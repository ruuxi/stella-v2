import { useEffect, useRef, useState } from "react";

export const CATCH_UP_SHOW_DELAY_MS = 300;

export const CATCH_UP_MIN_VISIBLE_MS = 600;

export interface CatchUpIndicatorState {

  startedAt: number | null;

  endedAt: number | null;
}

export const idleCatchUpIndicator: CatchUpIndicatorState = {
  startedAt: null,
  endedAt: null,
};

function shownAt(state: CatchUpIndicatorState): number | null {
  return state.startedAt === null
    ? null
    : state.startedAt + CATCH_UP_SHOW_DELAY_MS;
}

function hideAt(state: CatchUpIndicatorState): number | null {
  const shown = shownAt(state);
  if (shown === null || state.endedAt === null) return null;
  return Math.max(state.endedAt, shown + CATCH_UP_MIN_VISIBLE_MS);
}

export function isCatchUpIndicatorVisible(
  state: CatchUpIndicatorState,
  now: number,
): boolean {
  const shown = shownAt(state);
  if (shown === null || now < shown) return false;
  if (state.endedAt === null) return true;
  const hide = hideAt(state);
  return hide !== null && now < hide;
}

export function nextCatchUpTransitionAt(
  state: CatchUpIndicatorState,
  now: number,
): number | null {
  const shown = shownAt(state);
  if (shown === null) return null;

  if (now < shown && state.endedAt === null) return shown;

  if (state.endedAt !== null) {
    const hide = hideAt(state);
    if (hide !== null && now < hide) return hide;
  }
  return null;
}

export function applyCatchUpSignal(
  state: CatchUpIndicatorState,
  catchingUp: boolean,
  now: number,
): CatchUpIndicatorState {
  if (catchingUp) {

    if (state.startedAt !== null && state.endedAt === null) return state;

    if (isCatchUpIndicatorVisible(state, now)) {
      return { startedAt: state.startedAt, endedAt: null };
    }
    return { startedAt: now, endedAt: null };
  }

  if (state.startedAt === null || state.endedAt !== null) return state;

  const shown = shownAt(state);
  if (shown !== null && now < shown) return idleCatchUpIndicator;
  return { startedAt: state.startedAt, endedAt: now };
}

export function useCatchUpIndicatorVisible(catchingUp: boolean): boolean {
  const stateRef = useRef<CatchUpIndicatorState>(idleCatchUpIndicator);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    stateRef.current = applyCatchUpSignal(
      stateRef.current,
      catchingUp,
      Date.now(),
    );
    let timer: ReturnType<typeof setTimeout> | null = null;
    const evaluate = () => {
      const now = Date.now();
      setVisible(isCatchUpIndicatorVisible(stateRef.current, now));
      const next = nextCatchUpTransitionAt(stateRef.current, now);
      if (next !== null) {
        timer = setTimeout(evaluate, Math.max(0, next - now) + 1);
      }
    };
    evaluate();
    return () => {
      if (timer !== null) clearTimeout(timer);
    };
  }, [catchingUp]);

  return visible;
}
