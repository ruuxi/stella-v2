import { describe, expect, test } from "bun:test";
import {
  BREATHE_AMPLITUDE,
  breatheScale,
  clamp01,
  voiceScale,
} from "../stella-mark/motion";
import {
  AMP_X,
  CX,
  DIAMOND_PATH,
  DOT_STATIONS,
  HALF_H,
  HALF_W,
  MID_Y,
  MODE_ORBIT,
  MODE_PARKED,
  PARK_Y,
  SHEEN_PERIOD,
  SHEEN_PERIODS,
  SHEEN_STOPS,
  SHEEN_X0,
  SPIN_MS,
  SPIN_ZOOM,
  TRAVEL_MS,
  computeSpinnerFrame,
  diamondPath,
  easeInOutCubic,
  easeOutBack,
  makeDotState,
} from "../stella-mark/top-spinner";

const DOT_STRIDE = 12;

function runFrames(
  durationMs: number,
  stepMs = 1000 / 60,
  morph = 0,
  state = makeDotState(),
) {
  let last = computeSpinnerFrame(0, 0, morph, false, state);
  for (let t = stepMs; t <= durationMs; t += stepMs) {
    last = computeSpinnerFrame(t, stepMs / 1000, morph, false, state);
  }
  return { frame: last, state };
}

describe("diamond geometry", () => {
  test("four points with concave edges, tip up and tip down on the axis", () => {
    expect(DIAMOND_PATH.startsWith(`M${CX} ${(MID_Y - HALF_H).toFixed(2)}`)).toBe(
      true,
    );
    expect(DIAMOND_PATH.endsWith("Z")).toBe(true);
    expect(DIAMOND_PATH.split("Q").length - 1).toBe(4);
    expect(DIAMOND_PATH).toContain(`${(CX + HALF_W).toFixed(2)}`);
  });

  test("aspect narrows the waist, concavity pulls the edges inward", () => {
    const wide = diamondPath(1, 0.6);
    const narrow = diamondPath(0.4, 0.6);
    expect(wide === narrow).toBe(false);
    expect(diamondPath(0.68, 0.05) === diamondPath(0.68, 0.6)).toBe(false);
    expect(diamondPath(0.68, 0.6)).toBe(DIAMOND_PATH);
  });
});

describe("easings", () => {
  test("clamped and landing on their endpoints", () => {
    expect(easeInOutCubic(0)).toBe(0);
    expect(easeInOutCubic(1)).toBe(1);
    expect(easeInOutCubic(-2)).toBe(0);
    expect(easeInOutCubic(0.5)).toBeCloseTo(0.5, 10);
    expect(easeOutBack(0)).toBeCloseTo(0, 10);
    expect(easeOutBack(1)).toBeCloseTo(1, 10);
    expect(easeOutBack(0.7)).toBeGreaterThan(1);
  });
});

describe("travel", () => {
  test("mirrored figure eight — the lap starts by swinging left", () => {
    const early = computeSpinnerFrame(TRAVEL_MS * 0.05, 0.016, 0, false, makeDotState());
    expect(early.tx).toBeLessThan(0);
  });

  test("half travel reaches the spec amplitude and returns to centre each lap", () => {
    const quarter = computeSpinnerFrame(TRAVEL_MS * 0.25, 0.016, 0, false, makeDotState());
    expect(quarter.tx).toBeCloseTo(-AMP_X, 6);
    const lap = computeSpinnerFrame(TRAVEL_MS, 0.016, 0, false, makeDotState());
    expect(Math.abs(lap.tx)).toBeLessThan(1e-9);
  });

  test("travel collapses to nothing as the mark morphs into the character", () => {
    const spinner = computeSpinnerFrame(TRAVEL_MS * 0.25, 0.016, 0, false, makeDotState());
    const halfway = computeSpinnerFrame(TRAVEL_MS * 0.25, 0.016, 0.5, false, makeDotState());
    const blob = computeSpinnerFrame(TRAVEL_MS * 0.25, 0.016, 1, false, makeDotState());
    expect(Math.abs(halfway.tx)).toBeLessThan(Math.abs(spinner.tx));
    expect(blob.tx).toBeCloseTo(0, 12);
    expect(blob.lean).toBe(0);
    expect(blob.bodySy).toBe(1);
  });
});

describe("lean", () => {
  test("precession swings the lean either side of upright over one turn", () => {
    let min = Infinity;
    let max = -Infinity;
    for (let t = 0; t < 2100; t += 20) {
      const f = computeSpinnerFrame(t, 0.016, 0, false, makeDotState());
      min = Math.min(min, f.lean);
      max = Math.max(max, f.lean);
    }
    expect(max).toBeGreaterThan(11);
    expect(min).toBeLessThan(-11);
    expect(max).toBeLessThan(13);
  });

  test("the body squashes as the spin axis turns away from the viewer", () => {
    for (let t = 0; t < 2100; t += 37) {
      const f = computeSpinnerFrame(t, 0.016, 0, false, makeDotState());
      expect(f.bodySy).toBeLessThanOrEqual(1 + 1e-9);
      expect(f.bodySy).toBeGreaterThan(0.97);
    }
  });
});

