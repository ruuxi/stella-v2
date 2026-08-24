import type { UiState } from "./ui";
import type { Theme } from "@/shared/theme/themes/types";
import type { AgentStreamEvent } from "@stella/contracts/agent-stream";
import type { StellaBrowserBridgeStatus } from "@stella/contracts/browser-bridge-status";
import type {
  ConversationSummaryCursor,
  ConversationSummaryPage,
  LocalModelUsagePage,
  EventRecord,
  LocalChatUpdatedPayload,
  ThreadActivityRecord,
  ThreadActivityUpdatedPayload,
  LocalChatMessageWindow,
  LocalChatToolEventPage,
} from "@stella/contracts/local-chat";
import type {
  AssistantWorkingMode,
  RealtimeVoicePreferences,
} from "@stella/contracts/local-preferences";
import type {
  ChatContext as SharedChatContext,
  ChatContextFile as SharedChatContextFile,
  ChatContextUpdate as SharedChatContextUpdate,
  BrowserType as SharedBrowserType,
  DomainVisit as SharedDomainVisit,
  DomainDetail as SharedDomainDetail,
  BrowserData as SharedBrowserData,
  BrowserDataResult as SharedBrowserDataResult,
  PreferredBrowserProfile as SharedPreferredBrowserProfile,
  BrowserProfile as SharedBrowserProfile,
  CommandFrequency as SharedCommandFrequency,
  ShellAnalysis as SharedShellAnalysis,
  DiscoveredApp as SharedDiscoveredApp,
  AllUserSignals as SharedAllUserSignals,
  AllUserSignalsResult as SharedAllUserSignalsResult,
  AgentHealth as SharedAgentHealth,
  LocalLlmCredentialSummary as SharedLocalLlmCredentialSummary,
  LocalCronSchedule as SharedLocalCronSchedule,
  LocalCronPayload as SharedLocalCronPayload,
  LocalHeartbeatActiveHours as SharedLocalHeartbeatActiveHours,
  LocalCronJobRecord as SharedLocalCronJobRecord,
  LocalCronJobUpdatePatch as SharedLocalCronJobUpdatePatch,
  LocalHeartbeatConfigRecord as SharedLocalHeartbeatConfigRecord,
  LocalHeartbeatUpsertInput as SharedLocalHeartbeatUpsertInput,
  ScheduledConversationEvent as SharedScheduledConversationEvent,
  VoiceRuntimeSnapshot as SharedVoiceRuntimeSnapshot,
} from "@stella/contracts";
import type {
  DiscoveryCategory,
  DiscoveryKnowledgeSeedPayload,
} from "@stella/contracts/discovery";
import type {
  OnboardingSynthesisRequest,
  OnboardingSynthesisResponse,
  OnboardingWelcomeHtmlRequest,
  OnboardingWelcomeHtmlResponse,
} from "@stella/contracts/desktop/onboarding";
import type {
  RuntimeVoiceOrchestratorConfig,
  RuntimeVoiceToolCallPayload,
  RuntimeVoiceToolCallResult,
} from "@stella/contracts/protocol";
import type { RuntimeModelCatalogSnapshot } from "@stella/contracts/model-catalog";
import type {
  OfficePreviewRef as SharedOfficePreviewRef,
  OfficePreviewSnapshot as SharedOfficePreviewSnapshot,
} from "@stella/contracts/office-preview";
import type { DisplayPayload } from "@stella/contracts/desktop/display-payload";
import type { DesktopUpdateSnapshot } from "@stella/contracts/desktop/update";
import type {
  UserAppProjectListResult,
  UserAppProjectStartResult,
  UserAppProjectStopResult,
} from "@stella/contracts/user-app-projects";

type MobileAgentWorkPayloadForSync = {
  kind: "agent-work";
  state: "running" | "done";
  agentIds: string[];
  total: number;
  completed: number;
  title: string;
  subtitle: string;
  createdAt: number;

  agents?: Array<{
    agentId: string;
    title: string;
    files: DisplayPayload[];
  }>;
};

type MobileSyncArtifactForSync =
  | DisplayPayload
  | MobileAgentWorkPayloadForSync
  | { id: string; payload: DisplayPayload | MobileAgentWorkPayloadForSync };
import type {
  BackupNowResult as SharedBackupNowResult,
  BackupStatusSnapshot as SharedBackupStatusSnapshot,
  BackupSummary as SharedBackupSummary,
  RestoreBackupResult as SharedRestoreBackupResult,
} from "@stella/contracts/desktop/backup";

export type ChatContext = SharedChatContext;
export type ChatContextFile = SharedChatContextFile;
export type ChatContextUpdate = SharedChatContextUpdate;
export type BrowserType = SharedBrowserType;
export type DomainVisit = SharedDomainVisit;
export type DomainDetail = SharedDomainDetail;
export type BrowserData = SharedBrowserData;
export type BrowserDataResult = SharedBrowserDataResult;
export type PreferredBrowserProfile = SharedPreferredBrowserProfile;
export type BrowserProfile = SharedBrowserProfile;
export type CommandFrequency = SharedCommandFrequency;
export type ShellAnalysis = SharedShellAnalysis;
export type DiscoveredApp = SharedDiscoveredApp;
export type AllUserSignals = SharedAllUserSignals;
export type AllUserSignalsResult = SharedAllUserSignalsResult;
export type AgentStreamIpcEvent = AgentStreamEvent;
export type AgentHealth = SharedAgentHealth;
export type LocalLlmCredentialSummary = SharedLocalLlmCredentialSummary;
export type LocalLlmOAuthProviderSummary = {
  provider: string;
  label: string;
};
export type LocalCronSchedule = SharedLocalCronSchedule;
export type LocalCronPayload = SharedLocalCronPayload;
export type LocalHeartbeatActiveHours = SharedLocalHeartbeatActiveHours;
export type LocalCronJobRecord = SharedLocalCronJobRecord;
export type LocalCronJobUpdatePatch = SharedLocalCronJobUpdatePatch;
export type LocalHeartbeatConfigRecord = SharedLocalHeartbeatConfigRecord;
export type LocalHeartbeatUpsertInput = SharedLocalHeartbeatUpsertInput;
export type ScheduledConversationEvent = SharedScheduledConversationEvent;
export type VoiceRuntimeSnapshot = SharedVoiceRuntimeSnapshot;
export type OfficePreviewRef = SharedOfficePreviewRef;
export type OfficePreviewSnapshot = SharedOfficePreviewSnapshot;
export type BackupNowResult = SharedBackupNowResult;
export type BackupStatusSnapshot = SharedBackupStatusSnapshot;
export type BackupSummary = SharedBackupSummary;
export type RestoreBackupResult = SharedRestoreBackupResult;
export type VoiceShortcutRegistrationResult = {
  ok: boolean;
  requestedShortcut: string;
  activeShortcut: string;
  error?: string;
};

