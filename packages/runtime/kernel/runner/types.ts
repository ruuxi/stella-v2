import type { ConvexClient } from "convex/browser";
import type { Api, Model } from "../../ai/types.js";
import type { ImageCapTarget } from "../../ai/utils/image-caps.js";
import type { AgentMessage } from "../agent-core/types.js";
import type { OrchestratorSession } from "../agent-runtime/orchestrator-session.js";
import type { BackgroundCompactionScheduler } from "../agent-runtime/compaction-scheduler.js";
import type { BackgroundExitWake } from "./background-exit-wake.js";
import type { KernelRunSupervisor } from "./supervision/run-supervisor.js";
import type { RunCoordinator } from "./run-coordinator.js";
import type {
  RuntimeAssistantMessageEvent,
  RuntimeEndEvent,
  RuntimeErrorEvent,
  RuntimeExecutionSessionHandle,
  RuntimeReasoningEvent,
  RuntimeRunStartedEvent,
  RuntimeStatusEvent,
  RuntimeStreamEvent,
  RuntimeToolEndEvent,
  RuntimeToolStartEvent,
  RuntimeUserMessageEvent,
} from "../agent-runtime.js";
import type { RuntimeAgentEventPayload } from "@stella/contracts/protocol";
import type { HookEmitter } from "../extensions/hook-emitter.js";
import type { LocalContextEvent } from "../storage/shared.js";
import type {
  FashionToolApi,
  ScheduleToolApi,
  AgentToolRequest,
  AgentToolSnapshot,
  ToolContext,
  ToolUpdateCallback,
  ToolMetadata,
  ToolResult,
} from "../tools/types.js";
import type { ToolDefinition } from "../extensions/types.js";
import type {
  LocalAgentManager,
  AgentLifecycleEvent,
} from "../agents/local-agent-manager.js";
import type { RecallFtsHealth } from "../storage/recall-read-queries.js";
import type {
  RuntimeStore,
  TranscriptSearchHit,
} from "../storage/runtime-store.js";
import type {
  StorePackageRecord,
  StorePackageReleaseRecord,
} from "@stella/contracts";
import type {
  HostAppBrowserContextSnapshot,
  HostRuntimeAuthRefreshResult,
  RuntimeActiveRun,
  RuntimeAuthRefreshSource,
  RuntimeAttachmentRef,
  RuntimeAutomationTurnRequest,
  RuntimeAutomationTurnResult,
  RuntimeVoiceOrchestratorConfig,
  RuntimeVoiceOrchestratorConfigRequest,
  RuntimePromptMessage,
} from "@stella/contracts/protocol";
import type { LocalChatAppendEventArgs } from "../storage/shared.js";
import type { ThreadActivityUpdatedPayload } from "@stella/contracts/local-chat";