describe("sheen", () => {
  test("cyclic stops tile the diamond width a whole number of times", () => {
    expect(SHEEN_PERIOD).toBeCloseTo(HALF_W * 2, 10);
    expect(SHEEN_STOPS[0].offset).toBe(0);
    expect(SHEEN_STOPS[SHEEN_STOPS.length - 1].offset).toBe(1);
    for (let i = 1; i < SHEEN_STOPS.length; i += 1) {
      expect(SHEEN_STOPS[i].offset).toBeGreaterThan(SHEEN_STOPS[i - 1].offset);
    }
    expect(SHEEN_STOPS.filter((s) => s.opacity === 0.17).length).toBe(
      SHEEN_PERIODS,
    );
    expect(SHEEN_STOPS.filter((s) => s.opacity === 0.13).length).toBe(
      SHEEN_PERIODS,
    );
  });

  test("the band slides exactly one period per revolution and covers the body", () => {
    const start = computeSpinnerFrame(0, 0.016, 0, false, makeDotState());
    const wrap = computeSpinnerFrame(SPIN_MS, 0.016, 0, false, makeDotState());
    expect(start.sheenX).toBeCloseTo(SHEEN_X0, 10);
    expect(wrap.sheenX).toBeCloseTo(SHEEN_X0, 10);
    for (let t = 0; t < SPIN_MS; t += 7) {
      const f = computeSpinnerFrame(t, 0.016, 0, false, makeDotState());
      expect(f.sheenX).toBeLessThanOrEqual(SHEEN_X0 + 1e-9);
      expect(f.sheenX).toBeGreaterThan(SHEEN_X0 - SHEEN_PERIOD - 1e-9);
      expect(f.sheenX).toBeLessThanOrEqual(CX - HALF_W);
      expect(f.sheenX + SHEEN_PERIOD * SHEEN_PERIODS).toBeGreaterThanOrEqual(
        CX + HALF_W,
      );
    }
  });
});

describe("orbit dots", () => {
  test("all three are laid down as an ellipsis within the first lap", () => {
    const { state } = runFrames(TRAVEL_MS * 1.1);
    for (let i = 0; i < 3; i += 1) {
      expect(state[i * DOT_STRIDE]).toBe(MODE_PARKED);
    }
  });

  test("they park at the left, centre and right of the travelled path", () => {
    const { frame, state } = runFrames(TRAVEL_MS * 1.1);
    const parked = [0, 1, 2].map((i) => state[i * DOT_STRIDE + 2]);
    expect(parked[0]).toBeCloseTo(CX - AMP_X, 6);
    expect(parked[1]).toBeCloseTo(CX, 6);
    expect(parked[2]).toBeCloseTo(CX + AMP_X, 6);
    for (let i = 0; i < 3; i += 1) {
      expect(frame.dotY[i]).toBeCloseTo(PARK_Y, 6);
      expect(frame.dotFront[i]).toBeGreaterThan(0);
      expect(frame.dotBack[i]).toBe(0);
    }
  });

  test("the second lap collects every dot back into orbit", () => {
    const { state } = runFrames(TRAVEL_MS * 2.2);
    for (let i = 0; i < 3; i += 1) {
      expect(state[i * DOT_STRIDE]).toBe(MODE_ORBIT);
    }
  });

  test("stations sit on the sine of the travel path", () => {
    for (let i = 0; i < 3; i += 1) {
      const stationX = CX - Math.sin(DOT_STATIONS[i]) * AMP_X;
      expect(Number.isFinite(stationX)).toBe(true);
    }
    expect(DOT_STATIONS.length).toBe(3);
  });

  test("dots are dropped once the mark starts becoming the character", () => {
    const frame = computeSpinnerFrame(500, 0.016, 0.6, false, makeDotState());
    for (let i = 0; i < 3; i += 1) {
      expect(frame.dotFront[i]).toBe(0);
      expect(frame.dotBack[i]).toBe(0);
    }
  });
});

describe("morph handoff", () => {
  test("the spinner fades out early and the character grows in behind it", () => {
    const rest = computeSpinnerFrame(0, 0.016, 0, false, makeDotState());
    expect(rest.bodyOpacity).toBe(1);
    expect(rest.blobOpacity).toBe(0);
    expect(rest.zoom).toBeCloseTo(SPIN_ZOOM, 10);

    const mid = computeSpinnerFrame(0, 0.016, 0.5, false, makeDotState());
    expect(mid.bodyOpacity).toBe(0);
    expect(mid.blobOpacity).toBeGreaterThan(0);
    expect(mid.blobOpacity).toBeLessThan(1);

    const done = computeSpinnerFrame(0, 0.016, 1, false, makeDotState());
    expect(done.blobOpacity).toBe(1);
    expect(done.blobScale).toBeCloseTo(1, 10);
    expect(done.blobY).toBeCloseTo(0, 10);
    expect(done.zoom).toBeCloseTo(1, 10);
  });

  test("the character overshoots on the way in, the way easeOutBack does", () => {
    let peak = 0;
    for (let m = 0; m <= 1; m += 0.01) {
      peak = Math.max(peak, computeSpinnerFrame(0, 0.016, m, false, makeDotState()).blobScale);
    }
    expect(peak).toBeGreaterThan(1);
  });
});

describe("reduced motion", () => {
  test("parks the top upright and still with the gradient intact", () => {
    const f = computeSpinnerFrame(1234, 0.016, 0, true, makeDotState());
    expect(f.tx).toBeCloseTo(0, 12);
    expect(f.ty).toBeCloseTo(0, 12);
    expect(f.lean).toBe(0);
    expect(f.bodySy).toBeCloseTo(1, 10);
    expect(f.bodyOpacity).toBe(1);
    expect(f.lensOpacity).toBe(0);
    expect(f.sheenX).toBeCloseTo(SHEEN_X0, 10);
    for (let i = 0; i < 3; i += 1) {
      expect(f.dotFront[i]).toBe(0);
      expect(f.dotBack[i]).toBe(0);
    }
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
