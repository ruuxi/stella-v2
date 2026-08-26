import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useSyncExternalStore,
} from "react";
import type { MessageRecord } from "@stella/contracts/local-chat";
import {
  getLocalMessageTimelineSnapshot,
  loadLatestLocalMessages,
  loadNewerLocalMessages,
  loadOlderLocalMessages,
  retryLocalMessageTimeline,
  subscribeToLocalMessageTimeline,
  type MessageTimelineSnapshot,
} from "../services/local-message-timeline-store";
import {
  stabilizeMessageList,
  type StableMessageListState,
} from "../lib/stable-rows";

const INITIAL_RETRY_DELAY_MS = 250;
const MAX_RETRY_DELAY_MS = 4_000;

const EMPTY_LOCAL_SNAPSHOT: MessageTimelineSnapshot = {
  messages: [],
  hasLoaded: false,
  hasOlder: false,
  hasNewer: false,
  isLoadingOlder: false,
  isLoadingNewer: false,
  error: null,
};

export type ConversationMessagesState = {
  messages: MessageRecord[];
  hasOlderMessages: boolean;
  hasNewerMessages: boolean;
  isLoadingOlder: boolean;
  isLoadingNewer: boolean;
  isInitialLoading: boolean;
  loadOlder: () => false | Promise<boolean>;
  loadNewer: () => false | Promise<boolean>;
  loadLatest: () => false | Promise<boolean>;
};

export function useConversationMessages(
  conversationId: string | undefined,
): ConversationMessagesState {
  const subscribe = useCallback(
    (listener: () => void) => {
      if (!conversationId) return () => {};
      return subscribeToLocalMessageTimeline(conversationId, listener);
    },
    [conversationId],
  );
  const getSnapshot = useCallback(() => {
    if (!conversationId) return EMPTY_LOCAL_SNAPSHOT;
    return getLocalMessageTimelineSnapshot(conversationId);
  }, [conversationId]);
  const localSnapshot = useSyncExternalStore(
    subscribe,
    getSnapshot,
    () => EMPTY_LOCAL_SNAPSHOT,
  );

  const retryAttemptRef = useRef(0);
  const retryKey = conversationId ?? "";
  const retryKeyRef = useRef(retryKey);
  retryKeyRef.current = retryKey;
  useEffect(() => {
    retryAttemptRef.current = 0;
  }, [retryKey]);
  useEffect(() => {
    if (!conversationId || !localSnapshot.error) {
      return;
    }
    const attempt = retryAttemptRef.current++;
    const delay = Math.min(
      MAX_RETRY_DELAY_MS,
      INITIAL_RETRY_DELAY_MS * 2 ** attempt,
    );
    const timer = window.setTimeout(() => {
      const retry = retryLocalMessageTimeline(conversationId);
      if (retry instanceof Promise) {
        void retry.then((succeeded) => {
          if (succeeded && retryKeyRef.current === retryKey) {
            retryAttemptRef.current = 0;
          }
        });
      }
    }, delay);
    return () => window.clearTimeout(timer);
  }, [conversationId, localSnapshot.error, retryKey]);

  const rawMessages = localSnapshot.messages;
  const stableMessagesRef = useRef<StableMessageListState | null>(null);
  const stableMessagesKeyRef = useRef<string | null>(null);
  const stableMessagesKey = retryKey;
  if (stableMessagesKeyRef.current !== stableMessagesKey) {
    stableMessagesKeyRef.current = stableMessagesKey;
    stableMessagesRef.current = null;
  }
  const stableMessagesState = useMemo(
    () => stabilizeMessageList(rawMessages, stableMessagesRef.current),
    [rawMessages],
  );
  stableMessagesRef.current = stableMessagesState;
  const messages = stableMessagesState.result;

  const loadOlder = useCallback(() => {
    if (!conversationId) return false;
    return loadOlderLocalMessages(conversationId);
  }, [conversationId]);
  const loadNewer = useCallback(() => {
    if (!conversationId) return false;
    return loadNewerLocalMessages(conversationId);
  }, [conversationId]);
  const loadLatest = useCallback(() => {
    if (!conversationId) return false;
    return loadLatestLocalMessages(conversationId);
  }, [conversationId]);

  return useMemo(
    () => ({
      messages,
      hasOlderMessages: localSnapshot.hasOlder,
      hasNewerMessages: localSnapshot.hasNewer,
      isLoadingOlder: localSnapshot.isLoadingOlder,
      isLoadingNewer: localSnapshot.isLoadingNewer,
      isInitialLoading: Boolean(conversationId) && !localSnapshot.hasLoaded,
      loadOlder,
      loadNewer,
      loadLatest,
    }),
    [
      conversationId,
      loadLatest,
      loadNewer,
      loadOlder,
      localSnapshot.hasLoaded,
      localSnapshot.hasNewer,
      localSnapshot.hasOlder,
      localSnapshot.isLoadingNewer,
      localSnapshot.isLoadingOlder,
      messages,
    ],
  );
}
