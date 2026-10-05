import { EventEmitter } from "node:events";
import { existsSync, promises as fs, readFileSync, } from "node:fs";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { hostname } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { BackendClient, BackendRequestError } from "@stella/contracts/backend/client";
import { resolveBundledRuntimeFile } from "../kernel/shared/runtime-paths.js";
import { getFileLogger } from "../observability/file-logger.js";
import { isRestartContinuationEnabled, recordRestartShutdown, } from "../kernel/restart-continuation.js";
import { LocalSchedulerService } from "../kernel/local-scheduler-service.js";
import { createCloudSchedules, isCloudScheduleId, isCloudSchedulePayload, } from "./cloud-schedules.js";
import { createScheduleScriptAuthEnv } from "../kernel/shared/schedule-scripts.js";
import { AGENT_STREAM_EVENT_TYPES } from "@stella/contracts/agent-runtime";
import { createExecutionPlacementBridge, placementLocalAgentThreadId, placementLocalChatRunId, placementRemoteThreadAgentId, } from "./execution-placement-bridge.js";
import { isExecutionPlacementEligible } from "./execution-placement-eligibility.js";
import { isCloudHandedOff } from "./placed-dispatch.js";
import { AGENT_RUN_RPC_OPTIONS } from "./agent-run-request.js";
import { placementAttachmentPaths, resolvePlacementAttachments, } from "./placement-attachments.js";
import { getDesktopDatabasePath, initializeDesktopDatabase, } from "../kernel/storage/database-init.js";
import { METHOD_NAMES, NOTIFICATION_NAMES, STELLA_RUNTIME_PROTOCOL_VERSION, } from "@stella/contracts/protocol";
import { createRuntimeUnavailableError, } from "@stella/contracts/protocol/rpc-peer";
import { RuntimeWorkerLifecycleController, } from "./worker-lifecycle.js";
import { buildStdioConnectionFactory } from "./stdio-connection.js";
import { buildInprocConnectionFactory } from "./inproc-connection.js";
import { resolveRuntimePaths } from "../worker/runtime-paths.js";
import { Cause, Exit, Fiber } from "effect";
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
const PLACED_ATTACHMENT_MAX_BYTES = 20 * 1024 * 1024;
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
    (health.voiceBusy === true ||
        (health.pendingVoiceRequestCount ?? 0) > 0 ||
        // A worker with durable runs reports what a restart would actually
        // interrupt: an unsafe tool call in flight, or an active run that
        // would not resume (`run-task.ts`). Durable runs resume in the
        // replacement worker, so they no longer hold the restart. Older
        // workers without the report keep the conservative rule.
        (health.durableRestart
            ? health.durableRestart.blocked === true
            : health.activeRun != null || health.activeAgentCount > 0));
export const shouldAckWorkerRunEvent = (event) => {
    if (!Number.isFinite(event.seq))
        return false;
    if (event.seq >= SYNTHETIC_RUN_EVENT_SEQ_FLOOR)
        return false;
    return event.type !== AGENT_STREAM_EVENT_TYPES.RUN_FINISHED;
};
/**
 * The host's event bus, plus a tap on every event so the runtime can forward
 * them to its clients without keeping a list of names.
 */
