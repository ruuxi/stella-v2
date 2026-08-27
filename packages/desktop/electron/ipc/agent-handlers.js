import { ipcMain, webContents, } from "electron";
import crypto from "node:crypto";
import { promises as fs } from "fs";
import path from "path";
import { AGENT_RUN_FINISH_OUTCOMES, AGENT_STREAM_EVENT_TYPES, isTaskLifecycleTerminalType, } from "@stella/contracts/agent-runtime";
import { IPC_AGENT_ONE_SHOT_COMPLETION } from "@stella/contracts/desktop/ipc-channels";
import { createMonotonicSeqGenerator } from "./monotonic-seq.js";
import { stampAgentEventMainSeq, workerResumeLastSeq, } from "./agent-event-seq.js";
import { createLocalChatStreamCallbacks } from "./agent-stream-callbacks.js";
import { registerPrivilegedHandle } from "./privileged-ipc.js";
const redactSensitiveLogText = (value) => value
    .replace(/\b(sk-[A-Za-z0-9_-]{12,})\b/g, "[redacted-token]")
    .replace(/\b(Bearer\s+[A-Za-z0-9._-]{12,})\b/gi, "[redacted-token]")
    .replace(/\b([A-Za-z0-9_-]{20,}\.[A-Za-z0-9._-]{10,})\b/g, "[redacted-token]");
const AGENT_EVENT_BUFFER_LIMIT = 1000;
const AGENT_EVENT_BUFFER_TTL_MS = 10 * 60 * 1000;

const CLIENT_REQUEST_DEDUPE_TTL_MS = 5 * 60 * 1000;

