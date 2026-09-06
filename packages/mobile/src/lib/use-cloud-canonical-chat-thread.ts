import type { CloudExecutionSelection } from "@stella/contracts/agent-engine";
import { makeFunctionReference } from "convex/server";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { AppState } from "react-native";
import { notifySuccess } from "./haptics";
import { ReplyArrivalHaptics } from "./reply-arrival-haptics";
import { authClient } from "./auth-client";
import { clearCachedToken, getConvexTokenOwnerForSubject } from "./auth-token";
import {
  observeCloudConversationIdentity,
  type CloudConversationIdentity,
} from "./cloud-conversation-auth";
import { decodeMobileCloudMemoryPreferenceForSubject } from "./cloud-memory-preference";
import {
  CloudAuthorityError,
  loadCloudConversationAuthority,
  type CloudAuthorityIssue,
  type CloudConversationAuthority,
  type CloudRealtimeConfig,
} from "./cloud-conversation-authority";
import { CloudConversationAuthorityStore } from "./cloud-conversation-authority-store";
import {
  readMobileCloudConversationCache,
  rebuildMobileCloudConversationCache,
} from "./cloud-conversation-cache";
import { cancelCanonicalCloudExecution } from "./cloud-canonical-execution";
import {
  conversationStore,
  retireCloudConversationClientAuthority,
  setCloudConversationAppActive,
  type ConversationState,
  type ConversationStore,
} from "./cloud-conversation-store";
import {
  activeCloudTurnId,
  canonicalCloudDispatchIdForTurn,
  canonicalCloudDispatchIds,
  mergeCanonicalCloudMessages,
  projectCloudConversationMessages,
  rebindCanonicalCloudMessages,
} from "./cloud-journal-projection";
import { getConvexClient } from "./convex";
import {
  AUTOMATIC_EXECUTION_TARGET,
  cancelAutomaticExecution,
  ensureAutomaticExecutionConversation,
  getAutomaticExecutionStatus,
  type AutomaticExecutionTarget,
} from "./execution-placement";
import { groupActivityArtifacts } from "./activity-hub-model";
import { canonicalWorkingState } from "./canonical-working-state";
import { useChatAttachmentPreviews } from "./use-chat-attachment-previews";
import type { ChatArtifact, ChatMessage } from "../types";
import type { ChatThreadId } from "./offline-chat-storage";
import type { StoredPhoneAccess } from "./phone-access";
import {
  useChatThread,
  type ChatThread,
  type ChatTransport,
} from "./use-chat-thread";

const confirmIdentityRef = makeFunctionReference<
  "query",
  { expectedSubject: string; identityRevision: number },
  boolean
>("cloud_apps:confirmMySessionIdentity");

const realtimeConfigRef = makeFunctionReference<
  "query",
  Record<string, never>,
  CloudRealtimeConfig
>("cloud_apps:getCloudRealtimeConfig");

const memoryPreferenceFenceRef = makeFunctionReference<
  "query",
  { expectedSubject: string },
  {
    subject: string;
    ownerGeneration: string;
    memoryEnabled: boolean;
    revision: number;
    updatedAt: number;
  }
>("cloud_memory:getMyMemoryPreference");

const safeAuthorityIssue = (
  error: unknown,
  anonymous: boolean,
): CloudAuthorityIssue => {
  if (error instanceof CloudAuthorityError) {
    return { message: error.message, retryable: error.retryable };
  }
  const message = error instanceof Error ? error.message : String(error);
  if (/sign in|session|authentication|unauthorized/i.test(message)) {
    return {
      message: anonymous
        ? "Stella could not verify this anonymous session. Try again."
        : "Stella could not verify this account. Sign in again.",
      retryable: true,
    };
  }
  if (/transfer|migration|being linked|ownership/i.test(message)) {
    return {
      message:
        "Your cloud conversations are still moving to this account. Try again shortly.",
      retryable: true,
    };
  }
  return {
    message: "Stella could not load this cloud conversation. Try again.",
    retryable: true,
  };
};

export type CloudAuthorityHookState =
  | { status: "loading"; authority: null; issue: null; retry: () => void }
  | {
      status: "failed";
      authority: null;
      issue: CloudAuthorityIssue;
      retry: () => void;
    }
  | {
      status: "ready";
      authority: CloudConversationAuthority;
      issue: null;
      retry: () => void;
    };

