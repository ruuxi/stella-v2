import type { ResolvedLlmRoute } from "../model-routing.js";
import type { RuntimeStore } from "../storage/runtime-store.js";
import type {
  LocalChatAppendEventArgs,
  LocalContextEvent,
} from "../storage/shared.js";

export type ExtensionServices = {

  stellaDataDir: string;

  stellaAppDir: string;
  store: RuntimeStore;

  notifyLinkSpendApproval?: (payload: {
    merchantName?: string;
    amountCents?: number;
    conversationId?: string;
  }) => Promise<void> | void;
};

export type RuntimeRunServices = {

  resolvedLlm?: ResolvedLlmRoute;
  appendLocalChatEvent?: (args: LocalChatAppendEventArgs) => void;

  listLocalChatEvents?: (
    conversationId: string,
    maxItems: number,
  ) => LocalContextEvent[];

  resolveSubsidiaryLlmRoute?: (agentType: string) => ResolvedLlmRoute;
};