const DURABLE_CHAT_ACCEPTANCE_WAIT_MS = 2_000;
const waitForDurableChatAcceptance = async (history, eventId) => {

    await new Promise((resolve) => setTimeout(resolve, 0));
    const deadline = Date.now() + DURABLE_CHAT_ACCEPTANCE_WAIT_MS;
    while (Date.now() < deadline) {
        if (history.hasEventId({ eventId, type: "user_message" })) {
            return true;
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
    }
    return history.hasEventId({ eventId, type: "user_message" });
};
const requestIdForClientSend = (clientRequestId) => `req:client:${crypto.createHash("sha256").update(clientRequestId).digest("hex").slice(0, 32)}`;

const MOBILE_KEEPALIVE_INTERVAL_MS = 15_000;
export const pageMobileAgentReplayEvents = (events, requestedMaxEvents) => {
    const maxEvents = typeof requestedMaxEvents === "number" &&
        Number.isFinite(requestedMaxEvents)
        ? Math.max(1, Math.min(250, Math.floor(requestedMaxEvents)))
        : null;
    if (maxEvents === null)
        return { events: [...events], hasMore: false };
    return {
        events: events.slice(0, maxEvents),
        hasMore: events.length > maxEvents,
    };
};
export const registerAgentHandlers = (options) => {
    const runOwners = new Map();
    const requestOwners = new Map();
    const runToRequestId = new Map();
    const requestToRunId = new Map();
    const terminalRunIds = new Set();
    const activeRunByConversation = new Map();

    const runningAgentsByRunId = new Map();
    const nextAgentEventSeq = createMonotonicSeqGenerator();
    const conversationEventBuffers = new Map();
    const clientRequestIndex = new Map();
    const clientRequestKeyByRequestId = new Map();

    const pendingCancelRequestIds = new Set();

    let lastMobileAgentBroadcastAt = 0;
    const pruneClientRequestIndex = () => {
        const now = Date.now();
        for (const [key, entry] of clientRequestIndex) {
            if (now - entry.createdAt > CLIENT_REQUEST_DEDUPE_TTL_MS) {
                clientRequestIndex.delete(key);
                clientRequestKeyByRequestId.delete(entry.requestId);
            }
        }
    };
    const pruneConversationEventBuffers = () => {
        const now = Date.now();
        for (const [conversationId, buffer] of conversationEventBuffers.entries()) {
            if (activeRunByConversation.has(conversationId))
                continue;
            if (now - buffer.updatedAt > AGENT_EVENT_BUFFER_TTL_MS) {
                conversationEventBuffers.delete(conversationId);
            }
        }
    };
    const bufferConversationEvent = (conversationId, event) => {
        const existing = conversationEventBuffers.get(conversationId);
        if (existing) {
            existing.events.push(event);
            if (existing.events.length > AGENT_EVENT_BUFFER_LIMIT) {
                existing.events.splice(0, existing.events.length - AGENT_EVENT_BUFFER_LIMIT);
            }
            existing.updatedAt = Date.now();
            return;
        }
        conversationEventBuffers.set(conversationId, {
            events: [event],
            updatedAt: Date.now(),
        });
    };
    const resolveReceiverId = (event, targetWebContentsId) => {
        if (typeof targetWebContentsId === "number") {
            return targetWebContentsId;
        }
        if (event.requestId) {
            const requestOwner = requestOwners.get(event.requestId);
            if (typeof requestOwner === "number") {
                return requestOwner;
            }
        }
        const runOwner = runOwners.get(event.runId);
        return typeof runOwner === "number" ? runOwner : undefined;
    };
    const trackRunningAgent = (event) => {
        if (!event.agentId)
            return;
        const runId = event.rootRunId ?? event.runId;
        if (event.type === AGENT_STREAM_EVENT_TYPES.AGENT_STARTED) {
            const running = runningAgentsByRunId.get(runId) ?? new Set();
            running.add(event.agentId);
            runningAgentsByRunId.set(runId, running);
            return;
        }
        if (isTaskLifecycleTerminalType(event.type)) {
            const running = runningAgentsByRunId.get(runId);
            if (!running)
                return;
            running.delete(event.agentId);
            if (running.size === 0)
                runningAgentsByRunId.delete(runId);
        }
    };
    const emitAgentEvent = (event, targetWebContentsId) => {
        const normalizedEvent = stampAgentEventMainSeq(event, nextAgentEventSeq());
        const trackedRunId = normalizedEvent.rootRunId ?? normalizedEvent.runId;
        if (normalizedEvent.requestId) {
            runToRequestId.set(trackedRunId, normalizedEvent.requestId);
        }
        if (typeof targetWebContentsId === "number") {
            runOwners.set(trackedRunId, targetWebContentsId);
        }
        if (normalizedEvent.type === AGENT_STREAM_EVENT_TYPES.RUN_FINISHED) {
            const activeRun = activeRunByConversation.get(normalizedEvent.conversationId);
            if (activeRun?.runId === normalizedEvent.runId) {
                activeRunByConversation.delete(normalizedEvent.conversationId);
            }
            runningAgentsByRunId.delete(trackedRunId);
        }
        else {
            trackRunningAgent(normalizedEvent);
        }
        bufferConversationEvent(normalizedEvent.conversationId, normalizedEvent);
        pruneConversationEventBuffers();
        const broadcastToMobile = options.getBroadcastToMobile?.();
        if (broadcastToMobile) {
            broadcastToMobile("agent:event", normalizedEvent);
            lastMobileAgentBroadcastAt = Date.now();
        }
        const receiverId = resolveReceiverId(normalizedEvent, targetWebContentsId);
        if (receiverId == null) {
            return;
        }
        const receiver = webContents.fromId(receiverId);
        if (receiver && !receiver.isDestroyed()) {
            receiver.send("agent:event", normalizedEvent);
        }
    };

    const emitMobileKeepalives = () => {
        const broadcastToMobile = options.getBroadcastToMobile?.();
        if (!broadcastToMobile)
            return;
        if (activeRunByConversation.size === 0)
            return;
        if (Date.now() - lastMobileAgentBroadcastAt <
            MOBILE_KEEPALIVE_INTERVAL_MS) {
            return;
        }
        for (const activeRun of activeRunByConversation.values()) {
            broadcastToMobile("agent:event", {
                type: "keepalive",
                runId: activeRun.runId,
                conversationId: activeRun.conversationId,
                ...(activeRun.requestId ? { requestId: activeRun.requestId } : {}),
                ...(activeRun.userMessageId
                    ? { userMessageId: activeRun.userMessageId }
                    : {}),
            });
        }
        lastMobileAgentBroadcastAt = Date.now();
    };
    const mobileKeepaliveTimer = setInterval(emitMobileKeepalives, MOBILE_KEEPALIVE_INTERVAL_MS);
    mobileKeepaliveTimer.unref?.();
    const scheduleRunCleanup = (runId, requestId) => {
        setTimeout(() => {
            const hasRunningTasks = (runningAgentsByRunId.get(runId)?.size ?? 0) > 0;
            if (hasRunningTasks) {
                scheduleRunCleanup(runId, requestId);
                return;
            }
            runOwners.delete(runId);
            runningAgentsByRunId.delete(runId);
            terminalRunIds.delete(runId);
            const linkedRequestId = requestId ?? runToRequestId.get(runId);
            if (linkedRequestId) {
                requestOwners.delete(linkedRequestId);
                requestToRunId.delete(linkedRequestId);
                pendingCancelRequestIds.delete(linkedRequestId);
                runToRequestId.delete(runId);
                const clientRequestKey = clientRequestKeyByRequestId.get(linkedRequestId);
                if (clientRequestKey) {
                    clientRequestIndex.delete(clientRequestKey);
                    clientRequestKeyByRequestId.delete(linkedRequestId);
                }
            }
            pruneConversationEventBuffers();
        }, 60_000);
    };
    registerPrivilegedHandle(options, IPC_AGENT_ONE_SHOT_COMPLETION, async (_event, payload) => {
        const stellaHostRunner = options.getStellaHostRunner();
        if (!stellaHostRunner) {
            throw new Error("Stella runtime is not ready.");
        }
        return await stellaHostRunner.runOneShotCompletion(payload);
    });
    registerPrivilegedHandle(options, "agent:healthCheck", async () => {
        const stellaHostRunner = options.getStellaHostRunner();
        if (!stellaHostRunner) {
            return null;
        }
        const rawResult = await stellaHostRunner.agentHealthCheck();
        const result = rawResult?.ready === false &&
            rawResult.reason === "Missing auth token" &&
            !options.isHostAuthAuthenticated()
            ? { ...rawResult, reason: "Awaiting auth token" }
            : rawResult;
        return result;
    });
    registerPrivilegedHandle(options, "agent:getActiveRun", async () => {
        const stellaHostRunner = options.getStellaHostRunner();
        if (!stellaHostRunner)
            return null;
        const health = await stellaHostRunner.agentHealthCheck();
        if (!health?.ready)
            return null;
        return await stellaHostRunner.getActiveOrchestratorRun();
    });
    registerPrivilegedHandle(options, "agent:getAppSessionStartedAt", async () => {
        return options.getAppSessionStartedAt();
    });
    registerPrivilegedHandle(options, "agent:resume", async (event, payload) => {
        pruneConversationEventBuffers();
        const conversationId = typeof payload.conversationId === "string"
            ? payload.conversationId.trim()
            : "";
        const lastSeq = Number.isFinite(payload.lastSeq) ? payload.lastSeq : 0;
        if (!conversationId) {
            return {
                activeRun: null,
                events: [],
            };
        }
        const buffer = conversationEventBuffers.get(conversationId);
        let activeRun = activeRunByConversation.get(conversationId) ?? null;
        let resumeRunId = activeRun?.runId ?? null;
        if (!resumeRunId) {
            const stellaHostRunner = options.getStellaHostRunner();
            const discovered = await stellaHostRunner
                ?.listActiveRuns()
                .catch(() => ({ runs: [] }));
            const match = discovered?.runs.find((run) => run.conversationId === conversationId);
            if (match) {
                resumeRunId = match.runId;
                if (match.kind === "active") {
                    activeRun = {
                        runId: match.runId,
                        conversationId,
                        ...(match.uiVisibility
                            ? { uiVisibility: match.uiVisibility }
                            : {}),
                    };
                    activeRunByConversation.set(conversationId, activeRun);
                }
            }
        }
        const bufferedEvents = buffer
            ? buffer.events.filter((agentEvent) => agentEvent.seq > lastSeq)
            : [];
        let events = bufferedEvents;
        if (resumeRunId && events.length === 0) {
            const stellaHostRunner = options.getStellaHostRunner();
            if (stellaHostRunner) {
                try {
                    const replay = await stellaHostRunner.resumeRunEvents({
                        runId: resumeRunId,
                        lastSeq: workerResumeLastSeq(payload),
                    });
                    if (!replay.exhausted) {
                        events = replay.events.map((event) => {
                            const remapped = stampAgentEventMainSeq({
                                ...event,
                                type: event.type,
                                conversationId: event.conversationId ?? conversationId,
                            }, nextAgentEventSeq());
                            bufferConversationEvent(remapped.conversationId, remapped);
                            return remapped;
                        });
                    }
                }
                catch {

                }
            }
        }
        const page = pageMobileAgentReplayEvents(events, payload.maxEvents);
        events = page.events;
        const resumedRequestId = activeRun?.requestId ??
            events.find((agentEvent) => typeof agentEvent.requestId === "string")
                ?.requestId ??
            (resumeRunId ? runToRequestId.get(resumeRunId) : undefined);
        if (resumeRunId && activeRun) {
            const stellaHostRunner = options.getStellaHostRunner();
            const senderWebContentsId = event.sender.id;
            const requestId = resumedRequestId ?? `resume:${conversationId}:${resumeRunId}`;
            activeRun = {
                ...activeRun,
                requestId,
            };
            activeRunByConversation.set(conversationId, activeRun);
            runOwners.set(resumeRunId, senderWebContentsId);
            runToRequestId.set(resumeRunId, requestId);
            requestOwners.set(requestId, senderWebContentsId);
            requestToRunId.set(requestId, resumeRunId);
            stellaHostRunner?.attachResumedLocalChatSession({
                conversationId,
                runId: resumeRunId,
                requestId,
                ...(activeRun.userMessageId
                    ? { userMessageId: activeRun.userMessageId }
                    : {}),
                ...(activeRun.uiVisibility
                    ? { uiVisibility: activeRun.uiVisibility }
                    : {}),
                active: true,
            }, createLocalChatStreamCallbacks({
                conversationId,
                requestId,
                senderWebContentsId,
                emitAgentEvent,
                terminalRunIds,
                runOwners,
                runToRequestId,
                requestToRunId,
                activeRunByConversation,
                scheduleRunCleanup,
            }));
        }
        return {
            activeRun,
            events,
            hasMore: page.hasMore,
        };
    });
    registerPrivilegedHandle(options, "agent:startChat", async (event, payload) => {
        const stellaHostRunner = options.getStellaHostRunner();
        if (!stellaHostRunner) {
            throw new Error("Stella runtime not available");
        }

        const clientRequestId = typeof payload.clientRequestId === "string"
            ? payload.clientRequestId.trim()
            : "";
        const stableUserMessageId = typeof payload.userMessageEventId === "string"
            ? payload.userMessageEventId.trim()
            : "";
        const stableRequestId = clientRequestId
            ? requestIdForClientSend(clientRequestId)
            : "";
        if (clientRequestId) {
            pruneClientRequestIndex();

            if (stableUserMessageId &&
                options.localChatHistoryService.hasEventId({
                    eventId: stableUserMessageId,
                    type: "user_message",
                })) {
                const activeReplay = activeRunByConversation.get(payload.conversationId);
                return {
                    requestId: stableRequestId,
                    userMessageId: stableUserMessageId,
                    accepted: true,
                    deduplicated: true,
                    ...(activeReplay?.userMessageId === stableUserMessageId
                        ? { runId: activeReplay.runId }
                        : {}),
                };
            }
            const existing = clientRequestIndex.get(clientRequestId);
            if (existing) {

                return {
                    requestId: existing.requestId,
                    ...(requestToRunId.get(existing.requestId)
                        ? { runId: requestToRunId.get(existing.requestId) }
                        : {}),
                    ...(stableUserMessageId
                        ? { userMessageId: stableUserMessageId, accepted: false }
                        : {}),
                    deduplicated: true,
                };
            }
        }
        const senderWebContentsId = event.sender.id;
        const requestId = stableRequestId || `req:${crypto.randomUUID()}`;
        requestOwners.set(requestId, senderWebContentsId);
        if (clientRequestId) {
            clientRequestIndex.set(clientRequestId, {
                requestId,
                createdAt: Date.now(),
            });
            clientRequestKeyByRequestId.set(requestId, clientRequestId);
        }
        const releaseClientRequest = () => {
            pendingCancelRequestIds.delete(requestId);
            if (clientRequestId) {
                clientRequestIndex.delete(clientRequestId);
                clientRequestKeyByRequestId.delete(requestId);
            }
        };
        try {
            await stellaHostRunner.waitUntilConnected(5_000);
            await stellaHostRunner.waitUntilReady(15_000);
        }
        catch (error) {

            requestOwners.delete(requestId);
            releaseClientRequest();
            throw error;
        }
        console.log(`[stella:trace] IPC agent:startChat | convId=${payload.conversationId} | prompt=${redactSensitiveLogText(payload.userPrompt.slice(0, 200))}`);
        const streamCallbacks = createLocalChatStreamCallbacks({
            conversationId: payload.conversationId,
            requestId,
            senderWebContentsId,
            emitAgentEvent,
            terminalRunIds,
            runOwners,
            runToRequestId,
            requestToRunId,
            activeRunByConversation,
            scheduleRunCleanup,
            afterRunStarted: (runId) => {
                if (pendingCancelRequestIds.delete(requestId)) {
                    stellaHostRunner.cancelLocalChat(runId);
                }
            },
            onMissingRootRunId: (ev) => {
                console.warn("[chat] Dropping task event without rootRunId:", ev.type, ev.agentId);
            },
        });
        const emitRunFinished = (args) => streamCallbacks.onRunFinished(args);
        const localChatStartPromise = stellaHostRunner
            .handleLocalChat({
            ...payload,
            requestId,
        }, streamCallbacks)
            .catch((error) => {
            const message = error instanceof Error ? error.message : "Stella runtime failed";
            const startedRunId = requestToRunId.get(requestId);
            if (startedRunId) {
                emitRunFinished({
                    runId: startedRunId,
                    outcome: AGENT_RUN_FINISH_OUTCOMES.ERROR,
                    error: message,
                    reason: message,
                });
                return;
            }
            console.error("[chat] Local chat failed before runtime run start:", message);
            requestOwners.delete(requestId);
            releaseClientRequest();
            throw error;
        });
        let localChatStart;
        if (stableUserMessageId) {
            const startOutcome = await Promise.race([
                localChatStartPromise.then((value) => ({ kind: "started", value })),
                waitForDurableChatAcceptance(options.localChatHistoryService, stableUserMessageId).then((accepted) => ({ kind: accepted ? "accepted" : "pending" })),
            ]);
            if (startOutcome.kind === "accepted") {

                void localChatStartPromise.catch((error) => {
                    console.error("[chat] Durably accepted chat failed before runtime run start:", error instanceof Error ? error.message : String(error));
                });
                return {
                    requestId,
                    userMessageId: stableUserMessageId,
                    accepted: true,
                };
            }
            localChatStart = startOutcome.kind === "started"
                ? startOutcome.value
                : await localChatStartPromise;
        }
        else {
            localChatStart = await localChatStartPromise;
        }
        return {
            requestId,
            ...(localChatStart?.runId ? { runId: localChatStart.runId } : {}),
            ...(stableUserMessageId
                ? { userMessageId: stableUserMessageId, accepted: true }
                : {}),
        };
    });
    registerPrivilegedHandle(options, "agent:sendInput", async (_event, payload) => {
        const stellaHostRunner = options.getStellaHostRunner();
        if (!stellaHostRunner) {
            throw new Error("Stella runtime not available");
        }
        await stellaHostRunner.waitUntilConnected(5_000);
        return await stellaHostRunner.sendAgentInput(payload);
    });
    ipcMain.on("agent:cancelChat", (event, target) => {
        if (!options.assertPrivilegedSender(event, "agent:cancelChat")) {
            return;
        }
        const stellaHostRunner = options.getStellaHostRunner();
        if (!stellaHostRunner) {
            return;
        }
        const explicitRunId = typeof target === "string"
            ? target.trim()
            : typeof target?.runId === "string"
                ? target.runId.trim()
                : "";
        const requestId = typeof target === "object" &&
            target !== null &&
            typeof target.requestId === "string"
            ? target.requestId.trim()
            : "";
        const runId = explicitRunId || (requestId ? requestToRunId.get(requestId) : "");
        if (runId) {
            if (requestId) {
                pendingCancelRequestIds.delete(requestId);
            }
            stellaHostRunner.cancelLocalChat(runId);
            return;
        }
        if (requestId) {
            pendingCancelRequestIds.add(requestId);
        }
    });

    const TEST_BROKEN_FILE = path.join(options.stellaAppDir, "src", "testing", "__vite_error_trigger.tsx");
    registerPrivilegedHandle(options, "devtest:triggerViteError", async () => {
        await fs.mkdir(path.dirname(TEST_BROKEN_FILE), { recursive: true });
        await fs.writeFile(TEST_BROKEN_FILE, "const x: number = {\n// deliberately broken syntax\n", "utf-8");
        return { ok: true };
    });
    registerPrivilegedHandle(options, "devtest:fixViteError", async () => {
        try {
            await fs.unlink(TEST_BROKEN_FILE);
        }
        catch {

        }
        return { ok: true };
    });
};
