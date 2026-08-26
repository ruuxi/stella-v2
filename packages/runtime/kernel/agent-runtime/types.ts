import type { AgentMessage } from "../agent-core/types.js";
import type { HookEmitter } from "../extensions/hook-emitter.js";
import type { ResolvedLlmRoute } from "../model-routing.js";
import type { ImageDescriptionService } from "./image-description.js";
import type { LocalAgentContext } from "../agents/local-agent-manager.js";
// Type-only imports — both session classes import from this file, so a
// runtime import would form a cycle. The types are consumed only as
// opaque options below so type-only resolution at compile time is enough.
import type { OrchestratorSession } from "./orchestrator-session.js";
import type { SubagentSession } from "./subagent-session.js";
import type { BackgroundCompactionScheduler } from "./compaction-scheduler.js";
import type {
  AgentToolRequest,
  ProducedFilesOmission,
  ToolContext,
  ToolMetadata,
  ToolResult,
  ToolUpdateCallback,
} from "../tools/types.js";
import type { RuntimeStore } from "../storage/runtime-store.js";
import type {
  LocalChatAppendEventArgs,
  LocalContextEvent,
} from "../storage/shared.js";
import type {
  RuntimeAttachmentRef,
  RuntimePromptMessage,
  RuntimeAgentEventPayload,
} from "@stella/contracts/protocol";
import type {
  FileChangeRecord,
  ProducedFileRecord,
} from "@stella/contracts/file-changes";

export type RuntimeStreamEvent = {
  runId: string;
  agentType: string;
  seq: number;
  chunk: string;
  userMessageId: string;
  uiVisibility?: "visible" | "hidden";
  responseTarget?: RuntimeAgentEventPayload["responseTarget"];
};

export type RuntimeReasoningEvent = RuntimeStreamEvent;

export type RuntimeRunStartedEvent = {
  runId: string;
  agentType: string;
  seq: number;
  userMessageId: string;
  uiVisibility?: "visible" | "hidden";
  responseTarget?: RuntimeAgentEventPayload["responseTarget"];
};

export type RuntimeToolStartEvent = {
  runId: string;
  agentType: string;
  seq: number;
  toolCallId: string;
  toolName: string;
  statusText?: string;
  args: Record<string, unknown>;
  uiVisibility?: "visible" | "hidden";
};

export type RuntimeToolEndEvent = {
  runId: string;
  agentType: string;
  seq: number;
  toolCallId: string;
  toolName: string;
  resultPreview: string;
  /** True when the tool reported an error envelope for this call. */
  isError?: boolean;
  details?: unknown;
  fileChanges?: FileChangeRecord[];
  producedFiles?: ProducedFileRecord[];
  /**
   * Spawned-agent thread id (`task.threadId`) stamped by the subagent
   * runner so persisted `tool_result` payloads can be attributed to the
   * agent's Activity row live, before the `agent-completed` rollup lands.
   * Absent for the orchestrator's own direct tool calls.
   */
  agentId?: string;
  uiVisibility?: "visible" | "hidden";
};

export type RuntimeErrorEvent = {
  runId: string;
  agentType: string;
  seq: number;
  error: string;
  fatal: boolean;
  uiVisibility?: "visible" | "hidden";
};

export type RuntimeStatusEvent = {
  runId: string;
  agentType: string;
  seq: number;
  statusState: "running" | "compacting" | "provider-retry" | "model-fallback";
  statusText: string;
  uiVisibility?: "visible" | "hidden";
};

export type RuntimeUserMessageEvent = {
  userMessageId: string;
  text: string;
  timestamp: number;
  uiVisibility?: "visible" | "hidden";
};

