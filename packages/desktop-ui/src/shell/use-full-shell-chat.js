import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useAction } from "convex/react";
import { deriveComposerState } from "@/features/chat/composer-context";
import { conversationTabs } from "@/features/chat/services/conversation-tabs-store";
import { useConversationActivity } from "@/features/chat/hooks/use-conversation-activity";
import { useConversationDisplayMessages } from "@/features/chat/hooks/use-conversation-display-messages";
import { useConversationFiles } from "@/features/chat/hooks/use-conversation-files";
import { useConversationMessages } from "@/features/chat/hooks/use-conversation-messages";
import { useComposerMessageState } from "@/features/chat/hooks/use-composer-message-state";
import { useStreamingChat } from "@/features/chat/hooks/use-streaming-chat";
import { useThreadActivity } from "@/features/chat/hooks/use-thread-activity";
import {
  useTraceEventMonitor,
  useTraceIpcListener,
} from "@/platform/diagnostics/use-trace-listener";
import { buildActivityTasks } from "@/features/chat/lib/event-transforms";
import { useCapturedChatContext } from "./use-captured-chat-context";
import { useChatScrollManagement } from "./use-chat-scroll-management";
import { useChatHomeSurface } from "./use-chat-home-surface";
import { useAgentInputRouting } from "./use-agent-input-routing";
import { useConversationModelSelection } from "./use-conversation-model-selection";
import { useStellaSendMessageBridge } from "./use-stella-send-message-bridge";
import { composerDraftFromUserRow } from "@/app/chat/message-composer-restore";
import { useChatStore } from "@/context/chat-store-context";
import { useCloudChatBridge } from "@/features/cloud/use-cloud-chat-bridge";
import { cloudAttachmentsStore } from "@/features/cloud/cloud-composer-store";
import { useOwnDeviceRemoteCancel } from "@/features/cloud/use-own-device-remote-cancel";
import { cloudApi } from "@/features/cloud/cloud-api";
import { cloudPrefixBoundaryForUserMessage } from "@/features/cloud/use-cloud-chat-bridge";
import { conversationStore } from "@/features/cloud/conversation-store";
import { markCloudConversationCreated } from "@/features/cloud/cloud-conversation-selection";
import { useCloudMode } from "@/global/auth/hooks/use-cloud-mode";
import { showToast } from "@/ui/toast";
const MAX_RETAINED_TAB_STATE = 20;
/**
 * How long, after opening/switching into a conversation that lands at the
 * bottom, to keep re-pinning to the true end while late-rendering content
 * (agent cards, activity cards, images) settles and grows the scroll height.
 */
