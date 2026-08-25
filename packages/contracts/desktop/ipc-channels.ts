export const IPC_WINDOW_MINIMIZE = "window:minimize" as const;
export const IPC_WINDOW_MAXIMIZE = "window:maximize" as const;
export const IPC_WINDOW_CLOSE = "window:close" as const;
export const IPC_WINDOW_IS_MAXIMIZED = "window:isMaximized" as const;
export const IPC_WINDOW_SHOW = "window:show" as const;
export const IPC_WINDOW_SET_NATIVE_BUTTONS_VISIBLE =
  "window:setNativeButtonsVisible" as const;

export const IPC_DISPLAY_UPDATE = "display:update" as const;
export const IPC_DISPLAY_READ_FILE = "display:readFile" as const;
export const IPC_DISPLAY_LIST_CANVAS_HTML = "display:listCanvasHtml" as const;
export const IPC_DISPLAY_OPEN_SHARED_CANVAS =
  "display:openSharedCanvas" as const;
export const IPC_DISPLAY_TRASH_LIST = "displayTrash:list" as const;
export const IPC_DISPLAY_TRASH_FORCE_DELETE =
  "displayTrash:forceDelete" as const;
export const IPC_OFFICE_PREVIEW_LIST = "officePreview:list" as const;
export const IPC_OFFICE_PREVIEW_START = "officePreview:start" as const;
export const IPC_OFFICE_PREVIEW_UPDATE = "officePreview:update" as const;

export const IPC_UI_GET_STATE = "ui:getState" as const;
export const IPC_UI_SET_STATE = "ui:setState" as const;
export const IPC_UI_STATE = "ui:state" as const;

export const IPC_UI_STATE_KV_SNAPSHOT = "uiState:snapshot" as const;
export const IPC_UI_STATE_KV_APPLY = "uiState:apply" as const;
export const IPC_UI_STATE_KV_CLEAR = "uiState:clear" as const;
export const IPC_UI_STATE_KV_CHANGED = "uiState:changed" as const;
export const IPC_APP_SET_READY = "app:setReady" as const;
export const IPC_APP_RELOAD = "app:reload" as const;
export const IPC_APP_RELAUNCH = "app:relaunch" as const;
export const IPC_APP_HARD_RESET = "app:hardResetLocalState" as const;

export const IPC_UPDATES_GET_STATE = "updates:getState" as const;
export const IPC_UPDATES_CHECK = "updates:check" as const;
export const IPC_UPDATES_DOWNLOAD = "updates:download" as const;
export const IPC_UPDATES_RESTART_AND_INSTALL =
  "updates:restartAndInstall" as const;
export const IPC_UPDATES_STATE_CHANGED = "updates:stateChanged" as const;

export const IPC_CHAT_CONTEXT_GET = "chatContext:get" as const;
export const IPC_CHAT_CONTEXT_UPDATED = "chatContext:updated" as const;
export const IPC_CHAT_CONTEXT_ACK = "chatContext:ack" as const;
export const IPC_CHAT_CONTEXT_REMOVE_SCREENSHOT =
  "chatContext:removeScreenshot" as const;
export const IPC_SCREENSHOT_CAPTURE = "screenshot:capture" as const;
export const IPC_REGION_SELECT = "region:select" as const;
export const IPC_REGION_CLICK = "region:click" as const;
export const IPC_REGION_GET_WINDOW_CAPTURE = "region:getWindowCapture" as const;
export const IPC_REGION_CANCEL = "region:cancel" as const;
export const IPC_CAPTURE_PAGE_DATA_URL = "capture:pageDataUrl" as const;
export const IPC_CAPTURE_REGION_FAILED = "capture:regionCaptureFailed" as const;

export const IPC_OVERLAY_SET_INTERACTIVE = "overlay:setInteractive" as const;
export const IPC_OVERLAY_START_REGION_CAPTURE =
  "overlay:startRegionCapture" as const;
export const IPC_OVERLAY_END_REGION_CAPTURE =
  "overlay:endRegionCapture" as const;
