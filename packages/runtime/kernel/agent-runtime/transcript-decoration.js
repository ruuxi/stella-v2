import {
  formatTimestampForHistory,
  THIRTY_MINUTES_MS,
} from "@stella/contracts/message-timestamp";

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

    return null;
  }
  for (const entry of recent) {

    if (entry.content.startsWith(TOOL_RESULT_PREFIX)) {
      continue;
    }
    return entry.timestamp;
  }
  return null;
};

export const decorateUserTranscriptContent = ({
  store,
  threadKey,
  text,
  timestamp,
  timezone,
}) => {
  const body = truncateWithSuffix(text.trim(), MAX_TEXT_CHARS);
  if (!body) {
    return body;
  }
  const prevUserTs = findPreviousUserMessageTimestamp(store, threadKey);
  if (prevUserTs != null && timestamp - prevUserTs < THIRTY_MINUTES_MS) {
    return body;
  }
  const prevDate =
    prevUserTs != null
      ? formatTimestampForHistory(prevUserTs, undefined, timezone).dateStr
      : undefined;
  const { tag } = formatTimestampForHistory(timestamp, prevDate, timezone);
  return `${body}\n\n${tag}`;
};
