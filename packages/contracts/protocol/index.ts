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
  | JsonRpcRequest
  | JsonRpcNotification
  | JsonRpcSuccess
  | JsonRpcFailure;

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
  LOCAL_CHAT_GET_SYNC_CHECKPOINT: "localChat.getSyncCheckpoint",
  LOCAL_CHAT_SET_SYNC_CHECKPOINT: "localChat.setSyncCheckpoint",
  SCHEDULE_LIST_CRON_JOBS: "schedule.listCronJobs",
  SCHEDULE_LIST_HEARTBEATS: "schedule.listHeartbeats",
  SCHEDULE_LIST_EVENTS: "schedule.listConversationEvents",
  SCHEDULE_GET_EVENT_COUNT: "schedule.getConversationEventCount",
  PROJECTS_LIST: "projects.list",
  PROJECTS_REGISTER_DIRECTORY: "projects.registerDirectory",
  PROJECTS_START: "projects.start",
  PROJECTS_STOP: "projects.stop",
  SHELL_KILL_ALL: "shell.killAll",
  SHELL_KILL_BY_PORT: "shell.killByPort",
  DISCOVERY_COLLECT_BROWSER_DATA: "discovery.collectBrowserData",
  DISCOVERY_COLLECT_ALL_SIGNALS: "discovery.collectAllSignals",
  DISCOVERY_CORE_MEMORY_EXISTS: "discovery.coreMemoryExists",
  DISCOVERY_WRITE_CORE_MEMORY: "discovery.writeCoreMemory",
  DISCOVERY_DETECT_PREFERRED_BROWSER: "discovery.detectPreferredBrowser",
  DISCOVERY_LIST_BROWSER_PROFILES: "discovery.listBrowserProfiles",
  HOST_DEVICE_IDENTITY_GET: "host.deviceIdentity.get",
  HOST_CREDENTIALS_REQUEST: "host.credentials.request",
  HOST_LLM_CREDENTIALS_REQUEST: "host.llmCredentials.request",
  HOST_CONNECTOR_CREDENTIAL_REQUEST: "host.connectorCredential.request",
  HOST_CONNECTOR_TOKEN_STORE_REQUEST: "host.connectorTokenStore.request",
  HOST_CONNECTOR_CONNECT_REQUEST: "host.connectorConnect.request",
  HOST_CONNECTOR_CONNECT_CANCEL: "host.connectorConnect.cancel",
  HOST_LINK_WALLET_CONNECT_REQUEST: "host.linkWallet.connect.request",
  HOST_LINK_WALLET_CONNECT_CANCEL: "host.linkWallet.connect.cancel",
  HOST_LINK_WALLET_SPEND_NOTIFY: "host.linkWallet.spend.notify",
  HOST_BROWSER_EXTENSION_CONNECT_REQUEST:
    "host.browserExtensionConnect.request",
  HOST_COMPUTER_USE_APP_APPROVAL_REQUEST: "host.computerUseAppApproval.request",
  HOST_APP_BROWSER_CONTEXT_GET: "host.appBrowserContext.get",
  HOST_DISPLAY_UPDATE: "host.display.update",
  HOST_NOTIFICATION_SHOW: "host.notification.show",
  HOST_SYSTEM_REQUEST_PERMISSION: "host.system.requestPermission",

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

  INTERNAL_WORKER_CANCEL_BY_CONVERSATION:
    "internal.worker.cancelByConversation",
  INTERNAL_WORKER_RESUME_EVENTS: "internal.worker.resumeEvents",
  INTERNAL_WORKER_ACK_EVENTS: "internal.worker.ackEvents",
  INTERNAL_WORKER_LIST_ACTIVE_RUNS: "internal.worker.listActiveRuns",
  INTERNAL_WORKER_RUN_AUTOMATION: "internal.worker.runAutomation",
  INTERNAL_WORKER_RUN_BLOCKING_AGENT: "internal.worker.runBlockingAgent",
  INTERNAL_WORKER_CREATE_BACKGROUND_AGENT:
    "internal.worker.createBackgroundAgent",
  INTERNAL_WORKER_GET_AGENT_SNAPSHOT: "internal.worker.getAgentSnapshot",
  INTERNAL_WORKER_APPEND_THREAD_MESSAGE: "internal.worker.appendThreadMessage",
  INTERNAL_WORKER_SEND_AGENT_INPUT: "internal.worker.sendAgentInput",
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
  INTERNAL_WORKER_LOCAL_CHAT_GET_SYNC_CHECKPOINT:
    "internal.worker.localChat.getSyncCheckpoint",
  INTERNAL_WORKER_LOCAL_CHAT_SET_SYNC_CHECKPOINT:
    "internal.worker.localChat.setSyncCheckpoint",
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
  INTERNAL_WORKER_PROJECTS_LIST: "internal.worker.projects.list",
  INTERNAL_WORKER_PROJECTS_REGISTER_DIRECTORY:
    "internal.worker.projects.registerDirectory",
  INTERNAL_WORKER_PROJECTS_START: "internal.worker.projects.start",
  INTERNAL_WORKER_PROJECTS_STOP: "internal.worker.projects.stop",
  INTERNAL_WORKER_ONE_SHOT_COMPLETION: "internal.worker.oneShotCompletion",
  INTERNAL_STORE_LOAD_THREAD_MESSAGES: "internal.store.loadThreadMessages",
  INTERNAL_STORE_LIST_ACTIVE_THREADS: "internal.store.listActiveThreads",
  INTERNAL_STORE_GET_ORCHESTRATOR_REMINDER_STATE:
    "internal.store.getOrchestratorReminderState",
  INTERNAL_STORE_RESOLVE_OR_CREATE_ACTIVE_THREAD:
    "internal.store.resolveOrCreateActiveThread",
  INTERNAL_STORE_APPEND_THREAD_MESSAGE: "internal.store.appendThreadMessage",
  INTERNAL_STORE_ARCHIVE_THREAD: "internal.store.archiveThread",
  INTERNAL_STORE_REPLACE_THREAD_MESSAGES:
    "internal.store.replaceThreadMessages",
  INTERNAL_STORE_UPDATE_THREAD_SUMMARY: "internal.store.updateThreadSummary",
  INTERNAL_STORE_RECORD_RUN_EVENT: "internal.store.recordRunEvent",
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
  SCHEDULE_UPDATED: "schedule.updated",
  MODEL_CATALOG_UPDATED: "modelCatalog.updated",
  PROJECTS_UPDATED: "projects.updated",
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
  convexUrl?: string | null;
  convexSiteUrl?: string | null;
  authToken?: string | null;
  hasConnectedAccount?: boolean;
  cloudSyncEnabled?: boolean;
  modelCatalogUpdatedAt?: number | null;
  localLlmCredentialsUpdatedAt?: number | null;
};

