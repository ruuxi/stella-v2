/**
 * The one module-level ManagedRuntime for the host tree (Electron main
 * process side of `packages/runtime`), plus the small timer combinators the
 * host facades share.
 *
 * House conventions (docs/effect-architecture.md, kernel/tools/effect-runtime.ts):
 * - Exactly ONE requirements-free runtime per facade module family; context
 *   rides in closures, never per-call `Effect.runPromise`.
 * - Promise facades rethrow the ORIGINAL failure via `Cause.squash`, so
 *   callers observe byte-identical error objects and messages.
 * - Timers are forked fibers cancelled through a `Deferred` latch (the same
 *   shape as `forkAbortTimer` in kernel/tools) — the Effect replacement for
 *   `setTimeout`/`setInterval` + `clearTimeout` pairs.
 *
 * This module runs in Electron main only. It must never be imported from
 * worker-reachable modules (`worker/**` has its own runtime module).
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

/** Shared runtime for every Effect run in `host/` (staleness handshake,
 * quiescence poll, lifecycle controller, timers). */
export const hostRuntime = ManagedRuntime.make(Layer.empty);

/**
 * Run a host Effect on the shared runtime, rejecting with the ORIGINAL
 * failure object (`Cause.squash`) so facade callers see the exact error the
 * pre-Effect code would have thrown.
 */
export const runHostEffect = async <A>(
  effect: Effect.Effect<A, unknown>,
): Promise<A> => {
  const exit = await hostRuntime.runPromiseExit(effect);
  if (Exit.isSuccess(exit)) {
    return exit.value;
  }
  throw Cause.squash(exit.cause);
};

/** Cancellation handle for a forked timer fiber. Cancel is idempotent and
 * a no-op once the timer has fired (matching `clearTimeout`). */
export type HostTimerHandle = {
  readonly cancel: () => void;
};

/**
 * `setTimeout` replacement: run `fire` once after `delayMs` on the host
 * runtime. The returned handle interrupts the pending sleep via a
 * `Deferred` latch.
 */
export const forkDelayed = (
  delayMs: number,
  fire: () => void,
): HostTimerHandle => {
  const canceled = Deferred.makeUnsafe<void>();
  void hostRuntime
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

/**
 * `setInterval` replacement: first fire after `intervalMs`, then repeat on
 * the fixed-rate grid (`Schedule.fixed` — a slow callback does not push
 * later ticks, matching `setInterval` cadence; see
 * `host/staleness.ts#quiescencePollEffect` for the same parity argument).
 */
export const forkInterval = (
  intervalMs: number,
  fire: () => void,
): HostTimerHandle => {
  const canceled = Deferred.makeUnsafe<void>();
  void hostRuntime
    .runPromise(
      Effect.raceFirst(
        Effect.sleep(intervalMs).pipe(
          Effect.andThen(
            Effect.repeat(Effect.sync(fire), Schedule.fixed(intervalMs)),
          ),
        ),
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
