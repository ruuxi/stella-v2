/**
 * Typed Electron IPC contract.
 *
 * Every channel in `ipc-channels.ts` that the preload bridge uses is listed
 * here with its payload types, in one of three maps:
 *
 * - `IpcInvokeContract`: renderer → main request/response (`ipcRenderer.invoke`
 *   / `ipcMain.handle`). `req` is the argument tuple after the event, `res`
 *   what the handler resolves with.
 * - `IpcSendContract`: renderer → main fire-and-forget (`ipcRenderer.send` /
 *   `ipcMain.on`), as the argument tuple after the event.
 * - `IpcEventContract`: main → renderer pushes (`webContents.send` /
 *   `ipcRenderer.on`), as the single payload (`void` when there is none).
 *
 * Main registers handlers through the typed helpers in
 * `desktop/electron/ipc/typed-ipc.ts`; the preload bridge
 * (`desktop/electron-api.ts`) calls through `TypedIpcRenderer`. A payload
 * mismatch on either side is a compile error.
 */
import type {
  AgentHealth,
  AllUserSignalsResult,
  BrowserDataResult,
  BrowserProfile,
  ChatContext,
  ChatContextUpdate,
  DiscoveryCategory,
  LocalCronJobRecord,
  LocalCronJobUpdatePatch,
  LocalHeartbeatConfigRecord,
  LocalHeartbeatUpsertInput,
  LocalLlmCredentialSummary,
  PreferredBrowserProfile,
  ScheduledConversationEvent,
  VoiceRuntimeSnapshot,
} from "../index.js";
import type { AgentStreamEvent } from "../agent-stream.js";
import type { AuthSessionSnapshot } from "../auth-session.js";
import type { StellaBrowserBridgeStatus } from "../browser-bridge-status.js";
import type { EvidenceCardSet } from "../chat-evidence.js";
import type {
  ChatGptProfileSummary,
  ChatGptProfilesState,
} from "../chatgpt-siwc-types.js";
import type {
  ClaudeLocalAccountsState,
  ClaudeLocalConfig,
  ClaudeLocalLoginStart,
} from "../claude-local-accounts.js";
import type {
  CloudConversationCacheAuthority,
  CloudConversationCacheLifecycleAuthority,
  CloudConversationCachePurgeResult,
  CloudConversationCacheReplaceInput,
  CloudConversationCacheReplaceResult,
  CloudConversationCacheSnapshot,
} from "../cloud-conversation-cache.js";
import type {
  CloudHomeImportOwnership,
  LocalCloudHomeScan,
} from "../cloud-home-sync.js";
import type {
  DeviceFileMissingReason,
  DeviceFileSource,
} from "../device-files.js";
import type { DiscoveryKnowledgeSeedPayload } from "../discovery.js";
import type { ExecutionTarget } from "../execution-placement.js";
import type {
  ConversationSummaryCursor,
  ConversationSummaryPage,
  EventRecord,
  LocalChatAgentReport,
  LocalChatLineageWindow,
  LocalChatMessageWindow,
  LocalChatToolEventPage,
  LocalChatUpdatedPayload,
  LocalModelUsagePage,
  ThreadActivityRecord,
  ThreadActivityUpdatedPayload,
} from "../local-chat.js";
import type { RealtimeVoicePreferences } from "../local-preferences.js";
import type { RuntimeModelCatalogSnapshot } from "../model-catalog.js";
import type { PiChatEventsPayload, PiChatRequest } from "../pi-chat.js";
import type {
  OfficePreviewRef,
  OfficePreviewSnapshot,
} from "../office-preview.js";
import type { RuntimeVoiceOrchestratorConfig } from "../protocol/index.js";
import type { ConversationFocusRoot, ReplyCounts } from "../reply-refs.js";
import type {
  UserAsk,
  UserAskAnswer,
  UserAskEscalationPolicy,
  UserAskState,
} from "../user-ask.js";
import type { AppSourceActionResult, AppSourceState } from "./app-source.js";
import type { BrowserViewLayout, BrowserViewState } from "./browser-view.js";
import type {
  CompanionActivity,
  CompanionDragMove,
  CompanionLayout,
  CompanionPanelStatus,
  CompanionSendRequest,
  CompanionState,
  CompanionVisibility,
} from "./companion.js";
import type { ExternalOpener } from "./external-openers.js";
import type {
  GetActiveBrowserTabResult,
  ListRecentAppsResult,
} from "./home.js";
import type { MemorySyncEraseResult, MemorySyncStatus } from "./memory-sync.js";
import type {
  OnboardingSynthesisRequest,
  OnboardingSynthesisResponse,
} from "./onboarding.js";
import type { UiState } from "./ui.js";
import {
  IPC_AGENT_CANCEL_CHAT,
  IPC_AGENT_EVENT,
  IPC_PI_CHAT_ENABLED,
  IPC_PI_CHAT_ENABLED_CHANGED,
  IPC_PI_CHAT_EVENTS,
  IPC_PI_CHAT_REQUEST,
  IPC_AGENT_GET_ACTIVE_RUN,
  IPC_AGENT_GET_SESSION_STARTED_AT,
  IPC_AGENT_HEALTH_CHECK,
  IPC_AGENT_ONE_SHOT_COMPLETION,
  IPC_AGENT_RESUME,
  IPC_AGENT_SEND_INPUT,
  IPC_AGENT_START_CHAT,
  IPC_APP_HARD_RESET,
  IPC_APP_QUIT_FOR_RESTART,
  IPC_APP_RELAUNCH,
  IPC_APP_RELOAD,
  IPC_APP_RESET_MESSAGES,
  IPC_APP_SET_READY,
  IPC_APP_SOURCE_APPLY,
  IPC_APP_SOURCE_APPLY_REMOTE,
  IPC_APP_SOURCE_APPLY_UPSTREAM,
  IPC_APP_SOURCE_GET_STATE,
  IPC_APP_SOURCE_SKIP,
  IPC_APP_SOURCE_STATE,
  IPC_APP_SOURCE_UNDO,
  IPC_AUTH_APPLY_SESSION_TOKEN,
  IPC_AUTH_DELETE_USER,
  IPC_AUTH_GET_CHALLENGE_TOKEN,
  IPC_AUTH_GET_SESSION,
  IPC_AUTH_GET_TOKEN,
  IPC_AUTH_REVOKE_SESSIONS,
  IPC_AUTH_SESSION_INVALIDATED,
  IPC_AUTH_SIGN_DEVICE,
  IPC_AUTH_SIGN_IN_ANONYMOUS,
  IPC_AUTH_SIGN_OUT,
  IPC_BROWSER_BRIDGE_STATUS,
  IPC_BROWSER_FETCH_JSON,
  IPC_BROWSER_FETCH_TEXT,
  IPC_BROWSER_VIEW_CLOSE_TAB,
  IPC_BROWSER_VIEW_CONNECT,
  IPC_BROWSER_VIEW_CREATE_TAB,
  IPC_BROWSER_VIEW_GET_STATE,
  IPC_BROWSER_VIEW_GO_BACK,
  IPC_BROWSER_VIEW_GO_FORWARD,
  IPC_BROWSER_VIEW_HIDE,
  IPC_BROWSER_VIEW_NAVIGATE,
  IPC_BROWSER_VIEW_RELOAD,
  IPC_BROWSER_VIEW_REQUEST_EXTENSION_CONNECT,
  IPC_BROWSER_VIEW_SELECT_TAB,
  IPC_BROWSER_VIEW_SET_LAYOUT,
  IPC_BROWSER_VIEW_SET_OWNER_SCOPE,
  IPC_BROWSER_VIEW_SET_VISIBLE_OWNER,
  IPC_BROWSER_VIEW_SHOW,
  IPC_BROWSER_VIEW_STATE,
  IPC_CAPTURE_BEGIN_REGION_CAPTURE,
  IPC_CAPTURE_CURSOR_DISPLAY_INFO,
  IPC_CAPTURE_PAGE_DATA_URL,
  IPC_CAPTURE_REGION_FAILED,
  IPC_CHAT_CONTEXT_GET,
  IPC_CHAT_CONTEXT_REMOVE_SCREENSHOT,
  IPC_CHAT_CONTEXT_SET,
  IPC_CHAT_CONTEXT_UPDATED,
  IPC_CHAT_EVIDENCE_CARDS,
  IPC_CHAT_OPEN_SIDEBAR,
  IPC_CHATGPT_CANCEL_SIGN_IN,
  IPC_CHATGPT_LIST_MODELS,
  IPC_CHATGPT_LIST_PROFILES,
  IPC_CHATGPT_PROFILES_CHANGED,
  IPC_CHATGPT_REMOVE,
  IPC_CHATGPT_SET_ACTIVE,
  IPC_CHATGPT_SIGN_IN,
  IPC_CHATGPT_SIGN_OUT,
  IPC_CLAUDE_ACCOUNTS_CANCEL_LOGIN,
  IPC_CLAUDE_ACCOUNTS_CHANGED,
  IPC_CLAUDE_ACCOUNTS_FINISH_LOGIN,
  IPC_CLAUDE_ACCOUNTS_LIST,
  IPC_CLAUDE_ACCOUNTS_SIGN_OUT,
  IPC_CLAUDE_ACCOUNTS_START_LOGIN,
  IPC_CLAUDE_ACCOUNTS_WAIT_LOGIN,
  IPC_CLOUD_CONVERSATION_CACHE_ACTIVATE_AUTHORITY,
  IPC_CLOUD_CONVERSATION_CACHE_PURGE_CONVERSATION,
  IPC_CLOUD_CONVERSATION_CACHE_READ,
  IPC_CLOUD_CONVERSATION_CACHE_REPLACE,
  IPC_CLOUD_CONVERSATION_CACHE_RETAIN_ACCOUNT,
  IPC_CLOUD_HOME_CONFIRM_IMPORT_OWNERSHIP,
  IPC_CLOUD_HOME_GET_IMPORT_OWNERSHIP,
  IPC_CLOUD_HOME_SCAN_LOCAL,
  IPC_COMPANION_ACTIVITY,
  IPC_COMPANION_DRAG_END,
  IPC_COMPANION_DRAG_MOVE,
  IPC_COMPANION_DRAG_START,
  IPC_COMPANION_FOCUS,
  IPC_COMPANION_GET_STATE,
  IPC_COMPANION_GET_VISIBLE,
  IPC_COMPANION_HELLO,
  IPC_COMPANION_HOVER,
  IPC_COMPANION_LAYOUT,
  IPC_COMPANION_OPEN_MAIN,
  IPC_COMPANION_PANEL_STATUS,
  IPC_COMPANION_PUBLISH_STATE,
  IPC_COMPANION_SEND,
  IPC_COMPANION_SEND_REQUESTED,
  IPC_COMPANION_SET_EXPANDED,
  IPC_COMPANION_SET_VISIBLE,
  IPC_COMPANION_SHOW_CONTEXT_MENU,
  IPC_COMPANION_STATE,
  IPC_COMPANION_STOP,
  IPC_COMPANION_STOP_REQUESTED,
  IPC_COMPANION_TOGGLE_EXPANDED,
  IPC_COMPANION_VISIBLE_CHANGED,
  IPC_CONNECTOR_CONNECT_REQUEST,
  IPC_CONNECTOR_CONNECT_RESPOND,
  IPC_CONNECTOR_CONNECT_UPDATE,
  IPC_CONNECTOR_CREDENTIAL_CANCEL,
  IPC_CONNECTOR_CREDENTIAL_COMPLETE,
  IPC_CONNECTOR_CREDENTIAL_REQUEST,
  IPC_CONNECTOR_CREDENTIAL_SUBMIT,
  IPC_CUSTOMIZATIONS_RESET,
  IPC_DEVICE_GET_ID,
  IPC_DEVTEST_FIX_VITE_ERROR,
  IPC_DEVTEST_TRIGGER_VITE_ERROR,
  IPC_DIAGNOSTICS_EXPORT_LOGS,
  IPC_DIAGNOSTICS_OPEN_LOGS,
  IPC_DIAGNOSTICS_RECORD_HEAP_TRACE,
  IPC_DIAGNOSTICS_REPORT_ERROR,
  IPC_DIAGNOSTICS_REPORT_TIMING,
  IPC_DICTATION_ACTIVE_CHANGED,
  IPC_DICTATION_CANCEL_OPENROUTER,
  IPC_DICTATION_GET_SHORTCUT,
  IPC_DICTATION_GET_SOUND_EFFECTS_ENABLED,
  IPC_DICTATION_HAS_OPENROUTER_KEY,
  IPC_DICTATION_PLAY_SOUND,
  IPC_DICTATION_SET_SHORTCUT,
  IPC_DICTATION_SET_SOUND_EFFECTS_ENABLED,
  IPC_DICTATION_TOGGLE,
  IPC_DICTATION_TRANSCRIBE_WITH_OPENROUTER,
  IPC_DISCOVERY_COLLECT_ALL_SIGNALS,
  IPC_DISCOVERY_COLLECT_BROWSER_DATA,
  IPC_DISCOVERY_CORE_MEMORY_EXISTS,
  IPC_DISCOVERY_DETECT_PREFERRED_BROWSER,
  IPC_DISCOVERY_KNOWLEDGE_EXISTS,
  IPC_DISCOVERY_LIST_BROWSER_PROFILES,
  IPC_DISCOVERY_WRITE_CORE_MEMORY,
  IPC_DISCOVERY_WRITE_KNOWLEDGE,
  IPC_DISPLAY_CANVAS_FILE_URL,
  IPC_DISPLAY_CANVAS_HTML_URL,
  IPC_DISPLAY_LIST_CANVAS_HTML,
  IPC_DISPLAY_MEDIA_SOURCE,
  IPC_DISPLAY_OPEN_SHARED_CANVAS,
  IPC_DISPLAY_READ_FILE,
  IPC_DISPLAY_TRASH_FORCE_DELETE,
  IPC_DISPLAY_TRASH_LIST,
  IPC_DISPLAY_UPDATE,
  IPC_ENGINE_ACCOUNTS_CANCEL_CONNECT_CHATGPT_CLOUD,
  IPC_ENGINE_ACCOUNTS_CONNECT_CHATGPT_CLOUD,
  IPC_EXECUTION_ANSWER_REMOTE_REQUEST,
  IPC_EXECUTION_REMOTE_REQUEST,
  IPC_EXECUTION_TARGET_SET,
  IPC_GLOBAL_SHORTCUTS_GET_SUSPENDED,
  IPC_GLOBAL_SHORTCUTS_SET_SUSPENDED,
  IPC_HOME_CAPTURE_APP_WINDOW,
  IPC_HOME_GET_ACTIVE_BROWSER_TAB,
  IPC_HOME_LIST_RECENT_APPS,
  IPC_HOST_CONFIGURE_RUNTIME,
  IPC_HOST_SET_CLOUD_SYNC,
  IPC_LLM_CREDENTIALS_CANCEL_OAUTH,
  IPC_LLM_CREDENTIALS_DELETE,
  IPC_LLM_CREDENTIALS_DELETE_OAUTH,
  IPC_LLM_CREDENTIALS_LIST,
  IPC_LLM_CREDENTIALS_LIST_OAUTH,
  IPC_LLM_CREDENTIALS_LIST_OAUTH_PROVIDERS,
  IPC_LLM_CREDENTIALS_LOGIN_OAUTH,
  IPC_LLM_CREDENTIALS_SAVE,
  IPC_LLM_CREDENTIALS_VALIDATE_OAUTH,
  IPC_LOCAL_CHAT_CREATE_NEW_DEFAULT_ID,
  IPC_LOCAL_CHAT_DELETE_CONVERSATION,
  IPC_LOCAL_CHAT_GET_AGENT_REPORT,
  IPC_LOCAL_CHAT_GET_EVENT_COUNT,
  IPC_LOCAL_CHAT_GET_OR_CREATE_ID,
  IPC_LOCAL_CHAT_LIST_ACTIVITY,
  IPC_LOCAL_CHAT_LIST_CONVERSATIONS,
  IPC_LOCAL_CHAT_LIST_EVENTS,
  IPC_LOCAL_CHAT_LIST_FILES,
  IPC_LOCAL_CHAT_LIST_LINEAGE_MESSAGES,
  IPC_LOCAL_CHAT_LIST_MESSAGE_TOOL_EVENTS,
  IPC_LOCAL_CHAT_LIST_MESSAGES,
  IPC_LOCAL_CHAT_LIST_MESSAGES_AFTER,
  IPC_LOCAL_CHAT_LIST_MESSAGES_BEFORE,
  IPC_LOCAL_CHAT_LIST_MODEL_USAGE,
  IPC_LOCAL_CHAT_LIST_REPLY_COUNTS,
  IPC_LOCAL_CHAT_LIST_THREAD_ACTIVITY,
  IPC_LOCAL_CHAT_PERSIST_WELCOME,
  IPC_LOCAL_CHAT_SET_ACTIVE_ID,
  IPC_LOCAL_CHAT_THREAD_ACTIVITY_UPDATED,
  IPC_LOCAL_CHAT_UPDATED,
  IPC_MEDIA_COPY_ATTACHMENT,
  IPC_MEDIA_COPY_IMAGE,
  IPC_MEDIA_GET_DIR,
  IPC_MEDIA_SAVE_OUTPUT,
  IPC_MEETINGS_OPEN_FOLDER,
  IPC_MEETINGS_PAUSE,
  IPC_MEETINGS_RESUME,
  IPC_MEETINGS_START,
  IPC_MEETINGS_STATUS,
  IPC_MEETINGS_STOP,
  IPC_MEMORY_SYNC_ERASE_LOCAL,
  IPC_MEMORY_SYNC_GET_STATUS,
  IPC_MEMORY_SYNC_NOW,
  IPC_MEMORY_SYNC_STATUS,
  IPC_NATIVE_INTEGRATIONS_DISABLE,
  IPC_NATIVE_INTEGRATIONS_ENABLE,
  IPC_NATIVE_INTEGRATIONS_LIST,
  IPC_OFFICE_PREVIEW_LIST,
  IPC_OFFICE_PREVIEW_START,
  IPC_OFFICE_PREVIEW_UPDATE,
  IPC_ONBOARDING_SYNTHESIZE,
  IPC_OVERLAY_DISPLAY_CHANGE,
  IPC_OVERLAY_END_REGION_CAPTURE,
  IPC_OVERLAY_HIDE_SCREEN_GUIDE,
  IPC_OVERLAY_HIDE_SELECTION_CHIP,
  IPC_OVERLAY_HIDE_WINDOW_HIGHLIGHT,
  IPC_OVERLAY_PREVIEW_WINDOW_HIGHLIGHT_AT_POINT,
  IPC_OVERLAY_SELECTION_CHIP_CLICKED,
  IPC_OVERLAY_SET_INTERACTIVE,
  IPC_OVERLAY_SHOW_SCREEN_GUIDE,
  IPC_OVERLAY_SHOW_SELECTION_CHIP,
  IPC_OVERLAY_SHOW_WINDOW_HIGHLIGHT,
  IPC_OVERLAY_START_REGION_CAPTURE,
  IPC_OVERLAY_WINDOW_HIGHLIGHT,
  IPC_PERMISSIONS_GET_STATUS,
  IPC_PERMISSIONS_OPEN_SETTINGS,
  IPC_PERMISSIONS_REQUEST,
  IPC_PERMISSIONS_RESET,
  IPC_PERMISSIONS_RESET_MICROPHONE,
  IPC_PREFERENCES_GET_LOCKED_COMPUTER_USE,
  IPC_PREFERENCES_GET_MODELS,
  IPC_PREFERENCES_GET_ONBOARDING_COMPLETED,
  IPC_PREFERENCES_GET_PREVENT_SLEEP,
  IPC_PREFERENCES_GET_READ_ALOUD,
  IPC_PREFERENCES_GET_SOUND_NOTIFICATIONS,
  IPC_PREFERENCES_GET_WAKE_WORD,
  IPC_PREFERENCES_LIST_CLAUDE_CODE_MODELS,
  IPC_PREFERENCES_LIST_MODELS,
  IPC_PREFERENCES_MODELS_UPDATED,
  IPC_PREFERENCES_READ_ALOUD_CHANGED,
  IPC_PREFERENCES_SET_LOCKED_COMPUTER_USE,
  IPC_PREFERENCES_SET_MODELS,
  IPC_PREFERENCES_SET_ONBOARDING_COMPLETED,
  IPC_PREFERENCES_SET_PREVENT_SLEEP,
  IPC_PREFERENCES_SET_READ_ALOUD,
  IPC_PREFERENCES_SET_SOUND_NOTIFICATIONS,
  IPC_PREFERENCES_SET_WAKE_WORD,
  IPC_PROMPT_PRESETS_DELETE,
  IPC_PROMPT_PRESETS_LIST,
  IPC_PROMPT_PRESETS_READ,
  IPC_PROMPT_PRESETS_SAVE,
  IPC_PROMPT_PRESETS_SELECT,
  IPC_REGION_CANCEL,
  IPC_REGION_CLICK,
  IPC_REGION_COMMIT_PREPARED,
  IPC_REGION_GET_WINDOW_CAPTURE,
  IPC_REGION_PREPARE_SELECTION,
  IPC_REGION_SELECT,
  IPC_RUNTIME_AVAILABILITY,
  IPC_SCHEDULE_GET_EVENT_COUNT,
  IPC_SCHEDULE_LIST_CONVERSATION_EVENTS,
  IPC_SCHEDULE_LIST_CRON_JOBS,
  IPC_SCHEDULE_LIST_HEARTBEATS,
  IPC_SCHEDULE_REMOVE_CRON_JOB,
  IPC_SCHEDULE_RUN_CRON_JOB,
  IPC_SCHEDULE_RUN_HEARTBEAT,
  IPC_SCHEDULE_UPDATE_CRON_JOB,
  IPC_SCHEDULE_UPDATED,
  IPC_SCHEDULE_UPSERT_HEARTBEAT,
  IPC_SCREEN_GUIDE_HIDE,
  IPC_SCREEN_GUIDE_SHOW,
  IPC_SCREENSHOT_CAPTURE,
  IPC_SCREENSHOT_CAPTURE_VISION,
  IPC_SHELL_KILL_BY_PORT,
  IPC_SHELL_LIST_OPENERS,
  IPC_SHELL_OPEN_EXTERNAL,
  IPC_SHELL_OPEN_PATH,
  IPC_SHELL_OPEN_WITH,
  IPC_SHELL_SAVE_FILE_AS,
  IPC_SHELL_SHOW_IN_FOLDER,
  IPC_SYSTEM_DETECT_TECHNICAL_USER_SIGNALS,
  IPC_SYSTEM_OPEN_FDA,
  IPC_THEME_LIST_INSTALLED,
  IPC_UI_GET_STATE,
  IPC_UI_SET_STATE,
  IPC_UI_STATE,
  IPC_UI_STATE_KV_APPLY,
  IPC_UI_STATE_KV_CHANGED,
  IPC_UI_STATE_KV_CLEAR,
  IPC_UI_STATE_KV_SNAPSHOT,
  IPC_USER_ASK_ANSWER,
  IPC_USER_ASK_CANCEL,
  IPC_USER_ASK_CLOSED,
  IPC_USER_ASK_LIST,
  IPC_USER_ASK_OPENED,
  IPC_USER_ASK_OVERRIDE_SENSITIVE,
  IPC_USER_ASK_POLICY_GET,
  IPC_USER_ASK_POLICY_SET,
  IPC_USER_ASK_UPDATED,
  IPC_VOICE_CREATE_OPENAI_SESSION,
  IPC_VOICE_CREATE_XAI_SESSION,
  IPC_VOICE_GET_RUNTIME_STATE,
  IPC_VOICE_GET_SESSION_ERROR_STATE,
  IPC_VOICE_ORCHESTRATOR_ACTIVITY,
  IPC_VOICE_ORCHESTRATOR_CHAT,
  IPC_VOICE_ORCHESTRATOR_CONFIG,
  IPC_VOICE_PERSIST_TRANSCRIPT,
  IPC_VOICE_PREFERENCES_CHANGED,
  IPC_VOICE_REPORT_SESSION_ERROR,
  IPC_VOICE_REPORT_SESSION_ERROR_STATE,
  IPC_VOICE_RTC_GET_SHORTCUT,
  IPC_VOICE_RTC_SET_SHORTCUT,
  IPC_VOICE_RTC_TOGGLE,
  IPC_VOICE_RUNTIME_STATE,
  IPC_VOICE_SESSION_ERROR,
  IPC_VOICE_SESSION_ERROR_STATE,
  IPC_VOICE_WEB_SEARCH,
  IPC_WEBSITE_GET_BASE_URL,
  IPC_WINDOW_CLOSE,
  IPC_WINDOW_IS_MAXIMIZED,
  IPC_WINDOW_MAXIMIZE,
  IPC_WINDOW_MINIMIZE,
  IPC_WINDOW_SET_NATIVE_BUTTONS_VISIBLE,
  IPC_WINDOW_SHOW,
} from "./ipc-channels.js";

