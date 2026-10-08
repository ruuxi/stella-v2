import type {
  AgentHealth,
  LocalCronJobRecord,
  LocalHeartbeatConfigRecord,
  ScheduledConversationEvent,
} from "@stella/contracts";
import type {
  AgentRunFinishOutcome,
  TaskLifecycleStatus,
} from "@stella/contracts/agent-runtime";
import type { ReplyRef } from "@stella/contracts/reply-refs";
import type {
  RuntimeListModelsRequest,
  RuntimeModelCatalogModel,
  RuntimeModelCatalogSnapshot,
} from "@stella/contracts/model-catalog";

export type {
  AgentHealth,
  LocalCronJobRecord,
  LocalHeartbeatConfigRecord,
  ScheduledConversationEvent,
  RuntimeListModelsRequest,
  RuntimeModelCatalogModel,
  RuntimeModelCatalogSnapshot,
};

export const STELLA_RUNTIME_PROTOCOL_VERSION = "v1";
export const STELLA_RUNTIME_READY_METHOD = "internal.worker.readyz";

export type JsonRpcId = number | string;

export type JsonRpcRequest = {
  id: JsonRpcId;
  method: string;
  params?: unknown;
};

export type JsonRpcNotification = {
  method: string;
  params?: unknown;
};

export type JsonRpcSuccess = {
  id: JsonRpcId;
  result: unknown;
};

export type JsonRpcFailure = {
  id: JsonRpcId;
  error: {
    code: number;
    message: string;
    data?: unknown;
  };
};

export type JsonRpcMessage =
  JsonRpcRequest | JsonRpcNotification | JsonRpcSuccess | JsonRpcFailure;

export const RPC_ERROR_CODES = {
  PARSE_ERROR: -32_700,
  INVALID_REQUEST: -32_600,
  METHOD_NOT_FOUND: -32_601,
  INVALID_PARAMS: -32_602,
  INTERNAL_ERROR: -32_603,
  OVERLOADED: -32_700 - 100,
  RUNTIME_UNAVAILABLE: -32_700 - 101,
} as const;

