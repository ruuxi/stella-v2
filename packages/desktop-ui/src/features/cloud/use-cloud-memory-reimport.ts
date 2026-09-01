import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useConvex, useQueries, type RequestForQueries } from "convex/react";
import { useCloudConversationSession } from "@/global/auth/hooks/use-cloud-conversation-session";
import { cloudHomeApi, type CloudMemoryWipeStatus } from "./cloud-home-api";
import { cloudHomeSyncRetryStore } from "./cloud-home-sync";
import {
  beginCloudMemoryReimport,
  CloudMemoryReimportError,
  createCloudMemoryReimportClient,
  createCloudMemoryReimportRequestFence,
  isCloudMemoryReimportRequestCurrent,
  normalizeCloudMemoryReimportError,
  type CloudMemoryReimportAttempt,
  type CloudMemoryReimportIdentity,
  type CloudMemoryReimportIssueCode,
  type CloudMemoryReimportRequestFence,
} from "./cloud-memory-reimport";
import { decodeCloudMemoryWipeStatus } from "./cloud-memory-wipe";

type RetryPlan =
  | { kind: "load" }
  | { kind: "authorize"; attempt: CloudMemoryReimportAttempt };

export type CloudMemoryReimportView = Readonly<{
  identity: CloudMemoryReimportIdentity | null;
  phase: "loading" | "ready" | "authorizing" | "authorized" | "error";
  status: CloudMemoryWipeStatus | null;
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

const statusIsEligible = (status: CloudMemoryWipeStatus | null): boolean =>
  status?.state === "open" && status.importDisposition === "explicit_required";

/**
 * Explicit, account-fenced authorization for importing this Mac's local
 * Memory into a fresh post-wipe epoch. It does not authorize skills.
 */
export function useCloudMemoryReimport(): CloudMemoryReimportView {
  const convex = useConvex();
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
  const requests = useMemo<RequestForQueries>(() => {
    if (!identity) return {} as RequestForQueries;
    return {
      memoryReimportStatus: {
        query: cloudHomeApi.getMyMemoryWipeStatus,
        args: { expectedSubject: identity.ownerSubject },
      },
    };
  }, [identity]);
  const queryResults = useQueries(requests);
  const reactiveResult = queryResults.memoryReimportStatus;
  const client = useMemo(
    () =>
      createCloudMemoryReimportClient({
        read: (args) => convex.query(cloudHomeApi.getMyMemoryWipeStatus, args),
        authorize: (args) =>
          convex.mutation(cloudHomeApi.authorizeMyMemoryReimport, args),
      }),
    [convex],
  );

  const currentIdentityRef = useRef<CloudMemoryReimportIdentity | null>(
    identity,
  );
  const statusRef = useRef<CloudMemoryWipeStatus | null>(null);
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
    (status: CloudMemoryWipeStatus): boolean => {
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
    (status: CloudMemoryWipeStatus): boolean => {
      activeRequestIdRef.current = null;
      activeAttemptRef.current = null;
      retryPlanRef.current = null;
      authorizingRef.current = false;
      authorizingRequestIdRef.current = null;
      statusRef.current = status;
      setView({ phase: "authorized", status, issueCode: null });
      cloudHomeSyncRetryStore.request();
      return true;
    },
    [],
  );

  const publishReactiveStatus = useCallback(
    (status: CloudMemoryWipeStatus): boolean => {
      const attempt = activeAttemptRef.current;
      if (!attempt) {
        // A reactive head is newer authority than any one-shot load already in
        // flight. Invalidate that load before publishing this status.
        activeRequestIdRef.current = null;
        return publishOrdinaryStatus(status);
      }
      if (status.ownerGeneration !== attempt.expectedOwnerGeneration) {
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
        const result = await client.authorize(attempt);
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
    [client, completeAuthorization, publishError, requestIsCurrent],
  );

  const load = useCallback(async (): Promise<boolean> => {
    const current = currentIdentityRef.current;
    // An ambiguous authorization owns its exact retry until it resolves. A
    // generic refresh must not discard that plan or strand the attempt.
    if (!current || authorizingRef.current || activeAttemptRef.current) {
      return false;
    }
    const fence = createCloudMemoryReimportRequestFence(current);
    activeRequestIdRef.current = fence.requestId;
    setView({
      phase: "loading",
      status: statusRef.current,
      issueCode: null,
    });
    try {
      const result = await client.read(fence);
      if (!requestIsCurrent(fence)) return false;
      activeRequestIdRef.current = null;
      return publishOrdinaryStatus(result.status);
    } catch (error) {
      if (!requestIsCurrent(fence)) return false;
      activeRequestIdRef.current = null;
      publishError(normalizeCloudMemoryReimportError(error), { kind: "load" });
      return false;
    }
  }, [client, publishError, publishOrdinaryStatus, requestIsCurrent]);

  useLayoutEffect(() => {
    currentIdentityRef.current = identity;
    statusRef.current = null;
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
      if (!activeAttemptRef.current) {
        activeRequestIdRef.current = null;
        publishError(new CloudMemoryReimportError("unavailable", true), {
          kind: "load",
        });
      }
      return;
    }
    try {
      publishReactiveStatus(
        decodeCloudMemoryWipeStatus(reactiveResult, identity.ownerSubject),
      );
    } catch (error) {
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
