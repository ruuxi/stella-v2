/**
 * IPC Channel Constants
 *
 * Single source of truth for all Electron IPC channel names used between the
 * main process (electron/ipc/*.ts, electron/preload.ts) and the renderer.
 *
 * Import these constants instead of using raw channel-name strings so that:
 *   1. Typos are caught at compile time.
 *   2. Renaming a channel is a single-point change.
 *   3. "Find all references" works across both processes.
 *
 * Naming convention:  `<namespace>:<verb|noun>` in camelCase.
 */
// ── Window ──────────────────────────────────────────────────────────────────
export const IPC_WINDOW_MINIMIZE = "window:minimize";
export const IPC_WINDOW_MAXIMIZE = "window:maximize";
export const IPC_WINDOW_CLOSE = "window:close";
export const IPC_WINDOW_IS_MAXIMIZED = "window:isMaximized";
export const IPC_WINDOW_SHOW = "window:show";
export const IPC_WINDOW_SET_NATIVE_BUTTONS_VISIBLE = "window:setNativeButtonsVisible";
// ── Display ─────────────────────────────────────────────────────────────────
export const IPC_DISPLAY_UPDATE = "display:update";
export const IPC_DISPLAY_READ_FILE = "display:readFile";
export const IPC_DISPLAY_LIST_CANVAS_HTML = "display:listCanvasHtml";
export const IPC_DISPLAY_OPEN_SHARED_CANVAS = "display:openSharedCanvas";
export const IPC_DISPLAY_TRASH_LIST = "displayTrash:list";
export const IPC_DISPLAY_TRASH_FORCE_DELETE = "displayTrash:forceDelete";
export const IPC_OFFICE_PREVIEW_LIST = "officePreview:list";
export const IPC_OFFICE_PREVIEW_START = "officePreview:start";
export const IPC_OFFICE_PREVIEW_UPDATE = "officePreview:update";
// ── UI State ────────────────────────────────────────────────────────────────
export const IPC_UI_GET_STATE = "ui:getState";
export const IPC_UI_SET_STATE = "ui:setState";
export const IPC_UI_STATE = "ui:state";
// ── Shared UI state KV (~/.stella/ui-state.json) ───────────────────────────
export const IPC_UI_STATE_KV_SNAPSHOT = "uiState:snapshot";
export const IPC_UI_STATE_KV_APPLY = "uiState:apply";
export const IPC_UI_STATE_KV_CLEAR = "uiState:clear";
export const IPC_UI_STATE_KV_CHANGED = "uiState:changed";
export const IPC_APP_SET_READY = "app:setReady";
export const IPC_APP_RELOAD = "app:reload";
export const IPC_APP_RELAUNCH = "app:relaunch";
export const IPC_APP_HARD_RESET = "app:hardResetLocalState";
export const IPC_MORPH_START = "morph:start";
export const IPC_MORPH_COMPLETE = "morph:complete";
// ── Capture ─────────────────────────────────────────────────────────────────
export const IPC_CHAT_CONTEXT_GET = "chatContext:get";
export const IPC_CHAT_CONTEXT_UPDATED = "chatContext:updated";
export const IPC_CHAT_CONTEXT_ACK = "chatContext:ack";
export const IPC_CHAT_CONTEXT_REMOVE_SCREENSHOT = "chatContext:removeScreenshot";
export const IPC_SCREENSHOT_CAPTURE = "screenshot:capture";
export const IPC_REGION_SELECT = "region:select";
export const IPC_REGION_CLICK = "region:click";
export const IPC_REGION_GET_WINDOW_CAPTURE = "region:getWindowCapture";
export const IPC_REGION_CANCEL = "region:cancel";
export const IPC_CAPTURE_PAGE_DATA_URL = "capture:pageDataUrl";
export const IPC_CAPTURE_REGION_FAILED = "capture:regionCaptureFailed";
// ── Overlay ─────────────────────────────────────────────────────────────────
export const IPC_OVERLAY_SET_INTERACTIVE = "overlay:setInteractive";
export const IPC_OVERLAY_START_REGION_CAPTURE = "overlay:startRegionCapture";
export const IPC_OVERLAY_END_REGION_CAPTURE = "overlay:endRegionCapture";
export const IPC_OVERLAY_DISPLAY_CHANGE = "overlay:displayChange";
export const IPC_OVERLAY_MORPH_FORWARD = "overlay:morphForward";
export const IPC_OVERLAY_MORPH_BOUNDS = "overlay:morphBounds";
export const IPC_OVERLAY_MORPH_HANDOFF = "overlay:morphHandoff";
export const IPC_OVERLAY_MORPH_END = "overlay:morphEnd";
export const IPC_OVERLAY_MORPH_STATE = "overlay:morphState";
export const IPC_OVERLAY_MORPH_READY = "overlay:morphReady";
export const IPC_OVERLAY_MORPH_DONE = "overlay:morphDone";
export const IPC_OVERLAY_WINDOW_HIGHLIGHT = "overlay:windowHighlight";
export const IPC_OVERLAY_SHOW_WINDOW_HIGHLIGHT = "overlay:showWindowHighlight";
export const IPC_OVERLAY_HIDE_WINDOW_HIGHLIGHT = "overlay:hideWindowHighlight";
export const IPC_OVERLAY_PREVIEW_WINDOW_HIGHLIGHT_AT_POINT = "overlay:previewWindowHighlightAtPoint";
// ── Theme ───────────────────────────────────────────────────────────────────
export const IPC_THEME_LIST_INSTALLED = "theme:listInstalled";
// ── Voice ───────────────────────────────────────────────────────────────────
export const IPC_VOICE_PERSIST_TRANSCRIPT = "voice:persistTranscript";
export const IPC_VOICE_ORCHESTRATOR_CHAT = "voice:orchestratorChat";
export const IPC_VOICE_ORCHESTRATOR_CONFIG = "voice:orchestratorConfig";
export const IPC_VOICE_EXECUTE_TOOL = "voice:executeTool";
export const IPC_VOICE_EXECUTE_MOBILE_TOOL = "voice:executeMobileTool";
export const IPC_VOICE_WEB_SEARCH = "voice:webSearch";
export const IPC_VOICE_CREATE_OPENAI_SESSION = "voice:createOpenAISession";
export const IPC_VOICE_CREATE_XAI_SESSION = "voice:createXaiSession";
export const IPC_VOICE_CREATE_INWORLD_SESSION = "voice:createInworldSession";
export const IPC_VOICE_GET_RUNTIME_STATE = "voice:getRuntimeState";
export const IPC_VOICE_RUNTIME_STATE = "voice:runtimeState";
export const IPC_VOICE_RTC_SET_SHORTCUT = "voice-rtc:setShortcut";
export const IPC_VOICE_RTC_GET_SHORTCUT = "voice-rtc:getShortcut";
/** Renderer (overlay voice runtime) → main: an actionable voice session error. */
export const IPC_VOICE_REPORT_SESSION_ERROR = "voice:reportSessionError";
/** Main → renderer (visible app window): show a voice session error toast. */
export const IPC_VOICE_SESSION_ERROR = "voice:sessionError";
// ── Dictation ───────────────────────────────────────────────────────────────
export const IPC_DICTATION_TOGGLE = "dictation:toggle";
export const IPC_DICTATION_SET_SHORTCUT = "dictation:setShortcut";
export const IPC_DICTATION_GET_SHORTCUT = "dictation:getShortcut";
export const IPC_DICTATION_TRIGGER = "dictation:trigger";
// ── Agent ───────────────────────────────────────────────────────────────────
export const IPC_AGENT_ONE_SHOT_COMPLETION = "agent:oneShotCompletion";
export const IPC_AGENT_HEALTH_CHECK = "agent:healthCheck";
export const IPC_AGENT_GET_ACTIVE_RUN = "agent:getActiveRun";
export const IPC_AGENT_GET_SESSION_STARTED_AT = "agent:getAppSessionStartedAt";
export const IPC_AGENT_START_CHAT = "agent:startChat";
export const IPC_AGENT_SEND_INPUT = "agent:sendInput";
export const IPC_AGENT_CANCEL_CHAT = "agent:cancelChat";
export const IPC_AGENT_RESUME = "agent:resume";
export const IPC_AGENT_EVENT = "agent:event";
/**
 * Fired by the main process whenever the runtime client transitions
 * between connected and disconnected — most importantly after the
 * detached worker reattaches following an Electron restart. The
 * renderer subscribes so the chat-side `useResumeAgentRun` hook can
 * re-trigger replay without waiting for the user to navigate away
 * and back.
 */
