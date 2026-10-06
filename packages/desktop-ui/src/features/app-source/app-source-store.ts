import { useSyncExternalStore } from "react";
import type {
  AppSourceActionResult,
  AppSourceCommit,
  AppSourceDraft,
  AppSourceState,
} from "@stella/contracts/desktop/app-source";
import { isStellaDraft } from "@stella/contracts/desktop/app-source";
import { sidebarSections } from "@/features/workspace-display/sidebar-sections";
import { displayTabs } from "@/features/workspace-display/tab-store";

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
 * Every button here calls one method and is finished with it. Git work the
 * app cannot do alone — a stale draft, a diverged merge, an undo later work
 * conflicts with — is recognised and handed to an agent by the main process,
 * which has the shas and the conflicts in hand. The renderer used to do that
 * by dispatching a sentence into the chat as a hidden user message, so the
 * user read themselves asking for something they had only pressed a button
 * for. Nothing here writes to the conversation now.
 */

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
 * The newest thing an agent's change is on this computer: a draft to apply, a
 * draft whose base moved, or a commit already in the version (applied, or
 * undone again). A change made on another computer is offered by the Updates
 * list, never by the chat.
 */
export const agentChange = (
  state: AppSourceState,
  agentId: string,
): AgentChange | null => {
  const mine = (draft: AppSourceDraft) =>
    draft.agentId === agentId && !isStellaDraft(draft.name);
  const ready = state.ready.find(mine);
  if (ready) return { kind: "ready", draft: ready };
  const stale = state.stale.find(mine);
  if (stale) return { kind: "stale", draft: stale };
  // `recent` is newest first.
  const commit = state.recent.find((entry) => entry.agentId === agentId);
  return commit ? { kind: "applied", commit } : null;
};

/** Offers still waiting for a click: one already being added is not. */
export const waitingCount = (state: AppSourceState) =>
  state.waiting.filter((offer) => !offer.adding).length;

export const openUpdates = () => {
  sidebarSections.selectSection("updates");
  displayTabs.setPanelOpen(true);
};

/**
 * An update Stella is taking by itself, as the state reports it. Whether it
 * needed a merge, and whether an agent is doing it, is the main process's
 * business: the renderer only knows that one is running and then that it
 * landed. There is nothing to press either way.
 */
export const updateProgress = (state: AppSourceState) => state.update ?? null;
