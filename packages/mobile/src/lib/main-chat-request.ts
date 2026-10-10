import { useSyncExternalStore } from "react";

let requested = false;
const listeners = new Set<() => void>();

const publish = (next: boolean) => {
  if (requested === next) return;
  requested = next;
  for (const listener of listeners) listener();
};

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

const getSnapshot = () => requested;

export function requestMainChat(): void {
  publish(true);
}

export function takeMainChatRequest(): boolean {
  const was = requested;
  publish(false);
  return was;
}

export function useMainChatRequested(): boolean {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
