import type { ChatMessage } from "../types";
import { isStandInArtifactRow } from "./message-row-identity";

/**
 * Order the transcript by `createdAt` so a synced row lands in its true
 * chronological slot rather than wherever it happened to be appended. The sort
 * is stable (original index breaks ties) and tolerant of legacy rows that
 * predate `createdAt`: a missing timestamp carries forward from the previous
 * row, keeping un-stamped history anchored to its neighbours instead of
 * collapsing to the top.
 */
const sortByCreatedAt = (messages: ChatMessage[]): ChatMessage[] => {
  let lastSeen = 0;
  const keyed = messages.map((message, index) => {
    const createdAt =
      typeof message.createdAt === "number" && Number.isFinite(message.createdAt)
        ? message.createdAt
        : lastSeen;
    lastSeen = createdAt;
    return { message, index, createdAt };
  });
  keyed.sort((a, b) =>
    a.createdAt === b.createdAt ? a.index - b.index : a.createdAt - b.createdAt,
  );
  return keyed.map((entry) => entry.message);
};

/**
 * Merge canonical desktop messages into the local transcript by id without ever
 * discarding local-only rows (e.g. cloud-answered turns). Rows the transcript
 * already reconciled keep their local id (`canonicalId` links them to the
 * desktop row) so streaming bubbles never remount.
 *
 * Matching is by id / `canonicalId`, plus — for real assistant rows only — the
 * turn `requestId` the streamed reply was stamped with at turn end, so a
 * canonical reply that arrives in a later delta (e.g. the reconcile pull beat
 * the desktop persisting it) updates the bubble instead of duplicating it.
 * Content (role+text) is deliberately NOT used to link rows here: this generic
 * sync can't tell an unsent optimistic bubble apart from an older message that
 * merely repeats the same text (e.g. a second "ok"), so a text match could
 * overwrite the bubble with stale history and move it by an old timestamp.
 * Precise optimistic ↔ canonical linking for a just-sent turn is
 * `reconcileSentDesktopTurn`'s job, where the specific row ids are known.
 *
 * When the transcript already holds both a linked row (`canonicalId: X`) and an
 * unlinked twin (`id: X`) — e.g. a poll merged the canonical row before the
 * turn's reconcile linked the bubble — the twin collapses into the linked row
 * so re-delivered canonical rows (task anchors re-emit them) heal the
 * duplicate instead of keeping it. The result is sorted by `createdAt` so
 * freshly-synced history slots in chronologically instead of at the tail.
 */
export const mergeMessagesById = (
  current: ChatMessage[],
  incoming: ChatMessage[],
): ChatMessage[] => {
  if (incoming.length === 0) return current;
  const byId = new Map(current.map((message) => [message.id, message]));
  const order = current.map((message) => message.id);
  for (const message of incoming) {
    const linked = current.find(
      (candidate) => candidate.canonicalId === message.id,
    );
    const direct = current.find((candidate) => candidate.id === message.id);
    const byRequestId =
      !linked &&
      !direct &&
      message.role === "assistant" &&
      message.requestId &&
      !isStandInArtifactRow(message)
        ? current.find(
            (candidate) =>
              candidate.role === "assistant" &&
              candidate.requestId === message.requestId &&
              !isStandInArtifactRow(candidate) &&
              (!candidate.canonicalId || candidate.canonicalId === message.id),
          )
        : undefined;
    const existing = linked ?? direct ?? byRequestId;
    // Collapse a duplicate: the canonical row was merged as its own row before
    // the local bubble got linked to it. Keep the linked local row (stable id,
    // anchored timestamp) and drop the raw canonical twin.
    if (linked && direct && direct.id !== linked.id) {
      byId.delete(direct.id);
    }
    const id = existing?.id ?? message.id;
    if (!byId.has(id)) {
      order.push(id);
    }
    byId.set(
      id,
      existing
        ? {
            ...message,
            id,
            canonicalId: message.id,
            // Keep the timestamp the row was first shown with. Canonical rows
            // carry the *desktop* clock; adopting it for a row that's already
            // on screen lets the re-sort below yank it out of place when the
            // two devices' clocks disagree. New rows (no `existing`) still slot
            // by their canonical time.
            createdAt: existing.createdAt ?? message.createdAt,
            // The canonical desktop row drops attachment thumbnails — keep any
            // the local bubble already has so it doesn't lose its images.
            ...(existing.thumbnailUris?.length && !message.thumbnailUris?.length
              ? { thumbnailUris: existing.thumbnailUris, hasImage: true }
              : {}),
          }
        : message,
    );
  }
  const merged = order
    .map((id) => byId.get(id))
    .filter((message): message is ChatMessage => Boolean(message));
  return sortByCreatedAt(merged);
};

