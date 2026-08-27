export const USER_MESSAGE_COLLAPSE_LINES = 4;

export const USER_MESSAGE_MEASURE_LINES = USER_MESSAGE_COLLAPSE_LINES + 1;

export const USER_MESSAGE_MOBILE_FONT_SIZE_PX = 17;
export const USER_MESSAGE_MOBILE_LINE_HEIGHT = 1.52;

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
