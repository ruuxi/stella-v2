import type { ChatMessage } from "../types";

export function pickTurnReply(
  messages: ChatMessage[],
  opts: {

    sentUserMessageId: string | null;

    priorReplyId: string | null;
  },
): ChatMessage | null {
  const { sentUserMessageId, priorReplyId } = opts;
  if (sentUserMessageId) {
    const anchor = messages.findIndex(
      (m) => m.id === sentUserMessageId || m.canonicalId === sentUserMessageId,
    );

    if (anchor < 0) return null;
    for (let i = anchor + 1; i < messages.length; i++) {
      const message = messages[i];
      if (message.role === "assistant" && message.text.trim().length > 0) {
        return message;
      }
    }
    return null;
  }
  const newest = [...messages]
    .reverse()
    .find((m) => m.role === "assistant" && m.text.trim().length > 0);
  if (!newest || newest.id === priorReplyId) return null;
  return newest;
}
