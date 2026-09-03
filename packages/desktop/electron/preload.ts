import { contextBridge, ipcRenderer, webUtils } from "electron";
import type { IpcRendererEvent } from "electron";
import { IPC_AUTH_GET_CHALLENGE_TOKEN } from "./auth-challenge-ipc.js";
import type { ChatContext } from "@stella/contracts";
import type { StellaBrowserBridgeStatus } from "@stella/contracts/browser-bridge-status";
import type {
  ConversationSummaryCursor,
  ConversationSummaryPage,
  LocalModelUsagePage,
  LocalChatUpdatedPayload,
  ThreadActivityUpdatedPayload,
} from "@stella/contracts/local-chat";
import type { DesktopUpdateSnapshot } from "@stella/contracts/desktop/update";
import type { OfficePreviewSnapshot } from "@stella/contracts/office-preview";
import type { RealtimeVoicePreferences } from "@stella/contracts/local-preferences";
import type {
  CloudHomeImportOwnership,
  LocalCloudHomeScan,
} from "@stella/contracts/cloud-home-sync";
import type {
  CloudConversationCacheAuthority,
  CloudConversationCacheLifecycleAuthority,
  CloudConversationCachePurgeResult,
  CloudConversationCacheReplaceInput,
  CloudConversationCacheReplaceResult,
  CloudConversationCacheSnapshot,
} from "@stella/contracts/cloud-conversation-cache";
import {
  IPC_BROWSER_FETCH_JSON,
  IPC_BROWSER_FETCH_TEXT,
  IPC_CAPTURE_REGION_FAILED,
  IPC_CLOUD_CONVERSATION_CACHE_ACTIVATE_AUTHORITY,
  IPC_CLOUD_CONVERSATION_CACHE_PURGE_CONVERSATION,
  IPC_CLOUD_CONVERSATION_CACHE_READ,
  IPC_CLOUD_CONVERSATION_CACHE_REPLACE,
  IPC_CLOUD_CONVERSATION_CACHE_RETAIN_ACCOUNT,
  IPC_CLOUD_HOME_BEGIN_MEMORY_EXPORT,
  IPC_CLOUD_HOME_CANCEL_MEMORY_EXPORT,
  IPC_CLOUD_HOME_COMMIT_MEMORY_EXPORT,
  IPC_CLOUD_HOME_CONFIRM_IMPORT_OWNERSHIP,
  IPC_CLOUD_HOME_GET_IMPORT_OWNERSHIP,
  IPC_CLOUD_HOME_SCAN_LOCAL,
  IPC_DISCOVERY_COLLECT_ALL_SIGNALS,
  IPC_HOME_CAPTURE_APP_WINDOW,
  IPC_HOME_GET_ACTIVE_BROWSER_TAB,
  IPC_HOME_LIST_RECENT_APPS,
  IPC_LOCAL_CHAT_DELETE_CONVERSATION,
  IPC_LOCAL_CHAT_TRUNCATE_CONVERSATION,
  IPC_LOCAL_CHAT_FORK_CONVERSATION,
  IPC_LOCAL_CHAT_LIST_CONVERSATIONS,
  IPC_LOCAL_CHAT_LIST_MESSAGES_AFTER,
  IPC_LOCAL_CHAT_LIST_LINEAGE_MESSAGES,
  IPC_LOCAL_CHAT_LIST_REPLY_COUNTS,
  IPC_LOCAL_CHAT_GET_AGENT_REPORT,
  IPC_LOCAL_CHAT_LIST_MESSAGE_TOOL_EVENTS,
  IPC_LOCAL_CHAT_LIST_MODEL_USAGE,
  IPC_MEDIA_COPY_IMAGE,
  IPC_MEDIA_COPY_ATTACHMENT,
  IPC_MEDIA_GET_DIR,
  IPC_MEDIA_SAVE_OUTPUT,
  IPC_DISCOVERY_COLLECT_BROWSER_DATA,
  IPC_DISCOVERY_CORE_MEMORY_EXISTS,
  IPC_DISCOVERY_DETECT_PREFERRED_BROWSER,
  IPC_DISCOVERY_KNOWLEDGE_EXISTS,
  IPC_DISCOVERY_LIST_BROWSER_PROFILES,
  IPC_DISCOVERY_WRITE_CORE_MEMORY,
  IPC_DISCOVERY_WRITE_KNOWLEDGE,
  IPC_DISPLAY_LIST_CANVAS_HTML,
  IPC_DISPLAY_OPEN_SHARED_CANVAS,
  IPC_DISPLAY_TRASH_FORCE_DELETE,
  IPC_DISPLAY_TRASH_LIST,
  IPC_OFFICE_PREVIEW_LIST,
  IPC_OFFICE_PREVIEW_START,
  IPC_OFFICE_PREVIEW_UPDATE,
  IPC_UPDATES_CHECK,
  IPC_UPDATES_DOWNLOAD,
  IPC_UPDATES_GET_STATE,
  IPC_UPDATES_RESTART_AND_INSTALL,
  IPC_UPDATES_STATE_CHANGED,
  IPC_WINDOW_SET_NATIVE_BUTTONS_VISIBLE,
} from "@stella/contracts/desktop/ipc-channels";
import type {
  OnboardingSynthesisRequest,
  OnboardingSynthesisResponse,
} from "@stella/contracts/desktop/onboarding";
import type { DiscoveryKnowledgeSeedPayload } from "@stella/contracts/discovery";
import {
  IPC_APP_QUIT_FOR_RESTART,
  IPC_AUTH_APPLY_SESSION_TOKEN,
  IPC_AUTH_DELETE_USER,
  IPC_AUTH_GET_CONVEX_TOKEN,
  IPC_AUTH_GET_SESSION,
  IPC_AUTH_SESSION_INVALIDATED,
  IPC_AUTH_SIGN_IN_ANONYMOUS,
  IPC_AUTH_SIGN_OUT,
  IPC_DIAGNOSTICS_RECORD_HEAP_TRACE,
  IPC_DIAGNOSTICS_EXPORT_LOGS,
  IPC_DIAGNOSTICS_REPORT_ERROR,
  IPC_DIAGNOSTICS_REPORT_TIMING,
  IPC_DIAGNOSTICS_OPEN_LOGS,
  IPC_GLOBAL_SHORTCUTS_GET_SUSPENDED,
  IPC_GLOBAL_SHORTCUTS_SET_SUSPENDED,
  IPC_HOST_SET_MODEL_CATALOG_UPDATED_AT,
  IPC_PERMISSIONS_RESET,
  IPC_PERMISSIONS_RESET_MICROPHONE,
  IPC_PREFERENCES_GET_MODELS,
  IPC_PREFERENCES_LIST_CODEX_MODELS,
  IPC_PREFERENCES_LIST_CLAUDE_CODE_MODELS,
  IPC_PREFERENCES_LIST_MODELS,
  IPC_PREFERENCES_MODELS_UPDATED,
  IPC_PREFERENCES_GET_ONBOARDING_COMPLETED,
  IPC_PREFERENCES_GET_PREVENT_SLEEP,
  IPC_PREFERENCES_GET_LOCKED_COMPUTER_USE,
  IPC_PREFERENCES_GET_READ_ALOUD,
  IPC_PREFERENCES_READ_ALOUD_CHANGED,
  IPC_PREFERENCES_GET_SOUND_NOTIFICATIONS,
  IPC_PREFERENCES_SET_MODELS,
  IPC_PREFERENCES_SET_ONBOARDING_COMPLETED,
  IPC_PREFERENCES_SET_PREVENT_SLEEP,
  IPC_PREFERENCES_SET_LOCKED_COMPUTER_USE,
  IPC_PREFERENCES_SET_READ_ALOUD,
  IPC_PREFERENCES_SET_SOUND_NOTIFICATIONS,
  IPC_PREFERENCES_GET_WAKE_WORD,
  IPC_PREFERENCES_SET_WAKE_WORD,
  IPC_CUSTOMIZATIONS_RESET,
  IPC_PROMPT_PRESETS_LIST,
  IPC_PROMPT_PRESETS_READ,
  IPC_PROMPT_PRESETS_SAVE,
  IPC_PROMPT_PRESETS_DELETE,
  IPC_PROMPT_PRESETS_SELECT,
  IPC_SHELL_SAVE_FILE_AS,
  IPC_SHELL_LIST_OPENERS,
  IPC_SHELL_OPEN_WITH,
  IPC_SHELL_OPEN_PATH,
  IPC_SYSTEM_OPEN_FDA,
  IPC_UI_STATE_KV_APPLY,
  IPC_UI_STATE_KV_CHANGED,
  IPC_UI_STATE_KV_CLEAR,
  IPC_UI_STATE_KV_SNAPSHOT,
  IPC_WEBSITE_GET_BASE_URL,
  IPC_USER_APPS_LIST,
  IPC_USER_APPS_START,
  IPC_USER_APPS_STOP,
  IPC_USER_APPS_UPDATED,
  IPC_VOICE_CREATE_OPENAI_SESSION,
  IPC_VOICE_EXECUTE_TOOL,
  IPC_VOICE_ORCHESTRATOR_CONFIG,
  IPC_VOICE_CREATE_XAI_SESSION,
  IPC_VOICE_CREATE_INWORLD_SESSION,
  IPC_VOICE_PREFERENCES_CHANGED,
  IPC_VOICE_REPORT_SESSION_ERROR,
  IPC_VOICE_SESSION_ERROR,
} from "@stella/contracts/desktop/ipc-channels";
import type {
  RuntimeVoiceOrchestratorConfig,
  RuntimeVoiceToolCallPayload,
  RuntimeVoiceToolCallResult,
} from "@stella/contracts/protocol";
import type { RuntimeModelCatalogSnapshot } from "@stella/contracts/model-catalog";

