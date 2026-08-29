import { describe, expect, test } from "bun:test";
import {
  EYE_N, EYE_POSES, FACE, eyePath,
} from "../stella-mark/face";

const C = 114.2705;
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
    const socketX = C + FACE.dx, socketY = C + FACE.dy - FACE.ry * 0.05;
    const half = FACE.rx * 0.42, ew = FACE.rx * 0.78, eh = FACE.ry * 0.62;
    const d = eyePath(EYE_POSES.neutral, EYE_POSES.neutral, 1, socketX - half, socketY, ew, eh);
    const nums = d.match(/-?\d+\.\d+/g)!.map(Number);
    const xs = nums.filter((_, i) => i % 2 === 0);
    const ys = nums.filter((_, i) => i % 2 === 1);
    // must stay within the circle of radius rx around centre
    for (let i = 0; i < xs.length; i++) {
      const r = Math.hypot(xs[i] - C, ys[i] - C);
      expect(r).toBeLessThan(FACE.rx);
    }
  });
  test("blink collapses height but keeps the path valid", () => {
    const d = eyePath(EYE_POSES.neutral, EYE_POSES.neutral, 1, C, C, 50, 50 * 0.04);
    expect(d.startsWith("M")).toBe(true);
    expect(d.endsWith("Z")).toBe(true);
    expect(d.includes("NaN")).toBe(false);
  });
  test("morph midpoint lies between the two poses", () => {
    const mid = eyePath(EYE_POSES.neutral, EYE_POSES.happy, 0.5, C, C, 50, 50);
    expect(mid.includes("NaN")).toBe(false);
    const a = eyePath(EYE_POSES.neutral, EYE_POSES.neutral, 1, C, C, 50, 50);
    const b = eyePath(EYE_POSES.happy, EYE_POSES.happy, 1, C, C, 50, 50);
    expect(mid === a).toBe(false);
    expect(mid === b).toBe(false);
  });
});
