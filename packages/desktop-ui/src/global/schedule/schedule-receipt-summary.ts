/**
 * Helpers for the Schedule dialog summary line. Keeps structured schedule
 * side-channel JSON and raw tool-result envelopes out of user-facing copy.
 */

/**
 * Anything that reads as serialized structure is never summary copy: the
 * persisted schedule side-channel JSON, a non-envelope JSON result, or a
 * runtime `resultPreview` sliced at 200 chars mid-envelope, which fails
 * `JSON.parse` yet would otherwise fall through to the raw-string path and
 * render truncated JSON garbage. Prefix check on purpose: a parse test
 * cannot recognise the truncated forms.
 */
const looksLikeSerializedStructure = (text: string): boolean =>
  text.startsWith("{") || text.startsWith("[");

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
    if (envelopeText) {
      // An envelope whose text block is itself serialized structure renders
      // nothing from this candidate; a later candidate may still be prose.
      if (looksLikeSerializedStructure(envelopeText)) continue;
      return envelopeText;
    }
    const text = candidate.trim();
    if (!text || looksLikeSerializedStructure(text)) continue;
    return text;
  }
  return undefined;
};
