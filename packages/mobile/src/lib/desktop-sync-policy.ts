export const DESKTOP_TASK_POLL_MS = 5_000;

export const DESKTOP_TASK_POLL_PUSH_VERIFY_MS = 30_000;
export const DESKTOP_PUSH_DEDUPE_LIMIT = 512;

export type DesktopLocalChatPushDisposition =
  | "sync"
  | "duplicate"
  | "other-conversation";

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

export const desktopTaskPollIntervalMs = (
  livePushConnected: boolean,
): number =>
  livePushConnected ? DESKTOP_TASK_POLL_PUSH_VERIFY_MS : DESKTOP_TASK_POLL_MS;

export const shouldRunDesktopForegroundTimer = (args: {
  focused: boolean;
  appActive: boolean;
}): boolean => args.focused && args.appActive;

export const shouldSyncOnLocalChatPush = (args: {
  storageLoaded: boolean;
  sending: boolean;
}): boolean => args.storageLoaded && !args.sending;

export const shouldStartDesktopSyncRun = (args: {
  sending: boolean;
  duringSend: boolean;
}): boolean => !args.sending || args.duringSend;

export const desktopSyncJoinPlan = (args: {
  existingCatchUp: boolean;
  requestedCatchUp: boolean;
}): "share" | "chain-catch-up" =>
  args.requestedCatchUp && !args.existingCatchUp ? "chain-catch-up" : "share";

export const shouldDeferLocalChatPushDuringSend = (args: {
  storageLoaded: boolean;
  sending: boolean;
}): boolean => args.storageLoaded && args.sending;

export type DeferredDesktopSyncIntent = {
  catchUp: boolean;
};

export const mergeDeferredDesktopSyncIntent = (
  current: DeferredDesktopSyncIntent | null,
  requestedCatchUp: boolean,
): DeferredDesktopSyncIntent => ({
  catchUp: (current?.catchUp ?? false) || requestedCatchUp,
});

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

    return { catchUp: false, trigger: "push-resume-connect" };
  }
  return { catchUp: true, trigger: "push-reconnect" };
};

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
