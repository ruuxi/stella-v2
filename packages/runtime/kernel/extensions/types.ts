import type { ToolContext, ToolResult } from "../tools/types.js";
import type { ParsedAgent } from "../agents/types.js";
import type { AgentMessage, AgentToolResult } from "../agent-core/types.js";
import type { AssistantMessageEvent } from "../../ai/types.js";
import type { RuntimePromptMessage } from "@stella/contracts/protocol";

export interface ToolDefinition {

  name: string;

  label?: string;

  workingText?: string;

  description: string;

  agentTypes?: string[];

  parameters: Record<string, unknown>;

  demoted?: {
    searchTerms?: readonly string[];
    requiredConnectorProvider?: string;
  };

  execute(
    args: Record<string, unknown>,
    context: ToolContext,
  ): Promise<ToolResult>;
}

export type HookEvent =
  | "before_tool"
  | "after_tool"
  | "before_agent_start"
  | "before_user_message"
  | "agent_start"
  | "agent_end"
  | "turn_start"
  | "turn_end"
  | "message_start"
  | "message_update"
  | "message_end"
  | "tool_execution_start"
  | "tool_execution_update"
  | "tool_execution_end"
  | "before_compact"
  | "session_compact"
  | "before_provider_request"
  | "after_provider_response"
  | "session_start"
  | "session_shutdown";

export type HookRuntimeContext = {

  conversationId?: string;

  threadKey?: string;

  runId?: string;

  isUserTurn?: boolean;

  uiVisibility?: "visible" | "hidden";
};

export type BeforeToolPayload = {
  tool: string;
  args: Record<string, unknown>;
  context: ToolContext;
};

export type BeforeToolHookResult = {
  cancel?: boolean;
  reason?: string;
  args?: Record<string, unknown>;
};

export type AfterToolPayload = {
  tool: string;
  args: Record<string, unknown>;
  result: ToolResult;
  context: ToolContext;
};

export type AfterToolHookResult = {
  result?: ToolResult;
};

export type BeforeAgentStartPayload = HookRuntimeContext & {
  agentType: string;
  systemPrompt: string;
};

export type BeforeAgentStartHookResult = {
  systemPromptAppend?: string;
  systemPromptReplace?: string;
};

export type BeforeUserMessagePayload = HookRuntimeContext & {
  agentType: string;
  userPrompt: string;
  staleUserReminderText?: string;
  orchestratorReminderText?: string;

  connectorTransitionReminderText?: string;
  shouldInjectDynamicReminder?: boolean;
};

export type BeforeUserMessageHookResult = {

  prependMessages?: RuntimePromptMessage[];

  appendMessages?: RuntimePromptMessage[];
};

export type AgentStartPayload = HookRuntimeContext & {
  agentType: string;
};

export type AgentEndPayload = HookRuntimeContext & {
  agentType: string;

  finalText: string;

  outcome: "success" | "error" | "interrupted";

  services?: import("./services.js").RuntimeRunServices;
};

export type AgentEndHookResult = Record<string, never>;

export type TurnStartPayload = HookRuntimeContext & {
  agentType: string;
  messageCount: number;
};

export type TurnStartHookResult = {
  injectSystemContent?: string;
};

export type TurnEndPayload = HookRuntimeContext & {
  agentType: string;
  assistantText: string;
};

export type MessageStartPayload = HookRuntimeContext & {
  agentType: string;
  message: AgentMessage;
};

export type MessageUpdatePayload = HookRuntimeContext & {
  agentType: string;
  message: AgentMessage;
  assistantMessageEvent: AssistantMessageEvent;
};

export type MessageEndPayload = HookRuntimeContext & {
  agentType: string;
  message: AgentMessage;
};

export type MessageEndHookResult = void;

export type ToolExecutionStartPayload = HookRuntimeContext & {
  agentType: string;
  toolCallId: string;
  toolName: string;
  statusText?: string;
  args: Record<string, unknown>;
};

export type ToolExecutionUpdatePayload = HookRuntimeContext & {
  agentType: string;
  toolCallId: string;
  toolName: string;
  args: Record<string, unknown>;
  partialResult: AgentToolResult<unknown>;
};

export type ToolExecutionEndPayload = HookRuntimeContext & {
  agentType: string;
  toolCallId: string;
  toolName: string;
  result: AgentToolResult<unknown>;
  isError: boolean;
};

export type BeforeCompactPayload = HookRuntimeContext & {
  agentType: string;
  messageCount: number;
};