export type StellaHostRunnerOptions = {
  deviceId: string;
  stellaAppDir: string;
  stellaDataDir: string;
  stellaBrowserBinPath?: string;
  stellaOfficeBinPath?: string;
  stellaComputerCliPath?: string;
  stellaMediaCliPath?: string;
  stellaXApiCliPath?: string;
  /** UDS path for the worker-side CLI bridge (see runtime/worker/cli-bridge-server.ts).
   *  Forwarded into PTY env as `STELLA_CLI_BRIDGE_SOCK`. */
  cliBridgeSocketPath?: string;
  requestCredential?: (payload: {
    provider: string;
    label?: string;
    description?: string;
    placeholder?: string;
  }) => Promise<{ secretId: string; provider: string; label: string }>;
  /**
   * Legacy exec compatibility hop for the inline "connect the Stella browser
   * extension" chat card. Production browser actions use the persistent
   * browser service API. This hook blocks until the user connects, declines,
   * or the card times out, then retries the intercepted operation on success.
   */
  requestBrowserExtensionConnect?: (
    payload: {
      conversationId?: string;
      agentId?: string;
      command?: string;
    },
    signal?: AbortSignal,
  ) => Promise<
    | { ok: true; status: "connected" | "already_connected" }
    | {
        ok: false;
        reason: "declined" | "cancelled" | "timeout" | "unsupported" | string;
      }
  >;
  requestComputerUseAppApproval?: (payload: {
    bundleIdentifier: string;
    displayName: string;
    appPath?: string;
    allowPersistentApproval: boolean;
    risk?: string;
    warningSubtitle?: string;
  }) => Promise<
    | { decision: "approved"; scope: "session" | "persistent" }
    | { decision: "declined"; scope: "none" }
  >;
  /**
   * Desktop hop for the orchestrator's `connector_status` tool: render the
   * inline connector connect card (ConnectorConnectService) and resolve
   * with the user's outcome. The abort signal cancels the pending card.
   */
  requestConnectorConnection?: (
    payload: {
      id: string;
      name: string;
      description?: string;
      iconUrl?: string;
      category?: string;
      reason?: string;
      conversationId?: string;
    },
    signal?: AbortSignal,
  ) => Promise<
    | { ok: true; status: "connected" | "already_connected" }
    | {
        ok: false;
        reason: "declined" | "cancelled" | "timeout" | "unsupported" | string;
      }
  >;
  requestRuntimeAuthRefresh?: (payload: {
    source: RuntimeAuthRefreshSource;
  }) => Promise<HostRuntimeAuthRefreshResult>;
  scheduleApi?: ScheduleToolApi;
  fashionApi?: FashionToolApi;
  runtimeStore: RuntimeStore;
  getAppBrowserContext?: () =>
    | Promise<HostAppBrowserContextSnapshot>
    | HostAppBrowserContextSnapshot;
  listLocalChatEvents?: (
    conversationId: string,
    maxItems: number,
  ) => LocalContextEvent[];
  recallReadQueries?: {
    getFtsHealth: () => RecallFtsHealth;
    listTranscriptNeighborsBatch: (
      targets: readonly { conversationId: string; atMs: number }[],
      options?: { before?: number; after?: number; windowMs?: number },
    ) => TranscriptSearchHit[][];
  };
  appendLocalChatEvent?: (args: LocalChatAppendEventArgs) => void;
  /** Fired after every `runtime_agents` write with the durable keyed row. */
  notifyThreadActivityUpdated?: (payload: ThreadActivityUpdatedPayload) => void;
  getDefaultConversationId?: () => string;
};

export type ChatPayload = {
  conversationId: string;
  userMessageId: string;
  userPrompt: string;
  promptMessages?: RuntimePromptMessage[];
  attachments?: RuntimeAttachmentRef[];
  agentType?: string;
  storageMode?: "cloud" | "local";
};

export type RuntimeSendMessageInput = {
  conversationId: string;
  text: string;
  uiVisibility?: "visible" | "hidden";
  agentType?: string;
  deliverAs?: "steer" | "followUp";
  callbackRunId?: string;
  responseTarget?: RuntimeAgentEventPayload["responseTarget"];
  customType?: string;
  display?: boolean;
  timestamp?: number;
};

export type RuntimeSendUserMessageInput = RuntimeSendMessageInput & {
  metadata?: Record<string, unknown>;
};

export type ActiveOrchestratorSession = RuntimeExecutionSessionHandle & {
  conversationId: string;
  agentType: string;
  storageMode?: "cloud" | "local";
  uiVisibility: "visible" | "hidden";
  queueCallbackSwitch: (callbacks: AgentCallbacks) => void;
  queueMessage: (message: AgentMessage, delivery: "steer" | "followUp") => void;
};

export type AgentHealth = {
  ready: boolean;
  reason?: string;
  engine?: string;
};

