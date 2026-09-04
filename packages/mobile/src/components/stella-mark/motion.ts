/**
 * Pure motion math for the character mark, kept out of the component so it can
 * be unit-tested (the repo's `bun test` runner has no React Native renderer,
 * so only logic is testable).
 *
 * Every function here is a Reanimated worklet: the mark evaluates them on the
 * UI thread from one shared clock, so no per-frame work ever crosses to JS.
 * They are plain arithmetic, which is exactly what makes them worklet-safe and
 * directly callable from a test.
 *
 * All distances are in viewBox units of `geometry.ts`
 * (`STELLA_MARK_VIEWBOX`, centre `STELLA_MARK_CENTER`), matching the approved
 * desktop rig one-for-one. Turning those units into pixels is `layout.ts`.
 */

/** Full bounce cycle. */
export const DOT_CYCLE_MS = 1400;

/** Phase the whole wave is shifted by, so the cycle doesn't start on a peak. */
export const DOT_PHASE_OFFSET = 0.119;

/** Width of the per-dot Gaussian, in cycle fractions. */
export const DOT_SIGMA = 0.15;

/** Peak rise of a dot, in viewBox units. */
export const DOT_LIFT_UNITS = 9;

/** Radius of a thinking dot, in viewBox units. */
export const DOT_RADIUS_UNITS = 22;

/** Horizontal offset of the side dots from centre, in viewBox units. */
export const DOT_SPREAD_UNITS = 62;

/** Side dots read a touch larger than the middle one. */
export const SIDE_DOT_SCALE = 1.02;

/** Per-slot delay of the dots' entrance, in envelope fractions. */
export const DOT_ENTRANCE_STAGGER = 0.12;

/** Number of dots (also the phase denominator: slot `i` peaks at `i / 3`). */
export const DOT_COUNT = 3;

/**
 * Settle time of the star → dots morph. The envelope below is the step
 * response of a critically damped spring at ω = 14 rad/s, sampled over this
 * window (ω · t = 6.3 at t = 1).
 */
export const MORPH_MS = 450;
const MORPH_OMEGA_T = 14 * (MORPH_MS / 1000);

/** Value of the raw step response at t = 1, so the envelope lands exactly on 1. */
const MORPH_NORMALIZER = 1 - (1 + MORPH_OMEGA_T) * Math.exp(-MORPH_OMEGA_T);

/**
 * Critically damped step response `1 − (1 + ωt)·e^(−ωt)`, normalized to reach
 * exactly 1 at `t = 1`. Driven from a LINEAR shared value so the spring shape
 * is exact rather than a bezier approximation of it — and so reversing simply
 * runs the same curve back toward rest.
 */
export function morphEnvelope(t: number): number {
  "worklet";
  if (t <= 0) return 0;
  if (t >= 1) return 1;
  const k = MORPH_OMEGA_T * t;
  return (1 - (1 + k) * Math.exp(-k)) / MORPH_NORMALIZER;
}

/** Shortest distance between two points on a unit circle (both in 0..1). */
export function wrappedDistance(a: number, b: number): number {
  "worklet";
  const raw = Math.abs(a - b);
  return raw > 0.5 ? 1 - raw : raw;
}

/**
 * How "lit" slot `i` is at `timeMs`: a Gaussian centred on the slot's own
 * phase (`i / 3`), measured around the wrapped cycle so the travelling bump
 * crosses the seam without a hitch.
 */
export function dotGaussian(slot: number, timeMs: number): number {
  "worklet";
  const cycle = (timeMs / DOT_CYCLE_MS) % 1;
  const progress = (cycle + DOT_PHASE_OFFSET) % 1;
  const distance = wrappedDistance(progress, slot / DOT_COUNT);
  return Math.exp(-(distance * distance) / (2 * DOT_SIGMA * DOT_SIGMA));
}

/** Bounce state of one dot: rise, pop and tone all ride the same Gaussian. */
export function dotWave(
  slot: number,
  timeMs: number,
): { gaussian: number; liftUnits: number; scale: number; opacity: number } {
  "worklet";
  const gaussian = dotGaussian(slot, timeMs);
  return {
    gaussian,
    liftUnits: gaussian * DOT_LIFT_UNITS,
    scale: 0.84 + 0.22 * gaussian,
    opacity: 0.5 + 0.5 * gaussian,
  };
}

/** Period of the resting breathe. */
export const BREATHE_MS = 4000;

/** Resting breathe depth: ±1.3% is visible without reading as a pulse. */
export const BREATHE_AMPLITUDE = 0.013;

export type ToolCharacterMotionState =
  | "working"
  | "writing"
  | "searching"
  | "reading";

export type ToolCharacterMotion = {
  translateX: number;
  translateY: number;
  rotationDeg: number;
  scaleX: number;
  scaleY: number;
};

/**
 * Mobile-native versions of the desktop rig's tool poses. Working and writing
 * carry the travelling twinkle as a soft squash through the silhouette;
 * searching and reading leave room around the smaller body for orbiting marks.
 */
