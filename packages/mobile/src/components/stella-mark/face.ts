const TAU = Math.PI * 2;

export const EYE_N = 32;

// Face box measured from the character silhouette by the desktop rig's
// fitFace, baked so mobile needs no ring sampling at runtime.
export const FACE = { dx: -1.14, dy: 0.86, rx: 70.705, ry: 70.705 };

const pill = (w: number, h: number, n = 4): number[][] => {
  const pts: number[][] = new Array(EYE_N);
  for (let i = 0; i < EYE_N; i++) {
    const a = (i / EYE_N) * TAU;
    const ca = Math.cos(a);
    const sa = Math.sin(a);
    const k = Math.pow(
      Math.pow(Math.abs(ca), n) + Math.pow(Math.abs(sa), n),
      -1 / n,
    );
    pts[i] = [ca * k * (w / 2), sa * k * (h / 2)];
  }
  return pts;
};

const starEye = (w: number, h: number, spikes = 5, inner = 0.44): number[][] => {
  const pts: number[][] = new Array(EYE_N);
  for (let i = 0; i < EYE_N; i++) {
    const a = (i / EYE_N) * TAU;
    const phase = ((a + Math.PI / 2) * spikes) % TAU;
    const tri = Math.abs((((phase / TAU) * 2) % 2) - 1);
    const r = 1 - (1 - inner) * Math.pow(tri, 0.65);
    pts[i] = [Math.cos(a) * r * (w / 2), Math.sin(a) * r * (h / 2)];
  }
  return pts;
};

const warp = (
  pts: number[][],
  { squash = 1, bend = 0, shift = 0 } = {},
): number[][] => {
  let maxX = 0;
  for (const [x] of pts) maxX = Math.max(maxX, Math.abs(x));
  const inv = maxX > 0 ? 1 / maxX : 0;
  return pts.map(([x, y]) => {
    const u = x * inv;
    return [x, y * squash - bend * u * u + bend * 0.34 + shift];
  });
};

export const EYE_POSES = {
  neutral: pill(0.6, 1.0, 4.0),
  open: pill(0.66, 1.0, 3.4),
  wide: warp(pill(0.8, 1.0, 3.0), { squash: 1.04 }),
  focus: pill(0.46, 1.0, 4.8),
  happy: warp(pill(0.74, 1.0, 4.0), { squash: 0.3, bend: 0.52 }),
  squint: warp(pill(0.66, 1.0, 4.0), { squash: 0.46, bend: 0.14 }),
  sleepy: warp(pill(0.62, 1.0, 4.0), { squash: 0.26, bend: -0.16 }),
  sad: warp(pill(0.58, 1.0, 4.0), { squash: 0.66, bend: -0.3, shift: 0.06 }),
  curious: warp(pill(0.72, 1.0, 2.6), { squash: 0.96 }),
  star: starEye(1.02, 1.06),
} satisfies Record<string, number[][]>;

export type EyePoseName = keyof typeof EYE_POSES;

export const IDLE_POSES: EyePoseName[] = [
  "neutral",
  "open",
  "neutral",
  "curious",
  "happy",
  "focus",
];

export const POSE_EVERY_MS: [number, number] = [2600, 5200];
export const BLINK_EVERY_MS: [number, number] = [3200, 7000];
export const POSE_TRANSITION_MS = 190;
export const BLINK_MS = 78;

export const randomBetween = (a: number, b: number) => a + Math.random() * (b - a);

// Builds one eye's path in the mark's viewBox units. Worklet-safe: called on
// the UI thread while a pose transition is in flight.
export const eyePath = (
  from: number[][],
  to: number[][],
  mix: number,
  cx: number,
  cy: number,
  ew: number,
  eh: number,
): string => {
  "worklet";
  let d = "";
  for (let i = 0; i < EYE_N; i++) {
    const fx = from[i][0];
    const fy = from[i][1];
    const x = cx + (fx + (to[i][0] - fx) * mix) * ew;
    const y = cy + (fy + (to[i][1] - fy) * mix) * eh;
    d += (i === 0 ? "M" : "L") + x.toFixed(2) + " " + y.toFixed(2);
  }
  return d + "Z";
};
