/**
 * The one module-level ManagedRuntime for the tools tree (M5 kernel/tools
 * pass), plus the small Effect combinators the tool infrastructure shares.
 *
 * House conventions (docs/effect-architecture.md, agent-core/agent-loop.ts):
 * - Exactly ONE requirements-free runtime per facade module family; context
 *   rides in closures, never per-call `Effect.runPromise`.
 * - Promise facades rethrow the ORIGINAL failure via `Cause.squash`, so
 *   callers observe byte-identical error objects and messages.
 * - Caller-owned `AbortSignal`s cross into Effect exactly once, through the
 *   same `acquireAbortLatch` bridge the agent loop uses (cooperative cancel:
 *   the latch never aborts the signal, and listener registration is a scoped
 *   resource removed on every exit path).
 */

import { Cause, Deferred, Effect, Exit, Layer, ManagedRuntime } from "effect";
import { acquireAbortLatch } from "../agent-core/abort-bridge.js";

/** Shared runtime for every Effect run in `kernel/tools`. */
export const toolsRuntime = ManagedRuntime.make(Layer.empty);

/**
 * Run a tools Effect on the shared runtime, rejecting with the ORIGINAL
 * failure object (`Cause.squash`) so facade callers see the exact error the
 * pre-Effect code would have thrown.
 */
export const runToolEffect = async <A>(
  effect: Effect.Effect<A, unknown>,
): Promise<A> => {
  const exit = await toolsRuntime.runPromiseExit(effect);
  if (Exit.isSuccess(exit)) {
    return exit.value;
  }
  throw Cause.squash(exit.cause);
};

/**
 * Abortable sleep as an Effect: succeeds after `ms`, fails with
 * `makeAbortError(signal)` when the signal aborts first. Each caller keeps
 * its own error builder so the legacy per-module abort messages stay
 * byte-identical.
 */
export const sleepWithAbortEffect = (
  ms: number,
  signal: AbortSignal | undefined,
  makeAbortError: (signal: AbortSignal) => Error,
): Effect.Effect<void, unknown> =>
  Effect.scoped(
    Effect.gen(function* () {
      if (!signal) {
        return yield* Effect.sleep(ms);
      }
      if (signal.aborted) {
        return yield* Effect.fail(makeAbortError(signal));
      }
      const abortLatch = yield* acquireAbortLatch(signal);
      yield* Effect.raceFirst(
        Effect.sleep(ms),
        Deferred.await(abortLatch).pipe(
          Effect.flatMap(() => Effect.fail(makeAbortError(signal))),
        ),
      );
    }),
  );

/**
 * Promise facade over `sleepWithAbortEffect` — the drop-in replacement for
 * the tools tree's hand-rolled `setTimeout` + abort-listener sleeps.
 */
export const sleepWithAbort = (
  ms: number,
  signal: AbortSignal | undefined,
  makeAbortError: (signal: AbortSignal) => Error,
): Promise<void> => runToolEffect(sleepWithAbortEffect(ms, signal, makeAbortError));

/**
 * Fork a bounded timeout fiber: after `timeoutMs`, run `onTimeout` (typically
 * an `AbortController.abort(...)` at a fetch seam). Returns a cancel thunk
 * that interrupts the pending timeout — the Effect replacement for
 * `setTimeout`/`clearTimeout` pairs guarding in-flight requests.
 */
export const forkAbortTimer = (
  timeoutMs: number,
  onTimeout: () => void,
): (() => void) => {
  const canceled = Deferred.makeUnsafe<void>();
  void toolsRuntime
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
