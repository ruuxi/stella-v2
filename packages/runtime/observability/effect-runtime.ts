/**
 * The one module-level ManagedRuntime for remote telemetry, plus the timer
 * combinators that replace promise-land `setTimeout` in this tree.
 *
 * House conventions (kernel/tools/effect-runtime.ts):
 * - Exactly ONE requirements-free runtime per facade module family.
 * - Promise facades rethrow the ORIGINAL failure via `Cause.squash`.
 * - Timers are forked fibers cancelled through a `Deferred` latch — the
 *   Effect replacement for `setTimeout`/`clearTimeout` pairs.
 *
 * Fiber timers do not unref. Every use below is bounded (flush interval,
 * request close deadline) and only pending while the client already holds
 * work on the event loop.
 */

import {
  Cause,
  Deferred,
  Effect,
  Exit,
  Layer,
  ManagedRuntime,
} from "effect";

export const observabilityRuntime = ManagedRuntime.make(Layer.empty);

export const runObservabilityEffect = async <A>(
  effect: Effect.Effect<A, unknown>,
): Promise<A> => {
  const exit = await observabilityRuntime.runPromiseExit(effect);
  if (Exit.isSuccess(exit)) {
    return exit.value;
  }
  throw Cause.squash(exit.cause);
};

export type ObservabilityTimerHandle = {
  readonly cancel: () => void;
};

export const forkDelayed = (
  delayMs: number,
  fire: () => void,
): ObservabilityTimerHandle => {
  const canceled = Deferred.makeUnsafe<void>();
  void observabilityRuntime
    .runPromise(
      Effect.raceFirst(
        Effect.sleep(delayMs).pipe(Effect.andThen(Effect.sync(fire))),
        Deferred.await(canceled),
      ),
    )
    .catch(() => undefined);
  return {
    cancel: () => {
      Deferred.doneUnsafe(canceled, Effect.void);
    },
  };
};
