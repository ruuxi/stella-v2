import { useSyncExternalStore } from "react";

/**
 * Whether the native splash has lifted. Screens that open with a moment of
 * motion (onboarding's greeting) wait for it, so the moment isn't spent
 * underneath the splash while startup state resolves.
 */
let hidden = false;
const listeners = new Set<() => void>();

export function markSplashHidden(): void {
  if (hidden) return;
  hidden = true;
  for (const listener of [...listeners]) listener();
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

const getSnapshot = () => hidden;

export const useSplashHidden = (): boolean =>
  useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
