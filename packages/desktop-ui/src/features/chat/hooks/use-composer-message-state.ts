/**
 * Composer message state with a companion ref that is synchronized at WRITE
 * time, not render time.
 *
 * Why: the dictate-and-submit flow appends the final transcript via
 * `setMessage(...)` from an async (non-React-event) callback and then fires
 * the send commit on a microtask + requestAnimationFrame. React schedules the
 * corresponding re-render as a normal scheduler (macro)task, and the event
 * loop is allowed to run the rAF callback first whenever a frame deadline
 * lands before that task is dequeued. A ref refreshed in the render body
 * (`ref.current = message`) is therefore still holding the PRE-transcript
 * text when the commit reads it — the send goes out empty (and silently
 * no-ops), while the transcript renders into the composer afterwards and just
 * sits there unsent.
 *
 * Updating the ref synchronously inside the setter makes the send path
 * deterministic: whoever reads `messageRef.current` sees every write that
 * happened before the read, regardless of whether React has rendered yet.
 * All writes must flow through the returned `setMessage` for the ref to stay
 * authoritative.
 */

import { useCallback, useRef, useState, useSyncExternalStore } from "react";
import type { Dispatch, MutableRefObject, SetStateAction } from "react";

export const resolveSetStateAction = <T,>(
  action: SetStateAction<T>,
  current: T,
): T =>
  typeof action === "function"
    ? (action as (prev: T) => T)(current)
    : action;

export interface ComposerMessageState {
  message: string;
  /** Drop-in `Dispatch<SetStateAction<string>>`; also syncs `messageRef`. */
  setMessage: Dispatch<SetStateAction<string>>;
  /** Always-current mirror of the message — safe to read from rAF/microtask
   *  callbacks that may run before React flushes the corresponding render. */
  messageRef: MutableRefObject<string>;
}

export function useComposerMessageState(
  initialValue = "",
): ComposerMessageState {
  const [message, setMessageState] = useState(initialValue);
  const messageRef = useRef(message);

  const setMessage = useCallback((action: SetStateAction<string>) => {
    // Resolve functional updaters against the ref (the latest written value)
    // and hand React the resolved string so state and ref can never disagree.
    const next = resolveSetStateAction(action, messageRef.current);
    messageRef.current = next;
    setMessageState(next);
  }, []);

  return { message, setMessage, messageRef };
}

/**
 * Read-only subscription handle for composer text held outside React state.
 * Only the leaf that paints the textarea subscribes to the full string;
 * owners subscribe to derived facts (e.g. "has text") that change rarely.
 */
export interface ComposerMessageStore {
  getSnapshot: () => string;
  subscribe: (listener: () => void) => () => void;
}

export interface ComposerMessageStoreState {
  /** Stable for the owner's lifetime. */
  store: ComposerMessageStore;
  /** Drop-in `Dispatch<SetStateAction<string>>`; also syncs `messageRef`. */
  setMessage: Dispatch<SetStateAction<string>>;
  /** Always-current mirror of the message (same contract as above). */
  messageRef: MutableRefObject<string>;
}

const createComposerMessageStore = (
  initialValue: string,
): ComposerMessageStoreState => {
  const messageRef: MutableRefObject<string> = { current: initialValue };
  const listeners = new Set<() => void>();
  return {
    store: {
      getSnapshot: () => messageRef.current,
      subscribe: (listener) => {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
    },
    setMessage: (action) => {
      const next = resolveSetStateAction(action, messageRef.current);
      if (next === messageRef.current) return;
      messageRef.current = next;
      for (const listener of [...listeners]) listener();
    },
    messageRef,
  };
};

/**
 * Store-backed variant of `useComposerMessageState` for owners that sit high
 * in the tree. Keeping the text in React state there re-rendered the owner and
 * every consumer of the value it publishes on each keystroke; here a write
 * only notifies subscribers, so a keystroke re-renders the composer leaf and
 * nothing above it. The write-time ref contract is unchanged: the ref IS the
 * store's value, updated synchronously before listeners run.
 */
export function useComposerMessageStore(
  initialValue = "",
): ComposerMessageStoreState {
  const [state] = useState(() => createComposerMessageStore(initialValue));
  return state;
}

/** Subscribes to the full composer text. Use only in the composer leaf. */
export const useComposerMessage = (store: ComposerMessageStore): string =>
  useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);

/**
 * Subscribes to a derived value of the composer text. The component
 * re-renders only when `select` returns a different primitive.
 */
export const useComposerMessageSelector = <T,>(
  store: ComposerMessageStore,
  select: (message: string) => T,
): T => {
  const getSelected = () => select(store.getSnapshot());
  return useSyncExternalStore(store.subscribe, getSelected, getSelected);
};