export const METHOD_NAMES = {
  INITIALIZE: "initialize",
  INITIALIZED: "initialized",
  RUNTIME_CONFIGURE: "runtime.configure",
  RUNTIME_HEALTH: "runtime.health",
  RUNTIME_LIST_MODELS: "runtime.listModels",
  RUNTIME_RESTART_WORKER: "runtime.restartWorker",
  RUN_HEALTH_CHECK: "run.healthCheck",
  RUN_GET_ACTIVE: "run.getActive",
  RUN_START_CHAT: "run.startChat",
  RUN_CANCEL: "run.cancel",
  RUN_ACK_EVENTS: "run.ackEvents",
  RUN_AUTOMATION: "run.automation",
  AGENT_RUN_BLOCKING: "agent.runBlocking",
  AGENT_CREATE_BACKGROUND: "agent.createBackground",
  AGENT_GET_SNAPSHOT: "agent.getSnapshot",
  SEARCH_WEB: "search.web",
  VOICE_PERSIST_TRANSCRIPT: "voice.persistTranscript",
  VOICE_ORCHESTRATOR_CHAT: "voice.orchestratorChat",
  VOICE_ORCHESTRATOR_CONFIG: "voice.orchestratorConfig",
  VOICE_EXECUTE_TOOL: "voice.executeTool",
  VOICE_WEB_SEARCH: "voice.webSearch",
  THREAD_APPEND_MESSAGE: "thread.appendMessage",
  LOCAL_CHAT_GET_OR_CREATE_DEFAULT:
    "localChat.getOrCreateDefaultConversationId",
  LOCAL_CHAT_LIST_EVENTS: "localChat.listEvents",
  LOCAL_CHAT_GET_EVENT_COUNT: "localChat.getEventCount",
  LOCAL_CHAT_PERSIST_DISCOVERY_WELCOME: "localChat.persistDiscoveryWelcome",
  LOCAL_CHAT_LIST_SYNC_MESSAGES: "localChat.listSyncMessages",
  SCHEDULE_LIST_CRON_JOBS: "schedule.listCronJobs",
  SCHEDULE_LIST_HEARTBEATS: "schedule.listHeartbeats",
  SCHEDULE_LIST_EVENTS: "schedule.listConversationEvents",
  SCHEDULE_GET_EVENT_COUNT: "schedule.getConversationEventCount",
  SHELL_KILL_ALL: "shell.killAll",
  SHELL_KILL_BY_PORT: "shell.killByPort",
  DISCOVERY_COLLECT_BROWSER_DATA: "discovery.collectBrowserData",
  DISCOVERY_COLLECT_ALL_SIGNALS: "discovery.collectAllSignals",
  DISCOVERY_CORE_MEMORY_EXISTS: "discovery.coreMemoryExists",
  DISCOVERY_WRITE_CORE_MEMORY: "discovery.writeCoreMemory",
  DISCOVERY_DETECT_PREFERRED_BROWSER: "discovery.detectPreferredBrowser",
  DISCOVERY_LIST_BROWSER_PROFILES: "discovery.listBrowserProfiles",
  HOST_DEVICE_IDENTITY_GET: "host.deviceIdentity.get",
  HOST_ASK_USER_REQUEST: "host.askUser.request",
  HOST_SECURE_INPUT_REQUEST: "host.secureInput.request",
  HOST_SECURE_VALUE_USE: "host.secureValue.use",
  HOST_LLM_CREDENTIALS_REQUEST: "host.llmCredentials.request",
  HOST_CONNECTOR_CREDENTIAL_REQUEST: "host.connectorCredential.request",
  HOST_CONNECTOR_TOKEN_STORE_REQUEST: "host.connectorTokenStore.request",
  HOST_CONNECTOR_CONNECT_REQUEST: "host.connectorConnect.request",
  HOST_CONNECTOR_CONNECT_CANCEL: "host.connectorConnect.cancel",
  HOST_EXECUTION_DESTINATION_SWITCH: "host.executionDestination.switch",
  HOST_BROWSER_EXTENSION_CONNECT_REQUEST:
    "host.browserExtensionConnect.request",
  HOST_COMPUTER_USE_APP_APPROVAL_REQUEST: "host.computerUseAppApproval.request",
  HOST_DISPLAY_UPDATE: "host.display.update",
  HOST_NOTIFICATION_SHOW: "host.notification.show",
  HOST_SYSTEM_REQUEST_PERMISSION: "host.system.requestPermission",
  /**
   * Ask the Electron host process to spawn the desktop_automation daemon on
   * behalf of the (detached) runtime worker. macOS attributes TCC permission
   * checks (Accessibility) to the responsible process, which is inherited at
   * spawn time. The worker outlives the Electron app that spawned it, so
   * daemons spawned from the worker's process tree lose Stella.app attribution
   * after an app restart and fail AXIsProcessTrusted(). Spawning from the live
   * Electron main process keeps every automation process under the single
   * "Stella" TCC identity the user granted.
   */
  HOST_COMPUTER_USE_SPAWN_AUTOMATION_DAEMON:
    "host.computerUse.spawnAutomationDaemon",
  HOST_SYSTEM_OPEN_EXTERNAL: "host.system.openExternal",
  HOST_WINDOW_SHOW: "host.window.show",
  HOST_WINDOW_FOCUS: "host.window.focus",
  HOST_RUNTIME_AUTH_REFRESH: "host.runtimeAuth.refresh",
  INTERNAL_WORKER_INITIALIZE: "internal.worker.initialize",
  INTERNAL_WORKER_CONFIGURE: "internal.worker.configure",
  INTERNAL_WORKER_HEALTH: "internal.worker.health",
  INTERNAL_WORKER_LIST_MODELS: "internal.worker.listModels",
  INTERNAL_WORKER_GET_ACTIVE: "internal.worker.getActive",
  INTERNAL_WORKER_START_CHAT: "internal.worker.startChat",
  INTERNAL_WORKER_CANCEL: "internal.worker.cancel",
  /** Cancel the active orchestrator automation/chat run for a local conversation. */
  INTERNAL_WORKER_CANCEL_BY_CONVERSATION:
    "internal.worker.cancelByConversation",
  INTERNAL_WORKER_RESUME_EVENTS: "internal.worker.resumeEvents",
  INTERNAL_WORKER_ACK_EVENTS: "internal.worker.ackEvents",
  INTERNAL_WORKER_LIST_ACTIVE_RUNS: "internal.worker.listActiveRuns",
  INTERNAL_WORKER_RUN_AUTOMATION: "internal.worker.runAutomation",
  INTERNAL_WORKER_CANCEL_PLACEMENT_AUTOMATION:
    "internal.worker.cancelPlacementAutomation",
  INTERNAL_WORKER_RUN_BLOCKING_AGENT: "internal.worker.runBlockingAgent",
  INTERNAL_WORKER_CANCEL_BLOCKING_AGENT: "internal.worker.cancelBlockingAgent",
  INTERNAL_WORKER_STEER_BLOCKING_AGENT: "internal.worker.steerBlockingAgent",
  /** A `send_message` from the cloud for one of this computer's own agents. */
  INTERNAL_WORKER_DELIVER_AGENT_MESSAGE: "internal.worker.deliverAgentMessage",
  INTERNAL_WORKER_CREATE_BACKGROUND_AGENT:
    "internal.worker.createBackgroundAgent",
  INTERNAL_WORKER_GET_AGENT_SNAPSHOT: "internal.worker.getAgentSnapshot",
  INTERNAL_WORKER_APPEND_THREAD_MESSAGE: "internal.worker.appendThreadMessage",
  INTERNAL_WORKER_SEND_AGENT_INPUT: "internal.worker.sendAgentInput",
  /** The pi-durable chat (`@stella/contracts/pi-chat`): submit, abort, watch. */
  INTERNAL_WORKER_PI_CHAT: "internal.worker.piChat",
  INTERNAL_WORKER_WEB_SEARCH: "internal.worker.webSearch",
  INTERNAL_WORKER_VOICE_PERSIST_TRANSCRIPT:
    "internal.worker.voice.persistTranscript",
  INTERNAL_WORKER_VOICE_ORCHESTRATOR_CHAT:
    "internal.worker.voice.orchestratorChat",
  INTERNAL_WORKER_VOICE_ORCHESTRATOR_CONFIG:
    "internal.worker.voice.orchestratorConfig",
  INTERNAL_WORKER_VOICE_EXECUTE_TOOL: "internal.worker.voice.executeTool",
  INTERNAL_WORKER_VOICE_WEB_SEARCH: "internal.worker.voice.webSearch",
  INTERNAL_WORKER_KILL_ALL_SHELLS: "internal.worker.killAllShells",
  INTERNAL_WORKER_KILL_SHELL_BY_PORT: "internal.worker.killShellByPort",
  INTERNAL_WORKER_LOCAL_CHAT_GET_OR_CREATE_DEFAULT:
    "internal.worker.localChat.getOrCreateDefaultConversationId",
  INTERNAL_WORKER_LOCAL_CHAT_APPEND_EVENT:
    "internal.worker.localChat.appendEvent",
  INTERNAL_WORKER_LOCAL_CHAT_LIST_EVENTS:
    "internal.worker.localChat.listEvents",
  INTERNAL_WORKER_LOCAL_CHAT_GET_EVENT_COUNT:
    "internal.worker.localChat.getEventCount",
  INTERNAL_WORKER_LOCAL_CHAT_PERSIST_DISCOVERY_WELCOME:
    "internal.worker.localChat.persistDiscoveryWelcome",
  INTERNAL_WORKER_LOCAL_CHAT_LIST_SYNC_MESSAGES:
    "internal.worker.localChat.listSyncMessages",
  INTERNAL_WORKER_DISCOVERY_COLLECT_BROWSER_DATA:
    "internal.worker.discovery.collectBrowserData",
  INTERNAL_WORKER_DISCOVERY_COLLECT_ALL_SIGNALS:
    "internal.worker.discovery.collectAllSignals",
  INTERNAL_WORKER_SCHEDULE_LIST_CRON_JOBS:
    "internal.worker.schedule.listCronJobs",
  INTERNAL_WORKER_SCHEDULE_LIST_HEARTBEATS:
    "internal.worker.schedule.listHeartbeats",
  INTERNAL_WORKER_SCHEDULE_LIST_EVENTS:
    "internal.worker.schedule.listConversationEvents",
  INTERNAL_WORKER_SCHEDULE_GET_EVENT_COUNT:
    "internal.worker.schedule.getConversationEventCount",
  INTERNAL_WORKER_ONE_SHOT_COMPLETION: "internal.worker.oneShotCompletion",
  INTERNAL_STORE_LOAD_THREAD_MESSAGES: "internal.store.loadThreadMessages",
  INTERNAL_STORE_RESOLVE_OR_CREATE_ACTIVE_THREAD:
    "internal.store.resolveOrCreateActiveThread",
  INTERNAL_STORE_APPEND_THREAD_MESSAGE: "internal.store.appendThreadMessage",
  INTERNAL_STORE_ARCHIVE_THREAD: "internal.store.archiveThread",
  INTERNAL_STORE_REPLACE_THREAD_MESSAGES:
    "internal.store.replaceThreadMessages",
  INTERNAL_STORE_UPDATE_THREAD_SUMMARY: "internal.store.updateThreadSummary",
  INTERNAL_STORE_LIST_LOCAL_CHAT_EVENTS: "internal.store.listLocalChatEvents",
  INTERNAL_SCHEDULE_LIST_CRON_JOBS: "internal.schedule.listCronJobs",
  INTERNAL_SCHEDULE_LIST_HEARTBEATS: "internal.schedule.listHeartbeats",
  INTERNAL_SCHEDULE_ADD_CRON_JOB: "internal.schedule.addCronJob",
  INTERNAL_SCHEDULE_UPDATE_CRON_JOB: "internal.schedule.updateCronJob",
  INTERNAL_SCHEDULE_REMOVE_CRON_JOB: "internal.schedule.removeCronJob",
  INTERNAL_SCHEDULE_RUN_CRON_JOB: "internal.schedule.runCronJob",
  INTERNAL_SCHEDULE_GET_HEARTBEAT_CONFIG:
    "internal.schedule.getHeartbeatConfig",
  INTERNAL_SCHEDULE_UPSERT_HEARTBEAT: "internal.schedule.upsertHeartbeat",
  INTERNAL_SCHEDULE_RUN_HEARTBEAT: "internal.schedule.runHeartbeat",
  INTERNAL_CAPABILITY_STATE_GET: "internal.capabilityState.get",
  INTERNAL_CAPABILITY_STATE_SET: "internal.capabilityState.set",
  INTERNAL_CAPABILITY_STATE_APPEND_EVENT:
    "internal.capabilityState.appendEvent",
  INTERNAL_WORKER_GOOGLE_WORKSPACE_AUTH_STATUS:
    "internal.worker.googleWorkspace.authStatus",
  INTERNAL_WORKER_GOOGLE_WORKSPACE_CONNECT:
    "internal.worker.googleWorkspace.connect",
  INTERNAL_WORKER_GOOGLE_WORKSPACE_DISCONNECT:
    "internal.worker.googleWorkspace.disconnect",
} as const;

