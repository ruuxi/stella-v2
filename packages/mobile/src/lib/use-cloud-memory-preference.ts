import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { getBackendClient, reconnectBackend, useBackendView } from "./backend";
import type { CloudConversationIdentity } from "./cloud-conversation-auth";
import {
  MobileCloudMemoryPreferenceError,
  acceptCurrentMobileCloudMemoryPreferenceResult,
  beginMobileCloudMemoryPreferenceWrite,
  createMobileCloudMemoryPreferenceClient,
  decodeMobileCloudMemoryPreferenceForSubject,
  followsMobileOwnerGeneration,
  type MobileCloudMemoryPreference,
  type MobileCloudMemoryPreferenceWriteAttempt,
} from "./cloud-memory-preference";
import {
  failedMobileCloudMemoryPreference,
  loadingMobileCloudMemoryPreference,
  savingMobileCloudMemoryPreference,
  syncedMobileCloudMemoryPreference,
  type MobileCloudMemoryPreferenceUiState,
} from "./cloud-memory-preference-ui-state";
import { useTokenOwner } from "./use-token-owner";

const preferenceClient = createMobileCloudMemoryPreferenceClient({
  setMemoryEnabled: (input) =>
    getBackendClient().call("memory.setEnabled", input),
});

type PreferenceIdentity = {
  accountScope: string;
  identityKey: string;
  identityRevision: number;
  expectedSubject: string;
};

type RetryPlan =
  | { kind: "load" }
  | {
      kind: "write";
      attempt: MobileCloudMemoryPreferenceWriteAttempt;
      base: MobileCloudMemoryPreference;
    }
  | { kind: "reload_then_write"; memoryEnabled: boolean };

export type MobileCloudMemoryPreferenceView =
  MobileCloudMemoryPreferenceUiState & {
    disabled: boolean;
    setMemoryEnabled: (memoryEnabled: boolean) => void;
    retry: () => void;
  };

/** A view value echoing another owner is the previous account's, not ours. */
const belongsToAnotherOwner = (value: unknown, subject: string): boolean =>
  typeof value === "object" &&
  value !== null &&
  typeof (value as { subject?: unknown }).subject === "string" &&
  (value as { subject: string }).subject !== subject;

/**
 * Session/request/generation-fenced CAS controller for the mobile Memory
 * switch. The owner's live `memory.preference` view is the authority; its
 * caller also keys the component by the full Better Auth session, so an
 * account transition cannot paint the prior owner's setting.
 */
