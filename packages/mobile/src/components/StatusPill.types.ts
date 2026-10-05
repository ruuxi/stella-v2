import type { ReactNode } from "react";

/** The top bar's side buttons' diameter; the pill shares their height. */
export const STATUS_PILL_HEIGHT = 44;

/** Inset between the glass edge and the pill's content, as in the side buttons. */
export const STATUS_PILL_INSET = 7;

/** Spring both the native glass and the content ride, so they move together. */
export const STATUS_PILL_SPRING = { duration: 420, dampingRatio: 0.88 } as const;

export type StatusPillProps = {
  /** Width the glass settles at. Equal to the height, the pill is a circle. */
  width: number;
  /**
   * Width reserved for the pill while it resizes: the larger of where it was
   * and where it is going, so a shrinking glass is never cut off mid-way.
   */
  slotWidth: number;
  onPress: () => void;
  accessibilityLabel: string;
  children: ReactNode;
};
