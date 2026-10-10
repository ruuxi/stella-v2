import { useSyncExternalStore } from "react";

/**
 * Leaf-level store for the dictation waveform and timer.
 *
 * Mirrors desktop's session meter: one waveform bar per ~80 ms of audio,
 * published on a fixed ~12.5 Hz tick. The recorder hands audio over in
 * chunks whose length it decides (iOS currently sends a whole second at a
 * time, whatever interval is asked for), so each chunk is cut into 80 ms
 * slices, one level per slice, and the tick releases them one by one. The
 * row therefore keeps moving at desktop's pace however the audio arrives.
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
/** Most queued bars kept; older ones are dropped so the row never lags further. */
const MAX_QUEUED_LEVELS = 16;

let queuedLevels: number[] = [];
let tickTimer: ReturnType<typeof setInterval> | null = null;
const listeners = new Set<() => void>();

const publish = (next: Omit<DictationMeterSnapshot, "revision">): void => {
  snapshot = { ...next, revision: snapshot.revision + 1 };
  for (const listener of listeners) listener();
};

const clearTick = (): void => {
  if (tickTimer !== null) clearInterval(tickTimer);
  tickTimer = null;
  queuedLevels = [];
};

export const startDictationMeter = (startedAt: number): void => {
  clearTick();
  publish({ active: true, startedAt, level: 0 });
  tickTimer = setInterval(() => {
    const level = queuedLevels.shift();
    if (level === undefined) return;
    publish({ ...snapshot, level });
  }, LEVEL_TICK_MS);
};

/** Queue 0..1 levels, one per 80 ms of audio; each tick publishes the next. */
export const pushDictationLevels = (levels: readonly number[]): void => {
  for (const level of levels) {
    queuedLevels.push(Math.max(0, Math.min(1, level)));
  }
  if (queuedLevels.length > MAX_QUEUED_LEVELS) {
    queuedLevels = queuedLevels.slice(queuedLevels.length - MAX_QUEUED_LEVELS);
  }
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
