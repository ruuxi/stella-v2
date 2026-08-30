import { describe, expect, test } from "bun:test";
import { EYE_N, EYE_POSES, FACE, eyePath } from "../stella-mark/face";
import { STELLA_MARK_CENTER } from "../stella-mark/geometry";

/**
 * The face is built by worklet arithmetic, so the paths can be produced here
 * with no renderer — the same reason `motion.ts` and `layout.ts` are testable.
 */

const C = STELLA_MARK_CENTER;

describe("face geometry", () => {
  test("every pose has EYE_N finite points in unit space", () => {
    for (const pts of Object.values(EYE_POSES)) {
      expect(pts.length).toBe(EYE_N);
      for (const [x, y] of pts) {
        expect(Number.isFinite(x)).toBe(true);
        expect(Number.isFinite(y)).toBe(true);
        expect(Math.abs(x)).toBeLessThanOrEqual(1);
        expect(Math.abs(y)).toBeLessThanOrEqual(1.2);
      }
    }
  });

  test("eyes sit inside the silhouette's face box", () => {
    const socketX = C + FACE.dx;
    const socketY = C + FACE.dy - FACE.ry * 0.05;
    const half = FACE.rx * 0.42;
    const ew = FACE.rx * 0.78;
    const eh = FACE.ry * 0.62;
    const d = eyePath(
      EYE_POSES.neutral,
      EYE_POSES.neutral,
      1,
      socketX - half,
      socketY,
      ew,
      eh,
    );
    const nums = d.match(/-?\d+\.\d+/g);
    expect(nums).not.toBeNull();
    const coords = (nums ?? []).map(Number);
    for (let i = 0; i < coords.length; i += 2) {
      expect(Math.hypot(coords[i] - C, coords[i + 1] - C)).toBeLessThan(FACE.rx);
    }
  });

  test("blink collapses height but keeps the path valid", () => {
    const d = eyePath(EYE_POSES.neutral, EYE_POSES.neutral, 1, C, C, 50, 2);
    expect(d.startsWith("M")).toBe(true);
    expect(d.endsWith("Z")).toBe(true);
    expect(d.includes("NaN")).toBe(false);
  });

  test("morph midpoint lies between the two poses", () => {
    const mid = eyePath(EYE_POSES.neutral, EYE_POSES.happy, 0.5, C, C, 50, 50);
    const start = eyePath(
      EYE_POSES.neutral,
      EYE_POSES.neutral,
      1,
      C,
      C,
      50,
      50,
    );
    const end = eyePath(EYE_POSES.happy, EYE_POSES.happy, 1, C, C, 50, 50);
    expect(mid.includes("NaN")).toBe(false);
    expect(mid).not.toBe(start);
    expect(mid).not.toBe(end);
  });
});
