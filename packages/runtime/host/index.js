import { EventEmitter } from "node:events";
import { existsSync, promises as fs, readFileSync, watch, } from "node:fs";
import path from "node:path";
import { ConvexClient } from "convex/browser";
import { anyApi } from "convex/server";
import { readConfiguredConvexUrl } from "@stella/contracts/convex-urls";
import { resolveBundledRuntimeFile } from "../kernel/shared/runtime-paths.js";
import { getFileLogger } from "../observability/file-logger.js";
import { LocalSchedulerService } from "../kernel/local-scheduler-service.js";
import { createScheduleScriptAuthEnv } from "../kernel/shared/schedule-scripts.js";
import { createRemoteTurnBridge } from "../kernel/remote-turn-bridge.js";
import { getConvexErrorCode, isConvexUnauthenticatedError, shouldStopRemoteTurnForAuthFailure, } from "../kernel/runner/remote-turn-auth.js";
import { AGENT_RECORDER_SEQ_CEILING, AGENT_STREAM_EVENT_TYPES } from "@stella/contracts/agent-runtime";
import { resolveConnectorFollowupAction } from "./connector-followup.js";
import { METHOD_NAMES, NOTIFICATION_NAMES, STELLA_RUNTIME_PROTOCOL_VERSION, } from "@stella/contracts/protocol";
import { createRuntimeUnavailableError, } from "@stella/contracts/protocol/rpc-peer";
import { RuntimeWorkerLifecycleController, } from "./worker-lifecycle.js";
import { buildUdsConnectionFactory, killDetachedWorker, retireDetachedWorkerRoot, } from "./uds-connection.js";
import { buildStdioConnectionFactory } from "./stdio-connection.js";
import { resolveRuntimePaths } from "../worker/runtime-paths.js";
import { computeRuntimeBuildStamp, RUNTIME_BUILD_STAMP_UNAVAILABLE, } from "../worker/runtime-build-stamp.js";
const AGENT_EVENT_BUFFER_LIMIT = 1_000;
const AGENT_EVENT_BUFFER_TTL_MS = 10 * 60 * 1_000;
export { retireDetachedWorkerRoot };
const SYNTHETIC_RUN_EVENT_SEQ_FLOOR = AGENT_RECORDER_SEQ_CEILING;
const parseDisplayUpdateParams = (params) => {
    if (params && typeof params === "object") {
        const record = params;
        if (record.payload && typeof record.payload === "object") {
            return record.payload;
        }
        if (typeof record.kind === "string") {
            return record;
        }
    }
    throw new Error("Invalid host display update payload.");
};
const pruneAgentEventBuffers = (buffers) => {
    const now = Date.now();
    for (const [runId, buffer] of buffers.entries()) {
        if (now - buffer.updatedAt > AGENT_EVENT_BUFFER_TTL_MS) {
            buffers.delete(runId);
        }
    }
};
const bufferAgentEvent = (buffers, event) => {
    const existing = buffers.get(event.runId);
    if (existing) {
        existing.events.push(event);
        if (existing.events.length > AGENT_EVENT_BUFFER_LIMIT) {
            existing.events.splice(0, existing.events.length - AGENT_EVENT_BUFFER_LIMIT);
        }
        existing.updatedAt = Date.now();
        return;
    }
    buffers.set(event.runId, { events: [event], updatedAt: Date.now() });
};

export const isWorkerBusyForRestart = (health) => health != null &&
    (health.activeRun != null ||
        health.activeAgentCount > 0 ||
        health.voiceBusy === true ||
        (health.pendingVoiceRequestCount ?? 0) > 0);
export const shouldAckWorkerRunEvent = (event) => {
    if (!Number.isFinite(event.seq))
        return false;
    if (event.seq >= SYNTHETIC_RUN_EVENT_SEQ_FLOOR)
        return false;
    return event.type !== AGENT_STREAM_EVENT_TYPES.RUN_FINISHED;
};
export class StellaRuntimeHost {
    options;
    workerMode = "detached";
    events = new EventEmitter();
    agentEventBuffers = new Map();
    workerController;
    workerHealthCache = null;
    schedulerService = null;
    schedulerSubscription = null;
    watcher = null;
    reloadTimer = null;
    deferredRuntimeReload = false;

    restartInProgress = false;
    restartRequestedDuringRestart = false;

    pendingStaleWorkerRestart = null;
    staleWorkerQuiescencePollTimer = null;

    workerRestartCheckInFlight = false;
    reloadQueue = Promise.resolve();
    configCache = {};
    deviceIdentity = null;
    workerGeneration = 0;
    started = false;
    hostReady = false;
    hostConvexClient = null;
    hostConvexClientUrl = null;
    hostConvexClientAuthToken = null;
    hostRemoteTurnBridge = null;
    hostRemoteTurnAuthWindowStartedAt = 0;
    hostRemoteTurnUnauthenticatedFailures = 0;
    hostRemoteTurnAuthRecoveryPromise = null;
    pendingRunEventAcks = new Map();
    runEventAckTimer = null;

    connectorTargetsByLocalConversation = new Map();

    localConversationByRequestId = new Map();

    cancelledRequestIds = new Set();
    hostRemoteTurnCancelUnsubscribe = null;
    constructor(options) {
        this.options = options;
        const stellaAppDir = this.options.initializeParams.stellaAppDir;

        this.workerMode = this.options.workerMode === "child" ? "child" : "detached";
        const onWorkerRpcError = (error) => {
            console.error("[runtime-host] worker RPC error:", error);
        };
        const createConnectionAsync = this.workerMode === "child"
            ? buildStdioConnectionFactory({
                ...(process.env.STELLA_BUN_PATH?.trim()
                    ? { bunBinaryPath: process.env.STELLA_BUN_PATH.trim() }
                    : {}),
                onError: onWorkerRpcError,
            })
            : buildUdsConnectionFactory({
                stellaAppDir,
                ...(process.env.STELLA_BUN_PATH?.trim()
                    ? { bunBinaryPath: process.env.STELLA_BUN_PATH.trim() }
                    : {}),
                expectedProtocolVersion: STELLA_RUNTIME_PROTOCOL_VERSION,
                hostExecutablePath: process.execPath,
                onError: onWorkerRpcError,
            });
        this.workerController = new RuntimeWorkerLifecycleController({
            workerEntryPath: resolveDefaultWorkerEntryPath(this.options),
            isHostStarted: () => this.started,

            killWorkerOnStop: this.workerMode === "child"
                ? () => true
                : (reason) => reason === "restart",
            ...(this.workerMode === "child"
                ? {}
                : {
                    killWorker: async () => {
                        await killDetachedWorker(stellaAppDir);
                    },
                }),
            createConnectionAsync,
            initializeConnection: async (connection) => {
                this.registerHostHandlers(connection.peer);
                this.registerNotifications(connection.peer);
                const initializeResult = await connection.peer.request(METHOD_NAMES.INTERNAL_WORKER_INITIALIZE, this.buildWorkerInitializationState());
                if (initializeResult.protocolVersion !== STELLA_RUNTIME_PROTOCOL_VERSION) {
                    throw new Error(`Runtime worker protocol mismatch: host=${STELLA_RUNTIME_PROTOCOL_VERSION} worker=${initializeResult.protocolVersion ?? "unknown"}.`);
                }
                if (Object.keys(this.configCache).length > 0) {
                    await connection.peer.request(METHOD_NAMES.INTERNAL_WORKER_CONFIGURE, this.configCache);
                }
            },
            onConnectionStarted: async (connection) => {
                this.workerGeneration += 1;
                getFileLogger()?.process("host.worker-connected", {
                    pid: connection.pid,
                    generation: this.workerGeneration,
                    attached: connection.attachedToExistingWorker === true,
                });
                this.workerHealthCache = await this.workerController.getHealth({
                    ensureWorker: false,
                });
                try {
                    await this.evaluateWorkerStalenessOnConnect(connection);
                }
                catch (error) {
                    console.warn("[runtime-host] Worker staleness handshake failed:", error.message);
                }
                this.events.emit("runtime-ready", await this.health());
            },
            onUnexpectedExit: async () => {
                getFileLogger()?.error("host.worker-unexpected-exit", {
                    generation: this.workerGeneration,
                });
                this.workerHealthCache = null;
                if (this.started) {
                    this.events.emit("runtime-ready", await this.health());
                }
            },
            onAfterStop: async (reason) => {

                if (reason !== "idle") {
                    getFileLogger()?.process("host.worker-stopped", { reason });
                }
                this.workerHealthCache = null;
                if (this.started) {
                    this.events.emit("runtime-reloading", { reason: `worker-${reason}` });
                    this.events.emit("runtime-ready", await this.health());
                }
            },
            onStateChange: (_state) => {
                if (_state === "idle" && !this.workerController.getConnection()) {
                    this.workerHealthCache = null;
                }
            },
            fetchHealth: async (connection) => {
                const snapshot = await connection.peer.request(METHOD_NAMES.INTERNAL_WORKER_HEALTH);
                this.workerHealthCache = snapshot;
                return snapshot;
            },
        });
    }

