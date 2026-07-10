import type { ChatArtifact, ChatMessage } from "../types";
import { isStandInArtifactRow } from "./message-row-identity";

type CanonicalOrder = { stamp: number; tie: string };

const canonicalOrderOf = (message: ChatMessage): CanonicalOrder | null => {
  const stamp = message.canonicalCreatedAt;
  return typeof stamp === "number" && Number.isFinite(stamp)
    ? { stamp, tie: message.canonicalId ?? message.id }
    : null;
};

const compareCanonicalOrder = (
  a: CanonicalOrder,
  b: CanonicalOrder,
): number => {
  if (a.stamp !== b.stamp) return a.stamp - b.stamp;
  if (a.tie === b.tie) return 0;
  return a.tie < b.tie ? -1 : 1;
};

/**
 * Insert rows the phone has never rendered into their canonical desktop slots
 * without re-sorting rows already on screen.
 *
 * The old global sort re-keyed an optimistic row when reconciliation supplied
 * its desktop timestamp. That let a card/message which was already visible
 * move on completion, on the next turn, or during a full reconnect replay.
 * Existing array order is now the durable insertion sequence: updates may add
 * canonical identity, but never alter that sequence. Only genuinely new rows
 * are ordered, using the desktop cursor's immutable `(timestamp, id)` tuple;
 * same-stamp ties therefore converge deterministically on a fresh hydration.
 * Unstamped existing rows remain attached to their current neighbours.
 */
const insertNewRowsCanonically = (
  current: ChatMessage[],
  unseen: ChatMessage[],
): ChatMessage[] => {
  if (unseen.length === 0) return current;
  const indexed = unseen.map((message, index) => ({
    message,
    index,
    order: canonicalOrderOf(message),
  }));
  // Bridge rows all carry canonical stamps. If a legacy/locally-created row
  // does not, keep the batch's insertion order rather than mixing two
  // incomparable order domains in one comparator.
  const ordered = indexed.every((entry) => entry.order)
    ? [...indexed].sort(
        (a, b) =>
          compareCanonicalOrder(a.order!, b.order!) || a.index - b.index,
      )
    : indexed;
  const out = [...current];
  let afterPreviousInsert = 0;
  for (const entry of ordered) {
    if (!entry.order) {
      out.push(entry.message);
      afterPreviousInsert = out.length;
      continue;
    }
    let insertAt = out.length;
    for (let index = afterPreviousInsert; index < out.length; index += 1) {
      const existingOrder = canonicalOrderOf(out[index]);
      if (
        existingOrder &&
        compareCanonicalOrder(existingOrder, entry.order) > 0
      ) {
        insertAt = index;
        break;
      }
    }
    out.splice(insertAt, 0, entry.message);
    afterPreviousInsert = insertAt + 1;
  }
  return out;
};

/**
 * The desktop-clock ordering stamp for a canonical row arriving off the
 * bridge (whose `createdAt` IS the desktop timestamp — see
 * `parseDesktopBridgeMessageRows`).
 */
const canonicalStampOf = (canonical: ChatMessage): number | undefined =>
  canonical.canonicalCreatedAt ?? canonical.createdAt;

const jsonValueEqual = (a: unknown, b: unknown): boolean => {
  if (Object.is(a, b)) return true;
  if (Array.isArray(a) || Array.isArray(b)) {
    return (
      Array.isArray(a) &&
      Array.isArray(b) &&
      a.length === b.length &&
      a.every((value, index) => jsonValueEqual(value, b[index]))
    );
  }
  if (!a || !b || typeof a !== "object" || typeof b !== "object") {
    return false;
  }
  const aRecord = a as Record<string, unknown>;
  const bRecord = b as Record<string, unknown>;
  const aKeys = Object.keys(aRecord);
  const bKeys = Object.keys(bRecord);
  return (
    aKeys.length === bKeys.length &&
    aKeys.every(
      (key) =>
        Object.prototype.hasOwnProperty.call(bRecord, key) &&
        jsonValueEqual(aRecord[key], bRecord[key]),
    )
  );
};

const agentIdsOf = (artifact: ChatArtifact): Set<string> | null => {
  if (artifact.payload.kind !== "agent-work") return null;
  const explicit = artifact.payload.agentIds
    ?.map((value) => value.trim())
    .filter(Boolean);
  const fromId = artifact.id.startsWith("agent-work:")
    ? artifact.id
        .slice("agent-work:".length)
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean)
    : [];
  const ids = explicit?.length ? explicit : fromId;
  return ids.length > 0 ? new Set(ids) : null;
};

