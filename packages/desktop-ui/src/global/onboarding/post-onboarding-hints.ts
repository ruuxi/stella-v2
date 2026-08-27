import { useCallback, useSyncExternalStore } from "react";
import { uiState } from "@/platform/ui-state";

const STORAGE_KEY = "stella:post-onboarding-hints";
const CHANGE_EVENT = "stella:post-onboarding-hints-changed";

export type PostOnboardingHintId = "connect";

const ALL_HINT_IDS: readonly PostOnboardingHintId[] = ["connect"];

type StoredState = {
  seededAt: number;
  active: Partial<Record<PostOnboardingHintId, true>>;
};

const EMPTY_STATE: StoredState = { seededAt: 0, active: {} };

const safeRead = (): StoredState => {
  if (typeof window === "undefined") return EMPTY_STATE;
  try {
    const raw = uiState.getItem(STORAGE_KEY);
    if (!raw) return EMPTY_STATE;
    const parsed = JSON.parse(raw) as Partial<StoredState>;
    if (typeof parsed !== "object" || parsed === null) return EMPTY_STATE;
    return {
      seededAt: typeof parsed.seededAt === "number" ? parsed.seededAt : 0,
      active:
        parsed.active && typeof parsed.active === "object"
          ? (parsed.active as StoredState["active"])
          : {},
    };
  } catch {
    return EMPTY_STATE;
  }
};

const safeWrite = (state: StoredState): void => {
  if (typeof window === "undefined") return;
  uiState.setItem(STORAGE_KEY, JSON.stringify(state));
};

const subscribers = new Set<() => void>();
let listenersAttached = false;

const handleStorageEvent = (event: StorageEvent) => {
  if (event.key !== STORAGE_KEY) return;
  for (const notify of subscribers) notify();
};

const handleCustomEvent = () => {
  for (const notify of subscribers) notify();
};

const attachListeners = () => {
  if (listenersAttached || typeof window === "undefined") return;
  listenersAttached = true;
  window.addEventListener("storage", handleStorageEvent);
  window.addEventListener(CHANGE_EVENT, handleCustomEvent);
};

const detachListeners = () => {
  if (!listenersAttached || typeof window === "undefined") return;
  if (subscribers.size > 0) return;
  listenersAttached = false;
  window.removeEventListener("storage", handleStorageEvent);
  window.removeEventListener(CHANGE_EVENT, handleCustomEvent);
};

const subscribe = (notify: () => void) => {
  subscribers.add(notify);
  attachListeners();
  return () => {
    subscribers.delete(notify);
    detachListeners();
  };
};

const notifyAll = () => {
  if (typeof window !== "undefined") {
    window.dispatchEvent(new Event(CHANGE_EVENT));
  }
  for (const notify of subscribers) notify();
};

export const seedPostOnboardingHints = (): void => {
  const state = safeRead();
  if (state.seededAt > 0) return;
  const active: StoredState["active"] = {};
  for (const id of ALL_HINT_IDS) active[id] = true;
  safeWrite({ seededAt: Date.now(), active });
  notifyAll();
};

export const clearPostOnboardingHints = (): void => {
  safeWrite(EMPTY_STATE);
  notifyAll();
};

export const dismissPostOnboardingHint = (id: PostOnboardingHintId): void => {
  const state = safeRead();
  if (!state.active[id]) return;
  const nextActive = { ...state.active };
  delete nextActive[id];
  safeWrite({ ...state, active: nextActive });
  notifyAll();
};

const getHintSnapshot = (id: PostOnboardingHintId): boolean => {
  return Boolean(safeRead().active[id]);
};

const getServerSnapshot = () => false;

export function usePostOnboardingHint(
  id: PostOnboardingHintId,
): { active: boolean; dismiss: () => void } {
  const active = useSyncExternalStore(
    subscribe,
    useCallback(() => getHintSnapshot(id), [id]),
    getServerSnapshot,
  );
  const dismiss = useCallback(() => dismissPostOnboardingHint(id), [id]);
  return { active, dismiss };
}