// ---------------------------------------------------------------------------
// Payload types shared by several channels
// ---------------------------------------------------------------------------

export type IpcPoint = { x: number; y: number };

export type IpcRect = { x: number; y: number; width: number; height: number };

export type CapturedScreenshot = {
  dataUrl: string;
  width: number;
  height: number;
};

export type VisionScreenshot = CapturedScreenshot & {
  displayId: number;
  screenNumber: number;
  label: string;
  isPrimaryFocus: boolean;
  coordinateSpace: {
    x: number;
    y: number;
    logicalWidth: number;
    logicalHeight: number;
    sourceWidth: number;
    sourceHeight: number;
    targetWidth: number;
    targetHeight: number;
  };
};

export type RegionCaptureResult = {
  screenshot: CapturedScreenshot | null;
  window: {
    app: string;
    title: string;
    bounds: IpcRect;
  } | null;
};

export type ScreenGuideAnnotation = {
  id: string;
  label: string;
  x: number;
  y: number;
};

export type WindowHighlightTone = "default" | "subtle";

export type DisplayReadFileResult =
  | {
      bytes: Uint8Array;
      sizeBytes: number;
      mimeType: string;
      truncated: boolean;
      missing: false;
    }
  | {
      missing: true;
      mimeType: string;
      path: string;
      reason?: DeviceFileMissingReason;
    };

