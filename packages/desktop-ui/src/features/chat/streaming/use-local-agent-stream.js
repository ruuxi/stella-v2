import { useCallback, useEffect, useMemo, useReducer, useRef, useState, useSyncExternalStore, } from "react";
import { showToast } from "@/ui/toast";
import { useResumeAgentRun } from "../hooks/use-resume-agent-run";
import { attachmentsForStartChat, initialStoreState, streamStoreReducer, } from "./store";
import { useReasoningBatcher } from "./use-reasoning-batcher";
import { clearConversationTaskDecorations, getTaskDecorationsSnapshot, subscribeTaskDecorations, } from "./task-decoration-store";
import { useAgentEventHandler } from "./use-agent-event-handler";
import { useApplyResumeSnapshot } from "./use-resume-snapshot";
import { reconcileStreamingAssistantCanonicalMessage, streamingAssistantOverlayId, } from "./streaming-types";
import { notifyChatContentGrowth } from "@/shell/chat-scroll-follow";
import { resolveAgentNotReadyToast } from "./agent-stream-errors";
import { isStellaLimitOrAuthReason, resolveStellaProviderErrorToast, } from "./stella-provider-error-toast";
export function useLocalAgentStream({ activeConversationId, storageMode, onRunStarted, onRunFinished, }) {
    const [storeState, dispatch] = useReducer(streamStoreReducer, initialStoreState);
    const [pendingUserMessageId, setPendingUserMessageId] = useState(null);

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
    const resumeSourceSeqByConversationRef = useRef(new Map());
    const seenSourceEventKeysRef = useRef(new Set());
    const terminalRunIdsRef = useRef(new Set());
    const pendingRequestIdsRef = useRef(new Set());

    const nextSlotIndexByUserMessageIdRef = useRef(new Map());
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
    const reasoningText = "";

    const beginStreamingRun = useCallback((args) => {
        if (args.userMessageId) {
            nextSlotIndexByUserMessageIdRef.current.set(args.userMessageId, 1);
        }
    }, []);

    const finalizeMessageBoundary = useCallback((args) => {
        if (!args.userMessageId)
            return;
        const userMessageId = args.userMessageId;
        const indexInTurn = nextSlotIndexByUserMessageIdRef.current.get(userMessageId) ?? 1;
        nextSlotIndexByUserMessageIdRef.current.set(userMessageId, indexInTurn + 1);
        const slotId = streamingAssistantOverlayId(userMessageId, indexInTurn);
        const canonicalText = args.canonicalText ?? "";
        commitStreamingAssistants((current) => {
            if (current.some((slot) => slot._id === slotId)) {
                return reconcileStreamingAssistantCanonicalMessage(current, {
                    userMessageId,
                    indexInTurn,
                    ...(args.canonicalMessageId
                        ? { canonicalMessageId: args.canonicalMessageId }
                        : {}),
                    canonicalText,
                });
            }
            return [
                ...current,
                {
                    _id: slotId,
                    userMessageId,
                    indexInTurn,
                    text: canonicalText,
                    ...(args.responseTarget
                        ? { responseTarget: args.responseTarget }
                        : {}),
                    timestamp: Date.now(),
                    runId: args.runId,
                    ...(args.canonicalMessageId
                        ? { canonicalMessageId: args.canonicalMessageId }
                        : {}),
                    locked: true,
                },
            ];
        });

        notifyChatContentGrowth();
    }, [commitStreamingAssistants]);

    const finalizeRunOnFinish = useCallback(() => { }, []);
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
    }, []);
    const resetStreamingState = useCallback(() => {
        setPendingUserMessageId(null);
        commitStreamingAssistants([]);
        nextSlotIndexByUserMessageIdRef.current.clear();

        const conversationId = activeConversationIdRef.current;
        if (conversationId) {
            clearConversationTaskDecorations(conversationId);
            dispatch({
                type: "clear-conversation-run",
                conversationId,
            });
        }
    }, [commitStreamingAssistants]);
    const handleAgentEvent = useAgentEventHandler({
        dispatch,
        refs: {
            activeConversationIdRef,
            activeRunIdByConversationRef,
            lastSeqByConversationRef,
            resumeSeqByConversationRef,
            resumeSourceSeqByConversationRef,
            seenSourceEventKeysRef,
            terminalRunIdsRef,
            pendingRequestIdsRef,
        },
        streaming: {
            setPendingUserMessageId,
            beginStreamingRun,
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
            resumeSourceSeqByConversationRef,
        },
        actions: {
            ensureAgentStreamSubscription,
            applyResumeSnapshot,
            handleAgentEvent,
            clearReplayedStreamingState: resetStreamingState,
        },
    });
    useEffect(() => {
        commitStreamingAssistants([]);
        nextSlotIndexByUserMessageIdRef.current.clear();
        seenSourceEventKeysRef.current.clear();
        const timeoutId = window.setTimeout(() => {
            setPendingUserMessageId(null);
        }, 0);
        return () => window.clearTimeout(timeoutId);
    }, [activeConversationId, commitStreamingAssistants]);
    const startStream = useCallback(async (args) => {
        if (!activeConversationId || !window.electronAPI) {
            args.onStartFailed?.();
            return false;
        }
        ensureAgentStreamSubscription();
        if (args.userMessageEventId && args.mode !== "follow_up") {
            setPendingUserMessageId(args.userMessageEventId);
        }
        const attemptId = ++startAttemptRef.current;
        const startChatAttachments = attachmentsForStartChat(args.attachments);

        const startChatContext = args.chatContext
            ? {
                ...args.chatContext,
                regionScreenshots: undefined,
                files: undefined,
            }
            : args.chatContext;
        try {
            await Promise.resolve();
            if (attemptId !== startAttemptRef.current) {
                return false;
            }
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
            return true;
        }
        catch (error) {
            console.error("Failed to start local agent chat:", error.message);
            if (args.userMessageEventId) {
                setPendingUserMessageId((current) => current === args.userMessageEventId ? null : current);
            }
            const reason = error.message || null;

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
            return false;
        }
    }, [activeConversationId, ensureAgentStreamSubscription, storageMode]);
    const queueStream = useCallback((args) => {
        void startStream(args);
    }, [startStream]);
    const cancelCurrentStream = useCallback(() => {
        if (!activeRunId || !window.electronAPI?.agent.cancelChat) {
            return;
        }
        window.electronAPI.agent.cancelChat(activeRunId);
    }, [activeRunId]);

    const decorationsSnapshot = useSyncExternalStore(subscribeTaskDecorations, getTaskDecorationsSnapshot);
    const taskDecorations = useMemo(() => activeConversationId
        ? Object.fromEntries(Object.entries(decorationsSnapshot).filter(([, decoration]) => decoration.conversationId === activeConversationId))
        : {}, [activeConversationId, decorationsSnapshot]);
    return {
        taskDecorations,
        runtimeStatusText,
        activeToolCallId,
        activeToolName,
        latestCompletedTool,
        hasToolActivity,
        isToolActive,
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
