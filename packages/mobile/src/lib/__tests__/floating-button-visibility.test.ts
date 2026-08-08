import { describe, expect, test } from "bun:test";
import {
  deriveFloatingHidden,
  distanceFromBottom,
  FLOATING_NEAR_BOTTOM_PX,
  type FloatingScrollMetrics,
} from "../floating-button-visibility";

const metrics = (
  offsetY: number,
  contentHeight = 2000,
  layoutHeight = 800,
): FloatingScrollMetrics => ({ offsetY, contentHeight, layoutHeight });

// With contentHeight=2000 / layoutHeight=800, the bottom offset is 1200 and
// the near-bottom band starts at 1200 - FLOATING_NEAR_BOTTOM_PX = 1104.
const BOTTOM = 1200;
const MID = 600;

describe("distanceFromBottom", () => {
  test("zero at the exact bottom and clamped past it", () => {
    expect(distanceFromBottom(metrics(BOTTOM))).toBe(0);
    expect(distanceFromBottom(metrics(BOTTOM + 50))).toBe(0); // rubber band
  });

  test("positive when scrolled up", () => {
    expect(distanceFromBottom(metrics(MID))).toBe(600);
  });
});

describe("deriveFloatingHidden", () => {
  test("scrolling up mid-list hides", () => {
    expect(deriveFloatingHidden(false, MID, metrics(MID - 10))).toBe(true);
  });

  test("scrolling down mid-list shows", () => {
    expect(deriveFloatingHidden(true, MID, metrics(MID + 10))).toBe(false);
  });

  test("sub-threshold jitter keeps previous state", () => {
    expect(deriveFloatingHidden(true, MID, metrics(MID + 2))).toBe(true);
    expect(deriveFloatingHidden(false, MID, metrics(MID - 2))).toBe(false);
  });

  test("invariant: near bottom is always visible, even on an upward delta", () => {
    // Overshoot-and-correct at the end of a fling: last event moves up but
    // lands inside the near-bottom band.
    expect(
      deriveFloatingHidden(true, BOTTOM + 40, metrics(BOTTOM - 20)),
    ).toBe(false);
  });

  test("slow drag to the bottom shows despite sub-threshold deltas", () => {
    // Every event's dy is under the direction threshold; the old direction
    // latch never unhid here. Position rule must take over inside the band.
    let hidden = true;
    let prev = BOTTOM - FLOATING_NEAR_BOTTOM_PX - 20;
    for (let y = prev + 3; y <= BOTTOM; y += 3) {
      hidden = deriveFloatingHidden(hidden, prev, metrics(y));
      prev = y;
    }
    expect(hidden).toBe(false);
  });

  test("zero-delta positional refresh (settle / content growth)", () => {
    // At rest near the bottom → must show, even with no direction info.
    const atBottom = metrics(BOTTOM - 10);
    expect(deriveFloatingHidden(true, atBottom.offsetY, atBottom)).toBe(false);
    // At rest mid-list → latch is preserved either way.
    const mid = metrics(MID);
    expect(deriveFloatingHidden(true, mid.offsetY, mid)).toBe(true);
    expect(deriveFloatingHidden(false, mid.offsetY, mid)).toBe(false);
  });

  test("content growth pushing the user out of the band keeps the latch", () => {
    // User was at the bottom (visible); a burst of streamed content grows the
    // list. Zero-delta refresh mid-list keeps the button visible (no
    // spurious hide), and the follow-scroll back down keeps it visible too.
    const grown = metrics(BOTTOM, 2600);
    expect(deriveFloatingHidden(false, grown.offsetY, grown)).toBe(false);
  });

  test("top rubber-band never hides", () => {
    expect(deriveFloatingHidden(true, 10, metrics(-5))).toBe(false);
    expect(deriveFloatingHidden(true, 0, metrics(0))).toBe(false);
  });

  test("short list that never overflows stays visible", () => {
    const short = metrics(0, 400, 800);
    expect(deriveFloatingHidden(true, 0, short)).toBe(false);
  });
});
