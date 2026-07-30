export type ConversationStorageMode = "cloud" | "local";

/**
 * Ordinary Stella conversations are cloud-owned. `local` remains an explicit
 * escape hatch for operational surfaces such as voice and automations that do
 * not participate in the shared conversation journal.
 */
export const resolveConversationStorageMode = (
  value: ConversationStorageMode | undefined,
): ConversationStorageMode => (value === "local" ? "local" : "cloud");

export const shouldPersistLocalChatTranscript = (
  value: ConversationStorageMode | undefined,
): boolean => resolveConversationStorageMode(value) === "local";
