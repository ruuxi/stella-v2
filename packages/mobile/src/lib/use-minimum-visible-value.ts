import { useEffect, useRef, useState } from "react";

type Held<T> = {
  value: T;
  /**
   * The floor that was in force when this value became visible. Held with the
   * value rather than read live so a mid-hold prop change cannot cut short a
   * hold the caller already committed to.
   */
  minimumVisibleMs: number;
};

/**
 * Holds a value on screen for a minimum duration before letting the next one
 * through. The mobile counterpart of the desktop hook of the same name.
 *
 * The queue is one deep and it is not FIFO: while a value is serving its
 * floor, later values overwrite each other, so when the floor lifts the hook
 * jumps straight to whatever is current and skips everything in between. That
 * is what keeps the working indicator legible during a burst of tool calls —
 * each label it does show is readable, and it never falls behind the run
 * narrating labels nobody is waiting on any more.
 *
 * Holding the label is what holds the mark too: the indicator picks its pose
 * from whether the held label is empty, so the two can never disagree.
 */
export function useMinimumVisibleValue<T>(
  value: T,
  minimumVisibleMs: number,
  isEqual: (a: T, b: T) => boolean = Object.is,
): T {
  const [visibleValue, setVisibleValue] = useState(value);
  const visibleRef = useRef<Held<T>>({ value, minimumVisibleMs });
  const visibleSinceRef = useRef(Date.now());
  const pendingRef = useRef<Held<T> | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isEqualRef = useRef(isEqual);
  isEqualRef.current = isEqual;

  useEffect(() => {
    const clearTimer = () => {
      if (timerRef.current !== null) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };
    const remainingMs = () =>
      Math.max(
        0,
        visibleRef.current.minimumVisibleMs -
          (Date.now() - visibleSinceRef.current),
      );
    const show = (held: Held<T>) => {
      visibleRef.current = held;
      visibleSinceRef.current = Date.now();
      pendingRef.current = null;
      setVisibleValue(held.value);
    };
    const showPendingWhenReady = () => {
      clearTimer();
      const pending = pendingRef.current;
      if (!pending) return;
      const wait = remainingMs();
      if (wait === 0) {
        if (!isEqualRef.current(pending.value, visibleRef.current.value)) {
          show(pending);
        } else {
          pendingRef.current = null;
        }
        return;
      }
      timerRef.current = setTimeout(() => {
        timerRef.current = null;
        // Re-read the pending slot rather than closing over `pending`: the
        // point of the hold is to land on whatever is current *now*.
        const next = pendingRef.current;
        if (!next) return;
        if (!isEqualRef.current(next.value, visibleRef.current.value)) {
          show(next);
        } else {
          pendingRef.current = null;
        }
      }, wait);
    };

    // Bounced back to what is already showing; drop the pending change.
    if (isEqualRef.current(value, visibleRef.current.value)) {
      pendingRef.current = null;
      clearTimer();
      return;
    }

    pendingRef.current = { value, minimumVisibleMs };
    // A live timer already owns the handoff and will pick this up when it
    // fires; arming a second one would land the value early.
    if (timerRef.current === null) {
      showPendingWhenReady();
    }
  }, [minimumVisibleMs, value]);

  useEffect(
    () => () => {
      if (timerRef.current !== null) {
        clearTimeout(timerRef.current);
      }
    },
    [],
  );
  return visibleValue;
}