const isSubset = (candidate: Set<string>, target: Set<string>): boolean => {
  for (const value of candidate) {
    if (!target.has(value)) return false;
  }
  return true;
};

/** Whether two rows carry the same delegated-agent run. The live mobile stream
 * temporarily puts every turn artifact on one optimistic assistant row; the
 * canonical desktop projection is authoritative about which assistant row
 * actually owns that lifecycle event. */
const messagesShareAgentWork = (
  left: ChatMessage,
  right: ChatMessage,
): boolean => {
  const leftAgentIds = (left.artifacts ?? [])
    .map(agentIdsOf)
    .filter((ids): ids is Set<string> => Boolean(ids));
  if (leftAgentIds.length === 0) return false;
  const rightAgentIds = (right.artifacts ?? [])
    .map(agentIdsOf)
    .filter((ids): ids is Set<string> => Boolean(ids));
  return leftAgentIds.some((leftIds) =>
    rightAgentIds.some((rightIds) => {
      for (const id of leftIds) {
        if (rightIds.has(id)) return true;
      }
      return false;
    }),
  );
};

/** Keep card identity/order stable and never make an already-visible artifact
 * disappear because an intermediate projection omitted it. Same-id payloads
 * (running -> done) update in place; genuinely new artifacts append. */
const mergeArtifacts = (
  existing: ChatMessage["artifacts"],
  incoming: ChatMessage["artifacts"],
): ChatMessage["artifacts"] => {
  if (!existing?.length) return incoming;
  if (!incoming?.length) return existing;
  let base = existing;
  let updates = incoming;
  const incomingAgent = incoming.find((artifact) => agentIdsOf(artifact));
  const incomingAgentIds = incomingAgent ? agentIdsOf(incomingAgent) : null;
  if (incomingAgent && incomingAgentIds) {
    const existingAgents = existing
      .map((artifact) => ({ artifact, ids: agentIdsOf(artifact) }))
      .filter((entry): entry is { artifact: ChatArtifact; ids: Set<string> } =>
        Boolean(entry.ids),
      );
    const covering = existingAgents.find(
      (entry) =>
        isSubset(incomingAgentIds, entry.ids) &&
        entry.ids.size > incomingAgentIds.size,
    );
    if (covering) {
      // Do not let a stale single-agent replay downgrade an aggregate already
      // visible on the row.
      updates = incoming.filter((artifact) => artifact !== incomingAgent);
    } else {
      const covered = existingAgents.filter((entry) =>
        isSubset(entry.ids, incomingAgentIds),
      );
      if (covered.length > 0) {
        const stable = covered[0]!.artifact;
        const removed = new Set(
          covered.slice(1).map((entry) => entry.artifact.id),
        );
        base =
          removed.size > 0
            ? existing.filter((artifact) => !removed.has(artifact.id))
            : existing;
        updates = incoming.map((artifact) =>
          artifact === incomingAgent
            ? { ...artifact, id: stable.id }
            : artifact,
        );
      }
    }
  }
  const incomingById = new Map(
    updates.map((artifact) => [artifact.id, artifact]),
  );
  let changed = false;
  const next = base.map((artifact) => {
    const update = incomingById.get(artifact.id);
    if (!update) return artifact;
    incomingById.delete(artifact.id);
    if (jsonValueEqual(artifact, update)) return artifact;
    changed = true;
    return update;
  });
  for (const artifact of updates) {
    if (!incomingById.has(artifact.id)) continue;
    incomingById.delete(artifact.id);
    next.push(artifact);
    changed = true;
  }
  return changed || base !== existing ? next : existing;
};

const reuseEqualMessage = (
  existing: ChatMessage,
  candidate: ChatMessage,
): ChatMessage => {
  const next = { ...candidate } as ChatMessage;
  for (const key of ["toolSteps", "tasks", "thumbnailUris"] as const) {
    if (
      jsonValueEqual(existing[key], candidate[key]) &&
      (Object.prototype.hasOwnProperty.call(existing, key) ||
        Object.prototype.hasOwnProperty.call(candidate, key))
    ) {
      (next as unknown as Record<string, unknown>)[key] = existing[key];
    }
  }
  const existingRecord = existing as unknown as Record<string, unknown>;
  const nextRecord = next as unknown as Record<string, unknown>;
  const existingKeys = Object.keys(existingRecord);
  const nextKeys = Object.keys(nextRecord);
  return existingKeys.length === nextKeys.length &&
    existingKeys.every((key) => Object.is(existingRecord[key], nextRecord[key]))
    ? existing
    : next;
};