export type HostLlmCredentialsRequest =
  | { operation: "list" }
  | {
      operation: "get";
      kind: "api-key" | "oauth-api-key";
      provider: string;
    };

export type HostLlmCredentialsResult =
  | {
      ok: true;
      apiKeyProviders: string[];
      oauthProviders: string[];
    }
  | { ok: true; value: string | null }
  | { ok: false; reason: string };

export type RuntimeAuthRefreshSource =
  | "heartbeat"
  | "subscription"
  | "register"
  | "stella_provider"
  | "connector";

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

  pendingWorkerRestart?: boolean;
};

export type RuntimeAttachmentRef = {
  url: string;
  mimeType?: string;

  sourcePath?: string;

  kind?: string;
  name?: string;
  size?: number;
  transcript?: string;
  extractedText?: string;

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

  locale?: string;
  mode?: string;
  messageMetadata?: Record<string, unknown>;
  attachments?: RuntimeAttachmentRef[];
  userMessageEventId?: string;

  userMessageTimestamp?: number;
  agentType?: string;
  storageMode?: "cloud" | "local";
};

export type RuntimeVoiceTranscriptPayload = {
  conversationId: string;
  role: "user" | "assistant";
  text: string;
  uiVisibility?: "visible" | "hidden";

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

export type RuntimeOneShotCompletionRequest = {
  agentType: string;
  systemPrompt?: string;
  userText: string;
  maxOutputTokens?: number;
  temperature?: number;
  fallbackAgentTypes?: string[];

  model?: string;

  reasoningEffort?: "none" | "minimal" | "low" | "medium" | "high" | "xhigh";

  utility?: boolean;

  sessionKey?: string;

  closeSession?: boolean;

  sessionIdleTtlMs?: number;
};

export type RuntimeOneShotCompletionResult = {
  text: string;
};

export type RuntimeAutomationTurnRequest = {
  conversationId: string;
  userPrompt: string;
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

  userMessageEventId?: string;
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
  workingMode?: "direct" | "orchestrated";
  assistantMessageEventId?: string;
  assistantMessageText?: string;
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

export type HostDisplayUpdateParams = { payload: unknown };

export type HostRecentApp = {
  name: string;
  pid: number;
  isActive: boolean;
  bundleId?: string;
  windowTitle?: string;
};

export type HostActiveBrowserTab = {
  browser: string;
  url: string;
  bundleId?: string;
  title?: string;
};

export type HostAppBrowserContextSnapshot = {
  apps: HostRecentApp[];
  activeBrowserTab: HostActiveBrowserTab | null;
};

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
