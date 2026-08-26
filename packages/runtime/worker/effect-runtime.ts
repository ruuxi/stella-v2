/**
 * The one module-level ManagedRuntime for the worker process's top-level
 * plumbing (`worker/entry.ts`, transport, peer broker, lifecycle server,
 * CLI bridge), plus the shared timer combinator.
 *
 * `worker/server/**` (surface 1) builds its own layered runtime inside
 * `createRuntimeWorkerServer`; this module covers the plumbing OUTSIDE that
 * boundary — sockets, idle shutdown, request timeouts — following the same
 * per-area runtime pattern as `kernel/tools/effect-runtime.ts`.
 *
 * Worker-reachable: must never import electron or host/ modules.
 */

import {
  Cause,
  Deferred,
  Effect,
  Exit,
  Layer,
  ManagedRuntime,
} from "effect";

/** Shared runtime for every Effect run in the worker's top-level plumbing. */
export const workerRuntime = ManagedRuntime.make(Layer.empty);

/**
 * Run a worker-plumbing Effect on the shared runtime, rejecting with the
 * ORIGINAL failure object (`Cause.squash`) so facade callers see the exact
 * error the pre-Effect code would have thrown.
 */
export const runWorkerEffect = async <A>(
  effect: Effect.Effect<A, unknown>,
): Promise<A> => {
  const exit = await workerRuntime.runPromiseExit(effect);
  if (Exit.isSuccess(exit)) {
    return exit.value;
  }
  throw Cause.squash(exit.cause);
};

/** Cancellation handle for a forked timer fiber. Cancel is idempotent and
 * a no-op once the timer has fired (matching `clearTimeout`). */
export type WorkerTimerHandle = {
  readonly cancel: () => void;
};

/**
 * `setTimeout` replacement: run `fire` once after `delayMs` on the worker
 * runtime. The returned handle interrupts the pending sleep via a
 * `Deferred` latch (the `forkAbortTimer` shape from kernel/tools).
 */
export const forkDelayed = (
  delayMs: number,
  fire: () => void,
): WorkerTimerHandle => {
  const canceled = Deferred.makeUnsafe<void>();
  void workerRuntime
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