export type ElectronWindowApi = {
  minimize: () => void;
  maximize: () => void;
  close: () => void;
  isMaximized: () => Promise<boolean>;
  show: () => void;
  setNativeButtonsVisible: (visible: boolean) => void;
};

export type ElectronUiApi = {
  getState: () => Promise<UiState>;
  setState: (partial: Partial<UiState>) => Promise<UiState>;
  onState: (callback: (state: UiState) => void) => () => void;
  onOpenChatSidebar: (callback: () => void) => () => void;
  setAppReady: (ready: boolean) => void;
  reload: () => void;
  relaunch: () => void;
  hardReset: () => Promise<{ ok: boolean }>;
  setOnboardingPresentation: (active: boolean) => Promise<{ ok: boolean }>;
};

export type ElectronCaptureApi = {
  getContext: () => Promise<ChatContext | null>;
  setContext: (context: ChatContext | null) => void;
  onContext: (
    callback: (payload: ChatContextUpdate | null) => void,
  ) => () => void;
  onRegionCaptureFailed: (callback: () => void) => () => void;
  screenshot: (point?: { x: number; y: number }) => Promise<{
    dataUrl: string;
    width: number;
    height: number;
  } | null>;
  visionScreenshots: (point?: { x: number; y: number }) => Promise<
    Array<{
      dataUrl: string;
      width: number;
      height: number;
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
    }>
  >;
  removeScreenshot: (index: number) => void;
  submitRegionSelection: (payload: {
    x: number;
    y: number;
    width: number;
    height: number;
  }) => void;
  prepareRegionSelection: (payload: {
    x: number;
    y: number;
    width: number;
    height: number;
  }) => Promise<{
    screenshot: {
      dataUrl: string;
      width: number;
      height: number;
    } | null;
    window: null;
  } | null>;
  commitPreparedRegionCapture: (
    result: {
      screenshot: {
        dataUrl: string;
        width: number;
        height: number;
      } | null;
      window: {
        app: string;
        title: string;
        bounds: { x: number; y: number; width: number; height: number };
      } | null;
    } | null,
  ) => void;
  submitRegionClick: (point: { x: number; y: number }) => void;
  pageDataUrl: () => Promise<string | null>;
  getWindowCapture: (point: { x: number; y: number }) => Promise<{
    bounds: { x: number; y: number; width: number; height: number };
    thumbnail: string;
    result: {
      screenshot: {
        dataUrl: string;
        width: number;
        height: number;
      } | null;
      window: {
        app: string;
        title: string;
        bounds: { x: number; y: number; width: number; height: number };
      } | null;
    };
  } | null>;
  cursorDisplayInfo: () => Promise<{
    x: number;
    y: number;
    width: number;
    height: number;
    scaleFactor: number;
  }>;
  cancelRegion: () => void;

  beginRegionCapture: () => Promise<{ ok: true } | { cancelled: true }>;
};

export type ElectronOverlayApi = {
  setInteractive: (interactive: boolean) => void;
  showWindowHighlight: (payload: {
    bounds: {
      x: number;
      y: number;
      width: number;
      height: number;
    };
    tone?: "default" | "subtle";
  }) => void;
  hideWindowHighlight: () => void;
  previewWindowHighlightAtPoint: (point: { x: number; y: number }) => void;
  onStartRegionCapture: (callback: () => void) => () => void;
  onEndRegionCapture: (callback: () => void) => () => void;
  onWindowHighlight: (
    callback: (
      data: {
        x: number;
        y: number;
        width: number;
        height: number;
        tone?: "default" | "subtle";
      } | null,
    ) => void,
  ) => () => void;
  onShowDictation: (
    callback: (data: { x: number; y: number }) => void,
  ) => () => void;
  onHideDictation: (callback: () => void) => () => void;
  onShowScreenGuide: (
    callback: (data: {
      annotations: Array<{
        id: string;
        label: string;
        x: number;
        y: number;
      }>;
    }) => void,
  ) => () => void;
  onHideScreenGuide: (callback: () => void) => () => void;
  onDisplayChange: (
    callback: (data: {
      origin: { x: number; y: number };
      bounds: { x: number; y: number; width: number; height: number };
    }) => void,
  ) => () => void;
};

export type ElectronThemeApi = {
  listInstalled: () => Promise<Theme[]>;
};

export type ElectronWebsiteApi = {
  getBaseUrl: () => Promise<string>;
};

export type ElectronUiStateKvApi = {
  apply: (changes: Record<string, string | null>) => void;
  clear: () => void;
  onChanged: (
    callback: (changes: Record<string, string | null>) => void,
  ) => () => void;
};

export type ElectronVoiceApi = {
  persistTranscript: (payload: {
    conversationId: string;
    role: "user" | "assistant";
    text: string;
    uiVisibility?: "visible" | "hidden";
    voiceSession?: { durationMs: number };
  }) => void;
  orchestratorChat: (payload: {
    conversationId: string;
    message: string;
  }) => Promise<string>;
  getOrchestratorConfig: (payload: {
    conversationId: string;
  }) => Promise<RuntimeVoiceOrchestratorConfig>;
  executeTool: (
    payload: RuntimeVoiceToolCallPayload,
  ) => Promise<RuntimeVoiceToolCallResult>;
  webSearch: (payload: { query: string; category?: string }) => Promise<{
    text: string;
    results: Array<{ title: string; url: string; snippet: string }>;
  }>;
  createOpenAISession: (payload: {
    instructions?: string;
    tools?: RuntimeVoiceOrchestratorConfig["tools"];
  }) => Promise<{
    provider: "openai";
    clientSecret: string;
    model: string;
    voice: string;
    expiresAt?: number;
    sessionId?: string;
  }>;
  createXaiSession: (payload: {
    instructions?: string;
    tools?: RuntimeVoiceOrchestratorConfig["tools"];
  }) => Promise<{
    provider: "xai";
    clientSecret: string;
    model: string;
    voice: string;
    expiresAt?: number;
  }>;
  createInworldSession: (payload: { instructions?: string }) => Promise<{
    provider: "inworld";
    clientSecret: string;
    model: string;
    voice: string;
    iceServers?: RTCIceServer[];
  }>;
  getCoreMemory: () => Promise<string>;
  getRuntimeState: () => Promise<VoiceRuntimeSnapshot>;
  onRuntimeState: (
    callback: (state: VoiceRuntimeSnapshot) => void,
  ) => () => void;
  pushRuntimeState: (state: VoiceRuntimeSnapshot) => void;
  setRtcShortcut: (
    shortcut: string,
  ) => Promise<VoiceShortcutRegistrationResult>;
  getRtcShortcut: () => Promise<string>;

  reportSessionError: (message: string) => void;

  onSessionError: (callback: (message: string) => void) => () => void;

  onPreferencesChanged: (
    callback: (preferences: RealtimeVoicePreferences) => void,
  ) => () => void;
};

