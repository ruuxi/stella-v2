import AsyncStorage from "@react-native-async-storage/async-storage";
import { useEffect, useSyncExternalStore } from "react";

const STORAGE_KEY = "stella-mobile.composer-model-picker-pinned";

let pinned = false;
let loaded = false;
let loadPromise: Promise<boolean> | null = null;
const listeners = new Set<() => void>();

const emit = () => {
  for (const listener of listeners) listener();
};

export function loadComposerModelPinned(): Promise<boolean> {
  if (loaded) return Promise.resolve(pinned);
  if (loadPromise) return loadPromise;
  loadPromise = AsyncStorage.getItem(STORAGE_KEY)
    .then((value) => {
      pinned = value === "1";
      loaded = true;
      emit();
      return pinned;
    })
    .catch(() => {
      pinned = false;
      loaded = true;
      emit();
      return false;
    })
    .finally(() => {
      loadPromise = null;
    });
  return loadPromise;
}

export function setComposerModelPinned(next: boolean): void {
  if (loaded && pinned === next) return;
  pinned = next;
  loaded = true;
  emit();
  void (
    next
      ? AsyncStorage.setItem(STORAGE_KEY, "1")
      : AsyncStorage.removeItem(STORAGE_KEY)
  ).catch(() => undefined);
}

export function useComposerModelPinned(): boolean {
  const value = useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => pinned,
    () => false,
  );

  useEffect(() => {
    void loadComposerModelPinned();
  }, []);

  return value;
}
