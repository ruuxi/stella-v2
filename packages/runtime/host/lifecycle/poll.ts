import { Effect, Schedule } from "effect";

/**
 * Old-loop-shaped deadline polling. The baseline lifecycle loops were all
 * `deadline = Date.now() + budget; while (Date.now() < deadline) { attempt;
 * delay(interval) }` — the budget clock is anchored BEFORE attempt one and
 * admission of every attempt (including the first) is checked at attempt
 * start against that absolute deadline. `Schedule.during` cannot express
 * this: its elapsed clock starts at the first schedule step, so attempt one
 * runs outside the budget and a boundary attempt can be admitted late.
 *
 * Here the pacing between attempts stays an explicit
 * `Schedule.spaced(intervalMs)`, while admission is gated inside the attempt
 * against the anchored deadline — byte-for-byte the baseline's observable
 * timing: total elapsed ≈ budget (+ at most one attempt overrun), and no
 * attempt ever STARTS at/after the deadline.
 */
export const pollWithDeadline = <A, E, ED, R>(args: {
  timeoutMs: number;
  intervalMs: number;
  attempt: Effect.Effect<A, E, R>;
  /** Retry the attempt when this holds; other failures escape immediately. */
  retryWhile: (error: E) => boolean;
  /** Terminal failure produced when the deadline lapses. */
  onDeadline: () => ED;
}): Effect.Effect<A, E | ED, R> =>
  Effect.suspend(() => {
    const deadline = Date.now() + args.timeoutMs;
    let deadlineError: ED | undefined;
    const gated = Effect.suspend((): Effect.Effect<A, E | ED, R> => {
      if (Date.now() >= deadline) {
        deadlineError = args.onDeadline();
        return Effect.fail(deadlineError);
      }
      return args.attempt;
    });
    return gated.pipe(
      Effect.retry({
        while: (error) =>
          error !== deadlineError && args.retryWhile(error as E),
        schedule: Schedule.spaced(args.intervalMs),
      }),
    );
  });
