export function applyTabBarChrome(options: {
  /** React node handle of the host view whose subtree to adjust. */
  viewTag: number | null;
  /** Registered family name for the tab titles; null keeps the system font. */
  titleFontFamily: string | null;
  titleSize: number;
  /** Symbol point size for the tab icons; 0 or omitted keeps the system size. */
  iconPointSize?: number;
  /** Scale applied to the bar about its bottom edge; 1 keeps the system size. */
  scale?: number;
}): void;
