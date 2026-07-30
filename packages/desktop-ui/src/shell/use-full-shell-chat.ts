import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useMutation } from "convex/react";
import type {
  ChatColumnComposer,
  ChatColumnConversation,
  ChatColumnScroll,
} from "@/features/chat/chat-column-types";
import type { ChatContext } from "@/shared/types/electron";
import {
  attachComposerAppSelectionContext,
  deriveComposerState,
} from "@/features/chat/composer-context";
import { useConversationActivity } from "@/features/chat/hooks/use-conversation-activity";
import { useConversationDisplayMessages } from "@/features/chat/hooks/use-conversation-display-messages";
import { useConversationFiles } from "@/features/chat/hooks/use-conversation-files";
import { useConversationMessages } from "@/features/chat/hooks/use-conversation-messages";
import { useComposerMessageState } from "@/features/chat/hooks/use-composer-message-state";
import { useStreamingChat } from "@/features/chat/hooks/use-streaming-chat";
import { useActivityTaskState } from "@/features/chat/hooks/use-thread-activity";
import { getActivityPresence } from "@/features/chat/lib/activity-presence";
import {
  useTraceEventMonitor,
  useTraceIpcListener,
} from "@/platform/diagnostics/use-trace-listener";
import type { EventRecord } from "@/features/chat/lib/event-transforms";
import { useUiState } from "@/context/ui-state";
import { useChatStore } from "@/context/chat-store-context";
import { useAuthSessionState } from "@/global/auth/hooks/use-auth-session-state";
import { router } from "@/router";
import { cloudApi } from "@/features/cloud/cloud-api";
import {
  cloudAttachmentsStore,
  useCloudAttachments,
  withAttachmentPreamble,
} from "@/features/cloud/cloud-composer-store";
import { markCloudConversationCreated } from "@/features/cloud/cloud-conversation-selection";
import {
  activeCloudUserMessageIds,
  completeJournalWindowRecords,
  hasIncompleteLeadingJournalTurn,
  journalRecordsToMessageRecords,
  mergeCanonicalMessagesWithLocalCache,
} from "@/features/cloud/journal-message-records";
import {
  journalRecordsToCloudActivityEvents,
  journalRecordsToCloudFileEvents,
  mergeCanonicalCloudEventsWithLocalOverlay,
  nextLocalCloudEventOverlayExpiry,
} from "@/features/cloud/journal-activity-files";
import {
  mergeCloudConversationTasks,
  useCloudConversationActivity,
} from "@/features/cloud/use-cloud-activity";
import { useConversation } from "@/features/cloud/use-conversation";
import { useCapturedChatContext } from "./use-captured-chat-context";
import { useChatScrollManagement } from "./use-chat-scroll-management";
import { useChatHomeSurface } from "./use-chat-home-surface";
import { useAgentInputRouting } from "./use-agent-input-routing";
import { useStellaSendMessageBridge } from "./use-stella-send-message-bridge";

type UseFullShellChatOptions = {
  activeConversationId: string | null;
  /** True when the user is currently on the `/chat` route. */
  isOnChatRoute: boolean;
  /**
   * Explicit opt-in for trace diagnostics. NOT `import.meta.env.DEV`: Stella
   * ships as a Vite dev server so DEV is TRUE in production. Defaults OFF via
   * `isTraceDiagnosticsEnabled()` at the call site.
   */
  traceEnabled: boolean;
};

export type AnnotationSelection = NonNullable<ChatContext["appSelection"]>;

type AnnotationContextTarget = {
  id: number;
  submit: (selection: AnnotationSelection) => void;
};

type StartAnnotationOptions = {
  submit: (selection: AnnotationSelection) => void;
};

