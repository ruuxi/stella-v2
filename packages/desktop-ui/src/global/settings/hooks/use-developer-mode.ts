import { useEffect } from "react";
import {
  createResourceStore,
  useResourceStore,
} from "@/shared/lib/resource-cache";

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

    });
  });
};

export const readDeveloperModeSnapshot = (): boolean =>
  developerModeStore.get(SINGLETON_KEY).data === true;

export function useDeveloperModeEnabled(): boolean {
  useEffect(subscribeToPreferenceChanges, []);
  const { data } = useResourceStore(developerModeStore, SINGLETON_KEY);
  return data === true;
}
