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

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useSyncExternalStore,
} from "react";
import {
  useConvex,
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
import {
  cloudAttachmentsStore,
  isWebShell,
  type CloudAttachment,
} from "./cloud-composer-store";
import {
  browserExecutionCancelArgs,
  browserExecutionSubmitArgs,
  sha256Hex,
  waitForBrowserExecutionTurn,
} from "./browser-execution-placement";
import { PROTOCOL_VERSION } from "./conversation-protocol";
import type { ConversationState } from "./conversation-store";
import {
  activateCloudConversationClientAuthority,
  conversationStore,
  pendingPrompts,
  type CloudConversationOutboxAuthority,
  type PendingCloudTurnSubmission,
  type PendingPrompt,
} from "./conversation-store";
import { cloudConversationOutboxStorageKey } from "./conversation-outbox";
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
  cancelTurn: (turnId: string) => Promise<boolean>;
  cancelPending: (clientMsgId: string) => Promise<boolean>;
  loadOlder: () => void;
  retryConnection: () => void;
};

const newClientMsgId = (): string =>
  typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;

type RenderedAcceptanceBrowserDispatchMetadata = {
  authoritySha256: string;
  clientMsgIdSha256: string;
  conversationIdSha256: string;
  outboxKeySha256: string;
};

type RenderedAcceptanceBrowserDispatchOutcome = {
  clientMsgIdSha256: string;
  outcome: "accepted" | "owner_generation_rejected" | "other_rejected";
  errorCodeSha256: string;
};

type RenderedAcceptanceAuthorityMetadata = {
  authoritySha256: string;
  ownerGenerationSha256: string;
};

declare global {
  interface Window {
    /** Dev-only deterministic barrier for rendered stale-generation proof. */
    __STELLA_RENDERED_ACCEPTANCE_BEFORE_BROWSER_DISPATCH__?: (
      metadata: RenderedAcceptanceBrowserDispatchMetadata,
    ) => Promise<void>;
    /** Dev-only hash receipt for the held browser mutation's exact outcome. */
    __STELLA_RENDERED_ACCEPTANCE_AFTER_BROWSER_DISPATCH__?: (
      metadata: RenderedAcceptanceBrowserDispatchOutcome,
    ) => void;
    /** Dev-only hash receipt for exact renderer authority activation. */
    __STELLA_RENDERED_ACCEPTANCE_AUTHORITY__?: (
      metadata: RenderedAcceptanceAuthorityMetadata,
    ) => void;
  }
}

const hashCloudOutboxAuthority = async (
  authority: CloudConversationOutboxAuthority,
): Promise<string> =>
  await sha256Hex(
    JSON.stringify([authority.accountScope, authority.ownerGeneration]),
  );

const waitForRenderedAcceptanceBrowserDispatch = async (
  entry: PendingPrompt,
  barrier: (
    metadata: RenderedAcceptanceBrowserDispatchMetadata,
  ) => Promise<void>,
): Promise<void> => {
  const requestedConversationId = entry.submission.requestedConversationId;
  const [
    authoritySha256,
    clientMsgIdSha256,
    conversationIdSha256,
    outboxKeySha256,
  ] = await Promise.all([
    hashCloudOutboxAuthority(entry),
    sha256Hex(entry.clientMsgId),
    sha256Hex(requestedConversationId ?? "<new-conversation>"),
    sha256Hex(cloudConversationOutboxStorageKey(entry)),
  ]);
  await barrier(
    Object.freeze({
      authoritySha256,
      clientMsgIdSha256,
      conversationIdSha256,
      outboxKeySha256,
    }),
  );
};