export function useFullShellChat({
  activeConversationId,
  isOnChatRoute,
  traceEnabled,
}: UseFullShellChatOptions) {
  const { setConversationId } = useUiState();
  const { cloudFeaturesEnabled } = useChatStore();
  const { cacheScope: accountScope } = useAuthSessionState();
  const createCloudConversation = useMutation(cloudApi.createMyConversation);
  const cloudAttachments = useCloudAttachments();
  const decorateCloudPrompt = useCallback(
    (prompt: string) => withAttachmentPreamble(prompt, cloudAttachments),
    [cloudAttachments],
  );
  const clearCloudAttachments = useCallback(
    () => cloudAttachmentsStore.clear(),
    [],
  );
  const cloudConversation = useConversation(
    cloudFeaturesEnabled ? activeConversationId : null,
    decorateCloudPrompt,
    clearCloudAttachments,
  );
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
  const annotationIdRef = useRef(0);
  const annotationTargetRef = useRef<AnnotationContextTarget | null>(null);
  const [annotationTarget, setAnnotationTarget] =
    useState<AnnotationContextTarget | null>(null);
  const { chatContext, setChatContext, selectedText, setSelectedText } =
    useCapturedChatContext();
  const restoredConversationScrollRef = useRef<string | null>(null);

  const { messages: localPersistedMessages } = useConversationMessages(
    activeConversationId ?? undefined,
  );

  const hasIncompleteCloudLeadingTurn =
    cloudFeaturesEnabled &&
    hasIncompleteLeadingJournalTurn(
      cloudConversation.state.records,
      cloudConversation.state.hasOlder,
    );
  const completeCloudRecords = useMemo(
    () =>
      cloudFeaturesEnabled
        ? completeJournalWindowRecords(
            cloudConversation.state.records,
            cloudConversation.state.hasOlder,
          )
        : [],
    [
      cloudConversation.state.hasOlder,
      cloudConversation.state.records,
      cloudFeaturesEnabled,
    ],
  );
  const canonicalMessages = useMemo(
    () =>
      cloudFeaturesEnabled
        ? journalRecordsToMessageRecords(completeCloudRecords)
        : [],
    [cloudFeaturesEnabled, completeCloudRecords],
  );
  const activeCanonicalUserMessageIds = useMemo(
    () =>
      cloudFeaturesEnabled
        ? activeCloudUserMessageIds(cloudConversation.state.records)
        : new Set<string>(),
    [cloudConversation.state.records, cloudFeaturesEnabled],
  );
  const persistedMessages = useMemo(
    () =>
      mergeCanonicalMessagesWithLocalCache(
        canonicalMessages,
        localPersistedMessages,
        activeCanonicalUserMessageIds,
      ),
    [activeCanonicalUserMessageIds, canonicalMessages, localPersistedMessages],
  );
  const hasOlderMessages =
    cloudFeaturesEnabled && cloudConversation.state.hasOlder;
  const isLoadingOlderMessages =
    cloudFeaturesEnabled && cloudConversation.state.loadingOlder;
  const isInitialLoadingMessages =
    !cloudFeaturesEnabled ||
    Boolean(
      activeConversationId &&
        canonicalMessages.length === 0 &&
        (hasIncompleteCloudLeadingTurn ||
          cloudConversation.status === "idle" ||
          cloudConversation.status === "connecting"),
    );
  const loadOlderCloudMessages = cloudConversation.loadOlder;
  useEffect(() => {
    if (
      !hasIncompleteCloudLeadingTurn ||
      cloudConversation.state.loadingOlder
    ) {
      return;
    }
    loadOlderCloudMessages();
  }, [
    cloudConversation.state.loadingOlder,
    hasIncompleteCloudLeadingTurn,
    loadOlderCloudMessages,
  ]);
  const loadOlderMessages = useCallback(() => {
    if (!cloudFeaturesEnabled) return false;
    loadOlderCloudMessages();
    return true;
  }, [cloudFeaturesEnabled, loadOlderCloudMessages]);

  const { activities: localActivities } = useConversationActivity(
    activeConversationId ?? undefined,
  );

  const { files: localFiles } = useConversationFiles(
    activeConversationId ?? undefined,
  );
  const [localOverlayNowMs, setLocalOverlayNowMs] = useState(() => Date.now());
  useEffect(() => {
    const wallNow = Date.now();
    // The clock otherwise sleeps when there are no overlay rows. Refresh it
    // before evaluating newly arrived rows so a perfectly current event is not
    // mistaken for a future-dated legacy record after a long idle period.
    if (Math.abs(wallNow - localOverlayNowMs) > 1_000) {
      setLocalOverlayNowMs(wallNow);
      return;
    }
    const nextActivityExpiry = nextLocalCloudEventOverlayExpiry(
      localActivities,
      localOverlayNowMs,
    );
    const nextFileExpiry = nextLocalCloudEventOverlayExpiry(
      localFiles,
      localOverlayNowMs,
    );
    const expiries = [nextActivityExpiry, nextFileExpiry].filter(
      (expiry): expiry is number => expiry !== null,
    );
    if (expiries.length === 0) return;
    const nextExpiry = Math.min(...expiries);
    if (nextExpiry <= wallNow) {
      setLocalOverlayNowMs(wallNow);
      return;
    }
    const timer = window.setTimeout(
      () => setLocalOverlayNowMs(Date.now()),
      Math.min(2_147_483_647, nextExpiry - wallNow + 1),
    );
    return () => window.clearTimeout(timer);
  }, [localActivities, localFiles, localOverlayNowMs]);

  const canonicalActivities = useMemo(
    () =>
      cloudFeaturesEnabled
        ? journalRecordsToCloudActivityEvents(completeCloudRecords)
        : [],
    [cloudFeaturesEnabled, completeCloudRecords],
  );
  const canonicalFiles = useMemo(
    () =>
      cloudFeaturesEnabled
        ? journalRecordsToCloudFileEvents(completeCloudRecords)
        : [],
    [cloudFeaturesEnabled, completeCloudRecords],
  );
  const activities = useMemo(
    () =>
      mergeCanonicalCloudEventsWithLocalOverlay(
        canonicalActivities,
        localActivities,
        { nowMs: localOverlayNowMs },
      ),
    [canonicalActivities, localActivities, localOverlayNowMs],
  );
  const persistedFiles = useMemo(
    () =>
      mergeCanonicalCloudEventsWithLocalOverlay(canonicalFiles, localFiles, {
        nowMs: localOverlayNowMs,
      }),
    [canonicalFiles, localFiles, localOverlayNowMs],
  );
  const hasOlderActivity =
    cloudFeaturesEnabled && cloudConversation.state.hasOlder;
  const hasOlderFiles =
    cloudFeaturesEnabled && cloudConversation.state.hasOlder;
  const isLoadingOlderActivity =
    cloudFeaturesEnabled && cloudConversation.state.loadingOlder;
  const isLoadingOlderFiles =
    cloudFeaturesEnabled && cloudConversation.state.loadingOlder;
  const loadOlderActivity = loadOlderCloudMessages;
  const loadOlderFiles = loadOlderCloudMessages;

  const {
    taskDecorations,
    optimisticEvents,
    runtimeStatusText,
    activeToolCallId,
    activeToolName,
    hasToolActivity,
    isToolActive,
    reasoningText,
    streamingAssistants,
    isStreaming,
    isStreamingResponseText,
    pendingUserMessageId,
    queuedUserMessages,
    removeQueuedUserMessage,
    sendMessage,
    cancelCurrentStream,
  } = useStreamingChat({
    conversationId: activeConversationId,
    // Canonical cloud rows acknowledge optimistic sends. Local rows remain in
    // this merged window only for unacknowledged recovery overlays.
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
  const traceEvents = useMemo<EventRecord[]>(() => {
    if (!traceEnabled) return [];
    const out: EventRecord[] = [];
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

  const startNewChat = useCallback(async () => {
    // Auth bootstrap withholds the conversation surface until this becomes
    // true. Never turn that transient state into a desktop-only conversation.
    if (!cloudFeaturesEnabled) return;
    const nextConversationId = (
      await createCloudConversation({
        clientCreateId: crypto.randomUUID(),
      })
    ).conversationId;
    markCloudConversationCreated(nextConversationId, accountScope);
    setMessage("");
    setSelectedText(null);
    setChatContext(null);
    setConversationId(nextConversationId);
    showHome();

    // Every conversation is globally addressable, so every "New chat" entry
    // point lands on its exact route even when invoked elsewhere in the shell.
    await router.navigate({
      to: "/chat",
      search: { c: nextConversationId },
      replace: true,
    });
  }, [
    accountScope,
    cloudFeaturesEnabled,
    createCloudConversation,
    setChatContext,
    setConversationId,
    setMessage,
    setSelectedText,
    showHome,
  ]);

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

  const startAnnotation = useCallback((options: StartAnnotationOptions) => {
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

  const submitAnnotation = useCallback(
    (selection: AnnotationSelection, requestId?: number | null) => {
      const activeTarget = annotationTargetRef.current;
      const target =
        activeTarget && (requestId == null || activeTarget.id === requestId)
          ? activeTarget
          : null;

      if (!target) return;
      try {
        target.submit(selection);
      } finally {
        annotationTargetRef.current = null;
        setAnnotationTarget(null);
      }
    },
    [],
  );

  /**
   * Scroll: backed by Legend List (web entry). The list owns scrolling
   * and content geometry; the hook adapts list state into the surface
   * UI concerns (at-bottom, custom thumb, scroll-to-bottom button).
   */
  const {
    listRef,
    isAtBottom,
    isFollowingLatest,
    isUserScrolling,
    noteManualScroll,
    getIsFollowing,
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
  });

  // On conversation change, snap to the latest content. `initialScrollAtEnd`
  // covers fresh mounts; this handles in-place conversation switches.
  useEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const el = list.getScrollableNode();
    el?.scrollTo({ top: el.scrollHeight, behavior: "instant" });
  }, [activeConversationId, listRef]);

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
    const frame = window.requestAnimationFrame(() => {
      scrollToBottom("instant");
      restoredConversationScrollRef.current = conversationId;
    });
    return () => window.cancelAnimationFrame(frame);
  }, [
    activeConversationId,
    displayMessages.length,
    isInitialLoadingMessages,
    scrollToBottom,
  ]);

  const handleSend = useCallback(() => {
    // `getIsFollowing()` reads the follow latch (intent), not the
    // physical scroll position. After a short assistant reply, the
    // user is visually at the bottom of the conversation but ~150px
    // physically above the absolute end (because the trailing-region
    // footer is off-screen below the latest text).
    //
    // While a stream is already in flight, the send queues as a
    // follow-up chip at the keyed tail of the event list (not yet a sent
    // user row). The normal latest-user-row nudge is still skipped:
    // it would fall through to the prior turn's user bubble and scroll
    // *backwards* to re-frame it. The streaming branch below uses a
    // footer-tail target instead.
    const shouldKeepTailFramed = showHomeContent || getIsFollowing();
    const shouldNudgeAfterSend = !isStreaming && shouldKeepTailFramed;
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
    } else if (shouldNudgeAfterSend) {
      // Routes the small post-send bump through the same lerp loop
      // as streaming auto-follow so the two motions blend rather
      // than fight via separate concurrent rAF tweens.
      nudgeAfterSend();
    } else {
      releaseFollow();
    }
  }, [
    chatContext,
    enterChatSurfaceForInteraction,
    getIsFollowing,
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

  const attachFullChatAnnotation = useCallback(
    (selection: AnnotationSelection) => {
      enterChatSurfaceForInteraction();
      resetIdleTimer();
      attachComposerAppSelectionContext(selection, setChatContext);
      setComposerFocusRequestId((id) => id + 1);
    },
    [enterChatSurfaceForInteraction, resetIdleTimer, setChatContext],
  );

  const { canSubmit } = deriveComposerState({
    message,
    chatContext,
    selectedText,
    conversationId: activeConversationId,
    requireConversationId: true,
  });

  // The single task list every activity surface renders: authoritative
  // thread rows overlaid with live stream decoration. No event folding.
  const { tasks: localTasks } = useActivityTaskState(
    activeConversationId ?? undefined,
    taskDecorations,
  );
  const cloudActivity = useCloudConversationActivity(activeConversationId);
  const tasks = useMemo(
    () => mergeCloudConversationTasks(cloudActivity.tasks, localTasks),
    [cloudActivity.tasks, localTasks],
  );
  const activityPresence = useMemo(
    () => getActivityPresence(tasks, cloudActivity.hasLoaded),
    [cloudActivity.hasLoaded, tasks],
  );

  const chatColumnConversation = useMemo<ChatColumnConversation>(
    () => ({
      tasks,
      activityPresence,
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
    }),
    [
      activities,
      activityPresence,
      activeToolCallId,
      activeToolName,
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
    ],
  );

  const chatColumnComposer = useMemo<ChatColumnComposer>(
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
      onSelectArea: () => startAnnotation({ submit: attachFullChatAnnotation }),
      onSend: handleSend,
      onStop: cancelCurrentStream,
      onNewChat: startNewChat,
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
      startAnnotation,
      attachFullChatAnnotation,
      handleSend,
      cancelCurrentStream,
      startNewChat,
    ],
  );

  const chatColumnScroll = useMemo<ChatColumnScroll>(
    () => ({
      listRef,
      showScrollButton,
      isAtBottom,
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
      startNewChat,
    }),
    [
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
      startNewChat,
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

  const annotation = useMemo(
    () => ({
      active: Boolean(annotationTarget),
      requestId: annotationTarget?.id ?? null,
      start: startAnnotation,
      cancel: cancelAnnotation,
      submit: submitAnnotation,
    }),
    [annotationTarget, startAnnotation, cancelAnnotation, submitAnnotation],
  );

  const runtime = useMemo(
    () => ({
      conversation,
      composer,
      scroll: chatColumnScroll,
      annotation,
      cloudConversation,
      showHomeContent,
      dismissHome,
      showHome,
    }),
    [
      conversation,
      composer,
      chatColumnScroll,
      annotation,
      cloudConversation,
      showHomeContent,
      dismissHome,
      showHome,
    ],
  );

  return { runtime, messages: displayMessages };
}
