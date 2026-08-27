export const isConnectRequestVisibleToSurface = (
  request: { conversationId?: string },
  surfaceConversationId: string | null | undefined,
): boolean =>
  !request.conversationId ||
  (surfaceConversationId != null &&
    request.conversationId === surfaceConversationId);
