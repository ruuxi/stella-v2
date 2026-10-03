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
import {
  CloudMemoryWipeError,
  beginCloudMemoryWipe,
  createCloudMemoryWipeClient,
  decodeCloudMemoryWipeStatus,
  isCloudMemoryWipeActive,
  isCloudMemoryWipeComplete,
  isCloudMemoryWipeRequestCurrent,
  normalizeCloudMemoryWipeError,
  type CloudMemoryWipeAttempt,
  type CloudMemoryWipeIdentity,
  type CloudMemoryWipeIssueCode,
  type CloudMemoryWipeRequestFence,
} from "./cloud-memory-wipe";
import { followsOwnerGeneration } from "./cloud-memory-preference";

type RetryPlan =
  | { kind: "load" }
  | { kind: "start"; attempt: CloudMemoryWipeAttempt };

export type CloudMemoryWipeView = Readonly<{
  identity: CloudMemoryWipeIdentity | null;
  phase: "loading" | "ready" | "starting" | "active" | "completed" | "error";
  status: MemoryWipeStatus | null;
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

const wipeClient = createCloudMemoryWipeClient({
  start: (args) => backendClient.call("memory.startWipe", args),
});

/** A view value echoing another owner is the previous account's, not ours. */
const belongsToAnotherOwner = (value: unknown, subject: string): boolean =>
  typeof value === "object" &&
  value !== null &&
  typeof (value as { subject?: unknown }).subject === "string" &&
  (value as { subject: string }).subject !== subject;

const phaseForStatus = (
  status: MemoryWipeStatus,
): CloudMemoryWipeView["phase"] =>
  isCloudMemoryWipeActive(status)
    ? "active"
    : isCloudMemoryWipeComplete(status)
      ? "completed"
      : "ready";

/**
 * Account/session-fenced controller for the dedicated destructive Memory wipe.
 * The owner's live `memory.wipeStatus` view is the only authority and pushes
 * every stage; intermediate call success is never treated as completion, and
 * an ambiguous retry reuses its exact request id.
 */
export function useCloudMemoryWipe(): CloudMemoryWipeView {
  const mode = useCloudConversationSession();
  const identity = useMemo<CloudMemoryWipeIdentity | null>(
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

  const currentIdentityRef = useRef<CloudMemoryWipeIdentity | null>(identity);
  const statusRef = useRef<MemoryWipeStatus | null>(null);
  /** The last status the view delivered, published or not; null once it fails. */
  const liveStatusRef = useRef<MemoryWipeStatus | null>(null);
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
    (status: MemoryWipeStatus): boolean => {
      const attempt = activeAttemptRef.current;
      if (attempt) {
        if (
          status.ownerGeneration !== attempt.expectedOwnerGeneration &&
          !followsOwnerGeneration(
            attempt.expectedOwnerGeneration,
            status.ownerGeneration,
          )
        ) {
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
        const result = await wipeClient.start(attempt);
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
    [publishError, publishStatus, requestIsCurrent],
  );

  /**
   * Republish from the live view. A failed view is retried by reconnecting
   * the live channel; the status it delivers next is published by the
   * subscription effect.
   */
  const load = useCallback(async (): Promise<boolean> => {
    const current = currentIdentityRef.current;
    if (!current || startingRef.current) return false;
    activeRequestIdRef.current = null;
    const latest = liveStatusRef.current;
    if (latest) return publishStatus(latest);
    if (retryPlanRef.current?.kind !== "start") {
      setView({
        phase: "loading",
        status: statusRef.current,
        issueCode: null,
      });
    }
    backendClient.reconnect();
    return false;
  }, [publishStatus]);

  useLayoutEffect(() => {
    currentIdentityRef.current = identity;
    statusRef.current = null;
    liveStatusRef.current = null;
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
      liveStatusRef.current = null;
      if (retryPlanRef.current?.kind !== "start") {
        publishError(normalizeCloudMemoryWipeError(reactiveResult), {
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
      publishStatus(status);
    } catch (error) {
      liveStatusRef.current = null;
      publishError(
        error instanceof CloudMemoryWipeError
          ? error
          : new CloudMemoryWipeError("invalid_response"),
        { kind: "load" },
      );
    }
  }, [identity, publishError, publishStatus, reactiveResult]);

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