export type CanvasHtmlEntry = {
  filePath: string;
  slug: string;
  title: string;
  createdAt: number;
};

export type DisplayTrashItem = {
  id: string;
  source: string;
  originalPath: string;
  trashPath: string;
  trashedAt: number;
  purgeAfter: number;
  requestId?: string;
  agentType?: string;
  conversationId?: string;
};

export type DisplayTrashPurgeResult = {
  checked: number;
  purged: number;
  skipped: number;
  errors: string[];
};

export type ShortcutRegistrationResult = {
  ok: boolean;
  requestedShortcut: string;
  activeShortcut: string;
  error?: string;
};

export type VoiceOrchestratorActivity = {
  requestId: string;
  kind: "status" | "tool-start" | "tool-end";
  statusText?: string;
  toolName?: string;
  toolCallId?: string;
  isError?: boolean;
};

export type VoiceTranscriptPayload = {
  conversationId: string;
  role: "user" | "assistant";
  text: string;
  uiVisibility?: "visible" | "hidden";
  voiceSession?: { durationMs: number };
};

export type RealtimeVoiceSession =
  | {
      provider: "openai";
      clientSecret: string;
      model: string;
      voice: string;
      expiresAt?: number;
      sessionId?: string;
    }
  | {
      provider: "xai";
      clientSecret: string;
      model: string;
      voice: string;
      expiresAt?: number;
    };

export type DictationToggle = {
  startId?: string;
  action?: "toggle" | "start" | "stop" | "cancel";
  /** Set when the global shortcut was routed to the companion window. */
  source?: "companion";
};

export type OneShotCompletionRequest = {
  agentType: string;
  systemPrompt?: string;
  userText: string;
  maxOutputTokens?: number;
  temperature?: number;
  fallbackAgentTypes?: string[];
  model?: string;
  reasoningEffort?: "none" | "low" | "medium" | "high";
  utility?: boolean;
  sessionKey?: string;
  closeSession?: boolean;
  sessionIdleTtlMs?: number;
};

export type StartChatRequest = {
  conversationId: string;
  userPrompt: string;
  selectedText?: string | null;
  chatContext?: ChatContext | null;
  deviceId?: string;
  platform?: string;
  timezone?: string;
  /** BCP-47 locale for the user's preferred response language. */
  locale?: string;
  mode?: string;
  messageMetadata?: Record<string, unknown>;
  attachments?: Array<{
    url: string;
    mimeType?: string;
  }>;
  userMessageEventId?: string;
  userMessageTimestamp?: number;
  agentType?: string;
  storageMode?: "cloud" | "local";
  clientRequestId?: string;
  executionTarget?: ExecutionTarget;
};

export type StartChatResult = {
  requestId: string;
  runId?: string;
  userMessageId?: string;
  accepted?: boolean;
  deduplicated?: boolean;
};

export type ResumeConversationResult = {
  activeRun: {
    runId: string;
    conversationId: string;
    requestId?: string;
    userMessageId?: string;
    uiVisibility?: "visible" | "hidden";
  } | null;
  events: AgentStreamEvent[];
};

export type RuntimeAvailabilitySnapshot = {
  connected: boolean;
  ready: boolean;
  reason?: string;
  /** Runtime update detected but deferred until current work finishes. */
  pendingRuntimeRestart?: boolean;
};

export type PermissionStatus = {
  accessibility: boolean;
  screen: boolean;
  microphone: boolean;
  microphoneStatus:
    | "not-determined"
    | "granted"
    | "denied"
    | "restricted"
    | "unknown";
};

export type ResettablePermissionKind =
  | "accessibility"
  | "screen"
  | "microphone";

export type LockedComputerUseStatus = {
  ok: boolean;
  enabled: boolean;
  installed: boolean;
  active: boolean;
  locked: boolean;
  suppressedUntilManualUnlock: boolean;
  message: string;
  warnings: string[];
};

export type OkResult = { ok: boolean };

export type OkErrorResult = { ok: boolean; error?: string };