const resolveMobileCloudConversationAuthority = async (
  identity: CloudConversationIdentity,
): Promise<CloudConversationAuthority> => {
  const tokenOwner = await getConvexTokenOwnerForSubject(
    identity.expectedSubject,
  );
  const ownerSubject = tokenOwner.tokenIdentifier;
  return loadCloudConversationAuthority(identity, {
    confirmIdentity: (args) =>
      getConvexClient().query(confirmIdentityRef, args),
    getOwnerGeneration: async () =>
      await getConvexClient()
        .query(memoryPreferenceFenceRef, {
          expectedSubject: ownerSubject,
        })
        .then(
          (preference) =>
            decodeMobileCloudMemoryPreferenceForSubject(
              preference,
              ownerSubject,
            ).ownerGeneration,
        ),
    ensureConversation: () =>
      ensureAutomaticExecutionConversation({
        threadId: "cloud",
        title: "Chat",
      }),
    getRealtimeConfig: () => getConvexClient().query(realtimeConfigRef, {}),
  });
};

/**
 * The one process-wide authority handshake. Every surface on the session (the
 * chat screen, the CarPlay bridge, the root primer) reads this store, so the
 * handshake runs once per identity rather than once per mount.
 */
const authorityStore = new CloudConversationAuthorityStore({
  resolve: resolveMobileCloudConversationAuthority,
  describeFailure: safeAuthorityIssue,
  onIdentityChange: (identity) => {
    // A new identity key (sign-in, account switch, session rotation) is the
    // one moment the previous subject's bearer token and sockets must go.
    clearCachedToken();
    retireCloudConversationClientAuthority(identity.accountScope);
  },
});

/**
 * Starts (or joins) the handshake for the session as soon as the root layout
 * knows it, so the work overlaps the native splash instead of waiting for the
 * chat screen to mount underneath a spinner.
 */
export const primeCloudConversationAuthority = (
  identity: CloudConversationIdentity,
  anonymous: boolean,
): void => {
  void authorityStore.ensure(identity, anonymous);
};

/** Drops the cached handshake once the session is gone (sign-out). */
export const resetCloudConversationAuthority = (): void => {
  authorityStore.reset();
};

/**
 * True once the handshake for `identityKey` has landed (ready or failed), or
 * when there is no identity to resolve. The root layout holds the native
 * splash on this so a returning user lands on a chat that is already
 * authorised rather than on the spinner.
 */
export const useCloudConversationAuthoritySettled = (
  identityKey: string | null,
): boolean => {
  const entry = useSyncExternalStore(
    authorityStore.subscribe,
    authorityStore.getSnapshot,
    authorityStore.getSnapshot,
  );
  if (!identityKey) return true;
  return entry?.identityKey === identityKey && entry.status !== "loading";
};

const retryCloudConversationAuthority = (): void => {
  void authorityStore.retry();
};

