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

const BOTTOM = 1200;
const MID = 600;

describe("distanceFromBottom", () => {
  test("zero at the exact bottom and clamped past it", () => {
    expect(distanceFromBottom(metrics(BOTTOM))).toBe(0);
    expect(distanceFromBottom(metrics(BOTTOM + 50))).toBe(0);
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

    expect(
      deriveFloatingHidden(true, BOTTOM + 40, metrics(BOTTOM - 20)),
    ).toBe(false);
  });

  test("slow drag to the bottom shows despite sub-threshold deltas", () => {

    let hidden = true;
    let prev = BOTTOM - FLOATING_NEAR_BOTTOM_PX - 20;
    for (let y = prev + 3; y <= BOTTOM; y += 3) {
      hidden = deriveFloatingHidden(hidden, prev, metrics(y));
      prev = y;
    }
    expect(hidden).toBe(false);
  });

  test("zero-delta positional refresh (settle / content growth)", () => {

    const atBottom = metrics(BOTTOM - 10);
    expect(deriveFloatingHidden(true, atBottom.offsetY, atBottom)).toBe(false);

    const mid = metrics(MID);
    expect(deriveFloatingHidden(true, mid.offsetY, mid)).toBe(true);
    expect(deriveFloatingHidden(false, mid.offsetY, mid)).toBe(false);
  });

  test("content growth pushing the user out of the band keeps the latch", () => {

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
