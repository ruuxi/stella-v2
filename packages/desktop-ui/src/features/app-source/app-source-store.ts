import { useSyncExternalStore } from "react";
import type {
  AppSourceActionResult,
  AppSourceCommit,
  AppSourceDraft,
  AppSourceState,
} from "@stella/contracts/desktop/app-source";

/**
 * The app's own source state (drafts to apply, recent changes, the user's
 * other computers, published updates) when Stella runs from source. One
 * subscription for every card that shows a piece of it; `null` when Stella
 * doesn't run from source.
 */

let snapshot: AppSourceState | null = null;
let started = false;
const listeners = new Set<() => void>();

const emit = (next: AppSourceState) => {
  snapshot = next;
  for (const listener of listeners) listener();
};

const start = () => {
  const api = window.electronAPI?.appSource;
  if (started || !api) return;
  started = true;
  api.onState(emit);
  void api
    .getState()
    .then((next) => {
      if (next) emit(next);
    })
    .catch(() => {});
};

const subscribe = (listener: () => void) => {
  start();
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

export const useAppSourceState = () =>
  useSyncExternalStore(subscribe, () => snapshot);

export const appSourceApi = () => window.electronAPI?.appSource ?? null;

/**
 * The card whose action is running, by key. Shared, because the same card can
 * be mounted twice (the chat column under the home screen, and the home screen).
 */
let pending: string | null = null;
const pendingListeners = new Set<() => void>();
const setPending = (next: string | null) => {
  pending = next;
  for (const listener of pendingListeners) listener();
};
const subscribePending = (listener: () => void) => {
  pendingListeners.add(listener);
  return () => {
    pendingListeners.delete(listener);
  };
};

export const usePendingAppSourceAction = () =>
  useSyncExternalStore(subscribePending, () => pending);

export const runAppSourceAction = async (
  key: string,
  action: () => Promise<AppSourceActionResult>,
): Promise<AppSourceActionResult> => {
  setPending(key);
  try {
    return await action();
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  } finally {
    setPending(null);
  }
};

/** What the chat shows for an agent's change to Stella. */
export type AgentChange =
  | { kind: "ready"; draft: AppSourceDraft }
  | { kind: "stale"; draft: AppSourceDraft }
  | { kind: "applied"; commit: AppSourceCommit };

/**
 * The newest thing an agent's change is: a draft to apply, a draft whose base
 * moved, or a commit already in the version (applied, or undone again).
 */
export const agentChange = (
  state: AppSourceState,
  agentId: string,
): AgentChange | null => {
  const ready = state.ready.find((draft) => draft.agentId === agentId);
  if (ready) return { kind: "ready", draft: ready };
  const stale = state.stale.find((draft) => draft.agentId === agentId);
  if (stale) return { kind: "stale", draft: stale };
  // `recent` is newest first.
  const commit = state.recent.find((entry) => entry.agentId === agentId);
  return commit ? { kind: "applied", commit } : null;
};