export const IPC_OVERLAY_SHOW_MINI = "overlay:showMini" as const;
export const IPC_OVERLAY_HIDE_MINI = "overlay:hideMini" as const;
export const IPC_OVERLAY_RESTORE_MINI = "overlay:restoreMini" as const;
export const IPC_OVERLAY_DISPLAY_CHANGE = "overlay:displayChange" as const;
export const IPC_OVERLAY_WINDOW_HIGHLIGHT = "overlay:windowHighlight" as const;
export const IPC_OVERLAY_SHOW_WINDOW_HIGHLIGHT =
  "overlay:showWindowHighlight" as const;
export const IPC_OVERLAY_HIDE_WINDOW_HIGHLIGHT =
  "overlay:hideWindowHighlight" as const;
export const IPC_OVERLAY_PREVIEW_WINDOW_HIGHLIGHT_AT_POINT =
  "overlay:previewWindowHighlightAtPoint" as const;

export const IPC_MINI_VISIBILITY = "mini:visibility" as const;
export const IPC_MINI_DISMISS_PREVIEW = "mini:dismissPreview" as const;
export const IPC_MINI_BRIDGE_REQUEST = "miniBridge:request" as const;
export const IPC_MINI_BRIDGE_UPDATE = "miniBridge:update" as const;
export const IPC_MINI_BRIDGE_RESPONSE = "miniBridge:response" as const;
export const IPC_MINI_BRIDGE_READY = "miniBridge:ready" as const;

export const IPC_THEME_LIST_INSTALLED = "theme:listInstalled" as const;

export const IPC_WEBSITE_GET_BASE_URL = "website:getBaseUrl" as const;

export const IPC_VOICE_PERSIST_TRANSCRIPT = "voice:persistTranscript" as const;
export const IPC_VOICE_ORCHESTRATOR_CHAT = "voice:orchestratorChat" as const;
export const IPC_VOICE_ORCHESTRATOR_CONFIG =
  "voice:orchestratorConfig" as const;
export const IPC_VOICE_EXECUTE_TOOL = "voice:executeTool" as const;
export const IPC_VOICE_EXECUTE_MOBILE_TOOL = "voice:executeMobileTool" as const;
export const IPC_VOICE_WEB_SEARCH = "voice:webSearch" as const;
export const IPC_VOICE_CREATE_OPENAI_SESSION =
  "voice:createOpenAISession" as const;
export const IPC_VOICE_CREATE_XAI_SESSION = "voice:createXaiSession" as const;
export const IPC_VOICE_CREATE_INWORLD_SESSION =
  "voice:createInworldSession" as const;
export const IPC_VOICE_GET_RUNTIME_STATE = "voice:getRuntimeState" as const;
export const IPC_VOICE_RUNTIME_STATE = "voice:runtimeState" as const;
export const IPC_VOICE_RTC_SET_SHORTCUT = "voice-rtc:setShortcut" as const;
export const IPC_VOICE_RTC_GET_SHORTCUT = "voice-rtc:getShortcut" as const;

export const IPC_VOICE_REPORT_SESSION_ERROR =
  "voice:reportSessionError" as const;

export const IPC_VOICE_SESSION_ERROR = "voice:sessionError" as const;

export const IPC_VOICE_PREFERENCES_CHANGED =
  "voice:preferencesChanged" as const;

export const IPC_DICTATION_TOGGLE = "dictation:toggle" as const;
export const IPC_DICTATION_SET_SHORTCUT = "dictation:setShortcut" as const;
export const IPC_DICTATION_GET_SHORTCUT = "dictation:getShortcut" as const;

export const IPC_AGENT_ONE_SHOT_COMPLETION = "agent:oneShotCompletion" as const;
export const IPC_AGENT_HEALTH_CHECK = "agent:healthCheck" as const;
export const IPC_AGENT_GET_ACTIVE_RUN = "agent:getActiveRun" as const;
export const IPC_AGENT_GET_SESSION_STARTED_AT =
  "agent:getAppSessionStartedAt" as const;
export const IPC_AGENT_START_CHAT = "agent:startChat" as const;
export const IPC_AGENT_SEND_INPUT = "agent:sendInput" as const;
export const IPC_AGENT_CANCEL_CHAT = "agent:cancelChat" as const;
export const IPC_AGENT_RESUME = "agent:resume" as const;
export const IPC_AGENT_EVENT = "agent:event" as const;

