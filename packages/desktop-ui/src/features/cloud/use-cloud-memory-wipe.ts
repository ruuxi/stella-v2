import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useConvex, useQueries, type RequestForQueries } from "convex/react";
import { useCloudMode } from "@/global/auth/hooks/use-cloud-mode";
import { cloudHomeApi, type CloudMemoryWipeStatus } from "./cloud-home-api";
import {
  CloudMemoryWipeError,
  beginCloudMemoryWipe,
  createCloudMemoryWipeClient,
  createCloudMemoryWipeRequestFence,
  decodeCloudMemoryWipeStatus,
  isCloudMemoryWipeActive,
  isCloudMemoryWipeComplete,
  isCloudMemoryWipeRequestCurrent,
  type CloudMemoryWipeAttempt,
  type CloudMemoryWipeIdentity,
  type CloudMemoryWipeIssueCode,
  type CloudMemoryWipeRequestFence,
} from "./cloud-memory-wipe";

type RetryPlan =
  | { kind: "load" }
  | { kind: "start"; attempt: CloudMemoryWipeAttempt };

export type CloudMemoryWipeView = Readonly<{
  identity: CloudMemoryWipeIdentity | null;
  phase: "loading" | "ready" | "starting" | "active" | "completed" | "error";
  status: CloudMemoryWipeStatus | null;
  issueCode: CloudMemoryWipeIssueCode | null;
  disabled: boolean;
  startWipe: () => Promise<boolean>;
  refresh: () => Promise<boolean>;
  retry: () => Promise<boolean>;
}>;

const sameIdentity = (
  left: CloudMemoryWipeIdentity | null,
  right: CloudMemoryWipeIdentity | null,
): boolean =>
  Boolean(
    left &&
    right &&
    left.accountScope === right.accountScope &&
    left.identityRevision === right.identityRevision &&
    left.ownerSubject === right.ownerSubject,
  );

const phaseForStatus = (
  status: CloudMemoryWipeStatus,
): CloudMemoryWipeView["phase"] =>
  isCloudMemoryWipeActive(status)
    ? "active"
    : isCloudMemoryWipeComplete(status)
      ? "completed"
      : "ready";

/**
 * Account/session-fenced controller for the dedicated destructive Memory wipe.
 * Convex is the only authority; intermediate mutation success is never treated
 * as completion, and an ambiguous retry reuses its exact request id.
 */