export type FileResult = { ok: boolean; path?: string; error?: string };

export type PromptPresetSummary = { id: string; name: string; agentId: string };

export type ReasoningEffortPreference =
  | "default"
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh";

export type LocalModelPreferences = {
  defaultModels: Record<string, string>;
  modelOverrides: Record<string, string>;
  assistantPropagatedAgents: string[];
  reasoningEfforts: Record<string, ReasoningEffortPreference>;
  stellaConversationModelOverrides: Record<string, string>;
  stellaConversationReasoningEfforts: Record<string, ReasoningEffortPreference>;
  agentRuntimeEngine: "default" | "claude_code_local" | "codex_cli";
  codexModel: string;
  codexModelExplicit: boolean;
  codexReasoningEffort: ReasoningEffortPreference;
  codexServiceTier: "standard" | "fast";
  claudeCodeModel: string;
  claudeCodeReasoningEffort: ReasoningEffortPreference;
  useNativeClaudeCodeRuntime: boolean;
  maxAgentConcurrency: number;
  imageGeneration: {
    provider: "stella" | "openai" | "openrouter" | "fal";
    model?: string;
  };
  realtimeVoice: RealtimeVoicePreferences;
  memoryEnabled: boolean;
};

export type LocalLlmOAuthProviderSummary = {
  provider: string;
  label: string;
};

export type TechnicalUserSignal =
  | "claude-app"
  | "chatgpt-app"
  | "cursor-app"
  | "claude-cli"
  | "opencode-cli"
  | "pi-cli";

export type ConnectorCredentialRequest = {
  requestId: string;
  tokenKey: string;
  displayName: string;
  mode: "api_key" | "oauth";
  completionMode?: "approve" | "wait";
  description?: string;
  placeholder?: string;
  oauthUserCode?: string;
  oauthVerificationUri?: string;
};

export type ConnectorCredentialComplete = {
  requestId: string;
  ok: boolean;
  reason?: string;
};

export type ConnectorConnectRequest = {
  requestId: string;
  id: string;
  name: string;
  description?: string;
  iconUrl?: string;
  category?: string;
  reason?: string;
  kind?: "integration" | "browser-extension";
  conversationId?: string;
};

export type ConnectorConnectUpdate = {
  requestId: string;
  phase:
    | "connecting"
    | "connected"
    | "declined"
    | "cancelled"
    | "timeout"
    | "error";
  message?: string;
};

export type BrowserFetchInit = {
  method?: "GET" | "POST";
  headers?: Record<string, string>;
  body?: string;
};

export type BrowserFetchRequest = { url: string; init?: BrowserFetchInit };

export type AppWindowCapture = {
  capture: {
    title: string;
    axTree?: string | null;
    screenshot: CapturedScreenshot;
  } | null;
};

export type MeetingStatus = {
  available: boolean;
  running?: boolean;
  recording?: boolean;
  paused?: boolean;
  sessionId?: string | null;
  startedAtMs?: number | null;
  segmentSeconds?: number;
  screenPermission?: boolean;
  micPermission?: boolean;
};

export type MeetingStartResult = {
  ok: boolean;
  sessionId?: string;
  dir?: string;
  segmentSeconds?: number;
  system?: boolean;
  mic?: boolean;
  startedAtMs?: number;
  reason?: string;
};

export type MeetingStopResult = {
  ok: boolean;
  sessionId?: string;
  dir?: string;
  durationMs?: number;
  systemSegments?: number;
  micSegments?: number;
  reason?: string;
};

export type NativeIntegration = {
  id: string;
  name: string;
  category: string;
  auth: readonly string[];
  catalogToolCount: number;
  availability: "ready";
  provider: "google-workspace" | "oauth-catalog" | "backend-composio";
  /** Bundled execution is opt-in. Recovered OAuth entries are metadata only. */
  localExecution?: "production-ready" | "incomplete";
  toolPrefix?: string;
  sourceUrl?: string;
  iconUrl?: string;
  description: string;
  connectable: boolean;
  oauthSetupStatus:
    | "ready"
    | "local_implementation_incomplete"
    | "missing_oauth_app"
    | "missing_backend_exchange"
    | "missing_callback_bridge";
  oauthSetupMessage: string;
  oauthSetupGroup?: {
    id: string;
    name: string;
  };
  oauthProviderTemplate?: boolean;
  enabled: boolean;
  enabledAt?: number;
  skillPath?: string;
  toolCount: number;
  actionCount?: number;
};

// ---------------------------------------------------------------------------
// Contract
// ---------------------------------------------------------------------------

type Invoke<Req extends unknown[], Res> = { req: Req; res: Res };

