/**
 * Shared user-message collapse contract (desktop + mobile).
 *
 * Long USER bubbles show at most this many rendered text lines, then the
 * existing Show more / Show less affordance. Overflow is decided from the
 * native text-layout line boxes, not a character-count heuristic — so wrap
 * width, Dynamic Type, and Unicode stay correct.
 */
export const USER_MESSAGE_COLLAPSE_LINES = 4;

/**
 * Line cap used while measuring overflow. One line beyond the collapse cap is
 * enough to distinguish "fits in four lines" from "overflows", so a long sent
 * message never paints at full height first — which used to briefly inflate
 * the row and skew the post-send scroll anchor before the clamp collapsed it.
 */
export const USER_MESSAGE_MEASURE_LINES = USER_MESSAGE_COLLAPSE_LINES + 1;


/**
 * Mobile bubble type in ChatPane: 17px at 1.52 line-height.
 * Kept as an explicit assumption so tests fail if the bubble type drifts
 * without a matching clamp-height update.
 */
export const USER_MESSAGE_MOBILE_FONT_SIZE_PX = 17;
export const USER_MESSAGE_MOBILE_LINE_HEIGHT = 1.52;

/** Ignore sub-pixel width jitter when deciding to remasure wrap. */
export const USER_MESSAGE_WIDTH_REMEASURE_EPSILON_PX = 1;

export function collapsedUserMessageMaxHeight(args: {
  fontSizePx: number;
  lineHeight: number;
  maxLines?: number;
}): number {
  const lineHeightPx =
    args.lineHeight > 8 ? args.lineHeight : args.fontSizePx * args.lineHeight;
  return lineHeightPx * (args.maxLines ?? USER_MESSAGE_COLLAPSE_LINES);
}

export function isUserMessageTruncatable(
  totalLines: number | null,
  maxLines: number = USER_MESSAGE_COLLAPSE_LINES,
): boolean {
  return totalLines !== null && totalLines > maxLines;
}

/**
 * `numberOfLines` for the user-message <Text>. While `measuring`, render at
 * the measure cap (collapse + 1) instead of unclamped so overflow detection
 * never requires a full-height paint; once measured, clamp truncatable text
 * to the collapse cap unless expanded.
 */
export function userMessageNumberOfLines(args: {
  expanded: boolean;
  measuring: boolean;
  truncatable: boolean;
}): number | undefined {
  if (args.expanded) return undefined;
  if (args.measuring) return USER_MESSAGE_MEASURE_LINES;
  return args.truncatable ? USER_MESSAGE_COLLAPSE_LINES : undefined;
}

export function shouldShowUserMessageToggle(args: {
  overflowing: boolean;
  expanded: boolean;
}): boolean {
  return args.overflowing || args.expanded;
}

export function shouldRemeasureUserMessageWidth(
  previousWidth: number | null,
  nextWidth: number,
  epsilonPx: number = USER_MESSAGE_WIDTH_REMEASURE_EPSILON_PX,
): boolean {
  return (
    previousWidth !== null && Math.abs(previousWidth - nextWidth) >= epsilonPx
  );
}
