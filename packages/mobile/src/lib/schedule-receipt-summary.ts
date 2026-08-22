/**
 * Mobile port of the desktop `global/schedule/schedule-receipt-summary.ts`
 * (the v2 reference implementation). When a Schedule tool result comes back,
 * its human-readable summary renders as a plain-text line in the computer
 * chat — no chip or card — and structured schedule side-channel JSON never
 * reaches user-facing copy.
 *
 * The desktop version handles results that arrive as *serialized* tool-result
 * envelopes; on mobile the bridge already delivers `result` as a parsed
 * object (`{ content: [...] }`), so the envelope check runs against the
 * object shape directly, with the serialized-string path kept for older
 * desktops.
 */

/**
 * Anything that reads as serialized structure is never receipt copy: the
 * persisted schedule side-channel JSON, a non-envelope JSON result, or — the
 * sneaky one — a runtime `resultPreview` sliced at 200 chars mid-envelope,
 * which fails `JSON.parse` yet would otherwise fall through to the raw-string
 * path and render truncated JSON garbage in chat. Prefix check on purpose:
 * a parse test cannot recognise the truncated forms.
 */
const looksLikeSerializedStructure = (text: string): boolean =>
  text.startsWith("{") || text.startsWith("[");

/**
 * Pull the human-readable `text` out of a tool-result envelope — either the
 * parsed object the bridge delivers or its serialized JSON form. Returns
 * `undefined` for anything that isn't that shape.
 */
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

/**
 * Full receipt resolution for a Schedule tool result: prefer an envelope's
 * text blocks, then fall back to the preview/result summary picker. Anything
 * unparseable — including persisted schedule side-channel JSON previews —
 * yields nothing to render.
 */
export const scheduleReceiptText = (payload: {
  resultPreview?: unknown;
  result?: unknown;
}): string | undefined => {
  const envelopeText = textFromToolResultEnvelope(payload.result);
  // An envelope whose text is itself serialized structure (the persisted
  // side-channel JSON, say) renders nothing — and must not fall through to
  // the raw-string path.
  if (envelopeText) {
    return looksLikeSerializedStructure(envelopeText)
      ? undefined
      : envelopeText;
  }
  return pickScheduleToolSummary(payload);
};
