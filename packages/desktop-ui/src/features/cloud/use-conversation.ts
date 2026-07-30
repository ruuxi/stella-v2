/**
 * The one hook the cloud chat surface consumes.
 *
 * It binds three things that arrive on different clocks — the conversation id
 * (a Convex query), the builder origin (another Convex query), and the socket
 * (a long-lived connection) — into a single snapshot, and owns the outbound
 * side: sending a turn, cancelling one, and paging backwards.
 *
 * Turn *starts* deliberately do not go over the socket. Quota, engine
 * resolution and turn-token minting live in Convex, and a socket verb would
 * be a way around all three.
 */

import { useCallback, useEffect, useMemo, useSyncExternalStore } from "react";
import {
  useMutation,
  useQueries,
  useQuery,
  type RequestForQueries,
} from "convex/react";
import { useCloudMode } from "@/global/auth/hooks/use-cloud-mode";
import { cloudApi } from "./cloud-api";
import {
  getCloudExecutionSelectionSnapshot,
  reconcileCloudExecutionSelection,
  subscribeCloudExecutionSelection,
} from "./cloud-execution-store";
import { useI18n } from "../../shared/i18n/I18nProvider";
import { cloudAttachmentsStore } from "./cloud-composer-store";
import { PROTOCOL_VERSION } from "./conversation-protocol";
import type { ConversationState } from "./conversation-store";
import {
  conversationStore,
  pendingPrompts,
  type PendingPrompt,
} from "./conversation-store";
import type { SocketStatus } from "./conversation-socket";

export type CloudRealtimeConfig = {
  /** Builder origin the socket connects to. Null disables realtime. */
  socketBaseUrl: string | null;
  /** False while the query is still in flight. */
  resolved: boolean;
};

const OFFLINE_CONFIG: CloudRealtimeConfig = {
  socketBaseUrl: null,
  resolved: false,
};

const UNSUPPORTED_CONFIG: CloudRealtimeConfig = {
  socketBaseUrl: null,
  resolved: true,
};

/**
 * `useQueries` rather than `useQuery` on purpose: this runs above the
 * `CloudBoundary`, and a deployment that does not have this function yet must
 * cost the user their cloud tail, not the whole shell.
 */
export const useCloudRealtimeConfig = (): CloudRealtimeConfig => {
  const { cloudMode } = useCloudMode();
  const request = useMemo<RequestForQueries>(() => {
    const queries: RequestForQueries = {};
    if (cloudMode) {
      queries.realtime = { query: cloudApi.getCloudRealtimeConfig, args: {} };
    }
    return queries;
  }, [cloudMode]);
  const results = useQueries(request);
  return useMemo(() => {
    if (!cloudMode) return OFFLINE_CONFIG;
    const value = results.realtime;
    if (value === undefined) return OFFLINE_CONFIG;
    if (value instanceof Error) return UNSUPPORTED_CONFIG;
    const config = value as { socketOrigin?: unknown; protocol?: unknown };
    // A deployment speaking a different wire version would only get as far as
    // a 4409 close. Not connecting at all is the same outcome without the
    // round trip, and it keeps the reason in one place.
    if (config.protocol !== PROTOCOL_VERSION) return UNSUPPORTED_CONFIG;
    return {
      socketBaseUrl:
        typeof config.socketOrigin === "string" && config.socketOrigin
          ? config.socketOrigin
          : null,
      resolved: true,
    };
  }, [cloudMode, results.realtime]);
};

const IDLE_STATE: ConversationState = {
  conversationId: "",
  status: "idle",
  statusMessage: null,
  statusRetryable: true,
  records: [],
  live: null,
  title: "",
  floorSeq: 0,
  hasOlder: false,
  loadingOlder: false,
  olderNotice: null,
};

const noopSubscribe = (): (() => void) => () => {};
const idleSnapshot = (): ConversationState => IDLE_STATE;
const noLocalExecution = (): null => null;

export type CloudConversationView = {
  state: ConversationState;
  status: SocketStatus;
  /** Optimistic prompts belonging to this conversation (or not yet placed). */
  pending: readonly PendingPrompt[];
  send: (prompt: string) => Promise<void>;
  retrySend: (clientMsgId: string) => Promise<void>;
  dismissSend: (clientMsgId: string) => void;
  /** False when the stop could not be delivered — the caller must say so. */
  cancelTurn: (turnId: string) => boolean;
  loadOlder: () => void;
  retryConnection: () => void;
};

const newClientMsgId = (): string =>
  typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;