export type IpcInvokeContract = {
  // Cloud home / memory sync / derived cloud cache
  [IPC_CLOUD_HOME_SCAN_LOCAL]: Invoke<
    [accountScope: string],
    LocalCloudHomeScan
  >;
  [IPC_CLOUD_HOME_GET_IMPORT_OWNERSHIP]: Invoke<
    [accountScope: string],
    CloudHomeImportOwnership
  >;
  [IPC_CLOUD_HOME_CONFIRM_IMPORT_OWNERSHIP]: Invoke<
    [accountScope: string],
    boolean
  >;
  [IPC_MEMORY_SYNC_GET_STATUS]: Invoke<[], MemorySyncStatus>;
  [IPC_MEMORY_SYNC_NOW]: Invoke<[], MemorySyncStatus>;
  [IPC_MEMORY_SYNC_ERASE_LOCAL]: Invoke<[], MemorySyncEraseResult>;
  [IPC_CLOUD_CONVERSATION_CACHE_RETAIN_ACCOUNT]: Invoke<
    [payload: { accountScope: string }],
    CloudConversationCachePurgeResult
  >;
  [IPC_CLOUD_CONVERSATION_CACHE_ACTIVATE_AUTHORITY]: Invoke<
    [authority: CloudConversationCacheLifecycleAuthority],
    CloudConversationCachePurgeResult
  >;
  [IPC_CLOUD_CONVERSATION_CACHE_READ]: Invoke<
    [authority: CloudConversationCacheAuthority],
    CloudConversationCacheSnapshot | null
  >;
  [IPC_CLOUD_CONVERSATION_CACHE_REPLACE]: Invoke<
    [input: CloudConversationCacheReplaceInput],
    CloudConversationCacheReplaceResult
  >;
  [IPC_CLOUD_CONVERSATION_CACHE_PURGE_CONVERSATION]: Invoke<
    [authority: CloudConversationCacheAuthority],
    CloudConversationCachePurgeResult
  >;

  // Window / UI
  [IPC_WINDOW_IS_MAXIMIZED]: Invoke<[], boolean>;
  [IPC_UI_GET_STATE]: Invoke<[], UiState>;
  [IPC_UI_SET_STATE]: Invoke<[partial: Partial<UiState>], UiState>;
  [IPC_APP_HARD_RESET]: Invoke<[], OkResult>;
  [IPC_THEME_LIST_INSTALLED]: Invoke<[], unknown[]>;
  [IPC_WEBSITE_GET_BASE_URL]: Invoke<[], string>;

  // Display
  [IPC_DISPLAY_READ_FILE]: Invoke<
    [
      payload: {
        filePath: string;
        conversationId?: string | null;
        maxBytes?: number;
      },
    ],
    DisplayReadFileResult
  >;
  [IPC_DISPLAY_MEDIA_SOURCE]: Invoke<
    [payload: { filePath: string }],
    DeviceFileSource
  >;
  [IPC_DISPLAY_LIST_CANVAS_HTML]: Invoke<[], CanvasHtmlEntry[]>;
  [IPC_DISPLAY_OPEN_SHARED_CANVAS]: Invoke<
    [payload: { url: string }],
    ({ kind: "canvas-html" } & CanvasHtmlEntry) | null
  >;
  [IPC_DISPLAY_CANVAS_FILE_URL]: Invoke<
    [payload: { filePath: string }],
    { url: string } | { missing: true; message?: string }
  >;
  [IPC_DISPLAY_CANVAS_HTML_URL]: Invoke<
    [payload: { html: string }],
    { url: string }
  >;
  [IPC_DISPLAY_TRASH_LIST]: Invoke<
    [],
    { items: DisplayTrashItem[]; errors: string[] }
  >;
  [IPC_DISPLAY_TRASH_FORCE_DELETE]: Invoke<
    [payload: { id?: string; all?: boolean }],
    DisplayTrashPurgeResult
  >;
  [IPC_OFFICE_PREVIEW_LIST]: Invoke<
    [options: { conversationId?: string | null }],
    OfficePreviewSnapshot[]
  >;
  [IPC_OFFICE_PREVIEW_START]: Invoke<
    [payload: { filePath: string; conversationId?: string | null }],
    OfficePreviewRef
  >;
  [IPC_CHAT_EVIDENCE_CARDS]: Invoke<
    [payload: { filePaths: string[] }],
    EvidenceCardSet
  >;

  // Remote execution / app source
  [IPC_EXECUTION_ANSWER_REMOTE_REQUEST]: Invoke<
    [payload: { allow: boolean }],
    { allow: boolean }
  >;
  [IPC_APP_SOURCE_GET_STATE]: Invoke<[], AppSourceState | null>;
  [IPC_APP_SOURCE_APPLY]: Invoke<[name: string], AppSourceActionResult>;
  [IPC_APP_SOURCE_UNDO]: Invoke<[sha: string], AppSourceActionResult>;
  [IPC_APP_SOURCE_APPLY_REMOTE]: Invoke<[], AppSourceActionResult>;
  [IPC_APP_SOURCE_APPLY_UPSTREAM]: Invoke<[], AppSourceActionResult>;
  [IPC_APP_SOURCE_SKIP]: Invoke<[key: string], AppSourceActionResult>;

  // Capture
  [IPC_CHAT_CONTEXT_GET]: Invoke<[], ChatContext | null>;
  [IPC_SCREENSHOT_CAPTURE]: Invoke<
    [point?: IpcPoint],
    CapturedScreenshot | null
  >;
  [IPC_SCREENSHOT_CAPTURE_VISION]: Invoke<
    [point?: IpcPoint],
    VisionScreenshot[]
  >;
  [IPC_REGION_PREPARE_SELECTION]: Invoke<
    [selection: IpcRect],
    { screenshot: CapturedScreenshot | null; window: null } | null
  >;
  [IPC_REGION_GET_WINDOW_CAPTURE]: Invoke<
    [point: IpcPoint],
    { bounds: IpcRect; thumbnail: string; result: RegionCaptureResult } | null
  >;
  [IPC_CAPTURE_CURSOR_DISPLAY_INFO]: Invoke<
    [],
    IpcRect & { scaleFactor: number }
  >;
  [IPC_CAPTURE_PAGE_DATA_URL]: Invoke<[], string | null>;
  [IPC_CAPTURE_BEGIN_REGION_CAPTURE]: Invoke<
    [],
    { ok: true } | { cancelled: true }
  >;

  // Voice
  [IPC_VOICE_ORCHESTRATOR_CHAT]: Invoke<
    [
      payload: {
        /** Correlates the run's forwarded activity back to this request. */
        requestId: string;
        conversationId: string;
        message: string;
      },
    ],
    string
  >;
  [IPC_VOICE_ORCHESTRATOR_CONFIG]: Invoke<
    [payload: { conversationId: string }],
    RuntimeVoiceOrchestratorConfig
  >;
  [IPC_VOICE_WEB_SEARCH]: Invoke<
    [payload: { query: string; category?: string }],
    {
      text: string;
      results: Array<{ title: string; url: string; snippet: string }>;
    }
  >;
  [IPC_VOICE_CREATE_OPENAI_SESSION]: Invoke<
    [payload: { instructions?: string }],
    Extract<RealtimeVoiceSession, { provider: "openai" }>
  >;
  [IPC_VOICE_CREATE_XAI_SESSION]: Invoke<
    [payload: { instructions?: string }],
    Extract<RealtimeVoiceSession, { provider: "xai" }>
  >;
  [IPC_VOICE_GET_RUNTIME_STATE]: Invoke<[], VoiceRuntimeSnapshot>;
  [IPC_VOICE_RTC_SET_SHORTCUT]: Invoke<
    [shortcut: string],
    ShortcutRegistrationResult
  >;
  [IPC_VOICE_RTC_GET_SHORTCUT]: Invoke<[], string>;
  [IPC_VOICE_GET_SESSION_ERROR_STATE]: Invoke<[], string>;

  // Dictation
  [IPC_DICTATION_GET_SHORTCUT]: Invoke<[], string>;
  [IPC_DICTATION_SET_SHORTCUT]: Invoke<
    [shortcut: string],
    ShortcutRegistrationResult
  >;
  [IPC_DICTATION_GET_SOUND_EFFECTS_ENABLED]: Invoke<[], boolean>;
  [IPC_DICTATION_SET_SOUND_EFFECTS_ENABLED]: Invoke<
    [enabled: boolean],
    { enabled: boolean }
  >;
  [IPC_DICTATION_HAS_OPENROUTER_KEY]: Invoke<[], boolean>;
  [IPC_DICTATION_TRANSCRIBE_WITH_OPENROUTER]: Invoke<
    [payload: { requestId: string; wav: ArrayBuffer }],
    { text: string }
  >;

  // Companion
  [IPC_COMPANION_GET_STATE]: Invoke<[], CompanionState | null>;
  [IPC_COMPANION_GET_VISIBLE]: Invoke<[], CompanionVisibility>;
  [IPC_COMPANION_SET_VISIBLE]: Invoke<[visible: boolean], CompanionVisibility>;

  // Agent
  [IPC_AGENT_ONE_SHOT_COMPLETION]: Invoke<
    [payload: OneShotCompletionRequest],
    { text: string }
  >;
  [IPC_AGENT_HEALTH_CHECK]: Invoke<[], AgentHealth | null>;
  [IPC_AGENT_GET_ACTIVE_RUN]: Invoke<
    [],
    {
      runId: string;
      conversationId: string;
      uiVisibility?: "visible" | "hidden";
    } | null
  >;
  [IPC_AGENT_GET_SESSION_STARTED_AT]: Invoke<[], number>;
  [IPC_AGENT_START_CHAT]: Invoke<[payload: StartChatRequest], StartChatResult>;
  [IPC_AGENT_SEND_INPUT]: Invoke<
    [
      payload: {
        conversationId: string;
        threadId: string;
        message: string;
        metadata?: Record<string, unknown>;
      },
    ],
    { delivered: boolean }
  >;
  [IPC_AGENT_RESUME]: Invoke<
    [
      payload: {
        conversationId: string;
        lastSeq: number;
        /**
         * Highest worker/recorder seq the renderer has seen. `lastSeq` is
         * main's wire cursor; only this one is a valid cursor into the host
         * run-event log.
         */
        lastSourceSeq?: number;
      },
    ],
    ResumeConversationResult
  >;
  [IPC_DEVTEST_TRIGGER_VITE_ERROR]: Invoke<[], OkResult>;
  [IPC_DEVTEST_FIX_VITE_ERROR]: Invoke<[], OkResult>;

  // System / auth
  [IPC_DEVICE_GET_ID]: Invoke<[], string | null>;
  [IPC_AUTH_SIGN_DEVICE]: Invoke<
    [input: string],
    { alg: "ed25519"; rawPublicKey: number[]; signature: string }
  >;
  [IPC_HOST_CONFIGURE_RUNTIME]: Invoke<
    [config: { backendUrl: string }],
    { deviceId: string | null }
  >;
  [IPC_AUTH_GET_SESSION]: Invoke<
    [options?: { allowCached?: boolean }],
    AuthSessionSnapshot
  >;
  [IPC_AUTH_SIGN_IN_ANONYMOUS]: Invoke<[], unknown>;
  [IPC_AUTH_GET_CHALLENGE_TOKEN]: Invoke<[], string | undefined>;
  [IPC_AUTH_SIGN_OUT]: Invoke<[], OkResult>;
  [IPC_AUTH_DELETE_USER]: Invoke<[], OkResult>;
  [IPC_AUTH_APPLY_SESSION_TOKEN]: Invoke<
    [payload: { sessionToken: string }],
    OkResult
  >;
  [IPC_AUTH_GET_TOKEN]: Invoke<[], string | null>;
  [IPC_AUTH_REVOKE_SESSIONS]: Invoke<[], OkResult>;
  [IPC_HOST_SET_CLOUD_SYNC]: Invoke<[payload: { enabled: boolean }], OkResult>;
  [IPC_APP_QUIT_FOR_RESTART]: Invoke<[], OkResult>;
  [IPC_APP_RESET_MESSAGES]: Invoke<[], OkResult>;
  [IPC_PERMISSIONS_GET_STATUS]: Invoke<[], PermissionStatus>;
  [IPC_PERMISSIONS_OPEN_SETTINGS]: Invoke<[payload: { kind: string }], void>;
  [IPC_PERMISSIONS_REQUEST]: Invoke<
    [payload: { kind: string }],
    { granted: boolean; alreadyGranted: boolean; openedSettings?: boolean }
  >;
  [IPC_PERMISSIONS_RESET_MICROPHONE]: Invoke<[], OkResult>;
  [IPC_PERMISSIONS_RESET]: Invoke<
    [payload: { kind: ResettablePermissionKind }],
    OkResult
  >;
  [IPC_SHELL_SAVE_FILE_AS]: Invoke<
    [payload: { sourcePath: string; defaultName?: string }],
    { ok: boolean; path?: string; canceled?: boolean; error?: string }
  >;
  [IPC_SHELL_LIST_OPENERS]: Invoke<
    [payload: { filePath: string }],
    { openers: ExternalOpener[] }
  >;
  [IPC_SHELL_OPEN_WITH]: Invoke<
    [payload: { filePath: string; openerId: string }],
    OkErrorResult
  >;
  [IPC_SHELL_OPEN_PATH]: Invoke<[payload: { filePath: string }], OkErrorResult>;
  [IPC_SHELL_KILL_BY_PORT]: Invoke<[payload: { port: number }], void>;
  [IPC_SYSTEM_DETECT_TECHNICAL_USER_SIGNALS]: Invoke<
    [],
    { signals: TechnicalUserSignal[] }
  >;

  // Preferences
  [IPC_PREFERENCES_GET_PREVENT_SLEEP]: Invoke<[], boolean>;
  [IPC_PREFERENCES_SET_PREVENT_SLEEP]: Invoke<
    [enabled: boolean],
    { enabled: boolean }
  >;
  [IPC_PREFERENCES_GET_LOCKED_COMPUTER_USE]: Invoke<
    [],
    LockedComputerUseStatus
  >;
  [IPC_PREFERENCES_SET_LOCKED_COMPUTER_USE]: Invoke<
    [enabled: boolean],
    LockedComputerUseStatus
  >;
  [IPC_PREFERENCES_GET_SOUND_NOTIFICATIONS]: Invoke<[], boolean>;
  [IPC_PREFERENCES_SET_SOUND_NOTIFICATIONS]: Invoke<
    [enabled: boolean],
    { enabled: boolean }
  >;
  [IPC_PREFERENCES_GET_READ_ALOUD]: Invoke<[], boolean>;
  [IPC_PREFERENCES_SET_READ_ALOUD]: Invoke<
    [enabled: boolean],
    { enabled: boolean }
  >;
  [IPC_PREFERENCES_GET_ONBOARDING_COMPLETED]: Invoke<[], boolean>;
  [IPC_PREFERENCES_SET_ONBOARDING_COMPLETED]: Invoke<
    [completed: boolean],
    { completed: boolean }
  >;
  [IPC_PREFERENCES_GET_WAKE_WORD]: Invoke<[], boolean>;
  [IPC_PREFERENCES_SET_WAKE_WORD]: Invoke<
    [enabled: boolean],
    { enabled: boolean }
  >;
  [IPC_GLOBAL_SHORTCUTS_SET_SUSPENDED]: Invoke<
    [suspended: boolean],
    { supported: boolean; suspended: boolean }
  >;
  [IPC_GLOBAL_SHORTCUTS_GET_SUSPENDED]: Invoke<
    [],
    { supported: boolean; suspended: boolean }
  >;
  [IPC_DIAGNOSTICS_RECORD_HEAP_TRACE]: Invoke<
    [payload: { durationMs?: number }],
    FileResult
  >;
  [IPC_DIAGNOSTICS_OPEN_LOGS]: Invoke<[], FileResult>;
  [IPC_DIAGNOSTICS_EXPORT_LOGS]: Invoke<[], FileResult>;
  [IPC_PROMPT_PRESETS_LIST]: Invoke<
    [agentId: string],
    { presets: PromptPresetSummary[]; selectedId: string }
  >;
  [IPC_PROMPT_PRESETS_READ]: Invoke<
    [agentId: string, presetId: string],
    (PromptPresetSummary & { content: string }) | null
  >;
  [IPC_PROMPT_PRESETS_SAVE]: Invoke<
    [
      payload: {
        agentId: string;
        id?: string;
        name: string;
        content: string;
        select?: boolean;
      },
    ],
    { ok: true; preset: PromptPresetSummary } | { ok: false; error: string }
  >;
  [IPC_PROMPT_PRESETS_DELETE]: Invoke<
    [agentId: string, presetId: string],
    { ok: boolean; selectedId: string }
  >;
  [IPC_PROMPT_PRESETS_SELECT]: Invoke<
    [agentId: string, presetId: string],
    { ok: boolean; selectedId: string }
  >;
  [IPC_CUSTOMIZATIONS_RESET]: Invoke<
    [],
    {
      ok: boolean;
      movedEntries: string[];
      trashDir?: string | null;
      error?: string;
    }
  >;
  [IPC_PREFERENCES_GET_MODELS]: Invoke<[], LocalModelPreferences | null>;
  [IPC_PREFERENCES_SET_MODELS]: Invoke<
    [payload: Partial<LocalModelPreferences>],
    LocalModelPreferences | null
  >;
  [IPC_CHATGPT_LIST_MODELS]: Invoke<
    [],
    {
      source: "account" | "catalog";
      models: Array<{ id: string; name: string }>;
    }
  >;
  [IPC_PREFERENCES_LIST_CLAUDE_CODE_MODELS]: Invoke<
    [],
    {
      models: Array<{
        id: string;
        displayName: string;
        description?: string;
        source: "alias" | "anthropic";
      }>;
    }
  >;
  [IPC_PREFERENCES_LIST_MODELS]: Invoke<
    [options?: { forceRefresh?: boolean }],
    RuntimeModelCatalogSnapshot
  >;

  // LLM credentials / engine accounts
  [IPC_LLM_CREDENTIALS_LIST]: Invoke<[], LocalLlmCredentialSummary[]>;
  [IPC_LLM_CREDENTIALS_LIST_OAUTH_PROVIDERS]: Invoke<
    [],
    LocalLlmOAuthProviderSummary[]
  >;
  [IPC_LLM_CREDENTIALS_LIST_OAUTH]: Invoke<[], LocalLlmCredentialSummary[]>;
  [IPC_LLM_CREDENTIALS_LOGIN_OAUTH]: Invoke<
    [payload: { provider: string }],
    LocalLlmCredentialSummary
  >;
  [IPC_LLM_CREDENTIALS_CANCEL_OAUTH]: Invoke<
    [payload: { provider: string }],
    { canceled: boolean }
  >;
  [IPC_LLM_CREDENTIALS_VALIDATE_OAUTH]: Invoke<
    [payload: { provider: string }],
    { connected: boolean; needsReauth: boolean }
  >;
  [IPC_LLM_CREDENTIALS_DELETE_OAUTH]: Invoke<
    [payload: { provider: string }],
    { removed: boolean }
  >;
  [IPC_LLM_CREDENTIALS_SAVE]: Invoke<
    [payload: { provider: string; label: string; plaintext: string }],
    LocalLlmCredentialSummary
  >;
  [IPC_LLM_CREDENTIALS_DELETE]: Invoke<
    [payload: { provider: string }],
    { removed: boolean }
  >;
  [IPC_CLAUDE_ACCOUNTS_LIST]: Invoke<[], ClaudeLocalAccountsState>;
  [IPC_CLAUDE_ACCOUNTS_START_LOGIN]: Invoke<
    [payload: { configId?: string; email?: string }],
    ClaudeLocalLoginStart
  >;
  [IPC_CLAUDE_ACCOUNTS_WAIT_LOGIN]: Invoke<
    [payload: { loginId: string }],
    ClaudeLocalConfig
  >;
  [IPC_CLAUDE_ACCOUNTS_FINISH_LOGIN]: Invoke<
    [payload: { loginId: string; code: string }],
    ClaudeLocalConfig
  >;
  [IPC_CLAUDE_ACCOUNTS_CANCEL_LOGIN]: Invoke<
    [payload: { loginId: string }],
    { canceled: boolean }
  >;
  [IPC_CLAUDE_ACCOUNTS_SIGN_OUT]: Invoke<
    [payload: { configId: string }],
    { ok: true }
  >;
  [IPC_ENGINE_ACCOUNTS_CONNECT_CHATGPT_CLOUD]: Invoke<
    [
      payload: {
        accountId?: string;
        /** Reuse a registration another host of the owner made. */
        clientId?: string;
        enablePlanUsage?: boolean;
      },
    ],
    { accountId: string; planUsage: boolean }
  >;
  [IPC_ENGINE_ACCOUNTS_CANCEL_CONNECT_CHATGPT_CLOUD]: Invoke<
    [],
    { canceled: boolean }
  >;
  [IPC_CHATGPT_LIST_PROFILES]: Invoke<[], ChatGptProfilesState>;
  [IPC_CHATGPT_SIGN_IN]: Invoke<
    [
      payload: {
        profileId?: string;
        /** Sign in with an issued client id another host of the owner shared. */
        sharedClientId?: string;
        enablePlanUsage?: boolean;
      },
    ],
    ChatGptProfileSummary
  >;
  [IPC_CHATGPT_CANCEL_SIGN_IN]: Invoke<[], { canceled: boolean }>;
  [IPC_CHATGPT_SET_ACTIVE]: Invoke<
    [payload: { profileId: string }],
    { ok: true }
  >;
  [IPC_CHATGPT_SIGN_OUT]: Invoke<
    [payload: { profileId: string }],
    { revoked: boolean }
  >;
  [IPC_CHATGPT_REMOVE]: Invoke<
    [payload: { profileId: string }],
    { revoked: boolean }
  >;

  // User asks / connector prompts
  [IPC_USER_ASK_LIST]: Invoke<[], readonly UserAsk[]>;
  [IPC_USER_ASK_ANSWER]: Invoke<
    [answer: UserAskAnswer],
    { ok: boolean; late?: boolean; error?: string }
  >;
  [IPC_USER_ASK_CANCEL]: Invoke<
    [payload: { askId: string; revision?: number }],
    OkErrorResult
  >;
  [IPC_USER_ASK_OVERRIDE_SENSITIVE]: Invoke<
    [payload: { askId: string; fieldId: string; sensitive: boolean }],
    OkErrorResult
  >;
  [IPC_USER_ASK_POLICY_GET]: Invoke<[], UserAskEscalationPolicy>;
  [IPC_USER_ASK_POLICY_SET]: Invoke<
    [policy: UserAskEscalationPolicy],
    UserAskEscalationPolicy
  >;
  [IPC_CONNECTOR_CREDENTIAL_SUBMIT]: Invoke<
    [payload: { requestId: string; value: string; label?: string }],
    OkErrorResult
  >;
  [IPC_CONNECTOR_CREDENTIAL_CANCEL]: Invoke<
    [payload: { requestId: string }],
    OkErrorResult
  >;
  [IPC_CONNECTOR_CONNECT_RESPOND]: Invoke<
    [payload: { requestId: string; action: "accept" | "decline" | "cancel" }],
    OkErrorResult
  >;

  // Onboarding / discovery
  [IPC_ONBOARDING_SYNTHESIZE]: Invoke<
    [payload: OnboardingSynthesisRequest],
    OnboardingSynthesisResponse
  >;
  [IPC_DISCOVERY_CORE_MEMORY_EXISTS]: Invoke<[], boolean>;
  [IPC_DISCOVERY_KNOWLEDGE_EXISTS]: Invoke<[], boolean>;
  [IPC_DISCOVERY_COLLECT_BROWSER_DATA]: Invoke<
    [options?: { selectedBrowser?: string; selectedProfile?: string }],
    BrowserDataResult
  >;
  [IPC_DISCOVERY_DETECT_PREFERRED_BROWSER]: Invoke<[], PreferredBrowserProfile>;
  [IPC_DISCOVERY_LIST_BROWSER_PROFILES]: Invoke<
    [browserType: string],
    BrowserProfile[]
  >;
  [IPC_DISCOVERY_WRITE_CORE_MEMORY]: Invoke<
    [payload: { content: string; includeLocation: boolean }],
    OkErrorResult
  >;
  [IPC_DISCOVERY_WRITE_KNOWLEDGE]: Invoke<
    [payload: DiscoveryKnowledgeSeedPayload],
    OkErrorResult
  >;
  [IPC_DISCOVERY_COLLECT_ALL_SIGNALS]: Invoke<
    [
      options?: {
        categories?: DiscoveryCategory[];
        selectedBrowser?: string;
        selectedProfile?: string;
      },
    ],
    AllUserSignalsResult
  >;

  // Browser fetch / in-app browser view
  [IPC_BROWSER_FETCH_JSON]: Invoke<[payload: BrowserFetchRequest], unknown>;
  [IPC_BROWSER_FETCH_TEXT]: Invoke<[payload: BrowserFetchRequest], string>;
  [IPC_BROWSER_VIEW_GET_STATE]: Invoke<[], BrowserViewState>;
  [IPC_BROWSER_VIEW_CONNECT]: Invoke<
    [payload?: { browserType?: string; profileId?: string }],
    BrowserViewState
  >;
  [IPC_BROWSER_VIEW_SHOW]: Invoke<
    [layout: BrowserViewLayout],
    BrowserViewState
  >;
  [IPC_BROWSER_VIEW_SET_VISIBLE_OWNER]: Invoke<
    [payload: { ownerId: string }],
    BrowserViewState
  >;
  [IPC_BROWSER_VIEW_SET_OWNER_SCOPE]: Invoke<
    [payload?: { ownerId?: string }],
    BrowserViewState
  >;
  [IPC_BROWSER_VIEW_SET_LAYOUT]: Invoke<
    [layout: BrowserViewLayout],
    BrowserViewState
  >;
  [IPC_BROWSER_VIEW_HIDE]: Invoke<[], BrowserViewState>;
  [IPC_BROWSER_VIEW_CREATE_TAB]: Invoke<
    [payload?: { url?: string; ownerId?: string; activate?: boolean }],
    BrowserViewState
  >;
  [IPC_BROWSER_VIEW_SELECT_TAB]: Invoke<
    [payload: { tabId: string; ownerId?: string; activate?: boolean }],
    BrowserViewState
  >;
  [IPC_BROWSER_VIEW_CLOSE_TAB]: Invoke<
    [payload: { tabId: string; ownerId?: string }],
    BrowserViewState
  >;
  [IPC_BROWSER_VIEW_NAVIGATE]: Invoke<
    [payload: { tabId: string; url: string; ownerId?: string }],
    BrowserViewState
  >;
  [IPC_BROWSER_VIEW_GO_BACK]: Invoke<
    [payload: { tabId: string; ownerId?: string }],
    BrowserViewState
  >;
  [IPC_BROWSER_VIEW_GO_FORWARD]: Invoke<
    [payload: { tabId: string; ownerId?: string }],
    BrowserViewState
  >;
  [IPC_BROWSER_VIEW_RELOAD]: Invoke<
    [payload: { tabId: string; ownerId?: string }],
    BrowserViewState
  >;
  [IPC_BROWSER_VIEW_REQUEST_EXTENSION_CONNECT]: Invoke<[], BrowserViewState>;

  // Home
  [IPC_HOME_LIST_RECENT_APPS]: Invoke<
    [payload: { limit?: number }],
    ListRecentAppsResult
  >;
  [IPC_HOME_GET_ACTIVE_BROWSER_TAB]: Invoke<
    [payload: { bundleId: string }],
    GetActiveBrowserTabResult
  >;
  [IPC_HOME_CAPTURE_APP_WINDOW]: Invoke<
    [payload: { appName?: string | null; pid?: number | null }],
    AppWindowCapture
  >;

  // Media
  [IPC_MEDIA_SAVE_OUTPUT]: Invoke<
    [payload: { url: string; fileName: string }],
    FileResult
  >;
  [IPC_MEDIA_GET_DIR]: Invoke<[], string | null>;
  [IPC_MEDIA_COPY_IMAGE]: Invoke<
    [payload: { pngBase64: string }],
    OkErrorResult
  >;
  [IPC_MEDIA_COPY_ATTACHMENT]: Invoke<
    [
      payload: {
        path?: string;
        url?: string;
        mimeType?: string;
        kind?: string;
        name?: string;
      },
    ],
    { ok: boolean; mode?: "image" | "path"; error?: string }
  >;

  // Meetings
  [IPC_MEETINGS_STATUS]: Invoke<[], MeetingStatus>;
  [IPC_MEETINGS_START]: Invoke<
    [payload: { sessionId?: string; segmentSeconds?: number }],
    MeetingStartResult
  >;
  [IPC_MEETINGS_PAUSE]: Invoke<[], OkResult>;
  [IPC_MEETINGS_RESUME]: Invoke<[], OkResult>;
  [IPC_MEETINGS_STOP]: Invoke<[], MeetingStopResult>;
  [IPC_MEETINGS_OPEN_FOLDER]: Invoke<
    [payload: { sessionId?: string }],
    OkResult
  >;

  // Schedule
  [IPC_SCHEDULE_LIST_CRON_JOBS]: Invoke<[], LocalCronJobRecord[]>;
  [IPC_SCHEDULE_LIST_HEARTBEATS]: Invoke<[], LocalHeartbeatConfigRecord[]>;
  [IPC_SCHEDULE_LIST_CONVERSATION_EVENTS]: Invoke<
    [payload: { conversationId: string; maxItems?: number }],
    ScheduledConversationEvent[]
  >;
  [IPC_SCHEDULE_GET_EVENT_COUNT]: Invoke<
    [payload: { conversationId: string }],
    number
  >;
  [IPC_SCHEDULE_RUN_CRON_JOB]: Invoke<[payload: { jobId: string }], unknown>;
  [IPC_SCHEDULE_REMOVE_CRON_JOB]: Invoke<[payload: { jobId: string }], boolean>;
  [IPC_SCHEDULE_UPDATE_CRON_JOB]: Invoke<
    [payload: { jobId: string; patch: LocalCronJobUpdatePatch }],
    LocalCronJobRecord | null
  >;
  [IPC_SCHEDULE_UPSERT_HEARTBEAT]: Invoke<
    [payload: LocalHeartbeatUpsertInput],
    LocalHeartbeatConfigRecord
  >;
  [IPC_SCHEDULE_RUN_HEARTBEAT]: Invoke<
    [payload: { conversationId: string }],
    unknown
  >;

  // Local chat
  [IPC_LOCAL_CHAT_GET_OR_CREATE_ID]: Invoke<[], string>;
  [IPC_LOCAL_CHAT_CREATE_NEW_DEFAULT_ID]: Invoke<[], string>;
  [IPC_LOCAL_CHAT_SET_ACTIVE_ID]: Invoke<
    [payload: { conversationId: string }],
    { ok: true }
  >;
  [IPC_LOCAL_CHAT_LIST_CONVERSATIONS]: Invoke<
    [payload: { limit?: number; cursor?: ConversationSummaryCursor | null }],
    ConversationSummaryPage
  >;
  [IPC_LOCAL_CHAT_DELETE_CONVERSATION]: Invoke<
    [payload: { conversationId: string }],
    { deleted: boolean }
  >;
  [IPC_LOCAL_CHAT_LIST_EVENTS]: Invoke<
    [payload: { conversationId: string; maxItems?: number }],
    EventRecord[]
  >;
  [IPC_LOCAL_CHAT_LIST_MESSAGES]: Invoke<
    [payload: { conversationId: string; maxVisibleMessages?: number }],
    LocalChatMessageWindow
  >;
  [IPC_LOCAL_CHAT_LIST_MESSAGES_BEFORE]: Invoke<
    [
      payload: {
        conversationId: string;
        beforeTimestampMs: number;
        beforeId: string;
        maxVisibleMessages?: number;
      },
    ],
    LocalChatMessageWindow
  >;
  [IPC_LOCAL_CHAT_LIST_MESSAGES_AFTER]: Invoke<
    [
      payload: {
        conversationId: string;
        afterTimestampMs: number;
        afterId: string;
        afterSequence?: number;
        maxVisibleMessages?: number;
      },
    ],
    LocalChatMessageWindow
  >;
  [IPC_LOCAL_CHAT_LIST_MESSAGE_TOOL_EVENTS]: Invoke<
    [
      payload: {
        conversationId: string;
        messageTimestampMs: number;
        messageId: string;
        messageSequence?: number;
        afterTimestampMs?: number;
        afterId?: string;
        afterSequence?: number;
        limit?: number;
      },
    ],
    LocalChatToolEventPage
  >;
  [IPC_LOCAL_CHAT_LIST_ACTIVITY]: Invoke<
    [
      payload: {
        conversationId: string;
        limit?: number;
        beforeTimestampMs?: number;
        beforeId?: string;
      },
    ],
    { activities: EventRecord[] }
  >;
  [IPC_LOCAL_CHAT_LIST_THREAD_ACTIVITY]: Invoke<
    [payload: { conversationId: string }],
    ThreadActivityRecord[]
  >;
  [IPC_LOCAL_CHAT_LIST_LINEAGE_MESSAGES]: Invoke<
    [
      payload: {
        conversationId: string;
        root: ConversationFocusRoot;
        beforeSequence?: number;
        limit?: number;
      },
    ],
    LocalChatLineageWindow
  >;
  [IPC_LOCAL_CHAT_LIST_REPLY_COUNTS]: Invoke<
    [payload: { conversationId: string }],
    ReplyCounts
  >;
  [IPC_LOCAL_CHAT_GET_AGENT_REPORT]: Invoke<
    [payload: { threadId: string }],
    LocalChatAgentReport | null
  >;
  [IPC_LOCAL_CHAT_LIST_MODEL_USAGE]: Invoke<
    [
      payload: {
        fromMs?: number;
        toMs?: number;
        conversationId?: string;
        threadId?: string;
        limit?: number;
      },
    ],
    LocalModelUsagePage
  >;
  [IPC_LOCAL_CHAT_LIST_FILES]: Invoke<
    [
      payload: {
        conversationId: string;
        limit?: number;
        beforeTimestampMs?: number;
        beforeId?: string;
      },
    ],
    { files: EventRecord[] }
  >;
  [IPC_LOCAL_CHAT_GET_EVENT_COUNT]: Invoke<
    [payload: { conversationId: string }],
    number
  >;
  [IPC_LOCAL_CHAT_PERSIST_WELCOME]: Invoke<
    [payload: { conversationId: string; message: string }],
    { ok: true }
  >;

  // Native integrations
  [IPC_NATIVE_INTEGRATIONS_LIST]: Invoke<[], NativeIntegration[]>;
  [IPC_NATIVE_INTEGRATIONS_ENABLE]: Invoke<
    [payload: { id: string }],
    NativeIntegration
  >;
  [IPC_NATIVE_INTEGRATIONS_DISABLE]: Invoke<
    [payload: { id: string }],
    NativeIntegration
  >;

  // The desktop chat on pi-durable (`../pi-chat.js`)
  [IPC_PI_CHAT_REQUEST]: Invoke<[request: PiChatRequest], unknown>;
};

