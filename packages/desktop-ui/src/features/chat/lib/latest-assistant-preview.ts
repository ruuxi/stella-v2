import type { MessageRecord } from "@stella/contracts/local-chat";
import { stripMarkdownForTts } from "@/features/voice/services/read-aloud/markdown-strip";

export type LatestAssistantPreview = {
  id: string;
  text: string;
};

const getAssistantPayloadText = (message: MessageRecord): string => {
  if (message.type !== "assistant_message") return "";
  const payload = message.payload;
  if (!payload || typeof payload !== "object") return "";
  const text = (payload as { text?: unknown }).text;
  return typeof text === "string" ? text.trim() : "";
};

export const getLatestAssistantPreview = (
  messages: MessageRecord[],
): LatestAssistantPreview | null => {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    const raw = getAssistantPayloadText(message);
    if (!raw) continue;
    const plain = stripMarkdownForTts(raw).replace(/\s+/g, " ").trim();
    if (!plain) return null;
    return { id: message._id, text: plain };
  }
  return null;
};