    scheduleRuntimeReload() {
        this.deferredRuntimeReload = true;
        if (this.reloadTimer) {
            clearTimeout(this.reloadTimer);
        }
        this.reloadTimer = setTimeout(() => {
            this.reloadTimer = null;
            void this.flushWorkerRestart();
        }, 150);
    }

    getRuntimeControlPaths() {
        return resolveRuntimePaths(this.options.initializeParams.stellaAppDir);
    }
    readWorkerReportedBuildStamp() {
        try {
            const raw = readFileSync(this.getRuntimeControlPaths().buildStampFile, "utf-8").trim();
            return raw || null;
        }
        catch {
            return null;
        }
    }
    hasPersistedPendingWorkerRestart() {
        return existsSync(this.getRuntimeControlPaths().pendingWorkerRestartFile);
    }
    getPendingWorkerRestart() {
        return this.pendingStaleWorkerRestart;
    }
    async markPendingWorkerRestart(reason) {
        if (!this.pendingStaleWorkerRestart) {
            this.pendingStaleWorkerRestart = { reason, detectedAtMs: Date.now() };
        }
        getFileLogger()?.process("host.worker-restart-pending", { reason });
        console.warn(`[runtime-host] Runtime update pending (${reason}); the worker restarts when current work finishes.`);
        try {
            const paths = this.getRuntimeControlPaths();
            await fs.mkdir(paths.rootDir, { recursive: true });
            await fs.writeFile(paths.pendingWorkerRestartFile, JSON.stringify(this.pendingStaleWorkerRestart, null, 2), "utf-8");
        }
        catch (error) {
            console.warn("[runtime-host] Failed to persist pending worker restart flag:", error.message);
        }
        this.startStaleWorkerQuiescencePoll();

        const nudge = setTimeout(() => {
            void this.flushWorkerRestart();
        }, 1_000);
        nudge.unref?.();
        if (this.started) {
            this.events.emit("runtime-ready", await this.health());
        }
    }
    async clearPendingWorkerRestart() {
        this.stopStaleWorkerQuiescencePoll();
        this.pendingStaleWorkerRestart = null;
        await fs
            .unlink(this.getRuntimeControlPaths().pendingWorkerRestartFile)
            .catch(() => undefined);
    }
    startStaleWorkerQuiescencePoll() {
        if (this.staleWorkerQuiescencePollTimer)
            return;

        this.staleWorkerQuiescencePollTimer = setInterval(() => {
            void this.flushWorkerRestart();
        }, 30_000);
        this.staleWorkerQuiescencePollTimer.unref?.();
    }
    stopStaleWorkerQuiescencePoll() {
        if (!this.staleWorkerQuiescencePollTimer)
            return;
        clearInterval(this.staleWorkerQuiescencePollTimer);
        this.staleWorkerQuiescencePollTimer = null;
    }

    async evaluateWorkerStalenessOnConnect(connection) {
        if (this.workerMode === "child") {

            return;
        }
        if (connection.attachedToExistingWorker !== true) {

            await this.clearPendingWorkerRestart();
            return;
        }
        let reason = null;
        if (this.hasPersistedPendingWorkerRestart()) {
            reason = "pending-restart-flag";
        }
        else {
            const workerStamp = this.readWorkerReportedBuildStamp();
            if (!workerStamp) {

                reason = "worker-stamp-missing";
            }
            else {
                const onDiskStamp = computeRuntimeBuildStamp(resolveDefaultWorkerEntryPath(this.options));
                if (onDiskStamp !== RUNTIME_BUILD_STAMP_UNAVAILABLE &&
                    workerStamp !== onDiskStamp) {
                    reason = "build-stamp-mismatch";
                }
            }
        }
        if (!reason) {
            await this.clearPendingWorkerRestart();
            return;
        }
        getFileLogger()?.process("host.worker-stale-detected", {
            reason,
            pid: connection.pid,
        });
        console.warn(`[runtime-host] Reconnected to a stale runtime worker (pid=${connection.pid}, ${reason}).`);

        await this.markPendingWorkerRestart(reason);
    }

    canRestartWorkerNow(health = this.workerHealthCache) {
        return !isWorkerBusyForRestart(health);
    }

    hasPendingWorkerRestartIntent() {
        return this.deferredRuntimeReload || this.pendingStaleWorkerRestart != null;
    }

    async flushWorkerRestart() {
        if (!this.started || !this.hasPendingWorkerRestartIntent())
            return;
        if (this.workerRestartCheckInFlight)
            return;
        this.workerRestartCheckInFlight = true;
        try {
            const health = await this.getWorkerHealth({ ensureWorker: false }).catch(() => null);
            if (!this.canRestartWorkerNow(health))
                return;
            this.executeWorkerRestart();
        }
        finally {
            this.workerRestartCheckInFlight = false;
        }
    }