export type IpcSendContract = {
  [IPC_UI_STATE_KV_SNAPSHOT]: [];
  /** Synchronous: whether the desktop chat runs on pi-durable. */
  [IPC_PI_CHAT_ENABLED]: [];
  [IPC_UI_STATE_KV_APPLY]: [changes: Record<string, string | null>];
  [IPC_UI_STATE_KV_CLEAR]: [];
  [IPC_WINDOW_MINIMIZE]: [];
  [IPC_WINDOW_MAXIMIZE]: [];
  [IPC_WINDOW_CLOSE]: [];
  [IPC_WINDOW_SHOW]: [target?: "full"];
  [IPC_WINDOW_SET_NATIVE_BUTTONS_VISIBLE]: [visible: boolean];
  [IPC_APP_SET_READY]: [ready: boolean];
  [IPC_APP_RELOAD]: [];
  [IPC_APP_RELAUNCH]: [];
  [IPC_CHAT_CONTEXT_SET]: [context: ChatContext | null];
  [IPC_CHAT_CONTEXT_REMOVE_SCREENSHOT]: [index: number];
  [IPC_REGION_SELECT]: [selection: IpcRect];
  [IPC_REGION_COMMIT_PREPARED]: [result: RegionCaptureResult | null];
  [IPC_REGION_CLICK]: [point: IpcPoint];
  [IPC_REGION_CANCEL]: [];
  [IPC_OVERLAY_SET_INTERACTIVE]: [interactive: boolean];
  [IPC_OVERLAY_SHOW_WINDOW_HIGHLIGHT]: [
    payload: { bounds: IpcRect; tone?: WindowHighlightTone },
  ];
  [IPC_OVERLAY_HIDE_WINDOW_HIGHLIGHT]: [];
  [IPC_OVERLAY_PREVIEW_WINDOW_HIGHLIGHT_AT_POINT]: [point: IpcPoint];
  [IPC_OVERLAY_SELECTION_CHIP_CLICKED]: [payload: { requestId: number }];
  [IPC_SCREEN_GUIDE_SHOW]: [payload: { annotations: ScreenGuideAnnotation[] }];
  [IPC_SCREEN_GUIDE_HIDE]: [];
  [IPC_VOICE_RTC_TOGGLE]: [];
  [IPC_VOICE_PERSIST_TRANSCRIPT]: [payload: VoiceTranscriptPayload];
  [IPC_VOICE_RUNTIME_STATE]: [state: VoiceRuntimeSnapshot];
  [IPC_VOICE_REPORT_SESSION_ERROR]: [message: string];
  [IPC_VOICE_REPORT_SESSION_ERROR_STATE]: [message: string];
  [IPC_DICTATION_CANCEL_OPENROUTER]: [payload: { requestId: string }];
  [IPC_DICTATION_ACTIVE_CHANGED]: [payload: { active: boolean }];
  [IPC_DICTATION_PLAY_SOUND]: [
    payload: { sound: "startRecording" | "stopRecording" | "cancel" },
  ];
  [IPC_COMPANION_HELLO]: [];
  [IPC_COMPANION_HOVER]: [hovered: boolean];
  [IPC_COMPANION_PANEL_STATUS]: [status: CompanionPanelStatus];
  [IPC_COMPANION_TOGGLE_EXPANDED]: [];
  [IPC_COMPANION_DRAG_START]: [cursor: CompanionDragMove];
  [IPC_COMPANION_DRAG_MOVE]: [cursor: CompanionDragMove];
  [IPC_COMPANION_DRAG_END]: [];
  [IPC_COMPANION_FOCUS]: [];
  [IPC_COMPANION_OPEN_MAIN]: [];
  [IPC_COMPANION_SHOW_CONTEXT_MENU]: [];
  [IPC_COMPANION_SEND]: [payload: CompanionSendRequest];
  [IPC_COMPANION_STOP]: [];
  [IPC_COMPANION_PUBLISH_STATE]: [state: CompanionState];
  [IPC_AGENT_CANCEL_CHAT]: [runId: string];
  [IPC_SYSTEM_OPEN_FDA]: [];
  [IPC_SHELL_OPEN_EXTERNAL]: [url: string];
  [IPC_SHELL_SHOW_IN_FOLDER]: [filePath: string];
  [IPC_DIAGNOSTICS_REPORT_ERROR]: [
    payload: {
      message?: string;
      stack?: string;
      source?: string;
      kind?: string;
    },
  ];
  [IPC_DIAGNOSTICS_REPORT_TIMING]: [
    payload: {
      phase: string;
      elapsedMs: number;
      durationMs?: number;
      outcome?: "hit" | "miss" | "success" | "unavailable";
    },
  ];
};

