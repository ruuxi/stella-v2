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

export const visibleChatMessages = (messages: ChatMessage[]): ChatMessage[] =>
  messages.filter((message) => !isStandInArtifactRow(message));

export const shouldAnimateMessageEntry = (
  seenMessageIds: Set<string>,
  messageId: string,
): boolean => {
  if (seenMessageIds.has(messageId)) return false;
  seenMessageIds.add(messageId);
  return true;
};
