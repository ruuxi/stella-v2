/**
 * Write-time decoration for user transcripts persisted directly into the
 * durable runtime thread store (realtime-voice transcripts, connector
 * messages such as Linq/iMessage, Telegram, etc.).
 *
 * The local-events history projection (`kernel/local-history.ts`, now a
 * deprecated pre-transition compat shim) used to add this metadata while
 * folding chat events into orchestrator model context:
 *
 *   - a trailing `[linq_message_id: …]` line on Linq user messages so the
 *     model can target native iMessage affordances (reactions, replies) at
 *     older messages, and
 *   - a trailing `<system-reminder>…</system-reminder>` timestamp tag on
 *     user messages, suppressed when the previous user message landed less
 *     than thirty minutes earlier (date portion omitted when the previous
 *     user message rendered the same date).
 *
 * The durable thread store is now the single model-context source, so the
 * same formatting is applied once, at write time, and stored verbatim. The
 * chat-events log keeps the raw text for display/sync rendering.
 */
import {
  formatTimestampForHistory,
  THIRTY_MINUTES_MS,
} from "@stella/contracts/message-timestamp";

/** Matches the projection's per-message body bound (local-history.ts). */
const MAX_TEXT_CHARS = 30_000;

const TOOL_RESULT_PREFIX = "[Tool result]";

const truncateWithSuffix = (value, maxChars) =>
  value.length <= maxChars
    ? value
    : `${value.slice(0, maxChars)}...(truncated)`;

const findPreviousUserMessageTimestamp = (store, threadKey) => {
  if (typeof store?.listRecentThreadUserMessages !== "function") {
    return null;
  }
  let recent;
  try {
    recent = store.listRecentThreadUserMessages(threadKey);
  } catch {
    // Tagging is best-effort; a store read failure must not block the write.
    return null;
  }
  for (const entry of recent) {
    // Voice tool results are persisted with role "user" but are not user
    // utterances and never carried timestamp tags in the projection.
    if (entry.content.startsWith(TOOL_RESULT_PREFIX)) {
      continue;
    }
    return entry.timestamp;
  }
  return null;
};

/**
 * Decorate a user transcript body exactly the way the retired events
 * projection rendered it: optional `[linq_message_id: …]` trailer, then an
 * optional timestamp tag (skipped inside the thirty-minute window after the
 * thread's previous user message).
 *
 * @param {{
 *   store: {
 *     listRecentThreadUserMessages?: (
 *       threadKey: string,
 *       limit?: number,
 *     ) => Array<{ content: string; timestamp: number }>;
 *   };
 *   threadKey: string;
 *   text: string;
 *   timestamp: number;
 *   timezone?: string;
 *   linqMessageId?: string;
 * }} args
 * @returns {string}
 */
export const decorateUserTranscriptContent = ({
  store,
  threadKey,
  text,
  timestamp,
  timezone,
  linqMessageId,
}) => {
  const body = truncateWithSuffix(text.trim(), MAX_TEXT_CHARS);
  if (!body) {
    return body;
  }
  const trimmedLinqId =
    typeof linqMessageId === "string" ? linqMessageId.trim() : "";
  const bodyWithMetadata = trimmedLinqId
    ? `${body}\n\n[linq_message_id: ${trimmedLinqId}]`
    : body;
  const prevUserTs = findPreviousUserMessageTimestamp(store, threadKey);
  if (prevUserTs != null && timestamp - prevUserTs < THIRTY_MINUTES_MS) {
    return bodyWithMetadata;
  }
  const prevDate =
    prevUserTs != null
      ? formatTimestampForHistory(prevUserTs, undefined, timezone).dateStr
      : undefined;
  const { tag } = formatTimestampForHistory(timestamp, prevDate, timezone);
  return `${bodyWithMetadata}\n\n${tag}`;
};
