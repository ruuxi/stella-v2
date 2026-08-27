import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { deriveComposerState, } from "@/features/chat/composer-context";
import { conversationTabs } from "@/features/chat/services/conversation-tabs-store";
import { useConversationActivity } from "@/features/chat/hooks/use-conversation-activity";
import { useConversationDisplayMessages } from "@/features/chat/hooks/use-conversation-display-messages";
import { useConversationFiles } from "@/features/chat/hooks/use-conversation-files";
import { useConversationMessages } from "@/features/chat/hooks/use-conversation-messages";
import { useComposerMessageState } from "@/features/chat/hooks/use-composer-message-state";
import { useStreamingChat } from "@/features/chat/hooks/use-streaming-chat";
import { useThreadActivity } from "@/features/chat/hooks/use-thread-activity";
import { useTraceEventMonitor, useTraceIpcListener, } from "@/platform/diagnostics/use-trace-listener";
import { buildActivityTasks, } from "@/features/chat/lib/event-transforms";
import { useCapturedChatContext } from "./use-captured-chat-context";
import { useChatScrollManagement } from "./use-chat-scroll-management";
import { useChatHomeSurface } from "./use-chat-home-surface";
import { useAgentInputRouting } from "./use-agent-input-routing";
import { useConversationModelSelection } from "./use-conversation-model-selection";
import { useStellaSendMessageBridge } from "./use-stella-send-message-bridge";
import { forkLocalConversation, truncateLocalConversation, } from "@/features/chat/services/local-chat-store";
import { composerDraftFromUserRow } from "@/app/chat/message-composer-restore";
import { coerceAssistantWorkingMode, DEFAULT_ASSISTANT_WORKING_MODE, } from "@stella/contracts/local-preferences";
const MAX_RETAINED_TAB_STATE = 20;

