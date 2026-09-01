import { useSyncExternalStore } from "react";

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
const listeners = new Set<() => void>();

const publish = (next: Omit<DictationMeterSnapshot, "revision">): void => {
  snapshot = { ...next, revision: snapshot.revision + 1 };
  for (const listener of listeners) listener();
};

export const startDictationMeter = (startedAt: number): void =>
  publish({ active: true, startedAt, level: 0 });

export const updateDictationMeter = (level: number): void =>
  publish({ ...snapshot, level: Math.max(0, Math.min(1, level)) });

export const stopDictationMeter = (): void =>
  publish({ active: false, startedAt: 0, level: 0 });

export const useDictationMeter = (): DictationMeterSnapshot =>
  useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => snapshot,
    () => snapshot,
  );
