import { useCallback, useEffect, useSyncExternalStore } from "react";
import { uiState } from "@/platform/ui-state";
import {
  clearPostOnboardingHints,
  seedPostOnboardingHints,
} from "./post-onboarding-hints";

const ONBOARDING_COMPLETE_KEY = "stella-onboarding-complete";
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

/**
 * Module-level subscription so multiple consumers (`FullShell`, the
 * onboarding overlay hook, anything else) share a single pair of
 * `storage`/custom-event listeners on `window`. Previously each call
 * site registered its own pair, racing two independent boolean copies
 * for the same flag.
 */
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
    // Seed the one-time post-onboarding sidebar hints.
    // Idempotent — re-completing onboarding without a reset is a no-op.
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
    // Reset clears the seeded marker too so the next completion re-shows
    // the post-onboarding hints, matching brand-new-install behavior.
    clearPostOnboardingHints();
    window.dispatchEvent(new Event(ONBOARDING_COMPLETE_EVENT));
    notifyAll();
    void window.electronAPI?.system
      .setOnboardingCompleted?.(false)
      .catch((error) => {
        console.warn("Failed to reset onboarding completion", error);
      });
  }, []);

  return { completed, hydrated, complete, reset };
}
