import { useMemo } from "react";
import { useQueries, type RequestForQueries } from "convex/react";
import type { LocalChatAgentReport } from "@stella/contracts/local-chat";
import { useCloudConversationSession } from "@/global/auth/hooks/use-cloud-conversation-session";
import { cloudApi, type CloudAgentThread } from "./cloud-api";
import { cloudConversationBelongsToOwnerSubject } from "./cloud-conversation-selection";
import { cloudThreadReport } from "./use-cloud-activity";

/** Subscribe only after hover/open intent; terminal results can change on rerun. */
export function useCloudAgentReport(
  conversationId: string,
  threadId: string,
  enabled: boolean,
): LocalChatAgentReport | null | undefined {
  const { isCloudConversationReady, ownerSubject } = useCloudConversationSession();
  const queries = useMemo<RequestForQueries>(() => {
    const requests: RequestForQueries = {};
    if (enabled && isCloudConversationReady) {
      requests.report = {
        query: cloudApi.getMyAgentThread,
        args: { conversationId, threadId },
      };
    }
    return requests;
  }, [conversationId, enabled, isCloudConversationReady, threadId]);
  const results = useQueries(queries);
  if (!enabled || !isCloudConversationReady) return null;
  // useQueries exposes errors as values so an unavailable deployment does not
  // take down chat. Local-only tasks can still use the desktop report reader.
  const thread = results.report as CloudAgentThread | null | undefined | Error;
  if (thread === undefined) return undefined;
  if (!thread || thread instanceof Error) return null;
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
