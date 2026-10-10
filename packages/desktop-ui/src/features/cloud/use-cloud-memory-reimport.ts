import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { MemoryWipeStatus } from "@stella/contracts/backend/home";
import { useCloudConversationSession } from "@/global/auth/hooks/use-cloud-conversation-session";
import { backendClient } from "@/platform/backend/backend-client";
import { useBackendView } from "@/platform/backend/use-backend-view";
import { cloudHomeSyncRetryStore } from "./cloud-home-sync";
import { requestMemorySync } from "./use-memory-sync-status";
import {
  beginCloudMemoryReimport,
  CloudMemoryReimportError,
  createCloudMemoryReimportClient,
  isCloudMemoryReimportRequestCurrent,
  normalizeCloudMemoryReimportError,
  type CloudMemoryReimportAttempt,
  type CloudMemoryReimportIdentity,
  type CloudMemoryReimportIssueCode,
  type CloudMemoryReimportRequestFence,
} from "./cloud-memory-reimport";
import { followsOwnerGeneration } from "@stella/contracts/cloud-memory-preference";
import { decodeCloudMemoryWipeStatus } from "./cloud-memory-wipe";

type RetryPlan =
  | { kind: "load" }
  | { kind: "authorize"; attempt: CloudMemoryReimportAttempt };

export type CloudMemoryReimportView = Readonly<{
  identity: CloudMemoryReimportIdentity | null;
  phase: "loading" | "ready" | "authorizing" | "authorized" | "error";
  status: MemoryWipeStatus | null;
  issueCode: CloudMemoryReimportIssueCode | null;
  eligible: boolean;
  disabled: boolean;
  authorizeReimport: () => Promise<boolean>;
  refresh: () => Promise<boolean>;
  retry: () => Promise<boolean>;
}>;

const sameIdentity = (
  left: CloudMemoryReimportIdentity | null,
  right: CloudMemoryReimportIdentity | null,
): boolean =>
  Boolean(
    left &&
      right &&
      left.accountScope === right.accountScope &&
      left.identityRevision === right.identityRevision &&
      left.ownerSubject === right.ownerSubject,
  );

const reimportClient = createCloudMemoryReimportClient({
  authorize: (args) => backendClient.call("memory.authorizeReimport", args),
});

/** A view value echoing another owner is the previous account's, not ours. */
const belongsToAnotherOwner = (value: unknown, subject: string): boolean =>
  typeof value === "object" &&
  value !== null &&
  typeof (value as { subject?: unknown }).subject === "string" &&
  (value as { subject: string }).subject !== subject;

const statusIsEligible = (status: MemoryWipeStatus | null): boolean =>
  status?.state === "open" && status.importDisposition === "explicit_required";

/**
 * Explicit, account-fenced authorization for the memory computers kept from
 * before a wipe to sync into the fresh epoch (`memory.authorizeReimport`).
 * Until it is given, the desktop memory sync holds on those computers. It
 * does not authorize skills.
 */