export type ElectronDictationApi = {

  onToggle: (
    callback: (data: {
      startId?: string;
      action?: "toggle" | "start" | "reveal" | "stop" | "cancel";
    }) => void,
  ) => () => void;

  getShortcut: () => Promise<string>;

  setShortcut: (shortcut: string) => Promise<VoiceShortcutRegistrationResult>;

  getSoundEffectsEnabled: () => Promise<boolean>;

  setSoundEffectsEnabled: (enabled: boolean) => Promise<{ enabled: boolean }>;
  localStatus: () => Promise<{
    available: boolean;
    model: string;
    reason?: string;

    installable?: boolean;
  }>;
  downloadLocalModel: () => Promise<{
    available: boolean;
    model: string;
    reason?: string;
  }>;
  warmLocal: () => Promise<{
    available: boolean;
    model: string;
    reason?: string;
  }>;
  transcribeLocal: (payload: { audioBase64: string }) => Promise<{
    transcript: string;
    model: string;
  }>;
  onOverlayStart: (
    callback: (data: { sessionId: string }) => void,
  ) => () => void;
  onOverlayStop: (
    callback: (data: { sessionId: string }) => void,
  ) => () => void;
  onOverlayCancel: (
    callback: (data: { sessionId: string }) => void,
  ) => () => void;
  overlayCompleted: (payload: { sessionId: string; text: string }) => void;
  overlayFailed: (payload: { sessionId: string; error?: string }) => void;
  inAppStarted: (payload: { startId?: string }) => void;
  activeChanged: (payload: { active: boolean }) => void;
  playSound: (payload: {
    sound: "startRecording" | "stopRecording" | "cancel";
  }) => void;
};

export type ElectronAgentApi = {
  oneShotCompletion: (payload: {
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
  }) => Promise<{ text: string }>;
  healthCheck: () => Promise<AgentHealth | null>;
  getActiveRun: () => Promise<{
    runId: string;
    conversationId: string;
    uiVisibility?: "visible" | "hidden";
  } | null>;
  getAppSessionStartedAt: () => Promise<number>;
  startChat: (payload: {
    conversationId: string;
    userPrompt: string;
    selectedText?: string | null;
    chatContext?: SharedChatContext | null;
    deviceId?: string;
    platform?: string;
    timezone?: string;

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
  }) => Promise<{
    requestId: string;
    runId?: string;
    userMessageId?: string;
    accepted?: boolean;
    deduplicated?: boolean;
  }>;
  sendInput: (payload: {
    conversationId: string;
    threadId: string;
    message: string;
    metadata?: Record<string, unknown>;
  }) => Promise<{ delivered: boolean }>;
  cancelChat: (runId: string) => void;
  resumeConversationExecution: (payload: {
    conversationId: string;
    lastSeq: number;
    lastSourceSeq?: number;
  }) => Promise<{
    activeRun: {
      runId: string;
      conversationId: string;
      requestId?: string;
      userMessageId?: string;
      uiVisibility?: "visible" | "hidden";
    } | null;
    events: AgentStreamIpcEvent[];
  }>;
  onStream: (callback: (event: AgentStreamIpcEvent) => void) => () => void;

  onAvailability: (
    callback: (snapshot: {
      connected: boolean;
      ready: boolean;
      reason?: string;

      pendingRuntimeRestart?: boolean;
    }) => void,
  ) => () => void;
  triggerViteError: () => Promise<{ ok: boolean }>;
  fixViteError: () => Promise<{ ok: boolean }>;
};

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

