import type { ChatMessage } from "../types";
import { isStandInArtifactRow } from "./message-row-identity";

/**
 * Order the transcript by the desktop's canonical clock so it converges to
 * the desktop's own ordering after any sync.
 *
 * Canonical rows — anything stamped with `canonicalCreatedAt` at merge/link
 * time — sort by that desktop-clock key, the same (timestamp, id) order the
 * desktop transcript and its sync cursor use. Rows with no canonical
 * identity yet (in-flight optimistic turns, offline error bubbles, rows
 * persisted by older builds) inherit the previous row's key, staying glued
 * to their current neighbours in their current relative order.
 *
 * Local `createdAt` (phone clock) deliberately does NOT participate: the
 * phone and desktop clocks can disagree by minutes, and comparing a
 * phone-anchored turn against a desktop-stamped row is exactly what filed an
 * older desktop reply BELOW a newer phone-sent exchange (the build-97
 * ordering bug).
 *
 * Canonical rows sharing a stamp tie-break by canonical id (`canonicalId` ??
 * `id`) — mirroring the desktop cursor's (timestamp, id) order — so two
 * same-millisecond rows converge identically no matter which delta delivered
 * them first; delivery order alone would diverge from the desktop. Unstamped
 * rows keep pure positional stability: they travel with their anchor and
 * never enter id comparisons (mixing an id tie-break with an index tie-break
 * in one comparator would break strict weak ordering). A transcript that is
 * already converged never moves.
 */
const sortCanonically = (messages: ChatMessage[]): ChatMessage[] => {
  type Anchor = {
    message: ChatMessage;
    index: number;
    key: number;
    /** Canonical tie key mirroring the desktop cursor's id component. */
    tie: string;
    /** Unstamped rows glued behind this anchor, in their original order. */
    trailers: ChatMessage[];
  };
  // Rows with no preceding canonical anchor stay at the head, as-is.
  const headTrailers: ChatMessage[] = [];
  const anchors: Anchor[] = [];
  messages.forEach((message, index) => {
    const stamp = message.canonicalCreatedAt;
    if (typeof stamp === "number" && Number.isFinite(stamp)) {
      anchors.push({
        message,
        index,
        key: stamp,
        tie: message.canonicalId ?? message.id,
        trailers: [],
      });
    } else {
      const anchor = anchors[anchors.length - 1];
      (anchor ? anchor.trailers : headTrailers).push(message);
    }
  });
  anchors.sort((a, b) => {
    if (a.key !== b.key) return a.key - b.key;
    if (a.tie !== b.tie) return a.tie < b.tie ? -1 : 1;
    return a.index - b.index;
  });
  return [
    ...headTrailers,
    ...anchors.flatMap((anchor) => [anchor.message, ...anchor.trailers]),
  ];
};

/**
 * The desktop-clock ordering stamp for a canonical row arriving off the
 * bridge (whose `createdAt` IS the desktop timestamp — see
 * `parseDesktopBridgeMessageRows`).
 */
const canonicalStampOf = (canonical: ChatMessage): number | undefined =>
  canonical.canonicalCreatedAt ?? canonical.createdAt;

/**
 * Collapse "linked row + unlinked twin" duplicates: the transcript holds a
 * local row linked to a canonical desktop row (`canonicalId: X`) AND that
 * canonical row as its own separate row (`id: X`, no `canonicalId`).
 *
 * That state is how the "user message rendered twice" bug looks on disk. It
 * arises when a sync pulls the turn's canonical user row MID-SEND — the
 * desktop persists it the moment the turn starts, and `mergeMessagesById`
 * deliberately doesn't text-match, so the not-yet-linked optimistic bubble
 * can't absorb it; the canonical row lands as its own row stamped with the
 * *desktop* clock, sorting after the locally-anchored bubble (and, with any
 * clock skew, after the reply). The stream-end/reconcile linking then marks
 * the bubble `canonicalId: X`, but the twin survives because that mid-send
 * pull advanced the cursor past the row — it is never re-delivered, so the
 * in-merge collapse (which needs the canonical row in `incoming`) never runs.
 *
 * This pass heals the pair structurally, whatever created it: the linked
 * local row wins (stable id, anchored timestamp), adopting the twin's
 * artifacts if it has none. Returns the input array unchanged (same
 * reference) when there is nothing to collapse.
 */