/**
 * After a phone-sent desktop turn completes, swap the optimistic local user
 * bubble and streamed reply for their canonical desktop rows (keeping local
 * ids stable), then merge any other turns that happened on the desktop.
 *
 * `canonicalUserMessageId` — the desktop id the bridge reported for the
 * submitted user message — links the turn precisely when present: the user row
 * by its id, the assistant row by `requestId` (the desktop stamps replies with
 * their turn's user-message id). Text/last-assistant matching remains only as
 * a fallback for older desktops that don't report it. Stand-in artifact rows
 * (`<id>:artifacts` / `<id>:agent` — role "assistant", empty text) are never
 * eligible: adopting one would blank the streamed reply and orphan the real
 * one.
 */
export const reconcileSentDesktopTurn = ({
  current,
  userMessageId,
  replyId,
  sentText,
  canonicalMessages,
  canonicalUserMessageId,
}: {
  current: ChatMessage[];
  userMessageId: string;
  replyId: string;
  sentText: string;
  canonicalMessages: ChatMessage[];
  canonicalUserMessageId?: string;
}): ChatMessage[] => {
  const canonicalUser =
    (canonicalUserMessageId
      ? canonicalMessages.find(
          (message) =>
            message.role === "user" && message.id === canonicalUserMessageId,
        )
      : undefined) ??
    canonicalMessages.find(
      (message) => message.role === "user" && message.text.trim() === sentText,
    ) ??
    canonicalMessages.find((message) => message.role === "user");
  const assistantCandidates = canonicalMessages.filter(
    (message) =>
      message.role === "assistant" && !isStandInArtifactRow(message),
  );
  const canonicalAssistant =
    (canonicalUserMessageId
      ? [...assistantCandidates]
          .reverse()
          .find((message) => message.requestId === canonicalUserMessageId)
      : undefined) ?? [...assistantCandidates].reverse()[0];
  const consumed = new Set<string>();
  const next = current.map((message) => {
    if (message.id === userMessageId && canonicalUser) {
      consumed.add(canonicalUser.id);
      return {
        ...canonicalUser,
        id: message.id,
        canonicalId: canonicalUser.id,
        // Anchor to the optimistic send time so the just-sent turn keeps the
        // position it streamed into, rather than re-sorting onto the desktop
        // clock (which can jump it above earlier messages mid-render).
        createdAt: message.createdAt ?? canonicalUser.createdAt,
        // The canonical desktop row drops attachment thumbnails — keep the
        // ones the user just attached so the bubble doesn't lose its images.
        ...(message.thumbnailUris?.length
          ? { thumbnailUris: message.thumbnailUris, hasImage: true }
          : {}),
      };
    }
    if (message.id === replyId && canonicalAssistant) {
      consumed.add(canonicalAssistant.id);
      return {
        ...canonicalAssistant,
        id: message.id,
        canonicalId: canonicalAssistant.id,
        // Keep the reply pinned where it streamed in; see the user row above.
        createdAt: message.createdAt ?? canonicalAssistant.createdAt,
      };
    }
    return message;
  });
  // Evict canonical twins that a mid-turn sync already merged as their own
  // rows: the map above relabelled the *local* rows with `canonicalId`, so any
  // remaining row whose id is a consumed canonical id is a duplicate.
  const deduped = next.filter(
    (message) =>
      !(
        consumed.has(message.id) &&
        message.id !== userMessageId &&
        message.id !== replyId
      ),
  );
  return mergeMessagesById(
    deduped,
    canonicalMessages.filter((message) => !consumed.has(message.id)),
  );
};