class HostEvents extends EventEmitter {
    anyListeners = new Set();
    emit(eventName, ...args) {
        for (const listener of this.anyListeners) {
            try {
                listener(eventName, args[0]);
            }
            catch (error) {
                console.error("[runtime-host] event tap failed:", error);
            }
        }
        return super.emit(eventName, ...args);
    }
}
export class StellaRuntimeHost {
    options;
    workerMode = "child";
    events = new HostEvents();
    agentEventBuffers = new Map();
    workerController;
    workerHealthCache = null;
    schedulerService = null;
    schedulerSubscription = null;
    cloudScheduleUnsubscribe = null;
    cloudSchedules = null;
    reloadTimer = null;
    /** Debounced restart re-check at a tool boundary (see RUN_EVENT handler). */
    durableBoundaryFlushTimer = null;
    deferredRuntimeReload = false;
    // Coalescing for the requested-reload path only: while a
    // scheduled reload's restart is queued or running, further reload requests
    // collapse into a single trailing re-run instead of stacking one full restart
    // per request. This does NOT guard direct restartWorker() callers (e.g.
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
    staleWorkerFrameDrops = 0;
    started = false;
    hostReady = false;
    hostBackendClient = null;
    hostBackendClientUrl = null;
    /** Backend URL and token the signed-in host services last synchronized for. */
    hostAccountServicesKey = null;
    hostExecutionPlacementBridge = null;
    hostExecutionPlacementSyncQueue = Promise.resolve();
    placedDispatchByRunId = new Map();
    pendingRunEventAcks = new Map();
    runEventAckTimer = null;
    /** The desktop database the execution placement bridge keeps its proofs in. */
    hostDatabase = null;
    constructor(options) {
        this.options = options;
        // "inproc": the worker shares this process. That is the runtime
        // process, where the host runs for the desktop, and restarting the
        // worker restarts the process. "child" (default): a private stdio
        // worker owned by this host, for headless and test hosts.
        this.workerMode = this.options.workerMode === "inproc" ? "inproc" : "child";
        const onWorkerRpcError = (error) => {
            console.error("[runtime-host] worker RPC error:", error);
        };
        const createConnectionAsync = this.workerMode === "inproc"
            ? buildInprocConnectionFactory(this.options.inprocWorker.attach, {
                onError: onWorkerRpcError,
            })
            : buildStdioConnectionFactory({
                ...(process.env.STELLA_BUN_PATH?.trim()
                    ? { bunBinaryPath: process.env.STELLA_BUN_PATH.trim() }
                    : {}),
                onError: onWorkerRpcError,
            });
        this.workerController = new RuntimeWorkerLifecycleController({
            workerEntryPath: resolveDefaultWorkerEntryPath(this.options),
            isHostStarted: () => this.started,
            // A child worker is owned by this host, so every stop kills it. An
            // in-process worker only detaches; nothing outlives the process.
            killWorkerOnStop: this.workerMode === "inproc" ? () => false : () => true,
            createConnectionAsync,
            initializeConnection: async (connection) => {
                // Fence every worker frame to this connection: once it is no
                // longer the controller's live one (stopped, replaced, exited),
                // its late notifications and callbacks are dropped, not applied.
                const fencedPeer = this.fenceWorkerPeer(connection.peer);
                this.registerHostHandlers(fencedPeer);
                this.registerNotifications(fencedPeer);
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
     * In the runtime process, the host and its services (the scheduler and
     * execution placement) run beside the worker and keep running while the app restarts. Only the
     * callbacks that need the app wait for it to reattach.
     */
    /**
     * The app applied an update that changed runtime code: restart the
     * runtime as soon as it is idle (between turns).
     */
    async requestRuntimeRestart() {
        this.scheduleRuntimeReload();
        return { ok: true };
    }
    /**
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
     * The runtime process survives app restarts by design, so without this
     * machinery runtime code changes would never reach it.
     *
     * When an app attaches we compare the process's boot-time build stamp with
     * the on-disk runtime tree. Stale + idle => restart now. Stale + busy =>
     * mark "restart pending" (persisted, survives further app restarts) and
     * restart the moment the runtime goes quiescent, checked on every
     * RUN_FINISHED plus a slow safety poll. Deferral means in-flight work is
     * never killed.
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
    async evaluateWorkerStalenessOnConnect(_connection) {
        if (this.workerMode === "child") {
            // A stdio child always runs the current on-disk code, and the
            // on-disk pending-restart bookkeeping belongs to the desktop's
            // runtime process; an ephemeral headless host leaves it alone.
            return;
        }
        // This process just started its worker, so it runs the code on disk:
        // a restart deferred by the previous runtime process is satisfied.
        await this.clearPendingWorkerRestart();
    }
    /**
     * In-process mode: a client just attached, possibly an app updated since
     * this runtime started. Compare the code this process loaded with the
     * tree on disk and schedule a restart for when the runtime is idle.
     */
    async checkRuntimeStaleness() {
        if (this.workerMode !== "inproc" || !this.started)
            return;
        const verdict = await hostRuntime.runPromise(evaluateWorkerStaleness({
            attachedToExistingWorker: true,
            paths: this.getRuntimeControlPaths(),
            workerEntryPath: resolveDefaultWorkerEntryPath(this.options),
        }));
        if (!verdict.stale ||
            (verdict.reason === "pending-restart-flag" && this.pendingStaleWorkerRestart)) {
            return;
        }
        getFileLogger()?.process("host.runtime-stale-detected", {
            reason: verdict.reason,
        });
        await this.markPendingWorkerRestart(verdict.reason);
    }
    /**
     * Unified gate for restarting the runtime worker. A restart may only proceed
     * when the worker is not busy (an agent run / voice request is in flight).
     * Both restart triggers (a requested restart, stale-worker detection)
     * and every unblock hook route through this, so a requested restart honors
     * the worker-busy deferral exactly like the stale-worker path.
     */
    canRestartWorkerNow(health = this.workerHealthCache) {
        return !isWorkerBusyForRestart(health);
    }
    /**
     * Whether some trigger wants the worker restarted: a requested runtime
     * restart (`deferredRuntimeReload`) or a persisted stale-worker restart
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
                // Consume the requested intent before the replacement worker starts.
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
                    // A failed restart did not satisfy the request. Preserve it
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
    getConfiguredHostBackendUrl() {
        const value = (this.configCache.backendUrl ?? process.env.STELLA_BACKEND_URL ?? "").trim().replace(/\/+$/, "");
        return /^https?:\/\//.test(value) ? value : null;
    }
    disposeHostBackendClient() {
        this.hostBackendClient?.dispose();
        this.hostBackendClient = null;
        this.hostBackendClientUrl = null;
    }
    /** The backend worker client for owner-object calls; the token is read per request. */
    ensureHostBackendClient() {
        const baseUrl = this.getConfiguredHostBackendUrl();
        if (!baseUrl) {
            this.disposeHostBackendClient();
            return null;
        }
        if (this.hostBackendClient && this.hostBackendClientUrl === baseUrl) {
            return this.hostBackendClient;
        }
        this.disposeHostBackendClient();
        this.hostBackendClient = new BackendClient({
            baseUrl,
            getToken: async () => this.getConfiguredHostAuthToken() || null,
        });
        this.hostBackendClientUrl = baseUrl;
        return this.hostBackendClient;
    }
    /** Follows the owner's schedules on the current client (and sign-in). */
    resubscribeCloudSchedules() {
        this.cloudScheduleUnsubscribe?.();
        this.cloudScheduleUnsubscribe = null;
        if (!this.schedulerService || !this.hostAccountServicesKey)
            return;
        this.cloudScheduleUnsubscribe = this.getCloudSchedules().subscribe(() => {
            this.events.emit("schedule-updated", undefined);
        });
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
        const client = this.getConfiguredHostAuthToken() ? this.ensureHostBackendClient() : null;
        if (!client) {
            return;
        }
        try {
            await client.call("devices.adoptSuccession", {
                previousDeviceId,
                deviceId,
            });
        }
        catch (error) {
            // A CONFLICT means the retired id was already succeeded elsewhere;
            // there is nothing left to claim, so stop retrying it.
            const code = error instanceof BackendRequestError ? error.code : null;
            if (code !== "CONFLICT" && code !== "BAD_REQUEST") {
                console.warn("[device-identity] Failed to claim device identity succession; will retry.", error);
                return;
            }
        }
        await this.options.hostHandlers.clearSupersededDeviceId?.().catch(() => undefined);
        if (this.deviceIdentity) {
            delete this.deviceIdentity.supersededDeviceId;
        }
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
            hasDatabase: Boolean(this.hostDatabase),
            hasConnectedAccount: this.configCache.hasConnectedAccount,
            cloudSyncEnabled: this.configCache.cloudSyncEnabled,
            authToken: this.getConfiguredHostAuthToken(),
            backendUrl: this.getConfiguredHostBackendUrl(),
            canSignDeviceInput: typeof this.options.hostHandlers.signDeviceInput === "function",
        });
        const client = eligible ? this.ensureHostBackendClient() : null;
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
        if (!eligible || !client || !this.hostDatabase) {
            return;
        }
        const bridge = createExecutionPlacementBridge({
            client,
            database: this.hostDatabase,
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
            onRemoteExecutionRequest: (request) => {
                // Raise it on this machine's screen and return. The dispatch
                // that asked has already been refused with a retryable code;
                // nothing is blocked on the user answering.
                void Promise.resolve(this.options.hostHandlers.notifyRemoteExecutionRequest?.(request)).catch((error) => console.warn("[execution-placement] the remote execution prompt could not be shown.", error));
            },
            getAvailability: async () => {
                const platformCapabilities = process.platform === "darwin" || process.platform === "win32"
                    ? ["computer-use"]
                    : [];
                return {
                    ready: Boolean(this.started &&
                        this.hostReady &&
                        this.configCache.hasConnectedAccount &&
                        this.configCache.cloudSyncEnabled),
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
                    resolve: async (path) => await client.call("drive.fileUrl", { path }),
                    onSkipped: (path, error) => console.warn(`[execution-placement] attachment ${path} could not be resolved from the drive.`, error),
                });
                if (dispatch.kind === "agent") {
                    // An agent placed here is someone else's background work:
                    // its brief is not a message the user typed in this chat.
                    const description = typeof payload.description === "string" &&
                        payload.description.trim()
                        ? payload.description.trim()
                        : prompt.slice(0, 160);
                    const remoteThreadId = typeof payload.threadId === "string" && payload.threadId.trim()
                        ? payload.threadId.trim()
                        : null;
                    const requestedModel = typeof payload.model === "string" && payload.model.trim()
                        ? payload.model.trim()
                        : null;
                    const result = await this.requestWorker(METHOD_NAMES.INTERNAL_WORKER_RUN_BLOCKING_AGENT, {
                        conversationId: dispatch.conversationId,
                        description,
                        prompt,
                        agentType: "general",
                        ...(requestedModel ? { requestedModel } : {}),
                        ...(remoteThreadId
                            ? {
                                threadId: placementRemoteThreadAgentId(remoteThreadId),
                                executionId: placementLocalAgentThreadId(dispatch.dispatchId),
                            }
                            : { threadId: placementLocalAgentThreadId(dispatch.dispatchId) }),
                        // Resolved above for both dispatch kinds. The chat
                        // branch has always used them; discarding them here is
                        // what left a placed agent searching the local
                        // filesystem for a drive path it could not resolve.
                        ...(attachments.length > 0 ? { attachments } : {}),
                    }, {
                        ensureWorker: true,
                        recordActivity: true,
                        retryOnceOnDisconnect: false,
                        rpc: AGENT_RUN_RPC_OPTIONS,
                    });
                    return result.status === "ok"
                        ? { status: "ok", finalText: result.finalText }
                        : {
                            status: "error",
                            error: result.error || "The local agent failed.",
                        };
                }
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
                const result = await this.requestWorker(METHOD_NAMES.INTERNAL_WORKER_RUN_AUTOMATION, {
                    conversationId: dispatch.conversationId,
                    userPrompt: prompt,
                    userMessageEventId,
                    // A desktop/voice turn may be in flight when the phone
                    // sends. The runtime queues this exact accepted execution;
                    // background agents must not make the computer offline.
                    rejectIfBusy: false,
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
            steerExecution: async ({ dispatchId, payload, messageId, text }) => {
                const remoteThreadId = typeof payload.threadId === "string" && payload.threadId.trim()
                    ? payload.threadId.trim()
                    : null;
                const result = await this.requestWorker(METHOD_NAMES.INTERNAL_WORKER_STEER_BLOCKING_AGENT, {
                    agentId: remoteThreadId
                        ? placementRemoteThreadAgentId(remoteThreadId)
                        : placementLocalAgentThreadId(dispatchId),
                    text,
                    messageId,
                }, {
                    ensureWorker: true,
                    recordActivity: true,
                    retryOnceOnDisconnect: false,
                });
                return result?.delivered === true;
            },
            cancelExecution: async ({ dispatchId, kind, conversationId, payload }) => {
                if (kind === "agent") {
                    const remoteThreadId = typeof payload?.threadId === "string" && payload.threadId.trim()
                        ? payload.threadId.trim()
                        : null;
                    const result = remoteThreadId
                        ? await this.cancelBlockingLocalAgent(placementRemoteThreadAgentId(remoteThreadId), "Canceled by execution placement.", placementLocalAgentThreadId(dispatchId))
                        : await this.cancelBlockingLocalAgent(placementLocalAgentThreadId(dispatchId), "Canceled by execution placement.");
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
    /**
     * Services that follow the signed-in account: the device-identity
     * succession claim (retried on every sync until acknowledged) and the
     * cloud schedule feed, re-followed whenever the backend or token changes.
     */
    syncHostAccountServices() {
        const authToken = this.getConfiguredHostAuthToken();
        const backendUrl = this.getConfiguredHostBackendUrl();
        const signedIn = this.started &&
            this.hostReady &&
            Boolean(authToken && backendUrl) &&
            Boolean(this.configCache.hasConnectedAccount);
        const key = signedIn ? `${backendUrl}\n${authToken}` : null;
        if (signedIn) {
            void this.claimDeviceIdentitySuccession();
        }
        if (key === this.hostAccountServicesKey)
            return;
        this.hostAccountServicesKey = key;
        this.resubscribeCloudSchedules();
    }
    on(eventName, listener) {
        this.events.on(eventName, listener);
        return () => {
            this.events.removeListener(eventName, listener);
        };
    }
    /** Every event, as `(eventName, payload)`. */
    onAny(listener) {
        this.events.anyListeners.add(listener);
        return () => {
            this.events.anyListeners.delete(listener);
        };
    }
    async start() {
        if (this.started)
            return;
        this.started = true;
        await this.initializeHostServices();
        this.syncHostAccountServices();
        await this.syncHostExecutionPlacement();
        this.events.emit("runtime-connected", undefined);
        this.events.emit("runtime-ready", await this.health());
    }
    async stop(options) {
        if (options?.killWorker) {
            this.writeRestartContinuationRecord(this.pendingStaleWorkerRestart?.reason ?? "app-shutdown");
        }
        this.started = false;
        this.hostReady = false;
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
        this.durableBoundaryFlushTimer?.cancel();
        this.durableBoundaryFlushTimer = null;
        await this.workerController.stop(options?.killWorker ? "restart" : "stopped");
        await this.stopHostServices();
        this.deviceIdentity = null;
        this.configCache = {};
        this.events.emit("runtime-disconnected", { reason: "stopped" });
    }
    async configure(params) {
        this.configCache = { ...this.configCache, ...params };
        this.syncHostAccountServices();
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
        if (this.workerMode === "inproc") {
            // The worker is this process. It exits once this returns, and the
            // attached client starts a fresh one.
            getFileLogger()?.process("host.runtime-restart", { reason });
            this.options.inprocWorker.restartProcess(reason);
            return { ok: true };
        }
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
    async uploadPlacedAttachments(payload, idempotencyKey) {
        const attachments = Array.isArray(payload.attachments) ? payload.attachments.slice(0, 4) : [];
        if (attachments.length === 0) return [];
        // The drive lives in the owner's object; the backend client reaches it.
        const drive = this.ensureHostBackendClient();
        if (!drive) {
            throw new Error("Cross-device execution is not ready on this computer.");
        }
        const scope = createHash("sha256").update(idempotencyKey).digest("hex").slice(0, 24);
        const uploaded = [];
        for (let index = 0; index < attachments.length; index += 1) {
            const attachment = await this.readPlacedAttachment(attachments[index]);
            const rawExtension = path.extname(attachment.name).toLowerCase();
            const extension = /^\.[a-z0-9]{1,10}$/.test(rawExtension) ? rawExtension : "";
            const drivePath = `execution-attachments/${scope}/${String(index + 1).padStart(2, "0")}${extension}`;
            const prepared = await drive.call("drive.prepareUpload", {
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
            await drive.call("drive.finalizeUpload", {
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
        const enteredAt = Date.now();
        const preparationAt = performance.now();
        await this.syncHostExecutionPlacement();
        const placementReadyMs = Math.round(performance.now() - preparationAt);
        const bridge = this.hostExecutionPlacementBridge;
        if (!bridge?.isRunning) {
            throw new Error("Cross-device execution is not ready on this computer.");
        }
        const idempotencyKey = (payload.userMessageEventId?.trim() || payload.requestId?.trim() || `desktop:${crypto.randomUUID()}`).slice(0, 128);
        const attachmentAt = performance.now();
        const attachments = await this.uploadPlacedAttachments(payload, idempotencyKey);
        const attachmentsMs = Math.round(performance.now() - attachmentAt);
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
        getFileLogger()?.process("chat.dispatch-prepared", {
            requestId: payload.requestId, originUserMessageId: payload.userMessageEventId,
            enteredAt, dispatchAt: Date.now(), placementReadyMs, attachmentsMs,
            preparationMs: Math.round(performance.now() - preparationAt),
        });
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
        // Cloud admission uses the dispatch identity for its journal row.
        // Start/status/finish events and the acceptance reply must agree.
        const userMessageId = target.mode === "cloud"
            ? dispatch.dispatchId
            : payload.userMessageEventId ?? idempotencyKey;
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
        return { runId, userMessageId };
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
        const target = payload.storageMode === "local"
            ? { mode: "automatic" }
            : payload.executionTarget && typeof payload.executionTarget === "object"
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
            rpc: AGENT_RUN_RPC_OPTIONS,
        });
    }
    async cancelBlockingLocalAgent(agentId, reason, executionId) {
        return await this.requestWorker(METHOD_NAMES.INTERNAL_WORKER_CANCEL_BLOCKING_AGENT, { agentId, reason, ...(executionId ? { executionId } : {}) }, {
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
    /**
     * Reminders and tasks live in the owner's object (see cloud-schedules.ts);
     * watches stay on the local scheduler. Callers see one list either way.
     */
    getCloudSchedules() {
        if (!this.cloudSchedules) {
            this.cloudSchedules = createCloudSchedules({
                getClient: () => this.getConfiguredHostAuthToken() ? this.ensureHostBackendClient() : null,
                getDeviceId: () => this.deviceIdentity?.deviceId,
            });
        }
        return this.cloudSchedules;
    }
    async listCronJobs() {
        const local = this.schedulerService?.listCronJobs() ?? [];
        const cloud = await this.getCloudSchedules().list().catch(() => []);
        return [...cloud, ...local];
    }
    async addCronJob(input) {
        if (isCloudSchedulePayload(input.payload)) {
            return await this.getCloudSchedules().add(input);
        }
        return this.ensureScheduler().addCronJob(input);
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
        if (isCloudScheduleId(jobId)) {
            return await this.getCloudSchedules().runNow(jobId);
        }
        return this.ensureScheduler().runCronJob(jobId);
    }
    async removeCronJob(jobId) {
        if (isCloudScheduleId(jobId)) {
            return await this.getCloudSchedules().remove(jobId);
        }
        return this.ensureScheduler().removeCronJob(jobId);
    }
    async updateCronJob(jobId, patch) {
        if (isCloudScheduleId(jobId)) {
            return await this.getCloudSchedules().update(jobId, patch);
        }
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
        const identityStartedAt = performance.now();
        this.deviceIdentity = await this.options.hostHandlers.getDeviceIdentity();
        const dbStartedAt = performance.now();
        const HostDatabase = loadSqliteDatabaseCtorSync();
        const hostDatabase = new HostDatabase(getDesktopDatabasePath(this.options.initializeParams.stellaDataDirPath));
        // Synchronous on the host's thread (Electron main in the desktop app):
        // a pending schema migration blocks it for the migration's duration.
        // Timed so that cost is visible next to the worker's boot timing.
        const dbInit = initializeDesktopDatabase(hostDatabase);
        getFileLogger()?.process("host.services-init.timing", {
            deviceIdentityMs: Math.round(dbStartedAt - identityStartedAt),
            dbInitMs: Math.round(performance.now() - dbStartedAt),
            dbFromVersion: dbInit.fromVersion,
            dbToVersion: dbInit.toVersion,
            dbMigrated: dbInit.migrated,
        });
        this.hostDatabase = hostDatabase;
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
                return createScheduleScriptAuthEnv(auth, this.getConfiguredHostBackendUrl());
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
        // Reminders and tasks moved to the backend; the local copies are dropped
        // rather than migrated. Watches keep running here.
        for (const job of scheduler.listCronJobs()) {
            if (job.payload.kind !== "watch") scheduler.removeCronJob(job.id);
        }
        scheduler.start();
        this.schedulerService = scheduler;
        this.schedulerSubscription = scheduler.subscribe(() => {
            this.events.emit("schedule-updated", undefined);
        });
        this.resubscribeCloudSchedules();
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
        this.hostDatabase?.close();
        this.hostDatabase = null;
        this.disposeHostBackendClient();
        this.hostAccountServicesKey = null;
        this.schedulerSubscription?.();
        this.schedulerSubscription = null;
        this.cloudScheduleUnsubscribe?.();
        this.cloudScheduleUnsubscribe = null;
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
    /**
     * This computer's own answer to the "accept work from your other devices?"
     * prompt. Goes out on the presence socket, which is proven with the device
     * key, so the gate knows the machine itself answered.
     */
    async answerRemoteExecutionRequest(params) {
        const allow = Boolean(params && params.allow);
        const bridge = this.hostExecutionPlacementBridge;
        if (!bridge) {
            throw new Error("Execution placement is not running on this computer.");
        }
        await bridge.answerRemoteExecutionRequest(allow);
        return { allow };
    }
    buildWorkerInitializationState() {
        return {
            protocolVersion: STELLA_RUNTIME_PROTOCOL_VERSION,
            stellaAppDir: this.options.initializeParams.stellaAppDir,
            stellaDataDirPath: this.options.initializeParams.stellaDataDirPath,
            stellaWorkspacePath: this.options.initializeParams.stellaWorkspacePath,
            authToken: this.configCache.authToken ?? null,
            backendUrl: this.configCache.backendUrl ?? null,
            hasConnectedAccount: this.configCache.hasConnectedAccount ?? false,
            cloudSyncEnabled: this.configCache.cloudSyncEnabled ?? false,
            localLlmCredentialsUpdatedAt: this.configCache.localLlmCredentialsUpdatedAt ?? null,
        };
    }
    async requestWorker(method, params, options) {
        return await this.workerController.request(async (peer) => {
            const result = await peer.request(method, params, options?.rpc);
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
    /**
     * The registration surface of a worker peer, gated on that peer still
     * being the controller's live connection. A worker that was stopped or
     * replaced (a restarted stdio child still draining, a detached in-process
     * peer) can otherwise land run events or host callbacks on the new
     * generation's state.
     */
    fenceWorkerPeer(peer) {
        const isLive = () => this.workerController.getConnection()?.peer === peer;
        const generation = this.workerGeneration + 1;
        const noteDrop = (kind, method) => {
            this.staleWorkerFrameDrops += 1;
            getFileLogger()?.process("host.stale-worker-frame-dropped", {
                kind,
                method,
                generation,
                currentGeneration: this.workerGeneration,
                totalDropped: this.staleWorkerFrameDrops,
            });
        };
        return {
            registerRequestHandler: (method, handler) => {
                peer.registerRequestHandler(method, async (params) => {
                    if (!isLive()) {
                        noteDrop("request", method);
                        throw createRuntimeUnavailableError("This runtime worker connection was replaced; the request was dropped.");
                    }
                    return await handler(params);
                });
            },
            registerNotificationHandler: (method, handler) => {
                peer.registerNotificationHandler(method, (params) => {
                    if (!isLive()) {
                        noteDrop("notification", method);
                        return;
                    }
                    return handler(params);
                });
            },
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
        peer.registerRequestHandler(METHOD_NAMES.INTERNAL_SCHEDULE_ADD_CRON_JOB, async (params) => await this.addCronJob(params));
        peer.registerRequestHandler(METHOD_NAMES.INTERNAL_SCHEDULE_UPDATE_CRON_JOB, async (params) => {
            const payload = params;
            return await this.updateCronJob(payload.jobId, payload.patch);
        });
        peer.registerRequestHandler(METHOD_NAMES.INTERNAL_SCHEDULE_REMOVE_CRON_JOB, async (params) => await this.removeCronJob(params.jobId));
        peer.registerRequestHandler(METHOD_NAMES.INTERNAL_SCHEDULE_RUN_CRON_JOB, async (params) => await this.runCronJob(params.jobId));
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
                    forkDelayed(500, () => {
                        void this.flushWorkerRestart();
                    });
                }
            }
            else if ((payload.type === AGENT_STREAM_EVENT_TYPES.TOOL_END ||
                payload.type === AGENT_STREAM_EVENT_TYPES.AGENT_PROGRESS) &&
                this.hasPendingWorkerRestartIntent() &&
                !this.durableBoundaryFlushTimer) {
                // A restart held only by an unsafe tool call can proceed at the
                // next tool boundary (durable runs resume in the new worker).
                this.durableBoundaryFlushTimer = forkDelayed(500, () => {
                    this.durableBoundaryFlushTimer = null;
                    void this.flushWorkerRestart();
                });
            }
        });
        peer.registerNotificationHandler(NOTIFICATION_NAMES.VOICE_AGENT_EVENT, (params) => {
            this.events.emit("voice-agent-event", params);
        });
        peer.registerNotificationHandler(NOTIFICATION_NAMES.LOCAL_CHAT_UPDATED, (params) => {
            const payload = params;
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
    }
}
const resolveDefaultWorkerEntryPath = (options) => {
    if (options.workerEntryPath) {
        return options.workerEntryPath;
    }
    return resolveBundledRuntimeFile("worker/entry.js");
};