export type ElectronSystemApi = {
  getDeviceId: () => Promise<string | null>;
  startPhoneAccessSession: () => Promise<{ ok: boolean }>;
  stopPhoneAccessSession: () => Promise<{ ok: boolean }>;
  configurePiRuntime: (config: {
    convexUrl?: string;
    convexSiteUrl?: string;
  }) => Promise<{ deviceId: string | null }>;
  getAuthSession: () => Promise<unknown | null>;
  signInAnonymous: () => Promise<unknown>;
  signOutAuth: () => Promise<{ ok: boolean }>;
  deleteAuthUser: () => Promise<{ ok: boolean }>;
  applyAuthSessionToken: (sessionToken: string) => Promise<{ ok: boolean }>;
  getConvexAuthToken: () => Promise<string | null>;
  setCloudSyncEnabled: (payload: {
    enabled: boolean;
  }) => Promise<{ ok: boolean }>;
  setModelCatalogUpdatedAt: (payload: {
    updatedAt: number | null;
  }) => Promise<{ ok: boolean }>;
  onAuthSessionInvalidated: (callback: () => void) => () => void;
  quitForRestart: () => Promise<{ ok: boolean }>;
  openFullDiskAccess: () => void;
  getPermissionStatus: () => Promise<{
    accessibility: boolean;
    screen: boolean;
    microphone: boolean;
    microphoneStatus:
      | "not-determined"
      | "granted"
      | "denied"
      | "restricted"
      | "unknown";
  }>;
  openPermissionSettings: (kind: string) => Promise<void>;
  requestPermission: (kind: string) => Promise<{
    granted: boolean;
    alreadyGranted: boolean;
    openedSettings?: boolean;
  }>;
  resetMicrophonePermission: () => Promise<{ ok: boolean }>;
  resetPermission: (
    kind: "accessibility" | "screen" | "microphone",
  ) => Promise<{ ok: boolean }>;
  openExternal: (url: string) => void;
  showItemInFolder: (filePath: string) => void;
  saveFileAs: (
    sourcePath: string,
    defaultName?: string,
  ) => Promise<{
    ok: boolean;
    path?: string;
    canceled?: boolean;
    error?: string;
  }>;
  listExternalOpeners: (filePath: string) => Promise<{
    openers: Array<{
      id: string;
      label: string;
      kind: "app" | "default" | "reveal";
    }>;
  }>;
  openWithExternal: (
    filePath: string,
    openerId: string,
  ) => Promise<{ ok: boolean; error?: string }>;
  openPath: (filePath: string) => Promise<{ ok: boolean; error?: string }>;
  shellKillByPort: (port: number) => Promise<void>;
  getLocalSyncMode: () => Promise<string>;
  setLocalSyncMode: (mode: string) => Promise<void>;
  getPreventComputerSleep: () => Promise<boolean>;
  setPreventComputerSleep: (enabled: boolean) => Promise<{ enabled: boolean }>;
  getLockedComputerUseStatus: () => Promise<LockedComputerUseStatus>;
  setLockedComputerUseEnabled: (
    enabled: boolean,
  ) => Promise<LockedComputerUseStatus>;
  getSoundNotificationsEnabled: () => Promise<boolean>;
  setSoundNotificationsEnabled: (
    enabled: boolean,
  ) => Promise<{ enabled: boolean }>;
  getReadAloudEnabled: () => Promise<boolean>;
  setReadAloudEnabled: (enabled: boolean) => Promise<{ enabled: boolean }>;
  onReadAloudEnabledChanged: (
    callback: (enabled: boolean) => void,
  ) => () => void;
  getOnboardingCompleted: () => Promise<boolean>;
  setOnboardingCompleted: (
    completed: boolean,
  ) => Promise<{ completed: boolean }>;
  setGlobalShortcutsSuspended: (
    suspended: boolean,
  ) => Promise<{ supported: boolean; suspended: boolean }>;
  getGlobalShortcutsSuspended: () => Promise<{
    supported: boolean;
    suspended: boolean;
  }>;
  recordHeapTrace: (
    durationMs?: number,
  ) => Promise<{ ok: boolean; path?: string; error?: string }>;
  reportError: (payload: {
    message?: string;
    stack?: string;
    source?: string;
    kind?: string;
  }) => void;
  openLogs: () => Promise<{ ok: boolean; path?: string; error?: string }>;
  getWakeWordEnabled: () => Promise<boolean>;
  setWakeWordEnabled: (enabled: boolean) => Promise<{ enabled: boolean }>;
  listPromptPresets: (agentId: string) => Promise<{
    presets: Array<{ id: string; name: string; agentId: string }>;
    selectedId: string;
  }>;
  readPromptPreset: (
    agentId: string,
    presetId: string,
  ) => Promise<{
    id: string;
    name: string;
    agentId: string;
    content: string;
  } | null>;
  savePromptPreset: (payload: {
    agentId: string;
    id?: string;
    name: string;
    content: string;
    select?: boolean;
  }) => Promise<
    | { ok: true; preset: { id: string; name: string; agentId: string } }
    | { ok: false; error: string }
  >;
  deletePromptPreset: (
    agentId: string,
    presetId: string,
  ) => Promise<{ ok: boolean; selectedId: string }>;
  selectPromptPreset: (
    agentId: string,
    presetId: string,
  ) => Promise<{ ok: boolean; selectedId: string }>;
  resetCustomizations: () => Promise<{
    ok: boolean;
    movedEntries: string[];
    trashDir?: string | null;
    error?: string;
  }>;
  getBackupStatus: () => Promise<BackupStatusSnapshot>;
  backUpNow: () => Promise<BackupNowResult>;
  listBackups: (limit?: number) => Promise<BackupSummary[]>;
  restoreBackup: (snapshotId: string) => Promise<RestoreBackupResult>;
  getLocalModelPreferences: () => Promise<{
    defaultModels: Record<string, string>;
    modelOverrides: Record<string, string>;
    assistantPropagatedAgents: string[];
    reasoningEfforts: Record<
      string,
      "default" | "minimal" | "low" | "medium" | "high" | "xhigh"
    >;
    stellaConversationModelOverrides: Record<string, string>;
    stellaConversationReasoningEfforts: Record<
      string,
      "default" | "minimal" | "low" | "medium" | "high" | "xhigh"
    >;
    agentRuntimeEngine: "default" | "claude_code_local" | "codex_cli";
    codexModel: string;
    codexModelExplicit: boolean;
    codexReasoningEffort:
      | "default"
      | "minimal"
      | "low"
      | "medium"
      | "high"
      | "xhigh";
    codexServiceTier: "standard" | "fast";
    claudeCodeModel: string;
    claudeCodeReasoningEffort:
      | "default"
      | "minimal"
      | "low"
      | "medium"
      | "high"
      | "xhigh";
    maxAgentConcurrency: number;
    imageGeneration: {
      provider: "stella" | "openai" | "openrouter" | "fal";
      model?: string;
    };
    realtimeVoice: RealtimeVoicePreferences;
    assistantWorkingMode: AssistantWorkingMode;
    memoryEnabled: boolean;
  } | null>;
  setLocalModelPreferences: (payload: {
    defaultModels?: Record<string, string>;
    modelOverrides?: Record<string, string>;
    assistantPropagatedAgents?: string[];
    reasoningEfforts?: Record<
      string,
      "default" | "minimal" | "low" | "medium" | "high" | "xhigh"
    >;
    stellaConversationModelOverrides?: Record<string, string>;
    stellaConversationReasoningEfforts?: Record<
      string,
      "default" | "minimal" | "low" | "medium" | "high" | "xhigh"
    >;
    agentRuntimeEngine?: "default" | "claude_code_local" | "codex_cli";
    codexModel?: string;
    codexModelExplicit?: boolean;
    codexReasoningEffort?:
      | "default"
      | "minimal"
      | "low"
      | "medium"
      | "high"
      | "xhigh";
    codexServiceTier?: "standard" | "fast";
    claudeCodeModel?: string;
    claudeCodeReasoningEffort?:
      | "default"
      | "minimal"
      | "low"
      | "medium"
      | "high"
      | "xhigh";
    maxAgentConcurrency?: number;
    imageGeneration?: {
      provider: "stella" | "openai" | "openrouter" | "fal";
      model?: string;
    };
    realtimeVoice?: RealtimeVoicePreferences;
    assistantWorkingMode?: AssistantWorkingMode;
    memoryEnabled?: boolean;
  }) => Promise<{
    defaultModels: Record<string, string>;
    modelOverrides: Record<string, string>;
    assistantPropagatedAgents: string[];
    reasoningEfforts: Record<
      string,
      "default" | "minimal" | "low" | "medium" | "high" | "xhigh"
    >;
    stellaConversationModelOverrides: Record<string, string>;
    stellaConversationReasoningEfforts: Record<
      string,
      "default" | "minimal" | "low" | "medium" | "high" | "xhigh"
    >;
    agentRuntimeEngine: "default" | "claude_code_local" | "codex_cli";
    codexModel: string;
    codexModelExplicit: boolean;
    codexReasoningEffort:
      | "default"
      | "minimal"
      | "low"
      | "medium"
      | "high"
      | "xhigh";
    codexServiceTier: "standard" | "fast";
    claudeCodeModel: string;
    claudeCodeReasoningEffort:
      | "default"
      | "minimal"
      | "low"
      | "medium"
      | "high"
      | "xhigh";
    maxAgentConcurrency: number;
    imageGeneration: {
      provider: "stella" | "openai" | "openrouter" | "fal";
      model?: string;
    };
    realtimeVoice: RealtimeVoicePreferences;
    assistantWorkingMode: AssistantWorkingMode;
    memoryEnabled: boolean;
  } | null>;
  listCodexModels: () => Promise<{
    models: Array<{
      id: string;
      model: string;
      displayName: string;
      description: string;
      hidden: boolean;
      supportedReasoningEfforts: Array<{
        reasoningEffort:
          | "none"
          | "minimal"
          | "low"
          | "medium"
          | "high"
          | "xhigh";
        description: string;
      }>;
      defaultReasoningEffort:
        | "none"
        | "minimal"
        | "low"
        | "medium"
        | "high"
        | "xhigh";
      inputModalities: string[];
      additionalSpeedTiers: string[];
      serviceTiers: Array<{
        id: string;
        name: string;
        description: string;
      }>;
      defaultServiceTier?: string | null;
      isDefault: boolean;
    }>;
  }>;
  listClaudeCodeModels: () => Promise<{
    models: Array<{
      id: string;
      displayName: string;
      description?: string;
      source: "alias" | "anthropic";
    }>;
  }>;
  listLlmModels: (options?: {
    forceRefresh?: boolean;
  }) => Promise<RuntimeModelCatalogSnapshot>;
  onLlmModelsUpdated: (
    callback: (snapshot: RuntimeModelCatalogSnapshot) => void,
  ) => () => void;
  listLlmCredentials: () => Promise<LocalLlmCredentialSummary[]>;
  listLlmOAuthProviders: () => Promise<LocalLlmOAuthProviderSummary[]>;
  listLlmOAuthCredentials: () => Promise<LocalLlmCredentialSummary[]>;
  loginLlmOAuthCredential: (
    provider: string,
  ) => Promise<LocalLlmCredentialSummary>;
  cancelLlmOAuthCredential: (
    provider: string,
  ) => Promise<{ canceled: boolean }>;
  validateLlmOAuthCredential: (provider: string) => Promise<{
    connected: boolean;
    needsReauth: boolean;
  }>;
  deleteLlmOAuthCredential: (provider: string) => Promise<{ removed: boolean }>;
  saveLlmCredential: (payload: {
    provider: string;
    label: string;
    plaintext: string;
  }) => Promise<LocalLlmCredentialSummary>;
  deleteLlmCredential: (provider: string) => Promise<{ removed: boolean }>;
  detectTechnicalUserSignals: () => Promise<{
    signals: Array<
      | "claude-app"
      | "chatgpt-app"
      | "cursor-app"
      | "claude-cli"
      | "codex-cli"
      | "opencode-cli"
      | "pi-cli"
    >;
  }>;
  resetMessages: () => Promise<{ ok: boolean }>;
  onCredentialRequest: (
    callback: (
      event: unknown,
      data: {
        requestId: string;
        provider: string;
        label?: string;
        description?: string;
        placeholder?: string;
      },
    ) => void,
  ) => () => void;
  submitCredential: (payload: {
    requestId: string;
    secretId: string;
    provider: string;
    label: string;
  }) => Promise<{ ok: boolean; error?: string }>;
  cancelCredential: (payload: {
    requestId: string;
  }) => Promise<{ ok: boolean; error?: string }>;
  onConnectorCredentialRequest: (
    callback: (
      event: unknown,
      data: {
        requestId: string;
        tokenKey: string;
        displayName: string;
        mode: "api_key" | "oauth";
        completionMode?: "approve" | "wait";
        description?: string;
        placeholder?: string;
        oauthUserCode?: string;
        oauthVerificationUri?: string;
      },
    ) => void,
  ) => () => void;
  onConnectorCredentialComplete: (
    callback: (
      event: unknown,
      data: {
        requestId: string;
        ok: boolean;
        reason?: string;
      },
    ) => void,
  ) => () => void;
  submitConnectorCredential: (payload: {
    requestId: string;
    value: string;
    label?: string;
  }) => Promise<{ ok: boolean; error?: string }>;
  cancelConnectorCredential: (payload: {
    requestId: string;
  }) => Promise<{ ok: boolean; error?: string }>;
  onConnectorConnectRequest: (
    callback: (
      event: unknown,
      data: {
        requestId: string;
        id: string;
        name: string;
        description?: string;
        iconUrl?: string;
        category?: string;
        reason?: string;
        kind?: "integration" | "browser-extension";
        conversationId?: string;
      },
    ) => void,
  ) => () => void;
  onConnectorConnectUpdate: (
    callback: (
      event: unknown,
      data: {
        requestId: string;
        phase:
          | "connecting"
          | "connected"
          | "declined"
          | "cancelled"
          | "timeout"
          | "error";
        message?: string;
      },
    ) => void,
  ) => () => void;
  respondConnectorConnect: (payload: {
    requestId: string;
    action: "accept" | "decline" | "cancel";
  }) => Promise<{ ok: boolean; error?: string }>;
};

