import type {
  AgentIdLike,
  AgentRunFinishOutcome,
  AgentStreamEventType,
  TaskToolActivity,
} from "./agent-runtime.js";
import type { AssistantWorkingMode } from "./local-preferences.js";

export type AgentResponseTarget =
  | { type: "user_turn" }
  | { type: "agent_turn"; agentId: string }
  | {
      type: "agent_terminal_notice";
      agentId: string;
      terminalState: "completed" | "failed" | "canceled";
    };

export type AgentStreamEvent = {
  type: AgentStreamEventType;
  runId: string;
  seq: number;

  sourceSeq?: number;
  conversationId?: string;
  requestId?: string;
  userMessageId?: string;
  uiVisibility?: "visible" | "hidden";
  rootRunId?: string;
  chunk?: string;
  statusState?: "running" | "compacting" | "provider-retry" | "model-fallback";
  toolCallId?: string;
  toolName?: string;
  args?: Record<string, unknown>;
  resultPreview?: string;

  isError?: boolean;
  details?: unknown;
  error?: string;
  fatal?: boolean;
  finalText?: string;
  persisted?: boolean;
  agentId?: string;
  agentType?: AgentIdLike;
  description?: string;
  parentAgentId?: string;
  result?: string;
  statusText?: string;
  toolActivity?: TaskToolActivity;
  outcome?: AgentRunFinishOutcome;
  reason?: string;
  replacedByRunId?: string;
  responseTarget?: AgentResponseTarget;

  workingMode?: AssistantWorkingMode;

  assistantMessageEventId?: string;

  assistantMessageText?: string;

  followedByToolCall?: boolean;
};