    executeWorkerRestart() {
        if (this.restartInProgress) {
            this.restartRequestedDuringRestart = true;
            return;
        }
        this.restartInProgress = true;
        this.reloadQueue = this.reloadQueue
            .catch(() => undefined)
            .then(async () => {
            try {
                if (!this.started || !this.hasPendingWorkerRestartIntent())
                    return;
                const health = await this.getWorkerHealth({
                    ensureWorker: false,
                }).catch(() => null);
                if (!this.canRestartWorkerNow(health))
                    return;
                const reason = this.pendingStaleWorkerRestart?.reason ?? "runtime-reload";

                const consumedDeferredRuntimeReload = this.deferredRuntimeReload;
                this.deferredRuntimeReload = false;
                getFileLogger()?.process("host.worker-restart", { reason });
                console.warn(`[runtime-host] Restarting runtime worker (${reason}).`);
                try {
                    await this.restartWorker();
                }
                catch (error) {

                    if (consumedDeferredRuntimeReload) {
                        this.deferredRuntimeReload = true;
                    }
                    throw error;
                }
            }
            finally {
                this.restartInProgress = false;
                if (this.restartRequestedDuringRestart) {
                    this.restartRequestedDuringRestart = false;
                    setTimeout(() => {
                        void this.flushWorkerRestart();
                    }, 0);
                }

                if (this.started) {
                    void this.health().then((snapshot) => {
                        this.events.emit("runtime-ready", snapshot);
                    });
                }
            }
        });
    }
    getConfiguredHostAuthToken() {
        return this.configCache.authToken?.trim() || null;
    }
    getConfiguredHostConvexUrl() {
        return readConfiguredConvexUrl(this.configCache.convexUrl ?? null);
    }
    async getActiveLocalConversationId() {
        const activeConversationId = (await this.options.hostHandlers.getActiveConversationId?.())?.trim() ??
            "";
        return (activeConversationId || (await this.getOrCreateDefaultConversationId()));
    }
    resetHostRemoteTurnAuthTracking() {
        this.hostRemoteTurnAuthWindowStartedAt = Date.now();
        this.hostRemoteTurnUnauthenticatedFailures = 0;
    }
    noteHostRemoteTurnAuthHealthy() {
        this.hostRemoteTurnUnauthenticatedFailures = 0;
    }
    disposeHostConvexClient() {
        const client = this.hostConvexClient;
        this.hostConvexClient = null;
        this.hostConvexClientUrl = null;
        this.hostConvexClientAuthToken = null;
        if (client) {
            void client.close().catch(() => undefined);
        }
    }
    ensureHostConvexClient() {
        const deploymentUrl = this.getConfiguredHostConvexUrl();
        const authToken = this.getConfiguredHostAuthToken();
        if (!deploymentUrl) {
            this.disposeHostConvexClient();
            return null;
        }
        if (this.hostConvexClient &&
            this.hostConvexClientUrl === deploymentUrl &&
            this.hostConvexClientAuthToken === authToken) {
            return this.hostConvexClient;
        }
        this.disposeHostConvexClient();
        const client = new ConvexClient(deploymentUrl, {
            logger: false,
            unsavedChangesWarning: false,
        });
        client.setAuth(async () => this.getConfiguredHostAuthToken());
        this.hostConvexClient = client;
        this.hostConvexClientUrl = deploymentUrl;
        this.hostConvexClientAuthToken = authToken;
        return client;
    }
    handleHostRemoteTurnAuthFailure(source, error) {
        if (!isConvexUnauthenticatedError(error)) {
            return { handled: false, stopped: false };
        }
        this.hostRemoteTurnUnauthenticatedFailures += 1;
        if (!shouldStopRemoteTurnForAuthFailure({
            authWindowStartedAt: this.hostRemoteTurnAuthWindowStartedAt,
            failureCount: this.hostRemoteTurnUnauthenticatedFailures,
            nowMs: Date.now(),
        })) {
            return { handled: true, stopped: false };
        }
        this.stopHostRemoteTurnCancelSubscription();
        this.hostRemoteTurnBridge?.stop();
        this.hostRemoteTurnUnauthenticatedFailures = 0;
        console.warn(`[remote-turn] ${source} auth failed; stopping host remote turn sync until auth changes.`, error);
        return { handled: true, stopped: true };
    }
    async recoverHostRemoteTurnAuth(source) {
        if (!this.options.hostHandlers.requestRuntimeAuthRefresh) {
            return false;
        }
        if (this.hostRemoteTurnAuthRecoveryPromise) {
            return await this.hostRemoteTurnAuthRecoveryPromise;
        }
        this.hostRemoteTurnAuthRecoveryPromise = (async () => {
            try {
                const result = await this.options.hostHandlers.requestRuntimeAuthRefresh?.({
                    source,
                });
                const nextToken = result?.token?.trim() || null;
                const nextHasConnectedAccount = Boolean(result?.hasConnectedAccount);
                await this.configure({
                    authToken: nextToken,
                    hasConnectedAccount: nextHasConnectedAccount,
                });
                if (result?.authenticated && nextToken && nextHasConnectedAccount) {
                    this.noteHostRemoteTurnAuthHealthy();
                    console.info(`[remote-turn] Recovered host auth after ${source} failure.`);
                    return true;
                }
                console.warn(`[remote-turn] Host auth recovery did not restore a usable session after ${source} failure.`);
                return false;
            }
            catch (refreshError) {
                console.warn(`[remote-turn] Failed to refresh host auth after ${source} failure:`, refreshError);
                return false;
            }
            finally {
                this.hostRemoteTurnAuthRecoveryPromise = null;
            }
        })();
        return await this.hostRemoteTurnAuthRecoveryPromise;
    }
    async claimDeviceIdentitySuccession() {
        const previousDeviceId = this.deviceIdentity?.supersededDeviceId;
        const deviceId = this.deviceIdentity?.deviceId;
        if (!previousDeviceId || !deviceId || previousDeviceId === deviceId) {
            return;
        }
        if (this.deviceSuccessionClaimPromise) {
            return await this.deviceSuccessionClaimPromise;
        }
        this.deviceSuccessionClaimPromise = this.runDeviceIdentitySuccessionClaim(previousDeviceId, deviceId);
        try {
            return await this.deviceSuccessionClaimPromise;
        }
        finally {
            this.deviceSuccessionClaimPromise = null;
        }
    }
    async runDeviceIdentitySuccessionClaim(previousDeviceId, deviceId) {
        const client = this.ensureHostConvexClient();
        if (!client) {
            return;
        }
        try {
            await client.mutation(anyApi.device_identity.adoptDeviceIdentitySuccession, {
                previousDeviceId,
                deviceId,
            });
        }
        catch (error) {

            const code = getConvexErrorCode(error);
            if (code !== "CONFLICT" && code !== "INVALID_ARGUMENT") {
                console.warn("[device-identity] Failed to claim device identity succession; will retry.", error);
                return;
            }
        }
        await this.options.hostHandlers.clearSupersededDeviceId?.().catch(() => undefined);
        if (this.deviceIdentity) {
            delete this.deviceIdentity.supersededDeviceId;
        }
    }
    ensureHostRemoteTurnBridge() {
        if (this.hostRemoteTurnBridge || !this.deviceIdentity?.deviceId) {
            return;
        }
        this.hostRemoteTurnBridge = createRemoteTurnBridge({
            deviceId: this.deviceIdentity.deviceId,
            isEnabled: () => this.started && this.hostReady,
            isRunnerBusy: () => false,
            subscribeRemoteTurnRequests: ({ deviceId: targetDeviceId, since, onUpdate, onError, }) => {
                const client = this.ensureHostConvexClient();
                if (!client) {
                    return () => { };
                }
                const subscription = client.onUpdate(anyApi.events.subscribeRemoteTurnRequestsForDevice, {
                    deviceId: targetDeviceId,
                    since,
                    limit: 20,
                }, (events) => {
                    this.noteHostRemoteTurnAuthHealthy();
                    onUpdate(events);
                }, (error) => {
                    const authFailure = this.handleHostRemoteTurnAuthFailure("subscription", error);
                    if (authFailure.stopped) {
                        void this.recoverHostRemoteTurnAuth("subscription");
                        return;
                    }
                    if (authFailure.handled) {
                        return;
                    }
                    onError?.(error);
                });
                return () => {
                    subscription.unsubscribe();
                };
            },
            runLocalTurn: async ({ requestId, conversationId, userPrompt, agentType, modelOverride, provider, externalMessageId, attachments, }) => {
                const localConversationId = this.configCache.cloudSyncEnabled
                    ? conversationId || (await this.getOrCreateDefaultConversationId())
                    : await this.getActiveLocalConversationId();

                this.connectorTargetsByLocalConversation.set(localConversationId, {
                    requestId,
                    backendConversationId: conversationId,
                    initialTurnCompleted: false,
                    pendingFollowupTexts: [],
                });
                this.localConversationByRequestId.set(requestId, localConversationId);

                const connectorUserMessageId = `connector:${requestId}`;
                await this.appendLocalChatEvent({
                    conversationId: localConversationId,
                    type: "user_message",
                    eventId: connectorUserMessageId,
                    payload: {
                        text: userPrompt,
                        source: "connector",
                        ...(provider ? { provider } : {}),
                        ...(attachments?.length ? { attachments } : {}),
                    },
                });
                const result = await this.requestWorker(METHOD_NAMES.INTERNAL_WORKER_RUN_AUTOMATION, {
                    conversationId: localConversationId,
                    userPrompt,
                    userMessageEventId: connectorUserMessageId,
                    ...(agentType ? { agentType } : {}),
                    ...(modelOverride ? { modelOverride } : {}),
                    ...(attachments?.length ? { attachments } : {}),
                    connectorDeliveryTarget: {
                        requestId,
                        conversationId,
                        ...(provider ? { provider } : {}),
                        ...(externalMessageId ? { externalMessageId } : {}),
                    },
                }, {
                    ensureWorker: true,
                    recordActivity: true,
                    retryOnceOnDisconnect: true,
                });
                if (result.status === "ok" && result.finalText) {
                    await this.appendLocalChatEvent({
                        conversationId: localConversationId,
                        type: "assistant_message",
                        payload: { text: result.finalText, source: "connector" },
                    });
                }
                return result;
            },
            claimRemoteTurn: async ({ requestId, conversationId }) => {
                const client = this.ensureHostConvexClient();
                if (!client) {
                    return;
                }
                await client.mutation(anyApi.channels.connector_delivery.claimRemoteTurn, { requestId, conversationId });
            },
            completeConnectorTurn: async ({ requestId, conversationId, text }) => {
                const client = this.ensureHostConvexClient();
                if (!client) {
                    throw new Error("Missing Convex client configuration.");
                }
                await client.mutation(anyApi.channels.connector_delivery.completeRemoteTurn, { requestId, conversationId, text });
                this.markConnectorInitialTurnCompleted({
                    requestId,
                    backendConversationId: conversationId,
                });
            },
            log: (level, message, error) => {
                const logger = level === "error" ? console.error : console.warn;
                if (error === undefined) {
                    logger(message);
                    return;
                }
                logger(message, error);
            },
        });
    }
    async sendConnectorFollowup(args) {
        const client = this.ensureHostConvexClient();
        if (!client) {
            return;
        }
        try {
            await client.mutation(anyApi.channels.connector_delivery.sendConnectorFollowup, {
                requestId: args.requestId,
                conversationId: args.backendConversationId,
                text: args.text,
            });
        }
        catch (error) {
            console.warn("[runtime-host] sendConnectorFollowup failed:", error instanceof Error ? error.message : String(error));
        }
    }
    markConnectorInitialTurnCompleted(args) {
        const localConversationId = this.localConversationByRequestId.get(args.requestId);
        if (!localConversationId) {
            return;
        }
        const target = this.connectorTargetsByLocalConversation.get(localConversationId);
        if (!target ||
            target.requestId !== args.requestId ||
            target.backendConversationId !== args.backendConversationId) {
            return;
        }
        target.initialTurnCompleted = true;
        const pendingTexts = target.pendingFollowupTexts.splice(0);
        for (const text of pendingTexts) {
            void this.sendConnectorFollowup({
                requestId: target.requestId,
                backendConversationId: target.backendConversationId,
                text,
            });
        }
    }
    queueOrSendConnectorFollowup(args) {
        if (!args.target.initialTurnCompleted) {
            args.target.pendingFollowupTexts.push(args.text);
            return;
        }
        void this.sendConnectorFollowup({
            requestId: args.target.requestId,
            backendConversationId: args.target.backendConversationId,
            text: args.text,
        });
    }
    handleLocalChatUpdateForConnectorFollowup(payload) {
        if (!payload)
            return;
        const conversationId = payload.conversationId;
        if (!conversationId || !payload.event)
            return;
        const target = this.connectorTargetsByLocalConversation.get(conversationId);
        if (!target)
            return;
        const action = resolveConnectorFollowupAction(payload);
        switch (action.type) {
            case "clear-target": {

                const cleared = this.connectorTargetsByLocalConversation.get(conversationId);
                this.connectorTargetsByLocalConversation.delete(conversationId);
                if (cleared) {
                    this.localConversationByRequestId.delete(cleared.requestId);
                }
                return;
            }
            case "send":
                this.queueOrSendConnectorFollowup({
                    target,
                    text: action.text,
                });
                return;
            case "ignore":
                return;
        }
    }
    syncHostRemoteTurnBridge() {
        if (!this.started || !this.hostReady) {
            this.stopHostRemoteTurnCancelSubscription();
            this.hostRemoteTurnBridge?.stop();
            this.disposeHostConvexClient();
            return;
        }
        const authToken = this.getConfiguredHostAuthToken();
        const convexUrl = this.getConfiguredHostConvexUrl();
        if (!authToken || !convexUrl) {
            this.stopHostRemoteTurnCancelSubscription();
            this.hostRemoteTurnBridge?.stop();
            this.disposeHostConvexClient();
            return;
        }
        if (!this.configCache.hasConnectedAccount) {
            this.stopHostRemoteTurnCancelSubscription();
            this.hostRemoteTurnBridge?.stop();
            this.disposeHostConvexClient();
            return;
        }
        this.ensureHostRemoteTurnBridge();
        if (!this.hostRemoteTurnBridge) {
            return;
        }
        this.resetHostRemoteTurnAuthTracking();
        void this.claimDeviceIdentitySuccession();
        this.hostRemoteTurnBridge.start();
        this.hostRemoteTurnBridge.kick();
        this.ensureHostRemoteTurnCancelSubscription();
    }