export type ElectronOnboardingApi = {
  synthesizeCoreMemory: (
    payload: OnboardingSynthesisRequest,
  ) => Promise<OnboardingSynthesisResponse>;
  generateWelcomeHtml: (
    payload: OnboardingWelcomeHtmlRequest,
  ) => Promise<OnboardingWelcomeHtmlResponse>;
  complete: () => Promise<{ ok: boolean }>;
  reset: () => Promise<{ ok: boolean }>;
};

export type ElectronDiscoveryApi = {
  checkCoreMemoryExists: () => Promise<boolean>;
  checkKnowledgeExists: () => Promise<boolean>;
  collectData: (options?: {
    selectedBrowser?: string;
    selectedProfile?: string;
  }) => Promise<BrowserDataResult>;
  detectPreferred: () => Promise<PreferredBrowserProfile>;
  listProfiles: (browserType: string) => Promise<BrowserProfile[]>;
  writeCoreMemory: (
    content: string,
    options?: { includeLocation?: boolean },
  ) => Promise<{ ok: boolean; error?: string }>;
  writeKnowledge: (
    payload: DiscoveryKnowledgeSeedPayload,
  ) => Promise<{ ok: boolean; error?: string }>;
  collectAllSignals: (options?: {
    categories?: DiscoveryCategory[];
    selectedBrowser?: string;
    selectedProfile?: string;
  }) => Promise<AllUserSignalsResult>;
};

