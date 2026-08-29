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
import { authClient } from "./auth-client";
import { clearCachedToken, getConvexTokenOwnerForSubject } from "./auth-token";
import { observeCloudConversationIdentity } from "./cloud-conversation-auth";
import { decodeMobileCloudMemoryPreferenceForSubject } from "./cloud-memory-preference";
import {
  CloudAuthorityError,
  loadCloudConversationAuthority,
  type CloudAuthorityIssue,
  type CloudConversationAuthority,
  type CloudRealtimeConfig,
} from "./cloud-conversation-authority";
import { rebuildMobileCloudConversationCache } from "./cloud-conversation-cache";
import { cancelCanonicalCloudExecution } from "./cloud-canonical-execution";
import {
  conversationStore,
  retireCloudConversationClientAuthority,
  setCloudConversationAppActive,
  type ConversationState,
} from "./cloud-conversation-store";
import {
  activeCloudTurnId,
  canonicalCloudDispatchIdForTurn,
  canonicalCloudDispatchIds,
  cloudTurnActivity,
  mergeCanonicalCloudMessages,
  projectCloudConversationMessages,
  rebindCanonicalCloudMessages,
} from "./cloud-journal-projection";
import { getConvexClient } from "./convex";
import {
  cancelAutomaticExecution,
  ensureAutomaticExecutionConversation,
  getAutomaticExecutionStatus,
} from "./execution-placement";
import { groupActivityArtifacts } from "./activity-hub-model";
import {
  buildWorkingIndicatorState,
  IDLE_WORKING_ACTIVITY,
} from "../components/working-indicator-state";
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

const safeAuthorityIssue = (error: unknown): CloudAuthorityIssue => {
  if (error instanceof CloudAuthorityError) {
    return { message: error.message, retryable: error.retryable };
  }
  const message = error instanceof Error ? error.message : String(error);
  if (/sign in|session|authentication|unauthorized/i.test(message)) {
    return {
      message: "Stella could not verify this account. Sign in again.",
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

/** Resolves and account-fences the one signed-in mobile Chat conversation. */
export const useCloudConversationAuthority = (): CloudAuthorityHookState => {
  const session = authClient.useSession();
  const identity = useMemo(
    () => observeCloudConversationIdentity(session.data),
    [session.data],
  );
  const identityKey = identity?.identityKey ?? null;
  const accountScope = identity?.accountScope ?? null;
  const [retryGeneration, setRetryGeneration] = useState(0);
  const retry = useCallback(
    () => setRetryGeneration((generation) => generation + 1),
    [],
  );
  const [resolved, setResolved] = useState<
    | { identityKey: string; authority: CloudConversationAuthority }
    | { identityKey: string; issue: CloudAuthorityIssue }
    | null
  >(null);
  const requestGenerationRef = useRef(0);

  useLayoutEffect(() => {
    requestGenerationRef.current += 1;
    clearCachedToken();
    if (accountScope) {
      retireCloudConversationClientAuthority(accountScope);
    }
  }, [accountScope, identityKey]);

  useEffect(() => {
    if (session.isPending || !identity) return;
    const generation = ++requestGenerationRef.current;
    setResolved(null);
    void getConvexTokenOwnerForSubject(identity.expectedSubject)
      .then((tokenOwner) => {
        if (generation !== requestGenerationRef.current) return null;
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
          getRealtimeConfig: () =>
            getConvexClient().query(realtimeConfigRef, {}),
        });
      })
      .then(
        (authority) => {
          if (!authority || generation !== requestGenerationRef.current) return;
          setResolved({ identityKey: identity.identityKey, authority });
        },
        (error) => {
          if (generation !== requestGenerationRef.current) return;
          setResolved({
            identityKey: identity.identityKey,
            issue: safeAuthorityIssue(error),
          });
        },
      );
    return () => {
      requestGenerationRef.current += 1;
    };
  }, [identity, retryGeneration, session.isPending]);

  if (session.isPending || !identity) {
    return { status: "loading", authority: null, issue: null, retry };
  }
  if (!resolved || resolved.identityKey !== identity.identityKey) {
    return { status: "loading", authority: null, issue: null, retry };
  }
  if ("issue" in resolved) {
    return {
      status: "failed",
      authority: null,
      issue: resolved.issue,
      retry,
    };
  }
  return {
    status: "ready",
    authority: resolved.authority,
    issue: null,
    retry,
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
      onAdmission,
    }),
    [
      access,
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
  const acknowledgedDispatchIds = useMemo(
    () => canonicalCloudDispatchIds(state.records),
    [state.records],
  );
  const canonical = useMemo(
    () => rebindCanonicalCloudMessages(projected, dispatchBindings),
    [dispatchBindings, projected],
  );
  const messages = useMemo(
    () =>
      mergeCanonicalCloudMessages({
        canonical,
        local: local.messages,
        dispatchBindings,
        acknowledgedDispatchIds,
      }),
    [acknowledgedDispatchIds, canonical, dispatchBindings, local.messages],
  );

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
  const storageLoaded = (caughtUp || settledFailure) && !local.authorityIssue;

  const trackSend = useCallback(
    (send: () => { userMessageId: string } | null) => {
      if (!clientAuthorityReady) return null;
      const result = send();
      if (!result) return null;
      setDispatchBindings((current) => {
        if (current.has(result.userMessageId)) return current;
        const next = new Map(current);
        next.set(result.userMessageId, null);
        return next;
      });
      return result;
    },
    [clientAuthorityReady],
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
  const sending = local.sending || Boolean(runningTurnId);
  const workingIndicator = useMemo(() => {
    if (local.sending) return local.workingIndicator;
    if (!runningTurnId) {
      return buildWorkingIndicatorState({
        sending: false,
        activity: IDLE_WORKING_ACTIVITY,
      });
    }
    // Committed records carry the answer/tool history; the live snapshot only
    // knows which tool is open right now.
    const journal = cloudTurnActivity(state.records, runningTurnId);
    return buildWorkingIndicatorState({
      sending: true,
      activity: {
        ...(state.live?.toolName ? { toolName: state.live.toolName } : {}),
        ...(state.live?.toolLabel ? { statusText: state.live.toolLabel } : {}),
        answerLanded: journal.answerLanded,
        hasToolActivity:
          journal.hasToolActivity || Boolean(state.live?.toolName),
      },
    });
  }, [
    local.sending,
    local.workingIndicator,
    runningTurnId,
    state.live,
    state.records,
  ]);
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
        }),
      cancel: (command) =>
        cancelAutomaticExecution({
          ...command,
          signal: controller.signal,
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
  }, [authority.conversationId, localStop, runningDispatchId]);

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
