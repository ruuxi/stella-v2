import { useCallback, useRef, useState } from "react";
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

  setMessage: Dispatch<SetStateAction<string>>;

  messageRef: MutableRefObject<string>;
}

export function useComposerMessageState(
  initialValue = "",
): ComposerMessageState {
  const [message, setMessageState] = useState(initialValue);
  const messageRef = useRef(message);

  const setMessage = useCallback((action: SetStateAction<string>) => {

    const next = resolveSetStateAction(action, messageRef.current);
    messageRef.current = next;
    setMessageState(next);
  }, []);

  return { message, setMessage, messageRef };
}
