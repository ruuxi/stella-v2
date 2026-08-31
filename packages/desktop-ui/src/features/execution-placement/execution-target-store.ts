import { useSyncExternalStore } from "react";

export type DesktopExecutionTarget =
  | { mode: "automatic" }
  | { mode: "cloud" }
  | { mode: "device"; deviceId: string };

const STORAGE_KEY = "stella.execution-target.v1";
const AUTOMATIC: DesktopExecutionTarget = Object.freeze({ mode: "automatic" });
let current: DesktopExecutionTarget = AUTOMATIC;
const listeners = new Set<() => void>();

const parse = (value: string | null): DesktopExecutionTarget => {
  if (!value) return AUTOMATIC;
  try {
    const parsed = JSON.parse(value) as Record<string, unknown>;
    if (parsed.mode === "cloud") return { mode: "cloud" };
    if (
      parsed.mode === "device" &&
      typeof parsed.deviceId === "string" &&
      parsed.deviceId.trim()
    ) {
      return { mode: "device", deviceId: parsed.deviceId.trim() };
    }
  } catch {
    // A malformed/stale preference is equivalent to the safe default.
  }
  return AUTOMATIC;
};

if (typeof window !== "undefined") {
  current = parse(window.localStorage.getItem(STORAGE_KEY));
}

export const executionTargetStore = {
  getSnapshot: () => current,
  subscribe(listener: () => void) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
  set(next: DesktopExecutionTarget) {
    const normalized = parse(JSON.stringify(next));
    if (JSON.stringify(normalized) === JSON.stringify(current)) return;
    current = normalized;
    if (typeof window !== "undefined") {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(normalized));
    }
    for (const listener of listeners) listener();
  },
  reset() {
    executionTargetStore.set(AUTOMATIC);
  },
};

export const getExecutionTargetSnapshot = () => current;

export const useExecutionTarget = (): DesktopExecutionTarget =>
  useSyncExternalStore(
    executionTargetStore.subscribe,
    executionTargetStore.getSnapshot,
    () => AUTOMATIC,
  );
