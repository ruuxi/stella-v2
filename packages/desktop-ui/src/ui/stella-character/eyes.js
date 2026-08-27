import { TAU } from "./geometry.js";

export const EYE_N = 48;

function pill(w, h, n = 4) {
  const pts = new Array(EYE_N);
  for (let i = 0; i < EYE_N; i++) {
    const a = (i / EYE_N) * TAU;
    const ca = Math.cos(a), sa = Math.sin(a);
    const k = Math.pow(Math.pow(Math.abs(ca), n) + Math.pow(Math.abs(sa), n), -1 / n);
    pts[i] = [ca * k * (w / 2), sa * k * (h / 2)];
  }
  return pts;
}

function starEye(w, h, spikes = 5, inner = 0.44) {
  const pts = new Array(EYE_N);
  for (let i = 0; i < EYE_N; i++) {
    const a = (i / EYE_N) * TAU;
    const phase = ((a + Math.PI / 2) * spikes) % TAU;
    const tri = Math.abs(((phase / TAU) * 2) % 2 - 1);
    const r = 1 - (1 - inner) * Math.pow(tri, 0.65);
    pts[i] = [Math.cos(a) * r * (w / 2), Math.sin(a) * r * (h / 2)];
  }
  return pts;
}

function warp(pts, { squash = 1, bend = 0, shift = 0 } = {}) {
  let maxX = 0;
  for (const [x] of pts) maxX = Math.max(maxX, Math.abs(x));
  const inv = maxX > 0 ? 1 / maxX : 0;
  return pts.map(([x, y]) => {
    const u = x * inv;
    return [x, y * squash - bend * u * u + bend * 0.34 + shift];
  });
}

export const EYE_POSES = {

  neutral: pill(0.60, 1.0, 4.0),

  open: pill(0.66, 1.0, 3.4),

  wide: warp(pill(0.80, 1.0, 3.0), { squash: 1.04 }),

  focus: pill(0.46, 1.0, 4.8),

  happy: warp(pill(0.74, 1.0, 4.0), { squash: 0.30, bend: 0.52 }),

  squint: warp(pill(0.66, 1.0, 4.0), { squash: 0.46, bend: 0.14 }),

  sleepy: warp(pill(0.62, 1.0, 4.0), { squash: 0.26, bend: -0.16 }),

  sad: warp(pill(0.58, 1.0, 4.0), { squash: 0.66, bend: -0.30, shift: 0.06 }),

  curious: warp(pill(0.72, 1.0, 2.6), { squash: 0.96 }),

  star: starEye(1.02, 1.06),
};

export const POSE_NAMES = Object.keys(EYE_POSES);

export const lerpPose = (a, b, t) =>
  a.map(([x, y], i) => [x + (b[i][0] - x) * t, y + (b[i][1] - y) * t]);