export const IPC_RUNTIME_AVAILABILITY = "runtime:availability";
export const IPC_PREFERENCES_MODELS_UPDATED = "preferences:modelsUpdated";
export const IPC_DEVTEST_TRIGGER_VITE_ERROR = "devtest:triggerViteError";
export const IPC_DEVTEST_FIX_VITE_ERROR = "devtest:fixViteError";
// ── System ──────────────────────────────────────────────────────────────────
export const IPC_DEVICE_GET_ID = "device:getId";
export const IPC_PHONE_ACCESS_START = "phoneAccess:startSession";
export const IPC_PHONE_ACCESS_STOP = "phoneAccess:stopSession";
export const IPC_HOST_CONFIGURE_RUNTIME = "host:configurePiRuntime";
export const IPC_AUTH_SET_STATE = "auth:setState";
export const IPC_AUTH_GET_SESSION = "auth:getSession";
export const IPC_AUTH_SIGN_IN_ANONYMOUS = "auth:signInAnonymous";
export const IPC_AUTH_SIGN_OUT = "auth:signOut";
export const IPC_AUTH_DELETE_USER = "auth:deleteUser";
export const IPC_AUTH_VERIFY_CALLBACK_URL = "auth:verifyCallbackUrl";
export const IPC_AUTH_APPLY_SESSION_COOKIE = "auth:applySessionCookie";
export const IPC_AUTH_GET_CONVEX_TOKEN = "auth:getConvexToken";
export const IPC_HOST_SET_CLOUD_SYNC = "host:setCloudSyncEnabled";
export const IPC_HOST_SET_MODEL_CATALOG_UPDATED_AT = "host:setModelCatalogUpdatedAt";
export const IPC_AUTH_CALLBACK = "auth:callback";
export const IPC_AUTH_CONSUME_PENDING_CALLBACK = "auth:consumePendingCallback";
// Social invite deep links (`stella://join/<code>`,
// `stella://add-friend/<username>`) — broadcast + cold-boot pull, mirroring
// the auth callback pair above.
export const IPC_SOCIAL_INVITE = "social:invite";
export const IPC_SOCIAL_CONSUME_PENDING_INVITE = "social:consumePendingInvite";
export const IPC_AUTH_RUNTIME_REFRESH_REQUESTED = "auth:runtimeRefreshRequested";
export const IPC_AUTH_RUNTIME_REFRESH_COMPLETE = "auth:runtimeRefreshComplete";
export const IPC_APP_QUIT_FOR_RESTART = "app:quitForRestart";
export const IPC_SYSTEM_OPEN_FDA = "system:openFullDiskAccess";
export const IPC_PERMISSIONS_GET_STATUS = "permissions:getStatus";
export const IPC_PERMISSIONS_OPEN_SETTINGS = "permissions:openSettings";
export const IPC_PERMISSIONS_REQUEST = "permissions:request";
export const IPC_PERMISSIONS_RESET_MICROPHONE = "permissions:resetMicrophone";
export const IPC_PERMISSIONS_RESET = "permissions:reset";
export const IPC_SHELL_OPEN_EXTERNAL = "shell:openExternal";
export const IPC_SHELL_SHOW_IN_FOLDER = "shell:showItemInFolder";
export const IPC_SHELL_SAVE_FILE_AS = "shell:saveFileAs";
export const IPC_SHELL_KILL_BY_PORT = "shell:killByPort";
export const IPC_SHELL_LIST_OPENERS = "shell:listExternalOpeners";
export const IPC_SHELL_OPEN_WITH = "shell:openWithExternal";
export const IPC_SHELL_OPEN_PATH = "shell:openPath";
export const IPC_PREFERENCES_GET_SYNC_MODE = "preferences:getSyncMode";
export const IPC_PREFERENCES_SET_SYNC_MODE = "preferences:setSyncMode";
export const IPC_PREFERENCES_GET_MODELS = "preferences:getLocalModelPreferences";
export const IPC_PREFERENCES_SET_MODELS = "preferences:setLocalModelPreferences";
export const IPC_PREFERENCES_LIST_MODELS = "preferences:listModels";
export const IPC_PREFERENCES_LIST_CODEX_MODELS = "preferences:listCodexModels";
export const IPC_PREFERENCES_LIST_CLAUDE_CODE_MODELS = "preferences:listClaudeCodeModels";
export const IPC_PREFERENCES_GET_PREVENT_SLEEP = "preferences:getPreventSleep";
export const IPC_PREFERENCES_SET_PREVENT_SLEEP = "preferences:setPreventSleep";
export const IPC_PREFERENCES_GET_LOCKED_COMPUTER_USE = "preferences:getLockedComputerUse";
export const IPC_PREFERENCES_SET_LOCKED_COMPUTER_USE = "preferences:setLockedComputerUse";
export const IPC_PREFERENCES_GET_SOUND_NOTIFICATIONS = "preferences:getSoundNotifications";
export const IPC_PREFERENCES_SET_SOUND_NOTIFICATIONS = "preferences:setSoundNotifications";
export const IPC_PREFERENCES_GET_READ_ALOUD = "preferences:getReadAloud";
export const IPC_PREFERENCES_SET_READ_ALOUD = "preferences:setReadAloud";
export const IPC_PREFERENCES_READ_ALOUD_CHANGED = "preferences:readAloudChanged";
export const IPC_PREFERENCES_GET_ONBOARDING_COMPLETED = "preferences:getOnboardingCompleted";
export const IPC_PREFERENCES_SET_ONBOARDING_COMPLETED = "preferences:setOnboardingCompleted";
export const IPC_GLOBAL_SHORTCUTS_SET_SUSPENDED = "globalShortcuts:setSuspended";
export const IPC_GLOBAL_SHORTCUTS_GET_SUSPENDED = "globalShortcuts:getSuspended";
export const IPC_DIAGNOSTICS_RECORD_HEAP_TRACE = "diagnostics:recordHeapTrace";
export const IPC_DIAGNOSTICS_REPORT_ERROR = "diagnostics:reportError";
export const IPC_DIAGNOSTICS_OPEN_LOGS = "diagnostics:openLogs";
export const IPC_PREFERENCES_GET_PERSONALITY_VOICE = "preferences:getPersonalityVoice";
export const IPC_PREFERENCES_SET_PERSONALITY_VOICE = "preferences:setPersonalityVoice";
export const IPC_PREFERENCES_GET_WAKE_WORD = "preferences:getWakeWord";
export const IPC_PREFERENCES_SET_WAKE_WORD = "preferences:setWakeWord";
export const IPC_PET_REQUEST_DICTATION = "pet:requestDictation";
/** Main → renderer broadcast: pet-mic dictation is currently
 *  recording. Drives the pet's "Sending to Stella…" status pill. */
