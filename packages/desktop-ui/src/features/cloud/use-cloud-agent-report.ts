import { isPrivateConversationId } from "@/features/chat/services/chat-storage-preference";
import type { LocalChatAgentReport } from "@stella/contracts/local-chat";
import { useCloudConversationSession } from "@/global/auth/hooks/use-cloud-conversation-session";
import { useBackendView } from "@/platform/backend/use-backend-view";
import { cloudConversationBelongsToOwnerSubject } from "./cloud-conversation-selection";
import { cloudThreadReport } from "./use-cloud-activity";

/** Subscribe only after hover/open intent; terminal results can change on rerun. */
export function useCloudAgentReport(
  conversationId: string,
  threadId: string,
  enabled: boolean,
): LocalChatAgentReport | null | undefined {
  const { isCloudConversationReady: authCloudReady, ownerSubject } = useCloudConversationSession();
  const isCloudConversationReady = authCloudReady && !isPrivateConversationId(conversationId);
  const report = useBackendView(
    "agentThreads.get",
    enabled && isCloudConversationReady ? { conversationId, threadId } : "skip",
  );
  if (!enabled || !isCloudConversationReady) return null;
  // An unavailable backend costs the report, not the chat: local-only tasks
  // still use the desktop report reader.
  if (report.status === "error") return null;
  if (report.status === "loading") return undefined;
  const thread = report.value;
  if (!thread) return null;
  if (!cloudConversationBelongsToOwnerSubject(thread, ownerSubject)) return undefined;
  const status = thread.status === "running" || thread.status === "completed" || thread.status === "canceled"
    ? thread.status : "error";
  return {
    threadId: thread.threadId,
    description: thread.description,
    agentType: thread.agentType,
    status,
    result: cloudThreadReport(thread),
    startedAt: thread.createdAt,
    ...(status === "running" ? {} : { completedAt: thread.updatedAt }),
  };
}
