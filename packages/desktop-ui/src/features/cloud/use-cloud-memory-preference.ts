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
import { cloudHomeApi } from "./cloud-home-api";
import {
  CloudMemoryPreferenceError,
  beginCloudMemoryPreferenceWrite,
  createCloudMemoryPreferenceClient,
  createCloudMemoryPreferenceRequestFence,
  decodeCloudMemoryPreferenceForSubject,
  type CloudMemoryPreferenceIssue,
  type CloudMemoryPreferenceRequestFence,
  type CloudMemoryPreferenceWriteAttempt,
} from "./cloud-memory-preference";
import type { CloudMemoryPreference } from "./cloud-home-api";
import { mirrorCloudMemoryPreferenceLocally } from "./cloud-memory-local-mirror";

type AuthorityIdentity = {
  accountScope: string;
  identityRevision: number;
  expectedSubject: string;
};

type RetryPlan =
  | { kind: "load" }
  | { kind: "write"; attempt: CloudMemoryPreferenceWriteAttempt }
  | { kind: "reload_then_write"; memoryEnabled: boolean };

export type CloudMemoryPreferenceView = {
  status: "loading" | "synced" | "saving" | "error";
  preference: CloudMemoryPreference | null;
  memoryEnabled: boolean;
  issue: "load" | "save" | null;
  issueCode: CloudMemoryPreferenceIssue["code"] | null;
  disabled: boolean;
  setMemoryEnabled: (
    memoryEnabled: boolean,
    options?: { force?: boolean },
  ) => Promise<boolean>;
  retry: () => Promise<boolean>;
};

const sameIdentity = (
  left: AuthorityIdentity | null,
  right: AuthorityIdentity | null,
): boolean =>
  Boolean(
    left &&
      right &&
      left.accountScope === right.accountScope &&
      left.identityRevision === right.identityRevision &&
      left.expectedSubject === right.expectedSubject,
  );

const issueCode = (error: unknown): CloudMemoryPreferenceIssue["code"] =>
  error instanceof CloudMemoryPreferenceError ? error.code : "unavailable";

/**
 * One cloud-authoritative desktop Memory controller. Convex remains the
 * canonical preference; the Electron-local bit is only a privacy-conservative
 * runtime mirror and never seeds this state.
 */
