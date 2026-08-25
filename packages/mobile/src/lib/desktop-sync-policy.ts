/**
 * Pure decision logic for when the desktop transcript is re-pulled. Kept out
 * of the hook so the invariants are unit-testable:
 *
 * - NEVER pull mid-send (05e5bf6): the desktop persists the turn's user row
 *   the moment it starts, and a mid-turn pull would merge that canonical row
 *   before `reconcileSentDesktopTurn` links the optimistic bubble —
 *   duplicating it — while also advancing the cursor past the turn.
 * - The task poll stays armed while a task is running even when the localChat
 *   push socket is connected — the pill's task snapshots ride cursor deltas,
 *   and a push socket that is "connected" but silently not delivering (killed
 *   upstream by the tunnel/OS without a close event) would otherwise freeze
 *   the pill forever. Push relaxes the cadence to a verification poll instead
 *   of suspending it (the regression that shipped in build 94: while push was
 *   live nothing re-pulled task snapshots, so the activity pill never showed).
 * - A push notification that lands mid-send must be DEFERRED, not dropped:
 *   the turn's own agent-started/task events broadcast while `sending` is
 *   true, and if the post-turn reconcile races the desktop persisting those
 *   rows, nothing else re-delivers the running-task snapshot.
 */

/** Fast cadence while the push socket is down — polling is the only signal. */
export const DESKTOP_TASK_POLL_MS = 5_000;
/**
 * Slow verification cadence while push is live: push owns freshness, the
 * poll just guarantees the running-task snapshot can never silently freeze.
 */
export const DESKTOP_TASK_POLL_PUSH_VERIFY_MS = 30_000;
export const DESKTOP_PUSH_DEDUPE_LIMIT = 512;

export type DesktopLocalChatPushDisposition =
  | "sync"
  | "duplicate"
  | "other-conversation";

/**
 * Classify an at-least-once local-chat notification before scheduling a pull.
 * The desktop includes the durable event id when one exists, so identical
 * broadcasts can be ignored without guessing from message text or timestamps.
 */
export const consumeDesktopLocalChatPush = ({
  activeConversationId,
  payloadConversationId,
  eventId,
  seenEventIds,
  maxSeenEventIds = DESKTOP_PUSH_DEDUPE_LIMIT,
}: {
  activeConversationId: string | null;
  payloadConversationId?: string;
  eventId?: string;
  seenEventIds: Set<string>;
  maxSeenEventIds?: number;
}): DesktopLocalChatPushDisposition => {
  if (
    activeConversationId &&
    payloadConversationId &&
    payloadConversationId !== activeConversationId
  ) {
    return "other-conversation";
  }
  if (!eventId) return "sync";

  const identity = `${payloadConversationId ?? activeConversationId ?? ""}:${eventId}`;
  if (seenEventIds.has(identity)) return "duplicate";
  seenEventIds.add(identity);
  while (seenEventIds.size > Math.max(1, maxSeenEventIds)) {
    const oldest = seenEventIds.values().next().value;
    if (typeof oldest !== "string") break;
    seenEventIds.delete(oldest);
  }
  return "sync";
};

/**
 * Tool calls are high-volume source events, not standalone transcript rows.
 * The next user/assistant/lifecycle event (or the running-task verification
 * poll) pulls them with their owning message, so syncing every tool edge only
 * rebuilds the same row and artifact projection over and over.
 */
export const shouldScheduleDesktopTranscriptSyncForPush = (
  eventType?: string,
): boolean =>
  eventType !== "tool_request" &&
  eventType !== "tool_result" &&
  eventType !== "agent-progress";

export const shouldArmDesktopTaskPoll = (args: {
  isDesktopTransport: boolean;
  storageLoaded: boolean;
  hasRunningConversationTask: boolean;
  sending: boolean;
  appActive: boolean;
}): boolean =>
  args.isDesktopTransport &&
  args.storageLoaded &&
  args.hasRunningConversationTask &&
  !args.sending &&
  args.appActive;

/** Poll cadence for an armed task poll under the current push state. */
export const desktopTaskPollIntervalMs = (
  livePushConnected: boolean,
): number =>
  livePushConnected ? DESKTOP_TASK_POLL_PUSH_VERIFY_MS : DESKTOP_TASK_POLL_MS;

