/**
 * The one module-level ManagedRuntime for the CLI tree (M5 kernel/cli
 * pass), plus the small Effect combinators the CLI entry points and the
 * Windows computer plumbing share.
 *
 * House conventions (docs/effect-architecture.md, kernel/tools/effect-runtime.ts,
 * kernel/connectors/effect-runtime.ts):
 * - Exactly ONE requirements-free runtime per facade module family; context
 *   rides in closures, never per-call `Effect.runPromise`.
 * - Promise facades reject with the ORIGINAL failure object (`Cause.squash`),
 *   so callers observe byte-identical error messages (the Windows daemon
 *   error strings are matched by the computer-use retry paths).
 * - Caller-owned `AbortSignal`s cross into Effect exactly once, through the
 *   same `acquireAbortLatch` bridge the agent loop uses; each caller keeps
 *   its own abort-error builder so legacy per-module messages stay
 *   byte-identical.
 * - This module is bundled into the standalone CLI binaries (stella-connect
 *   cone already carries `effect`; the esbuild CLI bundle handles it).
 */

import { Cause, Deferred, Effect, Exit, Layer, ManagedRuntime } from "effect";
import { acquireAbortLatch } from "../agent-core/abort-bridge.js";

/** Shared runtime for every Effect run in `kernel/cli`. */
export const cliRuntime = ManagedRuntime.make(Layer.empty);

/**
 * Run a CLI Effect on the shared runtime, rejecting with the ORIGINAL
 * failure object (`Cause.squash`) so facade callers see the exact error the
 * pre-Effect code would have thrown.
 */
export const runCliEffect = async <A>(
  effect: Effect.Effect<A, unknown>,
): Promise<A> => {
  const exit = await cliRuntime.runPromiseExit(effect);
  if (Exit.isSuccess(exit)) {
    return exit.value;
  }
  throw Cause.squash(exit.cause);
};

/** Plain sleep facade — the drop-in replacement for `setTimeout` delays. */
export const sleepMs = (ms: number): Promise<void> =>
  cliRuntime.runPromise(Effect.sleep(ms));

/**
 * Abortable sleep: resolves after `ms`, rejects with `makeAbortError(signal)`
 * when the signal aborts first (same shape as
 * `kernel/tools/effect-runtime.ts` `sleepWithAbort`). The listener
 * registration is a scoped resource removed on every exit path.
 */
export const sleepWithAbort = (
  ms: number,
  signal: AbortSignal | undefined,
  makeAbortError: (signal: AbortSignal | undefined) => Error,
): Promise<void> =>
  runCliEffect(
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
    ),
  );

/**
 * Fork a bounded timeout fiber: after `timeoutMs`, run `onTimeout`. Returns
 * a cancel thunk that interrupts the pending timeout — the Effect
 * replacement for `setTimeout`/`clearTimeout` pairs guarding in-flight
 * requests (same shape as `kernel/connectors/effect-runtime.ts`
 * `forkTimeoutFiber`).
 */
export const forkTimeoutFiber = (
  timeoutMs: number,
  onTimeout: () => void,
): (() => void) => {
  const canceled = Deferred.makeUnsafe<void>();
  void cliRuntime
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

/**
 * Keep the Node event loop alive while a CLI entry runs: a repeating sleep
 * fiber whose pending timer holds the loop open, replacing the old
 * `setInterval(() => undefined, intervalMs)` keep-alive. Returns a stop
 * thunk (the old `clearInterval`).
 */
export const forkKeepAliveTicker = (intervalMs: number): (() => void) => {
  const stopped = Deferred.makeUnsafe<void>();
  void cliRuntime
    .runPromise(
      Effect.raceFirst(
        Effect.forever(Effect.sleep(intervalMs)),
        Deferred.await(stopped),
      ),
    )
    .catch(() => undefined);
  return () => {
    Deferred.doneUnsafe(stopped, Effect.void);
  };
};
