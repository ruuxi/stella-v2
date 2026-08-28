export const DOT_CYCLE_MS = 1400;

export const DOT_PHASE_OFFSET = 0.119;

export const DOT_SIGMA = 0.15;

export const DOT_LIFT_UNITS = 9;

export const DOT_RADIUS_UNITS = 22;

export const DOT_SPREAD_UNITS = 62;

export const SIDE_DOT_SCALE = 1.02;

export const DOT_ENTRANCE_STAGGER = 0.12;

export const DOT_COUNT = 3;

export const MORPH_MS = 450;
const MORPH_OMEGA_T = 14 * (MORPH_MS / 1000);

const MORPH_NORMALIZER = 1 - (1 + MORPH_OMEGA_T) * Math.exp(-MORPH_OMEGA_T);

export function morphEnvelope(t: number): number {
  "worklet";
  if (t <= 0) return 0;
  if (t >= 1) return 1;
  const k = MORPH_OMEGA_T * t;
  return (1 - (1 + k) * Math.exp(-k)) / MORPH_NORMALIZER;
}

export function wrappedDistance(a: number, b: number): number {
  "worklet";
  const raw = Math.abs(a - b);
  return raw > 0.5 ? 1 - raw : raw;
}

export function dotGaussian(slot: number, timeMs: number): number {
  "worklet";
  const cycle = (timeMs / DOT_CYCLE_MS) % 1;
  const progress = (cycle + DOT_PHASE_OFFSET) % 1;
  const distance = wrappedDistance(progress, slot / DOT_COUNT);
  return Math.exp(
    -(distance * distance) / (2 * DOT_SIGMA * DOT_SIGMA),
  );
}

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

export function easeOutCubic(t: number): number {
  "worklet";
  const clamped = t <= 0 ? 0 : t >= 1 ? 1 : t;
  const inv = 1 - clamped;
  return 1 - inv * inv * inv;
}

export function easeOutBack(t: number): number {
  "worklet";
  const clamped = t <= 0 ? 0 : t >= 1 ? 1 : t;
  const c1 = 1.70158;
  const c3 = c1 + 1;
  const inv = clamped - 1;
  return 1 + c3 * inv * inv * inv + c1 * inv * inv;
}

export function dotEntrance(slot: number, envelope: number): number {
  "worklet";
  const span = 1 - DOT_ENTRANCE_STAGGER * (DOT_COUNT - 1);
  const local = (envelope - DOT_ENTRANCE_STAGGER * slot) / span;
  return local <= 0 ? 0 : local >= 1 ? 1 : local;
}