    ensureHostRemoteTurnCancelSubscription() {
        if (this.hostRemoteTurnCancelUnsubscribe)
            return;
        const deviceId = this.deviceIdentity?.deviceId;
        if (!deviceId)
            return;
        const client = this.ensureHostConvexClient();
        if (!client)
            return;
        const subscription = client.onUpdate(anyApi.events.subscribeRemoteTurnCancelsForDevice, {
            deviceId,
            since: Date.now() - 5 * 60_000,
            limit: 50,
        }, (rows) => {
            if (!Array.isArray(rows))
                return;
            for (const row of rows) {
                const requestId = typeof row?.requestId === "string" ? row.requestId : "";
                if (!requestId || this.cancelledRequestIds.has(requestId))
                    continue;
                this.cancelledRequestIds.add(requestId);
                const localConversationId = this.localConversationByRequestId.get(requestId);
                if (!localConversationId)
                    continue;
                void this.cancelChatByConversation(localConversationId).catch((error) => {
                    console.warn("[runtime-host] cancelChatByConversation failed:", error instanceof Error ? error.message : String(error));
                });
            }
        }, (error) => {
            console.warn("[runtime-host] Remote turn cancel subscription failed:", error.message);
        });
        this.hostRemoteTurnCancelUnsubscribe = () => {
            subscription.unsubscribe();
        };
    }
    stopHostRemoteTurnCancelSubscription() {
        if (!this.hostRemoteTurnCancelUnsubscribe)
            return;
        try {
            this.hostRemoteTurnCancelUnsubscribe();
        }
        catch {

        }
        this.hostRemoteTurnCancelUnsubscribe = null;
    }
    on(eventName, listener) {
        this.events.on(eventName, listener);
        return () => {
            this.events.removeListener(eventName, listener);
        };
    }
    async start() {
        if (this.started)
            return;
        this.started = true;
        await this.initializeHostServices();
        this.syncHostRemoteTurnBridge();
        this.events.emit("runtime-connected", undefined);
        this.events.emit("runtime-ready", await this.health());
        this.startDevWatcher(resolveDefaultWorkerEntryPath(this.options));
    }
    async stop(options) {
        this.started = false;
        this.hostReady = false;
        this.workerHealthCache = null;
        this.workerGeneration = 0;
        this.agentEventBuffers.clear();
        this.pendingRunEventAcks.clear();
        if (this.runEventAckTimer)
            clearTimeout(this.runEventAckTimer);
        this.runEventAckTimer = null;
        this.deferredRuntimeReload = false;
        this.restartInProgress = false;
        this.restartRequestedDuringRestart = false;

        this.pendingStaleWorkerRestart = null;
        this.stopStaleWorkerQuiescencePoll();
        if (this.reloadTimer)
            clearTimeout(this.reloadTimer);
        this.reloadTimer = null;
        this.watcher?.close();
        this.watcher = null;
        await this.workerController.stop(options?.killWorker ? "restart" : "stopped");
        await this.stopHostServices();
        this.deviceIdentity = null;
        this.configCache = {};
        this.events.emit("runtime-disconnected", { reason: "stopped" });
    }
    async configure(params) {
        this.configCache = { ...this.configCache, ...params };
        this.syncHostRemoteTurnBridge();
        const connection = this.workerController.getConnection();
        if (!connection?.peer) {
            return { ok: true };
        }
        return await connection.peer.request(METHOD_NAMES.INTERNAL_WORKER_CONFIGURE, params);
    }
    async health() {
        return await this.buildHealthSnapshot();
    }
    async restartWorker() {
        const startedAt = Date.now();
        this.events.emit("runtime-reloading", { reason: "worker-restart" });
        await this.workerController.stop("restart");
        const stoppedAt = Date.now();
        await this.workerController.ensureStarted();
        const readyAt = Date.now();

        getFileLogger()?.process("host.worker-restart-latency", {
            stopMs: stoppedAt - startedAt,
            startMs: readyAt - stoppedAt,
            totalMs: readyAt - startedAt,
            generation: this.workerGeneration,
        });
        return { ok: true };
    }

