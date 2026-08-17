export const CANONICAL_HISTORY_MAX_TOKENS = 200_000;
export const DEFAULT_CANONICAL_CONTEXT_WINDOW_TOKENS = 128_000;

export const resolveCanonicalContextWindow = (contextWindow) => {
  const parsed = Number(contextWindow);
  const realWindow =
    Number.isFinite(parsed) && parsed > 0
      ? Math.floor(parsed)
      : DEFAULT_CANONICAL_CONTEXT_WINDOW_TOKENS;
  return Math.min(CANONICAL_HISTORY_MAX_TOKENS, realWindow);
};

export const estimateCanonicalTextTokens = (value) =>
  Math.max(1, Math.ceil(String(value ?? "").length / 4));

const estimateMessageTokens = (message) =>
  estimateCanonicalTextTokens(
    message?.payload ? JSON.stringify(message.payload) : message?.content,
  );

const truncateLatestMessage = (message, maxTokens) => {
  const maxChars = Math.max(1, maxTokens * 4);
  const content = message?.payload
    ? JSON.stringify(message.payload)
    : String(message?.content ?? "");
  const marker = "[Earlier portion of this entry omitted by history cap.]\n\n";
  const boundedContent =
    maxChars <= marker.length
      ? marker.slice(0, maxChars)
      : `${marker}${content.slice(-(maxChars - marker.length))}`;
  return {
    ...message,
    content: boundedContent,
    payload: undefined,
  };
};

export const capCanonicalMessages = (messages, contextWindow) => {
  const maxTokens = resolveCanonicalContextWindow(contextWindow);
  const selected = [];
  let usedTokens = 0;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    const tokens = estimateMessageTokens(message);
    if (usedTokens + tokens > maxTokens) {
      if (selected.length === 0) {
        selected.push(truncateLatestMessage(message, maxTokens));
      }
      break;
    }
    selected.push(message);
    usedTokens += tokens;
  }
  return selected.reverse();
};