const OPEN_BOTTOM_SETTLE_MS = 600;
const NO_NEWER_CLOUD_MESSAGES = () => false;
const EMPTY_STREAMING_ASSISTANTS = [];
const setBoundedTabMemory = (memory, conversationId, value) => {
  memory.delete(conversationId);
  memory.set(conversationId, value);
  while (memory.size > MAX_RETAINED_TAB_STATE) {
    const oldestConversationId = memory.keys().next().value;
    if (typeof oldestConversationId !== "string") break;
    memory.delete(oldestConversationId);
  }
};
export const createConversationScrollMemoryCleanup = ({
  conversationId,
  list,
  scrollMemory,
  getIsFollowing,
  isConversationOpen,
}) => {
  // Resolve Legend's DOM node while its internal ref is still mounted. During
  // layout cleanup the list handle can remain non-null after that internal ref
  // has already been cleared, making a late getScrollableNode() call throw.
  let element = null;
  if (conversationId && list) {
    try {
      element = list.getScrollableNode();
    } catch {
      // A conversation switch can race Legend's own ref teardown. Scroll
      // memory is best-effort; losing one position is safer than crashing the
      // account transition while trying to capture it.
      element = null;
    }
  }
  return () => {
    if (!conversationId || !isConversationOpen(conversationId) || !element) {
      return;
    }
    setBoundedTabMemory(scrollMemory, conversationId, {
      scrollTop: element.scrollTop,
      followingLatest: getIsFollowing(),
    });
  };
};
const newConversationEditRequestId = () =>
  typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `edit-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
export const cloudConversationEditFailureMessage = (error, fallback) => {
  const data = error?.data;
  if (typeof data === "string" && data.trim()) return data.trim();
  if (typeof data?.message === "string" && data.message.trim())
    return data.message.trim();
  if (
    error instanceof Error &&
    error.message.trim() &&
    !/Server Error|ConvexError|\[Request ID/.test(error.message)
  ) {
    return error.message.trim();
  }
  return fallback;
};
export function useFullShellChat({
  activeConversationId,
  isOnChatRoute,
  traceEnabled,
  navigateToConversation,
}) {
  const { cloudFeaturesEnabled, isLocalStorage } = useChatStore();
  const { accountScope } = useCloudMode();
  const activeAccountScopeRef = useRef(accountScope);
  activeAccountScopeRef.current = accountScope;
  const forkCloudConversation = useAction(cloudApi.forkMyConversation);
  const rewindCloudConversation = useAction(cloudApi.rewindMyConversation);
  // Message state + always-current mirror ref, synced at WRITE time. The
  // dictate-and-submit commit is rAF-deferred and can fire before React
  // flushes the render that carries the appended transcript — a ref synced in
  // the render body would still hold the pre-transcript text at that point,
  // so the send would go out empty (and silently no-op), leaving the
  // transcript sitting in the composer unsent. See use-composer-message-state.
  const {
    message,
    setMessage,
    messageRef: latestMessageRef,
  } = useComposerMessageState();
  const [composerFocusRequestId, setComposerFocusRequestId] = useState(0);
  const { chatContext, setChatContext, selectedText, setSelectedText } =
    useCapturedChatContext();
  const composerMemoryByConversationRef = useRef(new Map());
  const scrollMemoryByConversationRef = useRef(new Map());
  const activeConversationIdRef = useRef(activeConversationId);
  activeConversationIdRef.current = activeConversationId;
  const previousComposerConversationIdRef = useRef(activeConversationId);
  const restoredConversationScrollRef = useRef(null);
  // Auth scope is a hard renderer privacy boundary. Clear composer content,
  // attachment handles, and per-tab memories in a layout effect so no frame
  // can paint the previous owner's unsent text during identity bootstrap.
  useLayoutEffect(() => {
    composerMemoryByConversationRef.current.clear();
    scrollMemoryByConversationRef.current.clear();
    previousComposerConversationIdRef.current = null;
    restoredConversationScrollRef.current = null;
    setMessage("");
    setChatContext(null);
    setSelectedText(null);
    cloudAttachmentsStore.clear();
  }, [accountScope, setChatContext, setMessage, setSelectedText]);
  useEffect(() => {
    const previousConversationId = previousComposerConversationIdRef.current;
    if (previousConversationId === activeConversationId) return;
    if (previousConversationId) {
      const remainsOpen = conversationTabs
        .getSnapshot()
        .tabs.some((tab) => tab.conversationId === previousConversationId);
      if (remainsOpen) {
        setBoundedTabMemory(
          composerMemoryByConversationRef.current,
          previousConversationId,
          {
            message: latestMessageRef.current,
            chatContext,
            selectedText,
          },
        );
      }
    }
    if (activeConversationId) {
      const remembered =
        composerMemoryByConversationRef.current.get(activeConversationId);
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
  useEffect(
    () =>
      conversationTabs.subscribe(() => {
        const openIds = new Set(
          conversationTabs.getSnapshot().tabs.map((tab) => tab.conversationId),
        );
        for (const conversationId of composerMemoryByConversationRef.current.keys()) {
          if (!openIds.has(conversationId)) {
            composerMemoryByConversationRef.current.delete(conversationId);
            scrollMemoryByConversationRef.current.delete(conversationId);
          }
        }
      }),
    [],
  );
  const { messages: localPersistedMessages } = useConversationMessages(
    activeConversationId ?? undefined,
  );
  const { activities: localActivities } = useConversationActivity(
    activeConversationId ?? undefined,
  );
  const { files: localPersistedFiles } = useConversationFiles(
    activeConversationId ?? undefined,
  );
  const { records: threadActivityRecords } = useThreadActivity(
    activeConversationId ?? undefined,
  );
  const {
    taskDecorations: localTaskDecorations,
    optimisticEvents: localOptimisticEvents,
    runtimeStatusText: localRuntimeStatusText,
    activeToolCallId: localActiveToolCallId,
    activeToolName: localActiveToolName,
    latestCompletedTool: localLatestCompletedTool,
    hasToolActivity: localHasToolActivity,
    isToolActive: localIsToolActive,
    reasoningText: localReasoningText,
    streamingAssistants: localStreamingAssistants,
    isStreaming: localIsStreaming,
    answerLanded: localAnswerLanded,
    pendingUserMessageId: localPendingUserMessageId,
    queuedUserMessages: localQueuedUserMessages,
    removeQueuedUserMessage: localRemoveQueuedUserMessage,
    sendMessage: localSendMessage,
    cancelCurrentStream: localCancelCurrentStream,
  } = useStreamingChat({
    conversationId: activeConversationId,
    persistedMessages: localPersistedMessages,
  });
  const localTasks = useMemo(
    () => buildActivityTasks(threadActivityRecords, localTaskDecorations),
    [threadActivityRecords, localTaskDecorations],
  );
  const cloudChat = useCloudChatBridge({
    conversationId: activeConversationId,
    enabled: cloudFeaturesEnabled,
    localMessages: localPersistedMessages,
    localActivities,
    localFiles: localPersistedFiles,
    localTasks,
  });
  useOwnDeviceRemoteCancel({
    conversationId: cloudChat.conversation.state.conversationId,
    records: cloudChat.records,
    enabled: cloudFeaturesEnabled && isLocalStorage && !cloudChat.isWebShell,
    onCancel: localCancelCurrentStream,
  });
  const persistedMessages = cloudChat.persistedMessages;
  const activities = cloudChat.activities;
  const persistedFiles = cloudChat.files;
  const tasks = cloudChat.tasks;
  const optimisticEvents = cloudChat.isWebShell
    ? cloudChat.optimisticEvents
    : localOptimisticEvents;
  // The web shell has no in-memory overlay: a cloud reply becomes visible when
  // its journal row commits, not before.
  const streamingAssistants = cloudChat.isWebShell
    ? EMPTY_STREAMING_ASSISTANTS
    : localStreamingAssistants;
  const runtimeStatusText = cloudChat.isWebShell
    ? cloudChat.runtimeStatusText
    : localRuntimeStatusText;
  const activeToolCallId = cloudChat.isWebShell ? null : localActiveToolCallId;
  const activeToolName = cloudChat.isWebShell
    ? cloudChat.activeToolName
    : localActiveToolName;
  const latestCompletedTool = cloudChat.isWebShell
    ? null
    : localLatestCompletedTool;
  const hasToolActivity = cloudChat.isWebShell
    ? Boolean(cloudChat.activeToolName)
    : localHasToolActivity;
  const isToolActive = cloudChat.isWebShell
    ? Boolean(cloudChat.activeToolName)
    : localIsToolActive;
  const reasoningText = cloudChat.isWebShell ? "" : localReasoningText;
  const isStreaming = cloudChat.isWebShell
    ? cloudChat.isStreaming
    : localIsStreaming;
  // The web shell has no per-message landing signal: a cloud turn ends at the
  // moment its reply row commits, so the indicator exits on `isStreaming`
  // rather than handing off to a reply that is still arriving.
  const answerLanded = cloudChat.isWebShell ? false : localAnswerLanded;
  const pendingUserMessageId = cloudChat.isWebShell
    ? cloudChat.pendingUserMessageId
    : localPendingUserMessageId;
  const queuedUserMessages = cloudChat.isWebShell
    ? []
    : localQueuedUserMessages;
  const removeQueuedUserMessage = cloudChat.isWebShell
    ? () => {}
    : localRemoveQueuedUserMessage;
  const sendMessage = cloudChat.isWebShell
    ? cloudChat.sendMessage
    : localSendMessage;
  const cancelCurrentStream = cloudChat.isWebShell
    ? cloudChat.cancelCurrentStream
    : localCancelCurrentStream;
  // The DO window is the only history authority. SQLite page cursors are
  // deliberately not consulted even on desktop.
  const hasOlderMessages = cloudChat.conversation.state.hasOlder;
  const hasNewerMessages = false;
  const isLoadingOlderMessages = cloudChat.conversation.state.loadingOlder;
  const isLoadingNewerMessages = false;
  const isInitialLoadingMessages = cloudChat.isInitialLoading;
  const loadOlderMessages = cloudChat.conversation.loadOlder;
  const loadNewerMessages = NO_NEWER_CLOUD_MESSAGES;
  const loadLatestMessages = NO_NEWER_CLOUD_MESSAGES;
  const hasOlderActivity = cloudChat.hasOlderActivity;
  const isLoadingOlderActivity = cloudChat.isLoadingOlderActivity;
  const loadOlderActivity = cloudChat.loadOlderActivity;
  const hasOlderFiles = cloudChat.conversation.state.hasOlder;
  const isLoadingOlderFiles = cloudChat.conversation.state.loadingOlder;
  const loadOlderFiles = cloudChat.conversation.loadOlder;
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
    if (!traceEnabled) return [];
    const out = [];
    for (const event of activities) out.push(event);
    for (const message of persistedMessages) {
      out.push(message);
      for (const toolEvent of message.toolEvents) out.push(toolEvent);
    }
    return out;
  }, [activities, traceEnabled, persistedMessages]);
  useTraceEventMonitor(traceEnabled, traceEvents);
  const hasMessages = displayMessages.length > 0;
  const {
    showHomeContent,
    enterChatSurfaceForInteraction,
    resetIdleTimer,
    dismissHome,
    showHome,
  } = useChatHomeSurface({
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
    if (!isOnChatRoute) return;
    setComposerFocusRequestId((id) => id + 1);
  }, [isOnChatRoute, activeConversationId]);
  const {
    sendContextlessMessage,
    sendAgentInputMessage,
    sendMessageWithContext,
  } = useAgentInputRouting({
    activeConversationId,
    sendMessage,
    enterChatSurfaceForInteraction,
  });
  useStellaSendMessageBridge({
    sendContextlessMessage,
    sendAgentInputMessage,
  });
  /**
   * Scroll: backed by Legend List (web entry). The list owns scrolling
   * and content geometry; the hook adapts list state into the surface
   * UI concerns (at-bottom, custom thumb, scroll-to-bottom button).
   */
  const {
    listRef,
    isAtBottom,
    isNearBottom,
    isFollowingLatest,
    isUserScrolling,
    noteManualScroll,
    getIsFollowing,
    getShouldPlaceLatestTurn,
    getIsEffectivelyAtBottom,
    showScrollButton,
    scrollToBottom,
    releaseFollow,
    nudgeAfterSend,
    nudgeQueuedMessagesIntoView,
    thumbRef,
  } = useChatScrollManagement({
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
    const scrollMemory = scrollMemoryByConversationRef.current;
    return createConversationScrollMemoryCleanup({
      conversationId,
      list: listRef.current,
      scrollMemory,
      getIsFollowing,
      isConversationOpen: (id) =>
        conversationTabs
          .getSnapshot()
          .tabs.some((tab) => tab.conversationId === id),
    });
  }, [activeConversationId, getIsFollowing, listRef]);
  useEffect(() => {
    if (
      !activeConversationId ||
      isInitialLoadingMessages ||
      displayMessages.length === 0 ||
      restoredConversationScrollRef.current === activeConversationId
    ) {
      return;
    }
    const conversationId = activeConversationId;
    let settleRaf = null;
    const frame = window.requestAnimationFrame(() => {
      const remembered =
        scrollMemoryByConversationRef.current.get(conversationId);
      const element = listRef.current?.getScrollableNode();
      if (remembered && !remembered.followingLatest && element) {
        const maximumScrollTop = Math.max(
          0,
          element.scrollHeight - element.clientHeight,
        );
        element.scrollTo({
          top: Math.min(remembered.scrollTop, maximumScrollTop),
          behavior: "instant",
        });
      } else {
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
          if (!node || !getIsFollowing()) return;
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
      if (settleRaf !== null) window.cancelAnimationFrame(settleRaf);
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
    // Frame the just-sent turn (place the new user message near the top,
    // with the response spacer as the reading area below it) whenever the
    // freshest turn is on screen — near/at bottom OR meaningfully scrolled
    // up but still within the placement window. `getIsEffectivelyAtBottom`
    // is distance-based (latch-independent), so a stray upward nudge near
    // the bottom still frames-to-top rather than falling through to a plain
    // scroll. Only a genuine read-history position (neither) stays put. The
    // spacer is settled+frozen for the placement in the scroll hook, so the
    // nudge target can't be yanked mid-animation.
    const shouldKeepTailFramed =
      showHomeContent ||
      getIsEffectivelyAtBottom() ||
      getShouldPlaceLatestTurn();
    const shouldNudgeAfterSend = !isStreaming && shouldKeepTailFramed;
    const submittedConversationId = activeConversationId;
    const accepted = await sendMessage({
      text: latestMessageRef.current,
      selectedText,
      chatContext,
      onClear: () => {
        if (activeConversationIdRef.current !== submittedConversationId) {
          if (submittedConversationId) {
            setBoundedTabMemory(
              composerMemoryByConversationRef.current,
              submittedConversationId,
              {
                message: "",
                selectedText: null,
                chatContext: null,
              },
            );
          }
          return;
        }
        setMessage("");
        setSelectedText(null);
        setChatContext(null);
      },
    });
    if (
      !accepted ||
      activeConversationIdRef.current !== submittedConversationId
    ) {
      return;
    }
    if (showHomeContent) {
      setComposerFocusRequestId((id) => id + 1);
    }
    enterChatSurfaceForInteraction();
    resetIdleTimer();
    if (isStreaming) {
      // Queued follow-up — no new user row lands in the event list.
      // The streaming assistant row's own auto-follow keeps the reply
      // framed, but repeated queued chips live below that row in the
      // virtualized tail and can drift under the viewport without their own
      // target.
      if (shouldKeepTailFramed) {
        nudgeQueuedMessagesIntoView();
      }
    } else if (shouldNudgeAfterSend) {
      // Places the newest user turn near the top of the readable area,
      // above the (now settled) response spacer. The gentle loop keeps
      // that reframe continuous with the assistant stream-follow.
      nudgeAfterSend();
    } else {
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
  // Per-conversation model selection: mirror the global model preferences
  // to whichever conversation is active so each tab remembers its own
  // engine/model/reasoning pick. Cloud and local conversations both retain
  // their own selection while sharing the same global picker surface.
  useConversationModelSelection({
    activeConversationId,
    enabled: true,
  });
  // Per-user-message quick actions (Fork / Rewind) exposed to the deeply
  // nested action row. The callbacks are stable and read live state
  // through this ref, so every user row can consume them without
  // re-rendering as conversation state churns.
  const messageActionsStateRef = useRef(null);
  const conversationEditInFlightRef = useRef(false);
  const conversationEditOperationRef = useRef(null);
  const forkRequestRef = useRef(null);
  const rewindRequestRef = useRef(null);
  useEffect(() => {
    conversationEditInFlightRef.current = false;
    conversationEditOperationRef.current = null;
    forkRequestRef.current = null;
    rewindRequestRef.current = null;
  }, [accountScope]);
  messageActionsStateRef.current = {
    activeConversationId,
    accountScope,
    isStreaming,
    cloudRecords: cloudChat.records,
    cloudState: cloudChat.conversation.state,
    forkCloudConversation,
    rewindCloudConversation,
    setMessage,
    setChatContext,
    setSelectedText,
    navigateToConversation,
    requestFocus: () => setComposerFocusRequestId((id) => id + 1),
  };
  // Rewind changes the canonical DO epoch at the sequence immediately before
  // the target prompt, then seeds that prompt back into the same composer.
  // SQLite is neither read nor written as mutation authority.
  const rewindToUserMessage = useCallback((row) => {
    const state = messageActionsStateRef.current;
    if (!state) return;
    if (state.isStreaming || conversationEditInFlightRef.current) return;
    const conversationId = state.activeConversationId;
    if (!conversationId || !row?.id) return;
    const boundary = cloudPrefixBoundaryForUserMessage(
      state.cloudRecords,
      row.id,
    );
    const head = state.cloudState;
    if (!boundary) {
      showToast({
        title: "Couldn’t rewind this message",
        description:
          "This prompt has not reached the canonical cloud history yet. Reconnect and try again.",
        variant: "error",
      });
      return;
    }
    if (
      head.status !== "live" ||
      head.conversationId !== conversationId ||
      !Number.isSafeInteger(head.epoch) ||
      !Number.isSafeInteger(head.headSeq) ||
      head.headSeq < boundary.targetSeq
    ) {
      showToast({
        title: "Cloud history is reconnecting",
        description:
          "Wait for the conversation to finish reconnecting, then try Rewind again.",
        variant: "error",
      });
      return;
    }
    const draft = composerDraftFromUserRow(row);
    const requestKey = `${conversationId}:${head.epoch}:${head.headSeq}:${boundary.throughSeq}`;
    const requestId =
      rewindRequestRef.current?.key === requestKey
        ? rewindRequestRef.current.requestId
        : newConversationEditRequestId();
    rewindRequestRef.current = { key: requestKey, requestId };
    const operation = { accountScope: state.accountScope, requestId };
    conversationEditOperationRef.current = operation;
    conversationEditInFlightRef.current = true;
    void (async () => {
      try {
        await state.rewindCloudConversation({
          conversationId,
          throughSeq: boundary.throughSeq,
          expectedEpoch: head.epoch,
          expectedLastSeq: head.headSeq,
          requestId,
          activeTurnPolicy: "conflict",
        });
        if (
          conversationEditOperationRef.current !== operation ||
          activeAccountScopeRef.current !== operation.accountScope
        ) {
          return;
        }
        rewindRequestRef.current = null;
        scrollMemoryByConversationRef.current.delete(conversationId);
        conversationStore(
          conversationId,
          operation.accountScope,
        ).refreshAfterCanonicalMutation();
        if (activeConversationIdRef.current !== conversationId) {
          setBoundedTabMemory(
            composerMemoryByConversationRef.current,
            conversationId,
            {
              message: draft.message,
              chatContext: draft.chatContext,
              selectedText: null,
            },
          );
          return;
        }
        state.setMessage(draft.message);
        state.setChatContext(draft.chatContext);
        state.setSelectedText(null);
        state.requestFocus();
      } catch (error) {
        if (
          conversationEditOperationRef.current !== operation ||
          activeAccountScopeRef.current !== operation.accountScope
        ) {
          return;
        }
        showToast({
          title: "Couldn’t rewind this conversation",
          description: cloudConversationEditFailureMessage(
            error,
            "Cloud history changed before Rewind completed. Reconnect and try again.",
          ),
          variant: "error",
        });
      } finally {
        if (conversationEditOperationRef.current === operation) {
          conversationEditOperationRef.current = null;
          conversationEditInFlightRef.current = false;
        }
      }
    })();
  }, []);
  // Fork copies the canonical prefix into a fresh DO-backed conversation,
  // then drops the selected prompt into the new tab's composer. The source
  // remains untouched and no SQLite branch is minted.
  const forkToNewConversation = useCallback((row) => {
    const state = messageActionsStateRef.current;
    if (!state) return;
    if (state.isStreaming || conversationEditInFlightRef.current) return;
    const conversationId = state.activeConversationId;
    if (!conversationId || !row?.id) return;
    // Never mint a branch we can't navigate to — that would strand the
    // user on the original chat with an orphan conversation in the store.
    if (!state.navigateToConversation) return;
    const boundary = cloudPrefixBoundaryForUserMessage(
      state.cloudRecords,
      row.id,
    );
    const head = state.cloudState;
    if (!boundary) {
      showToast({
        title: "Couldn’t fork this message",
        description:
          "This prompt has not reached the canonical cloud history yet. Reconnect and try again.",
        variant: "error",
      });
      return;
    }
    if (
      head.status !== "live" ||
      head.conversationId !== conversationId ||
      !Number.isSafeInteger(head.epoch) ||
      !Number.isSafeInteger(head.headSeq) ||
      head.headSeq < boundary.targetSeq
    ) {
      showToast({
        title: "Cloud history is reconnecting",
        description:
          "Wait for the conversation to finish reconnecting, then try Fork again.",
        variant: "error",
      });
      return;
    }
    const draft = composerDraftFromUserRow(row);
    const requestKey = `${conversationId}:${head.epoch}:${head.headSeq}:${boundary.throughSeq}`;
    const requestId =
      forkRequestRef.current?.key === requestKey
        ? forkRequestRef.current.requestId
        : newConversationEditRequestId();
    forkRequestRef.current = { key: requestKey, requestId };
    const operation = { accountScope: state.accountScope, requestId };
    conversationEditOperationRef.current = operation;
    conversationEditInFlightRef.current = true;
    void (async () => {
      try {
        const result = await state.forkCloudConversation({
          sourceConversationId: conversationId,
          throughSeq: boundary.throughSeq,
          expectedEpoch: head.epoch,
          expectedLastSeq: head.headSeq,
          requestId,
        });
        if (
          conversationEditOperationRef.current !== operation ||
          activeAccountScopeRef.current !== operation.accountScope
        ) {
          return;
        }
        forkRequestRef.current = null;
        markCloudConversationCreated(result.conversationId, state.accountScope);
        // Open + navigate first so the destination tab exists, THEN seed
        // its composer memory. The restore effect consumes the seed when
        // the active id changes on the next render.
        state.navigateToConversation(result.conversationId);
        setBoundedTabMemory(
          composerMemoryByConversationRef.current,
          result.conversationId,
          {
            message: draft.message,
            chatContext: draft.chatContext,
            selectedText: null,
          },
        );
      } catch (error) {
        if (
          conversationEditOperationRef.current !== operation ||
          activeAccountScopeRef.current !== operation.accountScope
        ) {
          return;
        }
        showToast({
          title: "Couldn’t fork this conversation",
          description: cloudConversationEditFailureMessage(
            error,
            "Cloud history changed before Fork completed. Reconnect and try again.",
          ),
          variant: "error",
        });
      } finally {
        if (conversationEditOperationRef.current === operation) {
          conversationEditOperationRef.current = null;
          conversationEditInFlightRef.current = false;
        }
      }
    })();
  }, []);
  const messageActions = useMemo(
    () => ({ rewind: rewindToUserMessage, fork: forkToNewConversation }),
    [rewindToUserMessage, forkToNewConversation],
  );
  const chatColumnConversation = useMemo(
    () => ({
      conversationId: activeConversationId,
      tasks,
      extraTail: cloudChat.extraTail,
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
        answerLanded,
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
    }),
    [
      activeConversationId,
      activities,
      cloudChat.extraTail,
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
      answerLanded,
      isToolActive,
    ],
  );
  const chatColumnComposer = useMemo(
    () => ({
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
    }),
    [
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
    ],
  );
  const chatColumnScroll = useMemo(
    () => ({
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
    }),
    [
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
    ],
  );
  // The visible message timeline (`displayMessages`) is the only field
  // that changes whenever a provider chunk arrives while a reply streams. It is
  // returned separately and published through `ChatMessagesContext` rather
  // than folded into `runtime`, so the `runtime` value below keeps a stable
  // identity across streamed chunks. That stops every `useChatRuntime()`
  // consumer (shell chrome, left sidebar, mobile bridge) from re-rendering
  // per chunk — only the timeline renderers subscribe to the message channel.
  const conversation = useMemo(
    () => ({
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
    }),
    [
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
    ],
  );
  const composer = useMemo(
    () => ({
      ...chatColumnComposer,
      handleSend,
      handleStop: cancelCurrentStream,
    }),
    [chatColumnComposer, handleSend, cancelCurrentStream],
  );
  const runtime = useMemo(
    () => ({
      conversation,
      composer,
      scroll: chatColumnScroll,
      messageActions,
      showHomeContent,
      dismissHome,
      showHome,
    }),
    [
      conversation,
      composer,
      chatColumnScroll,
      messageActions,
      showHomeContent,
      dismissHome,
      showHome,
    ],
  );
  return { runtime, messages: displayMessages };
}