export const NOTIFICATION_NAMES = {
  RUNTIME_READY: "runtime.ready",
  RUNTIME_RELOADING: "runtime.reloading",
  RUNTIME_LAGGED: "runtime.lagged",
  RUN_EVENT: "run.event",
  VOICE_AGENT_EVENT: "voice.agentEvent",
  LOCAL_CHAT_UPDATED: "localChat.updated",
  THREAD_ACTIVITY_UPDATED: "localChat.threadActivityUpdated",
  /** A watched pi-durable conversation's events (`PiChatEventsPayload`). */
  PI_CHAT_EVENTS: "piChat.events",
  THREAD_TRANSCRIPT_UPDATED: "localChat.threadTranscriptUpdated",
  SCHEDULE_UPDATED: "schedule.updated",
  MODEL_CATALOG_UPDATED: "modelCatalog.updated",
  APPROVAL_REQUESTED: "approval.requested",
} as const;

export type RuntimeInitializeParams = {
  clientName: string;
  clientVersion: string;
  platform: NodeJS.Platform;
  protocolVersion: string;
  isDev: boolean;
  stellaAppDir: string;
  stellaDataDirPath: string;
  stellaWorkspacePath: string;
};

export type RuntimeInitializeResult = {
  protocolVersion: string;
  hostPid: number;
};

