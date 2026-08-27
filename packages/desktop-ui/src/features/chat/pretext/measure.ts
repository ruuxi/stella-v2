/**
 * Pretext-backed row height measurement for the chat transcript.
 *
 * The virtualized transcript (LegendList) has always had to guess row heights
 * (`estimatedItemSize`) and correct them after mount via ResizeObserver —
 * which is where scroll jumps come from. Pretext removes the guessing for the
 * common case: plain-text message bubbles. `prepare()` segments and measures
 * the text once against the browser's own font engine; `layout()` is then
 * pure arithmetic, so we can hand LegendList the *exact* pixel height of a
 * bubble row before it ever renders.
 *
 * Two ground rules keep the arithmetic honest:
 *
 * 1. The measured text must render with `font-kerning: none` and
 *    `font-variant-ligatures: none` (see `.chat-bubble-text` CSS). Kerning
 *    pairs and ligatures straddle segment boundaries and break additive
 *    width caching — this is the same trade Grok Bot's transcript makes.
 * 2. Only rows whose content is plain text go through this path. Anything
 *    with markdown structure (code, lists, headings, tables, images…)
 *    returns `undefined` and falls back to LegendList's measure-after-mount
 *    path, exactly as before.
 */
import { layout, prepare, type PreparedText } from "@chenglou/pretext";

/** Typography read off the live transcript, stamped with an epoch key. */
export interface TranscriptTypography {
  /** CSS font shorthand, e.g. `400 14px Inter, sans-serif`. */
  font: string;
  lineHeightPx: number;
  letterSpacingPx: number;
  /**
   * Cache key. Bump-by-value: any change to font, line height, letter
   * spacing or device pixel ratio produces a different epoch, which
   * invalidates every cached measurement.
   */
  epoch: string;
}

/**
 * Reads the effective typography from a rendered message-text element.
 * Call sparingly (mount + theme/zoom changes), never per row.
 */
export function readTranscriptTypography(el: HTMLElement): TranscriptTypography {
  const cs = getComputedStyle(el);
  const font = `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
  const lineHeightPx =
    Number.parseFloat(cs.lineHeight) || Number.parseFloat(cs.fontSize) * 1.5;
  const letterSpacingPx =
    cs.letterSpacing === "normal" ? 0 : Number.parseFloat(cs.letterSpacing) || 0;
  // Advance widths differ across device pixel ratios; quantize to quarters
  // so tiny zoom jitters don't thrash the cache.
  const dprBucket = Math.round((globalThis.devicePixelRatio ?? 1) * 4) / 4;
  return {
    font,
    lineHeightPx,
    letterSpacingPx,
    epoch: `${font}/${lineHeightPx}/${letterSpacingPx}/${dprBucket}`,
  };
}

/**
 * Markdown-significant syntax. If any of this appears, the row renders
 * through the full markdown pipeline and we do not predict its height.
 * Deliberately over-broad — a false positive only costs us the fallback
 * path, while a false negative would mis-measure a row.
 */
const MARKDOWN_SIGNIFICANT =
  /[`*_~#>|\\]|\[|\]|!\[|^-\s|^\d+\.\s|<\w|https?:\/\/\S*[()]/m;

/**
 * Anything the chat markdown pipeline replaces with a non-text box, which
 * pretext measures as plain glyphs and would therefore get wrong:
 *  - any URI (`remarkStellaFileLinks` turns `stella://file/...` into a chip,
 *    and autolinked http(s) URLs become anchors that can wrap differently);
 *  - emoji / pictographs (`remarkEmojiSprites` swaps them for sized sprite
 *    spans when an emoji pack is active).
 */
const NON_TEXT_SUBSTITUTION = /:\/\/|\p{Extended_Pictographic}/u;

export function isPlainText(text: string): boolean {
  return !MARKDOWN_SIGNIFICANT.test(text) && !NON_TEXT_SUBSTITUTION.test(text);
}

/** LRU of prepared texts. `prepare()` is the expensive half; keep it hot. */
const preparedCache = new Map<string, PreparedText>();
const PREPARED_CACHE_MAX = 600;

type WhiteSpaceMode = "normal" | "pre-wrap";

function preparedFor(
  text: string,
  typo: TranscriptTypography,
  whiteSpace: WhiteSpaceMode = "normal",
): PreparedText {
  const key = `${typo.epoch}|${whiteSpace}|${text}`;
  const hit = preparedCache.get(key);
  if (hit) {
    // Refresh recency.
    preparedCache.delete(key);
    preparedCache.set(key, hit);
    return hit;
  }
  const prepared = prepare(text, typo.font, {
    ...(whiteSpace === "pre-wrap" ? { whiteSpace } : {}),
    letterSpacing: typo.letterSpacingPx || undefined,
  });
  preparedCache.set(key, prepared);
  if (preparedCache.size > PREPARED_CACHE_MAX) {
    const oldest = preparedCache.keys().next().value;
    if (oldest !== undefined) preparedCache.delete(oldest);
  }
  return prepared;
}

/**
 * Exact rendered height of a plain-text run at `maxWidthPx`, or `undefined`
 * when the text isn't safely measurable (markdown, empty, degenerate width).
 *
 * Paragraphs (blank-line separated) are laid out independently and summed,
 * mirroring how the markdown renderer emits one block per paragraph;
 * `paragraphGapPx` is the vertical margin between those blocks.
 */
export function measurePlainTextHeight(
  text: string,
  typo: TranscriptTypography,
  maxWidthPx: number,
  paragraphGapPx = 0,
): number | undefined {
  if (maxWidthPx <= 8) return undefined;
  const trimmed = text.trim();
  if (trimmed.length === 0) return undefined;
  if (!isPlainText(trimmed)) return undefined;
  const paragraphs = trimmed.split(/\n{2,}/);
  let height = 0;
  for (let i = 0; i < paragraphs.length; i++) {
    const para = paragraphs[i].replace(/\n/g, " ").trim();
    if (para.length === 0) continue;
    const result = layout(
      preparedFor(para, typo),
      maxWidthPx,
      typo.lineHeightPx,
    );
    height += result.height;
    if (i > 0) height += paragraphGapPx;
  }
  return height > 0 ? height : undefined;
}

/**
 * Exact rendered height of a `white-space: pre-wrap` run — the user bubble's
 * `.event-body`, where runs of spaces and hard newlines stay visible — or
 * `undefined` when it isn't safely measurable. Unlike the markdown path the
 * text is measured verbatim in one piece, with pretext in `pre-wrap` mode.
 */
export function measurePreWrapTextHeight(
  text: string,
  typo: TranscriptTypography,
  maxWidthPx: number,
): number | undefined {
  if (maxWidthPx <= 8) return undefined;
  if (text.length === 0) return undefined;
  const { height } = layout(
    preparedFor(text, typo, "pre-wrap"),
    maxWidthPx,
    typo.lineHeightPx,
  );
  return height > 0 ? height : undefined;
}

/** Drop every cached measurement (call on epoch change). */
export function clearMeasurementCache(): void {
  preparedCache.clear();
}