// ---------------------------------------------------------------------------
// IPC listener helpers — eliminate boilerplate for the 3 common patterns.
// ---------------------------------------------------------------------------

/** Subscribe to an IPC channel, stripping the IpcRendererEvent and forwarding data. */
const onIpc =
  <T>(channel: string) =>
  (callback: (data: T) => void): (() => void) => {
    const handler = (_event: IpcRendererEvent, data: T) => callback(data);
    ipcRenderer.on(channel, handler);
    return () => {
      ipcRenderer.removeListener(channel, handler);
    };
  };

/** Subscribe to an IPC channel that sends no payload. */
const onIpcSignal =
  (channel: string) =>
  (callback: () => void): (() => void) => {
    const handler = () => callback();
    ipcRenderer.on(channel, handler);
    return () => {
      ipcRenderer.removeListener(channel, handler);
    };
  };

/** Subscribe to an IPC channel, forwarding both the event and payload. */
const onIpcWithEvent =
  <T>(channel: string) =>
  (callback: (event: IpcRendererEvent, data: T) => void): (() => void) => {
    ipcRenderer.on(channel, callback);
    return () => {
      ipcRenderer.removeListener(channel, callback);
    };
  };

/** Electron wraps handler errors as "Error invoking remote method 'ch': Error: …" — unwrap for UI. */
const unwrapIpcInvokeError = (error: unknown): Error => {
  if (!(error instanceof Error)) {
    return new Error(String(error));
  }
  const wrapped = error.message.match(
    /^Error invoking remote method '[^']+':\s*(.+)$/s,
  );
  if (!wrapped) {
    return error;
  }
  let inner = wrapped[1].trim();
  const nested = inner.match(/^Error:\s*(.+)$/s);
  if (nested) {
    inner = nested[1].trim();
  }
  return new Error(inner);
};

const invokeIpc = async <T>(channel: string, payload?: unknown): Promise<T> => {
  try {
    return (await ipcRenderer.invoke(channel, payload)) as T;
  } catch (error) {
    throw unwrapIpcInvokeError(error);
  }
};

const invokeBrowserFetch = async <T>(
  channel: "browser:fetchJson" | "browser:fetchText",
  payload: { url: string; init?: unknown },
): Promise<T> => {
  try {
    return (await ipcRenderer.invoke(channel, payload)) as T;
  } catch (error) {
    throw unwrapIpcInvokeError(error);
  }
};

