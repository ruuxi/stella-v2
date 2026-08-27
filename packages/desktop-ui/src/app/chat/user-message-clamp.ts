export const USER_MESSAGE_COLLAPSE_LINES = 4;

export const USER_MESSAGE_OVERFLOW_EPSILON_PX = 1;

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
