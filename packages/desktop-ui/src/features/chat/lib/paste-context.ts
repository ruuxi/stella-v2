import type { ClipboardEvent, Dispatch, SetStateAction } from "react";
import type { ChatContext } from "@/shared/types/electron";
import { attachFilesToContext } from "./file-attach";

type SetChatContext = Dispatch<SetStateAction<ChatContext | null>>;

export const PASTE_AS_CHIP_MIN_CHARS = 1200;

export const PASTE_AS_CHIP_MIN_LINES = 18;

export const PASTED_TEXT_PREVIEW_MAX_CHARS = 4000;

export type PastedTextDescriptor = {

  text?: string;
  lines: number;
  chars: number;
};

export const toPastedTextDescriptor = (text: string): PastedTextDescriptor => ({
  text: text.slice(0, PASTED_TEXT_PREVIEW_MAX_CHARS),
  lines: text.split(/\r\n|\r|\n/).length,
  chars: text.length,
});

export const describePastedText = (descriptor: PastedTextDescriptor): string =>
  descriptor.lines > 1
    ? `${descriptor.lines.toLocaleString()} lines`
    : `${descriptor.chars.toLocaleString()} chars`;

export const pastedTextPreview = (descriptor: PastedTextDescriptor): string => {
  const text = descriptor.text ?? "";
  if (!text) return "";
  return descriptor.chars > text.length ? `${text}…` : text;
};

export const shouldAttachPastedText = (text: string): boolean => {
  if (!text) return false;
  if (text.length >= PASTE_AS_CHIP_MIN_CHARS) return true;
  return text.split(/\r\n|\r|\n/).length >= PASTE_AS_CHIP_MIN_LINES;
};

export const attachPastedText = (
  text: string,
  setChatContext: SetChatContext,
): void => {
  const trimmed = text.replace(/\s+$/, "");
  if (!trimmed) return;
  setChatContext((prev) => {
    const base: ChatContext = prev ?? { window: null };
    return {
      ...base,
      pastedTexts: [...(base.pastedTexts ?? []), trimmed],
    };
  });
};

export const handleComposerPaste = (
  event: ClipboardEvent<HTMLTextAreaElement>,
  setChatContext: SetChatContext,
): boolean => {
  const clipboard = event.clipboardData;
  if (!clipboard) return false;
  const files = Array.from(clipboard.files ?? []);
  if (files.length > 0) {
    event.preventDefault();
    void attachFilesToContext(files, setChatContext);
    return true;
  }
  const text = clipboard.getData("text/plain");
  if (!shouldAttachPastedText(text)) return false;
  event.preventDefault();
  attachPastedText(text, setChatContext);
  return true;
};
