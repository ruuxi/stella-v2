import type { ChatArtifact, ChatMessage } from "../types";
import { isStandInArtifactRow } from "./message-row-identity";

type CanonicalOrder = { stamp: number; tie: string };

const canonicalOrderOf = (message: ChatMessage): CanonicalOrder | null => {
  const stamp = message.canonicalCreatedAt;
  return typeof stamp === "number" && Number.isFinite(stamp)
    ? { stamp, tie: message.canonicalId ?? message.id }
    : null;
};

const compareCanonicalOrder = (a: CanonicalOrder, b: CanonicalOrder): number => {
  if (a.stamp !== b.stamp) return a.stamp - b.stamp;
  if (a.tie === b.tie) return 0;
  return a.tie < b.tie ? -1 : 1;
};

const everyRowHasSequence = (rows: readonly ChatMessage[]): boolean => {
  for (const row of rows) {
    if (typeof row.sequence !== "number" || !Number.isFinite(row.sequence)) {
      return false;
    }
  }
  return true;
};

const orderBySequence = (rows: ChatMessage[]): ChatMessage[] =>
  [...rows].sort((a, b) => {
    if (a.sequence! !== b.sequence!) return a.sequence! - b.sequence!;
    if (a.id === b.id) return 0;
    return a.id < b.id ? -1 : 1;
  });

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
  const ordered = indexed.every((entry) => entry.order)
    ? [...indexed].sort(
        (a, b) => compareCanonicalOrder(a.order!, b.order!) || a.index - b.index,
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

const rederiveOrder = (
  retained: ChatMessage[],
  unseen: ChatMessage[],
): ChatMessage[] =>
  everyRowHasSequence(retained) && everyRowHasSequence(unseen)
    ? orderBySequence([...retained, ...unseen])
    : insertNewRowsCanonically(retained, unseen);

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

const isGeneratedImage = (artifact: ChatArtifact): boolean =>
  artifact.payload.kind === "media" &&
  artifact.payload.asset.kind === "image" &&
  artifact.payload.presentation === "inline-image";

const reconcileGeneratedImages = (
  existing: ChatArtifact[],
  incoming: ChatArtifact[],
): ChatArtifact[] => {
  let updates = incoming;
  const completed = incoming.filter(
    (artifact) =>
      isGeneratedImage(artifact) &&
      artifact.payload.kind === "media" &&
      artifact.payload.asset.kind === "image" &&
      artifact.payload.asset.filePaths.length > 0,
  );
  for (const result of completed) {
    if (result.payload.kind !== "media") continue;
    const resultPayload = result.payload;
    const placeholders = [...existing, ...updates].filter(
      (artifact) =>
        artifact.id !== result.id &&
        isGeneratedImage(artifact) &&
        artifact.payload.kind === "media" &&
        artifact.payload.asset.kind === "image" &&
        artifact.payload.asset.filePaths.length === 0,
    );
    const placeholder =
      placeholders.find(
        (artifact) =>
          artifact.payload.kind === "media" &&
          Boolean(resultPayload.toolCallId) &&
          artifact.payload.toolCallId === resultPayload.toolCallId,
      ) ??
      placeholders.find(
        (artifact) =>
          artifact.payload.kind === "media" &&
          Boolean(resultPayload.prompt) &&
          artifact.payload.prompt === resultPayload.prompt,
      ) ??
      (placeholders.length === 1 ? placeholders[0] : undefined);
    if (placeholder?.payload.kind !== "media") continue;
    const reconciled: ChatArtifact = {
      ...result,
      id: placeholder.id,
      payload: {
        ...result.payload,
        generationState: "completed",
        ...(placeholder.payload.toolCallId
          ? { toolCallId: placeholder.payload.toolCallId }
          : {}),
        ...(typeof placeholder.payload.textOffset === "number"
          ? { textOffset: placeholder.payload.textOffset }
          : {}),
      },
    };
    updates = updates
      .filter(
        (artifact) =>
          artifact.id !== placeholder.id && artifact.id !== result.id,
      )
      .concat(reconciled);
  }
  return updates;
};

const dedupeGeneratedImageResults = (
  artifacts: ChatArtifact[],
): ChatArtifact[] => {
  const output: ChatArtifact[] = [];
  const indexByPaths = new Map<string, number>();
  for (const artifact of artifacts) {
    if (
      !isGeneratedImage(artifact) ||
      artifact.payload.kind !== "media" ||
      artifact.payload.asset.kind !== "image" ||
      artifact.payload.asset.filePaths.length === 0
    ) {
      output.push(artifact);
      continue;
    }
    const pathKey = [...artifact.payload.asset.filePaths].sort().join("\n");
    const existingIndex = indexByPaths.get(pathKey);
    if (existingIndex === undefined) {
      indexByPaths.set(pathKey, output.length);
      output.push(artifact);
      continue;
    }
    const existing = output[existingIndex]!;
    if (
      artifact.id.startsWith("image-gen:") &&
      !existing.id.startsWith("image-gen:")
    ) {
      output[existingIndex] = artifact;
    }
  }
  return output.length === artifacts.length ? artifacts : output;
};

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
  updates = reconcileGeneratedImages(base, updates);
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
  const deduped = dedupeGeneratedImageResults(next);
  return changed || base !== existing || deduped !== next ? deduped : existing;
};