export const shouldRunDesktopForegroundTimer = (args: {
  focused: boolean;
  appActive: boolean;
}): boolean => args.focused && args.appActive;

/** Whether a push-notified transcript change may trigger a sync right now. */
export const shouldSyncOnLocalChatPush = (args: {
  storageLoaded: boolean;
  sending: boolean;
}): boolean => args.storageLoaded && !args.sending;

/**
 * Whether a `runDesktopSync` caller may start a new pull right now. Enforced
 * at the coalescing point so imperative callers that never check `sending`
 * themselves (focus/AppState resume, Force Sync) cannot start a mid-send
 * pull; only the send pipeline's own wake → sync step (`duringSend`) may run
 * while a turn is in flight. Callers denied here defer to the post-send
 * flush rather than dropping the request.
 */
export const shouldStartDesktopSyncRun = (args: {
  sending: boolean;
  duringSend: boolean;
}): boolean => !args.sending || args.duringSend;

/** How a caller joins an in-flight transcript pull. */
export const desktopSyncJoinPlan = (args: {
  existingCatchUp: boolean;
  requestedCatchUp: boolean;
}): "share" | "chain-catch-up" =>
  args.requestedCatchUp && !args.existingCatchUp ? "chain-catch-up" : "share";

/**
 * Whether a push notification blocked only by the mid-send gate should be
 * remembered and flushed once the send settles (rather than dropped). The
 * flush runs through the same coalesced `runDesktopSync`, which awaits the
 * turn's reconcile first, so ordering and the duplicate-row window stay safe.
 */
export const shouldDeferLocalChatPushDuringSend = (args: {
  storageLoaded: boolean;
  sending: boolean;
}): boolean => args.storageLoaded && args.sending;

export type DeferredDesktopSyncIntent = {
  catchUp: boolean;
};

/**
 * Merge a sync request into the one deferred by the mid-send gate. Catch-up
 * is sticky: once a reconnect/foreground healer asks for a full-window pull,
 * later ordinary push notifications must not downgrade its flush to a delta.
 */
export const mergeDeferredDesktopSyncIntent = (
  current: DeferredDesktopSyncIntent | null,
  requestedCatchUp: boolean,
): DeferredDesktopSyncIntent => ({
  catchUp: (current?.catchUp ?? false) || requestedCatchUp,
});

/**
 * A live socket's first connection only closes the subscribe-vs-sync race, so
 * it rides the saved cursor. Foreground resume does the same because the
 * Computer surface already owns the bounded resume catch-up. Only an
 * unexpected foreground socket gap gets another recent-window healer.
 */
export const desktopLiveConnectionSyncPlan = (details: {
  reconnected: boolean;
  foregroundResume: boolean;
}): {
  catchUp: boolean;
  trigger: "push-connect" | "push-resume-connect" | "push-reconnect";
} => {
  if (!details.reconnected) {
    return { catchUp: false, trigger: "push-connect" };
  }
  if (details.foregroundResume) {
    // The Computer surface already performs its bounded resume catch-up.
    // This socket pull only closes the subscribe-vs-sync race.
    return { catchUp: false, trigger: "push-resume-connect" };
  }
  return { catchUp: true, trigger: "push-reconnect" };
};

/**
 * Which cursor a pull sends to the desktop.
 *
 * Every pull with a known conversation and cursor starts with the cheap delta,
 * including landing/reconnect/Force Sync. Sequence-enabled desktop stores
 * resolve legacy timestamp/id cursors onto monotonic `ordering_sequence`, so
 * backdated and same-millisecond events remain visible. The sync endpoint
 * reports invalid cursors explicitly and returns a bounded recovery snapshot;
 * larger valid gaps are drained as bounded forward pages.
 *
 * A cursor is only usable at all when it was minted for the conversation we
 * expect — on a conversation switch the delta must restart from scratch.
 */
export const desktopSyncPullPlan = (args: {
  catchUp: boolean;
  expectedConversationId: string | null;
  cursor: string | null;
}): { sinceCursor: string | null; fullWindow: boolean } => {
  if (!args.expectedConversationId || !args.cursor) {
    return { sinceCursor: null, fullWindow: true };
  }
  return { sinceCursor: args.cursor, fullWindow: false };
};
