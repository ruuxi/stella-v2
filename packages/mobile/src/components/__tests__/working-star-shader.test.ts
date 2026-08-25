import { describe, expect, test } from "bun:test";
import {
  STAR_CYCLE_SECONDS,
  STAR_REST_TIME,
  WORKING_STAR_SKSL,
  starTurnFraction,
} from "../working-star-shader";

const near = (a: number, b: number, eps = 1e-4) => Math.abs(a - b) <= eps;

describe("working-star-shader SkSL source", () => {
  test("exposes a runtime-effect entry point and both required uniforms", () => {
    expect(WORKING_STAR_SKSL.includes("half4 main(float2 fragCoord)")).toBe(
      true,
    );
    expect(WORKING_STAR_SKSL.includes("uniform float uTime;")).toBe(true);
    expect(WORKING_STAR_SKSL.includes("uniform float2 uResolution;")).toBe(true);
  });

  test("uses SkSL types, not GLSL aliases or preprocessor directives", () => {
    // SkSL has no C preprocessor and spells matrices float2x2, not mat2.
    expect(WORKING_STAR_SKSL.includes("#define")).toBe(false);
    expect(WORKING_STAR_SKSL.includes("#ifdef")).toBe(false);
    expect(/\bmat2\b/.test(WORKING_STAR_SKSL)).toBe(false);
    expect(/\bvec[234]\b/.test(WORKING_STAR_SKSL)).toBe(false);
    expect(WORKING_STAR_SKSL.includes("float2x2")).toBe(true);
  });

  test("returns premultiplied color so Skia blends it correctly", () => {
    expect(WORKING_STAR_SKSL.includes("return half4(col * alpha, alpha);")).toBe(
      true,
    );
  });

  test("bakes the approved mobile gradient stops into the ramp", () => {
    // #00aad8 and #be57a4 are the ends of the approved five-stop ramp.
    expect(WORKING_STAR_SKSL.includes("#00aad8")).toBe(true);
    expect(WORKING_STAR_SKSL.includes("#be57a4")).toBe(true);
  });

  test("has balanced braces (cheap structural sanity check)", () => {
    const open = (WORKING_STAR_SKSL.match(/{/g) ?? []).length;
    const close = (WORKING_STAR_SKSL.match(/}/g) ?? []).length;
    expect(open).toBe(close);
  });
});

describe("starTurnFraction cadence parity", () => {
  test("rests at zero turn and completes exactly one turn per cycle", () => {
    expect(near(starTurnFraction(0), 0)).toBe(true);
    expect(near(starTurnFraction(1), 1)).toBe(true);
    expect(STAR_CYCLE_SECONDS).toBe(3.2);
    expect(STAR_REST_TIME).toBe(0);
  });

  test("reaches the drift and wind-up plateaus at the staged boundaries", () => {
    // End of the eased drift: an eighth of a turn.
    expect(near(starTurnFraction(0.5), 0.125)).toBe(true);
    // Bottom of the backward wind-up.
    expect(near(starTurnFraction(0.57), 0.114)).toBe(true);
  });

  test("winds backward before the whip (anticipation dips below the drift)", () => {
    expect(starTurnFraction(0.57) < starTurnFraction(0.5)).toBe(true);
  });

  test("overshoots past a full turn during the sprung landing", () => {
    let sawOvershoot = false;
    for (let p = 0.88; p < 1; p += 0.005) {
      if (starTurnFraction(p) > 1) {
        sawOvershoot = true;
        break;
      }
    }
    expect(sawOvershoot).toBe(true);
  });
});