export function useCloudMemoryPreference(): CloudMemoryPreferenceView {
  const convex = useConvex();
  const mode = useCloudConversationSession();
  const identity = useMemo<AuthorityIdentity | null>(
    () =>
      mode.isCloudConversationReady && mode.ownerSubject
        ? {
            accountScope: mode.accountScope,
            identityRevision: mode.identityRevision,
            expectedSubject: mode.ownerSubject,
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
    const next: RequestForQueries = {};
    if (identity) {
      next.preference = {
        query: cloudHomeApi.getMyMemoryPreference,
        args: { expectedSubject: identity.expectedSubject },
      };
    }
    return next;
  }, [identity]);
  const queryResults = useQueries(requests);
  const reactiveResult = queryResults.preference;
  const client = useMemo(
    () =>
      createCloudMemoryPreferenceClient({
        read: (args) => convex.query(cloudHomeApi.getMyMemoryPreference, args),
        write: (args) => convex.mutation(cloudHomeApi.setMyMemoryEnabled, args),
      }),
    [convex],
  );

  const currentIdentityRef = useRef<AuthorityIdentity | null>(identity);
  const preferenceRef = useRef<CloudMemoryPreference | null>(null);
  const activeRequestIdRef = useRef<string | null>(null);
  const activeAttemptRef = useRef<CloudMemoryPreferenceWriteAttempt | null>(
    null,
  );
  const retryPlanRef = useRef<RetryPlan | null>(null);
  const mountedRef = useRef(true);
  const runWriteRef = useRef<
    ((attempt: CloudMemoryPreferenceWriteAttempt) => Promise<boolean>) | null
  >(null);
  const [view, setView] = useState<
    Omit<CloudMemoryPreferenceView, "disabled" | "setMemoryEnabled" | "retry">
  >({
    status: "loading",
    preference: null,
    memoryEnabled: false,
    issue: null,
    issueCode: null,
  });

  const fenceIsCurrent = useCallback(
    (fence: CloudMemoryPreferenceRequestFence): boolean =>
      mountedRef.current &&
      sameIdentity(currentIdentityRef.current, {
        accountScope: fence.accountScope,
        identityRevision: fence.identityRevision,
        expectedSubject: fence.expectedSubject,
      }) &&
      activeRequestIdRef.current === fence.requestId,
    [],
  );

  const publishPreference = useCallback((preference: CloudMemoryPreference) => {
    preferenceRef.current = preference;
    setView({
      status: "synced",
      preference,
      memoryEnabled: preference.memoryEnabled,
      issue: null,
      issueCode: null,
    });
  }, []);

  const supersedingPreference = useCallback(
    (candidate: CloudMemoryPreference): CloudMemoryPreference | null => {
      const current = preferenceRef.current;
      if (!current || current.ownerGeneration !== candidate.ownerGeneration) {
        return null;
      }
      if (current.revision > candidate.revision) return current;
      if (
        current.revision === candidate.revision &&
        (current.memoryEnabled !== candidate.memoryEnabled ||
          current.updatedAt !== candidate.updatedAt)
      ) {
        return current;
      }
      return null;
    },
    [],
  );

  const publishSupersededWrite = useCallback(
    (
      attempt: CloudMemoryPreferenceWriteAttempt,
      authoritative: CloudMemoryPreference,
    ) => {
      preferenceRef.current = authoritative;
      activeAttemptRef.current = null;
      activeRequestIdRef.current = null;
      retryPlanRef.current = {
        kind: "reload_then_write",
        memoryEnabled: attempt.memoryEnabled,
      };
      // A same-generation actor advanced after this attempt. Even if the stale
      // result tried to enable Memory, return the runtime to privacy-conservative
      // false until the newer head is reconciled.
      void mirrorCloudMemoryPreferenceLocally(false).catch(() => false);
      setView({
        status: "error",
        preference: authoritative,
        memoryEnabled: authoritative.memoryEnabled,
        issue: "save",
        issueCode: "revision_conflict",
      });
    },
    [],
  );

  const runWrite = useCallback(
    async (attempt: CloudMemoryPreferenceWriteAttempt): Promise<boolean> => {
      const liveIdentity = currentIdentityRef.current;
      if (
        !sameIdentity(liveIdentity, {
          accountScope: attempt.accountScope,
          identityRevision: attempt.identityRevision,
          expectedSubject: attempt.expectedSubject,
        })
      ) {
        return false;
      }
      activeRequestIdRef.current = attempt.requestId;
      activeAttemptRef.current = attempt;
      retryPlanRef.current = null;
      const base = preferenceRef.current;
      setView({
        status: "saving",
        preference: base,
        memoryEnabled: attempt.memoryEnabled,
        issue: null,
        issueCode: null,
      });

      let localMirrorOk = true;
      if (!attempt.memoryEnabled) {
        localMirrorOk = await mirrorCloudMemoryPreferenceLocally(false).catch(
          () => false,
        );
        if (!fenceIsCurrent(attempt)) return false;
      }

      try {
        const result = await client.write(attempt);
        if (!fenceIsCurrent(attempt)) return false;
        const currentGeneration = preferenceRef.current?.ownerGeneration;
        if (
          currentGeneration &&
          currentGeneration !== attempt.expectedOwnerGeneration
        ) {
          return false;
        }
        if (result.status === "conflict") {
          activeAttemptRef.current = null;
          retryPlanRef.current = {
            kind: "reload_then_write",
            memoryEnabled: attempt.memoryEnabled,
          };
          setView({
            status: "error",
            preference: preferenceRef.current,
            memoryEnabled:
              preferenceRef.current?.memoryEnabled ?? attempt.memoryEnabled,
            issue: "save",
            issueCode: "revision_conflict",
          });
          return false;
        }
        const supersedingBeforeMirror = supersedingPreference(
          result.preference,
        );
        if (supersedingBeforeMirror) {
          publishSupersededWrite(attempt, supersedingBeforeMirror);
          return false;
        }
        preferenceRef.current = result.preference;
        if (result.preference.memoryEnabled) {
          localMirrorOk = await mirrorCloudMemoryPreferenceLocally(true).catch(
            () => false,
          );
          if (!fenceIsCurrent(attempt)) return false;
        }
        const supersedingAfterMirror = supersedingPreference(result.preference);
        if (supersedingAfterMirror) {
          publishSupersededWrite(attempt, supersedingAfterMirror);
          return false;
        }
        if (!localMirrorOk) {
          activeAttemptRef.current = null;
          retryPlanRef.current = { kind: "write", attempt };
          setView({
            status: "error",
            preference: result.preference,
            memoryEnabled: result.preference.memoryEnabled,
            issue: "save",
            issueCode: "unavailable",
          });
          return false;
        }
        activeAttemptRef.current = null;
        activeRequestIdRef.current = null;
        publishPreference(result.preference);
        return true;
      } catch (error) {
        if (!fenceIsCurrent(attempt)) return false;
        activeAttemptRef.current = null;
        const code = issueCode(error);
        retryPlanRef.current =
          error instanceof CloudMemoryPreferenceError && error.retryable
            ? { kind: "write", attempt }
            : {
                kind: "reload_then_write",
                memoryEnabled: attempt.memoryEnabled,
              };
        setView({
          status: "error",
          preference: preferenceRef.current,
          memoryEnabled:
            preferenceRef.current?.memoryEnabled ?? attempt.memoryEnabled,
          issue: "save",
          issueCode: code,
        });
        return false;
      }
    },
    [
      client,
      fenceIsCurrent,
      publishPreference,
      publishSupersededWrite,
      supersedingPreference,
    ],
  );

  useLayoutEffect(() => {
    runWriteRef.current = runWrite;
  }, [runWrite]);

  const load = useCallback(
    async (thenWrite?: boolean): Promise<boolean> => {
      const liveIdentity = currentIdentityRef.current;
      if (!liveIdentity || activeAttemptRef.current) return false;
      const fence = createCloudMemoryPreferenceRequestFence(liveIdentity);
      activeRequestIdRef.current = fence.requestId;
      retryPlanRef.current = null;
      setView((current) => ({
        ...current,
        status: "loading",
        issue: null,
        issueCode: null,
      }));
      try {
        const result = await client.read(fence);
        if (!fenceIsCurrent(fence)) return false;
        preferenceRef.current = result.preference;
        if (
          thenWrite !== undefined &&
          result.preference.memoryEnabled !== thenWrite
        ) {
          const attempt = beginCloudMemoryPreferenceWrite({
            ...liveIdentity,
            preference: result.preference,
            memoryEnabled: thenWrite,
          });
          return (await runWriteRef.current?.(attempt)) ?? false;
        }
        activeRequestIdRef.current = null;
        publishPreference(result.preference);
        return true;
      } catch (error) {
        if (!fenceIsCurrent(fence)) return false;
        retryPlanRef.current =
          thenWrite === undefined
            ? { kind: "load" }
            : { kind: "reload_then_write", memoryEnabled: thenWrite };
        setView({
          status: "error",
          preference: preferenceRef.current,
          memoryEnabled: preferenceRef.current?.memoryEnabled ?? false,
          issue: thenWrite === undefined ? "load" : "save",
          issueCode: issueCode(error),
        });
        return false;
      }
    },
    [client, fenceIsCurrent, publishPreference],
  );

  useLayoutEffect(() => {
    currentIdentityRef.current = identity;
    preferenceRef.current = null;
    activeRequestIdRef.current = null;
    activeAttemptRef.current = null;
    retryPlanRef.current = null;
    setView({
      status: "loading",
      preference: null,
      memoryEnabled: false,
      issue: null,
      issueCode: null,
    });
  }, [identity]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      activeRequestIdRef.current = null;
      activeAttemptRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (!identity) return;
    if (reactiveResult === undefined) return;
    if (reactiveResult instanceof Error) {
      if (!activeAttemptRef.current) {
        retryPlanRef.current = { kind: "load" };
        setView({
          status: "error",
          preference: preferenceRef.current,
          memoryEnabled: preferenceRef.current?.memoryEnabled ?? false,
          issue: "load",
          issueCode: issueCode(reactiveResult),
        });
      }
      return;
    }
    try {
      const preference = decodeCloudMemoryPreferenceForSubject(
        reactiveResult,
        identity.expectedSubject,
      );
      const activeAttempt = activeAttemptRef.current;
      preferenceRef.current = preference;
      if (
        activeAttempt &&
        activeAttempt.expectedOwnerGeneration !== preference.ownerGeneration
      ) {
        activeRequestIdRef.current = null;
        activeAttemptRef.current = null;
        retryPlanRef.current = null;
        publishPreference(preference);
        return;
      }
      if (!activeAttempt) {
        // The subscription is the live authority. Invalidate any older
        // one-shot reload so its eventual response cannot regress this head.
        activeRequestIdRef.current = null;
        retryPlanRef.current = null;
        publishPreference(preference);
      }
    } catch (error) {
      retryPlanRef.current = { kind: "load" };
      setView({
        status: "error",
        preference: null,
        memoryEnabled: false,
        issue: "load",
        issueCode: issueCode(error),
      });
    }
  }, [identity, publishPreference, reactiveResult]);

  const setMemoryEnabled = useCallback(
    async (
      memoryEnabled: boolean,
      options: { force?: boolean } = {},
    ): Promise<boolean> => {
      const liveIdentity = currentIdentityRef.current;
      const preference = preferenceRef.current;
      if (!liveIdentity || !preference || activeAttemptRef.current) {
        return false;
      }
      if (preference.memoryEnabled === memoryEnabled && !options.force) {
        return true;
      }
      const attempt = beginCloudMemoryPreferenceWrite({
        ...liveIdentity,
        preference,
        memoryEnabled,
      });
      return (await runWriteRef.current?.(attempt)) ?? false;
    },
    [],
  );

  const retry = useCallback(async (): Promise<boolean> => {
    const plan = retryPlanRef.current;
    if (!plan) return false;
    if (plan.kind === "load") return await load();
    if (plan.kind === "write") {
      return (await runWriteRef.current?.(plan.attempt)) ?? false;
    }
    return await load(plan.memoryEnabled);
  }, [load]);

  return {
    ...view,
    disabled:
      !identity || view.status === "loading" || view.status === "saving",
    setMemoryEnabled,
    retry,
  };
}