const mergeCanonicalMessage = (
  existing: ChatMessage,
  canonical: ChatMessage,
): ChatMessage => {
  const canonicalCreatedAt =
    existing.canonicalCreatedAt ?? canonicalStampOf(canonical);
  const artifacts = mergeArtifacts(existing.artifacts, canonical.artifacts);
  const candidate: ChatMessage = {
    ...canonical,
    id: existing.id,
    // A direct canonical replay needs no second identity field. Linked local
    // rows retain their local list key and adopt the desktop id exactly once.
    ...(existing.id !== canonical.id || existing.canonicalId
      ? { canonicalId: canonical.id }
      : {}),
    createdAt: existing.createdAt ?? canonical.createdAt,
    ...(canonicalCreatedAt !== undefined ? { canonicalCreatedAt } : {}),
    ...(existing.requestId && !canonical.requestId
      ? { requestId: existing.requestId }
      : {}),
    ...(artifacts?.length ? { artifacts } : {}),
    ...(existing.thumbnailUris?.length && !canonical.thumbnailUris?.length
      ? { thumbnailUris: existing.thumbnailUris, hasImage: true }
      : {}),
  };
  return reuseEqualMessage(existing, candidate);
};

const sameMessageSequence = (a: ChatMessage[], b: ChatMessage[]): boolean =>
  a.length === b.length && a.every((message, index) => message === b[index]);

/**
 * Heal the assistant form of the optimistic/canonical twin before the generic
 * id merge sees it. The streamed local reply is stamped with the turn's
 * `requestId` immediately, but it may not have a `canonicalId` yet. If a sync
 * inserted the canonical reply first, a later replay finds that direct id and
 * never reaches the request-id fallback, leaving both rows rendered forever.
 *
 * Canonical sync rows carry `canonicalCreatedAt`; optimistic rows do not. That
 * lets us distinguish the two without text-matching arbitrary history. A turn
 * with several assistant rows is linked only by shared agent-work identity or
 * an exact unique text match; a single canonical candidate is unambiguous.
 */
const collapseRequestLinkedAssistantDuplicates = (
  messages: ChatMessage[],
): ChatMessage[] => {
  const canonicalByRequestId = new Map<string, ChatMessage[]>();
  for (const message of messages) {
    if (
      message.role !== "assistant" ||
      !message.requestId ||
      message.canonicalId ||
      message.canonicalCreatedAt === undefined ||
      isStandInArtifactRow(message)
    ) {
      continue;
    }
    const bucket = canonicalByRequestId.get(message.requestId);
    if (bucket) bucket.push(message);
    else canonicalByRequestId.set(message.requestId, [message]);
  }
  if (canonicalByRequestId.size === 0) return messages;

  const replacements = new Map<string, ChatMessage>();
  const consumedCanonicalIds = new Set<string>();
  for (const optimistic of messages) {
    if (
      optimistic.role !== "assistant" ||
      !optimistic.requestId ||
      optimistic.canonicalId ||
      optimistic.canonicalCreatedAt !== undefined ||
      isStandInArtifactRow(optimistic)
    ) {
      continue;
    }
    const candidates = canonicalByRequestId.get(optimistic.requestId) ?? [];
    const agentMatch = candidates.find((candidate) =>
      messagesShareAgentWork(optimistic, candidate),
    );
    const textMatches = candidates.filter(
      (candidate) => candidate.text === optimistic.text,
    );
    const canonical =
      agentMatch ??
      (textMatches.length === 1 ? textMatches[0] : undefined) ??
      (candidates.length === 1 ? candidates[0] : undefined);
    if (!canonical || consumedCanonicalIds.has(canonical.id)) continue;
    consumedCanonicalIds.add(canonical.id);
    replacements.set(
      optimistic.id,
      mergeCanonicalMessage(
        { ...optimistic, canonicalId: canonical.id },
        canonical,
      ),
    );
  }
  if (replacements.size === 0) return messages;
  return messages
    .filter((message) => !consumedCanonicalIds.has(message.id))
    .map((message) => replacements.get(message.id) ?? message);
};

