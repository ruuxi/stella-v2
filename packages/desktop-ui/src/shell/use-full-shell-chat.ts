import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { deriveComposerState } from "@/features/chat/composer-context";
import { conversationTabs } from "@/features/chat/services/conversation-tabs-store";
import { useConversationActivity } from "@/features/chat/hooks/use-conversation-activity";
import { useConversationDisplayMessages } from "@/features/chat/hooks/use-conversation-display-messages";
import { useConversationFiles } from "@/features/chat/hooks/use-conversation-files";
import { useConversationMessages } from "@/features/chat/hooks/use-conversation-messages";
import {
  useComposerMessageSelector,
  useComposerMessageStore,
} from "@/features/chat/hooks/use-composer-message-state";
import { takePendingComposerDraft } from "@/global/onboarding/chat/pending-handoff";
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
import { useChatStore } from "@/context/chat-store-context";
import { useCloudChatBridge } from "@/features/cloud/use-cloud-chat-bridge";
import { usePiChat } from "@/features/chat/pi/use-pi-chat";
import { useTranscriptSourceHandoff } from "./use-transcript-source-handoff";
import {
  journaledPiTurns,
  piAgentActivityEvents,
  piPendingRows,
} from "@/features/chat/pi/pi-chat-records";
import { getDeviceIdOrNull } from "@/platform/electron/device";
import { cloudAttachmentsStore } from "@/features/cloud/cloud-composer-store";
import { useOwnDeviceRemoteCancel } from "@/features/cloud/use-own-device-remote-cancel";
import { useCloudConversationSession } from "@/global/auth/hooks/use-cloud-conversation-session";
import { acceptedUserMessageIds } from "@/features/chat/lib/accepted-user-message-ids";
import type { LegendListRef } from "@legendapp/list/react";
import type { EventRecord } from "@stella/contracts/local-chat";
import type { StreamingAssistantOverlay } from "@/features/chat/streaming/streaming-types";
import type { ChatContext } from "@/shared/types/electron";

type TabComposerMemory = {
  message: string;
  chatContext: ChatContext | null;
  selectedText: string | null;
};
type TabScrollMemory = { scrollTop: number; followingLatest: boolean };
const MAX_RETAINED_TAB_STATE = 20;
/**
 * How long, after opening/switching into a conversation that lands at the
 * bottom, to keep re-pinning to the true end while late-rendering content
 * (agent cards, activity cards, images) settles and grows the scroll height.
 */
