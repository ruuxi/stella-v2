import { useMemo } from "react";
import type { ConversationSummary } from "@stella/contracts/backend/conversations";
import { useBackendView } from "@/platform/backend/use-backend-view";
import { readActiveCloudConversationIdCache } from "@/features/cloud/cloud-conversation-cache";
import {
  cloudConversationsForOwnerSubject,
  isOwnedCloudConversation,
} from "@/features/cloud/cloud-conversation-selection";
import type { useCloudConversationSession } from "./use-cloud-conversation-session";

type CloudConversationSession = ReturnType<typeof useCloudConversationSession>;

/**
 * Every backend read the root shell makes to select a conversation: the
 * owner's recent conversations as a live view, plus exact lookups for the
 * routed and last-open conversation when they aren't in that list. The
 * owner generation comes from the session's verified identity.
 */
export function useShellConversationSource({
  session,
  isPrivate,
  routeConversationId,
}: {
  session: CloudConversationSession;
  isPrivate: boolean;
  /** `?c=` on the chat route, else null. */
  routeConversationId: string | null;
}) {
  const { accountScope, ownerSubject } = session;
  const isCloudConversationReady = !isPrivate && session.isCloudConversationReady;
  const recent = useBackendView(
    "conversations.recent",
    isCloudConversationReady ? {} : "skip",
  );
  const cloudConversations: ConversationSummary[] | undefined = recent.value;
  const ownerGeneration = isCloudConversationReady ? session.ownerGeneration : null;

  const scopedCloudConversations = useMemo(
    () =>
      cloudConversationsForOwnerSubject(cloudConversations ?? [], ownerSubject),
    [cloudConversations, ownerSubject],
  );
  const cachedCloudConversationId = isCloudConversationReady
    ? readActiveCloudConversationIdCache(accountScope)
    : null;
  const routeIsListedOrPendingCloudConversation = isOwnedCloudConversation(
    scopedCloudConversations,
    routeConversationId,
    accountScope,
    ownerSubject,
  );
  const routeLookupId =
    isCloudConversationReady &&
    cloudConversations !== undefined &&
    routeConversationId &&
    !routeIsListedOrPendingCloudConversation
      ? routeConversationId
      : null;
  const routeLookup = useBackendView(
    "conversations.get",
    routeLookupId ? { conversationId: routeLookupId } : "skip",
  );
  const exactCloudConversation = routeLookupId
    ? routeLookup.status === "loading"
      ? undefined
      : (routeLookup.value ?? null)
    : undefined;

  const cachedConversationIsListed = Boolean(
    cachedCloudConversationId &&
      scopedCloudConversations.some(
        (conversation) =>
          conversation.conversationId === cachedCloudConversationId,
      ),
  );
  const cachedLookupId =
    isCloudConversationReady &&
    cloudConversations !== undefined &&
    cachedCloudConversationId &&
    cachedCloudConversationId !== routeConversationId &&
    !cachedConversationIsListed
      ? cachedCloudConversationId
      : null;
  const cachedLookup = useBackendView(
    "conversations.get",
    cachedLookupId ? { conversationId: cachedLookupId } : "skip",
  );
  const exactCachedCloudConversation = cachedLookupId
    ? cachedLookup.status === "loading"
      ? undefined
      : (cachedLookup.value ?? null)
    : undefined;

  return {
    isCloudConversationReady,
    isLoading: session.isLoading,
    cloudConversations,
    scopedCloudConversations,
    ownerGeneration,
    cachedCloudConversationId,
    routeIsListedOrPendingCloudConversation,
    exactCloudConversation,
    cachedConversationIsListed,
    exactCachedCloudConversation,
  };
}