export type ElectronBrowserApi = {
  onBridgeStatus: (
    callback: (status: StellaBrowserBridgeStatus) => void,
  ) => () => void;
  fetchJson: (
    url: string,
    init?: {
      method?: "GET" | "POST";
      headers?: Record<string, string>;
      body?: string;
    },
  ) => Promise<unknown>;
  fetchText: (
    url: string,
    init?: {
      method?: "GET" | "POST";
      headers?: Record<string, string>;
      body?: string;
    },
  ) => Promise<string>;
};

export type BrowserViewState = {
  connection: "checking" | "disconnected" | "connected";
  profileName?: string;
  visibleOwnerId: string;
  owners: Array<{
    id: string;
    kind: "manual" | "agent";
    tabCount: number;
    activeTabId?: string;
    latest: boolean;
  }>;
  tabs: Array<{
    id: string;
    ownerId: string;
    url: string;
    title: string;
    faviconUrl?: string;
    loading: boolean;
    canGoBack: boolean;
    canGoForward: boolean;
  }>;
  activeTabId?: string;
  error?: string;
  unavailableReason?:
    | "extension_not_installed"
    | "extension_disconnected"
    | "bridge_missing"
    | "authorization_failed"
    | "connection_lost"
    | "transient_failure";
};

export type BrowserViewLayout = {
  pageBounds: { x: number; y: number; width: number; height: number };
  surfaceBounds: { x: number; y: number; width: number; height: number };
};

export type ElectronBrowserViewApi = {
  getState: () => Promise<BrowserViewState>;
  connect: (payload?: {
    browserType?: string;
    profileId?: string;
  }) => Promise<BrowserViewState>;
  show: (payload: BrowserViewLayout) => Promise<BrowserViewState>;
  setVisibleOwner: (payload: { ownerId: string }) => Promise<BrowserViewState>;
  setOwnerScope: (payload?: {
    ownerId?: string;
  }) => Promise<BrowserViewState>;
  setLayout: (payload: BrowserViewLayout) => Promise<BrowserViewState>;
  hide: () => Promise<BrowserViewState>;
  createTab: (payload?: {
    url?: string;
    ownerId?: string;
    activate?: boolean;
  }) => Promise<BrowserViewState>;
  selectTab: (payload: {
    tabId: string;
    ownerId?: string;
    activate?: boolean;
  }) => Promise<BrowserViewState>;
  closeTab: (payload: {
    tabId: string;
    ownerId?: string;
  }) => Promise<BrowserViewState>;
  navigate: (payload: {
    tabId: string;
    url: string;
    ownerId?: string;
  }) => Promise<BrowserViewState>;
  goBack: (payload: {
    tabId: string;
    ownerId?: string;
  }) => Promise<BrowserViewState>;
  goForward: (payload: {
    tabId: string;
    ownerId?: string;
  }) => Promise<BrowserViewState>;
  reload: (payload: {
    tabId: string;
    ownerId?: string;
  }) => Promise<BrowserViewState>;
  requestExtensionConnect: () => Promise<BrowserViewState>;
  onState: (callback: (state: BrowserViewState) => void) => () => void;
};

export type ElectronScheduleApi = {
  listCronJobs: () => Promise<LocalCronJobRecord[]>;
  listHeartbeats: () => Promise<LocalHeartbeatConfigRecord[]>;
  listConversationEvents: (payload: {
    conversationId: string;
    maxItems?: number;
  }) => Promise<ScheduledConversationEvent[]>;
  getConversationEventCount: (payload: {
    conversationId: string;
  }) => Promise<number>;
  runCronJob: (payload: { jobId: string }) => Promise<unknown>;
  removeCronJob: (payload: { jobId: string }) => Promise<boolean>;
  updateCronJob: (payload: {
    jobId: string;
    patch: LocalCronJobUpdatePatch;
  }) => Promise<LocalCronJobRecord | null>;
  upsertHeartbeat: (
    payload: LocalHeartbeatUpsertInput,
  ) => Promise<LocalHeartbeatConfigRecord>;
  runHeartbeat: (payload: { conversationId: string }) => Promise<unknown>;
  onUpdated: (callback: () => void) => () => void;
};

export type FashionBodyPhotoInfo = {
  hasBodyPhoto: boolean;
  absolutePath?: string;
  mimeType?: string;
  updatedAt?: number;
};

export type ElectronFashionApi = {
  pickAndSaveBodyPhoto: () => Promise<
    { canceled: true } | { canceled: false; info: FashionBodyPhotoInfo }
  >;
  getBodyPhotoInfo: () => Promise<FashionBodyPhotoInfo>;
  getBodyPhotoDataUrl: () => Promise<string | null>;
  deleteBodyPhoto: () => Promise<{ ok: true }>;
  getLocalImageDataUrl: (path: string) => Promise<string>;
  startOutfitBatch: (payload: {
    prompt?: string;
    batchId?: string;
    count?: number;
    excludeProductIds?: string[];
    seedHints?: string[];
  }) => Promise<{ threadId?: string; batchId: string }>;
  pickTryOnImages: () => Promise<
    { canceled: true; paths: string[] } | { canceled: false; paths: string[] }
  >;

  getDroppedFilePath: (file: File) => string;
  startTryOn: (payload: {
    prompt?: string;
    batchId?: string;
    imagePaths?: string[];
    imageUrls?: string[];
  }) => Promise<{
    threadId?: string;
    batchId: string;
    imagePaths: string[];
    imageUrls: string[];
  }>;
};

export type ElectronUserAppsApi = {
  list: () => Promise<UserAppProjectListResult>;
  start: (slug: string) => Promise<UserAppProjectStartResult>;
  stop: (slug: string) => Promise<UserAppProjectStopResult>;
  onUpdated: (callback: () => void) => () => void;
  onChanged: (callback: () => void) => () => void;
};

