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
