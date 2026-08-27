// Stella's silhouettes.
//
// Everything derives from ONE source of truth: the six-ray aurora brand star
// already shipping in `packages/mobile/src/components/WorkingStar.tsx`. The
// character shape is that same star with its radial profile inflated toward a
// circle and smoothed, so the character and the logo are provably the same
// object at two different `puff` values — and the rig can morph between them.

import {
  TAU, flattenPath, boundsCenter, radialProfile, smoothProfile,
  profileMax, profileToRing, toPath, fitFace,
} from "./geometry.js";

/** Ring resolution. Every morphable outline in the rig has exactly this many points. */
export const N = 96;

/** Shape space. Body radius equals the distance from centre to a ray tip. */
export const C = 114.2705;
export const BLEED = 15;
export const VIEWBOX = `${-BLEED} ${-BLEED} ${C * 2 + BLEED * 2} ${C * 2 + BLEED * 2}`;
export const VIEW_CENTER = -BLEED + (C * 2 + BLEED * 2) / 2;

/**
 * Six-ray Stella brand star, viewBox 0 0 100 100. Copied verbatim from
 * WorkingStar.tsx so the two can never drift.
 */
export const BRAND_STAR_PATH =
  "M50 8 L49.68 12.93 L49.39 15.14 L48.66 19.35 L47.69 23.64 L46.51 27.96 L45.01 32.61 L43.33 37.2 L41.47 41.76 L37.04 42.37 L32.26 42.65 L28.42 42.57 L25.56 42.29 L23.96 42.04 L23.45 42.14 L26.19 43.4 L29.44 45.25 L32.6 47.4 L35.9 50 L32.6 52.6 L29.44 54.75 L26.19 56.6 L23.45 57.86 L23.96 57.96 L26.7 57.57 L29.13 57.39 L33.05 57.37 L35.58 57.5 L38.27 57.76 L41.62 58.24 L42.57 58.4 L42.63 58.48 L44.28 62.84 L45.73 67.12 L47 71.37 L48.01 75.34 L48.74 78.8 L49.43 82.9 L49.69 85.07 L50 89.9 L50.31 85.07 L50.57 82.9 L51.26 78.8 L51.99 75.34 L53.13 70.93 L54.36 66.84 L55.89 62.36 L57.43 58.4 L62.52 57.68 L67.33 57.36 L71.58 57.43 L74.44 57.71 L76.04 57.96 L76.55 57.86 L73.81 56.6 L70.56 54.75 L67.4 52.6 L64.1 50 L67.4 47.4 L70.56 45.25 L73.81 43.4 L76.55 42.14 L76.04 42.04 L74.44 42.29 L71.58 42.57 L67.74 42.65 L62.96 42.37 L58.53 41.76 L56.67 37.2 L54.99 32.61 L53.49 27.96 L52.31 23.64 L51.34 19.35 L50.61 15.14 L50.32 12.93 Z";

const CENTER = [C, C];

/** The brand star's raw radial profile, normalised so its longest ray is 1. */
const rawPts = flattenPath(BRAND_STAR_PATH, 0.4);
const rawCenter = boundsCenter(rawPts);
const RAW = (() => {
  const p = radialProfile(rawPts, rawCenter, N);
  const m = profileMax(p);
  return Float64Array.from(p, (v) => v / m);
})();

/**
 * Turning the logo into a character.
 *
 * The brand star is six rays, but not a tidy six: the vertical pair runs to
 * 1.0 while the four side rays only reach 0.54–0.64, and they sit in two close
 * pairs about 37° apart rather than evenly around the circle. As a logo at
 * 512px that reads as an aurora flare. Shrunk to 24px with a face in it, the
 * long pair dominates and the close pairs merge into horizontal arms, and the
 * whole thing reads as a kite.
 *
 * So the character profile is rebuilt from the logo's own ray set — same count,
 * same starting angles, same heights — with four knobs:
 *
 *   balance  even out the ray heights            (1 = all six the same length)
 *   even     even out the ray angles             (1 = one ray every 60°)
 *   core     radius of the body a ray grows from
 *   gamma    ray taper; >1 is pointy, <1 is fat and plush
 *
 * `puff` crossfades the result against the untouched logo, so puff 0 is still
 * exactly the shipping mark and the rig can morph between the two.
 */

