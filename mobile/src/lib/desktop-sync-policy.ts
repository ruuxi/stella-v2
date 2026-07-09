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

/**
 * Which cursor a pull sends to the desktop.
 *
 * Steady-state pulls (task poll, push-notified, send-path reconcile) ride the
 * cheap `(created_at, id)` delta cursor. Catch-up pulls (landing, foreground
 * return, reconnect, Force Sync) MUST NOT trust it: the cursor is derived from
 * the newest *source event* the last pull saw — including tool/agent lifecycle
 * events — and the desktop's `listMessagesAfter` filter is strictly
 * `(created_at, id) > cursor`. Any row that lands at or behind the cursor is
 * invisible to every future delta, permanently:
 *
 *   - a row appended with a caller-supplied (earlier) timestamp — the store's
 *     `created_at` is not monotonic;
 *   - a same-millisecond insert whose random id sorts below the cursor's id;
 *   - a burst larger than `maxMessages`, where the returned cursor covers all
 *     source events but the delivered message page was truncated.
 *
 * This poisoned-cursor state was observed in production as "Force Sync
 * succeeds but nothing arrives": the delta legitimately returns zero rows
 * while the desktop transcript has them. A full-window pull ignores the
 * cursor entirely and merges by id, so every catch-up moment re-converges the
 * transcript no matter how the cursor got ahead. The full pull also returns a
 * fresh cursor, un-poisoning the steady-state deltas that follow.
 *
 * A cursor is only usable at all when it was minted for the conversation we
 * expect — on a conversation switch the delta must restart from scratch.
 */
export const desktopSyncPullPlan = (args: {
  catchUp: boolean;
  expectedConversationId: string | null;
  cursor: string | null;
}): { sinceCursor: string | null; fullWindow: boolean } => {
  if (args.catchUp || !args.expectedConversationId || !args.cursor) {
    return { sinceCursor: null, fullWindow: true };
  }
  return { sinceCursor: args.cursor, fullWindow: false };
};