export function useCloudMemoryWipe(): CloudMemoryWipeView {
  const convex = useConvex();
  const mode = useCloudMode();
  const identity = useMemo<CloudMemoryWipeIdentity | null>(
    () =>
      mode.cloudMode && mode.ownerSubject
        ? {
            accountScope: mode.accountScope,
            identityRevision: mode.identityRevision,
            ownerSubject: mode.ownerSubject,
          }
        : null,
    [
      mode.accountScope,
      mode.cloudMode,
      mode.identityRevision,
      mode.ownerSubject,
    ],
  );
  const requests = useMemo<RequestForQueries>(() => {
    if (!identity) return {} as RequestForQueries;
    return {
      wipeStatus: {
        query: cloudHomeApi.getMyMemoryWipeStatus,
        args: { expectedSubject: identity.ownerSubject },
      },
    };
  }, [identity]);
  const queryResults = useQueries(requests);
  const reactiveResult = queryResults.wipeStatus;
  const client = useMemo(
    () =>
      createCloudMemoryWipeClient({
        read: (args) => convex.query(cloudHomeApi.getMyMemoryWipeStatus, args),
        start: (args) => convex.mutation(cloudHomeApi.startMyMemoryWipe, args),
      }),
    [convex],
  );

  const currentIdentityRef = useRef<CloudMemoryWipeIdentity | null>(identity);
  const statusRef = useRef<CloudMemoryWipeStatus | null>(null);
  const activeRequestIdRef = useRef<string | null>(null);
  const activeAttemptRef = useRef<CloudMemoryWipeAttempt | null>(null);
  const observedOperationIdRef = useRef<string | null>(null);
  const retryPlanRef = useRef<RetryPlan | null>(null);
  const mountedRef = useRef(true);
  const startingRef = useRef(false);
  const startingRequestIdRef = useRef<string | null>(null);
  const [view, setView] = useState<
    Pick<CloudMemoryWipeView, "phase" | "status" | "issueCode">
  >({ phase: "loading", status: null, issueCode: null });

  const requestIsCurrent = useCallback(
    (fence: CloudMemoryWipeRequestFence): boolean => {
      const current = currentIdentityRef.current;
      return (
        mountedRef.current &&
        sameIdentity(current, fence) &&
        isCloudMemoryWipeRequestCurrent(fence, {
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
    (error: CloudMemoryWipeError, retryPlan: RetryPlan) => {
      retryPlanRef.current = retryPlan;
      setView({
        phase: "error",
        status: statusRef.current,
        issueCode: error.code,
      });
    },
    [],
  );

  const publishStatus = useCallback(
    (status: CloudMemoryWipeStatus): boolean => {
      const attempt = activeAttemptRef.current;
      if (attempt) {
        if (status.ownerGeneration !== attempt.expectedOwnerGeneration) {
          activeAttemptRef.current = null;
          observedOperationIdRef.current = null;
          publishError(new CloudMemoryWipeError("owner_generation_changed"), {
            kind: "load",
          });
          return false;
        }
        if (status.state === "wiping") {
          if (
            status.memoryEpoch !== attempt.expectedMemoryEpoch ||
            !status.job ||
            status.job.operationId === attempt.previousOperationId
          ) {
            activeAttemptRef.current = null;
            observedOperationIdRef.current = null;
            publishError(new CloudMemoryWipeError("stale_epoch"), {
              kind: "load",
            });
            return false;
          }
          observedOperationIdRef.current = status.job.operationId;
          retryPlanRef.current = null;
          statusRef.current = status;
          setView({ phase: "active", status, issueCode: null });
          return true;
        }
        if (isCloudMemoryWipeComplete(status)) {
          const operationId = status.job?.operationId ?? null;
          const observedOperationId = observedOperationIdRef.current;
          if (
            status.memoryEpoch === attempt.expectedMemoryEpoch ||
            operationId === attempt.previousOperationId ||
            (observedOperationId !== null &&
              operationId !== observedOperationId)
          ) {
            activeAttemptRef.current = null;
            observedOperationIdRef.current = null;
            publishError(new CloudMemoryWipeError("stale_epoch"), {
              kind: "load",
            });
            return false;
          }
          activeAttemptRef.current = null;
          observedOperationIdRef.current = null;
          retryPlanRef.current = null;
          statusRef.current = status;
          setView({ phase: "completed", status, issueCode: null });
          return true;
        }
        // An unchanged pre-start open head is not evidence that an ambiguous
        // mutation committed. Preserve its exact-attempt retry plan.
        return false;
      }

      retryPlanRef.current = null;
      statusRef.current = status;
      setView({ phase: phaseForStatus(status), status, issueCode: null });
      return true;
    },
    [publishError],
  );

  const runStart = useCallback(
    async (attempt: CloudMemoryWipeAttempt): Promise<boolean> => {
      const current = currentIdentityRef.current;
      if (!sameIdentity(current, attempt) || startingRef.current) return false;
      activeAttemptRef.current = attempt;
      activeRequestIdRef.current = attempt.requestId;
      observedOperationIdRef.current = null;
      retryPlanRef.current = null;
      startingRef.current = true;
      startingRequestIdRef.current = attempt.requestId;
      setView({
        phase: "starting",
        status: statusRef.current,
        issueCode: null,
      });
      try {
        const result = await client.start(attempt);
        if (!requestIsCurrent(attempt)) return false;
        activeRequestIdRef.current = null;
        return publishStatus(result.status);
      } catch (error) {
        if (!requestIsCurrent(attempt)) return false;
        activeRequestIdRef.current = null;
        const normalized =
          error instanceof CloudMemoryWipeError
            ? error
            : new CloudMemoryWipeError("unavailable", true);
        if (!normalized.retryable) {
          activeAttemptRef.current = null;
          observedOperationIdRef.current = null;
        }
        publishError(
          normalized,
          normalized.retryable ? { kind: "start", attempt } : { kind: "load" },
        );
        return false;
      } finally {
        if (startingRequestIdRef.current === attempt.requestId) {
          startingRequestIdRef.current = null;
          startingRef.current = false;
        }
      }
    },
    [client, publishError, publishStatus, requestIsCurrent],
  );

  const load = useCallback(
    async (silent = false): Promise<boolean> => {
      const current = currentIdentityRef.current;
      if (!current || startingRef.current) return false;
      const fence = createCloudMemoryWipeRequestFence(current);
      activeRequestIdRef.current = fence.requestId;
      if (!silent && retryPlanRef.current?.kind !== "start") {
        setView({
          phase: "loading",
          status: statusRef.current,
          issueCode: null,
        });
      }
      try {
        const result = await client.read(fence);
        if (!requestIsCurrent(fence)) return false;
        activeRequestIdRef.current = null;
        return publishStatus(result.status);
      } catch (error) {
        if (!requestIsCurrent(fence)) return false;
        activeRequestIdRef.current = null;
        const normalized =
          error instanceof CloudMemoryWipeError
            ? error
            : new CloudMemoryWipeError("unavailable", true);
        publishError(normalized, { kind: "load" });
        return false;
      }
    },
    [client, publishError, publishStatus, requestIsCurrent],
  );

  useLayoutEffect(() => {
    currentIdentityRef.current = identity;
    statusRef.current = null;
    activeRequestIdRef.current = null;
    activeAttemptRef.current = null;
    observedOperationIdRef.current = null;
    retryPlanRef.current = null;
    startingRef.current = false;
    startingRequestIdRef.current = null;
    setView({ phase: "loading", status: null, issueCode: null });
  }, [identity]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      activeRequestIdRef.current = null;
      activeAttemptRef.current = null;
      startingRef.current = false;
      startingRequestIdRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (!identity || reactiveResult === undefined) return;
    if (reactiveResult instanceof Error) {
      if (retryPlanRef.current?.kind !== "start") {
        publishError(new CloudMemoryWipeError("unavailable", true), {
          kind: "load",
        });
      }
      return;
    }
    try {
      const status = decodeCloudMemoryWipeStatus(
        reactiveResult,
        identity.ownerSubject,
      );
      publishStatus(status);
    } catch (error) {
      publishError(
        error instanceof CloudMemoryWipeError
          ? error
          : new CloudMemoryWipeError("invalid_response"),
        { kind: "load" },
      );
    }
  }, [identity, publishError, publishStatus, reactiveResult]);

  useEffect(() => {
    if (view.phase !== "active") return;
    const timer = globalThis.setInterval(() => void load(true), 2_500);
    return () => globalThis.clearInterval(timer);
  }, [load, view.phase]);

  const startWipe = useCallback(async (): Promise<boolean> => {
    const currentIdentity = currentIdentityRef.current;
    const status = statusRef.current;
    if (
      !currentIdentity ||
      !status ||
      status.state !== "open" ||
      startingRef.current ||
      activeAttemptRef.current
    ) {
      return false;
    }
    const attempt = beginCloudMemoryWipe({
      identity: currentIdentity,
      status,
    });
    return await runStart(attempt);
  }, [runStart]);

  const refresh = useCallback(
    async (): Promise<boolean> => await load(),
    [load],
  );

  const retry = useCallback(async (): Promise<boolean> => {
    const retryPlan = retryPlanRef.current;
    if (!retryPlan) return await load();
    if (retryPlan.kind === "start") return await runStart(retryPlan.attempt);
    return await load();
  }, [load, runStart]);

  const active = Boolean(view.status && isCloudMemoryWipeActive(view.status));
  return {
    identity,
    ...view,
    disabled:
      !identity ||
      active ||
      view.phase === "loading" ||
      view.phase === "starting",
    startWipe,
    refresh,
    retry,
  };
}
