export const BREATHE_MS = 4000;

export const BREATHE_AMPLITUDE = 0.013;

export const CLOCK_SPAN_MS = 2_800_000;

export const VOICE_PULSE_GAIN = 0.22;

export function clamp01(value: number): number {
  "worklet";
  if (!Number.isFinite(value)) return 0;
  return value <= 0 ? 0 : value >= 1 ? 1 : value;
}

export function breatheScale(timeMs: number, amplitude: number): number {
  "worklet";
  return 1 + amplitude * Math.sin((timeMs / BREATHE_MS) * 2 * Math.PI);
}

export function voiceScale(energy: number, timeMs: number): number {
  "worklet";
  const level = clamp01(energy);
  return (
    breatheScale(timeMs, BREATHE_AMPLITUDE * (1 - level)) *
    (1 + VOICE_PULSE_GAIN * level)
  );
}
