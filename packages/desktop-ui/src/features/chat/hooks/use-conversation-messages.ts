/**
 * Hook that returns the windowed list of visible chat messages for a
 * conversation. Successor to the message-rendering half of
 * `useConversationEventFeed`: the chat timeline now reads `MessageRecord[]`
 * (each assistant message carrying its turn's tool/agent-completed
 * events) instead of walking a flat event stream.
 *
 * The first page is the newest `MESSAGE_PAGE_SIZE` messages. Older pages
 * are requested through `listMessagesBefore` and prepended in the
 * renderer cache — the subscription stays keyed on the initial page size
 * so growing history does not tear down the live-update listener or
 * re-group the already-painted tail.
 *
 * `hasOlderMessages` is whatever the store last observed: the latest
 * window (or prepended page) saturated its requested count. A short
 * conversation whose visible count happens to equal the page size can
 * still report true until the next prepend comes back empty.
 */
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useChatStore } from "@/context/chat-store-context";
import {
  requestOlderLocalMessages,
  subscribeToLocalMessageWindow,
  trimLocalMessageWindowToNewestPage,
  type LocalMessageWindowSnapshot,
} from "@/features/chat/services/local-message-store";
import {
  stabilizeMessageList,
  type StableMessageListState,
} from "@/features/chat/lib/stable-rows";
import { showToast } from "@/ui/toast";
import type { MessageRecord } from "@stella/contracts/local-chat";

export const MESSAGE_PAGE_SIZE = 200;
/**
 * Soft ceiling on how far a single conversation window may grow in the
 * renderer. The virtualizer already bounds mounted DOM; this only keeps
 * `useEventRows` from walking every historical tool event after a very
 * long upward scroll. The previous 1000-message cap made Rahul's 1593-
 * message conversation look exhausted after five pages.
 */
export const MAX_VISIBLE_MESSAGES = 2_400;
const LOCAL_MESSAGE_LOAD_RETRY_MS = 300;

/**
 * Window decay: once older pages have been prepended, drop back to the
 * newest page after every chat surface has sat at the bottom for this
 * long. The grown window only exists to serve a scroll-up that's no
 * longer happening. A later upward gesture simply re-pages.
 */
const WINDOW_DECAY_AT_REST_MS = 90_000;
const WINDOW_DECAY_CHECK_INTERVAL_MS = 5_000;

/**
 * At-rest probes registered by chat scroll surfaces (full chat, sidebar —
 * each `useChatScrollManagement` instance). The window decays only while
 * *every* registered surface reports it is at the bottom, so a sidebar
 * scrolled deep into history is never yanked because the full chat
 * happens to be at rest. No registered surfaces means no decay.
 */
const chatAtRestProbes = new Set<() => boolean>();

export const registerChatAtRestProbe = (probe: () => boolean): (() => void) => {
  chatAtRestProbes.add(probe);
  return () => {
    chatAtRestProbes.delete(probe);
  };
};

const allChatSurfacesAtRest = (): boolean => {
  if (chatAtRestProbes.size === 0) return false;
  for (const probe of chatAtRestProbes) {
    if (!probe()) return false;
  }
  return true;
};

const EMPTY_MESSAGES: MessageRecord[] = [];

const EMPTY_SNAPSHOT: LocalMessageWindowSnapshot = {
  window: { messages: EMPTY_MESSAGES, visibleMessageCount: 0 },
  hasLoaded: false,
  error: null,
  hasOlder: false,
  loadingOlder: false,
};

export type ConversationMessagesFeed = {
  messages: MessageRecord[];
  hasOlderMessages: boolean;
  isLoadingOlder: boolean;
  isInitialLoading: boolean;
  loadOlder: () => boolean;
};

