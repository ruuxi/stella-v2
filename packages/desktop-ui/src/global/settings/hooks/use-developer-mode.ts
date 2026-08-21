import { useEffect } from "react";
import {
  createResourceStore,
  useResourceStore,
} from "@/shared/lib/resource-cache";

/**
 * Developer mode — the single flag that surfaces every power-user control:
 * the Models picker, BYOK provider configuration, the composer mini picker,
 * and the @-model mention menu. The authoritative value lives in the local
 * preferences file (main process / runtime); this store is the renderer's
 * shared, synchronous view of it.
 *
 * All preference writes in the app already dispatch
 * `stella:local-model-preferences-changed`, which invalidates this store, so
 * toggling the setting re-gates every mounted surface without a reload.
 */

export const LOCAL_MODEL_PREFERENCES_CHANGED_EVENT =
  "stella:local-model-preferences-changed";

const SINGLETON_KEY = "default" as const;

const developerModeStore = createResourceStore<
  typeof SINGLETON_KEY,
  boolean
>({
  fetcher: async () => {
    const prefs =
      await window.electronAPI?.system?.getLocalModelPreferences?.();
    return prefs?.developerModeEnabled === true;
  },
});

let subscribedToPreferenceChanges = false;
const subscribeToPreferenceChanges = () => {
  if (subscribedToPreferenceChanges || typeof window === "undefined") return;
  subscribedToPreferenceChanges = true;
  window.addEventListener(LOCAL_MODEL_PREFERENCES_CHANGED_EVENT, () => {
    developerModeStore.invalidate(SINGLETON_KEY);
    void developerModeStore.ensure(SINGLETON_KEY).catch(() => {
      /* error captured on the store entry */
    });
  });
};

/** Module-scope snapshot for non-React callers (toast action builders). */
export const readDeveloperModeSnapshot = (): boolean =>
  developerModeStore.get(SINGLETON_KEY).data === true;

/**
 * True only once the flag has loaded as enabled. While loading (or on IPC
 * failure) power-user surfaces stay hidden — the default experience.
 */
export function useDeveloperModeEnabled(): boolean {
  useEffect(subscribeToPreferenceChanges, []);
  const { data } = useResourceStore(developerModeStore, SINGLETON_KEY);
  return data === true;
}