export type RuntimeAssistantMessageEvent = {
  runId: string;
  agentType: string;
  seq: number;
  userMessageId: string;
  text: string;
  timestamp: number;
  uiVisibility?: "visible" | "hidden";
  responseTarget?: RuntimeAgentEventPayload["responseTarget"];
  /**
   * True when this assistant message ends with a tool call, i.e. it is an
   * interim/preamble message rather than the run's final answer. The renderer
   * keeps the working indicator up (instead of handing off) across the gap
   * between this message and the tool it precedes.
   */
  followedByToolCall?: boolean;
};

export type RuntimeEndEvent = {
  runId: string;
  agentType: string;
  seq: number;
  userMessageId: string;
  finalText: string;
  persisted: boolean;
  fileChanges?: FileChangeRecord[];
  producedFiles?: ProducedFileRecord[];
  uiVisibility?: "visible" | "hidden";
  responseTarget?: RuntimeAgentEventPayload["responseTarget"];
};

export type RuntimeInterruptedEvent = {
  runId: string;
  agentType: string;
  seq: number;
  userMessageId: string;
  reason: string;
  uiVisibility?: "visible" | "hidden";
};

export type RuntimeExecutionSessionHandle = {
  runId: string;
  threadKey: string;
  /**
   * Which execution engine backs `agent`. The native agent-core loop delivers
   * `steer` messages mid-run at the next safe turn boundary; external CLI
   * engines (Claude Code, Codex) buffer both steer and followUp until the
   * current turn completes, so mid-run `steer` delivery for user messages is
   * only meaningful when this is `"native"`.
   */
  engine: "native" | "external";
  queueUserMessageId: (
    userMessageId: string,
    onStart?: () => void,
    nextUiVisibility?: "visible" | "hidden",
  ) => void;
  agent: {
    state: {
      isStreaming: boolean;
    };
    steer: (message: AgentMessage) => void;
    followUp: (message: AgentMessage) => void;
    clearAllQueues: () => void;
  };
};

export type RuntimeRunCallbacks = {
  onRunStarted?: (event: RuntimeRunStartedEvent) => void;
  onUserMessage?: (event: RuntimeUserMessageEvent) => void;
  onAssistantMessage?: (event: RuntimeAssistantMessageEvent) => void;
  onStream: (event: RuntimeStreamEvent) => void;
  onReasoning?: (event: RuntimeReasoningEvent) => void;
  onStatus?: (event: RuntimeStatusEvent) => void;
  onToolStart: (event: RuntimeToolStartEvent) => void;
  onToolEnd: (event: RuntimeToolEndEvent) => void;
  onError: (event: RuntimeErrorEvent) => void;
  onEnd: (event: RuntimeEndEvent) => void;
  onInterrupted?: (event: RuntimeInterruptedEvent) => void;
};