export const useConversationMessages = (
  conversationId?: string,
): ConversationMessagesFeed => {
  const { storageMode } = useChatStore();
  const isLocalMode = storageMode === "local";

  const visitKey = `${storageMode}:${conversationId ?? ""}`;
  const visitToken = useMemo(() => Symbol(visitKey), [visitKey]);

  const [snapshotState, setSnapshotState] = useState<{
    visitToken: symbol;
    snapshot: LocalMessageWindowSnapshot;
  }>({
    visitToken,
    snapshot: EMPTY_SNAPSHOT,
  });
  const lastLocalLoadToastAtRef = useRef(0);
  const [localRetryTick, setLocalRetryTick] = useState(0);
  const inFlightRef = useRef(false);

  useEffect(() => {
    inFlightRef.current = false;
  }, [visitToken]);

  useEffect(() => {
    if (!isLocalMode || !conversationId) {
      setSnapshotState({
        visitToken,
        snapshot: {
          window: { messages: EMPTY_MESSAGES, visibleMessageCount: 0 },
          hasLoaded: true,
          error: null,
          hasOlder: false,
          loadingOlder: false,
        },
      });
      return;
    }

    let cancelled = false;
    let retryTimer: number | null = null;
    const scheduleRetry = () => {
      if (cancelled || retryTimer !== null) return;
      retryTimer = window.setTimeout(() => {
        retryTimer = null;
        if (!cancelled) {
          setLocalRetryTick((current) => current + 1);
        }
      }, LOCAL_MESSAGE_LOAD_RETRY_MS);
    };
    const unsubscribe = subscribeToLocalMessageWindow(
      { conversationId, maxVisibleMessages: MESSAGE_PAGE_SIZE },
      (snapshot) => {
        if (cancelled) return;
        if (retryTimer !== null) {
          window.clearTimeout(retryTimer);
          retryTimer = null;
        }
        setSnapshotState({ visitToken, snapshot });
        if (!snapshot.error) return;
        const now = Date.now();
        if (now - lastLocalLoadToastAtRef.current > 10_000) {
          lastLocalLoadToastAtRef.current = now;
          showToast({
            title: "Couldn’t load chat history",
            description:
              snapshot.error.message || "Stella will retry in a moment.",
            variant: "error",
          });
        }
        scheduleRetry();
      },
    );
    return () => {
      cancelled = true;
      if (retryTimer !== null) {
        window.clearTimeout(retryTimer);
      }
      unsubscribe();
    };
  }, [conversationId, isLocalMode, localRetryTick, visitToken]);

  const activeSnapshot =
    snapshotState.visitToken === visitToken
      ? snapshotState.snapshot
      : EMPTY_SNAPSHOT;

  const liveMessages = activeSnapshot.window.messages;

  // Reuse prior `MessageRecord` references whenever id + payload + tool
  // event ids match, so `useEventRows` downstream stays bailout-eligible
  // across update ticks. See `stable-rows.ts:stabilizeMessageList`.
  const stableMessagesRef = useRef<StableMessageListState | null>(null);
  const stableMessagesState = useMemo(
    () => stabilizeMessageList(liveMessages, stableMessagesRef.current),
    [liveMessages],
  );
  stableMessagesRef.current = stableMessagesState;
  const messages = stableMessagesState.result;
  const visibleMessageCount = activeSnapshot.window.visibleMessageCount;

  const hasOlderMessages =
    activeSnapshot.hasLoaded &&
    (activeSnapshot.hasOlder ??
      visibleMessageCount >= MESSAGE_PAGE_SIZE) &&
    visibleMessageCount < MAX_VISIBLE_MESSAGES;

  const isLoadingOlder = Boolean(activeSnapshot.loadingOlder);

  const loadOlder = useCallback(() => {
    if (!conversationId || !isLocalMode) return false;
    if (!hasOlderMessages) return false;
    if (inFlightRef.current || activeSnapshot.loadingOlder) return false;
    inFlightRef.current = true;
    void requestOlderLocalMessages(conversationId, MESSAGE_PAGE_SIZE).finally(
      () => {
        inFlightRef.current = false;
      },
    );
    return true;
  }, [
    activeSnapshot.loadingOlder,
    conversationId,
    hasOlderMessages,
    isLocalMode,
  ]);

  // Decay the grown window back to one page once every chat surface has
  // been at the bottom continuously for the rest interval. At the bottom
  // the visible rows are the newest page, so dropping the older prefix
  // changes nothing on screen (the virtualized list holds its end
  // anchor). Re-subscribing at the page size seeds from the retained
  // newest-200 projection.
  const windowGrown = visibleMessageCount > MESSAGE_PAGE_SIZE;
  useEffect(() => {
    if (!windowGrown || !isLocalMode || !conversationId) return;
    if (activeSnapshot.loadingOlder) return;
    let atRestSince: number | null = null;
    const interval = window.setInterval(() => {
      if (!allChatSurfacesAtRest()) {
        atRestSince = null;
        return;
      }
      const now = Date.now();
      atRestSince ??= now;
      if (now - atRestSince < WINDOW_DECAY_AT_REST_MS) return;
      window.clearInterval(interval);
      trimLocalMessageWindowToNewestPage(conversationId, MESSAGE_PAGE_SIZE);
    }, WINDOW_DECAY_CHECK_INTERVAL_MS);
    return () => {
      window.clearInterval(interval);
    };
  }, [
    activeSnapshot.loadingOlder,
    conversationId,
    isLocalMode,
    visitToken,
    windowGrown,
  ]);

  const isInitialLoading =
    Boolean(conversationId) &&
    isLocalMode &&
    !activeSnapshot.hasLoaded &&
    activeSnapshot.window.messages.length === 0;

  return {
    messages,
    hasOlderMessages,
    isLoadingOlder,
    isInitialLoading,
    loadOlder,
  };
};
