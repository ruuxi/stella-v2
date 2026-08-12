/**
 * Match one conversation-level mobile observer to runtime events. Before the
 * root run is known, request identity rejects stale broadcasts from a previous
 * send. Once known, the run is authoritative because consumed steers retain
 * the root run while callback/request ownership advances.
 */
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
