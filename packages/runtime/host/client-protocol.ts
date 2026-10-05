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
  "requestRuntimeRestart",
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
  /** This computer's answer to its own "accept remote work?" prompt. */
  "answerRemoteExecutionRequest",
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
  /**
   * Something tried to dispatch work to this computer and it has not agreed to
   * accept any. Fire and forget: the app raises the question on this machine's
   * own screen and answers later through `answerRemoteExecutionRequest`, so
   * nothing here is waiting on a person.
   */
  "notifyRemoteExecutionRequest",
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

/**
 * Route fencing on the client protocol (after Pi's protocol: the client hello
 * names the server it expects, and every session frame names its attachment).
 *
 * - `runtime.attach` may name the runtime instance the client probed
 *   (`expectedServerId`) and its root; the runtime refuses a mismatch with
 *   `RUNTIME_SERVER_MISMATCH` instead of adopting a client meant for another
 *   instance.
 * - Each attach carries a client-minted `attachmentId`. The runtime binds it
 *   to that connection and stamps every event and host callback it sends there
 *   with it; calls carry it back. A frame whose attachment is not the live one
 *   on either side (a superseded or retired connection, a re-attach) is dropped
 *   and logged rather than applied.
 *
 * All fields are optional on the wire so either side tolerates a peer that
 * predates fencing.
 */
export const RUNTIME_SERVER_MISMATCH = "runtime-server-mismatch";
export const RUNTIME_ATTACHMENT_STALE = "runtime-attachment-stale";

export type RuntimeAttachFence = {
  attachmentId?: string;
  expectedServerId?: string;
  expectedRootHash?: string;
};

export type FencedRuntimeAttachResult = {
  pid: number;
  hostCreated: boolean;
  serverId?: string;
  attachmentId?: string;
};

export type FencedRuntimeEventParams = {
  name: string;
  payload: unknown;
  attachmentId?: string;
};

export type FencedRuntimeHostHandlerParams = {
  name: string;
  args: unknown[];
  attachmentId?: string;
};

export type FencedRuntimeCallParams = {
  method: string;
  args: unknown[];
  attachmentId?: string;
};

const MAX_ATTACHMENT_ID_LENGTH = 128;

/** A well-formed attachment id, or undefined. */
export const readAttachmentId = (value: unknown): string | undefined =>
  typeof value === "string" &&
  value.length > 0 &&
  value.length <= MAX_ATTACHMENT_ID_LENGTH
    ? value
    : undefined;
