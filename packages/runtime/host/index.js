import { EventEmitter } from "node:events";
import { existsSync, promises as fs, readFileSync, watch, } from "node:fs";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { hostname } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ConvexClient } from "convex/browser";
import { anyApi } from "convex/server";
import { readConfiguredConvexUrl } from "@stella/contracts/convex-urls";
import { resolveBundledRuntimeFile } from "../kernel/shared/runtime-paths.js";
import { getFileLogger } from "../observability/file-logger.js";
import { isRestartContinuationEnabled, recordRestartShutdown, } from "../kernel/restart-continuation.js";
import { LocalSchedulerService } from "../kernel/local-scheduler-service.js";
import { createScheduleScriptAuthEnv } from "../kernel/shared/schedule-scripts.js";
import { createRemoteTurnBridge } from "../kernel/remote-turn-bridge.js";
import { remoteTurnWorkerRunId } from "../kernel/remote-turn-attempt.js";
import { getConvexErrorCode, isConvexUnauthenticatedError, shouldStopRemoteTurnForAuthFailure, } from "../kernel/runner/remote-turn-auth.js";
import { AGENT_STREAM_EVENT_TYPES } from "@stella/contracts/agent-runtime";
import { connectorLocalFollowupDeliveryId, resolveConnectorFollowupAction, resolveConnectorTerminalFollowup, } from "./connector-followup.js";
import { ConnectorFollowupOutbox } from "./connector-followup-outbox.js";
import { createExecutionPlacementBridge, placementLocalAgentThreadId, placementLocalChatRunId, } from "./execution-placement-bridge.js";
import { isExecutionPlacementEligible } from "./execution-placement-eligibility.js";
import { isCloudHandedOff } from "./placed-dispatch.js";
import { placementAttachmentPaths, resolvePlacementAttachments, } from "./placement-attachments.js";
import { getDesktopDatabasePath, initializeDesktopDatabase, } from "../kernel/storage/database-init.js";
import { METHOD_NAMES, NOTIFICATION_NAMES, STELLA_RUNTIME_PROTOCOL_VERSION, } from "@stella/contracts/protocol";
import { createRuntimeUnavailableError, } from "@stella/contracts/protocol/rpc-peer";
import { RuntimeWorkerLifecycleController, } from "./worker-lifecycle.js";
import { buildUdsConnectionFactory, killDetachedWorker, retireDetachedWorkerRoot, } from "./uds-connection.js";
import { buildStdioConnectionFactory } from "./stdio-connection.js";
import { resolveRuntimePaths } from "../worker/runtime-paths.js";
import { probeRunningWorker } from "../worker/lifecycle-server.js";
import { Cause, Effect, Exit, Fiber } from "effect";
import { forkDelayed, hostRuntime, } from "./effect-runtime.js";
import { clearPendingWorkerRestartFlag, evaluateWorkerStaleness, persistPendingWorkerRestartFlag, quiescencePollEffect, } from "./staleness.js";
import { HOST_CHALLENGE_TOKEN_METHOD } from "./challenge-token-method.js";
import { HOST_DEVICE_SIGNING_METHOD, MAX_DEVICE_SIGNING_INPUT_LENGTH, } from "./device-signing-method.js";
import { isDelegatedDeviceSigningInput } from "@stella/contracts/gateway/dpop";
/*
 * Host-side Effect boundary: the staleness/build-stamp handshake, the
 * quiescence poll, and every host timer (reload debounce and ack/flush
 * debounces) run on the shared `hostRuntime`
 * (host/effect-runtime.ts) as fibers cancelled through HostTimerHandle.
 * The StellaRuntimeHost API below stays plain Promise/data — no Effect type
 * escapes this file (check-boundary.mjs enforces the package fence, this
 * comment enforces the signature fence).
 */
