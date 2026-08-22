import { AGENT_STREAM_EVENT_TYPES, isTaskLifecycleEventType, isTaskLifecycleTerminalType, } from "@stella/contracts/agent-runtime";
import { StellaRuntimeHost, } from "@stella/runtime/host";
import { createRuntimeUnavailableError } from "@stella/contracts/protocol/rpc-peer";
import { readConfiguredStellaSiteUrl } from "@stella/contracts/convex-urls";
const isRunTerminalEvent = (type) => type === AGENT_STREAM_EVENT_TYPES.RUN_FINISHED;
/**
 * Worker recorder seqs are small (event count per run). Hidden→visible
 * mirrors and similar paths use `Date.now()`-scale synthetic seqs. If
 * those advance `lastSeqByScope`, every subsequent recorder-seq STREAM
 * chunk in the same run is dropped — post-tool / hidden replies stop
 * streaming live and pop in only once persisted.
 */
const SYNTHETIC_RUN_EVENT_SEQ_FLOOR = 1e10;
const isTaskScopedEvent = (type) => type === AGENT_STREAM_EVENT_TYPES.AGENT_REASONING ||
    isTaskLifecycleEventType(type);
const LOCAL_CHAT_SESSION_IDLE_CLEANUP_MS = 30_000;
export class RuntimeHostAdapter {
    host;
    lastHealth = null;
    lastRuntimeHealth = null;
    activeRun = null;
    connected = false;
    started = false;
    lastConfigureError = null;
    lastAvailabilitySnapshot = null;
    pendingConfig = {};
    queuedConfigPatch = {};
    configFlushQueued = false;
    localChatSessions = new Map();
    availabilityListeners = new Set();
    constructor(options) {
        this.host = new StellaRuntimeHost(options);
        this.host.on("runtime-connected", () => {
            this.connected = true;
            if (this.lastHealth && !this.lastHealth.ready) {
                this.lastHealth = { ready: false };
            }
            this.emitAvailabilityChange();
            // Flush any config patches that failed before the worker was ready
            if (this.started && Object.keys(this.pendingConfig).length > 0) {
                void this.host.configure(this.pendingConfig).catch(() => { });
            }
        });
        this.host.on("runtime-disconnected", ({ reason }) => {
            this.connected = false;
            this.lastRuntimeHealth = null;
            this.lastHealth = { ready: false, reason };
            this.activeRun = null;
            this.clearLocalChatSessions();
            this.emitAvailabilityChange();
        });
        this.host.on("runtime-ready", (snapshot) => {
            this.lastRuntimeHealth = snapshot;
            this.emitAvailabilityChange();
        });
        this.host.on("run-event", (event) => {
            if (event.type === AGENT_STREAM_EVENT_TYPES.RUN_STARTED &&
                event.conversationId) {
                this.activeRun = {
                    runId: event.runId,
                    conversationId: event.conversationId,
                };
            }
            if (event.type === AGENT_STREAM_EVENT_TYPES.RUN_FINISHED) {
                if (this.activeRun?.runId === event.runId) {
                    this.activeRun = null;
                }
            }
            if (event.type === AGENT_STREAM_EVENT_TYPES.RUN_STARTED &&
                event.requestId) {
                this.transferLocalChatRunOwnership(event.runId, event.requestId, event.conversationId);
            }
            let dispatched = false;
            if (event.requestId) {
                dispatched = this.dispatchLocalChatSessionEvent(event.requestId, event);
            }
            if (!dispatched) {
                this.dispatchLocalChatSessionEventByRun(event, event.requestId);
            }
        });
    }
    clearLocalChatSessionCleanup(requestId) {
        const session = this.localChatSessions.get(requestId);
        if (!session?.cleanupTimer) {
            return;
        }
        clearTimeout(session.cleanupTimer);
        session.cleanupTimer = null;
    }
    clearLocalChatSession(requestId) {
        this.clearLocalChatSessionCleanup(requestId);
        this.localChatSessions.delete(requestId);
    }
    clearLocalChatSessions() {
        for (const requestId of [...this.localChatSessions.keys()]) {
            this.clearLocalChatSession(requestId);
        }
    }
    transferLocalChatRunOwnership(runId, nextRequestId, conversationId) {
        for (const [requestId, session] of this.localChatSessions.entries()) {
            if (requestId === nextRequestId) {
                continue;
            }
            if (typeof conversationId === "string" &&
                session.conversationId !== conversationId) {
                continue;
            }
            const owned = session.activeRunIds.delete(runId) ||
                session.knownRunIds.delete(runId);
            if (!owned) {
                continue;
            }
            session.knownRunIds.delete(runId);
            for (const taskKey of [...session.activeTaskIds]) {
                if (taskKey.startsWith(`${runId}:`)) {
                    session.activeTaskIds.delete(taskKey);
                }
            }
            this.scheduleLocalChatSessionCleanup(requestId);
        }
    }
    scheduleLocalChatSessionCleanup(requestId) {
        const session = this.localChatSessions.get(requestId);
        if (!session) {
            return;
        }
        if (session.activeRunIds.size > 0 || session.activeTaskIds.size > 0) {
            this.clearLocalChatSessionCleanup(requestId);
            return;
        }
        this.clearLocalChatSessionCleanup(requestId);
        session.cleanupTimer = setTimeout(() => {
            const current = this.localChatSessions.get(requestId);
            if (!current) {
                return;
            }
            if (current.activeRunIds.size > 0 || current.activeTaskIds.size > 0) {
                return;
            }
            this.clearLocalChatSession(requestId);
        }, LOCAL_CHAT_SESSION_IDLE_CLEANUP_MS);
    }
    shouldIgnoreLocalChatSessionEvent(session, event) {
        if (typeof event.conversationId === "string" &&
            event.conversationId !== session.conversationId) {
            return true;
        }
        const scopeKey = `${isTaskScopedEvent(event.type) ? "task" : "run"}:${event.rootRunId ?? event.runId}`;
        const seq = Number.isFinite(event.seq) ? event.seq : 0;
        if (seq > 0 && seq < SYNTHETIC_RUN_EVENT_SEQ_FLOOR) {
            const previousSeq = session.lastSeqByScope.get(scopeKey);
            if (typeof previousSeq === "number" && seq <= previousSeq) {
                return true;
            }
            session.lastSeqByScope.set(scopeKey, seq);
        }
        return false;
    }
    dispatchLocalChatSessionEvent(requestId, event) {
        const session = this.localChatSessions.get(requestId);
        if (!session) {
            return false;
        }
        return this.dispatchEventToLocalChatSession(requestId, session, event);
    }
    dispatchLocalChatSessionEventByRun(event, exceptRequestId) {
        const runId = event.rootRunId ?? event.runId;
        let dispatched = false;
        for (const [requestId, session] of this.localChatSessions.entries()) {
            if (requestId === exceptRequestId) {
                continue;
            }
            if (typeof event.conversationId === "string" &&
                event.conversationId !== session.conversationId) {
                continue;
            }
            if (!session.knownRunIds.has(runId) && !session.activeRunIds.has(runId)) {
                continue;
            }
            dispatched =
                this.dispatchEventToLocalChatSession(requestId, session, event) ||
                    dispatched;
        }
        return dispatched;
    }
    dispatchEventToLocalChatSession(requestId, session, event) {
        if (this.shouldIgnoreLocalChatSessionEvent(session, event)) {
            return false;
        }
        this.clearLocalChatSessionCleanup(requestId);
        session.knownRunIds.add(event.runId);
        const taskKey = event.agentId && (event.rootRunId ?? event.runId)
            ? `${event.rootRunId ?? event.runId}:${event.agentId}`
            : null;
        if (event.type === AGENT_STREAM_EVENT_TYPES.RUN_STARTED) {
            session.activeRunIds.add(event.runId);
        }
        else if (isRunTerminalEvent(event.type)) {
            session.activeRunIds.delete(event.runId);
        }
        if (event.type === AGENT_STREAM_EVENT_TYPES.AGENT_STARTED && taskKey) {
            session.activeTaskIds.add(taskKey);
        }
        else if (isTaskLifecycleTerminalType(event.type) && taskKey) {
            session.activeTaskIds.delete(taskKey);
        }
        switch (event.type) {
            case AGENT_STREAM_EVENT_TYPES.RUN_STARTED:
                session.callbacks.onRunStarted?.(event);
                break;
            case AGENT_STREAM_EVENT_TYPES.STREAM:
                session.callbacks.onStream(event);
                break;
            case AGENT_STREAM_EVENT_TYPES.ASSISTANT_MESSAGE:
                session.callbacks.onAssistantMessage?.(event);
                break;
            case AGENT_STREAM_EVENT_TYPES.AGENT_REASONING:
                session.callbacks.onAgentReasoning?.(event);
                break;
            case AGENT_STREAM_EVENT_TYPES.STATUS:
                session.callbacks.onStatus?.(event);
                break;
            case AGENT_STREAM_EVENT_TYPES.TOOL_START:
                session.callbacks.onToolStart(event);
                break;
            case AGENT_STREAM_EVENT_TYPES.TOOL_END:
                session.callbacks.onToolEnd(event);
                break;
            case AGENT_STREAM_EVENT_TYPES.RUN_FINISHED:
                session.callbacks.onRunFinished(event);
                break;
            default:
                if (isTaskLifecycleEventType(event.type)) {
                    session.callbacks.onAgentEvent?.({
                        type: event.type,
                        conversationId: session.conversationId,
                        rootRunId: event.rootRunId ?? event.runId,
                        agentId: event.agentId ?? "",
                        agentType: event.agentType ?? "",
                        ...(event.description ? { description: event.description } : {}),
                        ...(event.parentAgentId
                            ? { parentAgentId: event.parentAgentId }
                            : {}),
                        ...(event.result ? { result: event.result } : {}),
                        ...(event.error ? { error: event.error } : {}),
                        ...(event.statusText ? { statusText: event.statusText } : {}),
                        ...(event.groupKey ? { groupKey: event.groupKey } : {}),
                        ...(event.groupLabel ? { groupLabel: event.groupLabel } : {}),
                    });
                }
                break;
        }
        this.scheduleLocalChatSessionCleanup(requestId);
        return true;
    }
    emitAvailabilityChange() {
        const snapshot = this.getAvailabilitySnapshot();
        if (this.lastAvailabilitySnapshot &&
            this.lastAvailabilitySnapshot.connected === snapshot.connected &&
            this.lastAvailabilitySnapshot.ready === snapshot.ready &&
            this.lastAvailabilitySnapshot.reason === snapshot.reason) {
            return;
        }
        this.lastAvailabilitySnapshot = snapshot;
        for (const listener of this.availabilityListeners) {
            listener(snapshot);
        }
    }
    waitForAvailability(predicate, timeoutMs, fallbackMessage) {
        const initial = this.getAvailabilitySnapshot();
        if (predicate(initial)) {
            return Promise.resolve();
        }
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                unsubscribe();
                reject(createRuntimeUnavailableError(this.getAvailabilitySnapshot().reason ?? fallbackMessage));
            }, timeoutMs);
            const unsubscribe = this.onAvailabilityChange((snapshot) => {
                if (!predicate(snapshot)) {
                    return;
                }
                clearTimeout(timer);
                unsubscribe();
                resolve();
            });
        });
    }
    getAvailabilitySnapshot() {
        const ready = Boolean(this.connected && this.lastRuntimeHealth?.ready);
        const reason = this.lastRuntimeHealth && !this.lastRuntimeHealth.ready
            ? "Stella runtime host is not ready."
            : (this.lastHealth?.reason ??
                (!this.connected
                    ? "Stella runtime client is not connected."
                    : undefined));
        return {
            connected: this.connected,
            ready,
            ...(reason ? { reason } : {}),
            ...(this.lastRuntimeHealth?.pendingWorkerRestart
                ? { pendingRuntimeRestart: true }
                : {}),
        };
    }
    onAvailabilityChange(listener) {
        this.availabilityListeners.add(listener);
        return () => {
            this.availabilityListeners.delete(listener);
        };
    }
    async start() {
        await this.host.start();
        this.started = true;
        if (Object.keys(this.pendingConfig).length > 0) {
            try {
                await this.host.configure(this.pendingConfig);
                this.lastConfigureError = null;
            }
            catch (error) {
                this.lastConfigureError =
                    error instanceof Error
                        ? error.message
                        : String(error ?? "Runtime configure failed.");
                throw error;
            }
        }
        this.lastRuntimeHealth = await this.host.health();
        this.lastHealth = await this.host.healthCheck();
        this.activeRun = await this.host.getActiveRun();
        this.emitAvailabilityChange();
    }
    async stop(options) {
        this.started = false;
        this.clearLocalChatSessions();
        await this.host.stop(options);
    }
    async ensureWorkerStarted() {
        if (!this.started) {
            return;
        }
        await this.host.ensureWorkerStarted();
        this.lastRuntimeHealth = await this.host.health();
        this.lastHealth = await this.host.healthCheck();
        this.emitAvailabilityChange();
    }
    queueRuntimeConfigPatch(patch) {
        this.pendingConfig = {
            ...this.pendingConfig,
            ...patch,
        };
        this.queuedConfigPatch = {
            ...this.queuedConfigPatch,
            ...patch,
        };
        if (!this.started) {
            return;
        }
        if (this.configFlushQueued) {
            return;
        }
        this.configFlushQueued = true;
        queueMicrotask(() => {
            this.configFlushQueued = false;
            if (!this.started) {
                return;
            }
            const nextPatch = this.queuedConfigPatch;
            this.queuedConfigPatch = {};
            if (Object.keys(nextPatch).length === 0) {
                return;
            }
            void this.host.configure(nextPatch).then(() => {
                this.lastConfigureError = null;
            }, (error) => {
                this.lastConfigureError =
                    error instanceof Error
                        ? error.message
                        : String(error ?? "Runtime configure failed.");
                console.warn("[stella-runtime-adapter] Failed to apply runtime config patch:", {
                    patch: nextPatch,
                    error: this.lastConfigureError,
                });
            });
        });
    }
    async waitUntilReady(timeoutMs = 10_000) {
        const deadline = Date.now() + timeoutMs;
        while (true) {
            // Host readiness only proves that the socket and host-owned services are
            // online. The worker builds its runner lazily after that handshake, and
            // a failed lazy import leaves the socket healthy while chats cannot run.
            // Require both layers to report ready before accepting a send.
            this.lastRuntimeHealth = await this.host.health();
            const workerHealth = await this.agentHealthCheck();
            this.emitAvailabilityChange();
            const snapshot = this.getAvailabilitySnapshot();
            // A pending restart is intentionally informational: the current worker
            // remains authoritative and usable until its active work drains. During
            // the actual stop/start window workerHealth is not ready, so sends still
            // wait without locking the user out for the entire deferral period.
            if (workerHealth?.ready === true && snapshot.ready) {
                return;
            }
            if (Date.now() >= deadline) {
                throw createRuntimeUnavailableError(workerHealth?.reason ??
                    snapshot.reason ??
                    "Stella is reconnecting to its runtime. Please try again.");
            }
            await new Promise((resolve) => setTimeout(resolve, 100));
        }
    }
    async waitUntilConnected(timeoutMs = 10_000) {
        if (this.getAvailabilitySnapshot().connected) {
            return;
        }
        await this.waitForAvailability((snapshot) => snapshot.connected, timeoutMs, "Stella runtime client is not connected.");
    }
    setConvexUrl(value) {
        this.queueRuntimeConfigPatch({ convexUrl: value });
    }
    setConvexSiteUrl(value) {
        this.queueRuntimeConfigPatch({ convexSiteUrl: value });
    }
    setAuthToken(value) {
        this.queueRuntimeConfigPatch({ authToken: value });
    }
    /**
     * Auth-inversion P1: mirror the desktop-owned Better Auth session into
     * the runtime worker's AuthOwner store (migration import + dual-write).
     * Rejects when the connected worker lacks the RPC (version skew);
     * callers treat that as legacy mode.
     */
    async importAuthSession(payload) {
        return await this.host.authImport(payload);
    }
    /** P2: pull a Convex JWT from the runtime AuthOwner (main-process proxy). */
    async getRuntimeConvexToken(payload = {}) {
        return await this.host.authGetConvexToken(payload);
    }
    /** P2: pull the Better Auth session from the runtime AuthOwner. */
    async getRuntimeAuthSession() {
        return await this.host.authGetSession();
    }
    /**
     * Monotonic worker-generation counter from the host. Lets the desktop auth
     * service detect a stale-worker replacement and re-evaluate ownership mode
     * instead of latching a legacy decision until the next app restart.
     */
    getWorkerGeneration() {
        return this.host.workerGeneration;
    }
    /** P2: runtime AuthOwner state-change events (token minted, sign-out). */
    onAuthChanged(listener) {
        return this.host.on("auth-changed", listener);
    }
    // P3: sign-in mutations proxied to the worker AuthOwner (single writer).
    async authSignInAnonymous() {
        return await this.host.authSignInAnonymous();
    }
    async authSignOut() {
        return await this.host.authSignOut();
    }
    async authDeleteUser() {
        return await this.host.authDeleteUser();
    }
    async authApplySessionCookie(payload) {
        return await this.host.authApplySessionCookie(payload);
    }
    async authHandleCallback(payload) {
        return await this.host.authHandleCallback(payload);
    }
    async authMagicLinkSend(payload) {
        return await this.host.authMagicLinkSend(payload);
    }
    async authMagicLinkStatus(payload) {
        return await this.host.authMagicLinkStatus(payload);
    }
    setHasConnectedAccount(value) {
        this.queueRuntimeConfigPatch({ hasConnectedAccount: value });
    }
    setCloudSyncEnabled(enabled) {
        this.queueRuntimeConfigPatch({ cloudSyncEnabled: enabled });
    }
    setModelCatalogUpdatedAt(value) {
        this.queueRuntimeConfigPatch({
            modelCatalogUpdatedAt: typeof value === "number" && Number.isFinite(value) ? value : null,
        });
    }
    refreshLocalLlmCredentials() {
        this.queueRuntimeConfigPatch({
            localLlmCredentialsUpdatedAt: Date.now(),
        });
    }
    getStellaSiteAuth() {
        const baseUrl = readConfiguredStellaSiteUrl(this.pendingConfig.convexSiteUrl ?? null);
        const authToken = this.pendingConfig.authToken?.trim() || null;
        if (!baseUrl || !authToken) {
            return null;
        }
        return { baseUrl, authToken };
    }
    async agentHealthCheck() {
        try {
            const value = await this.host.healthCheck();
            this.lastHealth = value ?? { ready: false };
        }
        catch (error) {
            this.lastHealth = {
                ready: false,
                reason: error instanceof Error
                    ? error.message
                    : String(error ?? "Stella runtime client is not connected."),
            };
        }
        this.emitAvailabilityChange();
        return this.lastHealth;
    }
    async getActiveOrchestratorRun() {
        try {
            this.activeRun = await this.host.getActiveRun();
        }
        catch {
            this.activeRun = null;
        }
        return this.activeRun;
    }
    async listActiveRuns() {
        return await this.host.listActiveRuns();
    }
    async listModels(request = {}) {
        return await this.host.listModels(request);
    }
    async resumeRunEvents(payload) {
        return await this.host.resumeRunEvents(payload);
    }
    attachResumedLocalChatSession(payload, callbacks) {
        const conversationId = payload.conversationId.trim();
        const runId = payload.runId.trim();
        if (!conversationId || !runId) {
            return () => { };
        }
        const requestId = payload.requestId?.trim() || `resume:${conversationId}:${runId}`;
        this.clearLocalChatSession(requestId);
        this.localChatSessions.set(requestId, {
            requestId,
            conversationId,
            callbacks,
            knownRunIds: new Set([runId]),
            activeRunIds: new Set(payload.active === false ? [] : [runId]),
            activeTaskIds: new Set(),
            lastSeqByScope: new Map(),
            cleanupTimer: null,
        });
        if (payload.active !== false) {
            this.activeRun = {
                runId,
                conversationId,
                ...(payload.requestId ? { requestId: payload.requestId } : {}),
                ...(payload.userMessageId
                    ? { userMessageId: payload.userMessageId }
                    : {}),
                ...(payload.uiVisibility ? { uiVisibility: payload.uiVisibility } : {}),
            };
        }
        return () => {
            this.clearLocalChatSession(requestId);
        };
    }
    cancelLocalChat(runId) {
        return void this.host.cancelChat(runId);
    }
    async handleLocalChat(payload, callbacks) {
        const requestId = typeof payload.requestId === "string" &&
            payload.requestId.trim().length > 0
            ? payload.requestId
            : `local:${Date.now()}:${Math.random().toString(36).slice(2)}`;
        this.clearLocalChatSession(requestId);
        this.localChatSessions.set(requestId, {
            requestId,
            conversationId: payload.conversationId,
            callbacks,
            knownRunIds: new Set(),
            activeRunIds: new Set(),
            activeTaskIds: new Set(),
            lastSeqByScope: new Map(),
            cleanupTimer: null,
        });
        try {
            const result = await this.host.startChat({
                ...payload,
                requestId,
            });
            this.localChatSessions.get(requestId)?.knownRunIds.add(result.runId);
            return result;
        }
        catch (error) {
            this.clearLocalChatSession(requestId);
            throw error;
        }
    }
    async sendAgentInput(payload) {
        return await this.host.sendAgentInput(payload);
    }
    runAutomationTurn(payload) {
        return this.host.runAutomationTurn(payload);
    }
    runBlockingLocalAgent(payload) {
        return this.host.runBlockingLocalAgent(payload);
    }
    createBackgroundAgent(payload) {
        return this.host.createBackgroundAgent(payload);
    }
    getLocalAgentSnapshot(agentId) {
        return this.host.getLocalAgentSnapshot(agentId);
    }
    appendThreadMessage(args) {
        return void this.host.appendThreadMessage(args);
    }
    persistVoiceTranscript(args) {
        return this.host.persistVoiceTranscript(args);
    }
    async handleVoiceChat(payload, callbacks) {
        const requestId = globalThis.crypto?.randomUUID?.() ??
            `voice-${Date.now()}-${Math.random().toString(36).slice(2)}`;
        let lastRunEventSeq = 0;
        let lastTaskEventSeq = 0;
        const activeTaskIds = new Set();
        const knownRunIds = new Set();
        let runTerminated = false;
        let unsubscribe = () => { };
        const maybeUnsubscribe = () => {
            if (!runTerminated || activeTaskIds.size > 0) {
                return;
            }
            unsubscribe();
        };
        const dispatch = (event) => {
            if (event.runId) {
                knownRunIds.add(event.runId);
            }
            const taskLifecycleEvent = isTaskLifecycleEventType(event.type);
            if (taskLifecycleEvent) {
                if (event.seq <= lastTaskEventSeq) {
                    return;
                }
                lastTaskEventSeq = event.seq;
            }
            else {
                if (event.seq <= lastRunEventSeq) {
                    return;
                }
                lastRunEventSeq = event.seq;
            }
            if (event.type === AGENT_STREAM_EVENT_TYPES.AGENT_STARTED &&
                event.agentId) {
                activeTaskIds.add(event.agentId);
            }
            else if (isTaskLifecycleTerminalType(event.type) && event.agentId) {
                activeTaskIds.delete(event.agentId);
            }
            switch (event.type) {
                case AGENT_STREAM_EVENT_TYPES.STREAM:
                    callbacks.onStream(event);
                    break;
                case AGENT_STREAM_EVENT_TYPES.STATUS:
                    callbacks.onStatus?.(event);
                    break;
                case AGENT_STREAM_EVENT_TYPES.TOOL_START:
                    callbacks.onToolStart(event);
                    break;
                case AGENT_STREAM_EVENT_TYPES.TOOL_END:
                    callbacks.onToolEnd(event);
                    break;
                case AGENT_STREAM_EVENT_TYPES.RUN_FINISHED:
                    callbacks.onRunFinished(event);
                    break;
                default:
                    if (taskLifecycleEvent) {
                        callbacks.onAgentEvent?.({
                            type: event.type,
                            conversationId: payload.conversationId,
                            rootRunId: event.runId,
                            agentId: event.agentId ?? "",
                            agentType: event.agentType ?? "",
                            ...(event.description ? { description: event.description } : {}),
                            ...(event.parentAgentId
                                ? { parentAgentId: event.parentAgentId }
                                : {}),
                            ...(event.result ? { result: event.result } : {}),
                            ...(event.error ? { error: event.error } : {}),
                            ...(event.statusText ? { statusText: event.statusText } : {}),
                            ...(event.groupKey ? { groupKey: event.groupKey } : {}),
                            ...(event.groupLabel ? { groupLabel: event.groupLabel } : {}),
                        });
                    }
                    break;
            }
            if (isRunTerminalEvent(event.type)) {
                runTerminated = true;
            }
            maybeUnsubscribe();
        };
        const offEvent = this.host.on("voice-agent-event", (eventPayload) => {
            if (eventPayload.requestId !== requestId) {
                return;
            }
            dispatch(eventPayload.event);
        });
        unsubscribe = () => {
            offEvent();
        };
        try {
            return await this.host.voiceOrchestratorChat({
                requestId,
                ...payload,
            });
        }
        catch (error) {
            unsubscribe();
            throw error;
        }
    }
    getVoiceOrchestratorConfig(payload) {
        return this.host.voiceOrchestratorConfig(payload);
    }
    executeVoiceTool(payload) {
        return this.host.voiceExecuteTool(payload);
    }
    webSearch(query, options) {
        return this.host.webSearch(query, options);
    }
    voiceWebSearch(payload) {
        return this.host.voiceWebSearch(payload);
    }
    runOneShotCompletion(payload) {
        return this.host.runOneShotCompletion(payload);
    }
    listStorePackages() {
        return this.host.listStorePackages();
    }
    getStorePackage(packageId) {
        return this.host.getStorePackage(packageId);
    }
    listStorePackageReleases(packageId) {
        return this.host.listStorePackageReleases(packageId);
    }
    getStorePackageRelease(packageId, releaseNumber) {
        return this.host.getStorePackageRelease(packageId, releaseNumber);
    }
    listCronJobs() {
        return this.host.listCronJobs();
    }
    listHeartbeats() {
        return this.host.listHeartbeats();
    }
    runCronJob(jobId) {
        return this.host.runCronJob(jobId);
    }
    removeCronJob(jobId) {
        return this.host.removeCronJob(jobId);
    }
    updateCronJob(jobId, patch) {
        return this.host.updateCronJob(jobId, patch);
    }
    upsertHeartbeat(input) {
        return this.host.upsertHeartbeat(input);
    }
    runHeartbeat(conversationId) {
        return this.host.runHeartbeat(conversationId);
    }
    listConversationEvents(args) {
        return this.host.listConversationEvents(args);
    }
    getConversationEventCount(args) {
        return this.host.getConversationEventCount(args);
    }
    onScheduleUpdated(listener) {
        return this.host.on("schedule-updated", listener);
    }
    onModelCatalogUpdated(listener) {
        return this.host.on("model-catalog-updated", listener);
    }
    onLocalChatUpdated(listener) {
        return this.host.on("local-chat-updated", listener);
    }
    onThreadActivityUpdated(listener) {
        return this.host.on("thread-activity-updated", listener);
    }
    onProjectsUpdated(listener) {
        return this.host.on("projects-updated", listener);
    }
    createSocialSession(payload) {
        return this.host.createSocialSession(payload);
    }
    updateSocialSessionStatus(payload) {
        return this.host.updateSocialSessionStatus(payload);
    }
    queueSocialSessionTurn(payload) {
        return this.host.queueSocialSessionTurn(payload);
    }
    getSocialSessionStatus() {
        return this.host.getSocialSessionStatus();
    }
    listProjects() {
        return this.host.listProjects();
    }
    startProject(slug) {
        return this.host.startProject(slug);
    }
    stopProject(slug) {
        return this.host.stopProject(slug);
    }
    killAllShells() {
        return void this.host.killAllShells();
    }
    killShellsByPort(port) {
        return this.host.killShellsByPort(port);
    }
    collectBrowserData(options) {
        return this.host.collectBrowserData(options);
    }
    collectAllSignals(options) {
        return this.host.collectAllSignals(options);
    }
    coreMemoryExists() {
        return this.host.coreMemoryExists();
    }
    discoveryKnowledgeExists() {
        return this.host.discoveryKnowledgeExists();
    }
    writeCoreMemory(content, options) {
        return this.host.writeCoreMemory(content, options);
    }
    writeDiscoveryKnowledge(payload) {
        return this.host.writeDiscoveryKnowledge(payload);
    }
    detectPreferredBrowserProfile() {
        return this.host.detectPreferredBrowserProfile();
    }
    listBrowserProfiles(browserType) {
        return this.host.listBrowserProfiles(browserType);
    }
    googleWorkspaceGetAuthStatus() {
        return this.host.googleWorkspaceGetAuthStatus();
    }
    googleWorkspaceConnect() {
        return this.host.googleWorkspaceConnect();
    }
    googleWorkspaceDisconnect() {
        return this.host.googleWorkspaceDisconnect();
    }
    triggerDreamNow(trigger) {
        return this.host.triggerDreamNow(trigger);
    }
}