export type RuntimeConfigureParams = {
  /** The Stella backend worker (auth, backend calls and live views). */
  backendUrl?: string | null;
  authToken?: string | null;
  hasConnectedAccount?: boolean;
  cloudSyncEnabled?: boolean;
  localLlmCredentialsUpdatedAt?: number | null;
};

export type HostLlmCredentialsRequest =
  | { operation: "list" }
  | {
      operation: "get";
      kind: "api-key" | "oauth-api-key";
      provider: string;
      /**
       * OAuth only: mint a new access token from the stored refresh token
       * even when the cached one has not reached its recorded expiry. Set
       * after the provider rejected the cached token (401 / token_expired).
       */
      forceRefresh?: boolean;
    }
  | {
      /**
       * Which Claude Code config the next local Claude turn runs on: the one
       * signed in to the owner's active Claude account, else the CLI's
       * default. Stella never handles the credential itself.
       */
      operation: "claude-config";
    };

export type HostLlmCredentialsResult =
  | {
      ok: true;
      apiKeyProviders: string[];
      oauthProviders: string[];
    }
  | { ok: true; value: string | null }
  | {
      ok: true;
      /** `CLAUDE_CONFIG_DIR` to run with; null for the CLI's default config. */
      configDir: string | null;
      /** The owner's active Claude account, when one is chosen. */
      email?: string;
      /** False while that account has no Claude Code login on this computer. */
      signedIn: boolean;
    }
  | { ok: false; reason: string };

