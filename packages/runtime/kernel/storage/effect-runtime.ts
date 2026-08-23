/**
 * The one module-level ManagedRuntime for the storage tree (M5 kernel/storage
 * pass), plus the small Effect combinators the storage modules share.
 *
 * House conventions (docs/effect-architecture.md, kernel/tools/effect-runtime.ts,
 * kernel/connectors/effect-runtime.ts):
 * - Exactly ONE requirements-free runtime per facade module family; context
 *   rides in closures, never per-call `Effect.runPromise`.
 * - Promise facades rethrow the ORIGINAL failure via `Cause.squash`, so
 *   callers observe byte-identical error objects and messages.
 * - The sqlite driver is synchronous (bun:sqlite), so store methods stay
 *   synchronous — many callers run inside open transactions. Only timers
 *   (the run-event-log retention sweep) move onto Effect fibers.
 */

import {
  Cause,
  Deferred,
  Effect,
  Exit,
  Layer,
  ManagedRuntime,
  Schedule,
} from "effect";

/** Shared runtime for every Effect run in `kernel/storage`. */
export const storageRuntime = ManagedRuntime.make(Layer.empty);

/**
 * Run a storage Effect on the shared runtime, rejecting with the ORIGINAL
 * failure object (`Cause.squash`) so facade callers see the exact error the
 * pre-Effect code would have thrown.
 */
export const runStorageEffect = async <A>(
  effect: Effect.Effect<A, unknown>,
): Promise<A> => {
  const exit = await storageRuntime.runPromiseExit(effect);
  if (Exit.isSuccess(exit)) {
    return exit.value;
  }
  throw Cause.squash(exit.cause);
};

/**
 * Fork a fixed-rate tick fiber — the Effect replacement for `setInterval`:
 * the first tick fires after `intervalMs`, later ticks stay on the fixed-rate
 * grid via `Schedule.fixed` (a slow tick does not push later ticks, matching
 * `setInterval`; same idiom as `host/staleness.ts` `quiescencePollEffect`).
 * Returns a cancel thunk that interrupts the fiber — the `clearInterval`.
 *
 * `tick` must not throw: a defect would end the fiber, where `setInterval`
 * kept firing. Callers keep their own try/catch, exactly as before.
 */
export const forkFixedRateFiber = (
  intervalMs: number,
  tick: () => void,
): (() => void) => {
  const canceled = Deferred.makeUnsafe<void>();
  void storageRuntime
    .runPromise(
      Effect.raceFirst(
        Effect.sleep(intervalMs).pipe(
          Effect.andThen(
            Effect.repeat(Effect.sync(tick), Schedule.fixed(intervalMs)),
          ),
          Effect.asVoid,
        ),
        Deferred.await(canceled),
      ),
    )
    .catch(() => undefined);
  return () => {
    Deferred.doneUnsafe(canceled, Effect.void);
  };
};