export const IPC_RUNTIME_AVAILABILITY = "runtime:availability" as const;
export const IPC_PREFERENCES_MODELS_UPDATED =
  "preferences:modelsUpdated" as const;
export const IPC_DEVTEST_TRIGGER_VITE_ERROR =
  "devtest:triggerViteError" as const;
export const IPC_DEVTEST_FIX_VITE_ERROR = "devtest:fixViteError" as const;

export const IPC_DEVICE_GET_ID = "device:getId" as const;
export const IPC_PHONE_ACCESS_START = "phoneAccess:startSession" as const;
export const IPC_PHONE_ACCESS_STOP = "phoneAccess:stopSession" as const;
export const IPC_HOST_CONFIGURE_RUNTIME = "host:configurePiRuntime" as const;
export const IPC_AUTH_GET_SESSION = "auth:getSession" as const;
export const IPC_AUTH_SIGN_IN_ANONYMOUS = "auth:signInAnonymous" as const;
export const IPC_AUTH_SIGN_OUT = "auth:signOut" as const;
export const IPC_AUTH_DELETE_USER = "auth:deleteUser" as const;
export const IPC_AUTH_APPLY_SESSION_TOKEN = "auth:applySessionToken" as const;
export const IPC_AUTH_GET_CONVEX_TOKEN = "auth:getConvexToken" as const;
export const IPC_HOST_SET_CLOUD_SYNC = "host:setCloudSyncEnabled" as const;
export const IPC_HOST_SET_MODEL_CATALOG_UPDATED_AT =
  "host:setModelCatalogUpdatedAt" as const;
export const IPC_AUTH_SESSION_INVALIDATED = "auth:sessionInvalidated" as const;
export const IPC_APP_QUIT_FOR_RESTART = "app:quitForRestart" as const;
export const IPC_SYSTEM_OPEN_FDA = "system:openFullDiskAccess" as const;
export const IPC_PERMISSIONS_GET_STATUS = "permissions:getStatus" as const;
export const IPC_PERMISSIONS_OPEN_SETTINGS =
  "permissions:openSettings" as const;
export const IPC_PERMISSIONS_REQUEST = "permissions:request" as const;
export const IPC_PERMISSIONS_RESET_MICROPHONE =
  "permissions:resetMicrophone" as const;
export const IPC_PERMISSIONS_RESET = "permissions:reset" as const;
export const IPC_SHELL_OPEN_EXTERNAL = "shell:openExternal" as const;
export const IPC_SHELL_SHOW_IN_FOLDER = "shell:showItemInFolder" as const;
export const IPC_SHELL_SAVE_FILE_AS = "shell:saveFileAs" as const;
export const IPC_SHELL_KILL_BY_PORT = "shell:killByPort" as const;
export const IPC_SHELL_LIST_OPENERS = "shell:listExternalOpeners" as const;
export const IPC_SHELL_OPEN_WITH = "shell:openWithExternal" as const;
export const IPC_SHELL_OPEN_PATH = "shell:openPath" as const;
export const IPC_PREFERENCES_GET_SYNC_MODE = "preferences:getSyncMode" as const;
export const IPC_PREFERENCES_SET_SYNC_MODE = "preferences:setSyncMode" as const;
export const IPC_PREFERENCES_GET_MODELS =
  "preferences:getLocalModelPreferences" as const;
export const IPC_PREFERENCES_SET_MODELS =
  "preferences:setLocalModelPreferences" as const;
export const IPC_PREFERENCES_LIST_MODELS = "preferences:listModels" as const;
export const IPC_PREFERENCES_LIST_CODEX_MODELS =
  "preferences:listCodexModels" as const;
export const IPC_PREFERENCES_LIST_CLAUDE_CODE_MODELS =
  "preferences:listClaudeCodeModels" as const;
export const IPC_PREFERENCES_GET_PREVENT_SLEEP =
  "preferences:getPreventSleep" as const;
export const IPC_PREFERENCES_SET_PREVENT_SLEEP =
  "preferences:setPreventSleep" as const;