export function useCloudMemoryReimport(): CloudMemoryReimportView {
  const mode = useCloudConversationSession();
  const identity = useMemo<CloudMemoryReimportIdentity | null>(
    () =>
      mode.isCloudConversationReady && mode.ownerSubject
        ? {
            accountScope: mode.accountScope,
            identityRevision: mode.identityRevision,
            ownerSubject: mode.ownerSubject,
          }
        : null,
    [
      mode.accountScope,
      mode.isCloudConversationReady,
      mode.identityRevision,
      mode.ownerSubject,
    ],
  );
  const live = useBackendView("memory.wipeStatus", identity ? {} : "skip");
  const reactiveResult: unknown =
    live.status === "ready"
      ? live.value
      : live.status === "error"
        ? live.error
        : undefined;

  const currentIdentityRef = useRef<CloudMemoryReimportIdentity | null>(
    identity,
  );
  const statusRef = useRef<MemoryWipeStatus | null>(null);
  /** The last status the view delivered; null once it fails. */
  const liveStatusRef = useRef<MemoryWipeStatus | null>(null);
  const activeRequestIdRef = useRef<string | null>(null);
  const activeAttemptRef = useRef<CloudMemoryReimportAttempt | null>(null);
  const retryPlanRef = useRef<RetryPlan | null>(null);
  const authorizingRef = useRef(false);
  const authorizingRequestIdRef = useRef<string | null>(null);
  const mountedRef = useRef(true);
  const [view, setView] = useState<
    Pick<CloudMemoryReimportView, "phase" | "status" | "issueCode">
  >({ phase: "loading", status: null, issueCode: null });

  const requestIsCurrent = useCallback(
    (fence: CloudMemoryReimportRequestFence): boolean => {
      const current = currentIdentityRef.current;
      return (
        mountedRef.current &&
        sameIdentity(current, fence) &&
        isCloudMemoryReimportRequestCurrent(fence, {
          accountScope: current?.accountScope,
          identityRevision: current?.identityRevision,
          ownerSubject: current?.ownerSubject,
          requestId: activeRequestIdRef.current,
        })
      );
    },
    [],
  );

  const publishError = useCallback(
    (error: CloudMemoryReimportError, retryPlan: RetryPlan) => {
      retryPlanRef.current = retryPlan;
      setView({
        phase: "error",
        status: statusRef.current,
        issueCode: error.code,
      });
    },
    [],
  );

  const publishOrdinaryStatus = useCallback(
    (status: MemoryWipeStatus): boolean => {
      retryPlanRef.current = null;
      statusRef.current = status;
      setView({
        phase:
          status.state === "open" &&
          status.importDisposition === "explicit_allowed"
            ? "authorized"
            : "ready",
        status,
        issueCode: null,
      });
      return true;
    },
    [],
  );

  const completeAuthorization = useCallback(
    (status: MemoryWipeStatus): boolean => {
      activeRequestIdRef.current = null;
      activeAttemptRef.current = null;
      retryPlanRef.current = null;
      authorizingRef.current = false;
      authorizingRequestIdRef.current = null;
      statusRef.current = status;
      setView({ phase: "authorized", status, issueCode: null });
      cloudHomeSyncRetryStore.request();
      // This computer's held memory goes up on the pass this starts.
      void requestMemorySync();
      return true;
    },
    [],
  );

  const publishReactiveStatus = useCallback(
    (status: MemoryWipeStatus): boolean => {
      const attempt = activeAttemptRef.current;
      if (!attempt) {
        activeRequestIdRef.current = null;
        return publishOrdinaryStatus(status);
      }
      if (
        status.ownerGeneration !== attempt.expectedOwnerGeneration &&
        !followsOwnerGeneration(
          attempt.expectedOwnerGeneration,
          status.ownerGeneration,
        )
      ) {
        activeRequestIdRef.current = null;
        activeAttemptRef.current = null;
        authorizingRef.current = false;
        authorizingRequestIdRef.current = null;
        publishError(new CloudMemoryReimportError("owner_generation_changed"), {
          kind: "load",
        });
        return false;
      }
      if (status.memoryEpoch !== attempt.expectedMemoryEpoch) {
        activeRequestIdRef.current = null;
        activeAttemptRef.current = null;
        authorizingRef.current = false;
        authorizingRequestIdRef.current = null;
        publishError(new CloudMemoryReimportError("stale_epoch"), {
          kind: "load",
        });
        return false;
      }
      if (status.state !== "open") {
        activeRequestIdRef.current = null;
        activeAttemptRef.current = null;
        authorizingRef.current = false;
        authorizingRequestIdRef.current = null;
        publishError(new CloudMemoryReimportError("active"), { kind: "load" });
        return false;
      }
      if (status.importDisposition === "explicit_allowed") {
        return completeAuthorization(status);
      }
      if (status.importDisposition === "explicit_required") {
        // This is the unchanged pre-authorization head. It cannot resolve an
        // ambiguous mutation and must not replace its exact-attempt retry.
        return false;
      }
      activeRequestIdRef.current = null;
      activeAttemptRef.current = null;
      authorizingRef.current = false;
      authorizingRequestIdRef.current = null;
      publishError(new CloudMemoryReimportError("invalid_response"), {
        kind: "load",
      });
      return false;
    },
    [completeAuthorization, publishError, publishOrdinaryStatus],
  );

  const runAuthorize = useCallback(
    async (attempt: CloudMemoryReimportAttempt): Promise<boolean> => {
      const current = currentIdentityRef.current;
      if (!sameIdentity(current, attempt) || authorizingRef.current) {
        return false;
      }
      activeAttemptRef.current = attempt;
      activeRequestIdRef.current = attempt.requestId;
      retryPlanRef.current = null;
      authorizingRef.current = true;
      authorizingRequestIdRef.current = attempt.requestId;
      setView({
        phase: "authorizing",
        status: statusRef.current,
        issueCode: null,
      });
      try {
        const result = await reimportClient.authorize(attempt);
        if (!requestIsCurrent(attempt)) return false;
        return completeAuthorization(result.status);
      } catch (error) {
        if (!requestIsCurrent(attempt)) return false;
        activeRequestIdRef.current = null;
        const normalized = normalizeCloudMemoryReimportError(error);
        if (!normalized.retryable) activeAttemptRef.current = null;
        publishError(
          normalized,
          normalized.retryable
            ? { kind: "authorize", attempt }
            : { kind: "load" },
        );
        return false;
      } finally {
        if (authorizingRequestIdRef.current === attempt.requestId) {
          authorizingRequestIdRef.current = null;
          authorizingRef.current = false;
        }
      }
    },
    [completeAuthorization, publishError, requestIsCurrent],
  );

  /**
   * Republish from the live view. A failed view is retried by reconnecting
   * the live channel; the status it delivers next is published by the
   * subscription effect.
   */
  const load = useCallback(async (): Promise<boolean> => {
    const current = currentIdentityRef.current;
    // An ambiguous authorization owns its exact retry until it resolves. A
    // generic refresh must not discard that plan or strand the attempt.
    if (!current || authorizingRef.current || activeAttemptRef.current) {
      return false;
    }
    activeRequestIdRef.current = null;
    const latest = liveStatusRef.current;
    if (latest) return publishOrdinaryStatus(latest);
    setView({
      phase: "loading",
      status: statusRef.current,
      issueCode: null,
    });
    backendClient.reconnect();
    return false;
  }, [publishOrdinaryStatus]);

  useLayoutEffect(() => {
    currentIdentityRef.current = identity;
    statusRef.current = null;
    liveStatusRef.current = null;
    activeRequestIdRef.current = null;
    activeAttemptRef.current = null;
    retryPlanRef.current = null;
    authorizingRef.current = false;
    authorizingRequestIdRef.current = null;
    setView({ phase: "loading", status: null, issueCode: null });
  }, [identity]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      activeRequestIdRef.current = null;
      activeAttemptRef.current = null;
      authorizingRef.current = false;
      authorizingRequestIdRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (!identity || reactiveResult === undefined) return;
    if (reactiveResult instanceof Error) {
      liveStatusRef.current = null;
      if (!activeAttemptRef.current) {
        activeRequestIdRef.current = null;
        publishError(normalizeCloudMemoryReimportError(reactiveResult), {
          kind: "load",
        });
      }
      return;
    }
    if (belongsToAnotherOwner(reactiveResult, identity.ownerSubject)) return;
    try {
      const status = decodeCloudMemoryWipeStatus(
        reactiveResult,
        identity.ownerSubject,
      );
      liveStatusRef.current = status;
      publishReactiveStatus(status);
    } catch (error) {
      liveStatusRef.current = null;
      activeRequestIdRef.current = null;
      activeAttemptRef.current = null;
      authorizingRef.current = false;
      authorizingRequestIdRef.current = null;
      publishError(normalizeCloudMemoryReimportError(error), { kind: "load" });
    }
  }, [identity, publishError, publishReactiveStatus, reactiveResult]);

  const authorizeReimport = useCallback(async (): Promise<boolean> => {
    const current = currentIdentityRef.current;
    const status = statusRef.current;
    if (
      !current ||
      !status ||
      !statusIsEligible(status) ||
      authorizingRef.current ||
      activeAttemptRef.current
    ) {
      return false;
    }
    try {
      return await runAuthorize(
        beginCloudMemoryReimport({ identity: current, status }),
      );
    } catch (error) {
      publishError(normalizeCloudMemoryReimportError(error), { kind: "load" });
      return false;
    }
  }, [publishError, runAuthorize]);

  const refresh = useCallback(
    async (): Promise<boolean> => await load(),
    [load],
  );

  const retry = useCallback(async (): Promise<boolean> => {
    const retryPlan = retryPlanRef.current;
    if (retryPlan?.kind === "authorize") {
      return await runAuthorize(retryPlan.attempt);
    }
    return await load();
  }, [load, runAuthorize]);

  const eligible = statusIsEligible(view.status);
  return {
    identity,
    ...view,
    eligible,
    disabled: !identity || !eligible || view.phase !== "ready",
    authorizeReimport,
    refresh,
    retry,
  };
}