const serializedErrorPayload = (
  error: unknown,
): Record<string, unknown> | null => {
  const data = (error as { data?: unknown })?.data;
  if (data && typeof data === "object" && !Array.isArray(data)) {
    return data as Record<string, unknown>;
  }
  if (!(error instanceof Error)) return null;
  const first = error.message.indexOf("{");
  const last = error.message.lastIndexOf("}");
  if (first < 0 || last <= first) return null;
  try {
    const parsed: unknown = JSON.parse(error.message.slice(first, last + 1));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
};

export const classifyBrowserDispatchRejection = async (
  error: unknown,
): Promise<
  Pick<RenderedAcceptanceBrowserDispatchOutcome, "outcome" | "errorCodeSha256">
> => {
  const payload = serializedErrorPayload(error);
  const code = typeof payload?.code === "string" ? payload.code : "";
  return {
    outcome:
      code === "OWNER_DATA_GENERATION_STALE"
        ? "owner_generation_rejected"
        : "other_rejected",
    errorCodeSha256: await sha256Hex(code || "<no-error-code>"),
  };
};

const browserDispatchRejectionReceipt = async (
  entry: PendingPrompt,
  error: unknown,
): Promise<RenderedAcceptanceBrowserDispatchOutcome> => {
  const classification = await classifyBrowserDispatchRejection(error);
  return {
    clientMsgIdSha256: await sha256Hex(entry.clientMsgId),
    ...classification,
  };
};

const reportRenderedAcceptanceAuthority = (
  authority: CloudConversationOutboxAuthority,
  hook: (metadata: RenderedAcceptanceAuthorityMetadata) => void,
): void => {
  void Promise.all([
    hashCloudOutboxAuthority(authority),
    sha256Hex(authority.ownerGeneration),
  ])
    .then(([authorityHash, ownerGenerationSha256]) => {
      hook({ authoritySha256: authorityHash, ownerGenerationSha256 });
    })
    .catch(() => {
      // Acceptance instrumentation must never change product behavior.
    });
};

export const cloudTurnStartArgs = (
  clientMsgId: string,
  expectedOwnerGeneration: string,
  submission: PendingCloudTurnSubmission,
) => ({
  prompt: submission.prompt,
  expectedOwnerGeneration,
  clientMsgId,
  ...(submission.requestedConversationId
    ? { conversationId: submission.requestedConversationId }
    : {}),
  ...(submission.locale ? { locale: submission.locale } : {}),
  ...(submission.imagePaths.length
    ? { attachments: [...submission.imagePaths] }
    : {}),
  ...(submission.execution ? { execution: submission.execution } : {}),
});

export const useConversation = (
  conversationId: string | null,
  /** Applied to the prompt before it is sent (drive attachments, etc.). */
  decoratePrompt: (
    prompt: string,
    attachments: readonly CloudAttachment[],
  ) => string = (prompt) => prompt,
  onSent: (submittedAttachments: readonly CloudAttachment[]) => void = () => {},
): CloudConversationView => {
  const config = useCloudRealtimeConfig();
  const { locale } = useI18n();
  const convex = useConvex();
  const startLegacyTurn = useMutation(cloudApi.startCloudChat);
  const submitBrowserExecution = useMutation(cloudApi.submitBrowserExecution);
  const cancelExecutionDispatch = useMutation(cloudApi.cancelExecutionDispatch);
  const { cloudMode, accountScope, ownerSubject } = useCloudMode();
  const webShell = isWebShell();
  const conversationIdentity = useQuery(
    cloudApi.getMyCloudConversationIdentity,
    cloudMode ? {} : "skip",
  );
  const authority = useMemo<CloudConversationOutboxAuthority | null>(() => {
    if (
      !cloudMode ||
      !ownerSubject ||
      !conversationIdentity ||
      conversationIdentity.ownerId !== ownerSubject ||
      !conversationIdentity.ownerGeneration
    ) {
      return null;
    }
    return {
      accountScope,
      ownerGeneration: conversationIdentity.ownerGeneration,
    };
  }, [accountScope, cloudMode, conversationIdentity, ownerSubject]);
  const activeAuthorityKey = authority
    ? `${authority.accountScope}\u0000${authority.ownerGeneration}`
    : null;
  const activeAuthorityKeyRef = useRef(activeAuthorityKey);
  activeAuthorityKeyRef.current = activeAuthorityKey;
  const activatedAuthorityKeyRef = useRef<string | null>(null);
  const dispatchByTurnRef = useRef(new Map<string, string>());
  const cloudEngine = useQuery(
    cloudApi.listMyEngineConnections,
    cloudMode ? {} : "skip",
  );
  const localExecution = useSyncExternalStore(
    subscribeCloudExecutionSelection,
    getCloudExecutionSelectionSnapshot,
    noLocalExecution,
  );
  const store =
    cloudMode && conversationId && authority
      ? conversationStore(
          conversationId,
          authority.accountScope,
          authority.ownerGeneration,
        )
      : null;

  useEffect(() => {
    reconcileCloudExecutionSelection(cloudEngine?.execution);
  }, [cloudEngine?.execution, localExecution]);

  useEffect(() => {
    if (!authority) return;
    const changed = activatedAuthorityKeyRef.current !== activeAuthorityKey;
    const ready = activateCloudConversationClientAuthority(authority);
    if (changed) dispatchByTurnRef.current.clear();
    activatedAuthorityKeyRef.current = activeAuthorityKey;
    const renderedAcceptanceAuthority =
      import.meta.env.DEV && typeof window !== "undefined"
        ? window.__STELLA_RENDERED_ACCEPTANCE_AUTHORITY__
        : undefined;
    if (ready && renderedAcceptanceAuthority) {
      reportRenderedAcceptanceAuthority(authority, renderedAcceptanceAuthority);
    }
  }, [activeAuthorityKey, authority]);

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
          authority !== null &&
          entry.accountScope === authority.accountScope &&
          entry.ownerGeneration === authority.ownerGeneration &&
          (entry.conversationId === null ||
            entry.conversationId === conversationId),
      ),
    [allPending, authority, conversationId],
  );

  const dispatch = useCallback(
    async (entry: PendingPrompt): Promise<void> => {
      const sendAuthority: CloudConversationOutboxAuthority = {
        accountScope: entry.accountScope,
        ownerGeneration: entry.ownerGeneration,
      };
      const sendAuthorityKey = `${entry.accountScope}\u0000${entry.ownerGeneration}`;
      const clientMsgId = entry.clientMsgId;
      const submission = entry.submission;
      if (!pendingPrompts.claimDispatch(sendAuthority, clientMsgId)) return;
      const isCurrentAuthority = () =>
        activeAuthorityKeyRef.current === sendAuthorityKey;
      // Attached drive images ride as model-visible image blocks in addition
      // to the path list in the prompt text. The submission was frozen before
      // the first mutation so an idempotent retry cannot change its payload.
      // The extension filter is only a hint — the server re-checks the stored
      // content type before signing anything.
      try {
        if (!isCurrentAuthority()) return;
        if (!webShell) {
          const result = await startLegacyTurn(
            cloudTurnStartArgs(clientMsgId, entry.ownerGeneration, submission),
          );
          if (!isCurrentAuthority()) return;
          pendingPrompts.bind(
            sendAuthority,
            clientMsgId,
            result.conversationId,
            result.turnId,
          );
          pendingPrompts.acknowledgeAdmission(
            sendAuthority,
            clientMsgId,
            result.conversationId,
            result.turnId,
          );
          onSent(submission.attachments);
          return;
        }
        const requestedConversationId = submission.requestedConversationId;
        if (!requestedConversationId) {
          throw new Error("Open a cloud conversation before sending.");
        }
        const submitArgs = await browserExecutionSubmitArgs({
          clientMsgId,
          expectedOwnerGeneration: entry.ownerGeneration,
          conversationId: requestedConversationId,
          submission,
        });
        // SHA-256 above is asynchronous. Re-fence immediately before the first
        // external side effect so a same-account generation rotation cannot
        // send a retired payload.
        if (!isCurrentAuthority()) return;
        const renderedAcceptanceBarrier =
          import.meta.env.DEV && typeof window !== "undefined"
            ? window.__STELLA_RENDERED_ACCEPTANCE_BEFORE_BROWSER_DISPATCH__
            : undefined;
        if (renderedAcceptanceBarrier) {
          // The development harness deliberately holds the exact request after
          // the normal client fence, then rotates the owner generation. There
          // is intentionally no second client check after release: the proof
          // is that Convex itself rejects the frozen stale generation. This
          // branch is absent from production and receives hashes only.
          await waitForRenderedAcceptanceBrowserDispatch(
            entry,
            renderedAcceptanceBarrier,
          );
        }
        const mutationOutcome = await (async () => {
          try {
            return {
              accepted: true as const,
              result: await submitBrowserExecution(submitArgs),
            };
          } catch (error) {
            return { accepted: false as const, error };
          }
        })();
        const renderedAcceptanceOutcome =
          import.meta.env.DEV && typeof window !== "undefined"
            ? window.__STELLA_RENDERED_ACCEPTANCE_AFTER_BROWSER_DISPATCH__
            : undefined;
        if (renderedAcceptanceOutcome) {
          const receipt = mutationOutcome.accepted
            ? {
                clientMsgIdSha256: await sha256Hex(entry.clientMsgId),
                outcome: "accepted" as const,
                errorCodeSha256: await sha256Hex("<accepted>"),
              }
            : await browserDispatchRejectionReceipt(
                entry,
                mutationOutcome.error,
              );
          try {
            renderedAcceptanceOutcome(Object.freeze(receipt));
          } catch {
            // Acceptance instrumentation must never change product behavior.
          }
        }
        if (!mutationOutcome.accepted) throw mutationOutcome.error;
        const result = mutationOutcome.result;
        if (!isCurrentAuthority()) return;
        pendingPrompts.bindDispatch(
          sendAuthority,
          clientMsgId,
          result.dispatchId,
        );
        onSent(submission.attachments);

        const current = pendingPrompts.find(sendAuthority, clientMsgId);
        if (current?.cancelRequested) {
          const canceled = await cancelExecutionDispatch(
            browserExecutionCancelArgs(result.dispatchId),
          );
          if (!isCurrentAuthority()) return;
          if (canceled.state === "canceled") {
            pendingPrompts.acknowledgeTerminal(
              sendAuthority,
              clientMsgId,
              result.dispatchId,
            );
            pendingPrompts.drop(sendAuthority, clientMsgId);
            return;
          }
        }

        const settled = await waitForBrowserExecutionTurn({
          dispatchId: result.dispatchId,
          queryStatus: (dispatchId) =>
            convex.query(cloudApi.getExecutionDispatchStatus, { dispatchId }),
          isCurrentAccount: isCurrentAuthority,
        });
        if (settled.status === "stale") return;
        if (settled.dispatch.cloudTurnId) {
          dispatchByTurnRef.current.set(
            settled.dispatch.cloudTurnId,
            result.dispatchId,
          );
          pendingPrompts.bind(
            sendAuthority,
            clientMsgId,
            settled.dispatch.conversationId,
            settled.dispatch.cloudTurnId,
          );
          pendingPrompts.acknowledgeAdmission(
            sendAuthority,
            clientMsgId,
            settled.dispatch.conversationId,
            settled.dispatch.cloudTurnId,
          );
        }
        if (settled.status === "terminal") {
          pendingPrompts.acknowledgeTerminal(
            sendAuthority,
            clientMsgId,
            result.dispatchId,
          );
          if (settled.dispatch.state === "canceled") {
            pendingPrompts.drop(sendAuthority, clientMsgId);
          } else if (settled.dispatch.state === "failed") {
            pendingPrompts.fail(
              sendAuthority,
              clientMsgId,
              settled.dispatch.errorMessage || "That cloud turn failed.",
            );
          }
        }
      } catch (error) {
        if (!isCurrentAuthority()) return;
        pendingPrompts.fail(
          sendAuthority,
          clientMsgId,
          friendlySendError(error),
          isAmbiguousTransportFailure(error),
        );
      } finally {
        pendingPrompts.releaseDispatch(sendAuthority, clientMsgId);
      }
    },
    [
      cancelExecutionDispatch,
      convex,
      onSent,
      startLegacyTurn,
      submitBrowserExecution,
      webShell,
    ],
  );

  // A fresh renderer hydrates only the exact current lifecycle generation.
  // Error-free rows are the two ambiguous windows: the process died before
  // admission, or the server committed before its response reached us. The
  // stable claim prevents StrictMode/multi-mount duplicate dispatchers.
  useEffect(() => {
    if (!authority || !pendingPrompts.isAuthorityReady(authority)) return;
    for (const entry of allPending) {
      if (
        entry.accountScope !== authority.accountScope ||
        entry.ownerGeneration !== authority.ownerGeneration ||
        entry.error !== null ||
        (entry.conversationId !== null &&
          entry.conversationId !== conversationId)
      ) {
        continue;
      }
      void dispatch(entry);
    }
  }, [allPending, authority, conversationId, dispatch]);

  const send = useCallback(
    async (prompt: string): Promise<void> => {
      const text = prompt.trim();
      if (!text) return;
      const clientMsgId = newClientMsgId();
      const attachments = cloudAttachmentsStore.getSnapshot();
      const selectedExecution =
        getCloudExecutionSelectionSnapshot() ?? cloudEngine?.execution ?? null;
      if (!authority) return;
      const submission: PendingCloudTurnSubmission = {
        requestedConversationId: conversationId,
        prompt: decoratePrompt(text, attachments),
        imagePaths: attachments
          .filter((entry) => /\.(png|jpe?g|gif|webp)$/i.test(entry.path))
          .slice(0, 4)
          .map((entry) => entry.path),
        attachments,
        locale: locale !== "en" ? locale : null,
        execution: selectedExecution ? { ...selectedExecution } : null,
      };
      const entry = pendingPrompts.add(
        authority,
        clientMsgId,
        text,
        conversationId,
        submission,
      );
      if (entry.durable && entry.error === null) await dispatch(entry);
    },
    [
      authority,
      cloudEngine?.execution,
      conversationId,
      decoratePrompt,
      dispatch,
      locale,
    ],
  );

  const retrySend = useCallback(
    async (clientMsgId: string): Promise<void> => {
      const entry = pending.find(
        (candidate) => candidate.clientMsgId === clientMsgId,
      );
      if (!entry || !authority) return;
      const retry = pendingPrompts.prepareRetry(authority, clientMsgId);
      if (!retry) return;
      // Same `clientMsgId`: if the first attempt actually landed, the server
      // dedupes it instead of starting a second turn.
      await dispatch(retry);
    },
    [authority, dispatch, pending],
  );
  const dismissSend = useCallback(
    (clientMsgId: string) => {
      if (authority) pendingPrompts.drop(authority, clientMsgId);
    },
    [authority],
  );
  const cancelPending = useCallback(
    async (clientMsgId: string): Promise<boolean> => {
      if (!authority) return false;
      const entry = pendingPrompts.find(authority, clientMsgId);
      if (!entry) return false;
      if (!entry.dispatchId) {
        // The submit mutation is still in flight. Its response handler observes
        // this durable-in-renderer intent before it starts status polling.
        pendingPrompts.requestCancel(authority, clientMsgId);
        return true;
      }
      try {
        const canceled = await cancelExecutionDispatch(
          browserExecutionCancelArgs(entry.dispatchId),
        );
        if (canceled.state === "canceled") {
          pendingPrompts.acknowledgeTerminal(
            authority,
            clientMsgId,
            entry.dispatchId,
          );
          pendingPrompts.drop(authority, clientMsgId);
        }
        return true;
      } catch {
        return false;
      }
    },
    [authority, cancelExecutionDispatch],
  );
  const cancelTurn = useCallback(
    async (turnId: string): Promise<boolean> => {
      const journalDispatchId = state.records.find(
        (record) =>
          record.kind === "message" &&
          record.role === "user" &&
          record.turnId === turnId &&
          record.clientMsgId?.startsWith("exec:"),
      );
      const dispatchId =
        dispatchByTurnRef.current.get(turnId) ??
        (journalDispatchId?.kind === "message"
          ? journalDispatchId.clientMsgId
          : undefined);
      if (dispatchId) {
        try {
          await cancelExecutionDispatch(browserExecutionCancelArgs(dispatchId));
          return true;
        } catch {
          return false;
        }
      }
      // Compatibility for a turn created before browser placement shipped.
      return store?.cancelTurn(turnId) ?? false;
    },
    [cancelExecutionDispatch, state.records, store],
  );
  const loadOlder = useCallback(() => store?.loadOlder(), [store]);
  const retryConnection = useCallback(() => store?.retry(), [store]);

  return {
    state,
    status: state.status,
    pending,
    send,
    retrySend,
    dismissSend,
    cancelTurn,
    cancelPending,
    loadOlder,
    retryConnection,
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

/** True only when the server may have committed before transport failed. */
const isAmbiguousTransportFailure = (error: unknown): boolean => {
  if (error instanceof TypeError) return true;
  if ((error as { data?: unknown })?.data !== undefined) return false;
  const message = error instanceof Error ? error.message : String(error ?? "");
  return /network|fetch|connection|socket|timed out|timeout|still starting|failed to reach|load failed/i.test(
    message,
  );
};