export const IPC_PREFERENCES_GET_LOCKED_COMPUTER_USE =
  "preferences:getLockedComputerUse" as const;
export const IPC_PREFERENCES_SET_LOCKED_COMPUTER_USE =
  "preferences:setLockedComputerUse" as const;
export const IPC_PREFERENCES_GET_SOUND_NOTIFICATIONS =
  "preferences:getSoundNotifications" as const;
export const IPC_PREFERENCES_SET_SOUND_NOTIFICATIONS =
  "preferences:setSoundNotifications" as const;
export const IPC_PREFERENCES_GET_READ_ALOUD =
  "preferences:getReadAloud" as const;
export const IPC_PREFERENCES_SET_READ_ALOUD =
  "preferences:setReadAloud" as const;
export const IPC_PREFERENCES_READ_ALOUD_CHANGED =
  "preferences:readAloudChanged" as const;
export const IPC_PREFERENCES_GET_ONBOARDING_COMPLETED =
  "preferences:getOnboardingCompleted" as const;
export const IPC_PREFERENCES_SET_ONBOARDING_COMPLETED =
  "preferences:setOnboardingCompleted" as const;
export const IPC_GLOBAL_SHORTCUTS_SET_SUSPENDED =
  "globalShortcuts:setSuspended" as const;
export const IPC_GLOBAL_SHORTCUTS_GET_SUSPENDED =
  "globalShortcuts:getSuspended" as const;
export const IPC_DIAGNOSTICS_RECORD_HEAP_TRACE =
  "diagnostics:recordHeapTrace" as const;
export const IPC_DIAGNOSTICS_REPORT_ERROR = "diagnostics:reportError" as const;
export const IPC_DIAGNOSTICS_OPEN_LOGS = "diagnostics:openLogs" as const;
export const IPC_PROMPT_PRESETS_LIST = "promptPresets:list" as const;
export const IPC_PROMPT_PRESETS_READ = "promptPresets:read" as const;
export const IPC_PROMPT_PRESETS_SAVE = "promptPresets:save" as const;
export const IPC_PROMPT_PRESETS_DELETE = "promptPresets:delete" as const;
export const IPC_PROMPT_PRESETS_SELECT = "promptPresets:select" as const;
export const IPC_CUSTOMIZATIONS_RESET = "customizations:reset" as const;
export const IPC_PREFERENCES_GET_WAKE_WORD = "preferences:getWakeWord" as const;
export const IPC_PREFERENCES_SET_WAKE_WORD = "preferences:setWakeWord" as const;
export const IPC_PET_REQUEST_DICTATION = "pet:requestDictation" as const;

export const IPC_PET_DICTATION_ACTIVE = "pet:dictationActive" as const;
export const IPC_BACKUP_GET_STATUS = "backup:getStatus" as const;
export const IPC_BACKUP_RUN_NOW = "backup:runNow" as const;
export const IPC_BACKUP_LIST = "backup:list" as const;
export const IPC_BACKUP_RESTORE = "backup:restore" as const;
export const IPC_LLM_CREDENTIALS_LIST = "llmCredentials:list" as const;
export const IPC_LLM_CREDENTIALS_LIST_OAUTH_PROVIDERS =
  "llmCredentials:listOAuthProviders" as const;
export const IPC_LLM_CREDENTIALS_LIST_OAUTH =
  "llmCredentials:listOAuth" as const;
export const IPC_LLM_CREDENTIALS_LOGIN_OAUTH =
  "llmCredentials:loginOAuth" as const;
export const IPC_LLM_CREDENTIALS_DELETE_OAUTH =
  "llmCredentials:deleteOAuth" as const;
export const IPC_LLM_CREDENTIALS_SAVE = "llmCredentials:save" as const;
export const IPC_LLM_CREDENTIALS_DELETE = "llmCredentials:delete" as const;
export const IPC_APP_RESET_MESSAGES = "app:resetLocalMessages" as const;
export const IPC_CREDENTIAL_REQUEST = "credential:request" as const;
export const IPC_CREDENTIAL_SUBMIT = "credential:submit" as const;
export const IPC_CREDENTIAL_CANCEL = "credential:cancel" as const;