type BrowserViewState = {
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

type BrowserViewLayout = {
  pageBounds: { x: number; y: number; width: number; height: number };
  surfaceBounds: { x: number; y: number; width: number; height: number };
};

// ---------------------------------------------------------------------------

// Shared UI state (~/.stella/ui-state.json) snapshot, read synchronously so
// the boot script and module-load preference reads see it before first paint.
contextBridge.exposeInMainWorld(
  "__stellaUiState",
  (() => {
    try {
      const snapshot = ipcRenderer.sendSync(
        IPC_UI_STATE_KV_SNAPSHOT,
      ) as unknown;
      return snapshot && typeof snapshot === "object" ? snapshot : {};
    } catch {
      return {};
    }
  })(),
);

contextBridge.exposeInMainWorld("electronAPI", {
  platform: process.platform,
  arch: process.arch,

  files: {
    /**
     * Absolute on-disk path for a picker/drag-drop `File`, or "" for
     * synthetic files (e.g. clipboard images). Lets the composer attach
     * images by path so the renderer never loads the original bytes.
     */
    getPathForFile: (file: File) => {
      try {
        return webUtils.getPathForFile(file) || "";
      } catch {
        return "";
      }
    },
  },

  cloudHome: {
    scanLocal: (accountScope: string) =>
      invokeIpc<LocalCloudHomeScan>(IPC_CLOUD_HOME_SCAN_LOCAL, accountScope),
    getImportOwnership: (accountScope: string) =>
      invokeIpc<CloudHomeImportOwnership>(
        IPC_CLOUD_HOME_GET_IMPORT_OWNERSHIP,
        accountScope,
      ),
    confirmImportOwnership: (accountScope: string) =>
      invokeIpc<boolean>(IPC_CLOUD_HOME_CONFIRM_IMPORT_OWNERSHIP, accountScope),
    beginMemoryExport: (payload: {
      suggestedName: string;
      expectedSubject: string;
      ownerGeneration: string;
      memoryEpoch: string;
      lifecycleState: "open";
    }) =>
      invokeIpc<{ ok: true; exportId: string } | { ok: false; canceled: true }>(
        IPC_CLOUD_HOME_BEGIN_MEMORY_EXPORT,
        payload,
      ),
    commitMemoryExport: (payload: {
      exportId: string;
      content: string;
      expectedSubject: string;
      ownerGeneration: string;
      memoryEpoch: string;
      lifecycleState: "open";
    }) =>
      invokeIpc<{ ok: true } | { ok: false; canceled: true }>(
        IPC_CLOUD_HOME_COMMIT_MEMORY_EXPORT,
        payload,
      ),
    cancelMemoryExport: (exportId: string) =>
      invokeIpc<{ ok: true }>(IPC_CLOUD_HOME_CANCEL_MEMORY_EXPORT, {
        exportId,
      }),
  },

  cloudConversationCache: {
    retainAccount: (accountScope: string) =>
      invokeIpc<CloudConversationCachePurgeResult>(
        IPC_CLOUD_CONVERSATION_CACHE_RETAIN_ACCOUNT,
        { accountScope },
      ),
    activateAuthority: (authority: CloudConversationCacheLifecycleAuthority) =>
      invokeIpc<CloudConversationCachePurgeResult>(
        IPC_CLOUD_CONVERSATION_CACHE_ACTIVATE_AUTHORITY,
        authority,
      ),
    read: (authority: CloudConversationCacheAuthority) =>
      invokeIpc<CloudConversationCacheSnapshot | null>(
        IPC_CLOUD_CONVERSATION_CACHE_READ,
        authority,
      ),
    replace: (input: CloudConversationCacheReplaceInput) =>
      invokeIpc<CloudConversationCacheReplaceResult>(
        IPC_CLOUD_CONVERSATION_CACHE_REPLACE,
        input,
      ),
    purgeConversation: (authority: CloudConversationCacheAuthority) =>
      invokeIpc<CloudConversationCachePurgeResult>(
        IPC_CLOUD_CONVERSATION_CACHE_PURGE_CONVERSATION,
        authority,
      ),
  },

  window: {
    minimize: () => ipcRenderer.send("window:minimize"),
    maximize: () => ipcRenderer.send("window:maximize"),
    close: () => ipcRenderer.send("window:close"),
    isMaximized: () => ipcRenderer.invoke("window:isMaximized"),
    show: (target: "full") => ipcRenderer.send("window:show", target),
    setNativeButtonsVisible: (visible: boolean) =>
      ipcRenderer.send(IPC_WINDOW_SET_NATIVE_BUTTONS_VISIBLE, visible),
  },

  display: {
    onUpdate: onIpc<string | unknown>("display:update"),
    readFile: (
      filePath: string,
      options?: { conversationId?: string | null; maxBytes?: number },
    ) =>
      ipcRenderer.invoke("display:readFile", {
        filePath,
        conversationId: options?.conversationId,
        maxBytes: options?.maxBytes,
      }) as Promise<
        | {
            bytes: Uint8Array;
            sizeBytes: number;
            mimeType: string;
            truncated: boolean;
            missing: false;
          }
        | { missing: true; mimeType: string; path: string }
      >,
    listCanvasHtml: () =>
      ipcRenderer.invoke(IPC_DISPLAY_LIST_CANVAS_HTML) as Promise<
        Array<{
          filePath: string;
          slug: string;
          title: string;
          createdAt: number;
        }>
      >,
    openSharedCanvas: (payload: { url: string }) =>
      ipcRenderer.invoke(IPC_DISPLAY_OPEN_SHARED_CANVAS, payload) as Promise<{
        kind: "canvas-html";
        filePath: string;
        slug: string;
        title: string;
        createdAt: number;
      } | null>,
    listTrash: () => ipcRenderer.invoke(IPC_DISPLAY_TRASH_LIST),
    forceDeleteTrash: (payload: { id?: string; all?: boolean }) =>
      ipcRenderer.invoke(IPC_DISPLAY_TRASH_FORCE_DELETE, payload),
  },

  officePreview: {
    list: (options?: { conversationId?: string | null }) =>
      ipcRenderer.invoke(IPC_OFFICE_PREVIEW_LIST, options ?? {}) as Promise<
        OfficePreviewSnapshot[]
      >,
    start: (filePath: string, options?: { conversationId?: string | null }) =>
      ipcRenderer.invoke(IPC_OFFICE_PREVIEW_START, {
        filePath,
        conversationId: options?.conversationId,
      }) as Promise<{
        sessionId: string;
        title: string;
        sourcePath: string;
      }>,
    onUpdate: onIpc<OfficePreviewSnapshot>(IPC_OFFICE_PREVIEW_UPDATE),
  },

  ui: {
    getState: () => ipcRenderer.invoke("ui:getState"),
    setState: (partial: Record<string, unknown>) =>
      ipcRenderer.invoke("ui:setState", partial),
    onState: onIpc<Record<string, unknown>>("ui:state"),
    onOpenChatSidebar: onIpcSignal("chat:openSidebar"),
    setAppReady: (ready: boolean) => ipcRenderer.send("app:setReady", ready),
    reload: () => ipcRenderer.send("app:reload"),
    relaunch: () => ipcRenderer.send("app:relaunch"),
    hardReset: () =>
      ipcRenderer.invoke("app:hardResetLocalState") as Promise<{ ok: boolean }>,
  },

  updates: {
    getState: () => invokeIpc<DesktopUpdateSnapshot>(IPC_UPDATES_GET_STATE),
    check: () => invokeIpc<DesktopUpdateSnapshot>(IPC_UPDATES_CHECK),
    download: () => invokeIpc<DesktopUpdateSnapshot>(IPC_UPDATES_DOWNLOAD),
    restartAndInstall: () =>
      invokeIpc<{ accepted: true }>(IPC_UPDATES_RESTART_AND_INSTALL),
    onStateChanged: onIpc<DesktopUpdateSnapshot>(IPC_UPDATES_STATE_CHANGED),
  },

  capture: {
    getContext: () => ipcRenderer.invoke("chatContext:get"),
    setContext: (context: ChatContext | null) =>
      ipcRenderer.send("chatContext:set", context),
    onContext: onIpc<Record<string, unknown> | null>("chatContext:updated"),
    onRegionCaptureFailed: onIpcSignal(IPC_CAPTURE_REGION_FAILED),
    screenshot: (point?: { x: number; y: number }) =>
      ipcRenderer.invoke("screenshot:capture", point),
    visionScreenshots: (point?: { x: number; y: number }) =>
      ipcRenderer.invoke("screenshot:captureVision", point) as Promise<
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
      >,
    removeScreenshot: (index: number) =>
      ipcRenderer.send("chatContext:removeScreenshot", index),
    submitRegionSelection: (payload: {
      x: number;
      y: number;
      width: number;
      height: number;
    }) => ipcRenderer.send("region:select", payload),
    prepareRegionSelection: (payload: {
      x: number;
      y: number;
      width: number;
      height: number;
    }) =>
      ipcRenderer.invoke("region:prepareSelection", payload) as Promise<{
        screenshot: {
          dataUrl: string;
          width: number;
          height: number;
        } | null;
        window: null;
      } | null>,
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
    ) => ipcRenderer.send("region:commitPrepared", result),
    submitRegionClick: (point: { x: number; y: number }) =>
      ipcRenderer.send("region:click", point),
    getWindowCapture: (point: { x: number; y: number }) =>
      ipcRenderer.invoke("region:getWindowCapture", point) as Promise<{
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
      } | null>,
    cancelRegion: () => ipcRenderer.send("region:cancel"),
    cursorDisplayInfo: () =>
      ipcRenderer.invoke("capture:cursorDisplayInfo") as Promise<{
        x: number;
        y: number;
        width: number;
        height: number;
        scaleFactor: number;
      }>,
    pageDataUrl: () =>
      ipcRenderer.invoke("capture:pageDataUrl") as Promise<string | null>,
    beginRegionCapture: () =>
      ipcRenderer.invoke("capture:beginRegionCapture") as Promise<
        { ok: true } | { cancelled: true }
      >,
  },

  overlay: {
    setInteractive: (interactive: boolean) =>
      ipcRenderer.send("overlay:setInteractive", interactive),
    showWindowHighlight: (payload: {
      bounds: {
        x: number;
        y: number;
        width: number;
        height: number;
      };
      tone?: "default" | "subtle";
    }) => ipcRenderer.send("overlay:showWindowHighlight", payload),
    hideWindowHighlight: () => ipcRenderer.send("overlay:hideWindowHighlight"),
    previewWindowHighlightAtPoint: (point: { x: number; y: number }) =>
      ipcRenderer.send("overlay:previewWindowHighlightAtPoint", point),
    onStartRegionCapture: onIpc<{
      mode?: "capture" | "window-attach";
    }>("overlay:startRegionCapture"),
    onEndRegionCapture: onIpcSignal("overlay:endRegionCapture"),
    onWindowHighlight: onIpc<{
      x: number;
      y: number;
      width: number;
      height: number;
      tone?: "default" | "subtle";
    } | null>("overlay:windowHighlight"),
    onShowDictation: onIpc<{ x: number; y: number }>("overlay:showDictation"),
    onHideDictation: onIpcSignal("overlay:hideDictation"),
    onShowScreenGuide: onIpc<{
      annotations: Array<{
        id: string;
        label: string;
        x: number;
        y: number;
      }>;
    }>("overlay:showScreenGuide"),
    onHideScreenGuide: onIpcSignal("overlay:hideScreenGuide"),
    onShowSelectionChip: onIpc<{
      requestId: number;
      text: string;
      rect: { x: number; y: number; width: number; height: number };
    }>("overlay:showSelectionChip"),
    onHideSelectionChip: onIpc<{ requestId?: number } | null>(
      "overlay:hideSelectionChip",
    ),
    selectionChipClicked: (requestId: number) =>
      ipcRenderer.send("overlay:selectionChipClicked", { requestId }),
    onDisplayChange: onIpc<{
      origin: { x: number; y: number };
      bounds: { x: number; y: number; width: number; height: number };
    }>("overlay:displayChange"),
  },

  theme: {
    listInstalled: () => ipcRenderer.invoke("theme:listInstalled"),
  },

  website: {
    getBaseUrl: () =>
      ipcRenderer.invoke(IPC_WEBSITE_GET_BASE_URL) as Promise<string>,
  },

  uiState: {
    apply: (changes: Record<string, string | null>) =>
      ipcRenderer.send(IPC_UI_STATE_KV_APPLY, changes),
    clear: () => ipcRenderer.send(IPC_UI_STATE_KV_CLEAR),
    onChanged: onIpc<Record<string, string | null>>(IPC_UI_STATE_KV_CHANGED),
  },

  screenGuide: {
    show: (
      annotations: Array<{
        id: string;
        label: string;
        x: number;
        y: number;
      }>,
    ) => ipcRenderer.send("screenGuide:show", { annotations }),
    hide: () => ipcRenderer.send("screenGuide:hide"),
  },

  voice: {
    persistTranscript: (payload: {
      conversationId: string;
      role: "user" | "assistant";
      text: string;
      uiVisibility?: "visible" | "hidden";
      voiceSession?: { durationMs: number };
    }) => ipcRenderer.send("voice:persistTranscript", payload),
    orchestratorChat: (payload: { conversationId: string; message: string }) =>
      ipcRenderer.invoke("voice:orchestratorChat", payload) as Promise<string>,
    getOrchestratorConfig: (payload: { conversationId: string }) =>
      ipcRenderer.invoke(
        IPC_VOICE_ORCHESTRATOR_CONFIG,
        payload,
      ) as Promise<RuntimeVoiceOrchestratorConfig>,
    executeTool: (payload: RuntimeVoiceToolCallPayload) =>
      ipcRenderer.invoke(
        IPC_VOICE_EXECUTE_TOOL,
        payload,
      ) as Promise<RuntimeVoiceToolCallResult>,
    webSearch: (payload: { query: string; category?: string }) =>
      ipcRenderer.invoke("voice:webSearch", payload) as Promise<{
        text: string;
        results: Array<{ title: string; url: string; snippet: string }>;
      }>,
    createOpenAISession: (payload: {
      instructions?: string;
      tools?: RuntimeVoiceOrchestratorConfig["tools"];
    }) =>
      ipcRenderer.invoke(IPC_VOICE_CREATE_OPENAI_SESSION, payload) as Promise<{
        provider: "openai";
        clientSecret: string;
        model: string;
        voice: string;
        expiresAt?: number;
        sessionId?: string;
      }>,
    createXaiSession: (payload: {
      instructions?: string;
      tools?: RuntimeVoiceOrchestratorConfig["tools"];
    }) =>
      ipcRenderer.invoke(IPC_VOICE_CREATE_XAI_SESSION, payload) as Promise<{
        provider: "xai";
        clientSecret: string;
        model: string;
        voice: string;
        expiresAt?: number;
      }>,
    createInworldSession: (payload: { instructions?: string }) =>
      ipcRenderer.invoke(IPC_VOICE_CREATE_INWORLD_SESSION, payload) as Promise<{
        provider: "inworld";
        clientSecret: string;
        model: string;
        voice: string;
        iceServers?: RTCIceServer[];
      }>,
    getCoreMemory: () =>
      ipcRenderer.invoke("voice:getCoreMemory") as Promise<string>,
    getRuntimeState: () =>
      ipcRenderer.invoke("voice:getRuntimeState") as Promise<{
        sessionState:
          "idle" | "connecting" | "connected" | "error" | "disconnecting";
        isConnected: boolean;
        isSpeaking: boolean;
        isUserSpeaking: boolean;
        micLevel: number;
        outputLevel: number;
      }>,
    onRuntimeState: onIpc<{
      sessionState:
        "idle" | "connecting" | "connected" | "error" | "disconnecting";
      isConnected: boolean;
      isSpeaking: boolean;
      isUserSpeaking: boolean;
      micLevel: number;
      outputLevel: number;
    }>("voice:runtimeState"),
    pushRuntimeState: (state: {
      sessionState:
        "idle" | "connecting" | "connected" | "error" | "disconnecting";
      isConnected: boolean;
      isSpeaking: boolean;
      isUserSpeaking: boolean;
      micLevel: number;
      outputLevel: number;
    }) => ipcRenderer.send("voice:runtimeState", state),
    setRtcShortcut: (shortcut: string) =>
      ipcRenderer.invoke("voice-rtc:setShortcut", shortcut) as Promise<{
        ok: boolean;
        requestedShortcut: string;
        activeShortcut: string;
        error?: string;
      }>,
    getRtcShortcut: () =>
      ipcRenderer.invoke("voice-rtc:getShortcut") as Promise<string>,
    reportSessionError: (message: string) =>
      ipcRenderer.send(IPC_VOICE_REPORT_SESSION_ERROR, message),
    onSessionError: onIpc<string>(IPC_VOICE_SESSION_ERROR),
    onPreferencesChanged: onIpc<RealtimeVoicePreferences>(
      IPC_VOICE_PREFERENCES_CHANGED,
    ),
  },

  dictation: {
    onToggle: onIpc<{
      startId?: string;
      action?: "toggle" | "start" | "reveal" | "stop" | "cancel";
    }>("dictation:toggle"),
    getShortcut: () =>
      ipcRenderer.invoke("dictation:getShortcut") as Promise<string>,
    setShortcut: (shortcut: string) =>
      ipcRenderer.invoke("dictation:setShortcut", shortcut) as Promise<{
        ok: boolean;
        requestedShortcut: string;
        activeShortcut: string;
        error?: string;
      }>,
    getSoundEffectsEnabled: () =>
      ipcRenderer.invoke(
        "dictation:getSoundEffectsEnabled",
      ) as Promise<boolean>,
    setSoundEffectsEnabled: (enabled: boolean) =>
      ipcRenderer.invoke(
        "dictation:setSoundEffectsEnabled",
        enabled,
      ) as Promise<{ enabled: boolean }>,
    onOverlayStart: onIpc<{ sessionId: string }>("dictation:overlayStart"),
    onOverlayStop: onIpc<{ sessionId: string }>("dictation:overlayStop"),
    onOverlayCancel: onIpc<{ sessionId: string }>("dictation:overlayCancel"),
    overlayCompleted: (payload: { sessionId: string; text: string }) =>
      ipcRenderer.send("dictation:overlayCompleted", payload),
    overlayFailed: (payload: { sessionId: string; error?: string }) =>
      ipcRenderer.send("dictation:overlayFailed", payload),
    inAppStarted: (payload: { startId?: string }) =>
      ipcRenderer.send("dictation:inAppStarted", payload),
    activeChanged: (payload: { active: boolean }) =>
      ipcRenderer.send("dictation:activeChanged", payload),
    playSound: (payload: {
      sound: "startRecording" | "stopRecording" | "cancel";
    }) => ipcRenderer.send("dictation:playSound", payload),
  },

  agent: {
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
    }) =>
      ipcRenderer.invoke("agent:oneShotCompletion", payload) as Promise<{
        text: string;
      }>,
    healthCheck: () =>
      ipcRenderer.invoke("agent:healthCheck") as Promise<{
        ready: true;
        runnerVersion: string;
      } | null>,
    getActiveRun: () =>
      ipcRenderer.invoke("agent:getActiveRun") as Promise<{
        runId: string;
        conversationId: string;
        uiVisibility?: "visible" | "hidden";
      } | null>,
    getAppSessionStartedAt: () =>
      ipcRenderer.invoke("agent:getAppSessionStartedAt") as Promise<number>,
    startChat: (payload: {
      conversationId: string;
      userPrompt: string;
      selectedText?: string | null;
      chatContext?: import("@stella/contracts").ChatContext | null;
      deviceId?: string;
      platform?: string;
      timezone?: string;
      mode?: string;
      messageMetadata?: Record<string, unknown>;
      attachments?: Array<{
        url: string;
        mimeType?: string;
      }>;
      agentType?: string;
      storageMode?: "cloud" | "local";
      clientRequestId?: string;
      executionTarget?:
        | { mode: "automatic" }
        | { mode: "cloud" }
        | { mode: "device"; deviceId: string };
    }) =>
      ipcRenderer.invoke("agent:startChat", payload) as Promise<{
        requestId: string;
        runId?: string;
        userMessageId?: string;
        accepted?: boolean;
        deduplicated?: boolean;
      }>,
    sendInput: (payload: {
      conversationId: string;
      threadId: string;
      message: string;
      metadata?: Record<string, unknown>;
    }) =>
      ipcRenderer.invoke("agent:sendInput", payload) as Promise<{
        delivered: boolean;
      }>,
    cancelChat: (runId: string) => ipcRenderer.send("agent:cancelChat", runId),
    resumeConversationExecution: (payload: {
      conversationId: string;
      lastSeq: number;
      lastSourceSeq?: number;
    }) =>
      ipcRenderer.invoke("agent:resume", payload) as Promise<{
        activeRun: {
          runId: string;
          conversationId: string;
          requestId?: string;
          userMessageId?: string;
          uiVisibility?: "visible" | "hidden";
        } | null;
        events: Array<{
          type:
            | "run-started"
            | "run-finished"
            | "status"
            | "provider-lifecycle"
            | "stream"
            | "tool-start"
            | "tool-end"
            | "agent-started"
            | "agent-reasoning"
            | "agent-completed"
            | "agent-failed"
            | "agent-canceled"
            | "agent-progress";
          runId: string;
          conversationId?: string;
          requestId?: string;
          agentType?: string;
          seq: number;
          userMessageId?: string;
          uiVisibility?: "visible" | "hidden";
          rootRunId?: string;
          chunk?: string;
          statusState?:
            "running" | "compacting" | "provider-retry" | "model-fallback";
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
          error?: string;
          fatal?: boolean;
          finalText?: string;
          persisted?: boolean;
          outcome?: "completed" | "error" | "canceled";
          reason?: string;
          replacedByRunId?: string;
          agentId?: string;
          description?: string;
          parentAgentId?: string;
          result?: string;
          statusText?: string;
          reasoningText?: string;
        }>;
      }>,
    onStream: onIpc<{
      type:
        | "run-started"
        | "run-finished"
        | "status"
        | "provider-lifecycle"
        | "stream"
        | "tool-start"
        | "tool-end"
        | "agent-started"
        | "agent-reasoning"
        | "agent-completed"
        | "agent-failed"
        | "agent-canceled"
        | "agent-progress";
      runId: string;
      conversationId?: string;
      requestId?: string;
      agentType?: string;
      seq: number;
      userMessageId?: string;
      uiVisibility?: "visible" | "hidden";
      rootRunId?: string;
      chunk?: string;
      statusState?:
        "running" | "compacting" | "provider-retry" | "model-fallback";
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
      html?: string;
      error?: string;
      fatal?: boolean;
      finalText?: string;
      persisted?: boolean;
      outcome?: "completed" | "error" | "canceled";
      reason?: string;
      replacedByRunId?: string;
      agentId?: string;
      description?: string;
      parentAgentId?: string;
      result?: string;
      statusText?: string;
      reasoningText?: string;
    }>("agent:event"),
    /**
     * Subscribe to runtime client availability transitions. The host
     * adapter fires this whenever the worker connection drops or
     * reattaches — most notably after Electron restarts and reconnects
     * to the still-running detached worker. Renderer hooks listen so
     * they can re-trigger chat-resume the moment the runtime is back.
     */
    onAvailability: onIpc<{
      connected: boolean;
      ready: boolean;
      reason?: string;
      pendingRuntimeRestart?: boolean;
    }>("runtime:availability"),
    triggerViteError: () => ipcRenderer.invoke("devtest:triggerViteError"),
    fixViteError: () => ipcRenderer.invoke("devtest:fixViteError"),
  },

  system: {
    getDeviceId: () => ipcRenderer.invoke("device:getId"),
    signDevice: (input: string) =>
      ipcRenderer.invoke("auth:signDevice", input) as Promise<{
        alg: "ed25519";
        rawPublicKey: number[];
        signature: string;
      }>,
    startPhoneAccessSession: () =>
      ipcRenderer.invoke("phoneAccess:startSession") as Promise<{
        ok: boolean;
      }>,
    stopPhoneAccessSession: () =>
      ipcRenderer.invoke("phoneAccess:stopSession") as Promise<{ ok: boolean }>,
    configurePiRuntime: (config: {
      convexUrl?: string;
      convexSiteUrl?: string;
    }) => ipcRenderer.invoke("host:configurePiRuntime", config),
    getAuthSession: (options?: { allowCached?: boolean }) =>
      ipcRenderer.invoke(IPC_AUTH_GET_SESSION, options),
    signInAnonymous: () => ipcRenderer.invoke(IPC_AUTH_SIGN_IN_ANONYMOUS),
    getChallengeToken: () =>
      ipcRenderer.invoke(IPC_AUTH_GET_CHALLENGE_TOKEN) as Promise<
        string | undefined
      >,
    signOutAuth: () =>
      ipcRenderer.invoke(IPC_AUTH_SIGN_OUT) as Promise<{ ok: boolean }>,
    deleteAuthUser: () =>
      ipcRenderer.invoke(IPC_AUTH_DELETE_USER) as Promise<{ ok: boolean }>,
    applyAuthSessionToken: (sessionToken: string) =>
      ipcRenderer.invoke(IPC_AUTH_APPLY_SESSION_TOKEN, {
        sessionToken,
      }) as Promise<{ ok: boolean }>,
    getConvexAuthToken: () =>
      ipcRenderer.invoke(IPC_AUTH_GET_CONVEX_TOKEN) as Promise<string | null>,
    setCloudSyncEnabled: (payload: { enabled: boolean }) =>
      ipcRenderer.invoke("host:setCloudSyncEnabled", payload),
    setModelCatalogUpdatedAt: (payload: { updatedAt: number | null }) =>
      ipcRenderer.invoke(IPC_HOST_SET_MODEL_CATALOG_UPDATED_AT, payload),
    onAuthSessionInvalidated: onIpcSignal(IPC_AUTH_SESSION_INVALIDATED),
    quitForRestart: () =>
      ipcRenderer.invoke(IPC_APP_QUIT_FOR_RESTART) as Promise<{ ok: boolean }>,
    openFullDiskAccess: () => ipcRenderer.send(IPC_SYSTEM_OPEN_FDA),
    getPermissionStatus: () =>
      ipcRenderer.invoke("permissions:getStatus") as Promise<{
        accessibility: boolean;
        screen: boolean;
        microphone: boolean;
        microphoneStatus:
          "not-determined" | "granted" | "denied" | "restricted" | "unknown";
      }>,
    openPermissionSettings: (kind: string) =>
      ipcRenderer.invoke("permissions:openSettings", { kind }),
    requestPermission: (kind: string) =>
      ipcRenderer.invoke("permissions:request", { kind }) as Promise<{
        granted: boolean;
        alreadyGranted: boolean;
        openedSettings?: boolean;
      }>,
    resetMicrophonePermission: () =>
      ipcRenderer.invoke(IPC_PERMISSIONS_RESET_MICROPHONE) as Promise<{
        ok: boolean;
      }>,
    resetPermission: (kind: string) =>
      ipcRenderer.invoke(IPC_PERMISSIONS_RESET, { kind }) as Promise<{
        ok: boolean;
      }>,
    openExternal: (url: string) => ipcRenderer.send("shell:openExternal", url),
    showItemInFolder: (filePath: string) =>
      ipcRenderer.send("shell:showItemInFolder", filePath),
    saveFileAs: (sourcePath: string, defaultName?: string) =>
      ipcRenderer.invoke(IPC_SHELL_SAVE_FILE_AS, {
        sourcePath,
        defaultName,
      }) as Promise<{
        ok: boolean;
        path?: string;
        canceled?: boolean;
        error?: string;
      }>,
    listExternalOpeners: (filePath: string) =>
      ipcRenderer.invoke(IPC_SHELL_LIST_OPENERS, { filePath }) as Promise<{
        openers: Array<{
          id: string;
          label: string;
          kind: "app" | "default" | "reveal";
        }>;
      }>,
    openWithExternal: (filePath: string, openerId: string) =>
      ipcRenderer.invoke(IPC_SHELL_OPEN_WITH, {
        filePath,
        openerId,
      }) as Promise<{ ok: boolean; error?: string }>,
    openPath: (filePath: string) =>
      ipcRenderer.invoke(IPC_SHELL_OPEN_PATH, { filePath }) as Promise<{
        ok: boolean;
        error?: string;
      }>,
    shellKillByPort: (port: number) =>
      ipcRenderer.invoke("shell:killByPort", { port }),
    getPreventComputerSleep: () =>
      ipcRenderer.invoke(IPC_PREFERENCES_GET_PREVENT_SLEEP) as Promise<boolean>,
    setPreventComputerSleep: (enabled: boolean) =>
      ipcRenderer.invoke(
        IPC_PREFERENCES_SET_PREVENT_SLEEP,
        enabled,
      ) as Promise<{ enabled: boolean }>,
    getLockedComputerUseStatus: () =>
      ipcRenderer.invoke(IPC_PREFERENCES_GET_LOCKED_COMPUTER_USE) as Promise<{
        ok: boolean;
        enabled: boolean;
        installed: boolean;
        active: boolean;
        locked: boolean;
        suppressedUntilManualUnlock: boolean;
        message: string;
        warnings: string[];
      }>,
    setLockedComputerUseEnabled: (enabled: boolean) =>
      ipcRenderer.invoke(
        IPC_PREFERENCES_SET_LOCKED_COMPUTER_USE,
        enabled,
      ) as Promise<{
        ok: boolean;
        enabled: boolean;
        installed: boolean;
        active: boolean;
        locked: boolean;
        suppressedUntilManualUnlock: boolean;
        message: string;
        warnings: string[];
      }>,
    getSoundNotificationsEnabled: () =>
      ipcRenderer.invoke(
        IPC_PREFERENCES_GET_SOUND_NOTIFICATIONS,
      ) as Promise<boolean>,
    setSoundNotificationsEnabled: (enabled: boolean) =>
      ipcRenderer.invoke(
        IPC_PREFERENCES_SET_SOUND_NOTIFICATIONS,
        enabled,
      ) as Promise<{ enabled: boolean }>,
    getReadAloudEnabled: () =>
      ipcRenderer.invoke(IPC_PREFERENCES_GET_READ_ALOUD) as Promise<boolean>,
    setReadAloudEnabled: (enabled: boolean) =>
      ipcRenderer.invoke(IPC_PREFERENCES_SET_READ_ALOUD, enabled) as Promise<{
        enabled: boolean;
      }>,
    onReadAloudEnabledChanged: onIpc<boolean>(
      IPC_PREFERENCES_READ_ALOUD_CHANGED,
    ),
    getOnboardingCompleted: () =>
      ipcRenderer.invoke(
        IPC_PREFERENCES_GET_ONBOARDING_COMPLETED,
      ) as Promise<boolean>,
    setOnboardingCompleted: (completed: boolean) =>
      ipcRenderer.invoke(
        IPC_PREFERENCES_SET_ONBOARDING_COMPLETED,
        completed,
      ) as Promise<{ completed: boolean }>,
    setGlobalShortcutsSuspended: (suspended: boolean) =>
      ipcRenderer.invoke(
        IPC_GLOBAL_SHORTCUTS_SET_SUSPENDED,
        suspended,
      ) as Promise<{ supported: boolean; suspended: boolean }>,
    getGlobalShortcutsSuspended: () =>
      ipcRenderer.invoke(IPC_GLOBAL_SHORTCUTS_GET_SUSPENDED) as Promise<{
        supported: boolean;
        suspended: boolean;
      }>,
    recordHeapTrace: (durationMs?: number) =>
      ipcRenderer.invoke(IPC_DIAGNOSTICS_RECORD_HEAP_TRACE, {
        durationMs,
      }) as Promise<{ ok: boolean; path?: string; error?: string }>,
    reportError: (payload: {
      message?: string;
      stack?: string;
      source?: string;
      kind?: string;
    }) => ipcRenderer.send(IPC_DIAGNOSTICS_REPORT_ERROR, payload),
    reportTiming: (payload: {
      phase: string;
      elapsedMs: number;
      durationMs?: number;
      outcome?: "hit" | "miss" | "success" | "unavailable";
    }) => ipcRenderer.send(IPC_DIAGNOSTICS_REPORT_TIMING, payload),
    openLogs: () =>
      ipcRenderer.invoke(IPC_DIAGNOSTICS_OPEN_LOGS) as Promise<{
        ok: boolean;
        path?: string;
        error?: string;
      }>,
    exportLogs: () =>
      ipcRenderer.invoke(IPC_DIAGNOSTICS_EXPORT_LOGS) as Promise<{
        ok: boolean;
        path?: string;
        error?: string;
      }>,
    getWakeWordEnabled: () =>
      ipcRenderer.invoke(IPC_PREFERENCES_GET_WAKE_WORD) as Promise<boolean>,
    setWakeWordEnabled: (enabled: boolean) =>
      ipcRenderer.invoke(IPC_PREFERENCES_SET_WAKE_WORD, enabled) as Promise<{
        enabled: boolean;
      }>,
    listPromptPresets: (agentId: string) =>
      ipcRenderer.invoke(IPC_PROMPT_PRESETS_LIST, agentId) as Promise<{
        presets: Array<{ id: string; name: string; agentId: string }>;
        selectedId: string;
      }>,
    readPromptPreset: (agentId: string, presetId: string) =>
      ipcRenderer.invoke(
        IPC_PROMPT_PRESETS_READ,
        agentId,
        presetId,
      ) as Promise<{
        id: string;
        name: string;
        agentId: string;
        content: string;
      } | null>,
    savePromptPreset: (payload: {
      agentId: string;
      id?: string;
      name: string;
      content: string;
      select?: boolean;
    }) =>
      ipcRenderer.invoke(IPC_PROMPT_PRESETS_SAVE, payload) as Promise<
        | { ok: true; preset: { id: string; name: string; agentId: string } }
        | { ok: false; error: string }
      >,
    deletePromptPreset: (agentId: string, presetId: string) =>
      ipcRenderer.invoke(
        IPC_PROMPT_PRESETS_DELETE,
        agentId,
        presetId,
      ) as Promise<{ ok: boolean; selectedId: string }>,
    selectPromptPreset: (agentId: string, presetId: string) =>
      ipcRenderer.invoke(
        IPC_PROMPT_PRESETS_SELECT,
        agentId,
        presetId,
      ) as Promise<{ ok: boolean; selectedId: string }>,
    resetCustomizations: () =>
      ipcRenderer.invoke(IPC_CUSTOMIZATIONS_RESET) as Promise<{
        ok: boolean;
        movedEntries: string[];
        trashDir?: string | null;
        error?: string;
      }>,
    getLocalModelPreferences: () =>
      ipcRenderer.invoke(IPC_PREFERENCES_GET_MODELS) as Promise<{
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
          "default" | "minimal" | "low" | "medium" | "high" | "xhigh";
        claudeCodeModel: string;
        claudeCodeReasoningEffort:
          "default" | "minimal" | "low" | "medium" | "high" | "xhigh";
        useNativeClaudeCodeRuntime: boolean;
        maxAgentConcurrency: number;
        imageGeneration: {
          provider: "stella" | "openai" | "openrouter" | "fal";
          model?: string;
        };
        realtimeVoice: RealtimeVoicePreferences;
        memoryEnabled: boolean;
      } | null>,
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
        "default" | "minimal" | "low" | "medium" | "high" | "xhigh";
      claudeCodeModel?: string;
      claudeCodeReasoningEffort?:
        "default" | "minimal" | "low" | "medium" | "high" | "xhigh";
      useNativeClaudeCodeRuntime?: boolean;
      maxAgentConcurrency?: number;
      imageGeneration?: {
        provider: "stella" | "openai" | "openrouter" | "fal";
        model?: string;
      };
      realtimeVoice?: RealtimeVoicePreferences;
      memoryEnabled?: boolean;
    }) =>
      ipcRenderer.invoke(IPC_PREFERENCES_SET_MODELS, payload) as Promise<{
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
          "default" | "minimal" | "low" | "medium" | "high" | "xhigh";
        claudeCodeModel: string;
        claudeCodeReasoningEffort:
          "default" | "minimal" | "low" | "medium" | "high" | "xhigh";
        useNativeClaudeCodeRuntime: boolean;
        maxAgentConcurrency: number;
        imageGeneration: {
          provider: "stella" | "openai" | "openrouter" | "fal";
          model?: string;
        };
        realtimeVoice: RealtimeVoicePreferences;
        memoryEnabled: boolean;
      } | null>,
    listCodexModels: () =>
      ipcRenderer.invoke(IPC_PREFERENCES_LIST_CODEX_MODELS) as Promise<{
        models: Array<{
          id: string;
          model: string;
          displayName: string;
          description: string;
          hidden: boolean;
          supportedReasoningEfforts: Array<{
            reasoningEffort:
              "none" | "minimal" | "low" | "medium" | "high" | "xhigh";
            description: string;
          }>;
          defaultReasoningEffort:
            "none" | "minimal" | "low" | "medium" | "high" | "xhigh";
          inputModalities: string[];
          additionalSpeedTiers: string[];
          isDefault: boolean;
        }>;
      }>,
    listClaudeCodeModels: () =>
      ipcRenderer.invoke(IPC_PREFERENCES_LIST_CLAUDE_CODE_MODELS) as Promise<{
        models: Array<{
          id: string;
          displayName: string;
          description?: string;
          source: "alias" | "anthropic";
        }>;
      }>,
    listLlmModels: (options?: { forceRefresh?: boolean }) =>
      ipcRenderer.invoke(
        IPC_PREFERENCES_LIST_MODELS,
        options,
      ) as Promise<RuntimeModelCatalogSnapshot>,
    onLlmModelsUpdated: onIpc<RuntimeModelCatalogSnapshot>(
      IPC_PREFERENCES_MODELS_UPDATED,
    ),
    listLlmCredentials: () =>
      ipcRenderer.invoke("llmCredentials:list") as Promise<
        Array<{
          provider: string;
          label: string;
          status: "active";
          updatedAt: number;
        }>
      >,
    listLlmOAuthProviders: () =>
      ipcRenderer.invoke("llmCredentials:listOAuthProviders") as Promise<
        Array<{ provider: string; label: string }>
      >,
    listLlmOAuthCredentials: () =>
      ipcRenderer.invoke("llmCredentials:listOAuth") as Promise<
        Array<{
          provider: string;
          label: string;
          status: "active";
          updatedAt: number;
        }>
      >,
    loginLlmOAuthCredential: (provider: string) =>
      ipcRenderer.invoke("llmCredentials:loginOAuth", { provider }) as Promise<{
        provider: string;
        label: string;
        status: "active";
        updatedAt: number;
      }>,
    cancelLlmOAuthCredential: (provider: string) =>
      ipcRenderer.invoke("llmCredentials:cancelOAuth", {
        provider,
      }) as Promise<{
        canceled: boolean;
      }>,
    validateLlmOAuthCredential: (provider: string) =>
      ipcRenderer.invoke("llmCredentials:validateOAuth", {
        provider,
      }) as Promise<{
        connected: boolean;
        needsReauth: boolean;
      }>,
    deleteLlmOAuthCredential: (provider: string) =>
      ipcRenderer.invoke("llmCredentials:deleteOAuth", {
        provider,
      }) as Promise<{
        removed: boolean;
      }>,
    saveLlmCredential: (payload: {
      provider: string;
      label: string;
      plaintext: string;
    }) =>
      ipcRenderer.invoke("llmCredentials:save", payload) as Promise<{
        provider: string;
        label: string;
        status: "active";
        updatedAt: number;
      }>,
    deleteLlmCredential: (provider: string) =>
      ipcRenderer.invoke("llmCredentials:delete", { provider }) as Promise<{
        removed: boolean;
      }>,
    detectTechnicalUserSignals: () =>
      ipcRenderer.invoke("system:detectTechnicalUserSignals") as Promise<{
        signals: Array<
          | "claude-app"
          | "chatgpt-app"
          | "cursor-app"
          | "claude-cli"
          | "opencode-cli"
          | "pi-cli"
          | "openclaw-cli"
          | "hermes-cli"
        >;
      }>,
    resetMessages: () =>
      ipcRenderer.invoke("app:resetLocalMessages") as Promise<{ ok: boolean }>,
    onCredentialRequest: onIpcWithEvent<{
      requestId: string;
      provider: string;
      label?: string;
      description?: string;
      placeholder?: string;
    }>("credential:request"),
    submitCredential: (payload: {
      requestId: string;
      secretId: string;
      provider: string;
      label: string;
    }) => ipcRenderer.invoke("credential:submit", payload),
    cancelCredential: (payload: { requestId: string }) =>
      ipcRenderer.invoke("credential:cancel", payload),
    onConnectorCredentialRequest: onIpcWithEvent<{
      requestId: string;
      tokenKey: string;
      displayName: string;
      mode: "api_key" | "oauth";
      completionMode?: "approve" | "wait";
      description?: string;
      placeholder?: string;
      oauthUserCode?: string;
      oauthVerificationUri?: string;
    }>("connector-credential:request"),
    onConnectorCredentialComplete: onIpcWithEvent<{
      requestId: string;
      ok: boolean;
      reason?: string;
    }>("connector-credential:complete"),
    submitConnectorCredential: (payload: {
      requestId: string;
      value: string;
      label?: string;
    }) => ipcRenderer.invoke("connector-credential:submit", payload),
    cancelConnectorCredential: (payload: { requestId: string }) =>
      ipcRenderer.invoke("connector-credential:cancel", payload),
    onConnectorConnectRequest: onIpcWithEvent<{
      requestId: string;
      id: string;
      name: string;
      description?: string;
      iconUrl?: string;
      category?: string;
      reason?: string;
      kind?: "integration" | "browser-extension";
      conversationId?: string;
    }>("connector-connect:request"),
    onConnectorConnectUpdate: onIpcWithEvent<{
      requestId: string;
      phase:
        | "connecting"
        | "connected"
        | "declined"
        | "cancelled"
        | "timeout"
        | "error";
      message?: string;
    }>("connector-connect:update"),
    respondConnectorConnect: (payload: {
      requestId: string;
      action: "accept" | "decline" | "cancel";
    }) =>
      ipcRenderer.invoke("connector-connect:respond", payload) as Promise<{
        ok: boolean;
        error?: string;
      }>,
  },

  onboarding: {
    synthesizeCoreMemory: (payload: OnboardingSynthesisRequest) =>
      ipcRenderer.invoke(
        "onboarding:synthesizeCoreMemory",
        payload,
      ) as Promise<OnboardingSynthesisResponse>,
  },

  discovery: {
    checkCoreMemoryExists: () =>
      ipcRenderer.invoke(IPC_DISCOVERY_CORE_MEMORY_EXISTS),
    checkKnowledgeExists: () =>
      ipcRenderer.invoke(IPC_DISCOVERY_KNOWLEDGE_EXISTS),
    collectData: (options?: {
      selectedBrowser?: string;
      selectedProfile?: string;
    }) => ipcRenderer.invoke(IPC_DISCOVERY_COLLECT_BROWSER_DATA, options),
    detectPreferred: () =>
      ipcRenderer.invoke(IPC_DISCOVERY_DETECT_PREFERRED_BROWSER),
    listProfiles: (browserType: string) =>
      ipcRenderer.invoke(IPC_DISCOVERY_LIST_BROWSER_PROFILES, browserType),
    writeCoreMemory: (
      content: string,
      options?: { includeLocation?: boolean },
    ) =>
      ipcRenderer.invoke(IPC_DISCOVERY_WRITE_CORE_MEMORY, {
        content,
        includeLocation: options?.includeLocation === true,
      }),
    writeKnowledge: (payload: DiscoveryKnowledgeSeedPayload) =>
      ipcRenderer.invoke(IPC_DISCOVERY_WRITE_KNOWLEDGE, payload),
    collectAllSignals: (options?: {
      categories?: string[];
      selectedBrowser?: string;
      selectedProfile?: string;
    }) => ipcRenderer.invoke(IPC_DISCOVERY_COLLECT_ALL_SIGNALS, options),
  },

  browser: {
    fetchJson: (
      url: string,
      init?: {
        method?: "GET" | "POST";
        headers?: Record<string, string>;
        body?: string;
      },
    ) => invokeBrowserFetch(IPC_BROWSER_FETCH_JSON, { url, init }),
    fetchText: (
      url: string,
      init?: {
        method?: "GET" | "POST";
        headers?: Record<string, string>;
        body?: string;
      },
    ) => invokeBrowserFetch(IPC_BROWSER_FETCH_TEXT, { url, init }),
    onBridgeStatus: onIpc<StellaBrowserBridgeStatus>("browser:bridgeStatus"),
  },

  browserView: {
    getState: () => invokeIpc<BrowserViewState>("browserView:getState"),
    connect: (payload: { browserType?: string; profileId?: string }) =>
      invokeIpc<BrowserViewState>("browserView:connect", payload),
    show: (payload: BrowserViewLayout) =>
      invokeIpc<BrowserViewState>("browserView:show", payload),
    setVisibleOwner: (payload: { ownerId: string }) =>
      invokeIpc<BrowserViewState>("browserView:setVisibleOwner", payload),
    setOwnerScope: (payload: { ownerId?: string } = {}) =>
      invokeIpc<BrowserViewState>("browserView:setOwnerScope", payload),
    setLayout: (payload: BrowserViewLayout) =>
      invokeIpc<BrowserViewState>("browserView:setLayout", payload),
    hide: () => invokeIpc<BrowserViewState>("browserView:hide"),
    createTab: (
      payload: { url?: string; ownerId?: string; activate?: boolean } = {},
    ) => invokeIpc<BrowserViewState>("browserView:createTab", payload),
    selectTab: (payload: {
      tabId: string;
      ownerId?: string;
      activate?: boolean;
    }) => invokeIpc<BrowserViewState>("browserView:selectTab", payload),
    closeTab: (payload: { tabId: string; ownerId?: string }) =>
      invokeIpc<BrowserViewState>("browserView:closeTab", payload),
    navigate: (payload: { tabId: string; url: string; ownerId?: string }) =>
      invokeIpc<BrowserViewState>("browserView:navigate", payload),
    goBack: (payload: { tabId: string; ownerId?: string }) =>
      invokeIpc<BrowserViewState>("browserView:goBack", payload),
    goForward: (payload: { tabId: string; ownerId?: string }) =>
      invokeIpc<BrowserViewState>("browserView:goForward", payload),
    reload: (payload: { tabId: string; ownerId?: string }) =>
      invokeIpc<BrowserViewState>("browserView:reload", payload),
    requestExtensionConnect: () =>
      invokeIpc<BrowserViewState>("browserView:requestExtensionConnect"),
    onState: onIpc<BrowserViewState>("browserView:state"),
  },

  home: {
    listRecentApps: (limit?: number) =>
      ipcRenderer.invoke(IPC_HOME_LIST_RECENT_APPS, { limit }) as Promise<{
        apps: Array<{
          name: string;
          bundleId?: string;
          pid: number;
          isActive: boolean;
          windowTitle?: string;
          iconDataUrl?: string;
        }>;
      }>,
    getActiveBrowserTab: (bundleId: string) =>
      ipcRenderer.invoke(IPC_HOME_GET_ACTIVE_BROWSER_TAB, {
        bundleId,
      }) as Promise<{
        tab: {
          browser: string;
          bundleId?: string;
          url: string;
          title?: string;
        } | null;
      }>,
    captureAppWindow: (
      target: string | { appName?: string | null; pid?: number | null },
    ) => {
      const payload =
        typeof target === "string"
          ? { appName: target }
          : { appName: target?.appName ?? null, pid: target?.pid ?? null };
      return ipcRenderer.invoke(
        IPC_HOME_CAPTURE_APP_WINDOW,
        payload,
      ) as Promise<{
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
    },
  },

  media: {
    saveOutput: (url: string, fileName: string) =>
      ipcRenderer.invoke(IPC_MEDIA_SAVE_OUTPUT, { url, fileName }) as Promise<{
        ok: boolean;
        path?: string;
        error?: string;
      }>,
    getStellaMediaDir: () =>
      ipcRenderer.invoke(IPC_MEDIA_GET_DIR) as Promise<string | null>,
    copyImage: (pngBase64: string) =>
      ipcRenderer.invoke(IPC_MEDIA_COPY_IMAGE, { pngBase64 }) as Promise<{
        ok: boolean;
        error?: string;
      }>,
    copyAttachment: (payload: {
      path?: string;
      url?: string;
      mimeType?: string;
      kind?: string;
      name?: string;
    }) =>
      ipcRenderer.invoke(IPC_MEDIA_COPY_ATTACHMENT, payload) as Promise<{
        ok: boolean;
        mode?: "image" | "path";
        error?: string;
      }>,
  },

  meetings: {
    status: () =>
      ipcRenderer.invoke("meetings:status") as Promise<{
        available: boolean;
        running?: boolean;
        recording?: boolean;
        paused?: boolean;
        sessionId?: string | null;
        startedAtMs?: number | null;
        segmentSeconds?: number;
        screenPermission?: boolean;
        micPermission?: boolean;
      }>,
    start: (payload?: { sessionId?: string; segmentSeconds?: number }) =>
      ipcRenderer.invoke("meetings:start", payload ?? {}) as Promise<{
        ok: boolean;
        sessionId?: string;
        dir?: string;
        segmentSeconds?: number;
        system?: boolean;
        mic?: boolean;
        startedAtMs?: number;
        reason?: string;
      }>,
    pause: () =>
      ipcRenderer.invoke("meetings:pause") as Promise<{ ok: boolean }>,
    resume: () =>
      ipcRenderer.invoke("meetings:resume") as Promise<{ ok: boolean }>,
    stop: () =>
      ipcRenderer.invoke("meetings:stop") as Promise<{
        ok: boolean;
        sessionId?: string;
        dir?: string;
        durationMs?: number;
        systemSegments?: number;
        micSegments?: number;
        reason?: string;
      }>,
    openFolder: (payload?: { sessionId?: string }) =>
      ipcRenderer.invoke("meetings:openFolder", payload ?? {}) as Promise<{
        ok: boolean;
      }>,
  },

  schedule: {
    listCronJobs: () => ipcRenderer.invoke("schedule:listCronJobs"),
    listHeartbeats: () => ipcRenderer.invoke("schedule:listHeartbeats"),
    listConversationEvents: (payload: {
      conversationId: string;
      maxItems?: number;
    }) => ipcRenderer.invoke("schedule:listConversationEvents", payload),
    getConversationEventCount: (payload: { conversationId: string }) =>
      ipcRenderer.invoke("schedule:getConversationEventCount", payload),
    runCronJob: (payload: { jobId: string }) =>
      ipcRenderer.invoke("schedule:runCronJob", payload),
    removeCronJob: (payload: { jobId: string }) =>
      ipcRenderer.invoke("schedule:removeCronJob", payload),
    updateCronJob: (payload: {
      jobId: string;
      patch: Record<string, unknown>;
    }) => ipcRenderer.invoke("schedule:updateCronJob", payload),
    upsertHeartbeat: (payload: Record<string, unknown>) =>
      ipcRenderer.invoke("schedule:upsertHeartbeat", payload),
    runHeartbeat: (payload: { conversationId: string }) =>
      ipcRenderer.invoke("schedule:runHeartbeat", payload),
    onUpdated: onIpcSignal("schedule:updated"),
  },

  fashion: {
    pickAndSaveBodyPhoto: () =>
      ipcRenderer.invoke("fashion:pickAndSaveBodyPhoto"),
    getBodyPhotoInfo: () => ipcRenderer.invoke("fashion:getBodyPhotoInfo"),
    getBodyPhotoDataUrl: () =>
      ipcRenderer.invoke("fashion:getBodyPhotoDataUrl"),
    deleteBodyPhoto: () => ipcRenderer.invoke("fashion:deleteBodyPhoto"),
    getLocalImageDataUrl: (path: string) =>
      ipcRenderer.invoke("fashion:getLocalImageDataUrl", { path }),
    startOutfitBatch: (payload: {
      prompt?: string;
      batchId?: string;
      count?: number;
      excludeProductIds?: string[];
      seedHints?: string[];
    }) => ipcRenderer.invoke("fashion:startOutfitBatch", payload),
    pickTryOnImages: () => ipcRenderer.invoke("fashion:pickTryOnImages"),
    /**
     * Resolves an absolute filesystem path for a `File` dropped into the
     * fashion drop zone. Uses Electron's `webUtils.getPathForFile`
     * (Electron ≥32) which works under `contextIsolation: true` where
     * `File.path` is no longer exposed. Returns an empty string if the
     * dropped item is not a real on-disk file (e.g. a generated File).
     */
    getDroppedFilePath: (file: File) => {
      try {
        return webUtils.getPathForFile(file) || "";
      } catch {
        return "";
      }
    },
    startTryOn: (payload: {
      prompt?: string;
      batchId?: string;
      imagePaths?: string[];
      imageUrls?: string[];
    }) => ipcRenderer.invoke("fashion:startTryOn", payload),
  },

  localChat: {
    getOrCreateDefaultConversationId: () =>
      ipcRenderer.invoke("localChat:getOrCreateDefaultConversationId"),
    createNewDefaultConversationId: () =>
      ipcRenderer.invoke("localChat:createNewDefaultConversationId"),
    setActiveConversationId: (payload: { conversationId: string }) =>
      ipcRenderer.invoke("localChat:setActiveConversationId", payload),
    listConversations: (payload: {
      limit?: number;
      cursor?: ConversationSummaryCursor | null;
    }): Promise<ConversationSummaryPage> =>
      ipcRenderer.invoke(IPC_LOCAL_CHAT_LIST_CONVERSATIONS, payload),
    deleteConversation: (payload: { conversationId: string }) =>
      ipcRenderer.invoke(IPC_LOCAL_CHAT_DELETE_CONVERSATION, payload),
    truncateConversation: (payload: {
      conversationId: string;
      eventId: string;
    }): Promise<{ removed: number }> =>
      ipcRenderer.invoke(IPC_LOCAL_CHAT_TRUNCATE_CONVERSATION, payload),
    forkConversation: (payload: {
      conversationId: string;
      eventId: string;
    }): Promise<{ conversationId: string } | null> =>
      ipcRenderer.invoke(IPC_LOCAL_CHAT_FORK_CONVERSATION, payload),
    listEvents: (payload: { conversationId: string; maxItems?: number }) =>
      ipcRenderer.invoke("localChat:listEvents", payload),
    listMessages: (payload: {
      conversationId: string;
      maxVisibleMessages?: number;
    }) => ipcRenderer.invoke("localChat:listMessages", payload),
    listMessagesBefore: (payload: {
      conversationId: string;
      beforeTimestampMs: number;
      beforeId: string;
      maxVisibleMessages?: number;
    }) => ipcRenderer.invoke("localChat:listMessagesBefore", payload),
    listMessagesAfter: (payload: {
      conversationId: string;
      afterTimestampMs: number;
      afterId: string;
      afterSequence?: number;
      maxVisibleMessages?: number;
    }) => ipcRenderer.invoke(IPC_LOCAL_CHAT_LIST_MESSAGES_AFTER, payload),
    listMessageToolEvents: (payload: {
      conversationId: string;
      messageTimestampMs: number;
      messageId: string;
      messageSequence?: number;
      afterTimestampMs?: number;
      afterId?: string;
      afterSequence?: number;
      limit?: number;
    }) => ipcRenderer.invoke(IPC_LOCAL_CHAT_LIST_MESSAGE_TOOL_EVENTS, payload),
    listActivity: (payload: {
      conversationId: string;
      limit?: number;
      beforeTimestampMs?: number;
      beforeId?: string;
    }) => ipcRenderer.invoke("localChat:listActivity", payload),
    listThreadActivity: (payload: { conversationId: string }) =>
      ipcRenderer.invoke("localChat:listThreadActivity", payload),
    listLineageMessages: (payload: {
      conversationId: string;
      root: { kind: "message"; id: string } | { kind: "agent"; threadId: string };
      beforeSequence?: number;
      limit?: number;
    }) => ipcRenderer.invoke(IPC_LOCAL_CHAT_LIST_LINEAGE_MESSAGES, payload),
    listReplyCounts: (payload: { conversationId: string }) =>
      ipcRenderer.invoke(IPC_LOCAL_CHAT_LIST_REPLY_COUNTS, payload),
    getAgentReport: (payload: { threadId: string }) =>
      ipcRenderer.invoke(IPC_LOCAL_CHAT_GET_AGENT_REPORT, payload),
    listModelUsage: (payload: {
      fromMs?: number;
      toMs?: number;
      conversationId?: string;
      threadId?: string;
      limit?: number;
    }): Promise<LocalModelUsagePage> =>
      ipcRenderer.invoke(IPC_LOCAL_CHAT_LIST_MODEL_USAGE, payload),
    listFiles: (payload: {
      conversationId: string;
      limit?: number;
      beforeTimestampMs?: number;
      beforeId?: string;
    }) => ipcRenderer.invoke("localChat:listFiles", payload),
    persistDiscoveryWelcome: (payload: {
      conversationId: string;
      message: string;
    }) => ipcRenderer.invoke("localChat:persistDiscoveryWelcome", payload),
    listSyncMessages: (payload: {
      conversationId: string;
      maxMessages?: number;
      includeDeveloperArtifacts?: boolean;
    }) => ipcRenderer.invoke("localChat:listSyncMessages", payload),
    syncMessages: (payload: {
      conversationId: string;
      sinceCursor?: string | null;
      maxMessages?: number;
      includeDeveloperArtifacts?: boolean;
    }) => ipcRenderer.invoke("localChat:syncMessages", payload),
    publishTaskDecoration: (payload: {
      statusTextByAgentId: Record<string, string>;
    }) => ipcRenderer.invoke("localChat:publishTaskDecoration", payload),
    onUpdated: onIpc<LocalChatUpdatedPayload | null>("localChat:updated"),
    onThreadActivityUpdated: onIpc<ThreadActivityUpdatedPayload>(
      "localChat:threadActivityUpdated",
    ),
  },

  userApps: {
    list: () => ipcRenderer.invoke(IPC_USER_APPS_LIST),
    start: (slug: string) => ipcRenderer.invoke(IPC_USER_APPS_START, { slug }),
    stop: (slug: string) => ipcRenderer.invoke(IPC_USER_APPS_STOP, { slug }),
    onUpdated: onIpc<void>(IPC_USER_APPS_UPDATED),
    // Alias retained for consumers that use the event-style naming convention.
    onChanged: onIpc<void>(IPC_USER_APPS_UPDATED),
  },

  pet: {
    getState: () =>
      ipcRenderer.invoke("pet:getState") as Promise<{
        open: boolean;
        status: {
          state:
            "idle" | "running" | "waiting" | "review" | "failed" | "waving";
          title: string;
          message: string;
          isLoading: boolean;
        };
      }>,
    setOpen: (open: boolean) => ipcRenderer.send("pet:setOpen", open),
    onSetOpen: onIpc<boolean>("pet:setOpen"),
    moveWindow: (position: { x: number; y: number }) =>
      ipcRenderer.send("pet:moveWindow", position),
    setComposerActive: (active: boolean) =>
      ipcRenderer.send("pet:setComposerActive", active),
    setInteractive: (active: boolean) =>
      ipcRenderer.send("pet:setInteractive", active),
    requestVoice: () => ipcRenderer.send("pet:requestVoice"),
    requestDictation: () => ipcRenderer.send("pet:requestDictation"),
    onDictationActive: onIpc<boolean>("pet:dictationActive"),
    pushStatus: (status: {
      state: "idle" | "running" | "waiting" | "review" | "failed" | "waving";
      title: string;
      message: string;
      isLoading: boolean;
    }) => ipcRenderer.send("pet:status", status),
    onStatus: onIpc<{
      state: "idle" | "running" | "waiting" | "review" | "failed" | "waving";
      title: string;
      message: string;
      isLoading: boolean;
    }>("pet:status"),
    openChat: () => ipcRenderer.send("pet:openChat"),
    sendMessage: (text: string) => ipcRenderer.send("pet:sendMessage", text),
    onSendMessage: onIpc<string>("pet:sendMessage"),
  },

  nativeIntegrations: {
    list: () => ipcRenderer.invoke("nativeIntegrations:list"),
    enable: (payload: { id: string }) =>
      ipcRenderer.invoke("nativeIntegrations:enable", payload),
    disable: (payload: { id: string }) =>
      ipcRenderer.invoke("nativeIntegrations:disable", payload),
  },
});