export const useCloudMemoryPreference = (
  sessionIdentity: CloudConversationIdentity | null,
): MobileCloudMemoryPreferenceView => {
  const tokenOwner = useTokenOwner(sessionIdentity);
  const identity = useMemo((): PreferenceIdentity | null => {
    const owner = tokenOwner.identity;
    if (!owner) return null;
    return {
      accountScope: owner.accountScope,
      identityKey: owner.identityKey,
      identityRevision: owner.identityRevision,
      expectedSubject: owner.expectedSubject,
    };
  }, [tokenOwner.identity]);
  const hasSessionIdentity = sessionIdentity !== null;
  const live = useBackendView("memory.preference", identity ? {} : "skip");
  const committedIdentityRef = useRef<PreferenceIdentity | null>(identity);
  const activeRequestIdRef = useRef<string | null>(null);
  const preferenceRef = useRef<MobileCloudMemoryPreference | null>(null);
  /** The last head the view delivered; null until it does or once it fails. */
  const liveRef = useRef<MobileCloudMemoryPreference | null>(null);
  const retryPlanRef = useRef<RetryPlan | null>(null);
  const desiredValueRef = useRef<boolean | null>(null);
  const writeInFlightRef = useRef(false);
  const mountedRef = useRef(true);
  const runWriteRef = useRef<
    | ((
        attempt: MobileCloudMemoryPreferenceWriteAttempt,
        base: MobileCloudMemoryPreference,
      ) => void)
    | null
  >(null);
  const [state, setState] = useState<MobileCloudMemoryPreferenceUiState>(() =>
    loadingMobileCloudMemoryPreference(),
  );

  const requestIsCurrent = useCallback(
    (fence: {
      accountScope: string;
      identityKey: string;
      identityRevision: number;
      expectedSubject: string;
      requestId: string;
    }) => {
      const current = committedIdentityRef.current;
      return Boolean(
        mountedRef.current &&
        current &&
        current.accountScope === fence.accountScope &&
        current.identityKey === fence.identityKey &&
        current.identityRevision === fence.identityRevision &&
        current.expectedSubject === fence.expectedSubject &&
        activeRequestIdRef.current === fence.requestId,
      );
    },
    [],
  );

  const runWrite = useCallback(
    (
      attempt: MobileCloudMemoryPreferenceWriteAttempt,
      base: MobileCloudMemoryPreference,
    ) => {
      const current = committedIdentityRef.current;
      if (
        !current ||
        current.accountScope !== attempt.accountScope ||
        current.identityKey !== attempt.identityKey ||
        current.identityRevision !== attempt.identityRevision ||
        current.expectedSubject !== attempt.expectedSubject
      ) {
        return;
      }
      activeRequestIdRef.current = attempt.requestId;
      writeInFlightRef.current = true;
      retryPlanRef.current = null;
      setState(savingMobileCloudMemoryPreference(base, attempt.memoryEnabled));
      void preferenceClient.write(attempt).then(
        (result) => {
          const currentIdentity = committedIdentityRef.current;
          const accepted = acceptCurrentMobileCloudMemoryPreferenceResult(
            result,
            {
              accountScope: currentIdentity?.accountScope,
              identityKey: currentIdentity?.identityKey,
              identityRevision: currentIdentity?.identityRevision,
              expectedSubject: currentIdentity?.expectedSubject,
              requestId: activeRequestIdRef.current,
              ownerGeneration: preferenceRef.current?.ownerGeneration,
            },
          );
          if (!accepted) return;
          writeInFlightRef.current = false;
          activeRequestIdRef.current = null;
          if (accepted.status === "committed") {
            preferenceRef.current = accepted.preference;
            const desired = desiredValueRef.current;
            if (
              desired !== null &&
              desired !== accepted.preference.memoryEnabled &&
              currentIdentity
            ) {
              const nextAttempt = beginMobileCloudMemoryPreferenceWrite({
                ...currentIdentity,
                preference: accepted.preference,
                memoryEnabled: desired,
              });
              runWriteRef.current?.(nextAttempt, accepted.preference);
              return;
            }
            desiredValueRef.current = null;
            setState(syncedMobileCloudMemoryPreference(accepted.preference));
            return;
          }
          const desired = desiredValueRef.current ?? attempt.memoryEnabled;
          retryPlanRef.current = {
            kind: "reload_then_write",
            memoryEnabled: desired,
          };
          setState(failedMobileCloudMemoryPreference(base, "save"));
        },
        (error) => {
          if (!requestIsCurrent(attempt)) return;
          writeInFlightRef.current = false;
          activeRequestIdRef.current = null;
          preferenceRef.current = base;
          const desired = desiredValueRef.current ?? attempt.memoryEnabled;
          retryPlanRef.current =
            error instanceof MobileCloudMemoryPreferenceError &&
            error.retryable &&
            desired === attempt.memoryEnabled
              ? { kind: "write", attempt, base }
              : { kind: "reload_then_write", memoryEnabled: desired };
          setState(failedMobileCloudMemoryPreference(base, "save"));
        },
      );
    },
    [requestIsCurrent],
  );

  useLayoutEffect(() => {
    runWriteRef.current = runWrite;
  }, [runWrite]);

  /**
   * Settle on a head the view delivered: write toward `target` when it
   * differs, otherwise publish it as synced.
   */
  const settle = useCallback(
    (preference: MobileCloudMemoryPreference, target?: boolean | null) => {
      const currentIdentity = committedIdentityRef.current;
      if (!currentIdentity) return;
      const previousGeneration = preferenceRef.current?.ownerGeneration;
      preferenceRef.current = preference;
      if (
        previousGeneration &&
        previousGeneration !== preference.ownerGeneration
      ) {
        // A reset/migration creates a new authority generation. Never carry
        // an old exact-attempt retry across that boundary.
        retryPlanRef.current = null;
      }
      if (
        target !== undefined &&
        target !== null &&
        preference.memoryEnabled !== target
      ) {
        const attempt = beginMobileCloudMemoryPreferenceWrite({
          ...currentIdentity,
          preference,
          memoryEnabled: target,
        });
        runWriteRef.current?.(attempt, preference);
        return;
      }
      desiredValueRef.current = null;
      retryPlanRef.current = null;
      setState(syncedMobileCloudMemoryPreference(preference));
    },
    [],
  );

  /**
   * Reconcile from the live view. A failed or still-empty view is retried by
   * reconnecting the live channel; the head it delivers next is settled by
   * the subscription effect.
   */
  const reconcile = useCallback(
    (thenWrite?: boolean) => {
      if (!committedIdentityRef.current || writeInFlightRef.current) return;
      const latest = liveRef.current;
      if (!latest) {
        if (thenWrite !== undefined) desiredValueRef.current = thenWrite;
        retryPlanRef.current =
          thenWrite === undefined
            ? { kind: "load" }
            : { kind: "reload_then_write", memoryEnabled: thenWrite };
        setState(loadingMobileCloudMemoryPreference(preferenceRef.current));
        reconnectBackend();
        return;
      }
      settle(latest, thenWrite ?? desiredValueRef.current);
    },
    [settle],
  );

  useLayoutEffect(() => {
    committedIdentityRef.current = identity;
    activeRequestIdRef.current = null;
    preferenceRef.current = null;
    liveRef.current = null;
    retryPlanRef.current = null;
    desiredValueRef.current = null;
    writeInFlightRef.current = false;
    setState(loadingMobileCloudMemoryPreference());
  }, [identity]);

  useEffect(() => {
    mountedRef.current = true;
    if (!identity && hasSessionIdentity && tokenOwner.unavailable) {
      setState(failedMobileCloudMemoryPreference(null, "load"));
    }
    return () => {
      mountedRef.current = false;
      activeRequestIdRef.current = null;
      writeInFlightRef.current = false;
    };
  }, [hasSessionIdentity, identity, tokenOwner.unavailable]);

  useEffect(() => {
    if (!identity) return;
    if (live.error) {
      liveRef.current = null;
      if (writeInFlightRef.current) return;
      const target = desiredValueRef.current;
      retryPlanRef.current =
        target === null
          ? { kind: "load" }
          : { kind: "reload_then_write", memoryEnabled: target };
      // A head already on screen stays unless the user is waiting on a retry.
      setState((current) =>
        !preferenceRef.current || current.status === "loading"
          ? failedMobileCloudMemoryPreference(
              preferenceRef.current,
              target === null ? "load" : "save",
            )
          : current,
      );
      return;
    }
    if (live.value === undefined) return;
    if (belongsToAnotherOwner(live.value, identity.expectedSubject)) return;
    let preference: MobileCloudMemoryPreference;
    try {
      preference = decodeMobileCloudMemoryPreferenceForSubject(
        live.value,
        identity.expectedSubject,
      );
    } catch {
      liveRef.current = null;
      if (writeInFlightRef.current) return;
      retryPlanRef.current = { kind: "load" };
      setState(failedMobileCloudMemoryPreference(preferenceRef.current, "load"));
      return;
    }
    liveRef.current = preference;
    if (writeInFlightRef.current) {
      const base = preferenceRef.current?.ownerGeneration;
      if (
        base !== undefined &&
        (base === preference.ownerGeneration ||
          followsMobileOwnerGeneration(base, preference.ownerGeneration))
      ) {
        return;
      }
      // The owner generation moved under the write; its result can no longer
      // apply, so drop it and adopt the new head.
      activeRequestIdRef.current = null;
      writeInFlightRef.current = false;
      desiredValueRef.current = null;
      retryPlanRef.current = null;
      preferenceRef.current = preference;
      setState(syncedMobileCloudMemoryPreference(preference));
      return;
    }
    settle(preference, desiredValueRef.current);
  }, [identity, live.error, live.value, settle]);

  const setMemoryEnabled = useCallback((memoryEnabled: boolean) => {
    if (typeof memoryEnabled !== "boolean") return;
    const currentIdentity = committedIdentityRef.current;
    const preference = preferenceRef.current;
    if (!currentIdentity || !preference) return;
    desiredValueRef.current = memoryEnabled;
    if (writeInFlightRef.current) return;
    if (preference.memoryEnabled === memoryEnabled) {
      desiredValueRef.current = null;
      setState(syncedMobileCloudMemoryPreference(preference));
      return;
    }
    const attempt = beginMobileCloudMemoryPreferenceWrite({
      ...currentIdentity,
      preference,
      memoryEnabled,
    });
    runWriteRef.current?.(attempt, preference);
  }, []);

  const retry = useCallback(() => {
    const plan = retryPlanRef.current;
    if (!plan || !committedIdentityRef.current) return;
    if (plan.kind === "load") {
      reconcile();
      return;
    }
    if (plan.kind === "write") {
      desiredValueRef.current = plan.attempt.memoryEnabled;
      runWriteRef.current?.(plan.attempt, plan.base);
      return;
    }
    desiredValueRef.current = plan.memoryEnabled;
    reconcile(plan.memoryEnabled);
  }, [reconcile]);

  return {
    ...state,
    disabled:
      !state.preference ||
      state.status === "loading" ||
      state.status === "saving",
    setMemoryEnabled,
    retry,
  };
};
