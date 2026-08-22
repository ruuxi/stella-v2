import { EventEmitter } from "node:events";
import { existsSync, promises as fs, readFileSync, watch, } from "node:fs";
import os from "node:os";
import path from "node:path";
import { ConvexClient } from "convex/browser";
import { anyApi } from "convex/server";
import { readConfiguredConvexUrl } from "@stella/contracts/convex-urls";
import { resolveBundledRuntimeFile } from "../kernel/shared/runtime-paths.js";
import { getFileLogger } from "../observability/file-logger.js";
import { LocalSchedulerService } from "../kernel/local-scheduler-service.js";
import { createRemoteTurnBridge } from "../kernel/remote-turn-bridge.js";
import { getConvexErrorCode, isConvexDeviceKeyMismatchError, isConvexUnauthenticatedError, shouldStopRemoteTurnForAuthFailure, } from "../kernel/runner/remote-turn-auth.js";
import { createEmptySocialSessionServiceSnapshot } from "@stella/contracts";
import { AGENT_STREAM_EVENT_TYPES } from "@stella/contracts/agent-runtime";
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
const DEVICE_HEARTBEAT_INTERVAL_MS = 30_000;
export { retireDetachedWorkerRoot };
const SYNTHETIC_RUN_EVENT_SEQ_FLOOR = 1e10;
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
/**
 * "Busy" for the purposes of stale-worker restarts: anything that a worker
 * kill would visibly interrupt. `activeRun`/`activeAgentCount` come from the
 * worker's active-run registry (the authoritative in-flight signal); voice
 * fields cover a live voice orchestrator turn. A `null` health snapshot
 * means the worker is unreachable, so there is nothing to preserve.
 */
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
    // Coalescing for the dev-watcher reload path only: while a
    // scheduled reload's restart is queued or running, further reload requests
    // collapse into a single trailing re-run instead of stacking one full restart
    // per file event. This does NOT guard direct restartWorker() callers (e.g.
    // the runtime.restartWorker IPC action) — those run their own full restart;
    // the controller's stop/start promises keep concurrent calls safe.
    restartInProgress = false;
    restartRequestedDuringRestart = false;
    /**
     * Set when the connected worker is known to be running stale runtime code
     * (build-stamp mismatch detected on reattach) but the restart was deferred because work is in
     * flight. Mirrored to `pendingWorkerRestartFile` on disk so the flag
     * survives an Electron restart; cleared whenever a freshly spawned worker
     * connects (fresh worker == current code).
     */
    pendingStaleWorkerRestart = null;
    staleWorkerQuiescencePollTimer = null;
    // Serializes the single gated flush (`flushWorkerRestart`) so concurrent
    // triggers/hooks don't stack overlapping health probes or restarts.
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
    hostDeviceRegistered = false;
    hostDeviceRegistering = false;
    hostHeartbeatTimer = null;
    hostRemoteTurnAuthWindowStartedAt = 0;
    hostRemoteTurnUnauthenticatedFailures = 0;
    hostRemoteTurnAuthRecoveryPromise = null;
    hostDeviceIdentityRecoveryPromise = null;
    pendingRunEventAcks = new Map();
    runEventAckTimer = null;
    /**
     * Per-conversation routing for follow-up assistant messages. Set when a
     * connector-sourced user message kicks off an orchestrator turn; cleared
     * when the user sends a non-connector message in that conversation
     * (i.e. they came back to the desktop). While a target is armed, every
     * assistant message persisted for that local conversation gets shipped
     * back to the same channel via `sendConnectorFollowup` so multi-turn
     * work (spawned-agent completion notices, "and here's the result" follow
     * ups, etc.) reaches the phone instead of dead-ending on the desktop.
     */
    connectorTargetsByLocalConversation = new Map();
    /**
     * Reverse index of `connectorTargetsByLocalConversation` keyed by
     * `requestId`. Used by the cancel subscription to map an inbound
     * cancellation back to the active local conversation so we can call
     * `cancelChatByConversation` on the worker. Maintained alongside the
     * primary map: any write here happens immediately after a write there.
     */
    localConversationByRequestId = new Map();
    /**
     * Tracks requestIds we've already actioned a cancel for, so reconnects
     * to `subscribeRemoteTurnCancelsForDevice` (which keeps returning
     * cancelled rows for the lookback window) don't fire repeat aborts.
     */
    cancelledRequestIds = new Set();
    hostRemoteTurnCancelUnsubscribe = null;
    constructor(options) {
        this.options = options;
        const stellaAppDir = this.options.initializeParams.stellaAppDir;
        // "detached" (default): shared self-supervising UDS worker keyed by
        // stellaAppDir — the desktop topology. "child": a private stdio worker
        // owned by this host process, used by headless/test hosts so they never
        // attach to (or restart) a live desktop's detached worker.
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
            // Worker self-supervises in the UDS path. Closing the IPC channel
            // (stop "stopped" / "idle") leaves the worker running for the next
            // host to attach; only "restart" actually kills the pid. A "child"
            // worker is owned by this process, so every stop kills it.
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
                // "idle" closes the IPC channel but leaves the worker alive for the
                // next host to reattach — routine churn, not a real stop. Only log
                // when the worker process is actually being torn down.
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
    /*
     * The detached worker keeps agent runs, shell/tool execution, and the
     * persistent run-event log alive across an Electron restart. Host-owned
     * services below still pause during the gap: LocalSchedulerService,
     * remote-turn Convex subscriptions, device heartbeats, dev file watching,
     * and the runtime file watcher. Those surfaces are expected
     * to recover on host reconnect; they are not part of the sidecar's
     * survival guarantee.
     */
    /**
     * Dev dist-electron watcher trigger: `runtime/` worker code changed on disk.
     * Records the reload intent and debounces a gated flush. The actual restart
     * only proceeds when {@link canRestartWorkerNow} holds (worker not busy) — evaluated in
     * `flushWorkerRestart`.
     */
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
    /*
     * ---- Stale-worker detection + idle/deferred restart -------------------
     *
     * The detached worker survives Electron restarts by design (grace window
     * that preserves in-flight runs). Without this machinery, runtime code
     * changes never reach a surviving
     * worker: the new host reconnects and keeps running old code forever.
     *
     * On every reattach we compare the worker's boot-time build stamp with the
     * on-disk runtime tree. Stale + idle => restart immediately. Stale + busy
     * => mark "restart pending" (persisted, survives further Electron
     * restarts) and restart the moment the worker goes quiescent — checked on
     * every RUN_FINISHED plus a slow safety poll. Auto-resuming runs killed by
     * a restart is intentionally out of scope for v1: deferral means we never
     * kill in-flight work in the first place.
     */
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
        // Nudge the unified gate soon: restart now if already quiescent, otherwise
        // an unblock hook (pause release, morph settle, worker idle) or the poll
        // retries. Off this call stack so a caller still inside the startup /
        // apply sequence isn't restarted from under itself.
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
        // Safety net for busy signals that don't end in a RUN_FINISHED event
        // (e.g. voice-only activity) or a missed event during churn.
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
    /**
     * Reconnect handshake: decide whether the worker we just connected to is
     * running stale runtime code. Runs from `onConnectionStarted` after the
     * health snapshot is cached.
     */
    async evaluateWorkerStalenessOnConnect(connection) {
        if (this.workerMode === "child") {
            // A stdio child always runs the current on-disk code and the
            // on-disk pending-restart bookkeeping belongs to the detached
            // supervisor topology — leave those control files alone so an
            // ephemeral headless host can't clear a desktop host's deferral.
            return;
        }
        if (connection.attachedToExistingWorker !== true) {
            // Freshly spawned worker loaded the current on-disk code; any deferred
            // restart bookkeeping from a previous generation is now satisfied.
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
                // Pre-stamp worker (older build) — by definition running old code.
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
        // `markPendingWorkerRestart` starts the quiescence poll and nudges the
        // unified gate; a run that starts in the meantime re-defers instead of
        // being killed.
        await this.markPendingWorkerRestart(reason);
    }
    /**
     * Unified gate for restarting the runtime worker. A restart may only proceed
     * when the worker is not busy (an agent run / voice request is in flight).
     * Both restart triggers (dev dist-electron watcher, stale-worker detection)
     * and every unblock hook route through this, so the dev-watcher path honors
     * the worker-busy deferral exactly like the stale-worker path.
     */
    canRestartWorkerNow(health = this.workerHealthCache) {
        return !isWorkerBusyForRestart(health);
    }
    /**
     * Whether some trigger wants the worker restarted: a dev-watcher runtime
     * reload (`deferredRuntimeReload`) or a persisted stale-worker restart
     * (`pendingStaleWorkerRestart`).
     */
    hasPendingWorkerRestartIntent() {
        return this.deferredRuntimeReload || this.pendingStaleWorkerRestart != null;
    }
    /**
     * The single flush path for BOTH restart triggers and every unblock hook
     * (worker idle / RUN_FINISHED, quiescence poll). Re-evaluates
     * {@link canRestartWorkerNow} against fresh
     * worker health and restarts once every blocker has cleared. A single
     * restart satisfies both intents: `restartWorker()` clears the
     * deferred-reload flag and a freshly spawned worker clears the pending flag
     * on reconnect.
     */
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
    /**
     * Perform the gated restart through the shared reload queue / in-progress
     * coalescing. Re-checks {@link canRestartWorkerNow} against fresh health
     * immediately before the kill so a run that started while queued is never
     * cut down — the pending intent stays set and a later flush retries.
     */
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
                // Consume the watcher intent before the replacement worker starts.
                // Worker initialization resets reload pauses and flushes pending
                // restart intent; leaving this bit set there re-arms the restart
                // forever, producing a spawn/ready/kill loop until Electron exits.
                const consumedDeferredRuntimeReload = this.deferredRuntimeReload;
                this.deferredRuntimeReload = false;
                getFileLogger()?.process("host.worker-restart", { reason });
                console.warn(`[runtime-host] Restarting runtime worker (${reason}).`);
                try {
                    await this.restartWorker();
                }
                catch (error) {
                    // A failed restart did not satisfy the watcher request. Preserve it
                    // for the next explicit readiness/recovery attempt.
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
                // `restartWorker()` emits readiness while restartInProgress is still
                // true, so that snapshot intentionally remains send-blocked. Publish
                // the authoritative post-transition state after clearing the flag so
                // waitUntilReady callers are released without polling or retrying.
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
    getHostDeviceName() {
        const hostname = os.hostname().trim();
        if (hostname) {
            return hostname;
        }
        const fallbackDeviceId = this.deviceIdentity?.deviceId ?? "unknown";
        return `${process.platform}-${fallbackDeviceId.slice(0, 6)}`;
    }
    async getActiveLocalConversationId() {
        const activeConversationId = (await this.options.hostHandlers.getActiveConversationId?.())?.trim() ??
            "";
        return (activeConversationId || (await this.getOrCreateDefaultConversationId()));
    }
    stopHostHeartbeatLoop() {
        if (this.hostHeartbeatTimer) {
            clearInterval(this.hostHeartbeatTimer);
            this.hostHeartbeatTimer = null;
        }
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
        this.stopHostHeartbeatLoop();
        this.stopHostRemoteTurnCancelSubscription();
        this.hostRemoteTurnBridge?.stop();
        this.hostDeviceRegistered = false;
        this.hostDeviceRegistering = false;
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
    async markHostDeviceOffline(deviceId) {
        if (!this.getConfiguredHostAuthToken() ||
            !this.getConfiguredHostConvexUrl()) {
            return;
        }
        const client = this.ensureHostConvexClient();
        if (!client) {
            return;
        }
        await client.mutation(anyApi.agent.device_resolver.goOffline, { deviceId });
    }
    async recoverHostDeviceIdentityFromKeyMismatch(error) {
        const resetDeviceIdentity = this.options.hostHandlers.resetDeviceIdentity;
        if (!resetDeviceIdentity) {
            console.warn("[remote-turn] Host device key mismatch cannot be recovered because identity reset is unavailable.", error);
            return false;
        }
        if (this.hostDeviceIdentityRecoveryPromise) {
            return await this.hostDeviceIdentityRecoveryPromise;
        }
        this.hostDeviceIdentityRecoveryPromise = (async () => {
            const previousDeviceId = this.deviceIdentity?.deviceId ?? null;
            console.warn("[remote-turn] Host device key mismatch; rotating local device identity.", error);
            this.stopHostHeartbeatLoop();
            this.stopHostRemoteTurnCancelSubscription();
            this.hostRemoteTurnBridge?.stop();
            this.hostRemoteTurnBridge = null;
            this.hostDeviceRegistered = false;
            this.hostDeviceRegistering = false;
            if (previousDeviceId) {
                await this.markHostDeviceOffline(previousDeviceId).catch(() => undefined);
            }
            this.deviceIdentity = await resetDeviceIdentity();
            this.workerHealthCache = null;
            this.ensureHostRemoteTurnBridge();
            this.ensureHostRemoteTurnCancelSubscription();
            const remoteTurnBridge = this.hostRemoteTurnBridge;
            remoteTurnBridge?.start();
            remoteTurnBridge?.kick();
            await this.registerHostDevice();
            this.startHostHeartbeatLoop();
            setTimeout(() => {
                void this.sendHostHeartbeat();
            }, 0);
            const activeRun = await this.getActiveRun().catch(() => null);
            if (!activeRun) {
                void this.scheduleRuntimeReload();
            }
            this.events.emit("runtime-ready", await this.health());
            return true;
        })();
        try {
            return await this.hostDeviceIdentityRecoveryPromise;
        }
        finally {
            this.hostDeviceIdentityRecoveryPromise = null;
        }
    }
    async sendHostHeartbeat(retryOnAuthFailure = true) {
        if (this.hostDeviceIdentityRecoveryPromise) {
            return;
        }
        const authToken = this.getConfiguredHostAuthToken();
        if (!authToken || !this.configCache.hasConnectedAccount) {
            return;
        }
        const deviceId = this.deviceIdentity?.deviceId;
        if (!deviceId) {
            return;
        }
        const client = this.ensureHostConvexClient();
        if (!client) {
            return;
        }
        try {
            const signedAtMs = Date.now();
            const { publicKey, signature } = await this.options.hostHandlers.signHeartbeatPayload(signedAtMs);
            if (this.deviceIdentity?.deviceId !== deviceId) {
                return;
            }
            await client.mutation(anyApi.agent.device_resolver.heartbeat, {
                deviceId,
                deviceName: this.getHostDeviceName(),
                platform: process.platform,
                signedAtMs,
                signature,
                publicKey,
            });
            this.hostDeviceRegistered = true;
            this.noteHostRemoteTurnAuthHealthy();
            // A successful heartbeat proves this identity is registered, and it
            // usually beats `registerHostDevice` to that state.
            void this.claimDeviceIdentitySuccession();
        }
        catch (error) {
            if (isConvexDeviceKeyMismatchError(error)) {
                await this.recoverHostDeviceIdentityFromKeyMismatch(error);
                return;
            }
            // A heartbeat can fire mid token-refresh with a stale/absent identity and
            // come back UNAUTHENTICATED even though the session is fine. Silently
            // refresh auth and retry once before treating it as a real auth failure,
            // so the transient race never surfaces or trips the failure-window
            // escalation below.
            if (retryOnAuthFailure && isConvexUnauthenticatedError(error)) {
                const recovered = await this.recoverHostRemoteTurnAuth("heartbeat");
                if (recovered) {
                    await this.sendHostHeartbeat(false);
                    return;
                }
                // Refresh could not restore a usable session — fall through to the
                // normal failure accounting/escalation.
            }
            const authFailure = this.handleHostRemoteTurnAuthFailure("heartbeat", error);
            if (authFailure.stopped) {
                void this.recoverHostRemoteTurnAuth("heartbeat");
                return;
            }
            if (authFailure.handled) {
                return;
            }
            console.warn("[remote-turn] Host heartbeat failed:", error);
        }
    }
    startHostHeartbeatLoop() {
        if (this.hostHeartbeatTimer) {
            return;
        }
        this.hostHeartbeatTimer = setInterval(() => {
            void this.sendHostHeartbeat();
        }, DEVICE_HEARTBEAT_INTERVAL_MS);
    }
    /**
     * Hand the backend this machine's retired device id so its paired phones,
     * bridge registration and tunnel move onto the current identity.
     *
     * A rotation happens whenever the local keypair stops being readable, and
     * every phone-facing record is keyed by the device id — without this, each
     * rotation strands every paired phone on an id that will never register a
     * bridge again, which reads on the phone as a permanently offline desktop.
     *
     * Best-effort and idempotent: the retired id stays on disk until the
     * backend acknowledges, so a claim that fails while offline is retried on
     * the next registration.
     */
    async claimDeviceIdentitySuccession() {
        const previousDeviceId = this.deviceIdentity?.supersededDeviceId;
        const deviceId = this.deviceIdentity?.deviceId;
        if (!previousDeviceId || !deviceId || previousDeviceId === deviceId) {
            return;
        }
        // Registration and the first heartbeat race each other, and either one
        // can be the path that proves the device is registered. Both call this,
        // so latch to keep it to a single in-flight claim.
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
            // A CONFLICT means the retired id was already succeeded elsewhere;
            // there is nothing left to claim, so stop retrying it.
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
    async registerHostDevice(attempt = 0) {
        if (this.hostDeviceRegistered || this.hostDeviceRegistering) {
            return;
        }
        const authToken = this.getConfiguredHostAuthToken();
        if (!authToken || !this.configCache.hasConnectedAccount) {
            return;
        }
        const deviceId = this.deviceIdentity?.deviceId;
        if (!deviceId) {
            return;
        }
        const client = this.ensureHostConvexClient();
        if (!client) {
            return;
        }
        this.hostDeviceRegistering = true;
        if (attempt === 0) {
            await new Promise((resolve) => setTimeout(resolve, 1_500));
        }
        if (this.deviceIdentity?.deviceId !== deviceId) {
            this.hostDeviceRegistering = false;
            return;
        }
        if (this.hostDeviceRegistered) {
            this.hostDeviceRegistering = false;
            return;
        }
        try {
            await client.mutation(anyApi.agent.device_resolver.registerDevice, {
                deviceId,
                deviceName: this.getHostDeviceName(),
                platform: process.platform,
            });
            if (this.deviceIdentity?.deviceId === deviceId) {
                this.hostDeviceRegistered = true;
                this.noteHostRemoteTurnAuthHealthy();
            }
            // Only meaningful once the successor itself is registered, which the
            // backend requires before it will move anything onto it.
            await this.claimDeviceIdentitySuccession();
        }
        catch (error) {
            const authFailure = this.handleHostRemoteTurnAuthFailure("register", error);
            if (authFailure.stopped) {
                void this.recoverHostRemoteTurnAuth("register");
                this.hostDeviceRegistering = false;
                return;
            }
            if (authFailure.handled) {
                this.hostDeviceRegistering = false;
                return;
            }
            if (attempt < 3) {
                await new Promise((resolve) => setTimeout(resolve, 2_000));
                this.hostDeviceRegistering = false;
                return await this.registerHostDevice(attempt + 1);
            }
        }
        this.hostDeviceRegistering = false;
    }
    async sendHostGoOffline() {
        this.stopHostHeartbeatLoop();
        if (!this.hostDeviceRegistered) {
            return;
        }
        if (!this.getConfiguredHostAuthToken() ||
            !this.getConfiguredHostConvexUrl()) {
            this.hostDeviceRegistered = false;
            return;
        }
        const deviceId = this.deviceIdentity?.deviceId;
        if (!deviceId) {
            this.hostDeviceRegistered = false;
            return;
        }
        try {
            await this.markHostDeviceOffline(deviceId);
            this.hostDeviceRegistered = false;
        }
        catch {
            // best-effort
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
                // Arm follow-up routing before the orchestrator turn runs so any
                // assistant message the worker persists during this run already
                // routes back to the connector. The map entry is cleared by the
                // local-chat listener as soon as the user sends a non-connector
                // message in this conversation.
                this.connectorTargetsByLocalConversation.set(localConversationId, {
                    requestId,
                    backendConversationId: conversationId,
                    initialTurnCompleted: false,
                    pendingFollowupTexts: [],
                });
                this.localConversationByRequestId.set(requestId, localConversationId);
                // Stable event id shared with the worker turn so the runtime
                // can exclude this display event from the legacy history shim
                // (the same text reaches the model via the turn's prompt).
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
                // The desktop user typed in this conversation — switch routing back
                // to the desktop. Connector-sourced user messages (the ones armed
                // by `runLocalTurn` above) keep the target alive.
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
            this.stopHostHeartbeatLoop();
            this.stopHostRemoteTurnCancelSubscription();
            this.hostRemoteTurnBridge?.stop();
            void this.sendHostGoOffline().finally(() => {
                this.disposeHostConvexClient();
            });
            return;
        }
        const authToken = this.getConfiguredHostAuthToken();
        const convexUrl = this.getConfiguredHostConvexUrl();
        if (!authToken || !convexUrl) {
            this.stopHostHeartbeatLoop();
            this.stopHostRemoteTurnCancelSubscription();
            this.hostRemoteTurnBridge?.stop();
            this.hostDeviceRegistered = false;
            this.hostDeviceRegistering = false;
            this.disposeHostConvexClient();
            return;
        }
        if (!this.configCache.hasConnectedAccount) {
            this.stopHostHeartbeatLoop();
            this.stopHostRemoteTurnCancelSubscription();
            this.hostRemoteTurnBridge?.stop();
            void this.sendHostGoOffline().finally(() => {
                this.disposeHostConvexClient();
            });
            return;
        }
        this.ensureHostRemoteTurnBridge();
        if (!this.hostRemoteTurnBridge) {
            return;
        }
        this.resetHostRemoteTurnAuthTracking();
        void this.registerHostDevice();
        this.startHostHeartbeatLoop();
        void this.sendHostHeartbeat();
        this.hostRemoteTurnBridge.start();
        this.hostRemoteTurnBridge.kick();
        this.ensureHostRemoteTurnCancelSubscription();
    }
    /**
     * Subscribes to `events.subscribeRemoteTurnCancelsForDevice` so a phone
     * (or any other client) that calls `mobile_chat.cancelChat` /
     * `cancelRemoteTurn` can abort the in-flight orchestrator run on this
     * desktop. The request feed alone is not enough — once the request is
     * `claimed`, it drops out of `subscribeRemoteTurnRequestsForDevice`'s
     * `pending`-only filter, so the active run is invisible to the request
     * stream. The cancel feed is a dedicated channel for "abort a run you
     * already started".
     *
     * Cancellation of a not-yet-claimed request is handled implicitly by
     * the request feed (cancelled rows fall out of the snapshot and the
     * bridge garbage-collects its pending entry) — this subscription only
     * acts on cancels for active local conversations.
     */
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
            // best-effort teardown
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
        // The on-disk pending-restart flag intentionally survives host stop so
        // the next host's reconnect handshake picks the deferral back up.
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
        // Restart-latency breakdown: stopMs (drain + kill grace) vs startMs (spawn
        // + cold parse + initialization exchange). Pairs with the worker-side
        // `worker.kill-latency` and `startup.post-ready-complete` lines.
        getFileLogger()?.process("host.worker-restart-latency", {
            stopMs: stoppedAt - startedAt,
            startMs: readyAt - stoppedAt,
            totalMs: readyAt - startedAt,
            generation: this.workerGeneration,
        });
        return { ok: true };
    }
    /**
     * Proactively spawn the worker process without forcing a model-catalog
     * fetch. The worker self-warms its catalog on init/configure (debounced),
     * so this is just the process spin-up — kept off the open burst by the
     * caller (deferred-startup) so it doesn't contend with first paint.
     */
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
        // Fast path: host-side in-memory buffer covers the renderer-reload
        // case (renderer reloads but host process is still alive). Falls
        // through to the worker for the host-restart case where the buffer
        // is gone but the worker still has the persistent event log.
        const buffer = this.agentEventBuffers.get(payload.runId);
        if (buffer) {
            const oldestSeq = buffer.events[0]?.seq ?? null;
            const events = buffer.events.filter((event) => event.seq > payload.lastSeq);
            const exhausted = oldestSeq !== null && payload.lastSeq < oldestSeq - 1;
            if (events.length > 0 || !exhausted) {
                return { events, exhausted };
            }
        }
        // Worker fallback. We only call this when the in-memory buffer
        // missed — keeps the cost off the hot path during normal streaming.
        try {
            const remote = await this.requestWorker(METHOD_NAMES.INTERNAL_WORKER_RESUME_EVENTS, { runId: payload.runId, lastSeq: payload.lastSeq }, { ensureWorker: false, recordActivity: false });
            return remote;
        }
        catch {
            return { events: [], exhausted: true };
        }
    }
    /**
     * Ack an event the host has successfully forwarded to the renderer.
     * Best-effort and async-fire-and-forget — a missed ack just keeps
     * the row in the worker's ring buffer a little longer; the periodic
     * sweep eventually drops aged entries regardless.
     */
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
    /**
     * Auth-inversion P1: desktop -> worker session migration/dual-write.
     * Throws when the connected worker predates the AuthOwner RPCs
     * (detached-worker version skew); callers treat that as legacy mode.
     */
    async authImport(payload) {
        return await this.requestWorker(METHOD_NAMES.AUTH_IMPORT, payload, {
            ensureWorker: true,
        });
    }
    async authGetSession() {
        return await this.requestWorker(METHOD_NAMES.AUTH_GET_SESSION, undefined, {
            ensureWorker: true,
        });
    }
    async authGetConvexToken(payload = {}) {
        return await this.requestWorker(METHOD_NAMES.AUTH_GET_CONVEX_TOKEN, payload, {
            ensureWorker: true,
        });
    }
    // P3: sign-in mutations execute inside the worker's AuthOwner.
    async authSignInAnonymous() {
        return await this.requestWorker(METHOD_NAMES.AUTH_SIGN_IN_ANONYMOUS, undefined, {
            ensureWorker: true,
        });
    }
    async authSignOut() {
        return await this.requestWorker(METHOD_NAMES.AUTH_SIGN_OUT, undefined, {
            ensureWorker: true,
        });
    }
    async authDeleteUser() {
        return await this.requestWorker(METHOD_NAMES.AUTH_DELETE_USER, undefined, {
            ensureWorker: true,
        });
    }
    async authApplySessionCookie(payload) {
        return await this.requestWorker(METHOD_NAMES.AUTH_APPLY_SESSION_COOKIE, payload, {
            ensureWorker: true,
        });
    }
    async authHandleCallback(payload) {
        return await this.requestWorker(METHOD_NAMES.AUTH_HANDLE_CALLBACK, payload, {
            ensureWorker: true,
        });
    }
    async authMagicLinkSend(payload) {
        return await this.requestWorker(METHOD_NAMES.AUTH_MAGIC_LINK_SEND, payload, {
            ensureWorker: true,
        });
    }
    async authMagicLinkStatus(payload) {
        return await this.requestWorker(METHOD_NAMES.AUTH_MAGIC_LINK_STATUS, payload, {
            ensureWorker: true,
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
    async listStorePackages() {
        return await this.requestWorker(METHOD_NAMES.INTERNAL_WORKER_LIST_STORE_PACKAGES, undefined, { ensureWorker: true, recordActivity: true });
    }
    async getStorePackage(packageId) {
        return await this.requestWorker(METHOD_NAMES.INTERNAL_WORKER_GET_STORE_PACKAGE, { packageId }, { ensureWorker: true, recordActivity: true });
    }
    async listStorePackageReleases(packageId) {
        return await this.requestWorker(METHOD_NAMES.INTERNAL_WORKER_LIST_STORE_RELEASES, { packageId }, { ensureWorker: true, recordActivity: true });
    }
    async getStorePackageRelease(packageId, releaseNumber) {
        return await this.requestWorker(METHOD_NAMES.INTERNAL_WORKER_GET_STORE_RELEASE, { packageId, releaseNumber }, { ensureWorker: true, recordActivity: true });
    }
    async listCronJobs() {
        return this.ensureScheduler().listCronJobs();
    }
    async listHeartbeats() {
        return this.ensureScheduler().listHeartbeats();
    }
    /**
     * Direct mutation surface used by the renderer-side schedule chip / dialog
     * (Run now, Pause/Resume, Delete). Same in-process scheduler the
     * Schedule subagent talks to via tools — both paths converge on
     * `LocalSchedulerService` and emit the shared `schedule.updated`
     * notification on success, so the chat surface and the Up next list
     * refresh together.
     */
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
    async createSocialSession(payload) {
        this.workerHealthCache = null;
        return await this.requestWorker(METHOD_NAMES.INTERNAL_WORKER_SOCIAL_SESSIONS_CREATE, payload, { ensureWorker: true, recordActivity: true });
    }
    async updateSocialSessionStatus(payload) {
        this.workerHealthCache = null;
        return await this.requestWorker(METHOD_NAMES.INTERNAL_WORKER_SOCIAL_SESSIONS_UPDATE_STATUS, payload, {
            ensureWorker: true,
            recordActivity: true,
        });
    }
    async queueSocialSessionTurn(payload) {
        this.workerHealthCache = null;
        return await this.requestWorker(METHOD_NAMES.INTERNAL_WORKER_SOCIAL_SESSIONS_QUEUE_TURN, payload, { ensureWorker: true, recordActivity: true });
    }
    async getSocialSessionStatus() {
        const health = await this.getWorkerHealth({ ensureWorker: false });
        return health?.socialSessions ?? createEmptySocialSessionServiceSnapshot();
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
            // Ephemeral hosts (headless CLI, tests) must not run a second
            // scheduler over the same data dir as a live desktop host — a
            // duplicate scheduler could double-fire due cron jobs.
            this.hostReady = true;
            return;
        }
        const showNotificationHandler = this.options.hostHandlers.showNotification;
        const scheduler = new LocalSchedulerService({
            stellaDataDir: this.options.initializeParams.stellaDataDirPath,
            runnerTarget: {
                getRunner: () => ({
                    runAutomationTurn: async (payload) => await this.requestWorker(METHOD_NAMES.INTERNAL_WORKER_RUN_AUTOMATION, payload, {
                        ensureWorker: true,
                        recordActivity: true,
                    }),
                    getActiveOrchestratorRun: async () => await this.getActiveRun(),
                }),
            },
            // Pop a native banner whenever a scheduled fire delivers a message.
            // Routed through the same Electron handler the runtime uses for
            // in-app notifications (sound preference + grouping respected).
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
        await this.sendHostGoOffline().catch(() => undefined);
        this.hostRemoteTurnBridge = null;
        this.stopHostHeartbeatLoop();
        this.disposeHostConvexClient();
        this.hostDeviceRegistered = false;
        this.hostDeviceRegistering = false;
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
    async triggerDreamNow(trigger = "manual") {
        return await this.requestWorker(METHOD_NAMES.INTERNAL_WORKER_DREAM_TRIGGER_NOW, { trigger }, { ensureWorker: true, recordActivity: true });
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
        peer.registerRequestHandler(METHOD_NAMES.HOST_DEVICE_HEARTBEAT_SIGN, async (params) => {
            const signedAtMs = params && typeof params === "object" && "signedAtMs" in params
                ? Number(params.signedAtMs)
                : Number.NaN;
            if (!Number.isFinite(signedAtMs)) {
                throw new Error("Invalid host heartbeat signing payload.");
            }
            return await this.options.hostHandlers.signHeartbeatPayload(signedAtMs);
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
        peer.registerRequestHandler(METHOD_NAMES.HOST_BROWSER_EXTENSION_CONNECT_REQUEST, async (params) => {
            if (!this.options.hostHandlers.requestBrowserExtensionConnect) {
                return { ok: false, reason: "unsupported" };
            }
            return await this.options.hostHandlers.requestBrowserExtensionConnect(params);
        });
        peer.registerRequestHandler(METHOD_NAMES.HOST_COMPUTER_USE_APP_APPROVAL_REQUEST, async (params) => {
            // Per-app Computer Use consent is retired. Chat-initiated use is
            // already authorized for ordinary apps. Always approve so a newer
            // desktop paired with an older worker cannot resurface the
            // "Allow Computer Use to use <app>?" dialog or honor a deny.
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
            // Ack only ordinary recorder events. Terminal events must remain
            // replayable until the retention sweep, otherwise an Electron
            // restart between host receipt and renderer resume can strand the
            // UI in an active run. Synthetic task seqs are Date.now-scale and
            // would prune lower ordinary run seqs, including terminal rows.
            if (payload.runId && shouldAckWorkerRunEvent(payload)) {
                this.scheduleRunEventAck(payload.runId, payload.seq);
            }
            if (payload.type === AGENT_STREAM_EVENT_TYPES.RUN_FINISHED) {
                if (this.hasPendingWorkerRestartIntent()) {
                    // A deferred worker restart is waiting for the worker to go idle;
                    // give immediate follow-up runs a moment to register before the
                    // unified gate re-checks.
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
        peer.registerNotificationHandler(NOTIFICATION_NAMES.AUTH_CHANGED, (params) => {
            // Auth-inversion P1: worker AuthOwner state changes fan out to
            // host clients (Electron main re-broadcasts to renderers in P2).
            this.events.emit("auth-changed", params);
        });
    }
    startDevWatcher(workerEntryPath) {
        if (!this.options.initializeParams.isDev || this.watcher)
            return;
        // Watch only the bundled `runtime/` subtree, not the whole dist-electron
        // tree (which also holds the 14.6MB main.js and the CLI bundles).
        // `shouldReloadRuntime` only ever matches "runtime/..." paths, so a single
        // esbuild rebuild that rewrites main.js no longer wakes this watcher and
        // cold-respawns the worker. The watch callback's `filename` is relative to
        // the watched root, so re-prefix it with "runtime/" to keep the matcher's
        // contract intact.
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