const OPEN_BOTTOM_SETTLE_MS = 600;
// Frames the height must hold still before an opening chat is shown.
const OPEN_BOTTOM_STABLE_FRAMES = 3;
const NO_NEWER_CLOUD_MESSAGES = () => false;
const EMPTY_STREAMING_ASSISTANTS: StreamingAssistantOverlay[] = [];
const EMPTY_EVENTS: EventRecord[] = [];
const NO_JOURNALED_TURNS: ReturnType<typeof journaledPiTurns> = new Map();
const NO_PI_PENDING_ROWS: ReturnType<typeof piPendingRows> = {
  messages: [],
  journalUserIds: new Map(),
};
const useOwnDeviceId = (enabled: boolean) => {
  const [deviceId, setDeviceId] = useState<string | null>(null);
  useEffect(() => {
    if (!enabled) return undefined;
    let cancelled = false;
    void getDeviceIdOrNull().then((next) => {
      if (!cancelled) setDeviceId(next);
    });
    return () => {
      cancelled = true;
    };
  }, [enabled]);
  return enabled ? deviceId : null;
};
const hasNonWhitespaceText = (text: string) => text.trim().length > 0;
const setBoundedTabMemory = <T>(
  memory: Map<string, T>,
  conversationId: string,
  value: T,
) => {
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
}: {
  conversationId: string | null;
  list: Pick<LegendListRef, "getScrollableNode"> | null;
  scrollMemory: Map<string, TabScrollMemory>;
  getIsFollowing: () => boolean;
  isConversationOpen: (conversationId: string) => boolean;
}) => {
  // Resolve Legend's DOM node while its internal ref is still mounted. During
  // layout cleanup the list handle can remain non-null after that internal ref
  // has already been cleared, making a late getScrollableNode() call throw.
  let element: ReturnType<LegendListRef["getScrollableNode"]> | null = null;
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
export function useFullShellChat({
  activeConversationId,
  isOnChatRoute,
  traceEnabled,
}: {
  activeConversationId: string | null;
  isOnChatRoute: boolean;
  traceEnabled: boolean;
}) {
  const { cloudFeaturesEnabled, isLocalStorage, storageMode } = useChatStore();
  const { accountScope } = useCloudConversationSession();
  // Message state + always-current mirror ref, synced at WRITE time. The
  // dictate-and-submit commit is rAF-deferred and can fire before React
  // flushes the render that carries the appended transcript — a ref synced in
  // the render body would still hold the pre-transcript text at that point,
  // so the send would go out empty (and silently no-op), leaving the
  // transcript sitting in the composer unsent. See use-composer-message-state.
  //
  // The text lives in a store rather than this hook's state: this hook owns
  // the whole chat runtime, so state here re-rendered the provider and every
  // runtime consumer (root chrome, sidebars, bridges) on each keystroke. Only
  // the composer leaf subscribes to the text; this hook reads derived facts.
  const {
    store: composerMessageStore,
    setMessage,
    messageRef: latestMessageRef,
  } = useComposerMessageStore();
  const hasComposerText = useComposerMessageSelector(
    composerMessageStore,
    hasNonWhitespaceText,
  );
  const [composerFocusRequestId, setComposerFocusRequestId] = useState(0);
  const { chatContext, setChatContext, selectedText, setSelectedText } =
    useCapturedChatContext();
  const composerMemoryByConversationRef = useRef(
    new Map<string, TabComposerMemory>(),
  );
  const scrollMemoryByConversationRef = useRef(
    new Map<string, TabScrollMemory>(),
  );
  const activeConversationIdRef = useRef(activeConversationId);
  activeConversationIdRef.current = activeConversationId;
  const previousComposerConversationIdRef = useRef<string | null>(
    activeConversationId,
  );
  const restoredConversationScrollRef = useRef<string | null>(null);
  const [settledScrollConversationId, setSettledScrollConversationId] =
    useState<string | null>(null);
  const markScrollSettled = useCallback((conversationId: string | null) => {
    setSettledScrollConversationId((current) =>
      current === conversationId ? current : conversationId,
    );
  }, []);
  // Text the onboarding hand-off asked to submit as soon as the composer can.
  const pendingAutoSendTextRef = useRef<string | null>(null);
  // Auth scope is a hard renderer privacy boundary. Clear composer content,
  // attachment handles, and per-tab memories in a layout effect so no frame
  // can paint the previous owner's unsent text during identity bootstrap.
  // Keyed on the scope it last cleared for: Fast Refresh re-runs every effect
  // of an edited component, and an applied renderer change must not wipe the
  // same owner's unsent text.
  const clearedForScopeRef = useRef<string | null>(null);
  useLayoutEffect(() => {
    const scope = `${accountScope}\0${storageMode}`;
    if (clearedForScopeRef.current === scope) return;
    clearedForScopeRef.current = scope;
    composerMemoryByConversationRef.current.clear();
    scrollMemoryByConversationRef.current.clear();
    previousComposerConversationIdRef.current = null;
    restoredConversationScrollRef.current = null;
    setMessage("");
    setChatContext(null);
    setSelectedText(null);
    cloudAttachmentsStore.clear();
  }, [accountScope, storageMode, setChatContext, setMessage, setSelectedText]);
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
      // First-run onboarding can leave a draft for the first conversation:
      // the starter the user tapped, or what they typed to skip ahead. It
      // never overrides a tab's own remembered text.
      const pendingDraft = remembered?.message
        ? null
        : takePendingComposerDraft();
      // Arm the hand-off before writing the text so the auto-send readiness
      // subscription below observes both in the same store notification.
      pendingAutoSendTextRef.current = pendingDraft?.send
        ? pendingDraft.text
        : null;
      setMessage(remembered?.message ?? pendingDraft?.text ?? "");
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
  const localMessageFeed = useConversationMessages(
    activeConversationId ?? undefined,
  );
  const { messages: localPersistedMessages } = localMessageFeed;
  const localActivityFeed = useConversationActivity(
    activeConversationId ?? undefined,
  );
  const { activities: localActivities } = localActivityFeed;
  const localFileFeed = useConversationFiles(activeConversationId ?? undefined);
  const { files: localPersistedFiles } = localFileFeed;
  const { records: threadActivityRecords } = useThreadActivity(
    activeConversationId ?? undefined,
  );
  const {
    taskDecorations: localTaskDecorations,
    optimisticEvents: localOptimisticEvents,
    acknowledgeMessages: acknowledgeLocalMessages,
    admissionSettledIds: localAdmissionSettledIds,
    runtimeStatusText: localRuntimeStatusText,
    isCompacting: localIsCompacting,
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
  // The chat runs on pi-durable in the runtime unless the engine is Claude
  // Code. A conversation stored in the cloud shows its journal whatever the
  // engine, so a model pick never changes what the chat shows; pi adds what
  // the journal does not hold yet. One kept on this computer shows pi's
  // transcript on pi and the chat log otherwise.
  const piChat = usePiChat(activeConversationId, {
    transcript: !cloudFeaturesEnabled,
  });
  const piTranscript = piChat.enabled && !cloudFeaturesEnabled;
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
  // On pi the transcript and its agents are the conversation's record:
  // Activity lists the agents, Files the links in replies and agents' results.
  const piActivities = useMemo(
    () =>
      piChat.enabled
        ? piAgentActivityEvents(threadActivityRecords)
        : EMPTY_EVENTS,
    [piChat.enabled, threadActivityRecords],
  );
  const piFiles = useMemo(
    () =>
      piChat.enabled
        ? [
            ...piChat.replyFiles,
            ...piActivities.filter((event) => event.type === "agent-completed"),
          ].sort((a, b) => a.timestamp - b.timestamp)
        : EMPTY_EVENTS,
    [piChat.enabled, piChat.replyFiles, piActivities],
  );
  const journalState = cloudChat.conversation.state;
  const ownDeviceId = useOwnDeviceId(piChat.enabled && cloudFeaturesEnabled);
  const journaledTurns = useMemo(
    () =>
      piChat.enabled && cloudFeaturesEnabled
        ? journaledPiTurns(
            cloudChat.records,
            piChat.projection.turns,
            ownDeviceId,
          )
        : NO_JOURNALED_TURNS,
    [
      cloudChat.records,
      cloudFeaturesEnabled,
      ownDeviceId,
      piChat.enabled,
      piChat.projection.turns,
    ],
  );
  const journalHasOlder = journalState.hasOlder;
  const journalStartMs = cloudChat.records[0]?.createdAtMs ?? null;
  const piPending = useMemo(() => {
    if (!piChat.enabled || !cloudFeaturesEnabled) return NO_PI_PENDING_ROWS;
    if (journalState.recordsSource === "none") return NO_PI_PENDING_ROWS;
    if (journalHasOlder && journalStartMs === null) return NO_PI_PENDING_ROWS;
    return piPendingRows({
      projection: piChat.projection,
      journaled: journaledTurns,
      canonical: cloudChat.persistedMessages,
      sinceMs: journalHasOlder ? journalStartMs : null,
    });
  }, [
    cloudChat.persistedMessages,
    cloudFeaturesEnabled,
    journalHasOlder,
    journalStartMs,
    journalState.recordsSource,
    journaledTurns,
    ownDeviceId,
    piChat.enabled,
    piChat.projection,
  ]);
  const journalMessages = useMemo(
    () =>
      piPending.messages.length > 0
        ? [...cloudChat.persistedMessages, ...piPending.messages]
        : cloudChat.persistedMessages,
    [cloudChat.persistedMessages, piPending.messages],
  );
  const journalUserId = useCallback(
    (userMessageId: string) =>
      piPending.journalUserIds.get(userMessageId) ?? userMessageId,
    [piPending.journalUserIds],
  );
  const piStreamingAssistants = useMemo(
    () =>
      piPending.journalUserIds.size === 0
        ? piChat.streamingAssistants
        : piChat.streamingAssistants.map((overlay) => {
            const userMessageId = journalUserId(overlay.userMessageId);
            return userMessageId === overlay.userMessageId
              ? overlay
              : { ...overlay, userMessageId };
          }),
    [journalUserId, piChat.streamingAssistants, piPending.journalUserIds],
  );
  // `ready` names the head before its replay arrives: the journal is current
  // once its rows reach that head.
  const journalReady = cloudFeaturesEnabled
    ? (journalState.recordsSource === "canonical" &&
        (journalState.records.at(-1)?.seq ?? -1) >= journalState.headSeq) ||
      journalState.status === "offline" ||
      journalState.status === "blocked"
    : !localMessageFeed.isInitialLoading;
  // A conversation kept on this computer moves between pi's transcript and
  // the chat log with the engine; the screen keeps the transcript it shows
  // until the incoming source is current.
  const transcript = useTranscriptSourceHandoff({
    conversationId: activeConversationId,
    source: piTranscript ? "pi" : "journal",
    ready: piTranscript ? piChat.isSynced : journalReady,
    transcript: {
      messages: piTranscript ? piChat.messages : journalMessages,
      activities: piChat.enabled ? piActivities : cloudChat.activities,
      files: piChat.enabled ? piFiles : cloudChat.files,
    },
  });
  const persistedMessages = transcript.messages;
  // Cloud placement can acknowledge IPC before its journal reaches this
  // window. Keep pending sends working until canonical history takes over,
  // and retire their overlays even when no SQLite write occurs on this device.
  useEffect(() => {
    acknowledgeLocalMessages(persistedMessages);
  }, [acknowledgeLocalMessages, persistedMessages, localOptimisticEvents]);
  const awaitingMessageAdmission = useMemo(() => {
    const persistedIds = acceptedUserMessageIds(persistedMessages);
    return localOptimisticEvents.some(
      (event) =>
        event.type === "user_message" &&
        !persistedIds.has(event._id) &&
        !localAdmissionSettledIds.has(event._id),
    );
  }, [localAdmissionSettledIds, localOptimisticEvents, persistedMessages]);
  const activities = transcript.activities;
  const persistedFiles = transcript.files;
  const tasks = cloudChat.tasks;
  const optimisticEvents = cloudChat.isWebShell
    ? cloudChat.optimisticEvents
    : localOptimisticEvents;
  // The web shell has no in-memory overlay: a cloud reply becomes visible when
  // its journal row commits, not before.
  const streamingAssistants = piChat.enabled
    ? piStreamingAssistants
    : cloudChat.isWebShell
      ? EMPTY_STREAMING_ASSISTANTS
      : localStreamingAssistants;
  // Desktop placement stops owning a run when the cloud accepts it.
  // Follow the canonical turn while no local execution owns the controls.
  // Remember the canonical turn this window executed. Its live-clear frame
  // can lag local completion; falling back to it would resurrect the dots.
  const locallyOwnedCloudTurnRef = useRef<string | null>(null);
  const cloudLiveTurnId = cloudChat.conversation.state.live?.turnId ?? null;
  useLayoutEffect(() => {
    if (
      localIsStreaming &&
      cloudLiveTurnId &&
      (localHasToolActivity || localAnswerLanded)
    ) {
      locallyOwnedCloudTurnRef.current = cloudLiveTurnId;
    }
  }, [
    localIsStreaming,
    cloudLiveTurnId,
    localHasToolActivity,
    localAnswerLanded,
  ]);
  const localTurnHandedOff =
    !localIsStreaming &&
    Boolean(cloudLiveTurnId) &&
    locallyOwnedCloudTurnRef.current === cloudLiveTurnId;
  const useCloudRun =
    cloudChat.isWebShell || (!localIsStreaming && cloudChat.isStreaming);
  const runtimeStatusText = piChat.enabled
    ? piChat.runtimeStatusText
    : useCloudRun
      ? cloudChat.runtimeStatusText
      : localRuntimeStatusText;
  const isCompacting = piChat.enabled
    ? piChat.isCompacting
    : useCloudRun
      ? false
      : localIsCompacting;
  const activeToolCallId = piChat.enabled
    ? piChat.activeToolCallId
    : useCloudRun
      ? cloudChat.activeToolCallId
      : localActiveToolCallId;
  const activeToolName = piChat.enabled
    ? piChat.activeToolName
    : useCloudRun
      ? localTurnHandedOff
        ? null
        : cloudChat.activeToolName
      : localActiveToolName;
  const latestCompletedTool =
    useCloudRun || piChat.enabled ? null : localLatestCompletedTool;
  const hasToolActivity = piChat.enabled
    ? piChat.hasToolActivity
    : useCloudRun
      ? Boolean(cloudChat.activeToolName)
      : localHasToolActivity;
  const isToolActive = piChat.enabled
    ? piChat.isToolActive
    : useCloudRun
      ? Boolean(activeToolName)
      : localIsToolActive;
  const reasoningText = useCloudRun || piChat.enabled ? "" : localReasoningText;
  const isStreaming = piChat.enabled
    ? piChat.isStreaming || awaitingMessageAdmission
    : cloudChat.isStreaming || localIsStreaming || awaitingMessageAdmission;
  // The committed reply hands off before the terminal turn frame arrives.
  const answerLanded =
    !awaitingMessageAdmission &&
    (piChat.enabled
      ? piChat.answerLanded
      : useCloudRun
        ? cloudChat.answerLanded || localTurnHandedOff
        : localAnswerLanded);
  const pendingUserMessageId = piChat.enabled
    ? piChat.pendingUserMessageId && journalUserId(piChat.pendingUserMessageId)
    : cloudChat.isWebShell
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
  const cancelCurrentStream = piChat.enabled
    ? piChat.cancelCurrentStream
    : useCloudRun
      ? cloudChat.cancelCurrentStream
      : localCancelCurrentStream;
  // Page only the selected history; local and cloud cursors never mix.
  const hasOlderMessages = piTranscript
    ? piChat.hasOlderMessages
    : storageMode === "local"
      ? localMessageFeed.hasOlderMessages
      : cloudChat.conversation.state.hasOlder;
  const hasNewerMessages =
    storageMode === "local" && !piTranscript
      ? localMessageFeed.hasNewerMessages
      : false;
  const isLoadingOlderMessages = piTranscript
    ? piChat.isLoadingOlder
    : storageMode === "local"
      ? localMessageFeed.isLoadingOlder
      : cloudChat.conversation.state.loadingOlder;
  const isLoadingNewerMessages =
    storageMode === "local" && !piTranscript
      ? localMessageFeed.isLoadingNewer
      : false;
  const isInitialLoadingMessages = transcript.holding
    ? false
    : piTranscript
      ? piChat.isInitialLoading
      : storageMode === "local"
        ? localMessageFeed.isInitialLoading
        : cloudChat.isInitialLoading;
  const loadOlderMessages = piTranscript
    ? piChat.loadOlderMessages
    : storageMode === "local"
      ? localMessageFeed.loadOlder
      : cloudChat.conversation.loadOlder;
  const loadNewerMessages =
    storageMode === "local" && !piTranscript
      ? localMessageFeed.loadNewer
      : NO_NEWER_CLOUD_MESSAGES;
  const loadLatestMessages =
    storageMode === "local" && !piTranscript
      ? localMessageFeed.loadLatest
      : NO_NEWER_CLOUD_MESSAGES;
  const hasOlderActivity =
    storageMode === "local"
      ? localActivityFeed.hasOlderActivity
      : cloudChat.hasOlderActivity;
  const isLoadingOlderActivity =
    storageMode === "local"
      ? localActivityFeed.isLoadingOlder
      : cloudChat.isLoadingOlderActivity;
  const loadOlderActivity =
    storageMode === "local"
      ? localActivityFeed.loadOlder
      : cloudChat.loadOlderActivity;
  // Older replies' files come with the transcript's older pages.
  const hasOlderFiles = piChat.enabled
    ? piChat.hasOlderMessages
    : storageMode === "local"
      ? localFileFeed.hasOlderFiles
      : cloudChat.conversation.state.hasOlder;
  const isLoadingOlderFiles = piChat.enabled
    ? piChat.isLoadingOlder
    : storageMode === "local"
      ? localFileFeed.isLoadingOlder
      : cloudChat.conversation.state.loadingOlder;
  const loadOlderFiles = piChat.enabled
    ? piChat.loadOlderMessages
    : storageMode === "local"
      ? localFileFeed.loadOlder
      : cloudChat.conversation.loadOlder;
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
  // (explicit opt-in) rather than a build-mode flag, so the array stays empty
  // unless someone asked for tracing.
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
    getShouldFollowSend,
    getIsEffectivelyAtBottom,
    showScrollButton,
    scrollToBottom,
    releaseFollow,
    followAfterSend,
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
      isConversationOpen: (id: string) =>
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
      if (restoredConversationScrollRef.current === activeConversationId) {
        markScrollSettled(activeConversationId);
      }
      return;
    }
    const conversationId = activeConversationId;
    let settleRaf: number | null = null;
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
        markScrollSettled(conversationId);
      } else {
        scrollToBottom("instant");
        // Agent cards, activity cards, and images near the bottom can
        // mount/settle a beat AFTER this initial pin, growing the scroll
        // height so the "bottom" we just landed on is now above the real
        // one — tab switches that land slightly above the true bottom.
        // Keep re-pinning to the end through that post-open settling
        // (until the height stops changing, a short window elapses, or
        // the user takes over) so we always end at the actual bottom.
        //
        // The timeline stays hidden (`isOpeningScroll`) until the height has
        // held still for a few frames, so a reload or relaunch shows the
        // chat already at the bottom instead of drawing it at the top and
        // then scrolling down.
        let lastHeight = element ? element.scrollHeight : 0;
        let stableFrames = 0;
        const deadline = performance.now() + OPEN_BOTTOM_SETTLE_MS;
        const settle = () => {
          settleRaf = null;
          const node = listRef.current?.getScrollableNode();
          // Bail once the user has scrolled away — never yank them back.
          if (!node || !getIsFollowing()) {
            markScrollSettled(conversationId);
            return;
          }
          if (node.scrollHeight !== lastHeight) {
            lastHeight = node.scrollHeight;
            stableFrames = 0;
            void listRef.current?.scrollToEnd({ animated: false });
          } else if (++stableFrames === OPEN_BOTTOM_STABLE_FRAMES) {
            markScrollSettled(conversationId);
          }
          if (performance.now() < deadline) {
            settleRaf = window.requestAnimationFrame(settle);
          } else {
            markScrollSettled(conversationId);
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
    markScrollSettled,
    scrollToBottom,
  ]);
  const isOpeningScroll =
    Boolean(activeConversationId) &&
    displayMessages.length > 0 &&
    settledScrollConversationId !== activeConversationId;
  const handleSend = useCallback(async () => {
    // Follow the send to the bottom whenever the freshest turn is on
    // screen — near/at bottom OR meaningfully scrolled up but still within
    // the 300px send gate. `getIsEffectivelyAtBottom` is distance-based
    // (latch-independent), so a stray upward nudge near the bottom still
    // follows. Only a genuine read-history position (neither) stays put.
    //
    // While a stream is already in flight, the send queues as a follow-up
    // chip at the keyed tail of the event list (not yet a sent user row).
    // That item is the end of content too, so the same follow frames it.
    const shouldFollowSend =
      showHomeContent || getIsEffectivelyAtBottom() || getShouldFollowSend();
    const submittedConversationId = activeConversationId;
    const submittedMessage = latestMessageRef.current;
    const submittedSelectedText = selectedText;
    const submittedChatContext = chatContext;
    const submittedFromHome = showHomeContent;
    const accepted = await sendMessage({
      text: submittedMessage,
      selectedText: submittedSelectedText,
      chatContext: submittedChatContext,
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
      onOptimisticStart: () => {
        if (activeConversationIdRef.current !== submittedConversationId) return;
        enterChatSurfaceForInteraction();
        resetIdleTimer();
        // Follow the optimistic row before runtime acceptance. Waiting for
        // sendMessage here makes the viewport lag behind the visible message.
        if (shouldFollowSend) {
          followAfterSend();
        } else if (!isStreaming) {
          releaseFollow();
        }
      },
      onRestore: () => {
        if (activeConversationIdRef.current !== submittedConversationId) {
          if (submittedConversationId) {
            const remembered: Partial<TabComposerMemory> =
              composerMemoryByConversationRef.current.get(
                submittedConversationId,
              ) ?? {};
            setBoundedTabMemory(
              composerMemoryByConversationRef.current,
              submittedConversationId,
              {
                message: remembered.message || submittedMessage,
                selectedText: remembered.selectedText ?? submittedSelectedText,
                chatContext: remembered.chatContext ?? submittedChatContext,
              },
            );
          }
          return;
        }
        const shouldRestoreHome =
          submittedFromHome && !latestMessageRef.current;
        setMessage((current) => current || submittedMessage);
        setSelectedText((current) => current ?? submittedSelectedText);
        setChatContext((current) => current ?? submittedChatContext);
        if (shouldRestoreHome) showHome();
      },
    });
    if (
      !accepted ||
      activeConversationIdRef.current !== submittedConversationId
    ) {
      return;
    }
    if (submittedFromHome) {
      setComposerFocusRequestId((id) => id + 1);
    }
  }, [
    activeConversationId,
    chatContext,
    enterChatSurfaceForInteraction,
    getIsFollowing,
    getShouldFollowSend,
    getIsEffectivelyAtBottom,
    isStreaming,
    latestMessageRef,
    followAfterSend,
    releaseFollow,
    resetIdleTimer,
    selectedText,
    sendMessage,
    setChatContext,
    setMessage,
    setSelectedText,
    showHome,
    showHomeContent,
  ]);
  const { canSubmit } = deriveComposerState({
    hasMessage: hasComposerText,
    chatContext,
    selectedText,
    conversationId: activeConversationId,
    requireConversationId: true,
  });
  // Submit the onboarding hand-off once the composer is live with that exact
  // text. A rejected send restores the text through the normal path, so the
  // user still sees their draft rather than losing it.
  const autoSendDraftReady = useComposerMessageSelector(
    composerMessageStore,
    (text) =>
      pendingAutoSendTextRef.current !== null &&
      text === pendingAutoSendTextRef.current,
  );
  useEffect(() => {
    const text = pendingAutoSendTextRef.current;
    if (!text || !canSubmit || isStreaming) return;
    if (latestMessageRef.current !== text) return;
    pendingAutoSendTextRef.current = null;
    void handleSend();
  }, [
    autoSendDraftReady,
    canSubmit,
    handleSend,
    isStreaming,
    latestMessageRef,
  ]);
  // Per-conversation model selection: mirror the global model preferences
  // to whichever conversation is active so each tab remembers its own
  // engine/model/reasoning pick. Cloud and local conversations both retain
  // their own selection while sharing the same global picker surface.
  useConversationModelSelection({
    activeConversationId,
    enabled: true,
  });
  const chatColumnConversation = useMemo(
    () => ({
      conversationId: activeConversationId,
      tasks,
      extraTail: cloudChat.extraTail,
      activity: {
        activities,
        // pi's agents come whole: there is no older activity to page in.
        hasOlder: piChat.enabled ? false : hasOlderActivity,
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
        isCompacting,
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
      piChat.enabled,
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
      isCompacting,
      isStreaming,
      answerLanded,
      isToolActive,
    ],
  );
  const chatColumnComposer = useMemo(
    () => ({
      messageStore: composerMessageStore,
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
      composerMessageStore,
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
      isOpeningScroll,
    }),
    [
      isOpeningScroll,
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
      showHomeContent,
      dismissHome,
      showHome,
    }),
    [
      conversation,
      composer,
      chatColumnScroll,
      showHomeContent,
      dismissHome,
      showHome,
    ],
  );
  return { runtime, messages: displayMessages };
}
