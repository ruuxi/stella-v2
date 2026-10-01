/**
 * The host methods a runtime client may call over `runtime.call`, by name.
 * Each takes and returns JSON. Anything else on the host stays internal to
 * the runtime process.
 */
export const RUNTIME_HOST_CALLS = [
  "health",
  "healthCheck",
  "configure",
  "ensureWorkerStarted",
  "getActiveRun",
  "listActiveRuns",
  "listModels",
  "startChat",
  "cancelChat",
  "resumeRunEvents",
  "sendAgentInput",
  "runAutomationTurn",
  "runBlockingLocalAgent",
  "createBackgroundAgent",
  "getLocalAgentSnapshot",
  "appendThreadMessage",
  "persistVoiceTranscript",
  "voiceOrchestratorChat",
  "voiceOrchestratorConfig",
  "voiceExecuteTool",
  "webSearch",
  "voiceWebSearch",
  "runOneShotCompletion",
  "listCronJobs",
  "listHeartbeats",
  "runCronJob",
  "removeCronJob",
  "updateCronJob",
  "upsertHeartbeat",
  "runHeartbeat",
  "listConversationEvents",
  "getConversationEventCount",
  "listProjects",
  "startProject",
  "stopProject",
  "killAllShells",
  "killShellsByPort",
  "collectBrowserData",
  "collectAllSignals",
  "coreMemoryExists",
  "discoveryKnowledgeExists",
  "writeCoreMemory",
  "writeDiscoveryKnowledge",
  "detectPreferredBrowserProfile",
  "listBrowserProfiles",
  "googleWorkspaceGetAuthStatus",
  "googleWorkspaceConnect",
  "googleWorkspaceDisconnect",
] as const;

export type RuntimeHostCall = (typeof RUNTIME_HOST_CALLS)[number];

const callable = new Set<string>(RUNTIME_HOST_CALLS);

export const isRuntimeHostCall = (name: unknown): name is RuntimeHostCall =>
  typeof name === "string" && callable.has(name);

/**
 * The host callbacks a client serves, by name: what the host needs from the
 * app (keychain secrets, prompts, notifications, windows).
 */
export const RUNTIME_HOST_HANDLERS = [
  "getActiveConversationId",
  "getDeviceIdentity",
  "clearSupersededDeviceId",
  "signDeviceInput",
  "requestRuntimeAuthRefresh",
  "getChallengeToken",
  "getScheduleScriptAuth",
  "getAppBrowserContext",
  "requestCredential",
  "requestLlmCredentials",
  "requestConnectorTokenStore",
  "requestConnectorCredential",
  "requestConnectorConnection",
  "cancelConnectorConnection",
  "requestBrowserExtensionConnect",
  "requestComputerUseAppApproval",
  "displayUpdate",
  "showNotification",
  "requestDesktopPermission",
  "spawnAutomationDaemon",
  "openExternal",
  "showWindow",
  "focusWindow",
] as const;

export type RuntimeHostHandler = (typeof RUNTIME_HOST_HANDLERS)[number];

const handlers = new Set<string>(RUNTIME_HOST_HANDLERS);

export const isRuntimeHostHandler = (
  name: unknown,
): name is RuntimeHostHandler => typeof name === "string" && handlers.has(name);
