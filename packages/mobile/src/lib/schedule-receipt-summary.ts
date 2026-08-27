const looksLikeSerializedStructure = (text: string): boolean =>
  text.startsWith("{") || text.startsWith("[");

const textFromToolResultEnvelope = (value: unknown): string | undefined => {
  const record =
    value && typeof value === "object" ? (value as { content?: unknown }) : null;
  const content = Array.isArray(record?.content)
    ? record!.content
    : (() => {
        if (typeof value !== "string") return undefined;
        const trimmed = value.trim();
        if (!trimmed.startsWith("{") || !trimmed.includes('"content"')) {
          return undefined;
        }
        try {
          const parsed = JSON.parse(trimmed) as { content?: unknown };
          return Array.isArray(parsed.content) ? parsed.content : undefined;
        } catch {
          return undefined;
        }
      })();
  if (!content) return undefined;
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

      if (looksLikeSerializedStructure(envelopeText)) continue;
      return envelopeText;
    }
    const text = candidate.trim();
    if (!text || looksLikeSerializedStructure(text)) continue;
    return text;
  }
  return undefined;
};

export const scheduleReceiptText = (payload: {
  resultPreview?: unknown;
  result?: unknown;
}): string | undefined => {
  const envelopeText = textFromToolResultEnvelope(payload.result);

  if (envelopeText) {
    return looksLikeSerializedStructure(envelopeText)
      ? undefined
      : envelopeText;
  }
  return pickScheduleToolSummary(payload);
};
