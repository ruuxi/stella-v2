import type {
  AgentIdLike,
  AgentRunFinishOutcome,
  AgentStreamEventType,
} from "@stella/contracts/agent-runtime";
import type { RuntimeAgentEventPayload } from "@stella/contracts/protocol";
import type { AssistantWorkingMode } from "@stella/contracts/local-preferences";
import type { createStellaHostRunner } from "../../kernel/runner.js";

/**
 * Host-pushed worker configuration. `INTERNAL_WORKER_INITIALIZE` carries the
 * full record; `INTERNAL_WORKER_CONFIGURE` carries partial patches.
 */
export type WorkerInitializationState = {
  protocolVersion?: string;
  stellaAppDir: string;
  stellaDataDirPath: string;
  stellaWorkspacePath: string;
  authToken: string | null;
  convexUrl: string | null;
  convexSiteUrl: string | null;
  hasConnectedAccount: boolean;
  modelCatalogUpdatedAt: number | null;
  localLlmCredentialsUpdatedAt: number | null;
};

export type RuntimeRunner = ReturnType<typeof createStellaHostRunner>;

export type AgentEventPayload = {
  type: AgentStreamEventType;
  runId: string;
  seq: number;
  conversationId?: string;
  requestId?: string;
  userMessageId?: string;
  uiVisibility?: "visible" | "hidden";
  chunk?: string;
  statusState?: "running" | "compacting" | "provider-retry" | "model-fallback";
  toolCallId?: string;
  toolName?: string;
  args?: Record<string, unknown>;
  resultPreview?: string;
  details?: unknown;
  error?: string;
  fatal?: boolean;
  finalText?: string;
  persisted?: boolean;
  agentId?: string;
  agentType?: AgentIdLike;
  rootRunId?: string;
  description?: string;
  parentAgentId?: string;
  result?: string;
  statusText?: string;
  outcome?: AgentRunFinishOutcome;
  reason?: string;
  replacedByRunId?: string;
  responseTarget?: RuntimeAgentEventPayload["responseTarget"];
  workingMode?: AssistantWorkingMode;
  assistantMessageEventId?: string;
  assistantMessageText?: string;
};

export type ConnectCardOutcome =
  | { ok: true; status: "connected" | "already_connected" }
  | {
      ok: false;
      reason: "declined" | "cancelled" | "timeout" | "unsupported" | string;
    };