export function toolCharacterMotion(
  state: ToolCharacterMotionState,
  timeMs: number,
): ToolCharacterMotion {
  "worklet";
  // Keep this inline: the iOS worklet serializer left the same-file helper
  // reference undefined when this pose first mounted after sending a message.
  const breathe =
    1 + BREATHE_AMPLITUDE * Math.sin((timeMs / BREATHE_MS) * 2 * Math.PI);
  const bobX =
    Math.sin(timeMs * 0.00042) * 0.45 +
    Math.sin(timeMs * 0.001) * 0.16;
  const bobY =
    Math.sin(timeMs * 0.00058) * 0.36 +
    Math.sin(timeMs * 0.0013) * 0.13;

  if (state === "working" || state === "writing") {
    const speed = state === "writing" ? 0.0026 : 0.0033;
    const twinkle = Math.sin(timeMs * speed);
    const strength = state === "writing" ? 0.045 : 0.06;
    return {
      translateX: bobX,
      translateY: bobY,
      rotationDeg: Math.sin(timeMs * 0.0012) * 2.6,
      scaleX: breathe * (1 + strength * twinkle),
      scaleY: breathe * (1 - strength * 0.62 * twinkle),
    };
  }

  const bodyScale = state === "searching" ? 0.9 : 0.94;
  return {
    translateX: bobX * 0.55,
    translateY: bobY * 0.55,
    rotationDeg: Math.sin(timeMs * 0.0009) * 3,
    scaleX: breathe * bodyScale,
    scaleY: breathe * bodyScale,
  };
}

export type OrbitMarkMotion = {
  opacity: number;
  rotationDeg: number;
  scale: number;
  translateX: number;
  translateY: number;
};

/** One of the desktop search/read orbit's four moving sparkle marks. */
export function orbitMarkMotion(
  index: number,
  timeMs: number,
): OrbitMarkMotion {
  "worklet";
  const angle = timeMs * 0.0016 + (index * Math.PI * 2) / 4;
  const depth = 0.5 + 0.5 * Math.max(0, Math.cos(angle));
  return {
    opacity: Math.max(0.2, Math.min(1, (Math.cos(angle) + 0.5) / 0.7)),
    rotationDeg: ((angle * 40) / Math.PI) % 360,
    scale: 0.62 + depth * 0.38,
    translateX: Math.sin(angle),
    translateY: -Math.cos(angle),
  };
}

/**
 * Length of the linear clock ramp every periodic term reads. A common multiple
 * of the bounce cycle (1400ms) and the breathe period (4000ms), so the wrap is
 * seamless for both; at ~47 minutes it is far outside any single activation.
 */
export const CLOCK_SPAN_MS = 2_800_000;

/** How much full mic/output energy inflates the mark over its resting size. */
export const VOICE_PULSE_GAIN = 0.22;

export function clamp01(value: number): number {
  "worklet";
  if (!Number.isFinite(value)) return 0;
  return value <= 0 ? 0 : value >= 1 ? 1 : value;
}

/** Resting breathe: a slow sine on the clock, in scale units. */
export function breatheScale(timeMs: number, amplitude: number): number {
  "worklet";
  return 1 + amplitude * Math.sin((timeMs / BREATHE_MS) * 2 * Math.PI);
}

/**
 * Scale for a voice-driven mark. Live energy takes over from the breathe
 * rather than beating against it: the breathe fades out as the level rises, so
 * a loud moment reads as one clean pulse instead of two overlapping rhythms.
 */
export function voiceScale(energy: number, timeMs: number): number {
  "worklet";
  const level = clamp01(energy);
  return (
    breatheScale(timeMs, BREATHE_AMPLITUDE * (1 - level)) *
    (1 + VOICE_PULSE_GAIN * level)
  );
}

/** Standard ease-out-cubic. */
export function easeOutCubic(t: number): number {
  "worklet";
  const clamped = t <= 0 ? 0 : t >= 1 ? 1 : t;
  const inv = 1 - clamped;
  return 1 - inv * inv * inv;
}

/** Standard ease-out-back — the slight overshoot on the dots' spread. */
export function easeOutBack(t: number): number {
  "worklet";
  const clamped = t <= 0 ? 0 : t >= 1 ? 1 : t;
  const c1 = 1.70158;
  const c3 = c1 + 1;
  const inv = clamped - 1;
  return 1 + c3 * inv * inv * inv + c1 * inv * inv;
}

/**
 * Entrance progress of slot `i` given the morph envelope: the dots don't all
 * appear at once, they cascade by {@link DOT_ENTRANCE_STAGGER}.
 */
export function dotEntrance(slot: number, envelope: number): number {
  "worklet";
  const span = 1 - DOT_ENTRANCE_STAGGER * (DOT_COUNT - 1);
  const local = (envelope - DOT_ENTRANCE_STAGGER * slot) / span;
  return local <= 0 ? 0 : local >= 1 ? 1 : local;
}
