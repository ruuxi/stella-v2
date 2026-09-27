import type { LocalContextEvent } from "./shared.js";

/**
 * A bounded read over the same window `listEvents(conversationId, size)`
 * returns (the newest `size` chat-event rows), without materializing and
 * parsing every row in it. The orchestrator context build only needs a few
 * of those rows (the latest user messages, and the pre-transition events the
 * legacy history shim can still consume), so it asks for exactly those.
 */
export type LocalChatEventWindowQuery = {
  /** Event types to return. Must be chat-event types (never
   * `thread_message` / `run_event` / `memory`, which the window excludes). */
  types: readonly string[];
  /** Keep only events with `timestamp < beforeTimestamp`. */
  beforeTimestamp?: number;
  /** Prefilter on payloads that carry this key. The SQL implementation may
   * return a superset (a text match), so callers must verify the value. */
  payloadKey?: string;
  /** Return only the newest `limit` matches. */
  limit?: number;
};

export type LocalChatEventWindow = {
  /** Matching events inside the window, oldest first. */
  query(query: LocalChatEventWindowQuery): LocalContextEvent[];
};

const hasOwnPayloadKey = (payload: unknown, key: string): boolean =>
  Boolean(payload) &&
  typeof payload === "object" &&
  Object.prototype.hasOwnProperty.call(payload, key);

/**
 * Reference semantics for {@link LocalChatEventWindowQuery} over an
 * already-read window (oldest first). Callers re-apply it to SQL results so a
 * query means the same thing whichever implementation answered it.
 */
export const filterLocalChatEventWindow = <T extends LocalContextEvent>(
  events: readonly T[],
  query: LocalChatEventWindowQuery,
): T[] => {
  const types = new Set(query.types);
  const matched = events.filter(
    (event) =>
      types.has(event.type) &&
      (query.beforeTimestamp === undefined ||
        event.timestamp < query.beforeTimestamp) &&
      (query.payloadKey === undefined ||
        hasOwnPayloadKey(event.payload, query.payloadKey)),
  );
  return query.limit !== undefined &&
    query.limit >= 0 &&
    matched.length > query.limit
    ? matched.slice(matched.length - query.limit)
    : matched;
};

/** Window over an already-read event list (tests, hosts without SQL). */
export const createListedLocalChatEventWindow = (
  events: readonly LocalContextEvent[],
): LocalChatEventWindow => ({
  query: (query) => filterLocalChatEventWindow(events, query),
});
