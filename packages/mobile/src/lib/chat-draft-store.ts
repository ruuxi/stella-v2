import { useCallback, useSyncExternalStore } from "react";

/**
 * The composer's text, held outside React state.
 *
 * A keystroke used to set state in the chat thread hook, which re-rendered the
 * thread hooks, the chat screen and the whole chat pane on every character.
 * Now only the input (which subscribes to the text) and components selecting a
 * derived value that actually flipped (empty ⇄ non-empty) re-render. Send,
 * dictation and quoting read and write the current text synchronously.
 */
export type ChatDraftStore = {
  get: () => string;
  set: (next: string | ((previous: string) => string)) => void;
  subscribe: (listener: () => void) => () => void;
};

export const createChatDraftStore = (initial = ""): ChatDraftStore => {
  let value = initial;
  const listeners = new Set<() => void>();
  return {
    get: () => value,
    set: (next) => {
      const resolved = typeof next === "function" ? next(value) : next;
      if (resolved === value) return;
      value = resolved;
      for (const listener of [...listeners]) listener();
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
};

/** The full draft text. Re-renders on every keystroke: for the input only. */
export const useChatDraft = (store: ChatDraftStore): string =>
  useSyncExternalStore(store.subscribe, store.get, store.get);

/**
 * A derived primitive of the draft (e.g. "is it empty"). Re-renders only when
 * the selected value changes, not on every keystroke. `select` must return a
 * primitive so the snapshot is stable between keystrokes.
 */
export const useChatDraftSelector = <T extends string | number | boolean>(
  store: ChatDraftStore,
  select: (draft: string) => T,
): T => {
  const getSnapshot = useCallback(() => select(store.get()), [select, store]);
  return useSyncExternalStore(store.subscribe, getSnapshot, getSnapshot);
};
