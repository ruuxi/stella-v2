import { describe, expect, test } from "bun:test";
import {
  DOT_SHRINK,
  middleDotScale,
  morphShrink,
  sideDotScale,
  stellaMarkLayout,
} from "../stella-mark/layout";

const INDICATOR_SIZE = 28;

describe("stella mark dot layout", () => {
  test("dots are laid out at their settled pixel size, not scaled down to it", () => {
    const layout = stellaMarkLayout(INDICATOR_SIZE);
    expect(layout.dotPx).toBeCloseTo(INDICATOR_SIZE * DOT_SHRINK * 1.5, 10);
    expect(layout.dotPx).toBeLessThan(INDICATOR_SIZE);
    expect(layout.sideDotPx).toBeGreaterThan(layout.dotPx);
  });

  test("every dot rests at scale 1 so nothing is resampled while it waves", () => {
    const layout = stellaMarkLayout(INDICATOR_SIZE);
    expect(middleDotScale(1, layout)).toBeCloseTo(1, 12);
    expect(sideDotScale(1, layout.zoom)).toBeCloseTo(1, 12);
  });

  test("the morph starts from the untouched full mark", () => {
    const layout = stellaMarkLayout(INDICATOR_SIZE);
    expect(morphShrink(0, layout.zoom)).toBe(1);
    expect(middleDotScale(0, layout)).toBeCloseTo(layout.dotOversize, 12);
  });

  test("shrinking is monotonic across the morph", () => {
    const layout = stellaMarkLayout(INDICATOR_SIZE);
    let previous = Infinity;
    for (let i = 0; i <= 20; i += 1) {
      const value = middleDotScale(i / 20, layout);
      expect(value).toBeLessThan(previous);
      previous = value;
    }
  });

  test("a large mark skips the dots zoom entirely", () => {
    const layout = stellaMarkLayout(64);
    expect(layout.zoom).toBe(1);
    expect(sideDotScale(0, layout.zoom)).toBe(1);
    expect(middleDotScale(1, layout)).toBeCloseTo(1, 12);
  });
});