export type BeforeCompactHookResult = {
  cancel?: boolean;
  compaction?: {
    summary: string;
    preserveLastN?: number;
  };
};

export type SessionCompactPayload = HookRuntimeContext & {
  agentType: string;
  summary: string;
  preserveLastN?: number;

  fromHook: boolean;
};

export type BeforeProviderRequestPayload = HookRuntimeContext & {
  agentType: string;
  model: string;
  payload: unknown;
};

export type BeforeProviderRequestHookResult = {
  payload?: unknown;
};

export type AfterProviderResponsePayload = HookRuntimeContext & {
  agentType: string;
  model: string;
  status?: number;
  headers?: Record<string, string>;
};

export type SessionStartPayload = HookRuntimeContext & {
  agentType: string;
  reason: "startup" | "new" | "resume" | "fork" | "reload";
  previousThreadKey?: string;
};

export type SessionShutdownPayload = HookRuntimeContext & {
  agentType: string;
  reason: "quit" | "reload" | "new" | "resume" | "fork";
  targetThreadKey?: string;
};

export interface HookEventMap {
  before_tool: { payload: BeforeToolPayload; result: BeforeToolHookResult };
  after_tool: { payload: AfterToolPayload; result: AfterToolHookResult };
  before_agent_start: {
    payload: BeforeAgentStartPayload;
    result: BeforeAgentStartHookResult;
  };
  before_user_message: {
    payload: BeforeUserMessagePayload;
    result: BeforeUserMessageHookResult;
  };
  agent_start: { payload: AgentStartPayload; result: void };
  agent_end: { payload: AgentEndPayload; result: AgentEndHookResult };
  turn_start: { payload: TurnStartPayload; result: TurnStartHookResult };
  turn_end: { payload: TurnEndPayload; result: void };
  message_start: { payload: MessageStartPayload; result: void };
  message_update: { payload: MessageUpdatePayload; result: void };
  message_end: { payload: MessageEndPayload; result: MessageEndHookResult };
  tool_execution_start: { payload: ToolExecutionStartPayload; result: void };
  tool_execution_update: { payload: ToolExecutionUpdatePayload; result: void };
  tool_execution_end: { payload: ToolExecutionEndPayload; result: void };
  before_compact: {
    payload: BeforeCompactPayload;
    result: BeforeCompactHookResult;
  };
  session_compact: { payload: SessionCompactPayload; result: void };
  before_provider_request: {
    payload: BeforeProviderRequestPayload;
    result: BeforeProviderRequestHookResult;
  };
  after_provider_response: {
    payload: AfterProviderResponsePayload;
    result: void;
  };
  session_start: { payload: SessionStartPayload; result: void };
  session_shutdown: { payload: SessionShutdownPayload; result: void };
}

export interface HookDefinition<E extends HookEvent = HookEvent> {

  event: E;

  filter?: { tool?: string; agentType?: string };

  source?: "bundled" | "extension";

  handler(
    payload: HookEventMap[E]["payload"],
  ): Promise<HookEventMap[E]["result"] | void>;
}

export interface ProviderModelDefinition {
  id: string;
  name: string;
  contextWindow: number;
  maxTokens: number;
  reasoning?: boolean;
  input?: string[];
  cost?: {
    input: number;
    output: number;
    cacheRead?: number;
    cacheWrite?: number;
  };
}

export interface ProviderDefinition {

  name: string;

  api: string;

  baseUrl: string;

  apiKeyEnv?: string;

  models: ProviderModelDefinition[];

  headers?: Record<string, string>;
}

export interface PromptTemplate {

  name: string;

  description: string;

  template: string;

  filePath: string;
}

export interface ExtensionRegistrationApi {
  on<E extends HookEvent>(
    event: E,
    handler: HookDefinition<E>["handler"],
    filter?: HookDefinition<E>["filter"],
  ): void;
  registerTool(tool: ToolDefinition): void;
  registerProvider(provider: ProviderDefinition): void;
  registerPrompt(prompt: PromptTemplate): void;
  registerAgent(agent: ParsedAgent): void;
}

export type ExtensionFactory = (
  api: ExtensionRegistrationApi,
  services: import("./services.js").ExtensionServices,
) => void | Promise<void>;

export interface LoadedExtensions {
  tools: ToolDefinition[];
  hooks: HookDefinition[];
  providers: ProviderDefinition[];
  prompts: PromptTemplate[];
  agents: ParsedAgent[];
}