export type IpcEventContract = {
  [IPC_MEMORY_SYNC_STATUS]: MemorySyncStatus;
  [IPC_DISPLAY_UPDATE]: unknown;
  [IPC_OFFICE_PREVIEW_UPDATE]: OfficePreviewSnapshot;
  [IPC_UI_STATE]: UiState;
  [IPC_CHAT_OPEN_SIDEBAR]: void;
  [IPC_EXECUTION_REMOTE_REQUEST]: {
    requestedAt: number;
    requesterLabel?: string;
  };
  [IPC_EXECUTION_TARGET_SET]: { target: ExecutionTarget };
  [IPC_APP_SOURCE_STATE]: AppSourceState;
  [IPC_CHAT_CONTEXT_UPDATED]: ChatContextUpdate | null;
  [IPC_CAPTURE_REGION_FAILED]: void;
  [IPC_OVERLAY_START_REGION_CAPTURE]: { mode?: "capture" | "window-attach" };
  [IPC_OVERLAY_END_REGION_CAPTURE]: void;
  [IPC_OVERLAY_WINDOW_HIGHLIGHT]:
    | (IpcRect & { tone?: WindowHighlightTone })
    | null;
  [IPC_OVERLAY_SHOW_SCREEN_GUIDE]: { annotations: ScreenGuideAnnotation[] };
  [IPC_OVERLAY_HIDE_SCREEN_GUIDE]: void;
  [IPC_OVERLAY_SHOW_SELECTION_CHIP]: {
    requestId: number;
    text: string;
    rect: IpcRect;
  };
  [IPC_OVERLAY_HIDE_SELECTION_CHIP]: { requestId?: number } | null;
  [IPC_OVERLAY_DISPLAY_CHANGE]: { origin: IpcPoint; bounds: IpcRect };
  [IPC_UI_STATE_KV_CHANGED]: Record<string, string | null>;
  [IPC_VOICE_ORCHESTRATOR_ACTIVITY]: VoiceOrchestratorActivity;
  [IPC_VOICE_RUNTIME_STATE]: VoiceRuntimeSnapshot;
  [IPC_VOICE_SESSION_ERROR]: string;
  [IPC_VOICE_SESSION_ERROR_STATE]: string;
  [IPC_VOICE_PREFERENCES_CHANGED]: RealtimeVoicePreferences;
  [IPC_DICTATION_TOGGLE]: DictationToggle;
  [IPC_COMPANION_LAYOUT]: CompanionLayout;
  [IPC_COMPANION_ACTIVITY]: CompanionActivity;
  [IPC_COMPANION_SET_EXPANDED]: { expanded: boolean };
  [IPC_COMPANION_STATE]: CompanionState;
  [IPC_COMPANION_SEND_REQUESTED]: CompanionSendRequest;
  [IPC_COMPANION_STOP_REQUESTED]: void;
  [IPC_COMPANION_VISIBLE_CHANGED]: CompanionVisibility;
  [IPC_AGENT_EVENT]: AgentStreamEvent;
  [IPC_PI_CHAT_EVENTS]: PiChatEventsPayload;
  [IPC_PI_CHAT_ENABLED_CHANGED]: boolean;
  [IPC_RUNTIME_AVAILABILITY]: RuntimeAvailabilitySnapshot;
  [IPC_AUTH_SESSION_INVALIDATED]: void;
  [IPC_PREFERENCES_READ_ALOUD_CHANGED]: boolean;
  [IPC_PREFERENCES_MODELS_UPDATED]: RuntimeModelCatalogSnapshot;
  [IPC_CLAUDE_ACCOUNTS_CHANGED]: void;
  [IPC_CHATGPT_PROFILES_CHANGED]: void;
  [IPC_USER_ASK_OPENED]: UserAsk;
  [IPC_USER_ASK_UPDATED]: UserAsk;
  [IPC_USER_ASK_CLOSED]: { askId: string; state: UserAskState };
  [IPC_CONNECTOR_CREDENTIAL_REQUEST]: ConnectorCredentialRequest;
  [IPC_CONNECTOR_CREDENTIAL_COMPLETE]: ConnectorCredentialComplete;
  [IPC_CONNECTOR_CONNECT_REQUEST]: ConnectorConnectRequest;
  [IPC_CONNECTOR_CONNECT_UPDATE]: ConnectorConnectUpdate;
  [IPC_BROWSER_BRIDGE_STATUS]: StellaBrowserBridgeStatus;
  [IPC_BROWSER_VIEW_STATE]: BrowserViewState;
  [IPC_SCHEDULE_UPDATED]: void;
  [IPC_LOCAL_CHAT_UPDATED]: LocalChatUpdatedPayload | null;
  [IPC_LOCAL_CHAT_THREAD_ACTIVITY_UPDATED]: ThreadActivityUpdatedPayload;
};

