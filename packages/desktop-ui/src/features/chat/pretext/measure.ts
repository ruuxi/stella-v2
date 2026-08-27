import { layout, prepare, type PreparedText } from "@chenglou/pretext";

export interface TranscriptTypography {

  font: string;
  lineHeightPx: number;
  letterSpacingPx: number;

  epoch: string;
}

export function readTranscriptTypography(el: HTMLElement): TranscriptTypography {
  const cs = getComputedStyle(el);
  const font = `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
  const lineHeightPx =
    Number.parseFloat(cs.lineHeight) || Number.parseFloat(cs.fontSize) * 1.5;
  const letterSpacingPx =
    cs.letterSpacing === "normal" ? 0 : Number.parseFloat(cs.letterSpacing) || 0;

  const dprBucket = Math.round((globalThis.devicePixelRatio ?? 1) * 4) / 4;
  return {
    font,
    lineHeightPx,
    letterSpacingPx,
    epoch: `${font}/${lineHeightPx}/${letterSpacingPx}/${dprBucket}`,
  };
}

const MARKDOWN_SIGNIFICANT =
  /[`*_~#>|\\]|\[|\]|!\[|^-\s|^\d+\.\s|<\w|https?:\/\/\S*[()]/m;

const NON_TEXT_SUBSTITUTION = /:\/\/|\p{Extended_Pictographic}/u;

export function isPlainText(text: string): boolean {
  return !MARKDOWN_SIGNIFICANT.test(text) && !NON_TEXT_SUBSTITUTION.test(text);
}

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

export function clearMeasurementCache(): void {
  preparedCache.clear();
}