    async ensureWorkerStarted() {
        await this.workerController.ensureStarted();
        return { ok: true };
    }
    async healthCheck() {
        const health = await this.getWorkerHealth({ ensureWorker: false });
        return health?.health ?? null;
    }
    async getActiveRun() {
        const health = await this.getWorkerHealth({ ensureWorker: false });
        return health?.activeRun ?? null;
    }
    async listActiveRuns() {
        try {
            return await this.requestWorker(METHOD_NAMES.INTERNAL_WORKER_LIST_ACTIVE_RUNS, {}, { ensureWorker: false, recordActivity: false });
        }
        catch {
            return { runs: [] };
        }
    }
    async listModels(request = {}) {
        return await this.requestWorker(METHOD_NAMES.INTERNAL_WORKER_LIST_MODELS, request, { ensureWorker: true, recordActivity: false });
    }
    async startChat(payload) {
        return await this.requestWorker(METHOD_NAMES.INTERNAL_WORKER_START_CHAT, payload, {
            ensureWorker: true,
            recordActivity: true,
        });
    }
    async sendAgentInput(payload) {
        return await this.requestWorker(METHOD_NAMES.INTERNAL_WORKER_SEND_AGENT_INPUT, payload, {
            ensureWorker: true,
            recordActivity: true,
        });
    }
    async cancelChat(runId) {
        return await this.requestWorker(METHOD_NAMES.INTERNAL_WORKER_CANCEL, { runId }, { ensureWorker: false, recordActivity: true });
    }
    async cancelChatByConversation(conversationId) {
        return await this.requestWorker(METHOD_NAMES.INTERNAL_WORKER_CANCEL_BY_CONVERSATION, { conversationId }, { ensureWorker: false, recordActivity: true });
    }
    async resumeRunEvents(payload) {
        pruneAgentEventBuffers(this.agentEventBuffers);

        const buffer = this.agentEventBuffers.get(payload.runId);
        if (buffer) {
            const oldestSeq = buffer.events[0]?.seq ?? null;
            const events = buffer.events.filter((event) => event.seq > payload.lastSeq);
            const exhausted = oldestSeq !== null && payload.lastSeq < oldestSeq - 1;
            if (events.length > 0 || !exhausted) {
                return { events, exhausted };
            }
        }

        try {
            const remote = await this.requestWorker(METHOD_NAMES.INTERNAL_WORKER_RESUME_EVENTS, { runId: payload.runId, lastSeq: payload.lastSeq }, { ensureWorker: false, recordActivity: false });
            return remote;
        }
        catch {
            return { events: [], exhausted: true };
        }
    }

    flushRunEventAcks() {
        if (this.runEventAckTimer) {
            clearTimeout(this.runEventAckTimer);
            this.runEventAckTimer = null;
        }
        const pending = this.pendingRunEventAcks;
        if (pending.size === 0)
            return;
        this.pendingRunEventAcks = new Map();
        for (const [runId, lastSeq] of pending) {
            void this.requestWorker(METHOD_NAMES.INTERNAL_WORKER_ACK_EVENTS, { runId, lastSeq }, { ensureWorker: false, recordActivity: false }).catch(() => undefined);
        }
    }
    scheduleRunEventAck(runId, lastSeq) {
        if (!runId || !Number.isFinite(lastSeq))
            return;
        const previous = this.pendingRunEventAcks.get(runId) ?? 0;
        this.pendingRunEventAcks.set(runId, Math.max(previous, lastSeq));
        if (this.runEventAckTimer)
            return;
        this.runEventAckTimer = setTimeout(() => {
            this.flushRunEventAcks();
        }, 150);
        this.runEventAckTimer.unref?.();
    }
    async runAutomationTurn(payload) {
        return await this.requestWorker(METHOD_NAMES.INTERNAL_WORKER_RUN_AUTOMATION, payload, {
            ensureWorker: true,
            recordActivity: true,
        });
    }
    async runBlockingLocalAgent(payload) {
        return await this.requestWorker(METHOD_NAMES.INTERNAL_WORKER_RUN_BLOCKING_AGENT, payload, {
            ensureWorker: true,
            recordActivity: true,
        });
    }
    async createBackgroundAgent(payload) {
        return await this.requestWorker(METHOD_NAMES.INTERNAL_WORKER_CREATE_BACKGROUND_AGENT, payload, {
            ensureWorker: true,
            recordActivity: true,
        });
    }
    async getLocalAgentSnapshot(agentId) {
        return await this.requestWorker(METHOD_NAMES.INTERNAL_WORKER_GET_AGENT_SNAPSHOT, { agentId }, { ensureWorker: false, recordActivity: false });
    }
    async appendThreadMessage(args) {
        return await this.requestWorker(METHOD_NAMES.INTERNAL_WORKER_APPEND_THREAD_MESSAGE, args, {
            ensureWorker: true,
            recordActivity: true,
        });
    }
    async webSearch(query, options) {
        return await this.requestWorker(METHOD_NAMES.INTERNAL_WORKER_WEB_SEARCH, { query, ...options }, {
            ensureWorker: true,
            recordActivity: true,
        });
    }
    async runOneShotCompletion(payload) {
        return await this.requestWorker(METHOD_NAMES.INTERNAL_WORKER_ONE_SHOT_COMPLETION, payload, {
            ensureWorker: true,
            recordActivity: true,
        });
    }
    async persistVoiceTranscript(payload) {
        return await this.requestWorker(METHOD_NAMES.INTERNAL_WORKER_VOICE_PERSIST_TRANSCRIPT, payload, {
            ensureWorker: true,
            recordActivity: true,
        });
    }
    async voiceOrchestratorChat(payload) {
        return await this.requestWorker(METHOD_NAMES.INTERNAL_WORKER_VOICE_ORCHESTRATOR_CHAT, payload, {
            ensureWorker: true,
            recordActivity: true,
        });
    }
    async voiceOrchestratorConfig(payload) {
        return await this.requestWorker(METHOD_NAMES.INTERNAL_WORKER_VOICE_ORCHESTRATOR_CONFIG, payload, {
            ensureWorker: true,
            recordActivity: true,
        });
    }
    async voiceExecuteTool(payload) {
        return await this.requestWorker(METHOD_NAMES.INTERNAL_WORKER_VOICE_EXECUTE_TOOL, payload, {
            ensureWorker: true,
            recordActivity: true,
        });
    }
    async voiceWebSearch(payload) {
        return await this.requestWorker(METHOD_NAMES.INTERNAL_WORKER_VOICE_WEB_SEARCH, payload, {
            ensureWorker: true,
            recordActivity: true,
        });
    }
    async getOrCreateDefaultConversationId() {
        return await this.requestWorker(METHOD_NAMES.INTERNAL_WORKER_LOCAL_CHAT_GET_OR_CREATE_DEFAULT, undefined, { ensureWorker: true, recordActivity: false });
    }
    async listLocalChatEvents(payload) {
        return await this.requestWorker(METHOD_NAMES.INTERNAL_WORKER_LOCAL_CHAT_LIST_EVENTS, payload, { ensureWorker: true, recordActivity: false });
    }
    async getLocalChatEventCount(payload) {
        return await this.requestWorker(METHOD_NAMES.INTERNAL_WORKER_LOCAL_CHAT_GET_EVENT_COUNT, payload, { ensureWorker: true, recordActivity: false });
    }
    async persistDiscoveryWelcome(payload) {
        return await this.requestWorker(METHOD_NAMES.INTERNAL_WORKER_LOCAL_CHAT_PERSIST_DISCOVERY_WELCOME, payload, { ensureWorker: true, recordActivity: true });
    }
    async listLocalChatSyncMessages(payload) {
        return await this.requestWorker(METHOD_NAMES.INTERNAL_WORKER_LOCAL_CHAT_LIST_SYNC_MESSAGES, payload, { ensureWorker: true, recordActivity: false });
    }
    async getLocalChatSyncCheckpoint(payload) {
        return await this.requestWorker(METHOD_NAMES.INTERNAL_WORKER_LOCAL_CHAT_GET_SYNC_CHECKPOINT, payload, { ensureWorker: true, recordActivity: false });
    }
    async setLocalChatSyncCheckpoint(payload) {
        return await this.requestWorker(METHOD_NAMES.INTERNAL_WORKER_LOCAL_CHAT_SET_SYNC_CHECKPOINT, payload, { ensureWorker: true, recordActivity: false });
    }
    async listCronJobs() {
        return this.ensureScheduler().listCronJobs();
    }
    async listHeartbeats() {
        return this.ensureScheduler().listHeartbeats();
    }

