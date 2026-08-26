/**
 * The one module-level ManagedRuntime for `kernel/computer-use` (M5 wave-4
 * pass), plus the small Effect combinators the area shares.
 *
 * House conventions (docs/effect-architecture.md, kernel/tools/effect-runtime.ts):
 * - Exactly ONE requirements-free runtime per area; context rides in
 *   closures, never per-call `Effect.runPromise`. This runtime is
 *   area-owned — computer-use modules never import another area's runtime.
 * - Promise facades rethrow the ORIGINAL failure via `Cause.squash`, so
 *   callers observe byte-identical error objects and messages.
 * - Caller-owned `AbortSignal`s cross into Effect exactly once, through the
 *   `acquireAbortLatch` bridge in `kernel/agent-core/abort-bridge.ts`
 *   (cooperative cancel: the latch never aborts the signal, and listener
 *   registration is a scoped resource removed on every exit path).
 */

import { Cause, Deferred, Effect, Exit, Layer, ManagedRuntime } from "effect";

/** Shared runtime for every Effect run in `kernel/computer-use`. */
export const computerUseRuntime = ManagedRuntime.make(Layer.empty);

/**
 * Run a computer-use Effect on the shared runtime, rejecting with the
 * ORIGINAL failure object (`Cause.squash`) so facade callers see the exact
 * error the pre-Effect code would have thrown.
 */
export const runComputerUseEffect = async <A>(
  effect: Effect.Effect<A, unknown>,
): Promise<A> => {
  const exit = await computerUseRuntime.runPromiseExit(effect);
  if (Exit.isSuccess(exit)) {
    return exit.value;
  }
  throw Cause.squash(exit.cause);
};

/**
 * Fork a bounded timeout fiber: after `timeoutMs`, run `onTimeout`. Returns
 * a cancel thunk that interrupts the pending timeout — the Effect
 * replacement for `setTimeout`/`clearTimeout` pairs guarding in-flight
 * daemon requests, evaluations, and dispose windows. Canceling after the
 * timeout fired (or firing after cancel) is a no-op, exactly like
 * `clearTimeout` on a settled timer.
 */
export const forkCancelableTimeout = (
  timeoutMs: number,
  onTimeout: () => void,
): (() => void) => {
  const canceled = Deferred.makeUnsafe<void>();
  void computerUseRuntime
    .runPromise(
      Effect.raceFirst(
        Effect.sleep(timeoutMs).pipe(
          Effect.flatMap(() => Effect.sync(onTimeout)),
        ),
        Deferred.await(canceled),
      ),
    )
    .catch(() => undefined);
  return () => {
    Deferred.doneUnsafe(canceled, Effect.void);
  };
};
