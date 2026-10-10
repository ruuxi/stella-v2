import { isPrivateConversationId } from "@/features/chat/services/chat-storage-preference";
import { fallbackTaskDescription } from "@/features/chat/lib/event-transforms";
import { useCloudConversationSession } from "@/global/auth/hooks/use-cloud-conversation-session";
import { useBackendView } from "@/platform/backend/use-backend-view";
import { cloudConversationBelongsToOwnerSubject } from "./cloud-conversation-selection";

const plainTitle = (value: string | undefined, threadId: string): string => {
  const title = value?.trim() ?? "";
  return title === threadId ? "" : title;
};

const firstTitle = (
  candidates: readonly (string | undefined)[],
  threadId: string,
  accept: (title: string) => boolean,
): string => {
  for (const candidate of candidates) {
    const title = plainTitle(candidate, threadId);
    if (title && accept(title)) return title;
  }
  return "";
};

export function useAgentTitle(
  conversationId: string,
  threadId: string,
  candidates: readonly (string | undefined)[],
): string | undefined {
  const { isCloudConversationReady, ownerSubject } = useCloudConversationSession();
  const derived = fallbackTaskDescription(threadId);
  const known = firstTitle(candidates, threadId, (title) => title !== derived);
  const lookup = useBackendView(
    "agentThreads.get",
    !known && threadId && isCloudConversationReady && !isPrivateConversationId(conversationId)
      ? { conversationId, threadId }
      : "skip",
  );
  if (known) return known;
  const thread = lookup.value;
  const indexed =
    thread && cloudConversationBelongsToOwnerSubject(thread, ownerSubject)
      ? plainTitle(thread.description, threadId)
      : "";
  return indexed || firstTitle(candidates, threadId, () => true) || undefined;
}
