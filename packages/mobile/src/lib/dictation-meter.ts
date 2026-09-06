import { useSyncExternalStore } from "react";

/**
 * Leaf-level store for the dictation waveform and timer.
 *
 * Mirrors desktop's session meter: audio callbacks only report the peak level
 * they observed, and a fixed ~12.5 Hz tick publishes that peak as one waveform
 * bar. The bar cadence therefore stays constant regardless of how the native
 * recorder coalesces its buffers (iOS delivers ~100 ms chunks), which is what
 * kept the previous waveform lively rather than slow and flat.
 */

/** ≈ 12.5 bars per second, matching desktop's `LEVEL_EMIT_INTERVAL_MS`. */
const LEVEL_TICK_MS = 80;

type DictationMeterSnapshot = {
  active: boolean;
  startedAt: number;
  level: number;
  revision: number;
};

let snapshot: DictationMeterSnapshot = {
  active: false,
  startedAt: 0,
  level: 0,
  revision: 0,
};
let peakSinceLastTick = 0;
let tickTimer: ReturnType<typeof setInterval> | null = null;
const listeners = new Set<() => void>();

const publish = (next: Omit<DictationMeterSnapshot, "revision">): void => {
  snapshot = { ...next, revision: snapshot.revision + 1 };
  for (const listener of listeners) listener();
};

const clearTick = (): void => {
  if (tickTimer !== null) clearInterval(tickTimer);
  tickTimer = null;
  peakSinceLastTick = 0;
};

export const startDictationMeter = (startedAt: number): void => {
  clearTick();
  publish({ active: true, startedAt, level: 0 });
  tickTimer = setInterval(() => {
    const level = peakSinceLastTick;
    peakSinceLastTick = 0;
    publish({ ...snapshot, level });
  }, LEVEL_TICK_MS);
};

/** Report a 0..1 level from an audio callback; the next tick publishes the peak. */
export const updateDictationMeter = (level: number): void => {
  const clamped = Math.max(0, Math.min(1, level));
  if (clamped > peakSinceLastTick) peakSinceLastTick = clamped;
};

export const stopDictationMeter = (): void => {
  clearTick();
  if (!snapshot.active) return;
  publish({ active: false, startedAt: 0, level: 0 });
};

export const getDictationMeterSnapshot = (): DictationMeterSnapshot => snapshot;

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

export const useDictationMeter = (): DictationMeterSnapshot =>
  useSyncExternalStore(subscribe, getDictationMeterSnapshot, getDictationMeterSnapshot);

/**
 * Re-renders once per waveform tick. Read the level through
 * `getDictationMeterSnapshot()` so identical consecutive levels (silence)
 * still append a bar.
 */
export const useDictationMeterTick = (): number =>
  useSyncExternalStore(
    subscribe,
    () => snapshot.revision,
    () => snapshot.revision,
  );

/** The recording start time, or 0 while idle. Stable across level ticks. */
export const useDictationMeterStartedAt = (): number =>
  useSyncExternalStore(
    subscribe,
    () => (snapshot.active ? snapshot.startedAt : 0),
    () => (snapshot.active ? snapshot.startedAt : 0),
  );
