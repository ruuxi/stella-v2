import type { ChatMessage } from "../types";

const STAND_IN_ARTIFACT_ID_SUFFIXES = [":artifacts", ":agent"];

export const isStandInArtifactRow = (
  message: Pick<ChatMessage, "id" | "canonicalId">,
): boolean =>
  STAND_IN_ARTIFACT_ID_SUFFIXES.some(
    (suffix) =>
      message.id.endsWith(suffix) ||
      (message.canonicalId?.endsWith(suffix) ?? false),
  );

/**
 * Drop stand-in artifact rows from the rendered transcript.
 *
 * Returns the input array itself when nothing is filtered. An in-flight turn
 * gives `messages` a new identity on every landed segment, tool step and
 * artifact, so this runs often; most transcripts have no stand-in rows at all,
 * and an unconditional `filter` allocated a second full-length array each time
 * for an identical result. Scanning first keeps the common case
 * allocation-free and lets consumers' `visibleMessages === messages` checks
 * hold.
 */
export const visibleChatMessages = (messages: ChatMessage[]): ChatMessage[] => {
  const firstStandIn = messages.findIndex(isStandInArtifactRow);
  if (firstStandIn === -1) return messages;
  const visible = messages.slice(0, firstStandIn);
  for (let i = firstStandIn + 1; i < messages.length; i += 1) {
    if (!isStandInArtifactRow(messages[i])) visible.push(messages[i]);
  }
  return visible;
};

export const shouldAnimateMessageEntry = (
  seenMessageIds: Set<string>,
  messageId: string,
): boolean => {
  if (seenMessageIds.has(messageId)) return false;
  seenMessageIds.add(messageId);
  return true;
};

/**
 * Register a prepended page of older messages as already seen, and return the
 * window's new head id.
 *
 * Paging history in must not read as messages arriving. Every row of an older
 * page is unseen, so `shouldAnimateMessageEntry` would play the entry pop for
 * all of them as they scroll into view — the list appears to shake while the
 * user is only scrolling back. Rows above the previous head are history by
 * definition, so they are marked seen before the list ever renders them.
 *
 * Returns immediately when the head has not moved, which is every data change
 * of a live stream; the scan costs only a real prepend. A head that is gone
 * entirely (a different conversation, a trimmed window) is not a prepend and
 * animates as before.
 */
export const markPrependedMessagesSeen = (
  seenMessageIds: Set<string>,
  messages: readonly Pick<ChatMessage, "id">[],
  previousHeadId: string | null,
): string | null => {
  const nextHeadId = messages[0]?.id ?? null;
  if (previousHeadId === null || previousHeadId === nextHeadId) {
    return nextHeadId;
  }
  const previousHeadIndex = messages.findIndex(
    (message) => message.id === previousHeadId,
  );
  for (let index = 0; index < previousHeadIndex; index += 1) {
    seenMessageIds.add(messages[index]!.id);
  }
  return nextHeadId;
};
