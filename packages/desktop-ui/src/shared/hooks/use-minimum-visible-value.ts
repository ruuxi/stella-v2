import { useEffect, useRef, useState } from "react";

type Held<T> = {
  value: T;
  minimumVisibleMs: number;
};

export function useMinimumVisibleValue<T>(
  value: T,
  minimumVisibleMs: number,
  isEqual: (a: T, b: T) => boolean = Object.is,
): T {
  const [visibleValue, setVisibleValue] = useState(value);
  const visibleRef = useRef<Held<T>>({ value, minimumVisibleMs });
  const visibleSinceRef = useRef(Date.now());
  const pendingRef = useRef<Held<T> | null>(null);
  const timerRef = useRef<number | null>(null);
  const isEqualRef = useRef(isEqual);
  isEqualRef.current = isEqual;

  useEffect(() => {
    const clearTimer = () => {
      if (timerRef.current !== null) {
        window.clearTimeout(timerRef.current);
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
      timerRef.current = window.setTimeout(() => {
        timerRef.current = null;
        const next = pendingRef.current;
        if (!next) return;
        if (!isEqualRef.current(next.value, visibleRef.current.value)) {
          show(next);
        } else {
          pendingRef.current = null;
        }
      }, wait);
    };

    if (isEqualRef.current(value, visibleRef.current.value)) {
      pendingRef.current = null;
      clearTimer();
      return;
    }

    pendingRef.current = { value, minimumVisibleMs };
    if (timerRef.current === null) {
      showPendingWhenReady();
    }
  }, [minimumVisibleMs, value]);

  useEffect(
    () => () => {
      if (timerRef.current !== null) {
        window.clearTimeout(timerRef.current);
      }
    },
    [],
  );
  return visibleValue;
}