export type IpcInvokeChannel = keyof IpcInvokeContract;
export type IpcInvokeArgs<C extends IpcInvokeChannel> =
  IpcInvokeContract[C]["req"];
export type IpcInvokeResult<C extends IpcInvokeChannel> =
  IpcInvokeContract[C]["res"];

export type IpcSendChannel = keyof IpcSendContract;
export type IpcSendArgs<C extends IpcSendChannel> = IpcSendContract[C];

export type IpcEventChannel = keyof IpcEventContract;
export type IpcEventPayload<C extends IpcEventChannel> = IpcEventContract[C];

/**
 * The renderer side of the contract, implemented by the preload over
 * `ipcRenderer`. `on` hands the listener Electron's event object as an
 * opaque first argument and returns its own unsubscribe.
 */
export type TypedIpcRenderer = {
  invoke: <C extends IpcInvokeChannel>(
    channel: C,
    ...args: IpcInvokeArgs<C>
  ) => Promise<IpcInvokeResult<C>>;
  send: <C extends IpcSendChannel>(channel: C, ...args: IpcSendArgs<C>) => void;
  /** Blocking send; main answers through `event.returnValue`, unchecked. */
  sendSync: <C extends IpcSendChannel>(
    channel: C,
    ...args: IpcSendArgs<C>
  ) => unknown;
  on: <C extends IpcEventChannel>(
    channel: C,
    listener: (event: unknown, payload: IpcEventPayload<C>) => void,
  ) => () => void;
};