export type ElectronLocalChatApi = {
  getOrCreateDefaultConversationId: () => Promise<string>;
  createNewDefaultConversationId: () => Promise<string>;

  setActiveConversationId: (payload: {
    conversationId: string;
  }) => Promise<{ ok: true }>;
  listConversations: (payload: {
    limit?: number;
    cursor?: ConversationSummaryCursor | null;
  }) => Promise<ConversationSummaryPage>;
  deleteConversation: (payload: {
    conversationId: string;
  }) => Promise<{ deleted: boolean }>;

  truncateConversation: (payload: {
    conversationId: string;
    eventId: string;
  }) => Promise<{ removed: number }>;

  forkConversation: (payload: {
    conversationId: string;
    eventId: string;
  }) => Promise<{ conversationId: string } | null>;

  listEvents: (payload: {
    conversationId: string;
    maxItems?: number;
  }) => Promise<EventRecord[]>;
  listMessages: (payload: {
    conversationId: string;
    maxVisibleMessages?: number;
  }) => Promise<LocalChatMessageWindow>;
  listMessagesBefore: (payload: {
    conversationId: string;
    beforeTimestampMs: number;
    beforeId: string;
    maxVisibleMessages?: number;
  }) => Promise<LocalChatMessageWindow>;

  listMessagesAfter: (payload: {
    conversationId: string;
    afterTimestampMs: number;
    afterId: string;
    afterSequence?: number;
    maxVisibleMessages?: number;
  }) => Promise<LocalChatMessageWindow>;
  listMessageToolEvents: (payload: {
    conversationId: string;
    messageTimestampMs: number;
    messageId: string;
    messageSequence?: number;
    afterTimestampMs?: number;
    afterId?: string;
    afterSequence?: number;
    limit?: number;
  }) => Promise<LocalChatToolEventPage>;
  listActivity: (payload: {
    conversationId: string;
    limit?: number;
    beforeTimestampMs?: number;
    beforeId?: string;
  }) => Promise<{
    activities: EventRecord[];
  }>;

  listThreadActivity: (payload: {
    conversationId: string;
  }) => Promise<ThreadActivityRecord[]>;
  listAgentThreadMessages: (payload: {
    threadId: string;
    limit?: number;
  }) => Promise<
    Array<{
      entryId?: string;
      timestamp: number;
      role:
        | "user"
        | "assistant"
        | "reasoning"
        | "tool"
        | "checkpoint"
        | "lifecycle";
      content: string;
      toolActivity?: {
        toolCallId: string;
        toolName: string;
        status: "running" | "completed" | "error";
        input?: string;
        output?: string;
        completedAt?: number;
      };
      lifecycleEvent?: EventRecord;
      source?: string;
    }>
  >;
  listModelUsage: (payload: {
    fromMs?: number;
    toMs?: number;
    conversationId?: string;
    threadId?: string;
    limit?: number;
  }) => Promise<LocalModelUsagePage>;
  listFiles: (payload: {
    conversationId: string;
    limit?: number;
    beforeTimestampMs?: number;
    beforeId?: string;
  }) => Promise<{ files: EventRecord[] }>;
  persistDiscoveryWelcome: (payload: {
    conversationId: string;
    message: string;
    firstReport?: unknown;
  }) => Promise<{ ok: true }>;
  listSyncMessages: (payload: {
    conversationId: string;
    maxMessages?: number;
    includeDeveloperArtifacts?: boolean;
  }) => Promise<
    Array<{
      localMessageId: string;
      role: "user" | "assistant";
      text: string;
      timestamp: number;
      requestId?: string;
      deviceId?: string;
      artifacts?: MobileSyncArtifactForSync[];
      toolSteps?: Array<{
        id: string;
        toolName: string;
        status: "completed" | "error";
        args?: Record<string, string>;
      }>;
      tasks?: Array<{
        id: string;
        title: string;
        status: "running" | "completed" | "error" | "canceled";
        statusText?: string;
        createdAt: number;
        completedAt?: number;
        assistantMessages: string[];
        reasoningSummaries: string[];
      }>;
    }>
  >;
  syncMessages: (payload: {
    conversationId: string;
    sinceCursor?: string | null;
    maxMessages?: number;
    includeDeveloperArtifacts?: boolean;
  }) => Promise<{
    cursor: string | null;
    messages: Array<{
      localMessageId: string;
      role: "user" | "assistant";
      text: string;
      timestamp: number;
      requestId?: string;
      deviceId?: string;
      artifacts?: MobileSyncArtifactForSync[];
      toolSteps?: Array<{
        id: string;
        toolName: string;
        status: "completed" | "error";
        args?: Record<string, string>;
      }>;
      tasks?: Array<{
        id: string;
        title: string;
        status: "running" | "completed" | "error" | "canceled";
        statusText?: string;
        createdAt: number;
        completedAt?: number;
        assistantMessages: string[];
        reasoningSummaries: string[];
      }>;
    }>;
  }>;

  publishTaskDecoration: (payload: {
    statusTextByAgentId: Record<string, string>;
  }) => Promise<{ ok: true }>;
  getSyncCheckpoint: (payload: {
    conversationId: string;
  }) => Promise<string | null>;
  setSyncCheckpoint: (payload: {
    conversationId: string;
    localMessageId: string;
  }) => Promise<{ ok: boolean }>;
  onUpdated: (
    callback: (payload: LocalChatUpdatedPayload | null) => void,
  ) => () => void;
  onThreadActivityUpdated: (
    callback: (payload: ThreadActivityUpdatedPayload) => void,
  ) => () => void;
};

