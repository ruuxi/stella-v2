/**
 * Pure motion math for the resting mark, kept out of the component so it can
 * be unit-tested (the repo's `bun test` runner has no React Native renderer,
 * so only logic is testable).
 *
 * Every function here is a Reanimated worklet: the mark evaluates them on the
 * UI thread from one shared clock, so no per-frame work ever crosses to JS.
 * They are plain arithmetic, which is exactly what makes them worklet-safe and
 * directly callable from a test.
 *
 * The thinking pose's own math lives in `top-spinner.ts`.
 */

/** Period of the resting breathe. */
export const BREATHE_MS = 4000;

/** Resting breathe depth: ±1.3% is visible without reading as a pulse. */
export const BREATHE_AMPLITUDE = 0.013;

/**
 * Length of the linear clock ramp every periodic term reads. At ~47 minutes it
 * is far outside any single activation, so the wrap is never seen.
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
