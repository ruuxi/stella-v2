import { useCallback, useEffect, useMemo, useReducer, useRef, useState, useSyncExternalStore, } from "react";
import { showToast } from "@/ui/toast";
import { useResumeAgentRun } from "../hooks/use-resume-agent-run";
import { attachmentsForStartChat, initialStoreState, streamStoreReducer, } from "./store";
import { useReasoningBatcher } from "./use-reasoning-batcher";
import { clearConversationTaskDecorations, getTaskDecorationsSnapshot, subscribeTaskDecorations, } from "./task-decoration-store";
import { useStreamTextAnimation } from "./use-stream-text-animation";
import { DirectAssistantHandoffController, } from "./direct-assistant-handoff";
import { useAgentEventHandler } from "./use-agent-event-handler";
import { useApplyResumeSnapshot } from "./use-resume-snapshot";
import { assistantScrollFollowKey, linkStreamingAssistantCanonicalMessage, reconcileStreamingAssistantCanonicalMessage, streamingAssistantOverlayId, } from "./streaming-types";
import { beginAssistantScrollFollow, clearAssistantScrollFollow, notifyAssistantScrollFollowLayoutChange, } from "@/shell/chat-scroll-follow";
import { resolveAgentNotReadyToast } from "./agent-stream-errors";
import { isStellaLimitOrAuthReason, resolveStellaProviderErrorToast, } from "./stella-provider-error-toast";
export function useLocalAgentStream({ activeConversationId, storageMode, onRunStarted, onRunFinished, }) {
    const [storeState, dispatch] = useReducer(streamStoreReducer, initialStoreState);
    const [pendingUserMessageId, setPendingUserMessageId] = useState(null);
    /**
     * In-memory assistant messages currently being streamed for the
     * active conversation. The renderer merges these into
     * `displayMessages` so the live stream is just a regular assistant
     * row (whose text grows) rather than a separate "tail" overlay.
     * Entries keep owning the visible text while present, even after
     * SQLite has persisted the matching `(userMessageId, indexInTurn)`
     * slot.
     */
    const [streamingAssistants, setStreamingAssistants] = useState([]);
    const streamingAssistantsRef = useRef([]);
    const commitStreamingAssistants = useCallback((update) => {
        const current = streamingAssistantsRef.current;
        const next = typeof update === "function" ? update(current) : update;
        if (next === current)
            return;
        streamingAssistantsRef.current = next;
        setStreamingAssistants(next);
    }, []);
    const activeConversationIdRef = useRef(activeConversationId);
    const activeRunIdByConversationRef = useRef(storeState.activeRunIdByConversation);
    const lastSeqByConversationRef = useRef(new Map());
    const resumeSeqByConversationRef = useRef(new Map());
    const seenSourceEventKeysRef = useRef(new Set());
    const terminalRunIdsRef = useRef(new Set());
    const pendingRequestIdsRef = useRef(new Set());
    /**
     * Active slot index per `userMessageId` for the in-flight run. The
     * first chunk of a turn pushes overlay slot 1; each
     * `ASSISTANT_MESSAGE` boundary increments the index; the next chunk
     * pushes overlay slot N at the new index.
     */
    const nextSlotIndexByUserMessageIdRef = useRef(new Map());
    const workingModeByRunIdRef = useRef(new Map());
    const receivedSlotIdsRef = useRef(new Set());
    const queuedStreamChunksBySlotIdRef = useRef(new Map());
    const queuedSlotsAwaitingFinishRef = useRef(new Set());
    const pendingCanonicalBySlotIdRef = useRef(new Map());
    const paintScheduledSlotIdsRef = useRef(new Set());
    const pendingPaintFrameIdsRef = useRef(new Set());
    const startQueuedSlotRef = useRef(() => { });
    const directHandoffControllerRef = useRef(null);
    if (directHandoffControllerRef.current === null) {
        directHandoffControllerRef.current = new DirectAssistantHandoffController({
            onFadeStart: (previousSlotId) => {
                commitStreamingAssistants((current) => {
                    const index = current.findIndex((slot) => slot._id === previousSlotId);
                    const slot = index >= 0 ? current[index] : undefined;
                    if (!slot || slot.textTransition === "fading")
                        return current;
                    const next = current.slice();
                    next[index] = { ...slot, textTransition: "fading" };
                    return next;
                });
            },
            onSwap: (previousSlotId, nextSlotId) => {
                commitStreamingAssistants((current) => {
                    let changed = false;
                    const next = current.map((slot) => {
                        if (slot._id === previousSlotId && slot.textTransition !== "hidden") {
                            changed = true;
                            return { ...slot, textTransition: "hidden" };
                        }
                        if (slot._id === nextSlotId && slot.textTransition === "queued") {
                            changed = true;
                            const { textTransition: _omit, ...visibleSlot } = slot;
                            return visibleSlot;
                        }
                        return slot;
                    });
                    return changed ? next : current;
                });
                startQueuedSlotRef.current(nextSlotId);
            },
        });
    }
    const startAttemptRef = useRef(0);
    const agentStreamCleanupRef = useRef(null);
    const activeRunId = activeConversationId
        ? (storeState.activeRunIdByConversation[activeConversationId] ?? null)
        : null;
    const activeRun = activeRunId
        ? (storeState.runsById[activeRunId] ?? null)
        : null;
    const isStreaming = Boolean(activeRun && !activeRun.terminal);
    const runtimeStatusText = activeRun?.statusText ?? null;
    const activeToolEntry = Object.entries(activeRun?.activeToolCalls ?? {}).at(-1);
    const activeToolCallId = activeToolEntry?.[0] ?? null;
    const activeToolName = activeToolEntry?.[1]?.toolName ?? null;
    const latestCompletedTool = activeRun?.latestCompletedTool ?? null;
    const hasToolActivity = Boolean(activeRun?.hasToolActivity);
    const isToolActive = Boolean(activeToolName);
    const isStreamingResponseText = Boolean(activeRun?.isStreamingText);
    const reasoningText = "";
    /** Apply an idempotent full-text animation frame to its overlay slot. */
    const revealStreamText = useCallback((slotId, visibleText) => {
        commitStreamingAssistants((current) => {
            const index = current.findIndex((slot) => slot._id === slotId);
            const slot = index >= 0 ? current[index] : undefined;
            if (!slot || slot.text === visibleText)
                return current;
            const next = current.slice();
            next[index] = { ...slot, text: visibleText };
            return next;
        });
        notifyAssistantScrollFollowLayoutChange();
    }, [commitStreamingAssistants]);
    const { enqueue: animateStreamText, finish: finishStreamText, discard: discardStreamText, } = useStreamTextAnimation({ onReveal: revealStreamText });
    /**
     * Lock one exact slot only after the frame-driven playout has drained.
     * The handoff clock starts after two requestAnimationFrame turns so the
     * fully revealed React/Markdown state has reached a browser paint.
     */
    const lockStreamSlot = useCallback((slotId) => {
        const canonical = pendingCanonicalBySlotIdRef.current.get(slotId);
        pendingCanonicalBySlotIdRef.current.delete(slotId);
        commitStreamingAssistants((current) => {
            let next = current;
            if (canonical?.canonicalText !== undefined) {
                next = reconcileStreamingAssistantCanonicalMessage(next, {
                    userMessageId: canonical.userMessageId,
                    indexInTurn: canonical.indexInTurn,
                    ...(canonical.canonicalMessageId
                        ? { canonicalMessageId: canonical.canonicalMessageId }
                        : {}),
                    canonicalText: canonical.canonicalText,
                });
            }
            else if (canonical?.canonicalMessageId) {
                next = linkStreamingAssistantCanonicalMessage(next, {
                    userMessageId: canonical.userMessageId,
                    indexInTurn: canonical.indexInTurn,
                    canonicalMessageId: canonical.canonicalMessageId,
                });
            }
            const index = next.findIndex((slot) => slot._id === slotId);
            const slot = index >= 0 ? next[index] : undefined;
            if (!slot || slot.locked)
                return next;
            const locked = next.slice();
            locked[index] = { ...slot, locked: true };
            return locked;
        });
        if (paintScheduledSlotIdsRef.current.has(slotId))
            return;
        paintScheduledSlotIdsRef.current.add(slotId);
        const firstFrameId = window.requestAnimationFrame(() => {
            pendingPaintFrameIdsRef.current.delete(firstFrameId);
            const secondFrameId = window.requestAnimationFrame(() => {
                pendingPaintFrameIdsRef.current.delete(secondFrameId);
                paintScheduledSlotIdsRef.current.delete(slotId);
                directHandoffControllerRef.current?.markPainted(slotId);
            });
            pendingPaintFrameIdsRef.current.add(secondFrameId);
        });
        pendingPaintFrameIdsRef.current.add(firstFrameId);
    }, [commitStreamingAssistants]);
    startQueuedSlotRef.current = (slotId) => {
        const queued = queuedStreamChunksBySlotIdRef.current.get(slotId);
        const slot = streamingAssistantsRef.current.find((entry) => entry._id === slotId);
        if (!queued || !slot)
            return;
        queuedStreamChunksBySlotIdRef.current.delete(slotId);
        beginAssistantScrollFollow(assistantScrollFollowKey(slot.userMessageId, slot.indexInTurn));
        animateStreamText(slotId, queued.runId, queued.chunks.join(""));
        if (queuedSlotsAwaitingFinishRef.current.delete(slotId)) {
            finishStreamText((entry) => entry.slotId === slotId, lockStreamSlot);
        }
        notifyAssistantScrollFollowLayoutChange();
    };
    const lockAndDiscardStreamSlot = useCallback((slotId) => {
        lockStreamSlot(slotId);
        discardStreamText((entry) => entry.slotId === slotId);
    }, [discardStreamText, lockStreamSlot]);
    /**
     * RUN_STARTED for a visible run: finish any prior run's pending playout and
     * reset the per-turn slot index so the next chunk lands on a fresh slot.
     * Prior overlays remain in the timeline; failed/canceled runs may not have a
     * persisted twin, so dropping them here would lose received response text.
     */
    const beginStreamingRun = useCallback((args) => {
        clearAssistantScrollFollow();
        finishStreamText((entry) => entry.runId !== args.runId, lockAndDiscardStreamSlot);
        if (args.workingMode) {
            workingModeByRunIdRef.current.set(args.runId, args.workingMode);
        }
        if (args.userMessageId) {
            nextSlotIndexByUserMessageIdRef.current.set(args.userMessageId, 1);
        }
    }, [finishStreamText, lockAndDiscardStreamSlot]);
    /**
     * STREAM chunk: ensure the current overlay slot for
     * `(userMessageId, currentIndex)` exists, then hand the chunk to the
     * frame-driven text animator. Provider chunk boundaries stay out of the
     * visual layer; hidden runs and runs without a `userMessageId` never produce
     * overlays.
     */
    const acceptStreamChunk = useCallback((args) => {
        if (!args.chunk)
            return;
        if (!args.userMessageId) {
            return;
        }
        const userMessageId = args.userMessageId;
        if (args.workingMode) {
            workingModeByRunIdRef.current.set(args.runId, args.workingMode);
        }
        const expectedIndex = nextSlotIndexByUserMessageIdRef.current.get(userMessageId) ?? 1;
        nextSlotIndexByUserMessageIdRef.current.set(userMessageId, expectedIndex);
        const slotId = streamingAssistantOverlayId(userMessageId, expectedIndex);
        receivedSlotIdsRef.current.add(slotId);
        const existing = streamingAssistantsRef.current.find((slot) => slot._id === slotId);
        if (existing?.textTransition === "queued") {
            const queued = queuedStreamChunksBySlotIdRef.current.get(slotId);
            if (queued) {
                queued.chunks.push(args.chunk);
            }
            else {
                queuedStreamChunksBySlotIdRef.current.set(slotId, {
                    runId: args.runId,
                    chunks: [args.chunk],
                });
            }
            return;
        }
        if (existing) {
            if (existing.locked) {
                directHandoffControllerRef.current?.markUnpainted(slotId);
                commitStreamingAssistants((current) => {
                    const index = current.findIndex((slot) => slot._id === slotId);
                    const slot = index >= 0 ? current[index] : undefined;
                    if (!slot || !slot.locked)
                        return current;
                    const next = current.slice();
                    next[index] = { ...slot, locked: false };
                    return next;
                });
            }
            animateStreamText(slotId, args.runId, args.chunk);
            return;
        }
        const previousSlotId = expectedIndex > 1
            ? streamingAssistantOverlayId(userMessageId, expectedIndex - 1)
            : null;
        const previousSlot = previousSlotId
            ? streamingAssistantsRef.current.find((slot) => slot._id === previousSlotId)
            : undefined;
        const shouldQueueDirectReplacement = workingModeByRunIdRef.current.get(args.runId) === "direct" &&
            Boolean(previousSlotId && previousSlot && previousSlot.textTransition !== "hidden");
        const newSlot = {
                _id: slotId,
                userMessageId,
                indexInTurn: expectedIndex,
                text: "",
                ...(args.responseTarget
                    ? { responseTarget: args.responseTarget }
                    : {}),
                timestamp: Date.now(),
                runId: args.runId,
                ...(shouldQueueDirectReplacement ? { textTransition: "queued" } : {}),
            };
        commitStreamingAssistants((current) => {
            const prepared = shouldQueueDirectReplacement && previousSlotId
                ? current.map((slot) => slot._id === previousSlotId
                    ? { ...slot, textTransition: "holding" }
                    : slot)
                : current;
            return [...prepared, newSlot];
        });
        if (shouldQueueDirectReplacement && previousSlotId) {
            queuedStreamChunksBySlotIdRef.current.set(slotId, {
                runId: args.runId,
                chunks: [args.chunk],
            });
            directHandoffControllerRef.current?.queue(previousSlotId, slotId);
        }
        else {
            beginAssistantScrollFollow(assistantScrollFollowKey(userMessageId, expectedIndex));
            animateStreamText(slotId, args.runId, args.chunk);
            notifyAssistantScrollFollowLayoutChange();
        }
    }, [animateStreamText, commitStreamingAssistants]);
    /**
     * `ASSISTANT_MESSAGE` boundary: lock the current slot, increment the
     * slot index, and let the next chunk create the next slot.
     */
    const finalizeMessageBoundary = useCallback((args) => {
        if (args.workingMode) {
            workingModeByRunIdRef.current.set(args.runId, args.workingMode);
        }
        const currentIndex = args.userMessageId
            ? (nextSlotIndexByUserMessageIdRef.current.get(args.userMessageId) ?? 1)
            : null;
        if (args.userMessageId && currentIndex !== null) {
            const slotId = streamingAssistantOverlayId(args.userMessageId, currentIndex);
            pendingCanonicalBySlotIdRef.current.set(slotId, {
                userMessageId: args.userMessageId,
                indexInTurn: currentIndex,
                ...(args.canonicalMessageId
                    ? { canonicalMessageId: args.canonicalMessageId }
                    : {}),
                ...(args.canonicalText !== undefined
                    ? { canonicalText: args.canonicalText }
                    : {}),
            });
            const slot = streamingAssistantsRef.current.find((entry) => entry._id === slotId);
            if (slot?.textTransition === "queued") {
                queuedSlotsAwaitingFinishRef.current.add(slotId);
            }
            else if (receivedSlotIdsRef.current.has(slotId)) {
                finishStreamText((entry) => entry.slotId === slotId, lockStreamSlot);
            }
            else {
                lockStreamSlot(slotId);
            }
            // Keep the active follow key until the next slot's first chunk
            // calls `beginAssistantScrollFollow` — clearing here dropped
            // auto-follow for late layout (image cards, undo) after the
            // final assistant message in a run.
            nextSlotIndexByUserMessageIdRef.current.set(args.userMessageId, currentIndex + 1);
        }
    }, [finishStreamText, lockStreamSlot]);
    /**
     * `RUN_FINISHED` (any outcome): lock the current slot and stop
     * expecting more chunks. The remaining overlay entries stay in the
     * array so the active UI does not swap from streamed text to SQLite
     * just because persistence completed.
     */
    const finalizeRunOnFinish = useCallback((args) => {
        for (const [slotId, queued] of queuedStreamChunksBySlotIdRef.current) {
            if (queued.runId === args.runId) {
                queuedSlotsAwaitingFinishRef.current.add(slotId);
            }
        }
        finishStreamText((entry) => entry.runId === args.runId, lockStreamSlot);
    }, [finishStreamText, lockStreamSlot]);
    /**
     * Marks persisted text restored for a resumed run as visible response text.
     * Live runs are marked directly from their first non-whitespace stream
     * event, without waiting for a client-side animation or paint callback.
     */
    const markAssistantResponseTextStarted = useCallback(() => {
        const conversationId = activeConversationIdRef.current;
        const runId = conversationId
            ? (activeRunIdByConversationRef.current[conversationId] ?? null)
            : null;
        if (runId) {
            dispatch({ type: "mark-streaming-text", runId });
        }
    }, []);
    activeConversationIdRef.current = activeConversationId;
    activeRunIdByConversationRef.current = storeState.activeRunIdByConversation;
    const reasoning = useReasoningBatcher();
    const lifecycleCallbacks = useMemo(() => ({
        onRunStarted,
        onRunFinished,
    }), [onRunFinished, onRunStarted]);
    useEffect(() => () => {
        if (agentStreamCleanupRef.current) {
            agentStreamCleanupRef.current();
            agentStreamCleanupRef.current = null;
        }
        directHandoffControllerRef.current?.reset();
        for (const frameId of pendingPaintFrameIdsRef.current) {
            window.cancelAnimationFrame(frameId);
        }
        pendingPaintFrameIdsRef.current.clear();
    }, []);
    const resetStreamingState = useCallback(() => {
        clearAssistantScrollFollow();
        discardStreamText();
        directHandoffControllerRef.current?.reset();
        for (const frameId of pendingPaintFrameIdsRef.current) {
            window.cancelAnimationFrame(frameId);
        }
        pendingPaintFrameIdsRef.current.clear();
        paintScheduledSlotIdsRef.current.clear();
        workingModeByRunIdRef.current.clear();
        receivedSlotIdsRef.current.clear();
        queuedStreamChunksBySlotIdRef.current.clear();
        queuedSlotsAwaitingFinishRef.current.clear();
        pendingCanonicalBySlotIdRef.current.clear();
        setPendingUserMessageId(null);
        commitStreamingAssistants([]);
        nextSlotIndexByUserMessageIdRef.current.clear();
        // This callback is handed to `useResumeAgentRun`, whose effect depends on
        // its identity. Reading the live ids from refs keeps the callback stable
        // across RUN_FINISHED; otherwise terminal state changed `activeRunId`,
        // restarted the resume effect, and its no-active-run cleanup discarded a
        // still-draining text buffer so SQLite's full message appeared at once.
        const conversationId = activeConversationIdRef.current;
        if (conversationId) {
            clearConversationTaskDecorations(conversationId);
            dispatch({
                type: "clear-conversation-run",
                conversationId,
            });
        }
    }, [commitStreamingAssistants, discardStreamText]);
    const handleAgentEvent = useAgentEventHandler({
        dispatch,
        refs: {
            activeConversationIdRef,
            activeRunIdByConversationRef,
            lastSeqByConversationRef,
            resumeSeqByConversationRef,
            seenSourceEventKeysRef,
            terminalRunIdsRef,
            pendingRequestIdsRef,
        },
        streaming: {
            setPendingUserMessageId,
            beginStreamingRun,
            acceptStreamChunk,
            finalizeMessageBoundary,
            finalizeRunOnFinish,
        },
        reasoning,
        lifecycle: lifecycleCallbacks,
    });
    const ensureAgentStreamSubscription = useCallback(() => {
        if (!window.electronAPI?.agent.onStream || agentStreamCleanupRef.current) {
            return;
        }
        agentStreamCleanupRef.current = window.electronAPI.agent.onStream((event) => {
            handleAgentEvent(event);
        });
    }, [handleAgentEvent]);
    const applyResumeSnapshot = useApplyResumeSnapshot({
        dispatch,
        refs: {
            activeConversationIdRef,
        },
        streaming: {
            setPendingUserMessageId,
        },
    });
    useResumeAgentRun({
        activeConversationId,
        refs: {
            resumeSeqByConversationRef,
        },
        actions: {
            ensureAgentStreamSubscription,
            applyResumeSnapshot,
            handleAgentEvent,
            clearReplayedStreamingState: resetStreamingState,
        },
    });
    useEffect(() => {
        clearAssistantScrollFollow();
        discardStreamText();
        directHandoffControllerRef.current?.reset();
        for (const frameId of pendingPaintFrameIdsRef.current) {
            window.cancelAnimationFrame(frameId);
        }
        pendingPaintFrameIdsRef.current.clear();
        paintScheduledSlotIdsRef.current.clear();
        workingModeByRunIdRef.current.clear();
        receivedSlotIdsRef.current.clear();
        queuedStreamChunksBySlotIdRef.current.clear();
        queuedSlotsAwaitingFinishRef.current.clear();
        pendingCanonicalBySlotIdRef.current.clear();
        commitStreamingAssistants([]);
        nextSlotIndexByUserMessageIdRef.current.clear();
        seenSourceEventKeysRef.current.clear();
        const timeoutId = window.setTimeout(() => {
            setPendingUserMessageId(null);
        }, 0);
        return () => window.clearTimeout(timeoutId);
    }, [activeConversationId, commitStreamingAssistants, discardStreamText]);
    const startStream = useCallback((args) => {
        if (!activeConversationId || !window.electronAPI) {
            args.onStartFailed?.();
            return;
        }
        ensureAgentStreamSubscription();
        if (args.userMessageEventId && args.mode !== "follow_up") {
            setPendingUserMessageId(args.userMessageEventId);
        }
        const attemptId = ++startAttemptRef.current;
        const startChatAttachments = attachmentsForStartChat(args.attachments);
        // The composer's attached images/files already travel as
        // `attachments` — shipping them again inside chatContext doubles a
        // potentially huge base64 payload across the IPC bridge for fields
        // the runtime never reads (it only consumes windowScreenshot,
        // window/AX, selection, and pasted text from chatContext).
        const startChatContext = args.chatContext
            ? {
                ...args.chatContext,
                regionScreenshots: undefined,
                files: undefined,
            }
            : args.chatContext;
        void (async () => {
            if (attemptId !== startAttemptRef.current)
                return;
            const { requestId } = await window.electronAPI.agent.startChat({
                conversationId: activeConversationId,
                userPrompt: args.userPrompt,
                ...(typeof args.selectedText !== "undefined"
                    ? { selectedText: args.selectedText }
                    : {}),
                ...(typeof startChatContext !== "undefined"
                    ? { chatContext: startChatContext }
                    : {}),
                deviceId: args.deviceId,
                platform: args.platform,
                timezone: args.timezone,
                ...(args.locale ? { locale: args.locale } : {}),
                mode: args.mode,
                ...(args.messageMetadata
                    ? { messageMetadata: args.messageMetadata }
                    : {}),
                ...(startChatAttachments?.length
                    ? { attachments: startChatAttachments }
                    : {}),
                ...(args.userMessageEventId
                    ? { userMessageEventId: args.userMessageEventId }
                    : {}),
                ...(Number.isFinite(args.userMessageTimestamp)
                    ? { userMessageTimestamp: args.userMessageTimestamp }
                    : {}),
                storageMode,
            });
            pendingRequestIdsRef.current.add(requestId);
        })().catch((error) => {
            console.error("Failed to start local agent chat:", error.message);
            if (args.userMessageEventId) {
                setPendingUserMessageId((current) => current === args.userMessageEventId ? null : current);
            }
            const reason = error.message || null;
            // A queued / follow-up message whose start fails because the user hit
            // an anonymous cap or usage/auth limit must show the same actionable
            // "Sign in to keep using Stella" toast as the live send path — not the
            // generic "Stella is still starting up". `resolveAgentNotReadyToast`
            // only understands local startup hiccups, so route real backend
            // limit/auth reasons through the provider-error resolver (which
            // carries the Sign in / Upgrade / BYOK CTAs).
            if (isStellaLimitOrAuthReason(reason)) {
                showToast(resolveStellaProviderErrorToast(reason));
            }
            else {
                const toast = resolveAgentNotReadyToast(reason);
                showToast({
                    title: toast.title,
                    description: toast.description || reason || "Please try again.",
                    variant: "error",
                });
            }
            args.onStartFailed?.();
        });
    }, [activeConversationId, ensureAgentStreamSubscription, storageMode]);
    const queueStream = useCallback((args) => {
        startStream(args);
    }, [startStream]);
    const cancelCurrentStream = useCallback(() => {
        if (!activeRunId || !window.electronAPI?.agent.cancelChat) {
            return;
        }
        window.electronAPI.agent.cancelChat(activeRunId);
    }, [activeRunId]);
    // Ephemeral per-thread stream decoration (statusText ticks, tool
    // activity, reasoning) for the active conversation, keyed by agentId.
    // The authoritative task rows come from `useThreadActivity`; callers
    // overlay these via `buildActivityTasks`. Backed by the module-level
    // decoration store, which inline chat cards also subscribe to per-agent.
    const decorationsSnapshot = useSyncExternalStore(subscribeTaskDecorations, getTaskDecorationsSnapshot);
    const taskDecorations = useMemo(() => activeConversationId
        ? Object.fromEntries(Object.entries(decorationsSnapshot).filter(([, decoration]) => decoration.conversationId === activeConversationId))
        : {}, [activeConversationId, decorationsSnapshot]);
    return {
        taskDecorations,
        runtimeStatusText,
        markAssistantResponseTextStarted,
        activeToolCallId,
        activeToolName,
        latestCompletedTool,
        hasToolActivity,
        isToolActive,
        isStreamingResponseText,
        reasoningText,
        streamingAssistants,
        isStreaming,
        pendingUserMessageId,
        setPendingUserMessageId,
        startStream,
        queueStream,
        cancelCurrentStream,
        resetStreamingState,
    };
}
