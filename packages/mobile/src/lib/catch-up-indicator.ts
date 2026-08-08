/**
 * Anti-flicker gate for the chat "Catching up" indicator.
 *
 * The raw signal (`catchingUp` from `useChatThread`) is true while a
 * catch-up-classified desktop sync is in flight — landing sync, app
 * foreground/refocus reconnect, manual Force Sync. Those pulls are often
 * sub-300ms (matching cursors are a no-op), so mirroring the raw signal
 * would flash a spinner for a couple frames on every return to the tab.
 *
 * This module derives visibility from the raw signal with two rules:
 *   - Show delay: only appear if the sync is still running after
 *     `CATCH_UP_SHOW_DELAY_MS` — instant pulls never show anything.
 *   - Minimum visible: once shown, stay for at least
 *     `CATCH_UP_MIN_VISIBLE_MS` so the indicator reads as a deliberate state
 *     rather than a flicker.
 *
 * The state machine is pure and time-parameterized (callers pass `now`) so it
 * is directly unit-testable; `useCatchUpIndicatorVisible` is the thin React
 * binding that schedules re-evaluation at the exact transition deadlines.
 */

import { useEffect, useRef, useState } from "react";

/** Sync must outlive this before the indicator appears. */
export const CATCH_UP_SHOW_DELAY_MS = 300;
/** Once shown, the indicator stays at least this long. */
export const CATCH_UP_MIN_VISIBLE_MS = 600;

export interface CatchUpIndicatorState {
  /** When the current catch-up window began, or null when idle. */
  startedAt: number | null;
  /** When the sync resolved; null while still running (or idle). */
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

/** The instant the indicator hides, for a window that showed and ended. */
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
  if (state.endedAt === null) return true; // still syncing
  const hide = hideAt(state);
  return hide !== null && now < hide;
}

/**
 * Absolute timestamp of the next visibility change, or null if none is
 * scheduled (idle, or visible with the sync still running).
 */
export function nextCatchUpTransitionAt(
  state: CatchUpIndicatorState,
  now: number,
): number | null {
  const shown = shownAt(state);
  if (shown === null) return null;
  // Waiting out the show delay with the sync still running.
  if (now < shown && state.endedAt === null) return shown;
  // Visible and ended — waiting out the minimum-visible tail.
  if (state.endedAt !== null) {
    const hide = hideAt(state);
    if (hide !== null && now < hide) return hide;
  }
  return null;
}

/** Advance the state machine when the raw `catchingUp` signal changes. */
export function applyCatchUpSignal(
  state: CatchUpIndicatorState,
  catchingUp: boolean,
  now: number,
): CatchUpIndicatorState {
  if (catchingUp) {
    // Already tracking a running sync.
    if (state.startedAt !== null && state.endedAt === null) return state;
    // A new sync starts while the previous window is still visible (inside
    // its minimum-visible tail): merge into one continuous window instead of
    // re-running the show delay — the indicator must not blink off/on.
    if (isCatchUpIndicatorVisible(state, now)) {
      return { startedAt: state.startedAt, endedAt: null };
    }
    return { startedAt: now, endedAt: null };
  }
  // Signal dropped while idle or already ended — nothing to do.
  if (state.startedAt === null || state.endedAt !== null) return state;
  // Ended before the show delay elapsed: never show — suppress the flash.
  const shown = shownAt(state);
  if (shown !== null && now < shown) return idleCatchUpIndicator;
  return { startedAt: state.startedAt, endedAt: now };
}

/**
 * React binding: debounced visibility for the raw `catchingUp` signal.
 * Re-evaluates exactly at the state machine's transition deadlines.
 */
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