export const IPC_ONBOARDING_SYNTHESIZE =
  "onboarding:synthesizeCoreMemory" as const;

export const IPC_DISCOVERY_CORE_MEMORY_EXISTS =
  "discovery:coreMemoryExists" as const;
export const IPC_DISCOVERY_KNOWLEDGE_EXISTS =
  "discovery:knowledgeExists" as const;
export const IPC_DISCOVERY_COLLECT_BROWSER_DATA =
  "discovery:collectBrowserData" as const;
export const IPC_DISCOVERY_DETECT_PREFERRED_BROWSER =
  "discovery:detectPreferredBrowser" as const;
export const IPC_DISCOVERY_LIST_BROWSER_PROFILES =
  "discovery:listBrowserProfiles" as const;
export const IPC_DISCOVERY_WRITE_CORE_MEMORY =
  "discovery:writeCoreMemory" as const;
export const IPC_DISCOVERY_WRITE_KNOWLEDGE =
  "discovery:writeKnowledge" as const;
export const IPC_DISCOVERY_COLLECT_ALL_SIGNALS =
  "discovery:collectAllSignals" as const;

export const IPC_BROWSER_FETCH_JSON = "browser:fetchJson" as const;
export const IPC_BROWSER_FETCH_TEXT = "browser:fetchText" as const;
export const IPC_BROWSER_BRIDGE_STATUS = "browser:bridgeStatus" as const;

export const IPC_HOME_LIST_RECENT_APPS = "home:listRecentApps" as const;
export const IPC_HOME_GET_ACTIVE_BROWSER_TAB =
  "home:getActiveBrowserTab" as const;
export const IPC_HOME_CAPTURE_APP_WINDOW = "home:captureAppWindow" as const;

export const IPC_MEDIA_SAVE_OUTPUT = "media:saveOutput" as const;
export const IPC_MEDIA_GET_DIR = "media:getStellaMediaDir" as const;
export const IPC_MEDIA_COPY_IMAGE = "media:copyImage" as const;

export const IPC_MEDIA_COPY_ATTACHMENT = "media:copyAttachment" as const;

export const IPC_SCHEDULE_LIST_CRON_JOBS = "schedule:listCronJobs" as const;
export const IPC_SCHEDULE_LIST_HEARTBEATS = "schedule:listHeartbeats" as const;
export const IPC_SCHEDULE_LIST_CONVERSATION_EVENTS =
  "schedule:listConversationEvents" as const;
export const IPC_SCHEDULE_GET_EVENT_COUNT =
  "schedule:getConversationEventCount" as const;
export const IPC_SCHEDULE_UPDATED = "schedule:updated" as const;

export const IPC_SCHEDULE_UPDATE_CRON_JOB =
  "schedule:updateCronJob" as const;
export const IPC_SCHEDULE_REMOVE_CRON_JOB =
  "schedule:removeCronJob" as const;

export const IPC_FASHION_PICK_AND_SAVE_BODY_PHOTO =
  "fashion:pickAndSaveBodyPhoto" as const;
export const IPC_FASHION_GET_BODY_PHOTO_INFO =
  "fashion:getBodyPhotoInfo" as const;
export const IPC_FASHION_GET_BODY_PHOTO_DATA_URL =
  "fashion:getBodyPhotoDataUrl" as const;
export const IPC_FASHION_DELETE_BODY_PHOTO = "fashion:deleteBodyPhoto" as const;
export const IPC_FASHION_START_OUTFIT_BATCH =
  "fashion:startOutfitBatch" as const;
export const IPC_FASHION_START_TRY_ON = "fashion:startTryOn" as const;
export const IPC_FASHION_PICK_TRY_ON_IMAGES =
  "fashion:pickTryOnImages" as const;
export const IPC_FASHION_GET_LOCAL_IMAGE_DATA_URL =
  "fashion:getLocalImageDataUrl" as const;

export const IPC_LOCAL_CHAT_GET_OR_CREATE_ID =
  "localChat:getOrCreateDefaultConversationId" as const;
