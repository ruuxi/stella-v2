import { useCallback, useEffect, useSyncExternalStore } from "react";
import { uiState } from "@/platform/ui-state";
import { SPLIT_STEP_ORDER, type Phase } from "./onboarding-flow";
import {
  clearPostOnboardingHints,
  seedPostOnboardingHints,
} from "./post-onboarding-hints";

const ONBOARDING_COMPLETE_KEY = "stella-onboarding-complete";

const ONBOARDING_PHASE_KEY = "stella-onboarding-phase";
const ONBOARDING_COMPLETE_EVENT = "stella:onboarding-complete-changed";

export const readLocalOnboardingCompleted = () => {
  return uiState.getItem(ONBOARDING_COMPLETE_KEY) === "true";
};

const writeLocalOnboardingCompleted = (completed: boolean) => {
  if (completed) {
    uiState.setItem(ONBOARDING_COMPLETE_KEY, "true");
    return;
  }
  uiState.removeItem(ONBOARDING_COMPLETE_KEY);
};

const SPLIT_PHASE_SET = new Set<Phase>(SPLIT_STEP_ORDER);

export const readOnboardingPhase = (): Phase | null => {
  const raw = uiState.getItem(ONBOARDING_PHASE_KEY);
  if (!raw) return null;
  if (!SPLIT_PHASE_SET.has(raw as Phase)) {
    uiState.removeItem(ONBOARDING_PHASE_KEY);
    return null;
  }
  return raw as Phase;
};

const writeOnboardingPhase = (phase: Phase | null) => {
  if (!phase || !SPLIT_PHASE_SET.has(phase)) {
    uiState.removeItem(ONBOARDING_PHASE_KEY);
    return;
  }
  uiState.setItem(ONBOARDING_PHASE_KEY, phase);
};

const subscribers = new Set<() => void>();
let listenersAttached = false;
let durableHydrated = false;
let durableCompleted = false;
let durableRevision = 0;
let hydrationPromise: Promise<void> | null = null;

const handleStorageEvent = (event: StorageEvent) => {
  if (event.key !== ONBOARDING_COMPLETE_KEY) return;
  for (const notify of subscribers) notify();
};

const handleCustomEvent = () => {
  for (const notify of subscribers) notify();
};

const attachWindowListeners = () => {
  if (listenersAttached || typeof window === "undefined") return;
  listenersAttached = true;
  window.addEventListener("storage", handleStorageEvent);
  window.addEventListener(ONBOARDING_COMPLETE_EVENT, handleCustomEvent);
};

const detachWindowListeners = () => {
  if (!listenersAttached || typeof window === "undefined") return;
  if (subscribers.size > 0) return;
  listenersAttached = false;
  window.removeEventListener("storage", handleStorageEvent);
  window.removeEventListener(ONBOARDING_COMPLETE_EVENT, handleCustomEvent);
};

const subscribe = (notify: () => void) => {
  subscribers.add(notify);
  attachWindowListeners();
  return () => {
    subscribers.delete(notify);
    detachWindowListeners();
  };
};

const getSnapshot = () =>
  durableHydrated ? durableCompleted : readLocalOnboardingCompleted();
const getHydratedSnapshot = () => durableHydrated;
const getServerSnapshot = () => false;

const notifyAll = () => {
  for (const notify of subscribers) notify();
};

const hydrateOnboardingCompleted = async () => {
  if (typeof window === "undefined") return;
  if (durableHydrated) return;
  if (hydrationPromise) return hydrationPromise;

  hydrationPromise = (async () => {
    const revisionAtStart = durableRevision;
    const localCompleted = readLocalOnboardingCompleted();
    const preferencesApi = window.electronAPI?.system;

    if (!preferencesApi?.getOnboardingCompleted) {
      durableCompleted = localCompleted;
      durableHydrated = true;
      notifyAll();
      return;
    }

    try {
      const persistedCompleted =
        (await preferencesApi.getOnboardingCompleted()) === true;

      if (revisionAtStart !== durableRevision) {
        durableHydrated = true;
        notifyAll();
        return;
      }

      const nextCompleted = persistedCompleted || localCompleted;
      durableCompleted = nextCompleted;
      durableHydrated = true;
      writeLocalOnboardingCompleted(nextCompleted);

      if (
        localCompleted &&
        !persistedCompleted &&
        preferencesApi.setOnboardingCompleted
      ) {
        void preferencesApi.setOnboardingCompleted(true).catch((error) => {
          console.warn("Failed to migrate onboarding completion", error);
        });
      }
    } catch (error) {
      console.warn("Failed to hydrate onboarding completion", error);
      durableCompleted = localCompleted;
      durableHydrated = true;
    } finally {
      notifyAll();
      hydrationPromise = null;
    }
  })();

  return hydrationPromise;
};

export function useOnboardingState() {
  const completed = useSyncExternalStore(
    subscribe,
    getSnapshot,
    getServerSnapshot,
  );
  const hydrated = useSyncExternalStore(
    subscribe,
    getHydratedSnapshot,
    getServerSnapshot,
  );

  useEffect(() => {
    void hydrateOnboardingCompleted();
  }, []);

  const complete = useCallback(() => {
    durableRevision += 1;
    durableCompleted = true;
    durableHydrated = true;
    writeLocalOnboardingCompleted(true);
    writeOnboardingPhase(null);

    seedPostOnboardingHints();
    window.dispatchEvent(new Event(ONBOARDING_COMPLETE_EVENT));
    notifyAll();
    void window.electronAPI?.system
      .setOnboardingCompleted?.(true)
      .catch((error) => {
        console.warn("Failed to persist onboarding completion", error);
      });
  }, []);

  const reset = useCallback(() => {
    durableRevision += 1;
    durableCompleted = false;
    durableHydrated = true;
    writeLocalOnboardingCompleted(false);
    writeOnboardingPhase(null);

    clearPostOnboardingHints();
    window.dispatchEvent(new Event(ONBOARDING_COMPLETE_EVENT));
    notifyAll();
    void window.electronAPI?.system
      .setOnboardingCompleted?.(false)
      .catch((error) => {
        console.warn("Failed to reset onboarding completion", error);
      });
  }, []);

  const persistPhase = useCallback((phase: Phase | null) => {
    writeOnboardingPhase(phase);
  }, []);

  return { completed, hydrated, complete, reset, persistPhase };
}
