import { Cause, Effect, Exit, Layer, ManagedRuntime } from "effect";

/**
 * The memory subsystem's single imperative boundary.
 *
 * Every exported plain-Promise (or plain-sync) API in `kernel/memory/` is a
 * facade over this one module-level ManagedRuntime, mirroring
 * `host/lifecycle.ts`. Rejections rethrow the ORIGINAL failure object via
 * `Cause.squash`, so error message strings observed by callers are
 * byte-identical to the pre-Effect implementation.
 */
const memoryRuntime = ManagedRuntime.make(Layer.empty);

/** Run a memory Effect, rejecting with the original failure object. */
export const runMemoryPromise = async <A>(
  effect: Effect.Effect<A, unknown>,
): Promise<A> => {
  const exit = await memoryRuntime.runPromiseExit(effect);
  if (Exit.isSuccess(exit)) {
    return exit.value;
  }
  throw Cause.squash(exit.cause);
};

/**
 * Run a synchronous memory Effect (sync fs / sqlite access), throwing the
 * original failure object. Used by resident-doc readers whose callers run
 * inside SQLite transactions and cannot await.
 */
export const runMemorySync = <A>(effect: Effect.Effect<A, unknown>): A => {
  const exit = memoryRuntime.runSyncExit(effect);
  if (Exit.isSuccess(exit)) {
    return exit.value;
  }
  throw Cause.squash(exit.cause);
};
