/**
 * Conversations created by this renderer may be routed to before the live
 * `listMyConversations` query has delivered its next snapshot. Keep that
 * short handoff explicit so route validation cannot mistake a just-created
 * conversation for a stale or foreign id and immediately navigate away.
 */

import type { CloudConversation } from "./cloud-api";

const PENDING_CREATE_TTL_MS = 30_000;
type PendingCreatedConversation = {
  expiresAt: number;
  accountScope: string;
};
const pendingCreatedConversations = new Map<
  string,
  PendingCreatedConversation
>();

const prune = (now = Date.now()): void => {
  for (const [conversationId, pending] of pendingCreatedConversations) {
    if (pending.expiresAt <= now) {
      pendingCreatedConversations.delete(conversationId);
    }
  }
};

export const markCloudConversationCreated = (
  conversationId: string,
  accountScope: string,
): void => {
  prune();
  pendingCreatedConversations.set(conversationId, {
    expiresAt: Date.now() + PENDING_CREATE_TTL_MS,
    accountScope,
  });
};

export const acknowledgeCloudConversation = (conversationId: string): void => {
  pendingCreatedConversations.delete(conversationId);
};

export const isPendingCloudConversation = (
  conversationId: string,
  accountScope: string,
): boolean => {
  prune();
  return (
    pendingCreatedConversations.get(conversationId)?.accountScope ===
    accountScope
  );
};

export const isOwnedCloudConversation = (
  conversations: readonly CloudConversation[],
  conversationId: string | null,
  accountScope: string,
): boolean =>
  Boolean(
    conversationId &&
      (conversations.some(
        (conversation) => conversation.conversationId === conversationId,
      ) ||
        isPendingCloudConversation(conversationId, accountScope)),
  );

/**
 * Route selection is deterministic and never follows list reordering while
 * the current route still belongs to the owner.
 */
export const resolveCloudConversationRoute = (args: {
  conversations: readonly CloudConversation[];
  routeConversationId: string | null;
  cachedConversationId: string | null;
  accountScope: string;
}): string | null => {
  if (
    isOwnedCloudConversation(
      args.conversations,
      args.routeConversationId,
      args.accountScope,
    )
  ) {
    return args.routeConversationId;
  }
  const cached = isOwnedCloudConversation(
    args.conversations,
    args.cachedConversationId,
    args.accountScope,
  )
    ? args.cachedConversationId
    : null;
  return cached ?? args.conversations[0]?.conversationId ?? null;
};

/**
 * The URL owns selection while the chat route is visible. Elsewhere the
 * account-scoped cache (or newest owned conversation) keeps the persistent
 * workspace Chat panel attached without manufacturing a chat-route redirect.
 */
export const resolveCloudConversationForShell = (args: {
  isOnChatRoute: boolean;
  conversations: readonly CloudConversation[];
  routeConversationId: string | null;
  cachedConversationId: string | null;
  accountScope: string;
}): string | null => {
  if (args.isOnChatRoute) {
    return isOwnedCloudConversation(
      args.conversations,
      args.routeConversationId,
      args.accountScope,
    )
      ? args.routeConversationId
      : null;
  }
  return resolveCloudConversationRoute({
    conversations: args.conversations,
    routeConversationId: null,
    cachedConversationId: args.cachedConversationId,
    accountScope: args.accountScope,
  });
};
