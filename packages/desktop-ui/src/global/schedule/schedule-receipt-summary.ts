/**
 * Helpers for the Schedule dialog summary line. Keeps structured schedule
 * side-channel JSON and raw tool-result envelopes out of user-facing copy.
 */

const isScheduleDetailsJsonPreview = (value: string): boolean => {
  const trimmed = value.trimStart();
  if (!trimmed.startsWith("{")) return false;
  return trimmed.includes('"schedule"') && trimmed.includes('"affected"');
};

/**
 * The Schedule specialist's tool result can reach the UI as a serialized
 * tool-result envelope (`{"content":[{"type":"text","text":"..."}]}`)
 * rather than the plain summary string. Pull the human-readable `text`
 * out; anything else passes through untouched.
 */
const textFromToolResultEnvelope = (value: string): string | undefined => {
  const trimmed = value.trim();
  if (!trimmed.startsWith("{") || !trimmed.includes('"content"')) {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return undefined;
  }
  const content = (parsed as { content?: unknown })?.content;
  if (!Array.isArray(content)) return undefined;
  for (const block of content) {
    if (
      block &&
      typeof block === "object" &&
      (block as { type?: unknown }).type === "text" &&
      typeof (block as { text?: unknown }).text === "string"
    ) {
      const text = (block as { text?: unknown }).text as string;
      if (text.trim()) return text.trim();
    }
  }
  return undefined;
};

export const pickScheduleToolSummary = (payload: {
  resultPreview?: unknown;
  result?: unknown;
}): string | undefined => {
  const candidates: unknown[] = [payload.resultPreview, payload.result];
  const nestedResult =
    payload.result && typeof payload.result === "object"
      ? (payload.result as { result?: unknown }).result
      : undefined;
  if (nestedResult !== undefined) {
    candidates.unshift(nestedResult);
  }

  for (const candidate of candidates) {
    if (typeof candidate !== "string") continue;
    const envelopeText = textFromToolResultEnvelope(candidate);
    if (envelopeText) return envelopeText;
    const text = candidate.trim();
    if (!text || isScheduleDetailsJsonPreview(text)) continue;
    return text;
  }
  return undefined;
};