/**
 * Collapse optimistic/canonical twins in either identity phase: an assistant
 * reply may still have only its turn `requestId`, or a settled local row may
 * already be linked to the desktop row (`canonicalId: X`) while that canonical
 * row also exists separately (`id: X`, no `canonicalId`).
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
 * This pass heals either pair structurally, whatever created it: the local row
 * wins (stable id, anchored timestamp) and adopts canonical content. Returns
 * the input array unchanged (same reference) when there is nothing to collapse.
 */
export const collapseLinkedDuplicates = (
  messages: ChatMessage[],
): ChatMessage[] => {
  const requestHealed = collapseRequestLinkedAssistantDuplicates(messages);
  const linkedCanonicalIds = new Set<string>();
  for (const message of requestHealed) {
    if (message.canonicalId && message.canonicalId !== message.id) {
      linkedCanonicalIds.add(message.canonicalId);
    }
  }
  if (linkedCanonicalIds.size === 0) return requestHealed;
  const twinsById = new Map<string, ChatMessage>();
  for (const message of requestHealed) {
    if (!message.canonicalId && linkedCanonicalIds.has(message.id)) {
      twinsById.set(message.id, message);
    }
  }
  if (twinsById.size === 0) return requestHealed;
  const out: ChatMessage[] = [];
  for (const message of requestHealed) {
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
          ...(twinStamp !== undefined ? { canonicalCreatedAt: twinStamp } : {}),
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
 * duplicate instead of keeping it. Existing rows keep their exact order;
 * freshly-seen rows alone slot into the desktop's canonical sequence (see
 * {@link insertNewRowsCanonically}).
 */
export const mergeMessagesById = (
  current: ChatMessage[],
  incoming: ChatMessage[],
): ChatMessage[] => {
  // Even a no-op delta heals linked-row/unlinked-twin duplicates: the
  // post-turn reconcile's delta often no longer contains the canonical row a
  // mid-send pull already consumed (see `collapseLinkedDuplicates`).
  if (incoming.length === 0) return collapseLinkedDuplicates(current);
  const healedCurrent = collapseLinkedDuplicates(current);
  const byId = new Map(healedCurrent.map((message) => [message.id, message]));
  const order = healedCurrent.map((message) => message.id);
  const unseenIds: string[] = [];
  // Lookup indexes over `current` (which the loop below never mutates),
  // built once so the merge is O(current + incoming) instead of a linear
  // scan per incoming row. Each keeps `.find`'s first-match semantics.
  const linkedByCanonicalId = new Map<string, ChatMessage>();
  const directById = new Map<string, ChatMessage>();
  const assistantsByRequestId = new Map<string, ChatMessage[]>();
  for (const candidate of healedCurrent) {
    if (
      candidate.canonicalId !== undefined &&
      !linkedByCanonicalId.has(candidate.canonicalId)
    ) {
      linkedByCanonicalId.set(candidate.canonicalId, candidate);
    }
    if (!directById.has(candidate.id)) {
      directById.set(candidate.id, candidate);
    }
    if (
      candidate.role === "assistant" &&
      candidate.requestId &&
      !isStandInArtifactRow(candidate)
    ) {
      const bucket = assistantsByRequestId.get(candidate.requestId);
      if (bucket) {
        bucket.push(candidate);
      } else {
        assistantsByRequestId.set(candidate.requestId, [candidate]);
      }
    }
  }
  for (const message of incoming) {
    const linked = linkedByCanonicalId.get(message.id);
    const direct = directById.get(message.id);
    const byRequestId =
      !linked &&
      !direct &&
      message.role === "assistant" &&
      message.requestId &&
      !isStandInArtifactRow(message)
        ? assistantsByRequestId
            .get(message.requestId)
            ?.find(
              (candidate) =>
                !candidate.canonicalId || candidate.canonicalId === message.id,
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
      unseenIds.push(id);
    }
    byId.set(
      id,
      existing
        ? mergeCanonicalMessage(existing, message)
        : {
            ...message,
            ...(canonicalStampOf(message) !== undefined
              ? { canonicalCreatedAt: canonicalStampOf(message) }
              : {}),
          },
    );
  }
  const retainedIds = new Set(unseenIds);
  const retained = order
    .filter((id) => !retainedIds.has(id))
    .map((id) => byId.get(id))
    .filter((message): message is ChatMessage => Boolean(message));
  const unseen = unseenIds
    .map((id) => byId.get(id))
    .filter((message): message is ChatMessage => Boolean(message));
  const merged = collapseLinkedDuplicates(
    insertNewRowsCanonically(retained, unseen),
  );
  return sameMessageSequence(current, merged) ? current : merged;
};

/**
 * Link a phone-sent turn's optimistic rows to their canonical desktop ids
 * WITHOUT swapping in any canonical content or appending finish/error text.
 *
 * Used on the interrupted-turn paths — the user stopped the run, or it errored
 * after the desktop already persisted the row. The desktop persists the turn's
 * canonical user row the instant the run starts, so an optimistic user bubble
 * left unlinked is a duplicate waiting to happen: the next send's wake→sync
 * pulls that canonical row and `mergeMessagesById`, matching only by
 * id/`canonicalId`, appends it as a SECOND copy of the same user message
 * (the "first user message duplicates after stop-then-send" bug). Stamping the
 * bubble's `canonicalId` (and the reply's `requestId`, the key canonical
 * assistant rows carry) lets that merge fold the canonical rows into the
 * existing bubbles instead of duplicating them.
 *
 * Only fills the link fields when they're still empty, so it never clobbers a
 * link a completed turn already established, and returns the input array
 * unchanged (same reference) when there is nothing to link.
 */
export const linkOptimisticTurnToCanonical = (
  messages: ChatMessage[],
  {
    userMessageId,
    replyId,
    canonicalUserMessageId,
  }: {
    userMessageId: string;
    replyId: string;
    canonicalUserMessageId: string;
  },
): ChatMessage[] => {
  const linkId = canonicalUserMessageId.trim();
  if (!linkId) return messages;
  let changed = false;
  const next = messages.map((message) => {
    if (message.id === userMessageId && !message.canonicalId) {
      changed = true;
      return { ...message, canonicalId: linkId };
    }
    if (message.id === replyId && !message.requestId) {
      changed = true;
      return { ...message, requestId: linkId };
    }
    return message;
  });
  return changed ? next : messages;
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
 * a fallback for older desktops that don't report it. When a streamed turn
 * produced several assistant rows, the canonical row carrying the same agent
 * card wins over the generic last-assistant match. That keeps the optimistic
 * card anchored to its desktop spawn position while later assistant rows slot
 * in below it. Stand-in artifact rows (`<id>:artifacts` / `<id>:agent` — role
 * "assistant", empty text) are never eligible: adopting one would blank the
 * streamed reply and orphan the real one.
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
    (message) => message.role === "assistant" && !isStandInArtifactRow(message),
  );
  const turnAssistantCandidates = canonicalUserMessageId
    ? assistantCandidates.filter(
        (message) => message.requestId === canonicalUserMessageId,
      )
    : assistantCandidates;
  const eligibleAssistantCandidates =
    turnAssistantCandidates.length > 0
      ? turnAssistantCandidates
      : assistantCandidates;
  const optimisticAssistant = current.find((message) => message.id === replyId);
  const canonicalAssistant =
    (optimisticAssistant
      ? [...eligibleAssistantCandidates]
          .reverse()
          .find((message) =>
            messagesShareAgentWork(optimisticAssistant, message),
          )
      : undefined) ?? [...eligibleAssistantCandidates].reverse()[0];
  const consumed = new Set<string>();
  const next = current.map((message) => {
    if (message.id === userMessageId && canonicalUser) {
      consumed.add(canonicalUser.id);
      return mergeCanonicalMessage(
        {
          ...message,
          canonicalId: canonicalUser.id,
        },
        {
          ...canonicalUser,
          // The canonical desktop row drops attachment thumbnails — keep the
          // ones the user just attached so the bubble doesn't lose its images.
          ...(message.thumbnailUris?.length
            ? { thumbnailUris: message.thumbnailUris, hasImage: true }
            : {}),
        },
      );
    }
    if (message.id === replyId && canonicalAssistant) {
      consumed.add(canonicalAssistant.id);
      return mergeCanonicalMessage(
        { ...message, canonicalId: canonicalAssistant.id },
        canonicalAssistant,
      );
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