export type RuntimeAuthRefreshSource =
  "heartbeat" | "subscription" | "register" | "stella_provider" | "connector";

export type HostRuntimeAuthRefreshParams = {
  source: RuntimeAuthRefreshSource;
};

export type HostRuntimeAuthRefreshResult = {
  authenticated: boolean;
  token: string | null;
  hasConnectedAccount: boolean;
};

import type { ChatContext } from "@stella/contracts";

export type RuntimeHealthSnapshot = {
  ready: boolean;
  hostPid: number;
  workerPid: number | null;
  workerRunning?: boolean;
  workerGeneration: number;
  deviceId: string | null;
  activeRunId: string | null;
  activeAgentCount: number;
  /**
   * True when the host detected that the connected worker is running stale
   * runtime code (build-stamp mismatch on reattach) but deferred the restart
   * because work is in flight.
   * The worker restarts automatically at the first quiescent moment.
   */
  pendingWorkerRestart?: boolean;
};

export type RuntimeAttachmentRef = {
  url: string;
  mimeType?: string;
  /** Durable local copy used when an older image is pruned from model input. */
  sourcePath?: string;
  /**
   * Optional metadata preserved across the host/worker boundary so future
   * non-image attachment paths (voice notes, documents, video) can branch
   * on it. Today the image materializer only reads `url`/`mimeType` and
   * silently drops everything that isn't an image — these fields exist so
   * that adding non-image support later is a worker-only change rather
   * than another round of contract plumbing.
   */
  kind?: string;
  name?: string;
  size?: number;
  path?: string;
  /**
   * Drive-relative location of an attachment that came from the owner's Stella
   * Drive (a turn sent from another device). Durable and device-independent,
   * unlike `url` (a short-lived signed GET) and `sourcePath` (one machine's
   * cache), so it is the only form of this attachment safe to persist in the
   * cloud journal and resolvable by every client.
   */
  drivePath?: string;
  transcript?: string;
  extractedText?: string;
  /**
   * Downscaled data URL generated at attach time. The model path always
   * uses the full-resolution `url`; the chat display store persists the
   * preview instead so user-message rows never decode (or store) tens of
   * megabytes of base64 per turn.
   */
  previewUrl?: string;
};

