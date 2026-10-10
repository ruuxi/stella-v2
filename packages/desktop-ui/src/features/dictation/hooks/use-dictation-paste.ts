import { useEffect, useRef, type Dispatch, type SetStateAction } from "react";
import type { ChatContext } from "@/shared/types/electron";
import { attachFilesToContext } from "@/features/chat/lib/file-attach";
import {
  attachPastedText,
  shouldAttachPastedText,
} from "@/features/chat/lib/paste-context";

type UseDictationPasteOptions = {
  active: boolean;
  setMessage: Dispatch<SetStateAction<string>>;
  setChatContext: Dispatch<SetStateAction<ChatContext | null>>;
};

const isEditableTarget = (target: EventTarget | null): boolean => {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  return tag === "TEXTAREA" || tag === "INPUT" || tag === "SELECT";
};

export const useDictationPaste = ({
  active,
  setMessage,
  setChatContext,
}: UseDictationPasteOptions): void => {
  const setMessageRef = useRef(setMessage);
  const setChatContextRef = useRef(setChatContext);
  setMessageRef.current = setMessage;
  setChatContextRef.current = setChatContext;

  useEffect(() => {
    if (!active) return;
    const onPaste = (event: ClipboardEvent) => {
      if (event.defaultPrevented || isEditableTarget(event.target)) return;
      const clipboard = event.clipboardData;
      if (!clipboard) return;
      const files = Array.from(clipboard.files ?? []);
      if (files.length > 0) {
        event.preventDefault();
        void attachFilesToContext(files, setChatContextRef.current);
        return;
      }
      const text = clipboard.getData("text/plain");
      if (!text) return;
      event.preventDefault();
      if (shouldAttachPastedText(text)) {
        attachPastedText(text, setChatContextRef.current);
        return;
      }
      setMessageRef.current((current) => `${current}${text}`);
    };
    document.addEventListener("paste", onPaste);
    return () => document.removeEventListener("paste", onPaste);
  }, [active]);
};
