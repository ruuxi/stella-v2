import type { ResolvedLlmRoute } from "../model-routing.js";
import type { RuntimeStore } from "../storage/runtime-store.js";
import type {
  LocalChatAppendEventArgs,
  LocalContextEvent,
} from "../storage/shared.js";
import type { AgentMessage } from "../agent-core/types.js";

export type ExtensionServices = {

  stellaDataDir: string;

  stellaAppDir: string;

  store: RuntimeStore;
};

export type RuntimeRunServices = {

  resolvedLlm?: ResolvedLlmRoute;

  messagesSnapshot?: AgentMessage[];

  appendLocalChatEvent?: (args: LocalChatAppendEventArgs) => void;

  listLocalChatEvents?: (
    conversationId: string,
    maxItems: number,
  ) => LocalContextEvent[];

  resolveSubsidiaryLlmRoute?: (agentType: string) => ResolvedLlmRoute;

  userTurnsSinceMemoryReview?: number;

  orchestratorTokenEstimate?: number;
};
