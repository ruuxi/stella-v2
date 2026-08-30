import { describe, expect, test } from "bun:test";
import {
  BREATHE_AMPLITUDE,
  DOT_CYCLE_MS,
  DOT_ENTRANCE_STAGGER,
  DOT_LIFT_UNITS,
  DOT_PHASE_OFFSET,
  breatheScale,
  clamp01,
  dotEntrance,
  dotGaussian,
  dotWave,
  easeOutBack,
  easeOutCubic,
  morphEnvelope,
  voiceScale,
  wrappedDistance,
} from "../stella-mark/motion";

/**
 * The mark's motion is worklet arithmetic, so it can be evaluated here directly.
 * `bun test` has no React Native renderer, which is exactly why the math lives
 * outside the components.
 */

describe("morph envelope", () => {
  test("runs from rest to fully morphed and clamps outside the window", () => {
    expect(morphEnvelope(0)).toBe(0);
    expect(morphEnvelope(1)).toBe(1);
    expect(morphEnvelope(-0.5)).toBe(0);
    expect(morphEnvelope(2)).toBe(1);
  });

  test("has the shape of a critically damped spring — monotonic, no overshoot", () => {
    let previous = 0;
    for (let i = 1; i <= 40; i += 1) {
      const value = morphEnvelope(i / 40);
      expect(value).toBeGreaterThan(previous);
      expect(value).toBeLessThanOrEqual(1);
      previous = value;
    }
  });

  test("is past halfway by a quarter of the settle window and nearly there by two thirds", () => {
    expect(morphEnvelope(0.25)).toBeGreaterThan(0.4);
    expect(morphEnvelope(0.25)).toBeLessThan(0.6);
    expect(morphEnvelope(2 / 3)).toBeGreaterThan(0.9);
  });
});

describe("wrapped distance", () => {
  test("measures around the cycle seam, not across it", () => {
    expect(wrappedDistance(0.05, 0.95)).toBeCloseTo(0.1, 10);
    expect(wrappedDistance(0.1, 0.4)).toBeCloseTo(0.3, 10);
    expect(wrappedDistance(0.5, 0.5)).toBe(0);
  });
});

const peakAt = (slot: number) =>
  ((slot / 3 - DOT_PHASE_OFFSET + 1) % 1) * DOT_CYCLE_MS;

describe("dot bounce wave", () => {
  test("each slot peaks once per cycle, a third of a cycle apart", () => {
    for (const slot of [0, 1, 2]) {
      expect(dotGaussian(slot, peakAt(slot))).toBeCloseTo(1, 6);
    }
  });

  test("the peak travels left → middle → right, a third of a cycle apart", () => {
    const third = DOT_CYCLE_MS / 3;
    const gap = (from: number, to: number) =>
      (peakAt(to) - peakAt(from) + DOT_CYCLE_MS) % DOT_CYCLE_MS;
    expect(gap(0, 1)).toBeCloseTo(third, 6);
    expect(gap(1, 2)).toBeCloseTo(third, 6);
  });

  test("wraps across the cycle seam without a discontinuity", () => {
    const beforeSeam = dotGaussian(0, DOT_CYCLE_MS - 1);
    const afterSeam = dotGaussian(0, DOT_CYCLE_MS + 1);
    expect(Math.abs(beforeSeam - afterSeam)).toBeLessThan(0.02);
  });

  test("lift, pop and tone all ride the same gaussian within their spec range", () => {
    for (let ms = 0; ms < DOT_CYCLE_MS; ms += 37) {
      const wave = dotWave(1, ms);
      expect(wave.gaussian).toBeGreaterThanOrEqual(0);
      expect(wave.gaussian).toBeLessThanOrEqual(1);
      expect(wave.liftUnits).toBeCloseTo(wave.gaussian * DOT_LIFT_UNITS, 10);
      expect(wave.scale).toBeGreaterThanOrEqual(0.84);
      expect(wave.scale).toBeLessThanOrEqual(0.84 + 0.22 + 1e-9);
      expect(wave.opacity).toBeGreaterThanOrEqual(0.5);
      expect(wave.opacity).toBeLessThanOrEqual(1 + 1e-9);
    }
  });
});

describe("entrance", () => {
  test("dots cascade — a later slot starts after an earlier one", () => {
    expect(dotEntrance(0, DOT_ENTRANCE_STAGGER)).toBeGreaterThan(0);
    expect(dotEntrance(2, DOT_ENTRANCE_STAGGER)).toBe(0);

    expect(dotEntrance(0, 1)).toBe(1);
    expect(dotEntrance(1, 1)).toBe(1);
    expect(dotEntrance(2, 1)).toBe(1);
  });

  test("easings are clamped and land on their endpoints", () => {
    expect(easeOutCubic(0)).toBe(0);
    expect(easeOutCubic(1)).toBe(1);
    expect(easeOutCubic(-1)).toBe(0);
    expect(easeOutBack(0)).toBeCloseTo(0, 10);
    expect(easeOutBack(1)).toBeCloseTo(1, 10);

    expect(easeOutBack(0.7)).toBeGreaterThan(1);
  });
});

describe("hero breathing", () => {
  test("clamp01 keeps energy inside the unit range", () => {
    expect(clamp01(-1)).toBe(0);
    expect(clamp01(0.4)).toBe(0.4);
    expect(clamp01(9)).toBe(1);
    expect(clamp01(Number.NaN)).toBe(0);
  });

  test("breathing stays within its amplitude and voice adds gain on top", () => {
    for (let ms = 0; ms < 4000; ms += 53) {
      const scale = breatheScale(ms, BREATHE_AMPLITUDE);
      expect(scale).toBeGreaterThanOrEqual(1 - BREATHE_AMPLITUDE - 1e-9);
      expect(scale).toBeLessThanOrEqual(1 + BREATHE_AMPLITUDE + 1e-9);
    }
    expect(voiceScale(1, 0)).toBeGreaterThan(voiceScale(0, 0));
  });
});
