export function applyTabBarChrome(options: {
  /** React node handle of the host view whose subtree to adjust. */
  viewTag: number | null;
  /** Registered family name for the tab titles; null keeps the system font. */
  titleFontFamily: string | null;
  titleSize: number;
}): void;
