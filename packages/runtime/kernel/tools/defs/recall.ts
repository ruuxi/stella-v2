import {
  RECALL_DESCRIPTION,
  RECALL_PARAMETERS,
  recallRequest,
} from "@stella/contracts/recall";
import { AGENT_IDS } from "@stella/contracts/agent-runtime";
import type { AgentModelConfigSnapshot } from "@stella/contracts/agent-engine";
import type { RecallLookupResult } from "../../agent-runtime/recall-run-cache.js";
import type { ToolDefinition } from "../types.js";

export type RecallToolOptions = {
  contextProvider?: (payload: {
    conversationId: string;
    requestId: string;
    runId?: string;
    prompt: string;
    memorySearchTerms?: string[];
    limit?: number;
    agentType?: string;
    modelConfigSnapshot?: AgentModelConfigSnapshot;
    signal?: AbortSignal;
  }) => Promise<RecallLookupResult>;
};

export const createRecallTool = (
  options: RecallToolOptions,
): ToolDefinition => ({
  name: "Recall",
  agentTypes: [AGENT_IDS.ORCHESTRATOR],
  description: RECALL_DESCRIPTION,
  parameters: RECALL_PARAMETERS,
  execute: async (args, context, extras) => {
    if (!options.contextProvider) {
      return { error: "Recall is not available in this runtime." };
    }
    let request: ReturnType<typeof recallRequest>;
    try {
      request = recallRequest(args);
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) };
    }
    const { prompt, terms: memorySearchTerms, limit } = request;
    const result = await options.contextProvider({
      conversationId: context.conversationId,
      requestId: context.requestId,
      ...(context.runId ? { runId: context.runId } : {}),
      prompt,
      limit,
      ...(memorySearchTerms?.length ? { memorySearchTerms } : {}),
      ...(context.agentType ? { agentType: context.agentType } : {}),
      ...(context.modelConfigSnapshot
        ? { modelConfigSnapshot: context.modelConfigSnapshot }
        : {}),
      ...(extras?.signal ? { signal: extras.signal } : {}),
    });
    return { result };
  },
});
