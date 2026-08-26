/**
 * The one module-level ManagedRuntime for the extensions tree (M5
 * kernel/extensions pass), plus the shared IO adapter.
 *
 * House conventions (docs/effect-architecture.md, kernel/tools/effect-runtime.ts):
 * - Exactly ONE requirements-free runtime per facade module family; context
 *   rides in closures, never per-call `Effect.runPromise`.
 * - Promise facades reject with the ORIGINAL failure object (`Cause.squash`),
 *   so callers observe byte-identical error objects and messages.
 * - Extension code itself (factories, hook handlers, tool executors) stays
 *   promise-shaped: it is user-authored and invoked from non-Effect land, so
 *   it crosses into Effect through one `tryExtensionOp` seam per call.
 */

import { Cause, Effect, Exit, Layer, ManagedRuntime } from "effect";

/** Shared runtime for every Effect run in `kernel/extensions`. */
export const extensionsRuntime = ManagedRuntime.make(Layer.empty);

/**
 * Run an extensions Effect on the shared runtime, rejecting with the
 * ORIGINAL failure object (`Cause.squash`) so facade callers see the exact
 * error the pre-Effect code would have thrown.
 */
export const runExtensionEffect = async <A>(
  effect: Effect.Effect<A, unknown>,
): Promise<A> => {
  const exit = await extensionsRuntime.runPromiseExit(effect);
  if (Exit.isSuccess(exit)) {
    return exit.value;
  }
  throw Cause.squash(exit.cause);
};

/**
 * Wrap one async extension IO call (fs reads, dynamic `import()`, extension
 * factory/hook invocations); failures carry the original error object.
 */
export const tryExtensionOp = <A>(
  op: () => Promise<A>,
): Effect.Effect<A, unknown> =>
  Effect.tryPromise({
    try: op,
    catch: (error) => error,
  });
