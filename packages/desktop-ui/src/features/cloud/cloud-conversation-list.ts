import type { CloudConversation } from "./cloud-api";

/**
 * Search the complete set of conversation pages the sidebar has loaded.
 *
 * Pagination, not this projection, owns how many rows are visible. Keeping
 * this helper deliberately free of a display cap prevents older loaded
 * conversations from becoming unreachable again.
 */
export const filterCloudConversationHistory = (
  conversations: ReadonlyArray<CloudConversation>,
  query: string,
): ReadonlyArray<CloudConversation> => {
  const normalizedQuery = query.trim().toLowerCase();
  if (!normalizedQuery) return conversations;
  return conversations.filter((conversation) =>
    `${conversation.title} ${conversation.lastPreview ?? ""}`
      .toLowerCase()
      .includes(normalizedQuery),
  );
};