export type AgentCallbacks = {
  onRunStarted?: (event: RuntimeRunStartedEvent) => void;
  onUserMessage?: (event: RuntimeUserMessageEvent) => void;
  onAssistantMessage?: (event: RuntimeAssistantMessageEvent) => void;
  onStream: (event: RuntimeStreamEvent) => void;
  onAgentReasoning?: (
    event: RuntimeReasoningEvent & {
      agentId: string;
      rootRunId?: string;
      /** The task's spawn description, so downstream task snapshots built
       *  from reasoning-only streams keep a real display name. */
      description?: string;
    },
  ) => void;
  onStatus?: (event: RuntimeStatusEvent) => void;
  onToolStart: (event: RuntimeToolStartEvent) => void;
  onToolEnd: (event: RuntimeToolEndEvent) => void;
  onError: (event: RuntimeErrorEvent) => void;
  onEnd: (event: RuntimeEndEvent) => void;
  onInterrupted?: (event: {
    runId: string;
    agentType: string;
    userMessageId?: string;
    uiVisibility?: "visible" | "hidden";
    reason: string;
  }) => void;
  onAgentEvent?: (event: AgentLifecycleEvent) => void;
};

export type QueuedOrchestratorTurn = {
  priority: "user" | "system";
  execute: () => Promise<void>;
};

/**
 * A user chat message that arrived while a run was already active on the
 * conversation and was injected into the live run as steering. If the run is interrupted, fails
 * fatally, or is otherwise torn down before the message is delivered, the
 * agent's in-memory queues are discarded and the user would never get a
 * reply. We mirror the message here so a fresh reply turn can be fired after
 * the active run drains, and prune the mirror once the message is actually
 * delivered to the model so an already-answered message is not re-answered.
 * See `flushPendingFollowUpReplies` in `orchestrator.ts` and
 * `prunePendingFollowUpReplies` in `shared.ts`.
 */
export type PendingFollowUpReply = {
  text: string;
  /** Queued-message id used to prune the mirror on delivery. */
  userMessageId?: string;
};

export type ParsedAgentLike = {
  id: string;
  name: string;
  description: string;
  systemPrompt: string;
  agentTypes: string[];
  toolsAllowlist?: string[];
  model?: string;
  maxAgentDepth?: number;
};

export type RunnerPaths = {
  extensionsPath: string;
};

