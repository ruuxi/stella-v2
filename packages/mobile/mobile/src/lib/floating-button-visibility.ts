/**
 * Visibility derivation for the floating settings (gear) button on the chat
 * screen.
 *
 * The button hides while the user scrolls up through history and reappears
 * when they head back toward the latest message. The old implementation was a
 * pure direction latch: it only flipped on scroll events whose delta crossed a
 * threshold. That broke intermittently — a slow drag back down emits deltas
 * under the threshold, and a fling/auto-scroll can end without a final
 * downward-delta event — leaving the button hidden while the user sits at the
 * bottom.
 *
 * This module derives visibility from position first, direction second, so the
 * invariant "near the bottom ⇒ visible" always holds:
 *
 *   1. Near the bottom (within `FLOATING_NEAR_BOTTOM_PX`) → visible, always.
 *      This is re-evaluated on every scroll event, on scroll settle (drag end /
 *      momentum end), and on content-size changes — not just direction flips.
 *   2. At/above the top rubber-band (offset ≤ 0) → visible (legacy behavior;
 *      short lists never hide the button).
 *   3. Otherwise, mid-list: scrolling up hides, scrolling down shows, and
 *      sub-threshold jitter keeps the previous state.
 */

/** Distance from the bottom (px) inside which the button must be visible. */
export const FLOATING_NEAR_BOTTOM_PX = 96;
/** Minimum per-event scroll delta (px) treated as intentional direction. */
export const FLOATING_DIRECTION_DELTA_PX = 4;

export interface FloatingScrollMetrics {
  /** Current scroll offset (non-inverted list: grows toward the bottom). */
  offsetY: number;
  contentHeight: number;
  layoutHeight: number;
}

export function distanceFromBottom(metrics: FloatingScrollMetrics): number {
  return Math.max(
    0,
    metrics.contentHeight - metrics.offsetY - metrics.layoutHeight,
  );
}

/**
 * Derive the button's hidden state after a scroll event.
 *
 * @param prevHidden hidden state before this event
 * @param prevOffsetY offset from the previous scroll event (pass `offsetY`
 *   when no direction information exists, e.g. settle / content growth — the
 *   zero delta keeps the latch and only the positional rules apply)
 */
export function deriveFloatingHidden(
  prevHidden: boolean,
  prevOffsetY: number,
  metrics: FloatingScrollMetrics,
): boolean {
  // Invariant: near the bottom the button is always visible, regardless of
  // how we got here (slow drag, fling, auto-scroll, content growth).
  if (distanceFromBottom(metrics) <= FLOATING_NEAR_BOTTOM_PX) return false;

  // Rubber-band/overscroll past the top — never hide.
  if (metrics.offsetY <= 0) return false;

  const dy = metrics.offsetY - prevOffsetY;
  if (dy > FLOATING_DIRECTION_DELTA_PX) return false; // heading down
  if (dy < -FLOATING_DIRECTION_DELTA_PX) return true; // heading up
  return prevHidden;
}
