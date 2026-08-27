import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { AppState } from "react-native";
import type { CloudConversationIdentity } from "./cloud-conversation-auth";
import {
  MobileCloudMemoryPreferenceError,
  acceptCurrentMobileCloudMemoryPreferenceResult,
  beginMobileCloudMemoryPreferenceWrite,
  createMobileCloudMemoryPreferenceRequestFence,
  type MobileCloudMemoryPreference,
  type MobileCloudMemoryPreferenceWriteAttempt,
} from "./cloud-memory-preference";
import { mobileCloudMemoryPreferenceClient } from "./cloud-memory-preference-convex";
import {
  failedMobileCloudMemoryPreference,
  loadingMobileCloudMemoryPreference,
  savingMobileCloudMemoryPreference,
  syncedMobileCloudMemoryPreference,
  type MobileCloudMemoryPreferenceUiState,
} from "./cloud-memory-preference-ui-state";
import { useConvexTokenOwner } from "./use-convex-token-owner";

const PREFERENCE_REFRESH_MS = 30_000;

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

/**
 * Session/request/generation-fenced CAS controller for the mobile Memory
 * switch. Its caller also keys the component by the full Better Auth session,
 * so an account transition cannot paint the prior owner's setting.
 */
export const useCloudMemoryPreference = (
  sessionIdentity: CloudConversationIdentity | null,
): MobileCloudMemoryPreferenceView => {
  const tokenOwner = useConvexTokenOwner(sessionIdentity);
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
  const committedIdentityRef = useRef<PreferenceIdentity | null>(identity);
  const activeRequestIdRef = useRef<string | null>(null);
  const preferenceRef = useRef<MobileCloudMemoryPreference | null>(null);
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
      void mobileCloudMemoryPreferenceClient.write(attempt).then(
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

  const load = useCallback(
    (options: { thenWrite?: boolean; silent?: boolean } = {}) => {
      const currentIdentity = committedIdentityRef.current;
      if (!currentIdentity || writeInFlightRef.current) return;
      const fence =
        createMobileCloudMemoryPreferenceRequestFence(currentIdentity);
      activeRequestIdRef.current = fence.requestId;
      retryPlanRef.current = null;
      if (!options.silent) {
        setState(loadingMobileCloudMemoryPreference(preferenceRef.current));
      }
      void mobileCloudMemoryPreferenceClient.read(fence).then(
        (result) => {
          const liveIdentity = committedIdentityRef.current;
          const accepted = acceptCurrentMobileCloudMemoryPreferenceResult(
            result,
            {
              accountScope: liveIdentity?.accountScope,
              identityKey: liveIdentity?.identityKey,
              identityRevision: liveIdentity?.identityRevision,
              expectedSubject: liveIdentity?.expectedSubject,
              requestId: activeRequestIdRef.current,
            },
          );
          if (!accepted) return;
          const previousGeneration = preferenceRef.current?.ownerGeneration;
          preferenceRef.current = accepted.preference;
          if (
            previousGeneration &&
            previousGeneration !== accepted.preference.ownerGeneration
          ) {
            // A reset/migration creates a new authority generation. Never
            // carry an old exact-attempt retry across that boundary.
            retryPlanRef.current = null;
          }
          const target =
            options.thenWrite ?? desiredValueRef.current ?? undefined;
          if (
            target !== undefined &&
            accepted.preference.memoryEnabled !== target &&
            liveIdentity
          ) {
            const attempt = beginMobileCloudMemoryPreferenceWrite({
              ...liveIdentity,
              preference: accepted.preference,
              memoryEnabled: target,
            });
            runWriteRef.current?.(attempt, accepted.preference);
            return;
          }
          desiredValueRef.current = null;
          setState(syncedMobileCloudMemoryPreference(accepted.preference));
        },
        () => {
          if (!requestIsCurrent(fence)) return;
          const target = options.thenWrite ?? desiredValueRef.current;
          retryPlanRef.current =
            target === undefined || target === null
              ? { kind: "load" }
              : { kind: "reload_then_write", memoryEnabled: target };
          if (!options.silent || !preferenceRef.current) {
            setState(
              failedMobileCloudMemoryPreference(
                preferenceRef.current,
                target === undefined || target === null ? "load" : "save",
              ),
            );
          }
        },
      );
    },
    [requestIsCurrent],
  );

  useLayoutEffect(() => {
    committedIdentityRef.current = identity;
    activeRequestIdRef.current = null;
    preferenceRef.current = null;
    retryPlanRef.current = null;
    desiredValueRef.current = null;
    writeInFlightRef.current = false;
    setState(loadingMobileCloudMemoryPreference());
  }, [identity]);

  useEffect(() => {
    mountedRef.current = true;
    if (identity) load();
    else if (hasSessionIdentity && tokenOwner.unavailable) {
      setState(failedMobileCloudMemoryPreference(null, "load"));
    }
    return () => {
      mountedRef.current = false;
      activeRequestIdRef.current = null;
      writeInFlightRef.current = false;
    };
  }, [hasSessionIdentity, identity, load, tokenOwner.unavailable]);

  useEffect(() => {
    if (!identity) return;
    const interval = setInterval(
      () => load({ silent: true }),
      PREFERENCE_REFRESH_MS,
    );
    const subscription = AppState.addEventListener("change", (nextState) => {
      if (nextState === "active") load({ silent: true });
    });
    return () => {
      clearInterval(interval);
      subscription.remove();
    };
  }, [identity, load]);

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
      load();
      return;
    }
    if (plan.kind === "write") {
      desiredValueRef.current = plan.attempt.memoryEnabled;
      runWriteRef.current?.(plan.attempt, plan.base);
      return;
    }
    desiredValueRef.current = plan.memoryEnabled;
    load({ thenWrite: plan.memoryEnabled });
  }, [load]);

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
