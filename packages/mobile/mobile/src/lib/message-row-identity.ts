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
 * Returns the input array itself when nothing is filtered. Streaming gives
 * `messages` a new identity on every revealed frame, so this runs ~60x a
 * second; most transcripts have no stand-in rows at all, and an unconditional
 * `filter` allocated a second full-length array each time for an identical
 * result. Scanning first keeps the common case allocation-free and lets
 * consumers' `visibleMessages === messages` checks hold.
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
