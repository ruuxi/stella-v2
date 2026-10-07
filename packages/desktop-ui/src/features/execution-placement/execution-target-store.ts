import { useSyncExternalStore } from "react";
import { getAuthSessionSnapshot } from "@/global/auth/services/auth-session";
import { isConnectedAccountSession } from "@/global/auth/hooks/use-auth-session-state";

export type DesktopExecutionTarget =
  | { mode: "automatic" }
  | { mode: "cloud" }
  | { mode: "device"; deviceId: string };

const STORAGE_KEY = "stella.execution-target.v1";
export const AUTOMATIC_EXECUTION_TARGET: DesktopExecutionTarget = Object.freeze({
  mode: "automatic",
});
const AUTOMATIC = AUTOMATIC_EXECUTION_TARGET;
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
    return AUTOMATIC;
  } catch {
    return AUTOMATIC;
  }
};

const readStoredTarget = (): DesktopExecutionTarget => {
  if (typeof window === "undefined") return AUTOMATIC;
  try {
    return parse(window.localStorage.getItem(STORAGE_KEY));
  } catch {
    return AUTOMATIC;
  }
};

const storeTarget = (target: DesktopExecutionTarget): void => {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(target));
  } catch {
    // localStorage can throw in restricted contexts.
  }
};

current = readStoredTarget();

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
    storeTarget(normalized);
    for (const listener of listeners) listener();
  },
};

if (typeof window !== "undefined") {
  window.electronAPI?.executionTarget?.onSet((payload) => {
    if (payload && typeof payload === "object" && payload.target) {
      executionTargetStore.set(payload.target);
    }
  });
}

/**
 * The target a send carries. Cloud and other computers run under a signed-in
 * account (the runtime's placement bridge refuses signed-out runtimes), so a
 * signed-out send runs here; the stored choice applies again after sign-in.
 */
export const getExecutionTargetSnapshot = (): DesktopExecutionTarget =>
  isConnectedAccountSession(getAuthSessionSnapshot().data) ? current : AUTOMATIC;

export const useExecutionTarget = (): DesktopExecutionTarget =>
  useSyncExternalStore(
    executionTargetStore.subscribe,
    executionTargetStore.getSnapshot,
    () => AUTOMATIC,
  );