/** Resolves and account-fences the one signed-in mobile Chat conversation. */
export const useCloudConversationAuthority = (): CloudAuthorityHookState => {
  const session = authClient.useSession();
  const anonymous = session.data?.user?.isAnonymous === true;
  const identity = useMemo(
    () => observeCloudConversationIdentity(session.data),
    [session.data],
  );
  const identityKey = identity?.identityKey ?? null;
  const pending = session.isPending;

  // Layout timing keeps the auth boundary synchronous with the render that
  // observed it: the previous subject's sockets retire before its teardown
  // grace could leave one warm. For an identity the store already resolved
  // this is a cache hit and does nothing.
  useLayoutEffect(() => {
    if (pending || !identity) return;
    void authorityStore.ensure(identity, anonymous);
    // `identity` is derived from the key; re-running on every session object
    // identity would only churn the (idempotent) ensure call.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [anonymous, identityKey, pending]);

  const entry = useSyncExternalStore(
    authorityStore.subscribe,
    authorityStore.getSnapshot,
    authorityStore.getSnapshot,
  );

  if (pending || !identity) {
    return {
      status: "loading",
      authority: null,
      issue: null,
      retry: retryCloudConversationAuthority,
    };
  }
  if (!entry || entry.identityKey !== identity.identityKey) {
    return {
      status: "loading",
      authority: null,
      issue: null,
      retry: retryCloudConversationAuthority,
    };
  }
  if (entry.status === "failed") {
    return {
      status: "failed",
      authority: null,
      issue: entry.issue,
      retry: retryCloudConversationAuthority,
    };
  }
  if (entry.status === "loading") {
    return {
      status: "loading",
      authority: null,
      issue: null,
      retry: retryCloudConversationAuthority,
    };
  }
  return {
    status: "ready",
    authority: entry.authority,
    issue: null,
    retry: retryCloudConversationAuthority,
  };
};

const EMPTY_STATE: ConversationState = {
  conversationId: "",
  status: "idle",
  statusMessage: null,
  statusRetryable: true,
  epoch: null,
  headSeq: -1,
  records: [],
  live: null,
  title: "",
  floorSeq: 0,
  hasOlder: false,
  loadingOlder: false,
  olderNotice: null,
};

const emptySnapshot = () => EMPTY_STATE;

const collectArtifacts = (messages: readonly ChatMessage[]): ChatArtifact[] =>
  messages.flatMap((message) => message.artifacts ?? []).reverse();

/**
 * Signed-in Chat: automatic execution for writes, DO journal for every visible
 * transcript row. The base hook's SQLite rows are used only as an optimistic
 * outbox overlay and are never accepted as historical authority.
 */
export const useCloudCanonicalChatThread = (
  authority: CloudConversationAuthority,
  options?: {
    reloadAuthority?: () => void;
    /** Paired computer, when one exists, for the live activity overlay. */
    access?: StoredPhoneAccess | null;
    executionTarget?: AutomaticExecutionTarget;
    execution?: CloudExecutionSelection;
    /**
     * Which durable outbox the optimistic overlay queues into. Two surfaces on
     * the same conversation (the Chat tab and the CarPlay loop) must not drain
     * one queue, so each names its own.
     */
    threadId?: ChatThreadId;
  },
): ChatThread => {
  const reloadAuthority = options?.reloadAuthority;
  const access = options?.access ?? null;
  const executionTarget =
    options?.executionTarget ?? AUTOMATIC_EXECUTION_TARGET;
  const execution = options?.execution;
  const threadId = options?.threadId ?? "cloud";
  const [dispatchBindings, setDispatchBindings] = useState<
    ReadonlyMap<string, string | null>
  >(() => new Map());
  const [placementIssue, setPlacementIssue] =
    useState<CloudAuthorityIssue | null>(null);
  const onAdmission = useCallback(
    (event: {
      localMessageId: string;
      dispatchId: string;
      conversationId: string;
    }) => {
      if (event.conversationId !== authority.conversationId) {
        setPlacementIssue({
          message:
            "Stella placed this turn in a different conversation. Reconnect before sending again.",
          retryable: true,
        });
        return;
      }
      setDispatchBindings((current) => {
        if (current.get(event.localMessageId) === event.dispatchId) {
          return current;
        }
        const next = new Map(current);
        next.set(event.localMessageId, event.dispatchId);
        return next;
      });
    },
    [authority.conversationId],
  );
  const store = useMemo(
    () =>
      conversationStore(
        authority.conversationId,
        authority.accountScope,
        authority.ownerGeneration,
      ),
    [
      authority.accountScope,
      authority.conversationId,
      authority.ownerGeneration,
    ],
  );

  useLayoutEffect(() => {
    // Owner reset keeps the account subject stable while invalidating every
    // prior owner-bound client. Retire the previous generation synchronously,
    // before its teardown grace can leave an authenticated socket warm.
    setDispatchBindings(new Map());
    setPlacementIssue(null);
    retireCloudConversationClientAuthority(
      authority.accountScope,
      authority.ownerGeneration,
    );
  }, [
    authority.accountScope,
    authority.conversationId,
    authority.ownerGeneration,
  ]);

  useEffect(() => {
    store.setConfig(authority.socketOrigin, true);
    store.wake();
  }, [authority.socketOrigin, store]);

  useEffect(() => {
    const active =
      AppState.currentState === "active" || AppState.currentState === "unknown";
    setCloudConversationAppActive(active);
    const subscription = AppState.addEventListener("change", (next) => {
      setCloudConversationAppActive(next === "active" || next === "unknown");
    });
    return () => subscription.remove();
  }, []);

  const replyHaptics = useMemo(() => new ReplyArrivalHaptics(), [store, threadId]);
  useEffect(() => {
    // Observe connection transitions directly: React may batch reconnect + replay
    // into one render. Catch-up must retire eligibility before old rows arrive.
    const retireDuringReplay = () => {
      replyHaptics.observeConnection(store.getSnapshot());
    };
    const unsubscribe = store.subscribe(retireDuringReplay);
    const appState = AppState.addEventListener("change", (next) => {
      if (next !== "active" && next !== "unknown") replyHaptics.reset();
    });
    return () => {
      unsubscribe();
      appState.remove();
      replyHaptics.reset();
    };
  }, [replyHaptics, store]);

  const state = useSyncExternalStore(
    store.subscribe,
    store.getSnapshot,
    emptySnapshot,
  );
  const lastSeq = state.records.at(-1)?.seq ?? -1;
  const caughtUp =
    state.epoch !== null && (state.headSeq < 0 || lastSeq >= state.headSeq);
  const authorityReady = !placementIssue && state.status === "live" && caughtUp;
  const transport = useMemo<ChatTransport>(
    () => ({
      accountScope: authority.accountScope,
      ownerGeneration: authority.ownerGeneration,
      conversationId: authority.conversationId,
      authorityReady,
      access,
      executionTarget,
      ...(execution ? { execution } : {}),
      onAdmission,
    }),
    [
      access,
      executionTarget,
      execution,
      authority.accountScope,
      authority.conversationId,
      authority.ownerGeneration,
      authorityReady,
      onAdmission,
    ],
  );
  const local = useChatThread({ threadId, transport });
  const clientAuthorityReady = authorityReady && !local.authorityIssue;

  // A queued row restored from the durable outbox is operational state, not
  // history. Track it until admission binds the server's dispatch identity.
  useEffect(() => {
    const activeIds = local.messages.flatMap((message) =>
      message.role === "user" &&
      (message.queued === true ||
        (local.sending &&
          local.messages
            .slice()
            .reverse()
            .find((candidate) => candidate.role === "user")?.id === message.id))
        ? [message.id]
        : [],
    );
    if (!activeIds.length) return;
    setDispatchBindings((current) => {
      let changed = false;
      const next = new Map(current);
      for (const id of activeIds) {
        if (next.has(id)) continue;
        changed = true;
        next.set(id, null);
      }
      return changed ? next : current;
    });
  }, [local.messages, local.sending]);

  const projected = useMemo(
    () =>
      projectCloudConversationMessages({
        conversationId: authority.conversationId,
        records: state.records,
        hasOlder: state.hasOlder,
      }),
    [authority.conversationId, state.hasOlder, state.records],
  );

  // Cold start: the on-disk projection from the last session paints the
  // transcript before the socket reconnects. It is read once per authority,
  // only when the process-level store has nothing yet, and only ever shown
  // while the journal has not reported an epoch: the first `ready` (even an
  // empty one) is newer than anything on disk and replaces it.
  const cacheAuthority = useMemo(
    () => ({
      accountScope: authority.accountScope,
      ownerGeneration: authority.ownerGeneration,
      conversationId: authority.conversationId,
      socketOrigin: authority.socketOrigin,
    }),
    [
      authority.accountScope,
      authority.conversationId,
      authority.ownerGeneration,
      authority.socketOrigin,
    ],
  );
  const [cachedProjection, setCachedProjection] = useState<{
    store: ConversationStore;
    messages: ChatMessage[];
  } | null>(null);
  useEffect(() => {
    // Only the chat surface renders history; the CarPlay loop never paints it.
    if (threadId !== "cloud") return;
    const snapshot = store.getSnapshot();
    if (snapshot.epoch !== null || snapshot.records.length > 0) return;
    let active = true;
    void readMobileCloudConversationCache(cacheAuthority).then(
      (messages) => {
        if (!active || !messages) return;
        setCachedProjection({ store, messages });
      },
      () => undefined,
    );
    return () => {
      active = false;
    };
  }, [cacheAuthority, store, threadId]);
  const cacheVisible =
    cachedProjection !== null &&
    cachedProjection.store === store &&
    state.epoch === null &&
    state.records.length === 0;
  const displayedProjection = cacheVisible
    ? cachedProjection.messages
    : projected;

  const acknowledgedDispatchIds = useMemo(
    () => canonicalCloudDispatchIds(state.records),
    [state.records],
  );
  const canonical = useMemo(
    () => rebindCanonicalCloudMessages(displayedProjection, dispatchBindings),
    [dispatchBindings, displayedProjection],
  );
  const mergedMessages = useMemo(
    () =>
      mergeCanonicalCloudMessages({
        canonical,
        local: local.messages,
        dispatchBindings,
        acknowledgedDispatchIds,
      }),
    [acknowledgedDispatchIds, canonical, dispatchBindings, local.messages],
  );
  const messages = useChatAttachmentPreviews(mergedMessages, JSON.stringify(cacheAuthority));

  useEffect(() => {
    if (!clientAuthorityReady || cacheVisible || threadId !== "cloud" ||
      (AppState.currentState !== "active" && AppState.currentState !== "unknown")) {
      replyHaptics.reset();
      return;
    }
    // Runs after the canonical reply has committed to the displayed transcript,
    // independently of the slower execution-placement terminal poll.
    for (const _requestId of replyHaptics.take(messages, state.records)) notifySuccess();
  }, [cacheVisible, clientAuthorityReady, messages, replyHaptics, state.records, threadId]);

  const cacheWriteGenerationRef = useRef(0);
  const cacheWriteQueueRef = useRef<Promise<void>>(Promise.resolve());
  useEffect(() => {
    if (!authorityReady || state.epoch === null) return;
    const generation = ++cacheWriteGenerationRef.current;
    const metadata = {
      version: 1 as const,
      accountScope: authority.accountScope,
      ownerGeneration: authority.ownerGeneration,
      socketOrigin: authority.socketOrigin,
      conversationId: authority.conversationId,
      epoch: state.epoch,
      headSeq: state.headSeq,
      floorSeq: state.floorSeq,
    };
    cacheWriteQueueRef.current = cacheWriteQueueRef.current
      .catch(() => undefined)
      .then(() =>
        rebuildMobileCloudConversationCache({
          metadata,
          // The projection is committed records only, so the cache never
          // persists anything the journal has not durably accepted.
          messages: projected,
          isCurrent: () => generation === cacheWriteGenerationRef.current,
        }),
      );
  }, [
    authority.accountScope,
    authority.conversationId,
    authority.ownerGeneration,
    authority.socketOrigin,
    authorityReady,
    projected,
    state.epoch,
    state.floorSeq,
    state.headSeq,
  ]);
  useEffect(
    () => () => {
      cacheWriteGenerationRef.current += 1;
    },
    [authority.accountScope, authority.conversationId],
  );
  const socketIssue = useMemo<CloudAuthorityIssue | null>(() => {
    if (state.status === "blocked") {
      return {
        message:
          state.statusMessage ??
          "Stella could not verify this cloud conversation.",
        retryable: state.statusRetryable,
      };
    }
    if (state.status === "offline") {
      return {
        message:
          state.statusMessage ??
          "Cloud conversation history is offline. Reconnect to continue.",
        retryable: true,
      };
    }
    if (state.status === "connecting" && state.records.length > 0) {
      return {
        message: "Reconnecting to cloud conversation history…",
        retryable: false,
      };
    }
    return null;
  }, [
    state.records.length,
    state.status,
    state.statusMessage,
    state.statusRetryable,
  ]);
  const issue =
    placementIssue ??
    (local.authorityIssue
      ? {
          message: local.authorityIssue.message,
          retryable: local.authorityIssue.retryable,
        }
      : null) ??
    socketIssue;
  const retryAuthority = useCallback(() => {
    setPlacementIssue(null);
    local.authorityIssue?.retry();
    store.retry();
    reloadAuthority?.();
  }, [local.authorityIssue, reloadAuthority, store]);
  const authorityIssue: ChatThread["authorityIssue"] = issue
    ? {
        ...issue,
        retry: retryAuthority,
      }
    : null;
  const settledFailure =
    state.status === "blocked" || state.status === "offline";
  const storageLoaded =
    (caughtUp || settledFailure || cacheVisible) && !local.authorityIssue;

  const trackSend = useCallback(
    (send: () => { userMessageId: string } | null) => {
      if (!clientAuthorityReady) return null;
      const result = send();
      if (!result) return null;
      if (threadId === "cloud") replyHaptics.arm(result.userMessageId);
      setDispatchBindings((current) => {
        if (current.has(result.userMessageId)) return current;
        const next = new Map(current);
        next.set(result.userMessageId, null);
        return next;
      });
      return result;
    },
    [clientAuthorityReady, replyHaptics, threadId],
  );
  const localSend = local.send;
  const localSendPrompt = local.sendPrompt;
  const localStop = local.stop;
  const send = useCallback(() => trackSend(localSend), [localSend, trackSend]);
  const sendPrompt = useCallback(
    (prompt: string) =>
      localSendPrompt ? trackSend(() => localSendPrompt(prompt)) : null,
    [localSendPrompt, trackSend],
  );
  const loadOlderMessages = useCallback(async () => {
    store.loadOlder();
  }, [store]);
  const loadNewerMessages = useCallback(async () => undefined, []);
  const runningTurnId = activeCloudTurnId(state.records, state.live);
  const runningDispatchId = canonicalCloudDispatchIdForTurn(
    state.records,
    runningTurnId,
  );
  const { sending, workingIndicator } = useMemo(
    () => canonicalWorkingState({
      records: state.records,
      live: state.live,
      localSending: local.sending,
      localIndicator: local.workingIndicator,
      hasQueuedSend: local.messages.some((message) =>
        message.role === "user" && message.queued && !message.stopped),
      activeSendMessageId: local.activeSendMessageId,
      activeDispatchId: local.activeSendMessageId
        ? dispatchBindings.get(local.activeSendMessageId) ?? null
        : null,
    }),
    [dispatchBindings, local.activeSendMessageId, local.sending,
      local.workingIndicator, local.messages, state.live, state.records],
  );
  const conversationArtifacts = useMemo(
    () => collectArtifacts(messages),
    [messages],
  );
  // The activity hub groups files by owning task, and the journal projection —
  // not the optimistic overlay — is what carries them.
  const activityArtifactGroups = useMemo(
    () => groupActivityArtifacts(messages, conversationArtifacts),
    [conversationArtifacts, messages],
  );
  const canonicalCancellationRef = useRef<{
    dispatchId: string;
    controller: AbortController;
  } | null>(null);
  useEffect(
    () => () => {
      canonicalCancellationRef.current?.controller.abort();
      canonicalCancellationRef.current = null;
    },
    [authority.accountScope, authority.conversationId],
  );
  const stop = useCallback(() => {
    // Preserve the base hook's durable queued/active cancellation path. A
    // clean client may also be watching a DO turn whose local outbox no longer
    // exists, so reconstruct that exact placement cancellation below.
    replyHaptics.reset();
    localStop();
    if (!runningDispatchId) return;
    if (canonicalCancellationRef.current?.dispatchId === runningDispatchId) {
      return;
    }
    canonicalCancellationRef.current?.controller.abort();
    const controller = new AbortController();
    canonicalCancellationRef.current = {
      dispatchId: runningDispatchId,
      controller,
    };
    setPlacementIssue(null);
    void cancelCanonicalCloudExecution({
      dispatchId: runningDispatchId,
      conversationId: authority.conversationId,
      readStatus: (dispatchId) =>
        getAutomaticExecutionStatus(dispatchId, {
          signal: controller.signal,
          builderOrigin: authority.socketOrigin,
        }),
      cancel: (command) =>
        cancelAutomaticExecution({
          ...command,
          signal: controller.signal,
          builderOrigin: authority.socketOrigin,
        }),
    })
      .catch(() => {
        if (controller.signal.aborted) return;
        setPlacementIssue({
          message: "Stella could not stop this cloud turn. Try again.",
          retryable: true,
        });
      })
      .finally(() => {
        if (canonicalCancellationRef.current?.controller === controller) {
          canonicalCancellationRef.current = null;
        }
      });
  }, [
    authority.conversationId,
    authority.socketOrigin,
    localStop,
    replyHaptics,
    runningDispatchId,
  ]);

  return {
    ...local,
    conversationId: authority.conversationId,
    messages,
    sending,
    workingIndicator,
    storageLoaded,
    authorityReady: clientAuthorityReady,
    authorityIssue,
    hasOlderMessages: state.hasOlder,
    hasNewerMessages: false,
    historyPageLoading: state.loadingOlder,
    loadOlderMessages,
    loadNewerMessages,
    conversationArtifacts,
    activityArtifactsByTaskId: activityArtifactGroups.byTaskId,
    conversationOwnedArtifacts: activityArtifactGroups.conversation,
    send,
    sendPrompt,
    stop,
    catchingUp: state.status === "connecting",
  };
};