export type RunnerState = {
  convexSiteUrl: string | null;
  authToken: string | null;
  convexDeploymentUrl: string | null;
  convexClient: ConvexClient | null;
  convexClientUrl: string | null;
  hasConnectedAccount: boolean;
  cloudSyncEnabled: boolean;
  modelCatalogUpdatedAt: number | null;
  isRunning: boolean;
  isInitialized: boolean;
  initializationPromise: Promise<void> | null;
  /**
   * Opens when `initializationPromise` is assigned at boot; reset when the
   * runner stops. Boot-window waiters (restart continuation) park here
   * instead of polling for the assignment.
   */
  initializationStarted: import("../shared/readiness-latch.js").ReadinessLatch;
  localAgentManager: LocalAgentManager | null;
  /**
   * Watches `exec_command` sessions a finished run left running and wakes
   * the owning thread when they exit. Null until the runner is initialized
   * (it needs both the tool host and the agent manager).
   */
  backgroundExitWake: BackgroundExitWake | null;
  activeOrchestratorRunId: string | null;
  activeOrchestratorConversationId: string | null;
  activeOrchestratorUiVisibility: "visible" | "hidden";
  activeOrchestratorSession: ActiveOrchestratorSession | null;
  /**
   * Long-lived orchestrator sessions keyed by `conversationId`. Each session
   * owns one live Pi `Agent` for the lifetime of the conversation and is
   * reused across turns to keep provider prompt-cache prefixes stable. See
   * `runtime/kernel/agent-runtime/orchestrator-session.ts`. Disposed on
   * worker shutdown via `runtime-initialization.ts:stop`.
   */
  orchestratorSessions: Map<string, OrchestratorSession>;
  /**
   * Per-thread background compaction scheduler. Holds at most one
   * in-flight compaction per `threadKey`; finalize* paths schedule
   * fire-and-forget after `onEnd` fires so users never wait on the
   * summarization LLM. Drained on worker shutdown so SQLite writes
   * complete before the store handle tears down. See
   * `runtime/kernel/agent-runtime/compaction-scheduler.ts`.
   */
  compactionScheduler: BackgroundCompactionScheduler;
  queuedOrchestratorTurns: QueuedOrchestratorTurn[];
  /**
   * Effect-owned run coordinator for the orchestrator lane: single writer
   * for run admission (`activeOrchestrator*` fields) and sole consumer of
   * `queuedOrchestratorTurns`, with a structurally single-flight,
   * interruptible drain. Installed on first use via `ensureRunCoordinator`
   * and shut down (drain fiber interrupted and joined) in
   * `runtime-initialization.ts:stop`. See
   * `runtime/kernel/runner/run-coordinator.ts`.
   */
  runCoordinator: RunCoordinator | null;
  /**
   * Per-conversation buffer of user chat messages that were injected into an
   * active run as steering. Populated when a user message lands on a live
   * streaming session; cleared when that run completes normally (the agent
   * loop drains and answers the steers before `agent_end`) and flushed into a
   * fresh reply turn when the run is interrupted or fails before draining.
   */
  pendingFollowUpReplies: Map<string, PendingFollowUpReply[]>;
  /**
   * Fiber supervision tree for orchestrator turns and subagent attempts.
   * Every run registers its cooperative abort at admission (`registerRun`)
   * and its root fiber at launch (`startRun`); subagent attempts spawned
   * with a `rootRunId` join that run's cancellation scope. This keyed
   * structure replaced the `activeRunAbortControllers` map:
   * `cancelLocalChat` and worker shutdown look up, abort, interrupt, and
   * join through the run scopes, so teardown of child processes, streams,
   * and pending tool calls is joined rather than fire-and-forget. See
   * `runtime/kernel/runner/supervision/run-supervisor.ts`.
   */
  supervisor: KernelRunSupervisor;
  conversationCallbacks: Map<string, AgentCallbacks>;
  runCallbacksByRunId: Map<string, AgentCallbacks>;
  loadedAgents: ParsedAgentLike[];
  /**
   * Late-bound web search handler. Wired by `createStellaHostRunner` after the
   * Convex session is created so the toolHost (built earlier in startup) can
   * reach Exa via the same convex-session call path that the rest of the
   * runtime uses. Stored on state so the toolHost can read it lazily.
   */
  webSearch:
    | ((
        query: string,
        options?: { category?: string },
      ) => Promise<{
        text: string;
        results: Array<{ title: string; url: string; snippet: string }>;
      }>)
    | null;
};

export type RunnerContext = {
  convexApi: unknown;
  deviceId: string;
  stellaAppDir: string;
  stellaDataDir: string;
  stellaBrowserBinPath?: string;
  stellaOfficeBinPath?: string;
  stellaComputerCliPath?: string;
  stellaMediaCliPath?: string;
  stellaXApiCliPath?: string;
  cliBridgeSocketPath?: string;
  requestCredential?: StellaHostRunnerOptions["requestCredential"];
  requestComputerUseAppApproval?: StellaHostRunnerOptions["requestComputerUseAppApproval"];
  requestRuntimeAuthRefresh?: StellaHostRunnerOptions["requestRuntimeAuthRefresh"];
  scheduleApi?: ScheduleToolApi;
  fashionApi?: FashionToolApi;
  runtimeStore: RuntimeStore;
  listLocalChatEvents?: StellaHostRunnerOptions["listLocalChatEvents"];
  recallReadQueries?: StellaHostRunnerOptions["recallReadQueries"];
  appendLocalChatEvent?: StellaHostRunnerOptions["appendLocalChatEvent"];
  notifyThreadActivityUpdated?: StellaHostRunnerOptions["notifyThreadActivityUpdated"];
  getDefaultConversationId?: StellaHostRunnerOptions["getDefaultConversationId"];
  /** Desktop's writer into a cloud conversation's DO-resident transcript. */
  cloudTranscript: import("./cloud-transcript-write.js").CloudTranscriptWriter;
  paths: RunnerPaths;
  state: RunnerState;
  hookEmitter: HookEmitter;
  toolHost: {
    getToolCatalog: (
      agentType?: string,
      options?: {
        model?: Pick<Model<Api>, "api" | "provider" | "id" | "name">;
        agentEngine?: import("../tools/file-edit-policy.js").FileEditAgentEngine;
        /** This thread was spawned by another agent; withhold orchestration tools. */
        parentOwned?: boolean;
        /** Include tools that are otherwise deferred from the default catalog. */
        includeDeferred?: boolean;
      },
    ) => ToolMetadata[];
    executeTool: (
      toolName: string,
      toolArgs: Record<string, unknown>,
      context: ToolContext,
      signal?: AbortSignal,
      onUpdate?: ToolUpdateCallback,
    ) => Promise<ToolResult>;
    endBrowserTurn: (
      runId: string,
      behavior: import("../browser-use/client.js").BrowserTurnEndBehavior,
    ) => Promise<void>;
    registerExtensionTools: (tools: ToolDefinition[]) => void;
    /** Sweep user-extension tools (F1 hot-reload). Built-ins are untouched. */
    unregisterExtensionTools: () => void;
    /**
     * Drain completed-but-unreported produced files from background/
     * long-running shell sessions so late deliverables reach the
     * agent-completed rollup. Optionally scoped to specific session ids.
     *
     * `omitted` is set when the per-command cap withheld a session's whole
     * batch: the files are absent, and only this says so.
     */
    drainCompletedShellProducedFiles: (sessionIds?: string[]) => Promise<{
      files: import("@stella/contracts/file-changes").ProducedFileRecord[];
      omitted?: import("../tools/types").ProducedFilesOmission;
    }>;
    killAllShells: () => void;
    killShell: (sessionId: string) => Promise<void> | void;
    killShellsByPort: (port: number) => void;
    shutdown: () => Promise<void>;
  };
};

