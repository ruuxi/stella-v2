import { describe, expect, test } from "bun:test";
import {
  applyCatchUpSignal,
  CATCH_UP_MIN_VISIBLE_MS,
  CATCH_UP_SHOW_DELAY_MS,
  idleCatchUpIndicator,
  isCatchUpIndicatorVisible,
  nextCatchUpTransitionAt,
  type CatchUpIndicatorState,
} from "../catch-up-indicator";

const T0 = 100_000;
const start = (now = T0): CatchUpIndicatorState =>
  applyCatchUpSignal(idleCatchUpIndicator, true, now);

describe("applyCatchUpSignal", () => {
  test("idle stays idle on a false signal", () => {
    expect(applyCatchUpSignal(idleCatchUpIndicator, false, T0)).toBe(
      idleCatchUpIndicator,
    );
  });

  test("start opens a window; repeat true is a no-op", () => {
    const s = start();
    expect(s).toEqual({ startedAt: T0, endedAt: null });
    expect(applyCatchUpSignal(s, true, T0 + 50)).toBe(s);
  });

  test("sync ending before the show delay resets to idle (no flash)", () => {
    const s = start();
    const ended = applyCatchUpSignal(s, false, T0 + CATCH_UP_SHOW_DELAY_MS - 1);
    expect(ended).toBe(idleCatchUpIndicator);
    expect(isCatchUpIndicatorVisible(ended, T0 + CATCH_UP_SHOW_DELAY_MS)).toBe(
      false,
    );
  });

  test("sync ending after the show delay records the end", () => {
    const s = start();
    const endAt = T0 + CATCH_UP_SHOW_DELAY_MS + 100;
    expect(applyCatchUpSignal(s, false, endAt)).toEqual({
      startedAt: T0,
      endedAt: endAt,
    });
  });

  test("new sync inside the visible tail merges without re-running the delay", () => {
    const s = start();
    const endAt = T0 + CATCH_UP_SHOW_DELAY_MS + 100;
    const ended = applyCatchUpSignal(s, false, endAt);
    // Still inside the minimum-visible tail.
    const rejoinAt = endAt + 50;
    expect(isCatchUpIndicatorVisible(ended, rejoinAt)).toBe(true);
    const merged = applyCatchUpSignal(ended, true, rejoinAt);
    expect(merged).toEqual({ startedAt: T0, endedAt: null });
    // No blink: visible continuously through the merge.
    expect(isCatchUpIndicatorVisible(merged, rejoinAt)).toBe(true);
  });

  test("new sync after the window fully closed starts fresh (delay applies)", () => {
    const s = start();
    const endAt = T0 + CATCH_UP_SHOW_DELAY_MS + CATCH_UP_MIN_VISIBLE_MS + 500;
    const ended = applyCatchUpSignal(s, false, endAt);
    const laterStart = endAt + 5_000;
    const fresh = applyCatchUpSignal(ended, true, laterStart);
    expect(fresh).toEqual({ startedAt: laterStart, endedAt: null });
    expect(isCatchUpIndicatorVisible(fresh, laterStart)).toBe(false);
  });
});

describe("isCatchUpIndicatorVisible", () => {
  test("hidden during the show delay, visible after while running", () => {
    const s = start();
    expect(isCatchUpIndicatorVisible(s, T0)).toBe(false);
    expect(
      isCatchUpIndicatorVisible(s, T0 + CATCH_UP_SHOW_DELAY_MS - 1),
    ).toBe(false);
    expect(isCatchUpIndicatorVisible(s, T0 + CATCH_UP_SHOW_DELAY_MS)).toBe(
      true,
    );
    // Long-running sync: stays visible indefinitely until it ends.
    expect(isCatchUpIndicatorVisible(s, T0 + 60_000)).toBe(true);
  });

  test("minimum visible time holds after a quick post-delay end", () => {
    const shownAt = T0 + CATCH_UP_SHOW_DELAY_MS;
    const s = applyCatchUpSignal(start(), false, shownAt + 50);
    // Ended 50ms after showing — must stay up to the minimum.
    expect(isCatchUpIndicatorVisible(s, shownAt + 100)).toBe(true);
    expect(
      isCatchUpIndicatorVisible(s, shownAt + CATCH_UP_MIN_VISIBLE_MS - 1),
    ).toBe(true);
    expect(
      isCatchUpIndicatorVisible(s, shownAt + CATCH_UP_MIN_VISIBLE_MS),
    ).toBe(false);
  });

  test("a sync outliving the minimum hides immediately on end", () => {
    const endAt = T0 + CATCH_UP_SHOW_DELAY_MS + CATCH_UP_MIN_VISIBLE_MS + 400;
    const s = applyCatchUpSignal(start(), false, endAt);
    expect(isCatchUpIndicatorVisible(s, endAt - 1)).toBe(true);
    expect(isCatchUpIndicatorVisible(s, endAt)).toBe(false);
  });
});

describe("nextCatchUpTransitionAt", () => {
  test("idle has no deadline", () => {
    expect(nextCatchUpTransitionAt(idleCatchUpIndicator, T0)).toBeNull();
  });

  test("during the delay the deadline is the show instant", () => {
    expect(nextCatchUpTransitionAt(start(), T0 + 10)).toBe(
      T0 + CATCH_UP_SHOW_DELAY_MS,
    );
  });

  test("visible with the sync running has no deadline", () => {
    expect(
      nextCatchUpTransitionAt(start(), T0 + CATCH_UP_SHOW_DELAY_MS + 10),
    ).toBeNull();
  });

  test("ended within the minimum: deadline is the min-visible boundary", () => {
    const shownAt = T0 + CATCH_UP_SHOW_DELAY_MS;
    const s = applyCatchUpSignal(start(), false, shownAt + 50);
    expect(nextCatchUpTransitionAt(s, shownAt + 60)).toBe(
      shownAt + CATCH_UP_MIN_VISIBLE_MS,
    );
    // Past the hide instant, nothing is scheduled.
    expect(
      nextCatchUpTransitionAt(s, shownAt + CATCH_UP_MIN_VISIBLE_MS + 1),
    ).toBeNull();
  });
});