export type BaseRunOptions = {
  runId?: string;
  rootRunId?: string;
  agentId?: string;
  conversationId: string;
  /**
   * Transcript ownership follows the conversation, not where this particular
   * agent executes. Cloud conversations keep tool-spawned task lifecycle in
   * Convex even when the task itself runs on this computer.
   */
  storageMode?: "cloud" | "local";
  userMessageId: string;
  uiVisibility?: "visible" | "hidden";
  agentType: string;
  userPrompt: string;
  promptMessages?: RuntimePromptMessage[];
  attachments?: RuntimeAttachmentRef[];
  connectorDeliveryTarget?: {
    requestId: string;
    conversationId: string;
    provider?: string;
    externalMessageId?: string;
  };
  agentContext: LocalAgentContext;
  toolCatalog?: ToolMetadata[];
  toolExecutor: (
    toolName: string,
    args: Record<string, unknown>,
    context: ToolContext,
    signal?: AbortSignal,
    onUpdate?: ToolUpdateCallback,
  ) => Promise<ToolResult>;
  deviceId: string;
  stellaDataDir: string;
  /** Private action-broker endpoint injected only into connector-capable children. */
  cliBridgeSocketPath?: string;
  resolvedLlm: ResolvedLlmRoute;
  /** Lazily describes newly-arriving images when the selected model is text-only. */
  describeImages?: ImageDescriptionService;
  store: RuntimeStore;
  abortSignal?: AbortSignal;
  stellaAppDir?: string;
  toolWorkspaceRoot?: string;
  hookEmitter?: HookEmitter;
  /**
   * Registers run-owned resources (provider streams, tool calls) into the
   * owning run's supervision scope, so cancel/shutdown interrupts them and
   * joins their teardown. Wired by the runner; sessions run unsupervised
   * (today's behavior) when absent.
   */
  superviseRunResource?: import("./run-resources.js").RunResourceRegistrar;
  responseTarget?: RuntimeAgentEventPayload["responseTarget"];
  /**
   * Append a local-chat event for the conversation. Routes through the
   * worker server wrapper that also fires the `localChat:updated`
   * notification, so the renderer re-fetches reactively.
   */
  appendLocalChatEvent?: (args: LocalChatAppendEventArgs) => void;
  /**
   * Read recent local-chat events for the conversation. Used by post-run
   * background passes that need a snapshot of the persisted event log.
   */
  listLocalChatEvents?: (
    conversationId: string,
    maxItems: number,
  ) => LocalContextEvent[];
  /**
   * Resolve the LLM route for a sibling agent type so post-run background
   * passes can run on a different model mode than the agent that just
   * finalized. Lazy: only invoked when actually needed.
   */
  resolveSubsidiaryLlmRoute?: (agentType: string) => ResolvedLlmRoute;
  /**
   * Per-thread compaction scheduler. finalize* paths run thread compaction
   * in the background AFTER the user-visible `onEnd` fires, so the user
   * never waits on the summarization LLM.
   *
   * One scheduler instance is shared across the runtime — see
   * `RunnerContext.state.compactionScheduler`. The scheduler enforces
   * one in-flight compaction per `threadKey`, which is what prevents
   * double-overlay races when turns finalize back-to-back.
   */
  compactionScheduler: BackgroundCompactionScheduler;
};

export type OrchestratorRunOptions = BaseRunOptions & {
  callbacks: RuntimeRunCallbacks;
  onExecutionSessionCreated?: (session: RuntimeExecutionSessionHandle) => void;
  beforeRunEnd?: (args: {
    runId: string;
    threadKey: string;
    finalText: string;
    outcome: "success";
  }) => Promise<void> | void;
  /**
   * Long-lived per-conversation session. When provided, the Pi engine path
   * routes through `session.runTurn(opts)` so the underlying `Agent`
   * survives across turns and provider prompt-cache prefixes stay stable.
   * The external engine path (`runExternalOrchestratorTurn`) ignores this
   * field; external engines own their own session concept on the binary
   * side. Callers that omit it get an ephemeral session through
   * `runOrchestratorTurn`, but the Pi execution path is still the same
   * session code.
   */
  orchestratorSession?: OrchestratorSession;
};

export type SubagentRunOptions = BaseRunOptions & {
  onProgress?: (chunk: string) => void;
  callbacks?: Partial<RuntimeRunCallbacks>;
  suppressCompletionSideEffects?: boolean;
  /**
   * Long-lived per-task subagent session. When provided, the Pi engine
   * path routes through `session.runTurn(opts)` so the underlying `Agent`
   * survives across `send_input` / restart-on-input cycles. The external
   * engine path ignores this. See `SubagentSession` for lifecycle.
   */
  subagentSession?: SubagentSession;
};

export type SubagentRunResult = {
  runId: string;
  result: string;
  interrupted?: boolean;
  error?: string;
  fileChanges?: FileChangeRecord[];
  producedFiles?: ProducedFileRecord[];
  /**
   * Set when the per-command cap withheld a background shell session's whole
   * produced-file batch. Those files are on disk and in no list, so this
   * count is the only thing that can say they exist.
   */
  producedFilesOmitted?: ProducedFilesOmission;
};
