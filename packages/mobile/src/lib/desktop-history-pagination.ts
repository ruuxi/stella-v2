import type { ChatMessage } from "../types";

export type DesktopHistoryPage = {
  messages: ChatMessage[];
  hasOlder: boolean;
  usedLegacyFallback: boolean;
  oldestSourceCursor?: { timestamp: number; id: string } | null;
};

export type DesktopHistoryPaginationTransport = {
  supportsHistoryBefore: boolean;
  invokeHistoryBefore: () => Promise<
    Omit<DesktopHistoryPage, "usedLegacyFallback">
  >;
  fetchRecent: (
    limit: number,
  ) => Promise<(ChatMessage & { timestamp?: number })[]>;
};

/** Bound the old-desktop compatibility expansion to explicit user paging. */
export const LEGACY_DESKTOP_HISTORY_MAX = 1_000;

/**
 * Choose the feature-gated desktop keyset endpoint, or progressively expand a
 * legacy recent-window request and slice before the requested stable cursor.
 */
export async function fetchDesktopHistoryBeforePage(
  options: {
    beforeTimestampMs: number;
    beforeId: string;
    maxMessages: number;
    legacyMaxMessages: number;
  },
  transport: DesktopHistoryPaginationTransport,
): Promise<DesktopHistoryPage> {
  if (transport.supportsHistoryBefore) {
    const page = await transport.invokeHistoryBefore();
    return { ...page, usedLegacyFallback: false };
  }

  const requestLimit = Math.min(
    LEGACY_DESKTOP_HISTORY_MAX,
    Math.max(options.maxMessages, options.legacyMaxMessages),
  );
  const legacyMessages = await transport.fetchRecent(requestLimit);
  const cursorIndex = legacyMessages.findIndex((message) => {
    const timestamp =
      message.sourceTimestamp ?? message.createdAt ?? message.timestamp ?? 0;
    const id = message.sourceMessageId ?? message.id;
    return id === options.beforeId && timestamp === options.beforeTimestampMs;
  });
  // The endpoint returns desktop timeline order, which can be monotonic
  // sequence order even when timestamps move backwards. Prefer the cursor's
  // actual position; retain tuple filtering only when an expanding old-desktop
  // window has not reached that cursor yet.
  const older =
    cursorIndex >= 0
      ? legacyMessages.slice(0, cursorIndex)
      : legacyMessages.filter((message) => {
          const timestamp =
            message.sourceTimestamp ??
            message.createdAt ??
            message.timestamp ??
            0;
          const id = message.sourceMessageId ?? message.id;
          return (
            timestamp < options.beforeTimestampMs ||
            (timestamp === options.beforeTimestampMs &&
              id.localeCompare(options.beforeId) < 0)
          );
        });
  const messages = older.slice(Math.max(0, older.length - options.maxMessages));
  const oldest = messages[0];
  return {
    messages,
    hasOlder:
      older.length > options.maxMessages ||
      (requestLimit < LEGACY_DESKTOP_HISTORY_MAX &&
        legacyMessages.length >= requestLimit),
    usedLegacyFallback: true,
    oldestSourceCursor: oldest
      ? {
          timestamp:
            oldest.sourceTimestamp ?? oldest.createdAt ?? oldest.timestamp ?? 0,
          id: oldest.sourceMessageId ?? oldest.id,
        }
      : null,
  };
}