const requireRuntime = createRequire(import.meta.url);
const loadSqliteDatabaseCtorSync = () => {
    if (process.versions.bun) {
        const bunSqlite = requireRuntime("bun:sqlite");
        if (typeof bunSqlite.Database === "function")
            return bunSqlite.Database;
    }
    else {
        const nodeSqlite = requireRuntime("node:sqlite");
        if (typeof nodeSqlite.DatabaseSync === "function") {
            return nodeSqlite.DatabaseSync;
        }
    }
    throw new Error("No compatible SQLite builtin is available.");
};
const AGENT_EVENT_BUFFER_LIMIT = 1_000;
const AGENT_EVENT_BUFFER_TTL_MS = 10 * 60 * 1_000;
const REMOTE_TURN_CANCEL_RETRY_COUNT = 4;
const REMOTE_TURN_CANCEL_RETRY_DELAY_MS = 25;
const REMOTE_TURN_CANCEL_ACK_TIMEOUT_MS = 500;
const PLACED_ATTACHMENT_MAX_BYTES = 20 * 1024 * 1024;
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
    staleWorkerQuiescencePollFiber = null;
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
    hostExecutionPlacementBridge = null;
    hostExecutionPlacementSyncQueue = Promise.resolve();
    placedDispatchByRunId = new Map();
    hostRemoteTurnAuthWindowStartedAt = 0;
    hostRemoteTurnUnauthenticatedFailures = 0;
    hostRemoteTurnAuthRecoveryPromise = null;
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
    connectorFollowupOutbox = null;
    connectorFollowupDatabase = null;
    /**
     * Tracks exact requestId:attemptId pairs with positive cancel/join evidence,
     * so reconnects
     * to `subscribeRemoteTurnCancelsForDevice` (which keeps returning
     * cancelled rows for the lookback window) don't fire repeat aborts.
     */
    cancelledRequestIds = new Set();
    remoteTurnAttemptsByRequestId = new Map();
    pendingRemoteTurnCancelsByRequestId = new Map();
    remoteTurnWorkerRetirementPromise = null;
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
     * remote-turn Convex subscriptions, dev file watching, and the runtime
     * file watcher. Those surfaces are expected
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
        this.reloadTimer?.cancel();
        this.reloadTimer = forkDelayed(150, () => {
            this.reloadTimer = null;
            void this.flushWorkerRestart();
        });
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
    /**
     * Authorize one graceful worker-replacement episode before sending the
     * signal that starts Effect teardown. The worker snapshots its active rows
     * against this episode before cancellation, and the replacement worker only
     * accepts exact episode matches. Synchronous/best-effort by design: failure
     * must never hold the process open or turn a crash into false continuation.
     */
    writeRestartContinuationRecord(reason) {
        if (!isRestartContinuationEnabled(process.env))
            return;
        try {
            if (recordRestartShutdown(this.options.initializeParams.stellaDataDirPath, {
                reason,
            })) {
                getFileLogger()?.process("host.restart-continuation-record", {
                    reason,
                });
            }
        }
        catch {
            // Best-effort shutdown bookkeeping.
        }
    }
    getPendingWorkerRestart() {
        return this.pendingStaleWorkerRestart;
    }
    async markPendingWorkerRestart(reason) {
        if (!this.pendingStaleWorkerRestart) {
            this.pendingStaleWorkerRestart = { reason, detectedAtMs: Date.now() };
        }
        const record = this.pendingStaleWorkerRestart;
        getFileLogger()?.process("host.worker-restart-pending", { reason });
        console.warn(`[runtime-host] Runtime update pending (${reason}); the worker restarts when current work finishes.`);
        const persistExit = await hostRuntime.runPromiseExit(persistPendingWorkerRestartFlag(this.getRuntimeControlPaths(), record));
        if (Exit.isFailure(persistExit)) {
            console.warn("[runtime-host] Failed to persist pending worker restart flag:", Cause.squash(persistExit.cause).message);
        }
        this.startStaleWorkerQuiescencePoll();
        // Nudge the unified gate soon: restart now if already quiescent, otherwise
        // an unblock hook (pause release, morph settle, worker idle) or the poll
        // retries. Forked as a 1s fiber so it stays off this call stack — a
        // caller still inside the startup / apply sequence isn't restarted from
        // under itself.
        forkDelayed(1_000, () => {
            void this.flushWorkerRestart();
        });
        if (this.started) {
            this.events.emit("runtime-ready", await this.health());
        }
    }
    async clearPendingWorkerRestart() {
        this.stopStaleWorkerQuiescencePoll();
        this.pendingStaleWorkerRestart = null;
        await hostRuntime.runPromise(clearPendingWorkerRestartFlag(this.getRuntimeControlPaths()));
    }
    startStaleWorkerQuiescencePoll() {
        if (this.staleWorkerQuiescencePollFiber)
            return;
        // Safety net for busy signals that don't end in a RUN_FINISHED event
        // (e.g. voice-only activity) or a missed event during churn. Fixed-rate
        // 30s ticks with a leading delay, matching the old setInterval cadence
        // (see quiescencePollEffect).
        this.staleWorkerQuiescencePollFiber = hostRuntime.runFork(quiescencePollEffect(() => this.flushWorkerRestart()));
    }
    stopStaleWorkerQuiescencePoll() {
        const fiber = this.staleWorkerQuiescencePollFiber;
        if (!fiber)
            return;
        this.staleWorkerQuiescencePollFiber = null;
        hostRuntime.runFork(Fiber.interrupt(fiber));
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
        const verdict = await hostRuntime.runPromise(evaluateWorkerStaleness({
            attachedToExistingWorker: true,
            paths: this.getRuntimeControlPaths(),
            workerEntryPath: resolveDefaultWorkerEntryPath(this.options),
        }));
        if (!verdict.stale) {
            await this.clearPendingWorkerRestart();
            return;
        }
        const reason = verdict.reason;
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
                    await this.restartWorker(reason);
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
                    forkDelayed(0, () => {
                        void this.flushWorkerRestart();
                    });
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
     * backend acknowledges, so a claim that fails while offline is retried
     * when authenticated host services next synchronize.
     */
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
    isCurrentRemoteTurnAttempt(binding) {
        return this.remoteTurnAttemptsByRequestId.get(binding.requestId) === binding;
    }
    publishRemoteTurnConnectorTarget(binding) {
        if (!this.isCurrentRemoteTurnAttempt(binding) ||
            binding.cancelRequested ||
            binding.signal.aborted) {
            return false;
        }
        const connectorTarget = this.connectorFollowupOutbox?.armTarget({
            conversationId: binding.localConversationId,
            requestId: binding.requestId,
            backendConversationId: binding.conversationId,
        });
        if (binding.previousConnectorTarget &&
            binding.previousConnectorTarget.requestId !== binding.requestId) {
            this.localConversationByRequestId.delete(binding.previousConnectorTarget.requestId);
        }
        this.connectorTargetsByLocalConversation.set(binding.localConversationId, {
            ...(connectorTarget ?? {
                requestId: binding.requestId,
                backendConversationId: binding.conversationId,
                initialTurnCompleted: false,
            }),
            attemptId: binding.attemptId,
        });
        this.localConversationByRequestId.set(binding.requestId, binding.localConversationId);
        binding.published = true;
        return true;
    }
    rollbackRemoteTurnConnectorTarget(binding) {
        if (!binding.published) {
            return;
        }
        const current = this.connectorTargetsByLocalConversation.get(binding.localConversationId);
        if (current?.requestId !== binding.requestId ||
            current?.attemptId !== binding.attemptId) {
            binding.published = false;
            return;
        }
        this.localConversationByRequestId.delete(binding.requestId);
        const previous = binding.previousConnectorTarget;
        if (previous) {
            const restored = this.connectorFollowupOutbox?.armTarget({
                conversationId: binding.localConversationId,
                requestId: previous.requestId,
                backendConversationId: previous.backendConversationId,
            });
            this.connectorTargetsByLocalConversation.set(binding.localConversationId, {
                ...(restored ?? previous),
                ...(previous.attemptId ? { attemptId: previous.attemptId } : {}),
            });
            this.localConversationByRequestId.set(previous.requestId, binding.localConversationId);
        }
        else {
            this.connectorTargetsByLocalConversation.delete(binding.localConversationId);
            this.connectorFollowupOutbox?.clearTarget(binding.localConversationId);
        }
        binding.published = false;
    }
    admitRemoteTurnAttempt(params) {
        const requestId = typeof params?.requestId === "string" ? params.requestId.trim() : "";
        const attemptId = typeof params?.attemptId === "string" ? params.attemptId.trim() : "";
        const conversationId = typeof params?.conversationId === "string"
            ? params.conversationId.trim()
            : "";
        const runId = typeof params?.runId === "string" ? params.runId.trim() : "";
        const binding = requestId
            ? this.remoteTurnAttemptsByRequestId.get(requestId)
            : null;
        const exact = Boolean(binding &&
            binding.attemptId === attemptId &&
            binding.localConversationId === conversationId &&
            binding.runId === runId &&
            runId === remoteTurnWorkerRunId(attemptId));
        if (!exact ||
            !this.started ||
            !this.hostReady ||
            binding.cancelRequested ||
            binding.signal.aborted) {
            if (exact) {
                binding.admissionDenied = true;
            }
            return { accepted: false, attemptId, runId };
        }
        if (!this.publishRemoteTurnConnectorTarget(binding)) {
            binding.admissionDenied = true;
            return { accepted: false, attemptId, runId };
        }
        binding.admitted = true;
        return { accepted: true, attemptId, runId };
    }
    async retireRemoteTurnWorker(binding, reason) {
        if (binding.workerRetired) {
            return true;
        }
        if (!this.remoteTurnWorkerRetirementPromise) {
            this.remoteTurnWorkerRetirementPromise = (async () => {
                console.warn(`[remote-turn] Retiring ambiguous worker for attempt ${binding.attemptId}: ${reason}`);
                await this.workerController.stop("restart");
                if (this.workerMode === "detached") {
                    const stellaAppDir = this.options.initializeParams.stellaAppDir;
                    await killDetachedWorker(stellaAppDir);
                    const remainingPid = await probeRunningWorker(stellaAppDir);
                    if (remainingPid != null) {
                        throw new Error(`Runtime worker ${remainingPid} survived remote-turn retirement.`);
                    }
                }
                if (this.started) {
                    await this.workerController.ensureStarted();
                }
            })().finally(() => {
                this.remoteTurnWorkerRetirementPromise = null;
            });
        }
        try {
            await this.remoteTurnWorkerRetirementPromise;
            binding.workerRetired = true;
            this.markRemoteTurnCancellationJoined(binding);
            return true;
        }
        catch (error) {
            console.warn(`[remote-turn] Failed to retire ambiguous worker for attempt ${binding.attemptId}:`, error instanceof Error ? error.message : String(error));
            return false;
        }
    }
    markRemoteTurnCancellationJoined(binding) {
        binding.cancelJoined = true;
        binding.resolveCancelJoined?.();
        binding.resolveCancelJoined = null;
    }
    requestRemoteTurnCancellation(binding) {
        binding.cancelRequested = true;
        if (binding.cancelJoined || binding.workerSettled) {
            this.markRemoteTurnCancellationJoined(binding);
            return Promise.resolve(true);
        }
        if (binding.cancelJoinPromise) {
            return binding.cancelJoinPromise;
        }
        binding.cancelJoinPromise = (async () => {
            for (let attempt = 0; attempt < REMOTE_TURN_CANCEL_RETRY_COUNT; attempt += 1) {
                if (binding.workerSettled) {
                    this.markRemoteTurnCancellationJoined(binding);
                    return true;
                }
                if (!binding.workerRequestSent) {
                    await hostRuntime.runPromise(Effect.sleep(REMOTE_TURN_CANCEL_RETRY_DELAY_MS));
                    continue;
                }
                if (binding.transportAmbiguous) {
                    return await this.retireRemoteTurnWorker(binding, "worker transport became ambiguous");
                }
                const cancellationRequest = this.cancelChat(binding.runId)
                    .then((receipt) => ({ receipt }))
                    .catch((error) => ({ error }));
                const response = await Promise.race([
                    cancellationRequest,
                    hostRuntime.runPromise(Effect.sleep(REMOTE_TURN_CANCEL_ACK_TIMEOUT_MS)).then(() => null),
                ]);
                if (response?.receipt?.cancelled === true) {
                    this.markRemoteTurnCancellationJoined(binding);
                    return true;
                }
                if (response === null || response?.error) {
                    binding.transportAmbiguous = true;
                    return await this.retireRemoteTurnWorker(binding, "exact cancellation ACK was ambiguous");
                }
                await hostRuntime.runPromise(Effect.sleep(REMOTE_TURN_CANCEL_RETRY_DELAY_MS));
            }
            if (!binding.workerRequestSent || binding.workerSettled) {
                this.markRemoteTurnCancellationJoined(binding);
                return true;
            }
            return await this.retireRemoteTurnWorker(binding, "exact cancellation was not registered in time");
        })().finally(() => {
            binding.cancelJoinPromise = null;
        });
        return binding.cancelJoinPromise;
    }
    ensureHostRemoteTurnBridge() {
        if (this.hostRemoteTurnBridge || !this.deviceIdentity?.deviceId) {
            return;
        }
        const remoteTurnDeviceId = this.deviceIdentity.deviceId;
        this.hostRemoteTurnBridge = createRemoteTurnBridge({
            deviceId: remoteTurnDeviceId,
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
            runLocalTurn: async ({ requestId, attemptId, conversationId, ownerGeneration, userPrompt, agentType, modelOverride, provider, externalMessageId, attachments, signal, confirmDispatchLease, }) => {
                const localConversationId = this.configCache.cloudSyncEnabled
                    ? conversationId || (await this.getOrCreateDefaultConversationId())
                    : await this.getActiveLocalConversationId();
                const existingBinding = this.remoteTurnAttemptsByRequestId.get(requestId);
                if (existingBinding && existingBinding.attemptId !== attemptId) {
                    throw new Error(`Remote-turn request ${requestId} already has another active attempt.`);
                }
                let resolveCancelJoined;
                const cancelJoinedPromise = new Promise((resolve) => {
                    resolveCancelJoined = resolve;
                });
                const binding = {
                    requestId,
                    attemptId,
                    conversationId,
                    localConversationId,
                    runId: remoteTurnWorkerRunId(attemptId),
                    signal,
                    previousConnectorTarget: this.resolveConnectorFollowupTarget(localConversationId),
                    published: false,
                    admitted: false,
                    admissionDenied: false,
                    cancelRequested: this.pendingRemoteTurnCancelsByRequestId.get(requestId) === attemptId,
                    cancelJoined: false,
                    cancelJoinedPromise,
                    resolveCancelJoined,
                    cancelJoinPromise: null,
                    workerRequestSent: false,
                    workerSettled: false,
                    workerRetired: false,
                    transportAmbiguous: false,
                };
                this.remoteTurnAttemptsByRequestId.set(requestId, binding);
                const cancelAndJoinRun = () => this.requestRemoteTurnCancellation(binding);
                const handleAttemptAbort = () => {
                    void cancelAndJoinRun();
                };
                signal.addEventListener("abort", handleAttemptAbort);
                if (binding.cancelRequested || signal.aborted) {
                    void cancelAndJoinRun();
                }
                // Stable event id shared with the worker turn so the runtime
                // can exclude this display event from the legacy history shim
                // (the same text reaches the model via the turn's prompt).
                const connectorUserMessageId = `connector:${requestId}`;
                let result;
                let completedSuccessfully = false;
                try {
                    if (signal.aborted || binding.cancelRequested) {
                        throw signal.reason instanceof Error
                            ? signal.reason
                            : new Error("Remote-turn attempt was cancelled before execution.");
                    }
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
                    if (signal.aborted || binding.cancelRequested) {
                        throw signal.reason instanceof Error
                            ? signal.reason
                            : new Error("Remote-turn attempt was cancelled before execution.");
                    }
                    // Worker startup may await a process spawn/reconnect, so it
                    // must finish before the final durable lease confirmation.
                    await this.ensureWorkerStarted();
                    if (signal.aborted || binding.cancelRequested) {
                        throw signal.reason instanceof Error
                            ? signal.reason
                            : new Error("Remote-turn attempt was cancelled before execution.");
                    }
                    // Final exact-attempt lifecycle/migration fence. There are
                    // no awaited preparation steps between this ACK and the
                    // physical worker request below.
                    await confirmDispatchLease();
                    if (signal.aborted || binding.cancelRequested) {
                        throw signal.reason instanceof Error
                            ? signal.reason
                            : new Error("Remote-turn attempt was cancelled before execution.");
                    }
                    binding.workerRequestSent = true;
                    const workerRunPromise = this.requestWorker(METHOD_NAMES.INTERNAL_WORKER_RUN_AUTOMATION, {
                        conversationId: localConversationId,
                        userPrompt,
                        userMessageEventId: connectorUserMessageId,
                        remoteTurnAttemptId: attemptId,
                        ownerGeneration,
                        ...(agentType ? { agentType } : {}),
                        ...(modelOverride ? { modelOverride } : {}),
                        ...(attachments?.length ? { attachments } : {}),
                        rejectIfBusy: true,
                        connectorDeliveryTarget: {
                            requestId,
                            conversationId,
                            ...(provider ? { provider } : {}),
                            ...(externalMessageId ? { externalMessageId } : {}),
                        },
                    }, {
                        // Startup was joined before the final lease pulse; do
                        // not introduce another awaited startup window here.
                        ensureWorker: false,
                        recordActivity: true,
                        // A retry would be a second physical execution under an
                        // ambiguous transport failure. Lease recovery, not the
                        // worker transport, owns any replay decision.
                        retryOnceOnDisconnect: false,
                    });
                    if (binding.cancelRequested || signal.aborted) {
                        void cancelAndJoinRun();
                    }
                    const workerOutcome = workerRunPromise.then((workerResult) => ({ kind: "result", result: workerResult }), (error) => ({ kind: "error", error }));
                    const workerOrCancel = await Promise.race([
                        workerOutcome,
                        binding.cancelJoinedPromise.then(() => ({ kind: "cancelled" })),
                    ]);
                    if (workerOrCancel.kind === "cancelled") {
                        // A positive exact cancel ACK joins the run scope. The
                        // outer JSON-RPC response may still be stuck in a lost
                        // transport, but no provider/tool execution can survive.
                        binding.workerSettled = true;
                        return {
                            status: "error",
                            finalText: "",
                            error: "Remote-turn execution was cancelled.",
                        };
                    }
                    if (workerOrCancel.kind === "error") {
                        binding.transportAmbiguous = true;
                        const joined = await cancelAndJoinRun();
                        if (!joined) {
                            return {
                                status: "uncertain",
                                finalText: "",
                                error: workerOrCancel.error instanceof Error
                                    ? workerOrCancel.error.message
                                    : String(workerOrCancel.error),
                            };
                        }
                        throw workerOrCancel.error;
                    }
                    result = workerOrCancel.result;
                    binding.workerSettled = true;
                    if (binding.cancelJoinPromise) {
                        await binding.cancelJoinPromise;
                    }
                    if (!signal.aborted && !binding.cancelRequested && result.status === "ok" && result.finalText) {
                        await this.appendLocalChatEvent({
                            conversationId: localConversationId,
                            type: "assistant_message",
                            payload: { text: result.finalText, source: "connector" },
                        });
                    }
                    completedSuccessfully = !signal.aborted &&
                        !binding.cancelRequested &&
                        result.status === "ok";
                    return result;
                }
                finally {
                    signal.removeEventListener("abort", handleAttemptAbort);
                    if (!binding.workerRequestSent) {
                        binding.workerSettled = true;
                    }
                    if (binding.cancelJoinPromise) {
                        await binding.cancelJoinPromise;
                    }
                    if (!completedSuccessfully) {
                        this.rollbackRemoteTurnConnectorTarget(binding);
                    }
                    if (this.isCurrentRemoteTurnAttempt(binding)) {
                        this.remoteTurnAttemptsByRequestId.delete(requestId);
                    }
                    if (this.pendingRemoteTurnCancelsByRequestId.get(requestId) === attemptId) {
                        this.pendingRemoteTurnCancelsByRequestId.delete(requestId);
                    }
                }
            },
            claimRemoteTurn: async ({ requestId, attemptId, conversationId }) => {
                const client = this.ensureHostConvexClient();
                if (!client) {
                    throw new Error("Missing Convex client configuration.");
                }
                return await client.mutation(anyApi.channels.connector_delivery.claimRemoteTurn, {
                    requestId,
                    conversationId,
                    deviceId: remoteTurnDeviceId,
                    attemptId,
                });
            },
            heartbeatRemoteTurn: async ({ requestId, attemptId, conversationId }) => {
                const client = this.ensureHostConvexClient();
                if (!client) {
                    throw new Error("Missing Convex client configuration.");
                }
                return await client.mutation(anyApi.channels.connector_delivery.heartbeatRemoteTurn, {
                    requestId,
                    conversationId,
                    deviceId: remoteTurnDeviceId,
                    attemptId,
                });
            },
            completeConnectorTurn: async ({ requestId, attemptId, conversationId, text, }) => {
                const client = this.ensureHostConvexClient();
                if (!client) {
                    throw new Error("Missing Convex client configuration.");
                }
                const ack = await client.mutation(anyApi.channels.connector_delivery.completeRemoteTurn, {
                    requestId,
                    conversationId,
                    deviceId: remoteTurnDeviceId,
                    attemptId,
                    text,
                });
                if (!ack || ack.accepted !== true) {
                    throw new Error("Remote-turn completion did not return an exact-attempt ACK.");
                }
            },
            finishRemoteTurnAttempt: async ({ requestId, attemptId, conversationId, outcome, }) => {
                const client = this.ensureHostConvexClient();
                if (!client) {
                    throw new Error("Missing Convex client configuration.");
                }
                const ack = await client.mutation(anyApi.channels.connector_delivery.finishRemoteTurnAttempt, {
                    requestId,
                    conversationId,
                    deviceId: remoteTurnDeviceId,
                    attemptId,
                    outcome,
                });
                if (!ack || ack.acknowledged !== true) {
                    throw new Error("Remote-turn terminal mutation did not return an exact-attempt ACK.");
                }
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
    async syncHostExecutionPlacement() {
        const operation = this.hostExecutionPlacementSyncQueue.then(() => this.syncHostExecutionPlacementNow());
        this.hostExecutionPlacementSyncQueue = operation.then(() => undefined, () => undefined);
        return await operation;
    }
    async syncHostExecutionPlacementNow() {
        const eligible = isExecutionPlacementEligible({
            started: this.started,
            hostReady: this.hostReady,
            deviceIdentity: this.deviceIdentity,
            hasDatabase: Boolean(this.connectorFollowupDatabase),
            hasConnectedAccount: this.configCache.hasConnectedAccount,
            cloudSyncEnabled: this.configCache.cloudSyncEnabled,
            authToken: this.getConfiguredHostAuthToken(),
            convexUrl: this.getConfiguredHostConvexUrl(),
            canSignDeviceInput: typeof this.options.hostHandlers.signDeviceInput === "function",
        });
        const client = eligible ? this.ensureHostConvexClient() : null;
        if (this.hostExecutionPlacementBridge &&
            client &&
            this.hostExecutionPlacementBridge.client === client &&
            this.hostExecutionPlacementBridge.isRunning) {
            return;
        }
        const previous = this.hostExecutionPlacementBridge;
        this.hostExecutionPlacementBridge = null;
        if (previous) {
            try {
                await previous.stop();
            }
            catch (error) {
                // Keep the stopped bridge as the only retry owner. A later sync
                // must finish its durable cancellation/drain barrier before it
                // can establish a replacement proof sequence.
                this.hostExecutionPlacementBridge = previous;
                throw error;
            }
        }
        if (!eligible || !client || !this.connectorFollowupDatabase) {
            return;
        }
        const bridge = createExecutionPlacementBridge({
            client,
            database: this.connectorFollowupDatabase,
            deviceIdentity: this.deviceIdentity,
            // The Ed25519 device key never enters the host. Electron main (or
            // the headless host) signs the presence nonce through the same
            // delegate the worker's DPoP path uses.
            signPresenceProof: async (message) => {
                const signed = await this.options.hostHandlers.signDeviceInput(message);
                if (!signed || typeof signed.signature !== "string" || !signed.signature) {
                    throw new Error("Stella device signing returned no signature.");
                }
                return signed.signature;
            },
            appVersion: "stella-desktop-v2",
            deviceName: hostname().trim().slice(0, 96) || undefined,
            platform: process.platform,
            getAuthToken: () => this.getConfiguredHostAuthToken(),
            getAvailability: async () => {
                const health = await this.getWorkerHealth({
                    ensureWorker: false,
                }).catch(() => null);
                const platformCapabilities = process.platform === "darwin" || process.platform === "win32"
                    ? ["computer-use", "local-apps"]
                    : [];
                return {
                    ready: Boolean(this.started &&
                        this.hostReady &&
                        this.configCache.hasConnectedAccount &&
                        this.configCache.cloudSyncEnabled &&
                        !isWorkerBusyForRestart(health)),
                    chatSlots: 1,
                    agentSlots: 1,
                    capabilities: [
                        "chat",
                        "agent",
                        "local-files",
                        "attachments",
                        ...platformCapabilities,
                    ],
                };
            },
            runExecution: async ({ dispatch, payload, ownerGeneration }) => {
                const prompt = typeof payload.prompt === "string" ? payload.prompt.trim() : "";
                if (!prompt) {
                    return {
                        status: "error",
                        error: "The accepted execution payload did not contain a prompt.",
                    };
                }
                // The cloud journal echoes this id as the turn's clientMsgId, and
                // mobile binds its optimistic bubble to the dispatch id, so the
                // two must be the same string or the phone shows the user row twice.
                const userMessageEventId = typeof payload.userMessageEventId === "string" && payload.userMessageEventId.trim()
                    ? payload.userMessageEventId.trim()
                    : dispatch.dispatchId;
                const attachments = await resolvePlacementAttachments({
                    paths: placementAttachmentPaths(payload),
                    resolve: async (path) => await client.action(anyApi.cloud_drive.getMyDriveFileUrl, { path }),
                    onSkipped: (path, error) => console.warn(`[execution-placement] attachment ${path} could not be resolved from the drive.`, error),
                });
                await this.appendLocalChatEvent({
                    conversationId: dispatch.conversationId,
                    eventId: userMessageEventId,
                    type: "user_message",
                    payload: {
                        text: prompt,
                        source: "execution-placement",
                        dispatchId: dispatch.dispatchId,
                    },
                });
                if (dispatch.kind === "agent") {
                    const description = typeof payload.description === "string" &&
                        payload.description.trim()
                        ? payload.description.trim()
                        : prompt.slice(0, 160);
                    const result = await this.requestWorker(METHOD_NAMES.INTERNAL_WORKER_RUN_BLOCKING_AGENT, {
                        conversationId: dispatch.conversationId,
                        description,
                        prompt,
                        agentType: "general",
                        threadId: placementLocalAgentThreadId(dispatch.dispatchId),
                    }, {
                        ensureWorker: true,
                        recordActivity: true,
                        retryOnceOnDisconnect: false,
                    });
                    return result.status === "ok"
                        ? { status: "ok", finalText: result.finalText }
                        : {
                            status: "error",
                            error: result.error || "The local agent failed.",
                        };
                }
                const result = await this.requestWorker(METHOD_NAMES.INTERNAL_WORKER_RUN_AUTOMATION, {
                    conversationId: dispatch.conversationId,
                    userPrompt: prompt,
                    userMessageEventId,
                    rejectIfBusy: true,
                    executionPlacementRunId: placementLocalChatRunId(dispatch.dispatchId),
                    ownerGeneration,
                    ...(attachments.length > 0 ? { attachments } : {}),
                }, {
                    ensureWorker: true,
                    recordActivity: true,
                    retryOnceOnDisconnect: false,
                });
                if (result.status === "ok") {
                    if (result.finalText) {
                        await this.appendLocalChatEvent({
                            conversationId: dispatch.conversationId,
                            eventId: `placement-assistant:${dispatch.dispatchId}`,
                            type: "assistant_message",
                            payload: {
                                text: result.finalText,
                                source: "execution-placement",
                                dispatchId: dispatch.dispatchId,
                            },
                        });
                    }
                    return { status: "ok", finalText: result.finalText };
                }
                return {
                    status: "error",
                    error: result.error || "The local execution failed.",
                };
            },
            cancelExecution: async ({ dispatchId, kind, conversationId }) => {
                if (kind === "agent") {
                    const result = await this.cancelBlockingLocalAgent(placementLocalAgentThreadId(dispatchId), "Canceled by execution placement.");
                    if (result?.canceled !== true) {
                        throw new Error("The exact local-agent cancellation was not acknowledged.");
                    }
                    return;
                }
                const result = await this.cancelPlacementAutomation(placementLocalChatRunId(dispatchId), "Canceled by execution placement.");
                if (result?.canceled !== true) {
                    throw new Error("The exact local-chat cancellation was not acknowledged.");
                }
            },
            log: (level, message, error) => {
                const logger = level === "error" ? console.error : console.warn;
                if (error === undefined) {
                    logger(`[execution-placement] ${message}`);
                }
                else {
                    logger(`[execution-placement] ${message}`, error);
                }
            },
        });
        this.hostExecutionPlacementBridge = bridge;
        try {
            await bridge.start();
        }
        catch (error) {
            if (this.hostExecutionPlacementBridge === bridge) {
                this.hostExecutionPlacementBridge = null;
            }
            try {
                await bridge.stop();
            }
            catch (stopError) {
                this.hostExecutionPlacementBridge = bridge;
                throw new Error("Execution placement startup cleanup did not reach its cancellation/drain barrier.", { cause: stopError });
            }
            console.warn("[execution-placement] Desktop placement bridge did not start.", error);
        }
    }
    async sendConnectorFollowup(args) {
        const client = this.ensureHostConvexClient();
        if (!client)
            throw new Error("Missing Convex client configuration.");
        // `args.deliveryId` keys the durable outbox row; dedup stays host-side
        // because the deployed connector_delivery.sendConnectorFollowup
        // mutation does not accept a deliveryId argument yet.
        await client.mutation(anyApi.channels.connector_delivery.sendConnectorFollowup, {
            requestId: args.requestId,
            conversationId: args.backendConversationId,
            text: args.text,
        });
    }
    resolveConnectorFollowupTarget(conversationId) {
        const cached = this.connectorTargetsByLocalConversation.get(conversationId) ?? null;
        if (cached)
            return cached;
        const durable = this.connectorFollowupOutbox?.targetForConversation(conversationId) ??
            null;
        if (durable) {
            this.connectorTargetsByLocalConversation.set(conversationId, durable);
        }
        return durable;
    }
    resolveConnectorConversationForRequest(requestId) {
        const cached = this.localConversationByRequestId.get(requestId) ?? null;
        if (cached)
            return cached;
        const route = this.connectorFollowupOutbox?.routeForRequest(requestId);
        if (!route)
            return null;
        this.localConversationByRequestId.set(requestId, route.conversationId);
        this.connectorTargetsByLocalConversation.set(route.conversationId, route);
        return route.conversationId;
    }
    enqueueConnectorFollowup(args) {
        if (!this.connectorFollowupOutbox) {
            throw new Error("Connector follow-up outbox is unavailable.");
        }
        this.connectorFollowupOutbox.enqueue(args.target, args.followup);
    }
    handleConnectorTerminalRunEvent(event) {
        const conversationId = event.conversationId?.trim();
        if (!conversationId)
            return;
        const target = this.resolveConnectorFollowupTarget(conversationId);
        if (!target)
            return;
        const followup = resolveConnectorTerminalFollowup(event, target.requestId);
        if (!followup)
            return;
        this.enqueueConnectorFollowup({ target, followup });
    }
    handleLocalChatUpdateForConnectorFollowup(payload) {
        if (!payload)
            return;
        const conversationId = payload.conversationId;
        if (!conversationId || !payload.event)
            return;
        const target = this.resolveConnectorFollowupTarget(conversationId);
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
                this.connectorFollowupOutbox?.clearTarget(conversationId);
                if (cleared) {
                    this.localConversationByRequestId.delete(cleared.requestId);
                }
                return;
            }
            case "send":
                this.enqueueConnectorFollowup({
                    target,
                    followup: {
                        deliveryId: connectorLocalFollowupDeliveryId(target.requestId, payload.event._id, action.text),
                        text: action.text,
                    },
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
                const activeAttemptId = typeof row?.activeAttemptId === "string"
                    ? row.activeAttemptId
                    : "";
                if (!requestId || !activeAttemptId)
                    continue;
                const cancelKey = `${requestId}:${activeAttemptId}`;
                if (this.cancelledRequestIds.has(cancelKey))
                    continue;
                const binding = this.remoteTurnAttemptsByRequestId.get(requestId);
                if (!binding) {
                    // Cancellation can arrive after the server claim but before
                    // runLocalTurn binds the local attempt. Preserve the exact
                    // attempt and let that binding consume it before dispatch.
                    this.pendingRemoteTurnCancelsByRequestId.set(requestId, activeAttemptId);
                    continue;
                }
                if (binding.attemptId !== activeAttemptId)
                    continue;
                binding.cancelRequested = true;
                void this.requestRemoteTurnCancellation(binding)
                    .then((joined) => {
                    if (!joined)
                        return;
                    this.cancelledRequestIds.add(cancelKey);
                    this.rollbackRemoteTurnConnectorTarget(binding);
                    if (this.pendingRemoteTurnCancelsByRequestId.get(requestId) === activeAttemptId) {
                        this.pendingRemoteTurnCancelsByRequestId.delete(requestId);
                    }
                })
                    .catch((error) => {
                    console.warn("[runtime-host] Exact remote-turn cancellation failed:", error instanceof Error ? error.message : String(error));
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
        await this.syncHostExecutionPlacement();
        this.events.emit("runtime-connected", undefined);
        this.events.emit("runtime-ready", await this.health());
        this.startDevWatcher(resolveDefaultWorkerEntryPath(this.options));
    }
    async stop(options) {
        if (options?.killWorker) {
            this.writeRestartContinuationRecord(this.pendingStaleWorkerRestart?.reason ?? "app-shutdown");
        }
        this.started = false;
        this.hostReady = false;
        // Abort the leased remote attempt while the worker peer is still live.
        // Its exact cancel/join (or worker retirement) must begin before the
        // normal detached-worker disconnect/drain below.
        this.hostRemoteTurnBridge?.stop();
        this.workerHealthCache = null;
        this.workerGeneration = 0;
        this.agentEventBuffers.clear();
        this.pendingRunEventAcks.clear();
        this.runEventAckTimer?.cancel();
        this.runEventAckTimer = null;
        this.deferredRuntimeReload = false;
        this.restartInProgress = false;
        this.restartRequestedDuringRestart = false;
        // The on-disk pending-restart flag intentionally survives host stop so
        // the next host's reconnect handshake picks the deferral back up.
        this.pendingStaleWorkerRestart = null;
        this.stopStaleWorkerQuiescencePoll();
        this.reloadTimer?.cancel();
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
        // Configuration/auth changes are a recovery edge: retry eligible durable
        // connector rows now instead of waiting out an old offline backoff.
        this.connectorFollowupOutbox?.resume(true);
        this.syncHostRemoteTurnBridge();
        await this.syncHostExecutionPlacement();
        const connection = this.workerController.getConnection();
        if (!connection?.peer) {
            return { ok: true };
        }
        return await connection.peer.request(METHOD_NAMES.INTERNAL_WORKER_CONFIGURE, params);
    }
    async health() {
        return await this.buildHealthSnapshot();
    }
    async restartWorker(reason = "runtime-reload") {
        const startedAt = Date.now();
        this.events.emit("runtime-reloading", { reason: "worker-restart" });
        this.writeRestartContinuationRecord(reason);
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
    emitPlacedRunEvent(event) {
        bufferAgentEvent(this.agentEventBuffers, event);
        pruneAgentEventBuffers(this.agentEventBuffers);
        this.events.emit("run-event", event);
    }
    async readPlacedAttachment(attachment) {
        const source = typeof attachment?.url === "string" ? attachment.url.trim() : "";
        if (!source) throw new Error("A remote attachment is missing its source.");
        let bytes;
        let inferredName = typeof attachment.name === "string" ? attachment.name.trim() : "";
        let contentType = typeof attachment.mimeType === "string" && attachment.mimeType.trim() ? attachment.mimeType.trim() : "application/octet-stream";
        const dataMatch = source.match(/^data:([^;,]+)?(?:;base64)?,(.*)$/s);
        if (dataMatch) {
            const encoded = dataMatch[2] ?? "";
            bytes = source.slice(0, source.indexOf(",")).includes(";base64") ? Buffer.from(encoded, "base64") : Buffer.from(decodeURIComponent(encoded), "utf8");
            if (dataMatch[1]) contentType = dataMatch[1];
        } else {
            const filePath = source.startsWith("file:") ? fileURLToPath(source) : source;
            bytes = await fs.readFile(filePath);
            inferredName ||= path.basename(filePath);
        }
        if (bytes.byteLength <= 0 || bytes.byteLength > PLACED_ATTACHMENT_MAX_BYTES) {
            throw new Error("Remote attachments must be between 1 byte and 20 MB.");
        }
        return {
            bytes,
            contentType,
            name: inferredName || "attachment",
        };
    }
    async uploadPlacedAttachments(client, payload, idempotencyKey) {
        const attachments = Array.isArray(payload.attachments) ? payload.attachments.slice(0, 4) : [];
        if (attachments.length === 0) return [];
        const scope = createHash("sha256").update(idempotencyKey).digest("hex").slice(0, 24);
        const uploaded = [];
        for (let index = 0; index < attachments.length; index += 1) {
            const attachment = await this.readPlacedAttachment(attachments[index]);
            const rawExtension = path.extname(attachment.name).toLowerCase();
            const extension = /^\.[a-z0-9]{1,10}$/.test(rawExtension) ? rawExtension : "";
            const drivePath = `execution-attachments/${scope}/${String(index + 1).padStart(2, "0")}${extension}`;
            const prepared = await client.action(anyApi.cloud_drive.prepareDriveUpload, {
                path: drivePath,
                sizeBytes: attachment.bytes.byteLength,
                contentType: attachment.contentType,
            });
            const response = await fetch(prepared.uploadUrl, {
                method: "PUT",
                headers: { "Content-Type": prepared.contentType },
                body: attachment.bytes,
            });
            if (!response.ok) {
                throw new Error(`Remote attachment upload failed (${response.status}).`);
            }
            await client.action(anyApi.cloud_drive.finalizeDriveUpload, {
                path: prepared.path,
                uploadId: prepared.uploadId,
                contentType: prepared.contentType,
                source: "execution-placement",
            });
            uploaded.push(prepared.path);
        }
        return uploaded;
    }
    async startPlacedChat(payload, target) {
        const client = this.ensureHostConvexClient();
        if (!client) {
            throw new Error("Cross-device execution is not ready on this computer.");
        }
        await this.syncHostExecutionPlacement();
        const bridge = this.hostExecutionPlacementBridge;
        if (!bridge?.isRunning) {
            throw new Error("Cross-device execution is not ready on this computer.");
        }
        const idempotencyKey = (payload.userMessageEventId?.trim() || payload.requestId?.trim() || `desktop:${crypto.randomUUID()}`).slice(0, 128);
        const attachments = await this.uploadPlacedAttachments(client, payload, idempotencyKey);
        const selectedText = typeof payload.selectedText === "string" ? payload.selectedText.trim() : "";
        const userPrompt = typeof payload.userPrompt === "string" ? payload.userPrompt.trim() : "";
        const prompt = selectedText ? `${userPrompt || "Please help with this context."}\n\nSelected text:\n${selectedText}` : userPrompt;
        if (!prompt) throw new Error("A prompt is required.");
        // Exactly the bytes the executing device (this one, another computer,
        // or the cloud) receives. The owner gate hashes and hands them over.
        const dispatchPayload = {
            schemaVersion: 1,
            prompt,
            conversationId: payload.conversationId,
            clientMsgId: idempotencyKey,
            userMessageEventId: payload.userMessageEventId ?? idempotencyKey,
            ...(payload.locale ? { locale: payload.locale } : {}),
            ...(attachments.length ? { attachments } : {}),
        };
        const dispatch = await bridge.submitDesktopExecution({
            idempotencyKey,
            requestedTargetMode: target.mode,
            ...(target.mode === "device" ? { requestedExecutorDeviceId: target.deviceId } : {}),
            payload: dispatchPayload,
            kind: "chat",
            subject: "portable",
            conversationId: payload.conversationId,
            requiredCapabilities: ["chat", ...(attachments.length ? ["attachments"] : [])],
        });
        if (!dispatch?.dispatchId) throw new Error("Execution placement returned an invalid dispatch.");
        const runId = `placed:${dispatch.dispatchId}`;
        const requestId = payload.requestId;
        const userMessageId = payload.userMessageEventId ?? idempotencyKey;
        let lastRevision = -1;
        let terminal = false;
        const placed = {
            dispatchId: dispatch.dispatchId,
            runId,
            requestId,
            conversationId: payload.conversationId,
            userMessageId,
            subscription: null,
        };
        this.placedDispatchByRunId.set(runId, placed);
        this.emitPlacedRunEvent({
            type: AGENT_STREAM_EVENT_TYPES.RUN_STARTED,
            seq: SYNTHETIC_RUN_EVENT_SEQ_FLOOR + 1,
            runId,
            requestId,
            conversationId: payload.conversationId,
            userMessageId,
            agentType: "orchestrator",
        });
        const finish = (status) => {
            if (terminal) return;
            terminal = true;
            placed.subscription?.unsubscribe();
            this.placedDispatchByRunId.delete(runId);
            const outcome = status.state === "completed" ? "completed" : status.state === "canceled" ? "canceled" : "error";
            this.emitPlacedRunEvent({
                type: AGENT_STREAM_EVENT_TYPES.RUN_FINISHED,
                seq: Number.MAX_SAFE_INTEGER,
                runId,
                requestId,
                conversationId: payload.conversationId,
                userMessageId,
                agentType: "orchestrator",
                outcome,
                persisted: true,
                ...(status.errorMessage ? { error: status.errorMessage, reason: status.errorMessage } : {}),
            });
        };
        const onStatus = (status) => {
            if (!status || status.dispatchId !== dispatch.dispatchId || terminal) return;
            // The placement run ends at hand-off. The conversation socket
            // owns the cloud turn's subsequent liveness and cancellation.
            // Balance RUN_STARTED so desktop replay cannot retain a phantom run.
            if (isCloudHandedOff(status)) {
                finish({ state: "completed" });
                return;
            }
            if (Number.isFinite(status.revision) && status.revision > lastRevision) {
                lastRevision = status.revision;
                const statusText = status.state === "offering" || status.state === "computer_claimed" ? "Connecting" : status.state === "computer_accepted" || status.state === "computer_running" || status.state === "cloud_running" ? "Working" : status.state === "cloud_committed" ? "Starting" : null;
                if (statusText) {
                    this.emitPlacedRunEvent({
                        type: AGENT_STREAM_EVENT_TYPES.STATUS,
                        seq: SYNTHETIC_RUN_EVENT_SEQ_FLOOR + 2 + lastRevision,
                        runId,
                        requestId,
                        conversationId: payload.conversationId,
                        userMessageId,
                        statusText,
                    });
                }
            }
            if (["completed", "failed", "canceled"].includes(status.state)) finish(status);
        };
        placed.subscription = bridge.watchDispatch(dispatch.dispatchId, onStatus);
        onStatus(dispatch);
        // Cloud admission journals the placement dispatch id, rather than the
        // desktop's optimistic id. Return that identity to the sending renderer.
        return { runId, userMessageId: target.mode === "cloud" ? dispatch.dispatchId : userMessageId };
    }
    async healthCheck() {
        const health = await this.getWorkerHealth({ ensureWorker: false });
        return health?.health ?? null;
    }
    async getActiveRun() {
        const placed = this.placedDispatchByRunId.values().next().value;
        if (placed) {
            return {
                runId: placed.runId,
                conversationId: placed.conversationId,
                requestId: placed.requestId,
                userMessageId: placed.userMessageId,
            };
        }
        const health = await this.getWorkerHealth({ ensureWorker: false });
        return health?.activeRun ?? null;
    }
    async listActiveRuns() {
        try {
            const local = await this.requestWorker(METHOD_NAMES.INTERNAL_WORKER_LIST_ACTIVE_RUNS, {}, { ensureWorker: false, recordActivity: false });
            return {
                ...local,
                runs: [
                    ...(local?.runs ?? []),
                    ...[...this.placedDispatchByRunId.values()].map((placed) => ({
                        runId: placed.runId,
                        conversationId: placed.conversationId,
                        requestId: placed.requestId,
                        userMessageId: placed.userMessageId,
                    })),
                ],
            };
        }
        catch {
            return {
                runs: [...this.placedDispatchByRunId.values()].map((placed) => ({
                    runId: placed.runId,
                    conversationId: placed.conversationId,
                    requestId: placed.requestId,
                    userMessageId: placed.userMessageId,
                })),
            };
        }
    }
    async listModels(request = {}) {
        return await this.requestWorker(METHOD_NAMES.INTERNAL_WORKER_LIST_MODELS, request, { ensureWorker: true, recordActivity: false });
    }
    async startChat(payload) {
        const priorConnectorTarget = this.resolveConnectorFollowupTarget(payload.conversationId);
        if (priorConnectorTarget) {
            this.connectorTargetsByLocalConversation.delete(payload.conversationId);
            this.connectorFollowupOutbox?.clearTarget(payload.conversationId);
            this.localConversationByRequestId.delete(priorConnectorTarget.requestId);
        }
        const target = payload.executionTarget && typeof payload.executionTarget === "object"
            ? payload.executionTarget
            : { mode: "automatic" };
        if (target.mode === "cloud") {
            return await this.startPlacedChat(payload, { mode: "cloud" });
        }
        if (target.mode === "device" && typeof target.deviceId === "string" && target.deviceId.trim() && target.deviceId.trim() !== this.deviceIdentity?.deviceId) {
            return await this.startPlacedChat(payload, {
                mode: "device",
                deviceId: target.deviceId.trim(),
            });
        }
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
        const placed = this.placedDispatchByRunId.get(runId);
        if (placed) {
            const bridge = this.hostExecutionPlacementBridge;
            if (!bridge)
                throw new Error("Execution placement is unavailable.");
            await bridge.cancelDispatch({
                dispatchId: placed.dispatchId,
                cancelRequestId: `cancel:${placed.dispatchId}`,
                reason: "Canceled by the user.",
            });
            return { ok: true, cancelled: true };
        }
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
            this.runEventAckTimer.cancel();
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
        this.runEventAckTimer = forkDelayed(150, () => {
            this.flushRunEventAcks();
        });
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
    async cancelBlockingLocalAgent(agentId, reason) {
        return await this.requestWorker(METHOD_NAMES.INTERNAL_WORKER_CANCEL_BLOCKING_AGENT, { agentId, reason }, {
            ensureWorker: true,
            recordActivity: true,
        });
    }
    async cancelPlacementAutomation(runId, reason) {
        return await this.requestWorker(METHOD_NAMES.INTERNAL_WORKER_CANCEL_PLACEMENT_AUTOMATION, { runId, reason }, {
            ensureWorker: true,
            recordActivity: true,
            retryOnceOnDisconnect: false,
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
        const ConnectorDatabase = loadSqliteDatabaseCtorSync();
        const connectorDatabase = new ConnectorDatabase(getDesktopDatabasePath(this.options.initializeParams.stellaDataDirPath));
        initializeDesktopDatabase(connectorDatabase);
        this.connectorFollowupDatabase = connectorDatabase;
        this.connectorFollowupOutbox = new ConnectorFollowupOutbox({
            database: connectorDatabase,
            deliver: async (entry) => await this.sendConnectorFollowup(entry),
        });
        this.connectorFollowupOutbox.resume(true);
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
        for (const placed of this.placedDispatchByRunId.values()) {
            placed.subscription?.unsubscribe();
        }
        this.placedDispatchByRunId.clear();
        await this.hostExecutionPlacementSyncQueue;
        await this.hostExecutionPlacementBridge?.stop();
        this.hostExecutionPlacementBridge = null;
        await this.connectorFollowupOutbox?.stop();
        this.connectorFollowupOutbox = null;
        this.connectorFollowupDatabase?.close();
        this.connectorFollowupDatabase = null;
        this.connectorTargetsByLocalConversation.clear();
        this.localConversationByRequestId.clear();
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
        peer.registerRequestHandler(HOST_CHALLENGE_TOKEN_METHOD, async () => {
            return ((await this.options.hostHandlers.getChallengeToken?.()) ?? null);
        });
        peer.registerRequestHandler(HOST_DEVICE_SIGNING_METHOD, async (params) => {
            const input = typeof params?.input === "string" ? params.input : "";
            if (!input || input.length > MAX_DEVICE_SIGNING_INPUT_LENGTH) {
                throw new Error("Invalid Stella device signing input.");
            }
            if (!isDelegatedDeviceSigningInput(input)) {
                throw new Error("Blocked device signing input outside the DPoP contract.");
            }
            if (!this.options.hostHandlers.signDeviceInput) {
                throw new Error("Stella device signing is not available.");
            }
            return await this.options.hostHandlers.signDeviceInput(input);
        });
        peer.registerRequestHandler(METHOD_NAMES.HOST_REMOTE_TURN_ADMIT, async (params) => {
            return this.admitRemoteTurnAttempt(params);
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
            this.handleConnectorTerminalRunEvent(payload);
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
                    forkDelayed(500, () => {
                        void this.flushWorkerRestart();
                    });
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
        peer.registerNotificationHandler(NOTIFICATION_NAMES.THREAD_TRANSCRIPT_UPDATED, (params) => {
            this.events.emit("thread-transcript-updated", params);
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