export type RuntimePromptMessage = {
  text: string;
  uiVisibility?: "visible" | "hidden";
  messageType?: "message" | "user";
  customType?: string;
  /** Structured dedup key retained on persisted runtime-internal messages. */
  eventId?: string;
  display?: boolean;
  /** Optional caller-supplied timestamp for chronological prompt insertion. */
  timestamp?: number;
};

export type RuntimeChatPayload = {
  conversationId: string;
  userPrompt: string;
  requestId?: string;
  promptMessages?: RuntimePromptMessage[];
  selectedText?: string | null;
  chatContext?: ChatContext | null;
  deviceId?: string;
  platform?: string;
  timezone?: string;
  /**
   * BCP-47 locale tag for the user's preferred response language. Plumbed
   * from the desktop renderer's `useI18n()` so the runtime can inject a
   * "respond in X" directive into the agent system prompt. Optional —
   * falls back to English when absent.
   */
  locale?: string;
  mode?: string;
  messageMetadata?: Record<string, unknown>;
  attachments?: RuntimeAttachmentRef[];
  userMessageEventId?: string;
  /** Original renderer send time; remains stable while a queued turn waits. */
  userMessageTimestamp?: number;
  agentType?: string;
  storageMode?: "cloud" | "local";
  /** Exact owner-data epoch captured when this cloud turn was admitted. */
  ownerGeneration?: string;
  /** Destination for this send. Omitted or automatic keeps local execution. */
  executionTarget?:
    | { mode: "automatic" }
    | { mode: "cloud" }
    | { mode: "device"; deviceId: string };
};

export type RuntimeVoiceTranscriptPayload = {
  conversationId: string;
  /** Stable renderer-generated identity for durable cloud append retries. */
  eventId: string;
  /** Captured once with eventId so retries serialize the identical journal row. */
  timestamp: number;
  role: "user" | "assistant";
  text: string;
  uiVisibility?: "visible" | "hidden";
  /** Present only on the visible end-of-session summary message. */
  voiceSession?: { durationMs: number };
};

export type RuntimeVoiceChatPayload = {
  requestId: string;
  conversationId: string;
  message: string;
};

export type RuntimeVoiceToolMetadata = {
  type: "function";
  name: string;
  description: string;
  parameters: Record<string, unknown>;
};

export type RuntimeVoiceOrchestratorConfigRequest = {
  conversationId: string;
};

export type RuntimeVoiceHistoryItem = {
  role: string;
  content: string;
  timestamp?: number;
  toolCallId?: string;
};

export type RuntimeVoiceOrchestratorConfig = {
  instructions: string;
  tools: RuntimeVoiceToolMetadata[];
  history?: RuntimeVoiceHistoryItem[];
};

export type RuntimeVoiceToolCallPayload = {
  requestId: string;
  conversationId: string;
  callId: string;
  name: string;
  args: Record<string, unknown>;
};

export type RuntimeVoiceToolCallResult = {
  output: string;
  details?: unknown;
  error?: string;
};

export type RuntimeActiveRun = {
  runId: string;
  conversationId: string;
  uiVisibility?: "visible" | "hidden";
};

/**
 * One-shot text completion request. Lets renderer surfaces (prompt shapers,
 * etc.) run a single completion through the runtime's BYOK-aware
 * route resolver — same path the orchestrator and subsidiary agents use —
 * instead of unconditionally hitting Stella's managed chat-completions endpoint.
 *
 * `agentType` picks which per-agent model override + provider to honor.
 * `fallbackAgentTypes` lets the caller fall through to a related agent's
 * configured model when no explicit override exists for `agentType` (e.g. an
 * internal helper falls back to `general` so the user's Assistant-tab BYOK
 * pick is respected even though the helper is not user-configurable).
 */
export type RuntimeOneShotCompletionRequest = {
  agentType: string;
  systemPrompt?: string;
  userText: string;
  maxOutputTokens?: number;
  temperature?: number;
  fallbackAgentTypes?: string[];
  /**
   * Explicit model id (e.g. `stella/light`) that takes precedence over any
   * per-agent override or `fallbackAgentTypes`. Lets internal helpers pin a
   * tier alias so it resolves consistently across engines — notably so the
   * Claude Code / Codex engines map `stella/light` to their own light models
   * (Haiku / mini) instead of the user's expensive default.
   */
  model?: string;
  /** Internal-only effort pin for bounded utility passes. */
  reasoningEffort?: "none" | "minimal" | "low" | "medium" | "high" | "xhigh";
  /** Marks a non-user-facing automatic utility pass for engine policy. */
  utility?: boolean;
  /** Stable key for a short-lived reusable utility session. */
  sessionKey?: string;
  /** Close a previously-created reusable utility session without a model call. */
  closeSession?: boolean;
  /** Safety cleanup for reusable sessions when lifecycle cleanup is missed. */
  sessionIdleTtlMs?: number;
};

