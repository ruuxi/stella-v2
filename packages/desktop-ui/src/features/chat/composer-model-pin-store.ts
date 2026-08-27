import { useSyncExternalStore } from "react";
import { uiState } from "@/platform/ui-state";

type Listener = () => void;

const STORAGE_KEY = "stella.composer.modelPickerPinned";

const readPersistedPinned = (): boolean => {
  if (typeof window === "undefined") return false;
  return uiState.getItem(STORAGE_KEY) === "1";
};

const writePersistedPinned = (next: boolean): void => {
  if (typeof window === "undefined") return;
  if (next) uiState.setItem(STORAGE_KEY, "1");
  else uiState.removeItem(STORAGE_KEY);
};

let isPinned = readPersistedPinned();
const listeners = new Set<Listener>();

const emit = (): void => {
  writePersistedPinned(isPinned);
  for (const listener of listeners) listener();
};

const subscribe = (listener: Listener): (() => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

export const composerModelPin = {
  isPinned: (): boolean => isPinned,
  setPinned(next: boolean): void {
    if (next === isPinned) return;
    isPinned = next;
    emit();
  },
  toggle(): void {
    isPinned = !isPinned;
    emit();
  },
};

export function useComposerModelPinned(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => isPinned,
    () => false,
  );
}
