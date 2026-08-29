import { useSyncExternalStore } from "react";
import { AppState, type AppStateStatus } from "react-native";

import { isAppVisible } from "./continuous-animation";

/**
 * One AppState subscription shared by every animated component, so a screen full
 * of shimmering rows does not register a listener each.
 */
let visible = isAppVisible(AppState.currentState);
const listeners = new Set<() => void>();
let subscription: { remove: () => void } | null = null;

const publish = (next: AppStateStatus) => {
  const nextVisible = isAppVisible(next);
  if (nextVisible === visible) return;
  visible = nextVisible;
  for (const listener of listeners) listener();
};

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  if (listeners.size === 1) {
    visible = isAppVisible(AppState.currentState);
    subscription = AppState.addEventListener("change", publish);
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) {
      subscription?.remove();
      subscription = null;
    }
  };
};

const getSnapshot = () => visible;

export const useAppVisible = (): boolean =>
  useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
