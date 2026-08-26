/**
 * The one module-level ManagedRuntime for the runner's cloud journal/retry
 * writers (M5 kernel/runner cloud pass: cloud-transcript-write,
 * cloud-agent-lifecycle, cloud-spawn-dispatch, computer-agent-cloud-records,
 * legacy-chat-cloud-import), plus the small Effect combinators they share.
 *
 * House conventions (docs/effect-architecture.md, kernel/tools/effect-runtime.ts,
 * kernel/connectors/effect-runtime.ts):
 * - Exactly ONE requirements-free runtime per facade module family; context
 *   rides in closures, never per-call `Effect.runPromise`.
 * - Promise facades rethrow the ORIGINAL failure via `Cause.squash`, so
 *   callers observe byte-identical error objects and messages (the timeout
 *   strings are surfaced to the model and matched by callers).
 * - Backoff/retry DELAYS stay data (`retryDelay(attempts)` over durable
 *   per-row attempt counts in SQLite — a restart resumes the same backoff
 *   position, which an in-memory Schedule state could not); only the timers
 *   move onto Effect fibers.
 * - `fetch`/Convex seams keep their `AbortSignal` plumbing
 *   (`AbortSignal.timeout` at the fetch seam is a sanctioned pin).
 */

import { Cause, Deferred, Effect, Exit, Layer, ManagedRuntime } from "effect";

/** Shared runtime for every Effect run in the runner's cloud writers. */
export const cloudWritersRuntime = ManagedRuntime.make(Layer.empty);

/**
 * Run a cloud-writer Effect on the shared runtime, rejecting with the
 * ORIGINAL failure object (`Cause.squash`) so facade callers see the exact
 * error the pre-Effect code would have thrown.
 */
export const runCloudWriterEffect = async <A>(
  effect: Effect.Effect<A, unknown>,
): Promise<A> => {
  const exit = await cloudWritersRuntime.runPromiseExit(effect);
  if (Exit.isSuccess(exit)) {
    return exit.value;
  }
  throw Cause.squash(exit.cause);
};

/**
 * Fork a one-shot delayed call: after `delayMs`, run `fire`. Returns a cancel
 * thunk that interrupts the pending delay — the Effect replacement for the
 * writers' reschedulable `setTimeout`/`clearTimeout` retry/heartbeat timers
 * (same shape as `kernel/tools/effect-runtime.ts` `forkAbortTimer`). The
 * delay value itself is unchanged: callers keep their exact backoff math and
 * clamps, so timing is identical to the timer it replaces.
 */
export const forkDelayedCall = (
  delayMs: number,
  fire: () => void,
): (() => void) => {
  const canceled = Deferred.makeUnsafe<void>();
  void cloudWritersRuntime
    .runPromise(
      Effect.raceFirst(
        Effect.sleep(delayMs).pipe(Effect.flatMap(() => Effect.sync(fire))),
        Deferred.await(canceled),
      ),
    )
    .catch(() => undefined);
  return () => {
    Deferred.doneUnsafe(canceled, Effect.void);
  };
};

/**
 * Race `promise` against a `timeoutMs` failure carrying the caller's parity
 * error — the Effect replacement for the `Promise.race` + `setTimeout` +
 * `finally clearTimeout` shape. When the promise settles first, the timeout
 * fiber is interrupted (the old `clearTimeout`); when the timeout wins, the
 * underlying promise keeps running with its settlement ignored, exactly as
 * `Promise.race` left it. Rejections rethrow the original error object.
 */
export const raceWithTimeoutError = <A>(
  promise: Promise<A>,
  timeoutMs: number,
  makeTimeoutError: () => Error,
): Promise<A> =>
  runCloudWriterEffect(
    Effect.raceFirst(
      Effect.tryPromise({ try: () => promise, catch: (error) => error }),
      Effect.sleep(timeoutMs).pipe(
        Effect.flatMap(() => Effect.fail(makeTimeoutError())),
      ),
    ),
  );