const OPEN_BOTTOM_SETTLE_MS = 600;
const setBoundedTabMemory = (memory, conversationId, value) => {
    memory.delete(conversationId);
    memory.set(conversationId, value);
    while (memory.size > MAX_RETAINED_TAB_STATE) {
        const oldestConversationId = memory.keys().next().value;
        if (typeof oldestConversationId !== "string")
            break;
        memory.delete(oldestConversationId);
    }
};
export function useFullShellChat({ activeConversationId, isOnChatRoute, traceEnabled, navigateToConversation, }) {

    const { message, setMessage, messageRef: latestMessageRef, } = useComposerMessageState();
    const [composerFocusRequestId, setComposerFocusRequestId] = useState(0);
    const { chatContext, setChatContext, selectedText, setSelectedText } = useCapturedChatContext();
    const composerMemoryByConversationRef = useRef(new Map());
    const scrollMemoryByConversationRef = useRef(new Map());
    const activeConversationIdRef = useRef(activeConversationId);
    activeConversationIdRef.current = activeConversationId;
    const previousComposerConversationIdRef = useRef(activeConversationId);
    const restoredConversationScrollRef = useRef(null);
    useEffect(() => {
        const previousConversationId = previousComposerConversationIdRef.current;
        if (previousConversationId === activeConversationId)
            return;
        if (previousConversationId) {
            const remainsOpen = conversationTabs
                .getSnapshot()
                .tabs.some((tab) => tab.conversationId === previousConversationId);
            if (remainsOpen) {
                setBoundedTabMemory(composerMemoryByConversationRef.current, previousConversationId, {
                    message: latestMessageRef.current,
                    chatContext,
                    selectedText,
                });
            }
        }
        if (activeConversationId) {
            const remembered = composerMemoryByConversationRef.current.get(activeConversationId);
            setMessage(remembered?.message ?? "");
            setChatContext(remembered?.chatContext ?? null);
            setSelectedText(remembered?.selectedText ?? null);
        }
        previousComposerConversationIdRef.current = activeConversationId;
    }, [
        activeConversationId,
        chatContext,
        latestMessageRef,
        selectedText,
        setChatContext,
        setMessage,
        setSelectedText,
    ]);
    useEffect(() => conversationTabs.subscribe(() => {
        const openIds = new Set(conversationTabs.getSnapshot().tabs.map((tab) => tab.conversationId));
        for (const conversationId of composerMemoryByConversationRef.current.keys()) {
            if (!openIds.has(conversationId)) {
                composerMemoryByConversationRef.current.delete(conversationId);
                scrollMemoryByConversationRef.current.delete(conversationId);
            }
        }
    }), []);
    const { messages: persistedMessages, hasOlderMessages, hasNewerMessages, isLoadingOlder: isLoadingOlderMessages, isLoadingNewer: isLoadingNewerMessages, isInitialLoading: isInitialLoadingMessages, loadOlder: loadOlderMessages, loadNewer: loadNewerMessages, loadLatest: loadLatestMessages, } = useConversationMessages(activeConversationId ?? undefined);
    const { activities, hasOlderActivity, isLoadingOlder: isLoadingOlderActivity, loadOlder: loadOlderActivity, } = useConversationActivity(activeConversationId ?? undefined);
    const { files: persistedFiles, hasOlderFiles, isLoadingOlder: isLoadingOlderFiles, loadOlder: loadOlderFiles, } = useConversationFiles(activeConversationId ?? undefined);
    const { records: threadActivityRecords } = useThreadActivity(activeConversationId ?? undefined);
    const { taskDecorations, optimisticEvents, runtimeStatusText, activeToolCallId, activeToolName, latestCompletedTool, hasToolActivity, isToolActive, reasoningText, streamingAssistants, isStreaming, pendingUserMessageId, queuedUserMessages, removeQueuedUserMessage, sendMessage, cancelCurrentStream, } = useStreamingChat({
        conversationId: activeConversationId,
        persistedMessages,
    });

    const displayMessages = useConversationDisplayMessages({
        conversationId: activeConversationId,
        persistedMessages,
        optimisticEvents,
        streamingAssistants,
    });
    useTraceIpcListener(traceEnabled);

    const traceEvents = useMemo(() => {
        if (!traceEnabled)
            return [];
        const out = [];
        for (const event of activities)
            out.push(event);
        for (const message of persistedMessages) {
            out.push(message);
            for (const toolEvent of message.toolEvents)
                out.push(toolEvent);
        }
        return out;
    }, [activities, traceEnabled, persistedMessages]);
    useTraceEventMonitor(traceEnabled, traceEvents);
    const hasMessages = displayMessages.length > 0;
    const { showHomeContent, enterChatSurfaceForInteraction, resetIdleTimer, dismissHome, showHome, } = useChatHomeSurface({
        isOnChatRoute,
        hasMessages,
        isInitialLoading: isInitialLoadingMessages,
        isStreaming,
        activeConversationId,
    });

    useEffect(() => {
        if (!isOnChatRoute)
            return;
        setComposerFocusRequestId((id) => id + 1);
    }, [isOnChatRoute, activeConversationId]);
    const { sendContextlessMessage, sendAgentInputMessage, sendMessageWithContext, } = useAgentInputRouting({
        activeConversationId,
        sendMessage,
        enterChatSurfaceForInteraction,
    });
    useStellaSendMessageBridge({
        sendContextlessMessage,
        sendAgentInputMessage,
    });

    const { listRef, isAtBottom, isNearBottom, isFollowingLatest, isUserScrolling, noteManualScroll, getIsFollowing, getShouldPlaceLatestTurn, getIsEffectivelyAtBottom, showScrollButton, scrollToBottom, releaseFollow, nudgeAfterSend, nudgeQueuedMessagesIntoView, thumbRef, } = useChatScrollManagement({
        hasOlderEvents: hasOlderMessages,
        isLoadingOlder: isLoadingOlderMessages,
        onLoadOlder: loadOlderMessages,
        hasNewerEvents: hasNewerMessages,
        isLoadingNewer: isLoadingNewerMessages,
        onLoadNewer: loadNewerMessages,
        onLoadLatest: loadLatestMessages,
        paginationKey: activeConversationId,
    });
    useLayoutEffect(() => {
        const conversationId = activeConversationId;
        const list = listRef.current;
        const scrollMemory = scrollMemoryByConversationRef.current;
        return () => {
            if (!conversationId)
                return;
            const remainsOpen = conversationTabs
                .getSnapshot()
                .tabs.some((tab) => tab.conversationId === conversationId);
            if (!remainsOpen)
                return;
            const element = list?.getScrollableNode();
            if (!element)
                return;
            setBoundedTabMemory(scrollMemory, conversationId, {
                scrollTop: element.scrollTop,
                followingLatest: getIsFollowing(),
            });
        };
    }, [activeConversationId, getIsFollowing, listRef]);
    useEffect(() => {
        if (!activeConversationId ||
            isInitialLoadingMessages ||
            displayMessages.length === 0 ||
            restoredConversationScrollRef.current === activeConversationId) {
            return;
        }
        const conversationId = activeConversationId;
        let settleRaf = null;
        const frame = window.requestAnimationFrame(() => {
            const remembered = scrollMemoryByConversationRef.current.get(conversationId);
            const element = listRef.current?.getScrollableNode();
            if (remembered && !remembered.followingLatest && element) {
                const maximumScrollTop = Math.max(0, element.scrollHeight - element.clientHeight);
                element.scrollTo({
                    top: Math.min(remembered.scrollTop, maximumScrollTop),
                    behavior: "instant",
                });
            }
            else {
                scrollToBottom("instant");

                let lastHeight = element ? element.scrollHeight : 0;
                const deadline = performance.now() + OPEN_BOTTOM_SETTLE_MS;
                const settle = () => {
                    settleRaf = null;
                    const node = listRef.current?.getScrollableNode();

                    if (!node || !getIsFollowing())
                        return;
                    if (node.scrollHeight !== lastHeight) {
                        lastHeight = node.scrollHeight;
                        void listRef.current?.scrollToEnd({ animated: false });
                    }
                    if (performance.now() < deadline) {
                        settleRaf = window.requestAnimationFrame(settle);
                    }
                };
                settleRaf = window.requestAnimationFrame(settle);
            }
            restoredConversationScrollRef.current = conversationId;
        });
        return () => {
            window.cancelAnimationFrame(frame);
            if (settleRaf !== null)
                window.cancelAnimationFrame(settleRaf);
        };
    }, [
        activeConversationId,
        displayMessages.length,
        getIsFollowing,
        isInitialLoadingMessages,
        listRef,
        scrollToBottom,
    ]);
    const handleSend = useCallback(async () => {

        const shouldKeepTailFramed =
            showHomeContent || getIsEffectivelyAtBottom() || getShouldPlaceLatestTurn();
        const shouldNudgeAfterSend = !isStreaming && shouldKeepTailFramed;
        const submittedConversationId = activeConversationId;
        const accepted = await sendMessage({
            text: latestMessageRef.current,
            selectedText,
            chatContext,
            onClear: () => {
                if (activeConversationIdRef.current !== submittedConversationId) {
                    if (submittedConversationId) {
                        setBoundedTabMemory(composerMemoryByConversationRef.current, submittedConversationId, {
                            message: "",
                            selectedText: null,
                            chatContext: null,
                        });
                    }
                    return;
                }
                setMessage("");
                setSelectedText(null);
                setChatContext(null);
            },
        });
        if (!accepted || activeConversationIdRef.current !== submittedConversationId) {
            return;
        }
        if (showHomeContent) {
            setComposerFocusRequestId((id) => id + 1);
        }
        enterChatSurfaceForInteraction();
        resetIdleTimer();
        if (isStreaming) {

            if (shouldKeepTailFramed) {
                nudgeQueuedMessagesIntoView();
            }
        }
        else if (shouldNudgeAfterSend) {

            nudgeAfterSend();
        }
        else {
            releaseFollow();
        }
    }, [
        activeConversationId,
        chatContext,
        enterChatSurfaceForInteraction,
        getIsFollowing,
        getShouldPlaceLatestTurn,
        getIsEffectivelyAtBottom,
        isStreaming,
        latestMessageRef,
        nudgeAfterSend,
        nudgeQueuedMessagesIntoView,
        releaseFollow,
        resetIdleTimer,
        selectedText,
        sendMessage,
        setChatContext,
        setMessage,
        setSelectedText,
        showHomeContent,
    ]);
    const { canSubmit } = deriveComposerState({
        message,
        chatContext,
        selectedText,
        conversationId: activeConversationId,
        requireConversationId: true,
    });

    const [assistantWorkingMode, setAssistantWorkingMode] = useState(DEFAULT_ASSISTANT_WORKING_MODE);
    useEffect(() => {
        let disposed = false;
        const loadWorkingMode = async () => {
            try {
                const preferences = await window.electronAPI?.system?.getLocalModelPreferences?.();
                if (!disposed) {
                    setAssistantWorkingMode(coerceAssistantWorkingMode(preferences?.assistantWorkingMode));
                }
            }
            catch {

            }
        };
        const handlePreferencesChanged = () => { void loadWorkingMode(); };
        void loadWorkingMode();
        window.addEventListener("stella:local-model-preferences-changed", handlePreferencesChanged);
        return () => {
            disposed = true;
            window.removeEventListener("stella:local-model-preferences-changed", handlePreferencesChanged);
        };
    }, []);
    const isOrchestratedMode = assistantWorkingMode === "orchestrated";

    useConversationModelSelection({
        activeConversationId,
        enabled: true,
    });

    const messageActionsStateRef = useRef(null);
    messageActionsStateRef.current = {
        activeConversationId,
        isStreaming,
        setMessage,
        setChatContext,
        setSelectedText,
        navigateToConversation,
        requestFocus: () => setComposerFocusRequestId((id) => id + 1),
    };

    const rewindToUserMessage = useCallback((row) => {
        const state = messageActionsStateRef.current;
        if (!state)
            return;
        if (state.isStreaming)
            return;
        const conversationId = state.activeConversationId;
        if (!conversationId || !row?.id)
            return;
        const draft = composerDraftFromUserRow(row);
        void (async () => {
            try {
                await truncateLocalConversation(conversationId, row.id);
            }
            catch (error) {
                console.warn("[fork-rewind] rewind truncate failed", error);
                return;
            }
            state.setMessage(draft.message);
            state.setChatContext(draft.chatContext);
            state.setSelectedText(null);
            state.requestFocus();
        })();
    }, []);

    const forkToNewConversation = useCallback((row) => {
        const state = messageActionsStateRef.current;
        if (!state)
            return;
        if (state.isStreaming)
            return;
        const conversationId = state.activeConversationId;
        if (!conversationId || !row?.id)
            return;

        if (!state.navigateToConversation)
            return;
        const draft = composerDraftFromUserRow(row);
        void (async () => {
            let newConversationId = null;
            try {
                newConversationId = await forkLocalConversation(conversationId, row.id);
            }
            catch (error) {
                console.warn("[fork-rewind] fork failed", error);
                return;
            }
            if (!newConversationId)
                return;

            state.navigateToConversation?.(newConversationId);
            setBoundedTabMemory(composerMemoryByConversationRef.current, newConversationId, {
                message: draft.message,
                chatContext: draft.chatContext,
                selectedText: null,
            });
        })();
    }, []);

    const messageActions = useMemo(() => (isOrchestratedMode
        ? { rewind: rewindToUserMessage }
        : { rewind: rewindToUserMessage, fork: forkToNewConversation }), [isOrchestratedMode, rewindToUserMessage, forkToNewConversation]);

    const tasks = useMemo(() => buildActivityTasks(threadActivityRecords, taskDecorations), [threadActivityRecords, taskDecorations]);
    const chatColumnConversation = useMemo(() => ({
        conversationId: activeConversationId,
        tasks,
        activity: {
            activities,
            hasOlder: hasOlderActivity,
            isLoadingOlder: isLoadingOlderActivity,
            loadOlder: loadOlderActivity,
        },
        files: {
            files: persistedFiles,
            hasOlder: hasOlderFiles,
            isLoadingOlder: isLoadingOlderFiles,
            loadOlder: loadOlderFiles,
        },
        streaming: {
            reasoningText,
            isStreaming,
            runtimeStatusText,
            activeToolCallId,
            activeToolName,
            latestCompletedTool,
            hasToolActivity,
            isToolActive,
            pendingUserMessageId,
            queuedUserMessages,
            removeQueuedUserMessage,
        },
        history: {
            hasOlderMessages,
            hasNewerMessages,
            isLoadingOlder: isLoadingOlderMessages,
            isLoadingNewer: isLoadingNewerMessages,
            isInitialLoading: isInitialLoadingMessages,
        },
    }), [
        activeConversationId,
        activities,
        activeToolCallId,
        activeToolName,
        latestCompletedTool,
        hasToolActivity,
        hasOlderActivity,
        hasOlderFiles,
        hasOlderMessages,
        hasNewerMessages,
        isInitialLoadingMessages,
        isLoadingOlderActivity,
        isLoadingOlderFiles,
        isLoadingOlderMessages,
        isLoadingNewerMessages,
        tasks,
        loadOlderActivity,
        loadOlderFiles,
        pendingUserMessageId,
        persistedFiles,
        queuedUserMessages,
        removeQueuedUserMessage,
        reasoningText,
        runtimeStatusText,
        isStreaming,
        isToolActive,
    ]);
    const chatColumnComposer = useMemo(() => ({
        message,
        setMessage,
        chatContext,
        setChatContext,
        selectedText,
        setSelectedText,
        canSubmit,
        focusRequestId: composerFocusRequestId,
        requestFocus: () => setComposerFocusRequestId((id) => id + 1),
        onSend: handleSend,
        onStop: cancelCurrentStream,
    }), [
        message,
        setMessage,
        chatContext,
        setChatContext,
        selectedText,
        setSelectedText,
        canSubmit,
        composerFocusRequestId,
        handleSend,
        cancelCurrentStream,
    ]);
    const chatColumnScroll = useMemo(() => ({
        listRef,
        showScrollButton,
        isAtBottom,
        isNearBottom,
        isFollowingLatest,
        isUserScrolling,
        noteManualScroll,
        getIsFollowing,
        scrollToBottom,
        thumbRef,
    }), [
        listRef,
        showScrollButton,
        isAtBottom,
        isNearBottom,
        isFollowingLatest,
        isUserScrolling,
        noteManualScroll,
        getIsFollowing,
        scrollToBottom,
        thumbRef,
    ]);

    const conversation = useMemo(() => ({
        ...chatColumnConversation,
        hasOlderMessages,
        hasNewerMessages,
        isLoadingOlder: isLoadingOlderMessages,
        isLoadingNewer: isLoadingNewerMessages,
        isInitialLoading: isInitialLoadingMessages,
        loadOlderMessages,
        loadNewerMessages,
        loadLatestMessages,
        reasoningText,
        isStreaming,
        pendingUserMessageId,
        queuedUserMessages,
        sendMessage,
        sendContextlessMessage,
        sendMessageWithContext,
        cancelCurrentStream,
    }), [
        chatColumnConversation,
        hasOlderMessages,
        hasNewerMessages,
        isLoadingOlderMessages,
        isLoadingNewerMessages,
        isInitialLoadingMessages,
        loadOlderMessages,
        loadNewerMessages,
        loadLatestMessages,
        reasoningText,
        isStreaming,
        pendingUserMessageId,
        queuedUserMessages,
        sendMessage,
        sendContextlessMessage,
        sendMessageWithContext,
        cancelCurrentStream,
    ]);
    const composer = useMemo(() => ({
        ...chatColumnComposer,
        handleSend,
        handleStop: cancelCurrentStream,
    }), [chatColumnComposer, handleSend, cancelCurrentStream]);
    const runtime = useMemo(() => ({
        conversation,
        composer,
        scroll: chatColumnScroll,
        messageActions,
        showHomeContent,
        dismissHome,
        showHome,
    }), [
        conversation,
        composer,
        chatColumnScroll,
        messageActions,
        showHomeContent,
        dismissHome,
        showHome,
    ]);
    return { runtime, messages: displayMessages };
}