export type ElectronNativeIntegration = {
  id: string;
  name: string;
  category: string;
  auth: string[];
  catalogToolCount: number;
  availability: "ready";
  provider: "google-workspace" | "oauth-catalog";
  toolPrefix?: string;
  sourceUrl?: string;
  iconUrl?: string;
  description: string;
  connectable: boolean;
  oauthSetupStatus:
    | "ready"
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

export type ElectronNativeIntegrationsApi = {
  list: () => Promise<ElectronNativeIntegration[]>;
  enable: (payload: { id: string }) => Promise<ElectronNativeIntegration>;
  disable: (payload: { id: string }) => Promise<ElectronNativeIntegration>;
};

export type ElectronHomeApi = {

  listRecentApps: (limit?: number) => Promise<{
    apps: Array<{
      name: string;
      bundleId?: string;
      pid: number;
      isActive: boolean;
      windowTitle?: string;
      iconDataUrl?: string;
    }>;
  }>;

  captureAppWindow: (
    target: string | { appName?: string | null; pid?: number | null },
  ) => Promise<{
    capture: {
      title: string;
      axTree?: string | null;
      screenshot: {
        dataUrl: string;
        width: number;
        height: number;
      };
    } | null;
  }>;

  getActiveBrowserTab: (bundleId: string) => Promise<{
    tab: {
      browser: string;
      bundleId?: string;
      url: string;
      title?: string;
    } | null;
  }>;
};

export type ElectronScreenGuideApi = {
  show: (
    annotations: Array<{
      id: string;
      label: string;
      x: number;
      y: number;
    }>,
  ) => void;
  hide: () => void;
};

export type ElectronDisplayApi = {

  onUpdate: (callback: (payload: unknown) => void) => () => void;

  readFile: (
    filePath: string,
    options?: { conversationId?: string | null; maxBytes?: number },
  ) => Promise<
    | {
        bytes: Uint8Array;
        sizeBytes: number;
        mimeType: string;
        truncated: boolean;
        missing: false;
      }
    | { missing: true; mimeType: string; path: string }
  >;
  listCanvasHtml: () => Promise<
    Array<{
      filePath: string;
      slug: string;
      title: string;
      createdAt: number;
    }>
  >;

  openSharedCanvas: (payload: { url: string }) => Promise<{
    kind: "canvas-html";
    filePath: string;
    slug: string;
    title: string;
    createdAt: number;
  } | null>;
  listTrash: () => Promise<{
    items: Array<{
      id: string;
      source: string;
      originalPath: string;
      trashPath: string;
      trashedAt: number;
      purgeAfter: number;
      requestId?: string;
      agentType?: string;
      conversationId?: string;
    }>;
    errors: string[];
  }>;
  forceDeleteTrash: (payload: { id?: string; all?: boolean }) => Promise<{
    checked: number;
    purged: number;
    skipped: number;
    errors: string[];
  }>;
};

export type ElectronOfficePreviewApi = {
  list: (options?: {
    conversationId?: string | null;
  }) => Promise<OfficePreviewSnapshot[]>;
  start: (
    filePath: string,
    options?: { conversationId?: string | null },
  ) => Promise<OfficePreviewRef>;
  onUpdate: (callback: (snapshot: OfficePreviewSnapshot) => void) => () => void;
};

export type ElectronUpdatesApi = {
  getState: () => Promise<DesktopUpdateSnapshot>;
  check: () => Promise<DesktopUpdateSnapshot>;
  download: () => Promise<DesktopUpdateSnapshot>;
  restartAndInstall: () => Promise<{ accepted: true }>;
  onStateChanged: (
    callback: (snapshot: DesktopUpdateSnapshot) => void,
  ) => () => void;
};

export type ElectronApi = {
  platform: string;
  arch: string;
  files: {

    getPathForFile: (file: File) => string;
  };
  display: ElectronDisplayApi;
  officePreview: ElectronOfficePreviewApi;
  window: ElectronWindowApi;
  ui: ElectronUiApi;
  capture: ElectronCaptureApi;
  overlay: ElectronOverlayApi;
  screenGuide: ElectronScreenGuideApi;
  theme: ElectronThemeApi;
  website: ElectronWebsiteApi;
  uiState: ElectronUiStateKvApi;
  voice: ElectronVoiceApi;
  dictation: ElectronDictationApi;
  agent: ElectronAgentApi;
  system: ElectronSystemApi;
  updates: ElectronUpdatesApi;
  onboarding: ElectronOnboardingApi;
  discovery: ElectronDiscoveryApi;
  browser: ElectronBrowserApi;
  browserView: ElectronBrowserViewApi;
  media: {
    saveOutput: (
      url: string,
      fileName: string,
      kind?: "image",
    ) => Promise<{ ok: boolean; path?: string; error?: string }>;
    getStellaMediaDir: () => Promise<string | null>;
    copyImage: (pngBase64: string) => Promise<{ ok: boolean; error?: string }>;

    copyAttachment: (payload: {
      path?: string;
      url?: string;
      mimeType?: string;
      kind?: string;
      name?: string;
    }) => Promise<{ ok: boolean; mode?: "image" | "path"; error?: string }>;
  };
  meetings: {
    status: () => Promise<{
      available: boolean;
      running?: boolean;
      recording?: boolean;
      paused?: boolean;
      sessionId?: string | null;
      startedAtMs?: number | null;
      segmentSeconds?: number;
      screenPermission?: boolean;
      micPermission?: boolean;
    }>;
    start: (payload?: {
      sessionId?: string;
      segmentSeconds?: number;
    }) => Promise<{
      ok: boolean;
      sessionId?: string;
      dir?: string;
      segmentSeconds?: number;
      system?: boolean;
      mic?: boolean;
      startedAtMs?: number;
      reason?: string;
    }>;
    pause: () => Promise<{ ok: boolean }>;
    resume: () => Promise<{ ok: boolean }>;
    stop: () => Promise<{
      ok: boolean;
      sessionId?: string;
      dir?: string;
      durationMs?: number;
      systemSegments?: number;
      micSegments?: number;
      reason?: string;
    }>;
    openFolder: (payload?: { sessionId?: string }) => Promise<{ ok: boolean }>;
  };
  schedule: ElectronScheduleApi;
  fashion: ElectronFashionApi;
  userApps: ElectronUserAppsApi;
  localChat: ElectronLocalChatApi;
  nativeIntegrations: ElectronNativeIntegrationsApi;
  home: ElectronHomeApi;
  pet: ElectronPetApi;
};

type PetOverlayMood =
  | "idle"
  | "running"
  | "waiting"
  | "review"
  | "failed"
  | "waving";

type PetOverlayStatusPayload = {
  state: PetOverlayMood;
  title: string;
  message: string;
  isLoading: boolean;
};

type ElectronPetApi = {

  getState: () => Promise<{
    open: boolean;
    status: PetOverlayStatusPayload;
  }>;

  setOpen: (open: boolean) => void;

  moveWindow: (position: { x: number; y: number }) => void;

  setComposerActive: (active: boolean) => void;

  setInteractive: (active: boolean) => void;

  requestVoice: () => void;

  requestDictation: () => void;

  onDictationActive: (callback: (active: boolean) => void) => () => void;

  onSetOpen: (callback: (open: boolean) => void) => () => void;

  pushStatus: (status: PetOverlayStatusPayload) => void;

  onStatus: (callback: (status: PetOverlayStatusPayload) => void) => () => void;

  openChat: () => void;

  sendMessage: (text: string) => void;

  onSendMessage: (callback: (text: string) => void) => () => void;
};

declare global {
  interface Window {
    electronAPI?: ElectronApi;

    __stellaUiState?: Record<string, string>;
  }
}

export {};