export type RuntimeOneShotCompletionResult = {
  text: string;
};

export type RuntimeAutomationTurnRequest = {
  conversationId: string;
  userPrompt: string;
  /**
   * Fail closed instead of joining the shared orchestrator queue when another
   * run already owns the lane. Leased remote executions use this so their
   * external authority cannot outlive an unobservable queued entry.
   */
  rejectIfBusy?: boolean;
  /** Exact dispatch-scoped local owner for a desktop placement chat run. */
  executionPlacementRunId?: string;
  /** Transcript authority for this automation turn. */
  storageMode?: "cloud" | "local";
  /** Exact owner-data epoch captured at the turn's admission boundary. */
  ownerGeneration?: string;
  /** Stable cloud-journal id used to deduplicate a retried external request. */
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
  /**
   * Chat-events id of the user message the caller already appended for
   * display (connector turns). Lets the runtime exclude that event from the
   * legacy pre-transition history shim so the message isn't duplicated into
   * model context alongside the prompt.
   */
  userMessageEventId?: string;
  /**
   * A person typed this prompt on another device and it was relayed here to
   * run (a placement chat dispatch). The run itself still executes with
   * hidden UI visibility — this computer publishes no run/event rows for it,
   * because the sending client owns that presentation — but the user message
   * mirrored into the cloud journal has to be visible: that row is the only
   * copy every other client can read. Automation that no human typed (cron
   * and trigger turns, connector deliveries) leaves this unset and keeps the
   * hidden journal row it has always written.
   */
  userAuthoredPrompt?: boolean;

};

export type RuntimeAutomationTurnResult =
  | { status: "ok"; finalText: string }
  | { status: "busy"; finalText: ""; error: string }
  | { status: "error"; finalText: ""; error: string };

export type RuntimeLocalAgentRequest = {
  conversationId: string;
  description: string;
  prompt: string;
  agentType?: string;
  /** Exact caller-owned thread identity used for idempotent placement/cancel. */
  threadId?: string;
  /**
   * The placement fence for this one attempt, when a thread outlives it (a
   * remote agent thread continued on this device). Defaults to `threadId`.
   */
  executionId?: string;
  /**
   * The requester's `spawn_agent` model selector. A selector this device
   * cannot run fails the agent with the reason.
   */
  requestedModel?: string;
  /**
   * The spawning turn's attachments, already resolved by the host to
   * short-lived signed drive GETs. The worker downloads them into the
   * conversation's attachment cache and gives the agent absolute paths; a
   * drive path on its own means nothing on a device.
   */
  attachments?: RuntimeAttachmentRef[];
};

export type RuntimeLocalAgentSteerRequest = {
  agentId: string;
  text: string;
  /** Stable across a retried steer, so the agent takes it once. */
  messageId: string;
};

export type RuntimeLocalAgentMessageRequest = {
  /** The local agent id, which is also its cloud thread id. */
  threadId: string;
  /** The framed `<agent-message>` text, delivered verbatim. */
  text: string;
  /** Stable across redeliveries, so the agent takes it once. */
  messageId: string;
  ownerGeneration: string;
};

export type RuntimeLocalAgentCancellationRequest = {
  agentId: string;
  reason?: string;
  /** The attempt's placement fence; defaults to `agentId`. */
  executionId?: string;
};

export type RuntimePlacementAutomationCancellationRequest = {
  runId: string;
  reason?: string;
};