    async runCronJob(jobId) {
        return this.ensureScheduler().runCronJob(jobId);
    }
    async removeCronJob(jobId) {
        return this.ensureScheduler().removeCronJob(jobId);
    }
    async updateCronJob(jobId, patch) {
        return this.ensureScheduler().updateCronJob(jobId, patch);
    }
    async upsertHeartbeat(input) {
        return this.ensureScheduler().upsertHeartbeat(input);
    }
    async runHeartbeat(conversationId) {
        return this.ensureScheduler().runHeartbeat(conversationId);
    }
    async listConversationEvents(payload) {
        return this.ensureScheduler().listConversationEvents(payload.conversationId, payload.maxItems);
    }
    async getConversationEventCount(payload) {
        return this.ensureScheduler().getConversationEventCount(payload.conversationId);
    }
    async listProjects() {
        return await this.requestWorker(METHOD_NAMES.INTERNAL_WORKER_PROJECTS_LIST, undefined, { ensureWorker: true, recordActivity: false });
    }
    async startProject(slug) {
        return await this.requestWorker(METHOD_NAMES.INTERNAL_WORKER_PROJECTS_START, { slug }, { ensureWorker: true, recordActivity: true });
    }
    async stopProject(slug) {
        return await this.requestWorker(METHOD_NAMES.INTERNAL_WORKER_PROJECTS_STOP, { slug }, { ensureWorker: true, recordActivity: true });
    }
    async killAllShells() {
        return await this.requestWorker(METHOD_NAMES.INTERNAL_WORKER_KILL_ALL_SHELLS, undefined, { ensureWorker: false, recordActivity: true });
    }
    async killShellsByPort(port) {
        return await this.requestWorker(METHOD_NAMES.INTERNAL_WORKER_KILL_SHELL_BY_PORT, { port }, { ensureWorker: false, recordActivity: true });
    }
    async collectBrowserData(options) {
        return await this.requestWorker(METHOD_NAMES.INTERNAL_WORKER_DISCOVERY_COLLECT_BROWSER_DATA, options, { ensureWorker: true, recordActivity: false });
    }
    async collectAllSignals(options) {
        return await this.requestWorker(METHOD_NAMES.INTERNAL_WORKER_DISCOVERY_COLLECT_ALL_SIGNALS, options, { ensureWorker: true, recordActivity: false });
    }
    async coreMemoryExists() {
        const { coreMemoryExists } = await import("../discovery/browser-data.js");
        return await coreMemoryExists(this.options.initializeParams.stellaDataDirPath);
    }
    async discoveryKnowledgeExists() {
        const { discoveryKnowledgeExists } = await import("../discovery/life-knowledge.js");
        return await discoveryKnowledgeExists(this.options.initializeParams.stellaDataDirPath);
    }
    async writeCoreMemory(content, options) {
        const { writeCoreMemory } = await import("../discovery/browser-data.js");
        await writeCoreMemory(this.options.initializeParams.stellaDataDirPath, content, options);
    }
    async writeDiscoveryKnowledge(payload) {
        const { writeDiscoveryKnowledge } = await import("../discovery/life-knowledge.js");
        await writeDiscoveryKnowledge(this.options.initializeParams.stellaDataDirPath, payload);
    }
    async detectPreferredBrowserProfile() {
        const { detectPreferredBrowserProfile } = await import("../discovery/browser-data.js");
        return await detectPreferredBrowserProfile();
    }
    async listBrowserProfiles(browserType) {
        const { listBrowserProfiles } = await import("../discovery/browser-data.js");
        return await listBrowserProfiles(browserType);
    }
    ensureScheduler() {
        if (!this.schedulerService) {
            throw createRuntimeUnavailableError("Local scheduler is not available.");
        }
        return this.schedulerService;
    }
    async appendLocalChatEvent(payload) {
        await this.requestWorker(METHOD_NAMES.INTERNAL_WORKER_LOCAL_CHAT_APPEND_EVENT, payload, { ensureWorker: true, recordActivity: true });
        this.events.emit("local-chat-updated", null);
    }
    async initializeHostServices() {
        await this.stopHostServices();
        this.deviceIdentity = await this.options.hostHandlers.getDeviceIdentity();
        this.ensureHostRemoteTurnBridge();
        if (this.options.disableLocalScheduler) {

            this.hostReady = true;
            return;
        }
        const showNotificationHandler = this.options.hostHandlers.showNotification;
        const scheduler = new LocalSchedulerService({
            stellaDataDir: this.options.initializeParams.stellaDataDirPath,
            getScriptAuthEnv: async () => {
                const auth = await this.options.hostHandlers.getScheduleScriptAuth?.();
                return createScheduleScriptAuthEnv(auth);
            },
            runnerTarget: {
                getRunner: () => ({
                    runAutomationTurn: async (payload) => await this.requestWorker(METHOD_NAMES.INTERNAL_WORKER_RUN_AUTOMATION, payload, {
                        ensureWorker: true,
                        recordActivity: true,
                    }),
                    getActiveOrchestratorRun: async () => await this.getActiveRun(),
                }),
            },

            ...(showNotificationHandler
                ? {
                    showNotification: ({ title, body }) => {
                        void showNotificationHandler({ title, body });
                    },
                }
                : {}),
        });
        scheduler.start();
        this.schedulerService = scheduler;
        this.schedulerSubscription = scheduler.subscribe(() => {
            this.events.emit("schedule-updated", undefined);
        });
        this.hostReady = true;
    }
    async stopHostServices() {
        this.stopHostRemoteTurnCancelSubscription();
        this.hostRemoteTurnBridge?.stop();
        this.hostRemoteTurnBridge = null;
        this.disposeHostConvexClient();
        this.hostRemoteTurnAuthWindowStartedAt = 0;
        this.hostRemoteTurnUnauthenticatedFailures = 0;
        this.hostRemoteTurnAuthRecoveryPromise = null;
        this.schedulerSubscription?.();
        this.schedulerSubscription = null;
        this.schedulerService?.stop();
        this.schedulerService = null;
    }
    async googleWorkspaceGetAuthStatus() {
        return await this.requestWorker(METHOD_NAMES.INTERNAL_WORKER_GOOGLE_WORKSPACE_AUTH_STATUS, undefined, {
            ensureWorker: true,
            recordActivity: false,
        });
    }
    async googleWorkspaceConnect() {
        return await this.requestWorker(METHOD_NAMES.INTERNAL_WORKER_GOOGLE_WORKSPACE_CONNECT, undefined, {
            ensureWorker: true,
            recordActivity: true,
            retryOnceOnDisconnect: true,
        });
    }
    async googleWorkspaceDisconnect() {
        return await this.requestWorker(METHOD_NAMES.INTERNAL_WORKER_GOOGLE_WORKSPACE_DISCONNECT, undefined, { ensureWorker: true, recordActivity: true });
    }
    buildWorkerInitializationState() {
        return {
            protocolVersion: STELLA_RUNTIME_PROTOCOL_VERSION,
            stellaAppDir: this.options.initializeParams.stellaAppDir,
            stellaDataDirPath: this.options.initializeParams.stellaDataDirPath,
            stellaWorkspacePath: this.options.initializeParams.stellaWorkspacePath,
            authToken: this.configCache.authToken ?? null,
            convexUrl: this.configCache.convexUrl ?? null,
            convexSiteUrl: this.configCache.convexSiteUrl ?? null,
            hasConnectedAccount: this.configCache.hasConnectedAccount ?? false,
            cloudSyncEnabled: this.configCache.cloudSyncEnabled ?? false,
            modelCatalogUpdatedAt: this.configCache.modelCatalogUpdatedAt ?? null,
            localLlmCredentialsUpdatedAt: this.configCache.localLlmCredentialsUpdatedAt ?? null,
        };
    }
    async requestWorker(method, params, options) {
        return await this.workerController.request(async (peer) => {
            const result = await peer.request(method, params);
            this.workerHealthCache = null;
            return result;
        }, options);
    }
    async getWorkerHealth(args) {
        return await this.workerController.getHealth(args);
    }
    async buildHealthSnapshot() {
        const workerHealth = await this.getWorkerHealth({
            ensureWorker: false,
        }).catch(() => null);
        return {
            ready: this.hostReady,
            hostPid: process.pid,
            workerPid: workerHealth?.pid ?? null,
            workerRunning: this.workerController.getState() === "running" ||
                this.workerController.getState() === "starting",
            workerGeneration: this.workerGeneration,
            deviceId: workerHealth?.deviceId ?? this.deviceIdentity?.deviceId ?? null,
            ...(this.hasPendingWorkerRestartIntent() || this.restartInProgress
                ? { pendingWorkerRestart: true }
                : {}),
            activeRunId: workerHealth?.activeRun?.runId ?? null,
            activeAgentCount: workerHealth?.activeAgentCount ?? 0,
        };
    }
    registerHostHandlers(peer) {
        peer.registerRequestHandler(METHOD_NAMES.HOST_DEVICE_IDENTITY_GET, async () => {
            if (!this.deviceIdentity) {
                this.deviceIdentity =
                    await this.options.hostHandlers.getDeviceIdentity();
            }
            return this.deviceIdentity;
        });
        peer.registerRequestHandler(METHOD_NAMES.HOST_RUNTIME_AUTH_REFRESH, async (params) => {
            return ((await this.options.hostHandlers.requestRuntimeAuthRefresh?.(params)) ?? {
                authenticated: false,
                token: null,
                hasConnectedAccount: false,
            });
        });
        peer.registerRequestHandler(METHOD_NAMES.HOST_APP_BROWSER_CONTEXT_GET, async () => {
            return ((await this.options.hostHandlers.getAppBrowserContext?.()) ?? {
                apps: [],
                activeBrowserTab: null,
            });
        });
        peer.registerRequestHandler(METHOD_NAMES.HOST_CREDENTIALS_REQUEST, async (params) => {
            return await this.options.hostHandlers.requestCredential(params);
        });
        peer.registerRequestHandler(METHOD_NAMES.HOST_LLM_CREDENTIALS_REQUEST, async (params) => {
            if (!this.options.hostHandlers.requestLlmCredentials) {
                return { ok: false, reason: "unsupported" };
            }
            return await this.options.hostHandlers.requestLlmCredentials(params);
        });
        peer.registerRequestHandler(METHOD_NAMES.HOST_CONNECTOR_TOKEN_STORE_REQUEST, async (params) => {
            if (!this.options.hostHandlers.requestConnectorTokenStore) {
                return { ok: false, reason: "unsupported" };
            }
            return await this.options.hostHandlers.requestConnectorTokenStore(params);
        });
        peer.registerRequestHandler(METHOD_NAMES.HOST_CONNECTOR_CREDENTIAL_REQUEST, async (params) => {
            if (!this.options.hostHandlers.requestConnectorCredential) {
                return { ok: false, reason: "unsupported" };
            }
            return await this.options.hostHandlers.requestConnectorCredential(params);
        });
        peer.registerRequestHandler(METHOD_NAMES.HOST_CONNECTOR_CONNECT_REQUEST, async (params) => {
            if (!this.options.hostHandlers.requestConnectorConnection) {
                return { ok: false, reason: "unsupported" };
            }
            return await this.options.hostHandlers.requestConnectorConnection(params);
        });
        peer.registerRequestHandler(METHOD_NAMES.HOST_CONNECTOR_CONNECT_CANCEL, async (params) => {
            if (!this.options.hostHandlers.cancelConnectorConnection) {
                return { ok: false };
            }
            const offerId = params && typeof params === "object"
                ? String(params.offerId ?? "")
                : "";
            if (!offerId)
                return { ok: false };
            return await this.options.hostHandlers.cancelConnectorConnection({
                offerId,
            });
        });
        peer.registerRequestHandler(METHOD_NAMES.HOST_LINK_WALLET_CONNECT_REQUEST, async (params) => {
            if (!this.options.hostHandlers.requestLinkWalletConnection) {
                return { ok: false, reason: "unsupported" };
            }
            return await this.options.hostHandlers.requestLinkWalletConnection(params);
        });
        peer.registerRequestHandler(METHOD_NAMES.HOST_LINK_WALLET_CONNECT_CANCEL, async (params) => {
            if (!this.options.hostHandlers.cancelLinkWalletConnection) {
                return { ok: false };
            }
            const offerId = params && typeof params === "object"
                ? String(params.offerId ?? "")
                : "";
            if (!offerId)
                return { ok: false };
            return await this.options.hostHandlers.cancelLinkWalletConnection({
                offerId,
            });
        });
        peer.registerRequestHandler(METHOD_NAMES.HOST_LINK_WALLET_SPEND_NOTIFY, async (params) => {
            const payload = params && typeof params === "object" ? params : {};
            this.options.hostHandlers.notifyLinkSpendApproval?.({
                merchantName: typeof payload.merchantName === "string" ? payload.merchantName : undefined,
                amountCents: typeof payload.amountCents === "number" ? payload.amountCents : undefined,
                conversationId: typeof payload.conversationId === "string" ? payload.conversationId : undefined,
            });
            return { ok: true };
        });
        peer.registerRequestHandler(METHOD_NAMES.HOST_BROWSER_EXTENSION_CONNECT_REQUEST, async (params) => {
            if (!this.options.hostHandlers.requestBrowserExtensionConnect) {
                return { ok: false, reason: "unsupported" };
            }
            return await this.options.hostHandlers.requestBrowserExtensionConnect(params);
        });
        peer.registerRequestHandler(METHOD_NAMES.HOST_COMPUTER_USE_APP_APPROVAL_REQUEST, async (params) => {

            void params;
            if (this.options.hostHandlers.requestComputerUseAppApproval) {
                return await this.options.hostHandlers.requestComputerUseAppApproval(params);
            }
            return { decision: "approved", scope: "session" };
        });
        peer.registerRequestHandler(METHOD_NAMES.HOST_DISPLAY_UPDATE, async (params) => {
            await this.options.hostHandlers.displayUpdate(parseDisplayUpdateParams(params));
            return { ok: true };
        });
        peer.registerRequestHandler(METHOD_NAMES.HOST_NOTIFICATION_SHOW, async (params) => {
            await this.options.hostHandlers.showNotification?.(params);
            return { ok: true };
        });
        peer.registerRequestHandler(METHOD_NAMES.HOST_SYSTEM_REQUEST_PERMISSION, async (params) => {
            const kind = String(params ?? "");
            if (kind !== "accessibility" && kind !== "screen") {
                return {
                    granted: false,
                    alreadyGranted: false,
                    reason: "unsupported",
                };
            }
            if (!this.options.hostHandlers.requestDesktopPermission) {
                return {
                    granted: false,
                    alreadyGranted: false,
                    reason: "unsupported",
                };
            }
            return await this.options.hostHandlers.requestDesktopPermission(kind);
        });
        peer.registerRequestHandler(METHOD_NAMES.HOST_COMPUTER_USE_SPAWN_AUTOMATION_DAEMON, async (params) => {
            if (!this.options.hostHandlers.spawnAutomationDaemon) {
                return { ok: false, reason: "unsupported" };
            }
            return await this.options.hostHandlers.spawnAutomationDaemon(params && typeof params === "object" ? params : {});
        });
        peer.registerRequestHandler(METHOD_NAMES.HOST_SYSTEM_OPEN_EXTERNAL, async (params) => {
            await this.options.hostHandlers.openExternal?.(String(params ?? ""));
            return { ok: true };
        });
        peer.registerRequestHandler(METHOD_NAMES.HOST_WINDOW_SHOW, async () => {
            await this.options.hostHandlers.showWindow?.();
            return { ok: true };
        });
        peer.registerRequestHandler(METHOD_NAMES.HOST_WINDOW_FOCUS, async () => {
            await this.options.hostHandlers.focusWindow?.();
            return { ok: true };
        });
        peer.registerRequestHandler(METHOD_NAMES.INTERNAL_SCHEDULE_LIST_CRON_JOBS, async () => await this.listCronJobs());
        peer.registerRequestHandler(METHOD_NAMES.INTERNAL_SCHEDULE_LIST_HEARTBEATS, async () => await this.listHeartbeats());
        peer.registerRequestHandler(METHOD_NAMES.INTERNAL_SCHEDULE_ADD_CRON_JOB, async (params) => await this.ensureScheduler().addCronJob(params));
        peer.registerRequestHandler(METHOD_NAMES.INTERNAL_SCHEDULE_UPDATE_CRON_JOB, async (params) => {
            const payload = params;
            return await this.ensureScheduler().updateCronJob(payload.jobId, payload.patch);
        });
        peer.registerRequestHandler(METHOD_NAMES.INTERNAL_SCHEDULE_REMOVE_CRON_JOB, async (params) => await this.ensureScheduler().removeCronJob(params.jobId));
        peer.registerRequestHandler(METHOD_NAMES.INTERNAL_SCHEDULE_RUN_CRON_JOB, async (params) => await this.ensureScheduler().runCronJob(params.jobId));
        peer.registerRequestHandler(METHOD_NAMES.INTERNAL_SCHEDULE_GET_HEARTBEAT_CONFIG, async (params) => await this.ensureScheduler().getHeartbeatConfig(params.conversationId));
        peer.registerRequestHandler(METHOD_NAMES.INTERNAL_SCHEDULE_UPSERT_HEARTBEAT, async (params) => await this.ensureScheduler().upsertHeartbeat(params));
        peer.registerRequestHandler(METHOD_NAMES.INTERNAL_SCHEDULE_RUN_HEARTBEAT, async (params) => await this.ensureScheduler().runHeartbeat(params.conversationId));
    }
    registerNotifications(peer) {
        peer.registerNotificationHandler(NOTIFICATION_NAMES.RUNTIME_READY, (params) => {
            this.events.emit("runtime-ready", params);
        });
        peer.registerNotificationHandler(NOTIFICATION_NAMES.RUNTIME_RELOADING, (params) => {
            this.events.emit("runtime-reloading", params);
        });
        peer.registerNotificationHandler(NOTIFICATION_NAMES.RUNTIME_LAGGED, (params) => {
            this.events.emit("runtime-lagged", params);
        });
        peer.registerNotificationHandler(NOTIFICATION_NAMES.RUN_EVENT, (params) => {
            const payload = params;
            bufferAgentEvent(this.agentEventBuffers, payload);
            pruneAgentEventBuffers(this.agentEventBuffers);
            this.events.emit("run-event", payload);

            if (payload.runId && shouldAckWorkerRunEvent(payload)) {
                this.scheduleRunEventAck(payload.runId, payload.seq);
            }
            if (payload.type === AGENT_STREAM_EVENT_TYPES.RUN_FINISHED) {
                if (this.hasPendingWorkerRestartIntent()) {

                    const timer = setTimeout(() => {
                        void this.flushWorkerRestart();
                    }, 500);
                    timer.unref?.();
                }
            }
        });
        peer.registerNotificationHandler(NOTIFICATION_NAMES.VOICE_AGENT_EVENT, (params) => {
            this.events.emit("voice-agent-event", params);
        });
        peer.registerNotificationHandler(NOTIFICATION_NAMES.LOCAL_CHAT_UPDATED, (params) => {
            const payload = params;
            this.handleLocalChatUpdateForConnectorFollowup(payload);
            this.events.emit("local-chat-updated", payload);
        });
        peer.registerNotificationHandler(NOTIFICATION_NAMES.THREAD_ACTIVITY_UPDATED, (params) => {
            this.events.emit("thread-activity-updated", params);
        });
        peer.registerNotificationHandler(NOTIFICATION_NAMES.SCHEDULE_UPDATED, () => {
            this.events.emit("schedule-updated", undefined);
        });
        peer.registerNotificationHandler(NOTIFICATION_NAMES.MODEL_CATALOG_UPDATED, (params) => {
            this.events.emit("model-catalog-updated", params);
        });
        peer.registerNotificationHandler(NOTIFICATION_NAMES.PROJECTS_UPDATED, () => {
            this.events.emit("projects-updated", undefined);
        });
    }
    startDevWatcher(workerEntryPath) {
        if (!this.options.initializeParams.isDev || this.watcher)
            return;

        const runtimeBundleRoot = path.resolve(path.dirname(workerEntryPath), "..");
        this.watcher = watch(runtimeBundleRoot, { recursive: true }, (_eventType, filename) => {
            if (typeof filename !== "string" || !filename.endsWith(".js"))
                return;
            const runtimeRelative = `runtime/${filename.replace(/\\/g, "/")}`;
            if (!shouldReloadRuntime(runtimeRelative))
                return;
            void this.scheduleRuntimeReload();
        });
    }
}
const resolveDefaultWorkerEntryPath = (options) => {
    if (options.workerEntryPath) {
        return options.workerEntryPath;
    }
    return resolveBundledRuntimeFile("worker/entry.js");
};
const shouldReloadRuntime = (normalizedFilename) => {
    const hostOwnedRuntimeKernelPrefixes = [
        "runtime/kernel/convex-urls",
        "runtime/kernel/dev-projects/",
        "runtime/kernel/home/",
        "runtime/kernel/local-scheduler-service",
        "runtime/kernel/preferences/local-preferences",
        "runtime/kernel/shared/",
        "runtime/kernel/storage/",
        "runtime/kernel/tools/network-guards",
        "runtime/kernel/tools/stella-browser-bridge-config",
    ];
    if (normalizedFilename.startsWith("runtime/discovery/") &&
        !normalizedFilename.startsWith("runtime/discovery/browser-data")) {
        return true;
    }
    if (normalizedFilename.startsWith("runtime/kernel/") &&
        !hostOwnedRuntimeKernelPrefixes.some((prefix) => normalizedFilename.startsWith(prefix))) {
        return true;
    }
    if (normalizedFilename.startsWith("runtime/ai/") ||
        normalizedFilename.startsWith("runtime/worker/") ||
        normalizedFilename.startsWith("runtime/protocol/jsonl")) {
        return true;
    }
    return false;
};
