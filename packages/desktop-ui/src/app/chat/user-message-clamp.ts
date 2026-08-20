/**
 * Shared user-message collapse contract (desktop + mobile).
 *
 * Long USER bubbles show at most this many rendered text lines, then the
 * existing Show more / Show less affordance. Overflow is decided from the
 * actual laid-out box (scroll vs client height, or native line boxes), not
 * a character-count heuristic — so wrap width, font scale, and Unicode stay
 * correct.
 */
export const USER_MESSAGE_COLLAPSE_LINES = 4;

/** Ignore sub-pixel clamp rounding when comparing scroll vs client height. */
export const USER_MESSAGE_OVERFLOW_EPSILON_PX = 1;

/**
 * Desktop bubble type: 15px (`--font-size-lg`) at 1.5 line-height.
 * Kept as an explicit assumption so tests fail if the chat type contract
 * drifts without a matching clamp-height update.
 */
export const USER_MESSAGE_DESKTOP_FONT_SIZE_PX = 15;
export const USER_MESSAGE_DESKTOP_LINE_HEIGHT = 1.5;

export function collapsedUserMessageMaxHeight(args: {
  fontSizePx: number;
  lineHeight: number;
  maxLines?: number;
}): number {
  const lineHeightPx =
    args.lineHeight > 8 ? args.lineHeight : args.fontSizePx * args.lineHeight;
  return lineHeightPx * (args.maxLines ?? USER_MESSAGE_COLLAPSE_LINES);
}

export function isUserMessageOverflowing(args: {
  scrollHeight: number;
  clientHeight: number;
  epsilonPx?: number;
}): boolean {
  return (
    args.scrollHeight - args.clientHeight >
    (args.epsilonPx ?? USER_MESSAGE_OVERFLOW_EPSILON_PX)
  );
}

export function shouldShowUserMessageToggle(args: {
  overflowing: boolean;
  expanded: boolean;
}): boolean {
  return args.overflowing || args.expanded;
}