export const IPC_PET_DICTATION_ACTIVE = "pet:dictationActive";
export const IPC_BACKUP_GET_STATUS = "backup:getStatus";
export const IPC_BACKUP_RUN_NOW = "backup:runNow";
export const IPC_BACKUP_LIST = "backup:list";
export const IPC_BACKUP_RESTORE = "backup:restore";
export const IPC_LLM_CREDENTIALS_LIST = "llmCredentials:list";
export const IPC_LLM_CREDENTIALS_LIST_OAUTH_PROVIDERS = "llmCredentials:listOAuthProviders";
export const IPC_LLM_CREDENTIALS_LIST_OAUTH = "llmCredentials:listOAuth";
export const IPC_LLM_CREDENTIALS_LOGIN_OAUTH = "llmCredentials:loginOAuth";
export const IPC_LLM_CREDENTIALS_DELETE_OAUTH = "llmCredentials:deleteOAuth";
export const IPC_LLM_CREDENTIALS_SAVE = "llmCredentials:save";
export const IPC_LLM_CREDENTIALS_DELETE = "llmCredentials:delete";
export const IPC_APP_RESET_MESSAGES = "app:resetLocalMessages";
export const IPC_CREDENTIAL_REQUEST = "credential:request";
export const IPC_CREDENTIAL_SUBMIT = "credential:submit";
export const IPC_CREDENTIAL_CANCEL = "credential:cancel";
// ── Updates ─────────────────────────────────────────────────────────────────
export const IPC_UPDATES_GET_INSTALL_MANIFEST = "updates:getInstallManifest";
export const IPC_UPDATES_TRY_APPLY_CLEAN = "updates:tryApplyCleanUpdate";
export const IPC_UPDATES_RECORD_APPLIED_COMMIT = "updates:recordAppliedCommit";
export const IPC_UPDATES_REFRESH_NATIVE_HELPERS = "updates:refreshNativeHelpers";
export const IPC_UPDATES_ROLLBACK_CANCELED = "updates:rollbackCanceledUpdate";
// ── Onboarding ──────────────────────────────────────────────────────────────
export const IPC_ONBOARDING_SYNTHESIZE = "onboarding:synthesizeCoreMemory";
// ── Discovery ───────────────────────────────────────────────────────────────
export const IPC_DISCOVERY_CORE_MEMORY_EXISTS = "discovery:coreMemoryExists";
export const IPC_DISCOVERY_KNOWLEDGE_EXISTS = "discovery:knowledgeExists";
export const IPC_DISCOVERY_COLLECT_BROWSER_DATA = "discovery:collectBrowserData";
export const IPC_DISCOVERY_DETECT_PREFERRED_BROWSER = "discovery:detectPreferredBrowser";
export const IPC_DISCOVERY_LIST_BROWSER_PROFILES = "discovery:listBrowserProfiles";
export const IPC_DISCOVERY_WRITE_CORE_MEMORY = "discovery:writeCoreMemory";
export const IPC_DISCOVERY_WRITE_KNOWLEDGE = "discovery:writeKnowledge";
export const IPC_DISCOVERY_COLLECT_ALL_SIGNALS = "discovery:collectAllSignals";
// ── Browser ─────────────────────────────────────────────────────────────────
export const IPC_BROWSER_FETCH_JSON = "browser:fetchJson";
export const IPC_BROWSER_FETCH_TEXT = "browser:fetchText";
export const IPC_BROWSER_BRIDGE_STATUS = "browser:bridgeStatus";
// ── Home ────────────────────────────────────────────────────────────────────
export const IPC_HOME_LIST_RECENT_APPS = "home:listRecentApps";
export const IPC_HOME_GET_ACTIVE_BROWSER_TAB = "home:getActiveBrowserTab";
export const IPC_HOME_CAPTURE_APP_WINDOW = "home:captureAppWindow";
// ── Media ───────────────────────────────────────────────────────────────────
export const IPC_MEDIA_SAVE_OUTPUT = "media:saveOutput";
export const IPC_MEDIA_GET_DIR = "media:getStellaMediaDir";
export const IPC_MEDIA_COPY_IMAGE = "media:copyImage";
// ── Schedule ────────────────────────────────────────────────────────────────
export const IPC_SCHEDULE_LIST_CRON_JOBS = "schedule:listCronJobs";
export const IPC_SCHEDULE_LIST_HEARTBEATS = "schedule:listHeartbeats";
export const IPC_SCHEDULE_LIST_CONVERSATION_EVENTS = "schedule:listConversationEvents";
export const IPC_SCHEDULE_GET_EVENT_COUNT = "schedule:getConversationEventCount";
export const IPC_SCHEDULE_UPDATED = "schedule:updated";
// ── Store ───────────────────────────────────────────────────────────────────
export const IPC_STORE_READ_FEATURE_SNAPSHOT = "store:readFeatureSnapshot";
export const IPC_STORE_LIST_FEATURE_ROSTER = "store:listFeatureRoster";
export const IPC_STORE_LIST_PACKAGES = "store:listPackages";
export const IPC_STORE_GET_PACKAGE = "store:getPackage";
export const IPC_STORE_LIST_RELEASES = "store:listReleases";
export const IPC_STORE_GET_RELEASE = "store:getRelease";
export const IPC_STORE_LIST_INSTALLED = "store:listInstalledMods";
export const IPC_STORE_INSTALL_FROM_BLUEPRINT = "store:installFromBlueprint";
export const IPC_STORE_UNINSTALL = "store:uninstallMod";
// ── Fashion ─────────────────────────────────────────────────────────────────
//
// The body photo intentionally does NOT round-trip through Convex storage —
// we keep raw bytes on disk under `~/.stella/fashion/body.<ext>` and only persist
// a `hasBodyPhoto` flag to the backend (see `backend/convex/data/fashion.ts`).
// These IPC channels expose the local file lifecycle to the renderer.
export const IPC_FASHION_PICK_AND_SAVE_BODY_PHOTO = "fashion:pickAndSaveBodyPhoto";
export const IPC_FASHION_GET_BODY_PHOTO_INFO = "fashion:getBodyPhotoInfo";
export const IPC_FASHION_GET_BODY_PHOTO_DATA_URL = "fashion:getBodyPhotoDataUrl";
export const IPC_FASHION_DELETE_BODY_PHOTO = "fashion:deleteBodyPhoto";
export const IPC_FASHION_START_OUTFIT_BATCH = "fashion:startOutfitBatch";
export const IPC_FASHION_START_TRY_ON = "fashion:startTryOn";
export const IPC_FASHION_PICK_TRY_ON_IMAGES = "fashion:pickTryOnImages";
export const IPC_FASHION_GET_LOCAL_IMAGE_DATA_URL = "fashion:getLocalImageDataUrl";
// ── Local Chat ──────────────────────────────────────────────────────────────
export const IPC_LOCAL_CHAT_GET_OR_CREATE_ID = "localChat:getOrCreateDefaultConversationId";
export const IPC_LOCAL_CHAT_CREATE_NEW_DEFAULT_ID = "localChat:createNewDefaultConversationId";
export const IPC_LOCAL_CHAT_LIST_EVENTS = "localChat:listEvents";
export const IPC_LOCAL_CHAT_LIST_MESSAGES = "localChat:listMessages";
export const IPC_LOCAL_CHAT_LIST_MESSAGES_BEFORE = "localChat:listMessagesBefore";
export const IPC_LOCAL_CHAT_LIST_ACTIVITY = "localChat:listActivity";
export const IPC_LOCAL_CHAT_LIST_THREAD_ACTIVITY = "localChat:listThreadActivity";
export const IPC_LOCAL_CHAT_LIST_AGENT_THREAD_MESSAGES = "localChat:listAgentThreadMessages";
export const IPC_LOCAL_CHAT_LIST_AGENT_THREAD_MESSAGE_PAGE = "localChat:listAgentThreadMessagePage";
export const IPC_LOCAL_CHAT_LIST_FILES = "localChat:listFiles";
export const IPC_LOCAL_CHAT_GET_EVENT_COUNT = "localChat:getEventCount";
export const IPC_LOCAL_CHAT_PERSIST_WELCOME = "localChat:persistDiscoveryWelcome";
export const IPC_LOCAL_CHAT_LIST_SYNC_MESSAGES = "localChat:listSyncMessages";
export const IPC_LOCAL_CHAT_SYNC_MESSAGES = "localChat:syncMessages";
export const IPC_LOCAL_CHAT_GET_SYNC_CHECKPOINT = "localChat:getSyncCheckpoint";
export const IPC_LOCAL_CHAT_SET_SYNC_CHECKPOINT = "localChat:setSyncCheckpoint";
export const IPC_LOCAL_CHAT_UPDATED = "localChat:updated";
export const IPC_LOCAL_CHAT_THREAD_ACTIVITY_UPDATED = "localChat:threadActivityUpdated";
export const IPC_LOCAL_CHAT_TASK_DECORATION_UPDATED = "localChat:taskDecorationUpdated";
// ── Social Sessions ─────────────────────────────────────────────────────────
export const IPC_SOCIAL_SESSIONS_CREATE = "socialSessions:create";
export const IPC_SOCIAL_SESSIONS_UPDATE_STATUS = "socialSessions:updateStatus";
export const IPC_SOCIAL_SESSIONS_QUEUE_TURN = "socialSessions:queueTurn";
export const IPC_SOCIAL_SESSIONS_GET_STATUS = "socialSessions:getStatus";
// ── Pet Overlay ─────────────────────────────────────────────────────────────
//
// The pet renders inside the existing transparent overlay window. State is
// owned by the main process so toggles from any window (Pets settings,
// pet's own context menu) reach every renderer; agent status is produced
// by the full-shell chat surface and broadcast to all renderers via
// `pet:status` so the overlay can drive the right animation and bubble.
//
//   pet:setOpen      any window → main → all renderers (toggle visibility)
//   pet:status       full window → main → all renderers (mood + bubble copy)
//   pet:openChat     pet → main (focus full window + open the sidebar chat)
//   pet:sendMessage  pet → main → full window (deliver popover-composer text)
export const IPC_PET_SET_OPEN = "pet:setOpen";
export const IPC_PET_GET_STATE = "pet:getState";
/** Renderer drag handler: move the dedicated pet window to an absolute
 *  screen-coords position. Sent on every pointermove so the window
 *  follows the cursor smoothly during a drag gesture. */
export const IPC_PET_MOVE_WINDOW = "pet:moveWindow";
/** Pet renderer toggles the inline chat composer. Main grows the
 *  dedicated pet window to make room for the composer to the left of
 *  the sprite *and* flips `focusable` on so the textarea can receive
 *  keystrokes (the resting pet window is non-focusable so it never
 *  steals focus from the active app). */
export const IPC_PET_SET_COMPOSER_ACTIVE = "pet:setComposerActive";
/** Pet voice button: ask main to enter voice (RTC) mode. */
export const IPC_PET_REQUEST_VOICE = "pet:requestVoice";
/** Renderer-driven mouse passthrough toggle. The pet window is small
 *  but most of its rectangle is transparent space around the sprite +
 *  action arc; we keep `setIgnoreMouseEvents(true, { forward: true })`
 *  by default and let the renderer flip it to `false` only while the
 *  cursor is over a visibly-interactive element. Without this empty
 *  pixels of the pet window block clicks to whatever app is below. */
export const IPC_PET_SET_INTERACTIVE = "pet:setInteractive";
export const IPC_PET_STATUS = "pet:status";
export const IPC_PET_OPEN_CHAT = "pet:openChat";
export const IPC_PET_SEND_MESSAGE = "pet:sendMessage";
