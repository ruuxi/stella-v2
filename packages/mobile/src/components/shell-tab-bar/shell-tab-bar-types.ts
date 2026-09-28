import type { IconName } from "../Icon";

export type ShellTabItem<K extends string> = {
  key: K;
  label: string;
  icon: IconName;
};

export type ShellTabBarProps<K extends string> = {
  tabs: readonly ShellTabItem<K>[];
  value: K;
  /** Fires for every tap, including a tap on the current tab. */
  onSelect: (next: K) => void;
};

/**
 * The least room kept under the bar, for screens with no home indicator
 * (where the safe-area inset is 0).
 */
export const SHELL_TAB_BAR_MIN_EDGE = 12;

/** The line the bar rests on: the safe-area inset, or the minimum edge. */
export const shellTabBarBase = (safeBottom: number): number =>
  Math.max(safeBottom, SHELL_TAB_BAR_MIN_EDGE);

/**
 * Screen-bottom band the bar covers above `shellTabBarBase`: the platter
 * plus its breathing room. Routes pad by this (via `useShellBottomInset`) so
 * their last row and the chat composer rest above the bar.
 */
export const SHELL_TAB_BAR_RESERVE = 61;

/** Height of the fallback platter. */
export const SHELL_TAB_BAR_HEIGHT = 56;