/** Local maxima of the raw profile — one per ray. */
const PEAKS = (() => {
  let lo = 1;
  for (const v of RAW) if (v < lo) lo = v;
  const gate = lo + 0.28 * (1 - lo);
  const found = [];
  for (let i = 0; i < N; i++) {
    const p = RAW[(i - 1 + N) % N], c = RAW[i], n = RAW[(i + 1) % N];
    if (c >= p && c > n && c > gate) found.push({ angle: (i / N) * TAU, height: c });
  }
  return found;
})();

export const RAY_COUNT = PEAKS.length;

/** Where each ray would sit if the six were evenly spaced, one pointing up. */
const EVEN_ANGLES = PEAKS.map((_, k) => (-Math.PI / 2) + (k * TAU) / PEAKS.length);

const angDist = (a, b) => {
  let d = Math.abs(((a - b) % TAU + TAU) % TAU);
  return d > Math.PI ? TAU - d : d;
};

export function starProfile(puff, opts = {}) {
  const {
    core = 0.44, gamma = 1.15, sharp = 1, even = 0.9, balance = 0.92, smooth = 0.7,
  } = opts;
  let lo = 1, hi = 0;
  for (const v of RAW) { if (v < lo) lo = v; if (v > hi) hi = v; }
  const span = Math.max(hi - lo, 1e-6);

  const rays = PEAKS.map((p, k) => {
    const h = (p.height - lo) / span;
    // Shortest-way blend toward the even slot, so a ray never sweeps the long way.
    let delta = ((EVEN_ANGLES[k] - p.angle + Math.PI * 3) % TAU) - Math.PI;
    return { angle: p.angle + delta * even, height: h + (1 - h) * balance };
  });

  const halfWidth = (Math.PI / rays.length) * sharp;
  const out = new Float64Array(N);
  for (let i = 0; i < N; i++) {
    const th = (i / N) * TAU;
    let ridge = 0;
    for (const r of rays) {
      const t = 1 - angDist(th, r.angle) / halfWidth;
      if (t <= 0) continue;
      const v = r.height * Math.pow(t, gamma);
      if (v > ridge) ridge = v;
    }
    const shaped = core + (1 - core) * ridge;
    out[i] = RAW[i] + (shaped - RAW[i]) * puff;
  }
  const sm = smoothProfile(out, smooth * puff);
  const m = profileMax(sm) || 1;
  return Float64Array.from(sm, (v) => v / m);
}

function buildShape(label, puff, opts) {
  const prof = starProfile(puff, opts);
  const ring = profileToRing(prof, C, CENTER);
  const face = fitFace(ring, CENTER, C);
  return { label, puff, profile: prof, ring, path: toPath(ring), face };
}

/**
 * The set. `star` is the character; `brand` is the shipping logo; the rig
 * morphs between any two because they are all the same 96-point ring.
 */
export const SHAPES = {
  /** The character. Unmistakably six-pointed, plush enough to hold a face. */
  star: buildShape("Star", 1, { core: 0.46, gamma: 1.15, sharp: 1.2, even: 1, balance: 0.94, smooth: 0.7 }),
  /** Softer, for 16–20px chrome where six points turn to fuzz. */
  pebble: buildShape("Pebble", 1, { core: 0.78, gamma: 1.15, sharp: 1.2, even: 1, balance: 0.94, smooth: 1.1 }),
  /** The shipping mark: original ray heights, original angles, needle tips. */
  brand: buildShape("Brand star", 0.1, { core: 0.3, gamma: 1, sharp: 1, even: 0, balance: 0, smooth: 0.4 }),
  /** Fully balled up — and the morph target for the thinking dots. */
  orb: buildShape("Orb", 1, { core: 1, gamma: 1, sharp: 1, even: 0, balance: 0, smooth: 0 }),
};

export const ORB_RING = SHAPES.orb.ring;
export const ORB_PATH = SHAPES.orb.path;

/**
 * A four-point sparkle, for particles and for the flash at each dot's peak.
 * Concave, so it is authored directly rather than as a radial profile.
 */
export const SPARKLE_PATH = (() => {
  const pts = [];
  const n = 8;
  for (let i = 0; i < n; i++) {
    const a = -Math.PI / 2 + (i * TAU) / n;
    const r = i % 2 === 0 ? 1 : 0.19;
    pts.push(`${(Math.cos(a) * r).toFixed(3)} ${(Math.sin(a) * r).toFixed(3)}`);
  }
  // Straight-line star, drawn in unit space and scaled by the caller.
  return "M" + pts.join("L") + "Z";
})();