export const useConversation = (
  conversationId: string | null,
  /** Applied to the prompt before it is sent (drive attachments, etc.). */
  decoratePrompt: (prompt: string) => string = (prompt) => prompt,
  onSent: () => void = () => {},
): CloudConversationView => {
  const config = useCloudRealtimeConfig();
  const { locale } = useI18n();
  const startTurn = useMutation(cloudApi.startCloudChat);
  const { cloudMode } = useCloudMode();
  const cloudEngine = useQuery(
    cloudApi.listMyEngineConnections,
    cloudMode ? {} : "skip",
  );
  const localExecution = useSyncExternalStore(
    subscribeCloudExecutionSelection,
    getCloudExecutionSelectionSnapshot,
    noLocalExecution,
  );
  const store = conversationId ? conversationStore(conversationId) : null;

  useEffect(() => {
    reconcileCloudExecutionSelection(cloudEngine?.execution);
  }, [cloudEngine?.execution, localExecution]);

  useEffect(() => {
    store?.setConfig(config.socketBaseUrl, config.resolved);
  }, [store, config.socketBaseUrl, config.resolved]);

  const state = useSyncExternalStore(
    store?.subscribe ?? noopSubscribe,
    store?.getSnapshot ?? idleSnapshot,
    idleSnapshot,
  );
  const allPending = useSyncExternalStore(
    pendingPrompts.subscribe,
    pendingPrompts.getSnapshot,
    pendingPrompts.getServerSnapshot,
  );

  // A dropped socket is normal on a laptop lid or a phone leaving a tunnel.
  // The browser tells us when that changed; asking then is what makes the
  // reconnect feel immediate without any polling.
  useEffect(() => {
    if (!store) return;
    const wake = () => store.wake();
    const onVisible = () => {
      if (document.visibilityState === "visible") store.wake();
    };
    window.addEventListener("online", wake);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.removeEventListener("online", wake);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [store]);

  const pending = useMemo(
    () =>
      allPending.filter(
        (entry) =>
          entry.conversationId === null ||
          entry.conversationId === conversationId,
      ),
    [allPending, conversationId],
  );

  const dispatch = useCallback(
    async (clientMsgId: string, prompt: string): Promise<void> => {
      // Attached drive images ride as model-visible image blocks in addition
      // to the path list in the prompt text. Read at dispatch time: the store
      // is cleared only on success, so a retry re-sends the same set. The
      // extension filter is a hint — the server re-checks the stored
      // content type before signing anything.
      const imagePaths = cloudAttachmentsStore
        .getSnapshot()
        .filter((entry) => /\.(png|jpe?g|gif|webp)$/i.test(entry.path))
        .slice(0, 4)
        .map((entry) => entry.path);
      const selectedExecution =
        getCloudExecutionSelectionSnapshot() ?? cloudEngine?.execution;
      try {
        const result = await startTurn({
          prompt,
          clientMsgId,
          ...(conversationId ? { conversationId } : {}),
          // The reply-language hint; English sends nothing (default behavior).
          ...(locale !== "en" ? { locale } : {}),
          ...(imagePaths.length ? { attachments: imagePaths } : {}),
          // An explicit selection makes a picker change apply to the next
          // message even when this conversation already has a durable route.
          ...(selectedExecution ? { execution: selectedExecution } : {}),
        });
        pendingPrompts.bind(clientMsgId, result.conversationId, result.turnId);
        onSent();
      } catch (error) {
        pendingPrompts.fail(clientMsgId, friendlySendError(error));
      }
    },
    [startTurn, conversationId, onSent, locale, cloudEngine?.execution],
  );

  const send = useCallback(
    async (prompt: string): Promise<void> => {
      const text = prompt.trim();
      if (!text) return;
      const clientMsgId = newClientMsgId();
      pendingPrompts.add(clientMsgId, text, conversationId);
      await dispatch(clientMsgId, decoratePrompt(text));
    },
    [conversationId, decoratePrompt, dispatch],
  );

  const retrySend = useCallback(
    async (clientMsgId: string): Promise<void> => {
      const entry = allPending.find(
        (candidate) => candidate.clientMsgId === clientMsgId,
      );
      if (!entry) return;
      pendingPrompts.clearError(clientMsgId);
      // Same `clientMsgId`: if the first attempt actually landed, the server
      // dedupes it instead of starting a second turn.
      await dispatch(clientMsgId, decoratePrompt(entry.text));
    },
    [allPending, decoratePrompt, dispatch],
  );

  return {
    state,
    status: state.status,
    pending,
    send,
    retrySend,
    dismissSend: pendingPrompts.drop,
    cancelTurn: useCallback(
      (turnId: string) => store?.cancelTurn(turnId) ?? false,
      [store],
    ),
    loadOlder: useCallback(() => store?.loadOlder(), [store]),
    retryConnection: useCallback(() => store?.retry(), [store]),
  };
};

/**
 * Convex wraps a thrown `ConvexError` in a request-id preamble and a stack.
 * The message we wrote is the only part a user should ever read.
 */
const friendlySendError = (error: unknown): string => {
  const data = (error as { data?: unknown })?.data;
  if (typeof data === "string" && data.trim()) return data.trim();
  const message = (data as { message?: unknown })?.message;
  if (typeof message === "string" && message.trim()) return message.trim();
  if (
    error instanceof Error &&
    error.message &&
    !/Server Error|ConvexError|\[Request ID/.test(error.message)
  ) {
    return error.message;
  }
  return "That didn't send. Try again.";
};
