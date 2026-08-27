import { AGENT_IDS } from "@stella/contracts/agent-runtime";
import { canResolveRunnerLlmRoute } from "./model-selection.js";
import { sanitizeStellaBase } from "./shared.js";
import { resolveConversationStorageMode } from "./conversation-storage-mode.js";
import type { AgentHealth, ChatPayload, RunnerContext } from "./types.js";
import type {
  RuntimeAttachmentRef,
  RuntimePromptMessage,
} from "@stella/contracts/protocol";

export type OrchestratorRuntimeDeps = {
  resolveAgent: (agentType: string) => unknown;
  getConfiguredModel: (
    agentType: string,
    agent?: unknown,
  ) => string | undefined;
};

export type NormalizedOrchestratorRunInput = {
  conversationId: string;
  userPrompt: string;
  promptMessages?: RuntimePromptMessage[];
  attachments: RuntimeAttachmentRef[];
  agentType: string;
  storageMode?: "cloud" | "local";
  ownerGeneration?: string;
  userMessageId?: string;
  modelOverride?: string;
  toolWorkspaceRoot?: string;
  connectorDeliveryTarget?: {
    requestId: string;
    conversationId: string;
    provider?: string;
    externalMessageId?: string;
  };
};

const normalizeAttachments = (
  attachments: ChatPayload["attachments"],
): RuntimeAttachmentRef[] =>
  Array.isArray(attachments)
    ? attachments.filter((attachment): attachment is RuntimeAttachmentRef =>
        Boolean(
          attachment &&
          typeof attachment.url === "string" &&
          attachment.url.trim().length > 0,
        ),
      )
    : [];

export const getOrchestratorHealth = (
  context: RunnerContext,
  deps: OrchestratorRuntimeDeps,
  /**
   * Model the upcoming turn will actually run on (automation turns pin one).
   * When set, readiness is judged against it instead of the configured
   * orchestrator default — a pinned engine-CLI model must not be blocked
   * because the default model's credentials are unavailable.
   */
  modelOverride?: string,
): AgentHealth => {
  if (!context.state.isRunning) {
    return {
      ready: false,
      reason: "Stella runtime is not started",
      engine: "stella",
    };
  }
  if (!context.state.isInitialized) {
    return {
      ready: false,
      reason: "Stella runtime is still initializing",
      engine: "stella",
    };
  }
  const orchestratorModel =
    modelOverride?.trim() ||
    deps.getConfiguredModel(
      AGENT_IDS.ORCHESTRATOR,
      deps.resolveAgent(AGENT_IDS.ORCHESTRATOR),
    );
  if (canResolveRunnerLlmRoute(context, orchestratorModel)) {
    return { ready: true, engine: "pi" };
  }
  const hasSiteUrl = Boolean(sanitizeStellaBase(context.state.convexSiteUrl));
  const hasAuthToken = Boolean(context.state.authToken?.trim());
  if (!hasSiteUrl) {
    return { ready: false, reason: "Missing site URL", engine: "pi" };
  }
  if (!hasAuthToken) {
    return { ready: false, reason: "Missing auth token", engine: "pi" };
  }
  return { ready: false, reason: "No usable model route", engine: "pi" };
};

export const normalizeChatRunInput = (
  payload: ChatPayload,
): NormalizedOrchestratorRunInput => ({
  conversationId: payload.conversationId,
  userPrompt: payload.userPrompt.trim(),
  promptMessages: Array.isArray(payload.promptMessages)
    ? payload.promptMessages
        .filter(
          (
            message,
          ): message is NonNullable<ChatPayload["promptMessages"]>[number] =>
            Boolean(
              message &&
              typeof message.text === "string" &&
              message.text.trim().length > 0,
            ),
        )
        .map((message) => ({
          text: message.text.trim(),
          ...(message.uiVisibility
            ? { uiVisibility: message.uiVisibility }
            : {}),
          ...(message.messageType ? { messageType: message.messageType } : {}),
          ...(typeof message.customType === "string" &&
          message.customType.trim()
            ? { customType: message.customType.trim() }
            : {}),
          ...(typeof message.eventId === "string" && message.eventId.trim()
            ? { eventId: message.eventId.trim() }
            : {}),
          ...(typeof message.display === "boolean"
            ? { display: message.display }
            : {}),
          ...(typeof message.timestamp === "number" &&
          Number.isFinite(message.timestamp)
            ? { timestamp: message.timestamp }
            : {}),
        }))
    : undefined,
  attachments: normalizeAttachments(payload.attachments),
  agentType: payload.agentType ?? AGENT_IDS.ORCHESTRATOR,
  storageMode: resolveConversationStorageMode(payload.storageMode),
  ...(payload.ownerGeneration?.trim()
    ? { ownerGeneration: payload.ownerGeneration.trim() }
    : {}),
});

export const normalizeAutomationRunInput = (payload: {
  conversationId: string;
  userPrompt: string;
  storageMode?: "cloud" | "local";
  ownerGeneration?: string;
  userMessageId?: string;
  agentType?: string;
  modelOverride?: string;
  toolWorkspaceRoot?: string;
  attachments?: RuntimeAttachmentRef[];
  connectorDeliveryTarget?: {
    requestId: string;
    conversationId: string;
    provider?: string;
    externalMessageId?: string;
  };
}): NormalizedOrchestratorRunInput => ({
  conversationId: payload.conversationId.trim(),
  userPrompt: payload.userPrompt.trim(),
  attachments: normalizeAttachments(payload.attachments),
  agentType: payload.agentType ?? AGENT_IDS.ORCHESTRATOR,
  storageMode: resolveConversationStorageMode(payload.storageMode),
  ...(payload.ownerGeneration?.trim()
    ? { ownerGeneration: payload.ownerGeneration.trim() }
    : {}),
  ...(payload.userMessageId?.trim()
    ? { userMessageId: payload.userMessageId.trim() }
    : {}),
  ...(payload.modelOverride?.trim()
    ? { modelOverride: payload.modelOverride.trim() }
    : {}),
  ...(payload.toolWorkspaceRoot?.trim()
    ? { toolWorkspaceRoot: payload.toolWorkspaceRoot.trim() }
    : {}),
  ...(payload.connectorDeliveryTarget?.requestId?.trim() &&
  payload.connectorDeliveryTarget?.conversationId?.trim()
    ? {
        connectorDeliveryTarget: {
          requestId: payload.connectorDeliveryTarget.requestId.trim(),
          conversationId: payload.connectorDeliveryTarget.conversationId.trim(),
          ...(payload.connectorDeliveryTarget.provider?.trim()
            ? { provider: payload.connectorDeliveryTarget.provider.trim() }
            : {}),
          ...(payload.connectorDeliveryTarget.externalMessageId?.trim()
            ? {
                externalMessageId:
                  payload.connectorDeliveryTarget.externalMessageId.trim(),
              }
            : {}),
        },
      }
    : {}),
});
