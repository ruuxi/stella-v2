/**
 * The one module-level ManagedRuntime for the connector tree (M5
 * kernel/connectors pass), plus the small Effect combinators the connector
 * plumbing shares.
 *
 * House conventions (docs/effect-architecture.md, kernel/tools/effect-runtime.ts):
 * - Exactly ONE requirements-free runtime per facade module family; context
 *   rides in closures, never per-call `Effect.runPromise`.
 * - Promise facades rethrow the ORIGINAL failure via `Cause.squash`, so
 *   callers observe byte-identical error objects and messages (OAuth error
 *   strings are user-visible and matched by callers such as
 *   `stella-connect`).
 * - `fetch` seams still need a real `AbortSignal`, so the seam
 *   `AbortController`s stay in their owning modules as sanctioned ratchet
 *   pins; only the timers move onto Effect fibers.
 */

import { Cause, Deferred, Effect, Exit, Layer, ManagedRuntime } from "effect";

/** Shared runtime for every Effect run in `kernel/connectors`. */
export const connectorsRuntime = ManagedRuntime.make(Layer.empty);

/**
 * Run a connector Effect on the shared runtime, rejecting with the ORIGINAL
 * failure object (`Cause.squash`) so facade callers see the exact error the
 * pre-Effect code would have thrown.
 */
export const runConnectorEffect = async <A>(
  effect: Effect.Effect<A, unknown>,
): Promise<A> => {
  const exit = await connectorsRuntime.runPromiseExit(effect);
  if (Exit.isSuccess(exit)) {
    return exit.value;
  }
  throw Cause.squash(exit.cause);
};

/**
 * Wrap one async connector IO call (token-store fs access, broker hops,
 * token-endpoint fetches); failures carry the original error object — the
 * connector-side sibling of `kernel/memory/effect-io.ts` `tryFs`.
 */
export const tryConnectorOp = <A>(
  op: () => Promise<A>,
): Effect.Effect<A, unknown> =>
  Effect.tryPromise({
    try: op,
    catch: (error) => error,
  });

/** Abortable sleep facade — the drop-in replacement for `setTimeout` delays. */
export const sleepMs = (ms: number): Promise<void> =>
  connectorsRuntime.runPromise(Effect.sleep(ms));

/**
 * Fork a bounded timeout fiber: after `timeoutMs`, run `onTimeout`. Returns a
 * cancel thunk that interrupts the pending timeout — the Effect replacement
 * for `setTimeout`/`clearTimeout` pairs guarding in-flight requests (same
 * shape as `kernel/tools/effect-runtime.ts` `forkAbortTimer`).
 */
export const forkTimeoutFiber = (
  timeoutMs: number,
  onTimeout: () => void,
): (() => void) => {
  const canceled = Deferred.makeUnsafe<void>();
  void connectorsRuntime
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
 * Run `run()` (typically a `fetch` holding a seam `AbortController`'s signal)
 * guarded by a scoped timeout fiber that fires `onTimeout` after `timeoutMs`.
 * The fiber is interrupted when `run` settles (the `clearTimeout` in the old
 * `finally`), and `mapError` lets callers substitute their parity timeout
 * error when the seam signal aborted.
 */
export const guardWithAbortTimeout = <A>(args: {
  timeoutMs: number;
  onTimeout: () => void;
  run: () => Promise<A>;
  mapError?: (error: unknown) => unknown;
}): Promise<A> =>
  runConnectorEffect(
    Effect.scoped(
      Effect.gen(function* () {
        yield* Effect.forkScoped(
          Effect.sleep(args.timeoutMs).pipe(
            Effect.flatMap(() => Effect.sync(args.onTimeout)),
          ),
          { startImmediately: true },
        );
        return yield* Effect.tryPromise({
          try: args.run,
          catch: (error) => (args.mapError ? args.mapError(error) : error),
        });
      }),
    ),
  );