export type StoreOperations = {
  listStorePackages: () => Promise<StorePackageRecord[]>;
  getStorePackage: (packageId: string) => Promise<StorePackageRecord | null>;
  listStorePackageReleases: (
    packageId: string,
  ) => Promise<StorePackageReleaseRecord[]>;
  getStorePackageRelease: (
    packageId: string,
    releaseNumber: number,
  ) => Promise<StorePackageReleaseRecord | null>;
};

export type RunnerPublicApi = {
  deviceId: string;
  hookEmitter: HookEmitter;
  setConvexUrl: (value: string | null) => void;
  setConvexSiteUrl: (value: string | null) => void;
  setAuthToken: (value: string | null) => void;
  setHasConnectedAccount: (value: boolean) => void;
  setCloudSyncEnabled: (enabled: boolean) => void;
  setModelCatalogUpdatedAt: (value: number | null) => void;
  start: () => void;
  stop: () => Promise<void>;
  waitUntilInitialized: () => Promise<void>;
  subscribeQuery: (
    query: unknown,
    args: Record<string, unknown>,
    onUpdate: (value: unknown) => void,
    onError?: (error: Error) => void,
  ) => (() => void) | null;
  getConvexUrl: () => string | null;
  getStellaSiteAuth: () => { baseUrl: string; authToken: string } | null;
  killAllShells: () => void;
  killShellsByPort: (port: number) => void;
  executeTool: (
    toolName: string,
    toolArgs: Record<string, unknown>,
    context: ToolContext,
    signal?: AbortSignal,
    onUpdate?: ToolUpdateCallback,
  ) => Promise<ToolResult>;
  agentHealthCheck: () => AgentHealth;
  warmModelCatalog: () => Promise<void>;
  /**
   * Resolve the provider/model an agent's turn would run on, for sizing
   * composer image attachments to that provider's limits. Returns null when
   * no route resolves (signed out, misconfigured pick).
   */
  resolveImageTarget: (
    agentType?: string,
  ) => Promise<Pick<ImageCapTarget, "provider" | "api" | "modelId"> | null>;
  webSearch: (
    query: string,
    options?: { category?: string },
  ) => Promise<{
    text: string;
    results: Array<{ title: string; url: string; snippet: string }>;
  }>;
  listStorePackages: StoreOperations["listStorePackages"];
  getStorePackage: StoreOperations["getStorePackage"];
  listStorePackageReleases: StoreOperations["listStorePackageReleases"];
  getStorePackageRelease: StoreOperations["getStorePackageRelease"];
  handleLocalChat: (
    payload: ChatPayload,
    callbacks: AgentCallbacks,
  ) => Promise<{ runId: string }>;
  sendMessage: (input: RuntimeSendMessageInput) => Promise<void>;
  sendUserMessage: (input: RuntimeSendUserMessageInput) => Promise<void>;
  runAutomationTurn: (
    payload: RuntimeAutomationTurnRequest,
  ) => Promise<RuntimeAutomationTurnResult>;
  runBlockingLocalAgent: (
    request: Omit<AgentToolRequest, "storageMode">,
  ) => Promise<
    | { status: "ok"; finalText: string; threadId: string }
    | { status: "error"; finalText: ""; error: string; threadId?: string }
  >;
  createBackgroundAgent: (
    request: Omit<AgentToolRequest, "storageMode">,
  ) => Promise<{ threadId: string }>;
  getActiveAgentCount: () => number;
  listActiveAgentRuns: () => RuntimeActiveRun[];
  getLocalAgentSnapshot: (agentId: string) => Promise<AgentToolSnapshot | null>;
  cancelLocalAgent: (
    agentId: string,
    reason?: string,
  ) => Promise<{ canceled: boolean }>;
  /**
   * The single joining cancel path: interrupts the run's fiber tree and
   * resolves only after every owned resource (provider streams, tools,
   * engine turns, subagent attempts) has torn down and the run's one
   * truthful terminal was emitted. Bounded by the per-resource abandonment
   * graces, so it can never hang.
   */
  cancelLocalChat: (runId: string) => Promise<void>;
  /**
   * Cancel the active orchestrator run for the given local conversation,
   * if one exists. Resolves `true` (after the joining cancel) if a run was
   * cancelled. Used by the remote-turn cancel path so callers don't need
   * to track runIds.
   */
  cancelLocalChatByConversation: (conversationId: string) => Promise<boolean>;
  getActiveOrchestratorRun: () => RuntimeActiveRun | null;
  appendThreadMessage: (args: {
    threadKey: string;
    role: "user" | "assistant";
    content: string;
    /**
     * Stamp the user-message timestamp tag (and thirty-minute suppression)
     * onto the persisted content — the durable-store equivalent of the
     * metadata the retired local-events projection added at read time.
     */
    decorateUserTimestampTag?: boolean;
    timezone?: string;
  }) => void;
  appendCloudJournal: import("./cloud-transcript-write.js").CloudTranscriptWriter["append"];
  beginVoiceToolCallReceipt: RuntimeStore["beginVoiceToolCallReceipt"];
  completeVoiceToolCallReceipt: RuntimeStore["completeVoiceToolCallReceipt"];
  notifyOrchestratorHistoryChanged: (conversationId: string) => void;
  getVoiceOrchestratorConfig: (
    payload: RuntimeVoiceOrchestratorConfigRequest,
  ) => Promise<RuntimeVoiceOrchestratorConfig>;
  convexAction: (ref: unknown, args: unknown) => Promise<unknown>;
  googleWorkspaceGetAuthStatus: () => Promise<{
    connected: boolean;
    unavailable?: boolean;
    email?: string;
    name?: string;
  }>;
  googleWorkspaceConnect: () => Promise<{
    connected: boolean;
    unavailable?: boolean;
    email?: string;
    name?: string;
  }>;
  googleWorkspaceDisconnect: () => Promise<{ ok: boolean }>;
  /**
   * Ask the Dream scheduler to run now. Trigger names are advisory and used
   * for diagnostics; eligibility gates apply to non-`manual` triggers.
   */
  triggerDreamNow: (trigger?: "manual" | "startup_catchup") => Promise<{
    scheduled: boolean;
    reason:
      | "scheduled"
      | "disabled"
      | "in_flight"
      | "shutting_down"
      | "count_failed"
      | "no_inputs"
      | "below_threshold"
      | "lock_busy"
      | "no_api_key"
      | "unavailable";
    pendingItems: number;
    detail?: string;
  }>;
};
