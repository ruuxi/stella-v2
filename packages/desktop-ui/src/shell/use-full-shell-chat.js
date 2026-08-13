import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { attachComposerAppSelectionContext, deriveComposerState, } from "@/features/chat/composer-context";
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
/**
 * How long, after opening/switching into a conversation that lands at the
 * bottom, to keep re-pinning to the true end while late-rendering content
 * (agent cards, activity cards, images) settles and grows the scroll height.
 */
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
    // Message state + always-current mirror ref, synced at WRITE time. The
    // dictate-and-submit commit is rAF-deferred and can fire before React
    // flushes the render that carries the appended transcript — a ref synced in
    // the render body would still hold the pre-transcript text at that point,
    // so the send would go out empty (and silently no-op), leaving the
    // transcript sitting in the composer unsent. See use-composer-message-state.
    const { message, setMessage, messageRef: latestMessageRef, } = useComposerMessageState();
    const [composerFocusRequestId, setComposerFocusRequestId] = useState(0);
    const annotationIdRef = useRef(0);
    const annotationTargetRef = useRef(null);
    const [annotationTarget, setAnnotationTarget] = useState(null);
    const { chatContext, setChatContext, selectedText, setSelectedText } = useCapturedChatContext();
    const composerMemoryByConversationRef = useRef(new Map());
    const scrollMemoryByConversationRef = useRef(new Map());
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
    const { messages: persistedMessages, hasOlderMessages, isLoadingOlder: isLoadingOlderMessages, isInitialLoading: isInitialLoadingMessages, loadOlder: loadOlderMessages, } = useConversationMessages(activeConversationId ?? undefined);
    const { activities, hasOlderActivity, isLoadingOlder: isLoadingOlderActivity, loadOlder: loadOlderActivity, } = useConversationActivity(activeConversationId ?? undefined);
    const { files: persistedFiles, hasOlderFiles, isLoadingOlder: isLoadingOlderFiles, loadOlder: loadOlderFiles, } = useConversationFiles(activeConversationId ?? undefined);
    const { records: threadActivityRecords } = useThreadActivity(activeConversationId ?? undefined);
    const { taskDecorations, optimisticEvents, runtimeStatusText, activeToolCallId, activeToolName, latestCompletedTool, hasToolActivity, isToolActive, reasoningText, streamingAssistants, isStreaming, isStreamingResponseText, pendingUserMessageId, queuedUserMessages, removeQueuedUserMessage, sendMessage, cancelCurrentStream, } = useStreamingChat({
        conversationId: activeConversationId,
        persistedMessages,
    });
    // Visible chat timeline: SQLite-backed `persistedMessages` plus the
    // synthetic overlays (optimistic users, in-memory streaming
    // assistants, scheduler-pending) that drop off as their persisted
    // counterparts land. Lives in its own hook so the overlay-
    // composition concerns stay next to each other.
    const displayMessages = useConversationDisplayMessages({
        conversationId: activeConversationId,
        persistedMessages,
        optimisticEvents,
        streamingAssistants,
    });
    useTraceIpcListener(traceEnabled);
    // Opt-in event trace consumes the union of activity + message + the
    // per-turn tool events. The hook's internal `seenIds` set keeps it
    // idempotent across re-runs, so we can rebuild the list cheaply on
    // every tick without double-firing trace entries. Gated on `traceEnabled`
    // (explicit opt-in) rather than `import.meta.env.DEV`, which is TRUE in
    // Stella's dev-server-as-production build, so the array stays empty for
    // real users.
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
    // Focus the composer on mount and whenever the user navigates onto the
    // chat route (covers both home content and the full chat surface), so
    // the user can start typing without clicking first.
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
    const startAnnotation = useCallback((options) => {
        const nextTarget = {
            id: ++annotationIdRef.current,
            submit: options.submit,
        };
        annotationTargetRef.current = nextTarget;
        setAnnotationTarget(nextTarget);
    }, []);
    const cancelAnnotation = useCallback(() => {
        annotationTargetRef.current = null;
        setAnnotationTarget(null);
    }, []);
    const submitAnnotation = useCallback((selection, requestId) => {
        const activeTarget = annotationTargetRef.current;
        const target = activeTarget && (requestId == null || activeTarget.id === requestId)
            ? activeTarget
            : null;
        if (!target)
            return;
        try {
            target.submit(selection);
        }
        finally {
            annotationTargetRef.current = null;
            setAnnotationTarget(null);
        }
    }, []);
    /**
     * Scroll: backed by Legend List (web entry). The list owns scrolling
     * and content geometry; the hook adapts list state into the surface
     * UI concerns (at-bottom, custom thumb, scroll-to-bottom button).
     */
    const { listRef, isAtBottom, isNearBottom, isFollowingLatest, isUserScrolling, noteManualScroll, getIsFollowing, getShouldPlaceLatestTurn, getIsEffectivelyAtBottom, showScrollButton, scrollToBottom, releaseFollow, nudgeAfterSend, nudgeQueuedMessagesIntoView, thumbRef, } = useChatScrollManagement({
        hasOlderEvents: hasOlderMessages,
        isLoadingOlder: isLoadingOlderMessages,
        onLoadOlder: loadOlderMessages,
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
                // Agent cards, activity cards, and images near the bottom can
                // mount/settle a beat AFTER this initial pin, growing the scroll
                // height so the "bottom" we just landed on is now above the real
                // one — tab switches that land slightly above the true bottom.
                // Keep re-pinning to the end through that post-open settling
                // (until the height stops changing, a short window elapses, or
                // the user takes over) so we always end at the actual bottom.
                let lastHeight = element ? element.scrollHeight : 0;
                const deadline = performance.now() + OPEN_BOTTOM_SETTLE_MS;
                const settle = () => {
                    settleRaf = null;
                    const node = listRef.current?.getScrollableNode();
                    // Bail once the user has scrolled away — never yank them back.
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
    const handleSend = useCallback(() => {
        // The placement gate subtracts the synthetic response spacer before
        // applying Codex's 300px near-bottom threshold. That keeps a visually
        // bottomed short reply eligible without pulling deliberate scrollback
        // forward.
        //
        // While a stream is already in flight, the send queues as a
        // follow-up chip at the keyed tail of the event list (not yet a sent
        // user row). The normal latest-user-row nudge is still skipped:
        // it would fall through to the prior turn's user bubble and scroll
        // *backwards* to re-frame it. The streaming branch below uses a
        // footer-tail target instead.
        const shouldKeepTailFramed = showHomeContent || getShouldPlaceLatestTurn();
        // Treat a near-bottom send (the freshest turn still on screen) as an
        // at-bottom send: pin to the newest content with a plain scroll-to-
        // bottom instead of reframing the just-sent message near the top. Only
        // a genuinely scrolled-up send gets the message-to-top+autoscroll
        // reframe. `getIsEffectivelyAtBottom` is distance-based, so a stray
        // upward nudge (which drops the motion follow latch) no longer counts
        // as "scrolled up" here. Home's first send keeps the reframe so the
        // opening reply lands in the Codex reading position.
        const effectivelyAtBottom = !showHomeContent && getIsEffectivelyAtBottom();
        const shouldNudgeAfterSend = !isStreaming && shouldKeepTailFramed && !effectivelyAtBottom;
        if (showHomeContent) {
            setComposerFocusRequestId((id) => id + 1);
        }
        enterChatSurfaceForInteraction();
        resetIdleTimer();
        void sendMessage({
            text: latestMessageRef.current,
            selectedText,
            chatContext,
            onClear: () => {
                setMessage("");
                setSelectedText(null);
                setChatContext(null);
            },
        });
        if (isStreaming) {
            // Queued follow-up — no new user row lands in the event list.
            // The streaming assistant row's own auto-follow keeps the reply
            // framed, but repeated queued chips live below that row in the
            // virtualized tail and can drift under the viewport without their own
            // target.
            if (shouldKeepTailFramed) {
                nudgeQueuedMessagesIntoView();
            }
        }
        else if (shouldNudgeAfterSend) {
            // Genuinely scrolled up: place the newest user turn near the top of
            // the readable area, above the viewport-derived response spacer. The
            // existing gentle loop keeps that reframe continuous with
            // stream-follow.
            nudgeAfterSend();
        }
        else if (effectivelyAtBottom) {
            // Near-bottom send: a normal scroll-to-bottom that re-arms follow so
            // the incoming reply is tracked as it streams.
            scrollToBottom("smooth");
        }
        else {
            releaseFollow();
        }
    }, [
        chatContext,
        enterChatSurfaceForInteraction,
        getIsFollowing,
        getShouldPlaceLatestTurn,
        getIsEffectivelyAtBottom,
        scrollToBottom,
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
    const attachFullChatAnnotation = useCallback((selection) => {
        enterChatSurfaceForInteraction();
        resetIdleTimer();
        attachComposerAppSelectionContext(selection, setChatContext);
        setComposerFocusRequestId((id) => id + 1);
    }, [enterChatSurfaceForInteraction, resetIdleTimer, setChatContext]);
    const { canSubmit } = deriveComposerState({
        message,
        chatContext,
        selectedText,
        conversationId: activeConversationId,
        requireConversationId: true,
    });
    // Assistant working mode gates the Fork action: forking spawns a new
    // conversation/tab, which only exists in the multi-tab (orchestrator-off)
    // experience. In orchestrated mode there are no tabs, so Fork is omitted
    // entirely (Rewind still shows). Mirrors the top bar's mode read.
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
                // Keep the product default when preferences are unavailable.
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
    // Per-tab (per-conversation) model selection: mirror the global model
    // preferences to whichever tab is active so each tab remembers its own
    // engine/model/reasoning pick. Inert in orchestrated single-chat mode.
    useConversationModelSelection({
        activeConversationId,
        enabled: !isOrchestratedMode,
    });
    // Per-user-message quick actions (Fork / Rewind) exposed to the deeply
    // nested action row. The callbacks are stable and read live state
    // through this ref, so every user row can consume them without
    // re-rendering as conversation state churns.
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
    // Rewind: destructively truncate THIS conversation at the target user
    // message (removing it and everything after), then load its text +
    // attachments back into the same chat's composer. The action row is
    // disabled while a turn is busy, so this never fires mid-stream; the
    // guard below is belt-and-suspenders and never interrupts in-flight work.
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
    // Fork: non-destructively branch the history BEFORE the target user
    // message into a brand-new conversation, drop the message into the new
    // chat's composer, and navigate there. The original chat is untouched.
    const forkToNewConversation = useCallback((row) => {
        const state = messageActionsStateRef.current;
        if (!state)
            return;
        if (state.isStreaming)
            return;
        const conversationId = state.activeConversationId;
        if (!conversationId || !row?.id)
            return;
        // Never mint a branch we can't navigate to — that would strand the
        // user on the original chat with an orphan conversation in the store.
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
            // Open + navigate first so the destination tab exists, THEN seed
            // its composer memory. The composer-restore effect reads this
            // seed when `activeConversationId` flips to the fork on the next
            // render, dropping the message + attachments into the new chat.
            state.navigateToConversation?.(newConversationId);
            setBoundedTabMemory(composerMemoryByConversationRef.current, newConversationId, {
                message: draft.message,
                chatContext: draft.chatContext,
                selectedText: null,
            });
        })();
    }, []);
    // Fork is dropped entirely in orchestrated mode (no tabs to branch
    // into); Rewind is always present, subject only to the busy disable.
    const messageActions = useMemo(() => (isOrchestratedMode
        ? { rewind: rewindToUserMessage }
        : { rewind: rewindToUserMessage, fork: forkToNewConversation }), [isOrchestratedMode, rewindToUserMessage, forkToNewConversation]);
    // The single task list every activity surface renders: authoritative
    // thread rows overlaid with live stream decoration. No event folding.
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
            isStreamingResponseText,
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
            isLoadingOlder: isLoadingOlderMessages,
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
        isInitialLoadingMessages,
        isLoadingOlderActivity,
        isLoadingOlderFiles,
        isLoadingOlderMessages,
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
        isStreamingResponseText,
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
        onSelectArea: () => startAnnotation({ submit: attachFullChatAnnotation }),
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
        startAnnotation,
        attachFullChatAnnotation,
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
    // The visible message timeline (`displayMessages`) is the only field
    // that changes whenever a provider chunk arrives while a reply streams. It is
    // returned separately and published through `ChatMessagesContext` rather
    // than folded into `runtime`, so the `runtime` value below keeps a stable
    // identity across streamed chunks. That stops every `useChatRuntime()`
    // consumer (shell chrome, left sidebar, mobile bridge) from re-rendering
    // per chunk — only the timeline renderers subscribe to the message channel.
    const conversation = useMemo(() => ({
        ...chatColumnConversation,
        hasOlderMessages,
        isLoadingOlder: isLoadingOlderMessages,
        isInitialLoading: isInitialLoadingMessages,
        loadOlderMessages,
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
        isLoadingOlderMessages,
        isInitialLoadingMessages,
        loadOlderMessages,
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
    const annotation = useMemo(() => ({
        active: Boolean(annotationTarget),
        requestId: annotationTarget?.id ?? null,
        start: startAnnotation,
        cancel: cancelAnnotation,
        submit: submitAnnotation,
    }), [annotationTarget, startAnnotation, cancelAnnotation, submitAnnotation]);
    const runtime = useMemo(() => ({
        conversation,
        composer,
        scroll: chatColumnScroll,
        annotation,
        messageActions,
        showHomeContent,
        dismissHome,
        showHome,
    }), [
        conversation,
        composer,
        chatColumnScroll,
        annotation,
        messageActions,
        showHomeContent,
        dismissHome,
        showHome,
    ]);
    return { runtime, messages: displayMessages };
}
