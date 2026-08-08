import type { ChatMessage } from "../types";

/**
 * Pick the assistant reply the CarPlay voice loop should auto-speak for the
 * turn it just sent.
 *
 * "Newest assistant row that didn't exist before the send" is NOT the turn's
 * reply on the computer target: the send pipeline's own pre-send sync can
 * merge an OLDER desktop reply the CarPlay thread had simply never pulled,
 * and that history row must not be read out as the answer. When the sent
 * user-message id is known (the send pipeline returns it), the reply is
 * located structurally instead: the first non-empty assistant row AFTER the
 * turn's user bubble. Merged history sorts on its older timestamps above the
 * bubble, so it can never be picked; the turn's streamed reply placeholder
 * (or, if linking failed, the turn's canonical reply row) is the first
 * assistant row below it. Stand-in artifact rows carry empty text and are
 * skipped by the same check.
 *
 * Returns null while the reply hasn't landed yet, so callers keep waiting
 * (grace window) instead of guessing.
 *
 * `priorReplyId` keeps the legacy "newest reply that changed" fallback for
 * the case where no sent-row id is known (a send that never dispatched).
 */
export function pickTurnReply(
  messages: ChatMessage[],
  opts: {
    /** Local id of the just-sent user bubble, if the dispatch reported one. */
    sentUserMessageId: string | null;
    /** Newest assistant reply id snapshotted BEFORE the send (fallback). */
    priorReplyId: string | null;
  },
): ChatMessage | null {
  const { sentUserMessageId, priorReplyId } = opts;
  if (sentUserMessageId) {
    const anchor = messages.findIndex(
      (m) => m.id === sentUserMessageId || m.canonicalId === sentUserMessageId,
    );
    // Anchor not visible yet (a merge is still settling) — wait, don't guess.
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
