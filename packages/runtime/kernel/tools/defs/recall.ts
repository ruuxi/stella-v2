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
  description:
    "Find relevant memory, past work, conversation history, or live machine context that is not already available. Past work can include resumable thread_ids. Use agent_status for a known thread's current progress. Results distinguish found, no_match, retrieval_error, and synthesis_error; a retrieval failure does not mean the history is absent. Identical lookups within a run are cached.",
  parameters: {
    type: "object",
    properties: {
      prompt: {
        type: "string",
        description:
          'What you are trying to find or resolve, in your own words. e.g. "what was the user working on yesterday afternoon" or "find the thread where we set up the budget app".',
      },
      memorySearchTerms: {
        type: "array",
        items: { type: "string" },
        description:
          "Grep-like search terms: 2-8 concrete terms from the user's wording, repo/module names, feature names, dates, file names, error text, or prior-decision keywords. Recall applies them to both thread and transcript history in one unified retrieval pass.",
      },
    },
    required: ["prompt", "memorySearchTerms"],
    additionalProperties: false,
  },
  execute: async (args, context, extras) => {
    if (!options.contextProvider) {
      return { error: "Recall is not available in this runtime." };
    }
    const prompt = typeof args.prompt === "string" ? args.prompt.trim() : "";
    if (!prompt) {
      return { error: "Recall prompt is required." };
    }
    const memorySearchTerms = Array.isArray(args.memorySearchTerms)
      ? args.memorySearchTerms
          .filter((term): term is string => typeof term === "string")
          .map((term) => term.trim())
          .filter(Boolean)
      : undefined;
    if (!memorySearchTerms?.length) {
      return {
        error:
          "memorySearchTerms is required: pass 2-8 concrete grep-like terms (names, repo/module/feature words, dates, file names, error text) so the lookup can pre-run its searches.",
      };
    }
    const result = await options.contextProvider({
      conversationId: context.conversationId,
      requestId: context.requestId,
      ...(context.runId ? { runId: context.runId } : {}),
      prompt,
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