export const IPC_LOCAL_CHAT_CREATE_NEW_DEFAULT_ID =
  "localChat:createNewDefaultConversationId" as const;
export const IPC_LOCAL_CHAT_LIST_CONVERSATIONS =
  "localChat:listConversations" as const;
export const IPC_LOCAL_CHAT_DELETE_CONVERSATION =
  "localChat:deleteConversation" as const;

export const IPC_LOCAL_CHAT_TRUNCATE_CONVERSATION =
  "localChat:truncateConversation" as const;

export const IPC_LOCAL_CHAT_FORK_CONVERSATION =
  "localChat:forkConversation" as const;
export const IPC_LOCAL_CHAT_LIST_EVENTS = "localChat:listEvents" as const;
export const IPC_LOCAL_CHAT_LIST_MESSAGES = "localChat:listMessages" as const;
export const IPC_LOCAL_CHAT_LIST_MESSAGES_BEFORE =
  "localChat:listMessagesBefore" as const;
export const IPC_LOCAL_CHAT_LIST_SYNC_MESSAGES_BEFORE =
  "localChat:listSyncMessagesBefore" as const;
export const IPC_LOCAL_CHAT_LIST_MESSAGES_AFTER =
  "localChat:listMessagesAfter" as const;
export const IPC_LOCAL_CHAT_LIST_MESSAGE_TOOL_EVENTS =
  "localChat:listMessageToolEvents" as const;
export const IPC_LOCAL_CHAT_LIST_ACTIVITY = "localChat:listActivity" as const;
export const IPC_LOCAL_CHAT_LIST_THREAD_ACTIVITY =
  "localChat:listThreadActivity" as const;
export const IPC_LOCAL_CHAT_LIST_AGENT_THREAD_MESSAGES =
  "localChat:listAgentThreadMessages" as const;
export const IPC_LOCAL_CHAT_LIST_MODEL_USAGE =
  "localChat:listModelUsage" as const;
export const IPC_LOCAL_CHAT_LIST_FILES = "localChat:listFiles" as const;
export const IPC_LOCAL_CHAT_GET_EVENT_COUNT =
  "localChat:getEventCount" as const;
export const IPC_LOCAL_CHAT_PERSIST_WELCOME =
  "localChat:persistDiscoveryWelcome" as const;
export const IPC_LOCAL_CHAT_LIST_SYNC_MESSAGES =
  "localChat:listSyncMessages" as const;
export const IPC_LOCAL_CHAT_SYNC_MESSAGES = "localChat:syncMessages" as const;
export const IPC_LOCAL_CHAT_GET_SYNC_CHECKPOINT =
  "localChat:getSyncCheckpoint" as const;
export const IPC_LOCAL_CHAT_SET_SYNC_CHECKPOINT =
  "localChat:setSyncCheckpoint" as const;
export const IPC_LOCAL_CHAT_UPDATED = "localChat:updated" as const;
export const IPC_LOCAL_CHAT_THREAD_ACTIVITY_UPDATED =
  "localChat:threadActivityUpdated" as const;
export const IPC_LOCAL_CHAT_TASK_DECORATION_UPDATED =
  "localChat:taskDecorationUpdated" as const;

export const IPC_USER_APPS_LIST = "userApps:list" as const;
export const IPC_USER_APPS_START = "userApps:start" as const;
export const IPC_USER_APPS_STOP = "userApps:stop" as const;
export const IPC_USER_APPS_UPDATED = "userApps:updated" as const;

export const IPC_PET_SET_OPEN = "pet:setOpen" as const;
export const IPC_PET_GET_STATE = "pet:getState" as const;

export const IPC_PET_MOVE_WINDOW = "pet:moveWindow" as const;

export const IPC_PET_SET_COMPOSER_ACTIVE = "pet:setComposerActive" as const;

export const IPC_PET_REQUEST_VOICE = "pet:requestVoice" as const;

export const IPC_PET_SET_INTERACTIVE = "pet:setInteractive" as const;
export const IPC_PET_STATUS = "pet:status" as const;
export const IPC_PET_OPEN_CHAT = "pet:openChat" as const;
export const IPC_PET_SEND_MESSAGE = "pet:sendMessage" as const;