const reuseEqualMessage = (
  existing: ChatMessage,
  candidate: ChatMessage,
): ChatMessage => {
  const next = { ...candidate } as ChatMessage;
  for (const key of [
    "toolSteps",
    "tasks",
    "thumbnailUris",
    "quotedText",
  ] as const) {
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

  const keepExistingText =
    existing.text !== canonical.text &&
    partialTextKey(existing.text) === partialTextKey(canonical.text);
  const candidate: ChatMessage = {
    ...canonical,
    id: existing.id,
    ...(keepExistingText ? { text: existing.text } : {}),

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

    ...(existing.quotedText && !canonical.quotedText
      ? { quotedText: existing.quotedText }
      : {}),
  };
  return reuseEqualMessage(existing, candidate);
};

const sameMessageSequence = (a: ChatMessage[], b: ChatMessage[]): boolean =>
  a.length === b.length && a.every((message, index) => message === b[index]);

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

const partialTextKey = (text: string): string =>
  text.replace(/\s+/g, " ").trim();

export const finalizeAssistantTurnText = (
  assembledText: string,
  finalText: string,
): string => {
  if (!assembledText.trim()) return finalText;
  if (!finalText.trim()) return assembledText;
  const assembled = partialTextKey(assembledText);
  const final = partialTextKey(finalText);
  if (assembled === final || assembled.endsWith(final)) return assembledText;
  return finalText;
};

const sweepSupersededPartialReplies = (
  messages: ChatMessage[],
): ChatMessage[] => {
  const backedByRequestId = new Map<string, ChatMessage[]>();
  for (const message of messages) {
    if (
      message.role !== "assistant" ||
      !message.requestId ||
      isStandInArtifactRow(message) ||
      (!message.canonicalId && message.canonicalCreatedAt === undefined)
    ) {
      continue;
    }
    const bucket = backedByRequestId.get(message.requestId);
    if (bucket) bucket.push(message);
    else backedByRequestId.set(message.requestId, [message]);
  }
  if (backedByRequestId.size === 0) return messages;
  const survivors: ChatMessage[] = [];
  const adoptedArtifacts = new Map<string, ChatArtifact[]>();
  let swept = false;
  for (const message of messages) {
    const isSnapshot =
      message.role === "assistant" &&
      Boolean(message.requestId) &&
      !message.canonicalId &&
      message.canonicalCreatedAt === undefined &&
      !isStandInArtifactRow(message) &&
      message.text.trim().length > 0;
    if (isSnapshot) {
      const key = partialTextKey(message.text);
      const backed = backedByRequestId
        .get(message.requestId!)
        ?.find(
          (candidate) =>
            candidate.id !== message.id &&
            partialTextKey(candidate.text).startsWith(key),
        );
      if (backed) {
        swept = true;
        if (message.artifacts?.length && !backed.artifacts?.length) {
          adoptedArtifacts.set(backed.id, message.artifacts);
        }
        continue;
      }
    }
    survivors.push(message);
  }
  if (!swept) return messages;
  if (adoptedArtifacts.size === 0) return survivors;
  return survivors.map((message) => {
    const artifacts = adoptedArtifacts.get(message.id);
    return artifacts && !message.artifacts?.length
      ? { ...message, artifacts }
      : message;
  });
};

export const collapseLinkedDuplicates = (
  messages: ChatMessage[],
): ChatMessage[] =>
  sweepSupersededPartialReplies(collapseLinkedTwinDuplicates(messages));

const collapseLinkedTwinDuplicates = (
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

export const mergeMessagesById = (
  current: ChatMessage[],
  incoming: ChatMessage[],
): ChatMessage[] => {

  if (incoming.length === 0) return collapseLinkedDuplicates(current);
  const healedCurrent = collapseLinkedDuplicates(current);
  const byId = new Map(healedCurrent.map((message) => [message.id, message]));
  const order = healedCurrent.map((message) => message.id);
  const unseenIds: string[] = [];

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
  const merged = collapseLinkedDuplicates(rederiveOrder(retained, unseen));
  return sameMessageSequence(current, merged) ? current : merged;
};

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

export const retargetOptimisticReplyToUser = (
  messages: ChatMessage[],
  {
    replyId,
    userMessageId,
  }: {
    replyId: string;
    userMessageId: string;
  },
): ChatMessage[] => {
  const replyIndex = messages.findIndex((message) => message.id === replyId);
  const userIndex = messages.findIndex(
    (message) => message.id === userMessageId && message.role === "user",
  );
  if (replyIndex < 0 || userIndex < 0) return messages;

  const reply = messages[replyIndex]!;
  const withoutReply = messages.filter((message) => message.id !== replyId);
  const targetIndex = withoutReply.findIndex(
    (message) => message.id === userMessageId,
  );
  if (targetIndex < 0) return messages;

  const next = [...withoutReply];
  next[targetIndex] = { ...next[targetIndex]!, queued: false };
  next.splice(targetIndex + 1, 0, {
    ...reply,
    requestId: userMessageId,
    createdAt: Math.max(
      reply.createdAt ?? 0,
      next[targetIndex]!.createdAt ?? 0,
    ),
  });
  return next;
};

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
