import type { IconName } from "../Icon";

export type SidebarTabItem<K extends string> = {
  key: K;
  label: string;
  /** Spoken name; differs from `label` when the tab doubles as a toggle. */
  accessibilityLabel: string;
  icon: IconName;
};

export type SidebarTabBarProps<K extends string> = {
  tabs: readonly SidebarTabItem<K>[];
  value: K;
  /** Fires for every tap, including a tap on the current tab. */
  onSelect: (next: K) => void;
  /** Reports the rendered height so the list can pad past the bar. */
  onHeight?: (height: number) => void;
};

/** Height of the fallback bar, and the panel's estimate before layout. */
export const SIDEBAR_TAB_BAR_HEIGHT = 50;
