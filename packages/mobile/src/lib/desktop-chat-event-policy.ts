export const desktopBridgeEventMatchesActiveRun = (args: {
  conversationId: string;
  requestId: string;
  runId: string;
  eventConversationId: string;
  eventRequestId: string;
  eventRunId: string;
}): boolean => {
  if (
    args.eventConversationId &&
    args.eventConversationId !== args.conversationId
  ) {
    return false;
  }
  if (args.runId && args.eventRunId) return args.eventRunId === args.runId;
  if (args.requestId && args.eventRequestId) {
    return args.eventRequestId === args.requestId;
  }
  return true;
};