export const collapseLinkedDuplicates = (
  messages: ChatMessage[],
): ChatMessage[] => {
  const linkedCanonicalIds = new Set<string>();
  for (const message of messages) {
    if (message.canonicalId && message.canonicalId !== message.id) {
      linkedCanonicalIds.add(message.canonicalId);
    }
  }
  if (linkedCanonicalIds.size === 0) return messages;
  const twinsById = new Map<string, ChatMessage>();
  for (const message of messages) {
    if (!message.canonicalId && linkedCanonicalIds.has(message.id)) {
      twinsById.set(message.id, message);
    }
  }
  if (twinsById.size === 0) return messages;
  const out: ChatMessage[] = [];
  for (const message of messages) {
    if (!message.canonicalId && twinsById.has(message.id)) continue;
    const twin = message.canonicalId
      ? twinsById.get(message.canonicalId)
      : undefined;
    if (twin) {
      // The dropped twin may carry content the linked row never received:
      // artifacts on a canonical assistant row, and — the twin being the
      // canonical row itself — the desktop-clock ordering stamp the survivor
      // may lack (a stream-end link happens before any delta delivers it).
      const adoptArtifacts =
        twin.artifacts?.length && !message.artifacts?.length;
      const twinStamp =
        message.canonicalCreatedAt === undefined
          ? (twin.canonicalCreatedAt ?? twin.createdAt)
          : undefined;
      if (adoptArtifacts || twinStamp !== undefined) {
        out.push({
          ...message,
          ...(adoptArtifacts ? { artifacts: twin.artifacts } : {}),
          ...(twinStamp !== undefined
            ? { canonicalCreatedAt: twinStamp }
            : {}),
        });
        continue;
      }
    }
    out.push(message);
  }
  return out;
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
 * duplicate instead of keeping it. The result is ordered by the desktop's
 * canonical clock (see {@link sortCanonically}) so freshly-synced rows slot
 * into the desktop's sequence instead of at the tail — or, worse, into a
 * cross-clock position.
 */
export const mergeMessagesById = (
  current: ChatMessage[],
  incoming: ChatMessage[],
): ChatMessage[] => {
  // Even a no-op delta heals linked-row/unlinked-twin duplicates: the
  // post-turn reconcile's delta often no longer contains the canonical row a
  // mid-send pull already consumed (see `collapseLinkedDuplicates`).
  if (incoming.length === 0) return collapseLinkedDuplicates(current);
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
    const canonicalCreatedAt = canonicalStampOf(message);
    byId.set(
      id,
      existing
        ? {
            ...message,
            id,
            canonicalId: message.id,
            // Keep the timestamp the row was first shown with as the local
            // display anchor; ordering runs on the canonical stamp below, so
            // the two clocks never get compared against each other.
            createdAt: existing.createdAt ?? message.createdAt,
            // Desktop-clock ordering key (see sortCanonically).
            ...(canonicalCreatedAt !== undefined
              ? { canonicalCreatedAt }
              : existing.canonicalCreatedAt !== undefined
                ? { canonicalCreatedAt: existing.canonicalCreatedAt }
                : {}),
            // The canonical desktop row drops attachment thumbnails — keep any
            // the local bubble already has so it doesn't lose its images.
            ...(existing.thumbnailUris?.length && !message.thumbnailUris?.length
              ? { thumbnailUris: existing.thumbnailUris, hasImage: true }
              : {}),
          }
        : {
            ...message,
            ...(canonicalCreatedAt !== undefined
              ? { canonicalCreatedAt }
              : {}),
          },
    );
  }
  const merged = order
    .map((id) => byId.get(id))
    .filter((message): message is ChatMessage => Boolean(message));
  return sortCanonically(collapseLinkedDuplicates(merged));
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
      const canonicalCreatedAt = canonicalStampOf(canonicalUser);
      return {
        ...canonicalUser,
        id: message.id,
        canonicalId: canonicalUser.id,
        // Anchor the DISPLAY time to the optimistic send; ordering uses the
        // canonical desktop stamp so the turn converges to the desktop's
        // sequence without the two clocks ever being compared.
        createdAt: message.createdAt ?? canonicalUser.createdAt,
        ...(canonicalCreatedAt !== undefined ? { canonicalCreatedAt } : {}),
        // The canonical desktop row drops attachment thumbnails — keep the
        // ones the user just attached so the bubble doesn't lose its images.
        ...(message.thumbnailUris?.length
          ? { thumbnailUris: message.thumbnailUris, hasImage: true }
          : {}),
      };
    }
    if (message.id === replyId && canonicalAssistant) {
      consumed.add(canonicalAssistant.id);
      const canonicalCreatedAt = canonicalStampOf(canonicalAssistant);
      return {
        ...canonicalAssistant,
        id: message.id,
        canonicalId: canonicalAssistant.id,
        // Keep the reply's display time where it streamed in; see above.
        createdAt: message.createdAt ?? canonicalAssistant.createdAt,
        ...(canonicalCreatedAt !== undefined ? { canonicalCreatedAt } : {}),
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
