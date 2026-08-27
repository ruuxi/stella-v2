import { useCallback, useEffect, useRef, useState } from "react";
import { useAction } from "convex/react";
import { api } from "@/convex/api";
import { clearCachedToken } from "@/global/auth/services/auth-token";
import { uiState } from "@/platform/ui-state";
import { useAuthSessionState } from "@/global/auth/hooks/use-auth-session-state";
import {
  readOnboardingPhase,
  useOnboardingState,
} from "@/global/onboarding/use-onboarding-state";
import { SPLIT_PHASES, type Phase } from "@/global/onboarding/onboarding-flow";
import type { StellaAnimationHandle } from "@/shell/aurora/StellaAnimation";

export const CREATURE_INITIAL_SIZE = 0.22;

const deleteIndexedDatabase = (name: string) =>
  new Promise<void>((resolve) => {
    try {
      const request = indexedDB.deleteDatabase(name);
      request.onsuccess = () => resolve();
      request.onerror = () => resolve();
      request.onblocked = () => resolve();
    } catch {
      resolve();
    }
  });

const clearLocalBrowserState = async () => {
  clearCachedToken();

  uiState.clear();

  try {
    localStorage.clear();
  } catch {

  }

  try {
    sessionStorage.clear();
  } catch {

  }

  if (
    typeof indexedDB !== "undefined" &&
    typeof indexedDB.databases === "function"
  ) {
    try {
      const databases = await indexedDB.databases();
      const names = databases
        .map((database) => database.name)
        .filter(
          (name): name is string => typeof name === "string" && name.length > 0,
        );
      await Promise.all(names.map(deleteIndexedDatabase));
    } catch {

    }
  }

  if (typeof caches !== "undefined") {
    try {
      const cacheNames = await caches.keys();
      await Promise.all(
        cacheNames.map((cacheName) => caches.delete(cacheName)),
      );
    } catch {

    }
  }
};

const clearLocalRuntimeState = async () => {
  await clearLocalBrowserState();
  await window.electronAPI?.ui.hardReset?.();
};

export function useOnboardingOverlay() {
  const {
    completed: onboardingDone,
    complete: completeOnboarding,
    reset: resetOnboarding,
    persistPhase,
  } = useOnboardingState();
  const { hasConnectedAccount, isLoading: isAuthLoading } =
    useAuthSessionState();
  const resetUserData = useAction(api.reset.resetAllUserData);

  const resumePhaseRef = useRef<Phase | null>(null);
  if (resumePhaseRef.current === null && !onboardingDone) {
    resumePhaseRef.current = readOnboardingPhase();
  }
  const resumePhase = onboardingDone ? null : resumePhaseRef.current;
  const isResuming = resumePhase !== null;
  const initialPhase: Phase = resumePhase ?? "capabilities";
  const [hasExpanded, setHasExpanded] = useState(
    () => onboardingDone || isResuming,
  );
  const [hasStarted, setHasStarted] = useState(
    () => onboardingDone || isResuming,
  );
  const [splitMode, setSplitMode] = useState(
    () => isResuming && SPLIT_PHASES.has(initialPhase),
  );

  const [splitEntering, setSplitEntering] = useState(false);
  const splitEnterTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [onboardingExiting, setOnboardingExiting] = useState(false);
  const [onboardingKey, setOnboardingKey] = useState(0);
  const stellaAnimationRef = useRef<StellaAnimationHandle | null>(null);
  const exitTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const setPresentation = window.electronAPI?.ui.setOnboardingPresentation;
    if (typeof setPresentation !== "function") return;
    const fullscreen = !(onboardingDone || onboardingExiting);
    void setPresentation(fullscreen);
  }, [onboardingDone, onboardingExiting]);

  const triggerFlash = useCallback(() => {
    stellaAnimationRef.current?.triggerFlash();
  }, []);

  const enterSplit = useCallback(() => {
    setSplitMode(true);
    setSplitEntering(true);
    if (splitEnterTimerRef.current) {
      clearTimeout(splitEnterTimerRef.current);
    }
    splitEnterTimerRef.current = setTimeout(() => {
      setSplitEntering(false);
      splitEnterTimerRef.current = null;
    }, 400);
  }, []);

  const startOnboarding = useCallback(() => {
    setHasStarted(true);
    setHasExpanded(true);
    enterSplit();
  }, [enterSplit]);

  useEffect(
    () => () => {
      if (splitEnterTimerRef.current) {
        clearTimeout(splitEnterTimerRef.current);
        splitEnterTimerRef.current = null;
      }
    },
    [],
  );

  const handleCompleteOnboarding = useCallback(() => {
    if (exitTimerRef.current) return;

    setOnboardingExiting(true);
    exitTimerRef.current = setTimeout(() => {
      setSplitMode(false);
      completeOnboarding();
      setOnboardingExiting(false);
      exitTimerRef.current = null;
    }, 600);
  }, [completeOnboarding]);

  const handleResetOnboarding = useCallback(() => {
    if (exitTimerRef.current) {
      clearTimeout(exitTimerRef.current);
      exitTimerRef.current = null;
    }
    resumePhaseRef.current = null;
    setHasExpanded(false);
    setHasStarted(false);
    setSplitMode(false);
    setOnboardingExiting(false);
    setOnboardingKey((k) => k + 1);
    stellaAnimationRef.current?.reset(CREATURE_INITIAL_SIZE);
    resetOnboarding();

    const finishLocalReset = async () => {
      try {
        await clearLocalRuntimeState();
      } catch (error) {
        console.error(error);
      }
      window.location.reload();
    };

    if (!hasConnectedAccount) {
      void finishLocalReset();
      return;
    }

    resetUserData()
      .catch(console.error)
      .finally(() => {
        void finishLocalReset();
      });
  }, [hasConnectedAccount, resetOnboarding, resetUserData]);

  return {
    onboardingDone,
    onboardingExiting,
    completeOnboarding: handleCompleteOnboarding,
    isAuthenticated: hasConnectedAccount,
    isAuthLoading,
    hasExpanded,
    hasStarted,
    splitMode,
    splitEntering,
    onboardingKey,
    initialPhase,
    persistPhase,
    stellaAnimationRef,
    triggerFlash,
    startOnboarding,
    handleResetOnboarding,
  };
}
