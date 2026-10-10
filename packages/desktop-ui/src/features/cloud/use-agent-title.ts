import type { TaskLifecycleStatus } from "@stella/contracts/agent-runtime";
import { agentThreadStatus } from "@stella/contracts/agent-titles";
import { isPrivateConversationId } from "@/features/chat/services/chat-storage-preference";
import { fallbackTaskDescription } from "@/features/chat/lib/event-transforms";
import { useCloudConversationSession } from "@/global/auth/hooks/use-cloud-conversation-session";
import { useBackendView } from "@/platform/backend/use-backend-view";
import { cloudConversationBelongsToOwnerSubject } from "./cloud-conversation-selection";
import { useJournalAgent } from "./journal-agent-store";

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

export type AgentCard = {
  title?: string;
  status?: TaskLifecycleStatus;
};

export function useAgentCard(
  conversationId: string,
  threadId: string,
  candidates: readonly (string | undefined)[],
  localStatus?: TaskLifecycleStatus,
): AgentCard {
  const { isCloudConversationReady, ownerSubject } = useCloudConversationSession();
  const journal = useJournalAgent(conversationId, threadId);
  const titles = [...candidates, journal?.title];
  const derived = fallbackTaskDescription(threadId);
  const known = firstTitle(titles, threadId, (title) => title !== derived);
  const lookup = useBackendView(
    "agentThreads.get",
    (!known || (!localStatus && (!journal?.status || journal.status === "running"))) &&
      threadId &&
      isCloudConversationReady &&
      !isPrivateConversationId(conversationId)
      ? { conversationId, threadId }
      : "skip",
  );
  const thread =
    lookup.value && cloudConversationBelongsToOwnerSubject(lookup.value, ownerSubject)
      ? lookup.value
      : null;
  const title =
    known ||
    (thread ? plainTitle(thread.description, threadId) : "") ||
    firstTitle(titles, threadId, () => true);
  const status =
    localStatus ?? (thread ? agentThreadStatus(thread.status) : undefined) ?? journal?.status;
  return {
    ...(title ? { title } : {}),
    ...(status ? { status } : {}),
  };
}

export function useAgentTitle(
  conversationId: string,
  threadId: string,
  candidates: readonly (string | undefined)[],
): string | undefined {
  return useAgentCard(conversationId, threadId, candidates, "completed").title;
}