export type RuntimeLocalAgentSnapshot = {
  id: string;
  status: TaskLifecycleStatus;
  description: string;
  startedAt: number;
  completedAt: number | null;
  result?: string;
  error?: string;
  recentActivity?: string[];
  messages?: Array<{
    from: "orchestrator" | "subagent";
    text: string;
    timestamp: number;
  }>;
};

export type RuntimeAgentEventPayload = {
  type: string;
  runId: string;
  seq: number;
  sourceSeq?: number;
  conversationId?: string;
  requestId?: string;
  userMessageId?: string;
  uiVisibility?: "visible" | "hidden";
  rootRunId?: string;
  chunk?: string;
  statusState?:
    | "running"
    | "compacting"
    | "engine-compacting"
    | "provider-retry"
    | "model-fallback";
  providerLifecyclePhase?:
    | "request-admitted"
    | "request-dispatched"
    | "stream-open"
    | "transport-closed"
    | "transport-joined"
    | "abandoned"
    | "outcome-unknown";
  providerRequestIdSha256?: string;
  providerPhysicalAttempt?: number;
  providerStreamOrdinal?: number;
  providerName?: string;
  providerModelId?: string;
  providerOutcome?: "completed" | "canceled" | "error";
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
  agentType?: string;
  description?: string;
  parentAgentId?: string;
  result?: string;
  statusText?: string;
  outcome?: AgentRunFinishOutcome;
  reason?: string;
  replacedByRunId?: string;
  responseTarget?:
    | { type: "user_turn" }
    | { type: "agent_turn"; agentId: string }
    | {
        type: "agent_terminal_notice";
        agentId: string;
        terminalState: "completed" | "failed" | "canceled";
      };
  assistantMessageEventId?: string;
  assistantMessageText?: string;
  /** Resolved citations for an `ASSISTANT_MESSAGE` boundary (`reply-refs`). */
  replyRefs?: ReplyRef[];
};

export type RuntimeVoiceAgentEventPayload = {
  requestId: string;
  event: RuntimeAgentEventPayload;
};

export type RunResumeEventsResult = {
  events: RuntimeAgentEventPayload[];
  exhausted: boolean;
};

export type RuntimeConversationActiveRunSnapshot = {
  runId: string;
  conversationId: string;
  requestId?: string;
  userMessageId?: string;
  uiVisibility?: "visible" | "hidden";
};

export type RuntimeConversationTaskSnapshot = {
  runId: string;
  agentId: string;
  agentType?: string;
  description?: string;
  parentAgentId?: string;
  status: TaskLifecycleStatus;
  statusText?: string;
  result?: string;
  error?: string;
};

export type RuntimeConversationResumeResult = {
  activeRun: RuntimeConversationActiveRunSnapshot | null;
  events: RuntimeAgentEventPayload[];
  tasks: RuntimeConversationTaskSnapshot[];
};

export type RuntimeWebSearchResult = {
  text: string;
  results: Array<{
    title: string;
    url: string;
    snippet: string;
    image?: string;
    favicon?: string;
  }>;
};

export type HostDeviceIdentity = {
  deviceId: string;
  publicKey: string;
};

export type HostHeartbeatSignature = {
  publicKey: string;
  signature: string;
};

/**
 * The host display update bridge accepts structured payloads that the renderer
 * maps to the workspace panel tab manager.
 *
 * Structured payloads use the same `DisplayPayload` shape defined in
 * `desktop/src/shared/contracts/display-payload.ts`. We avoid importing it
 * here so the runtime protocol stays free of desktop-only types — the
 * renderer is the single source of truth for the union and validates the
 * payload shape before routing it to the panel.
 */
export type HostDisplayUpdateParams = { payload: unknown };

export type RuntimeScheduleApi = {
  listCronJobs: () => Promise<LocalCronJobRecord[]>;
  listHeartbeats: () => Promise<LocalHeartbeatConfigRecord[]>;
  listConversationEvents: (args: {
    conversationId: string;
    maxItems?: number;
  }) => Promise<ScheduledConversationEvent[]>;
  getConversationEventCount: (args: {
    conversationId: string;
  }) => Promise<number>;
};

export type RuntimeHealthApi = {
  healthCheck: () => Promise<AgentHealth | null>;
  getActiveRun: () => Promise<RuntimeActiveRun | null>;
};
