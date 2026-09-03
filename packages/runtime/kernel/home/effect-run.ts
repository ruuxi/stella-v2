import { Effect, Exit, Layer, ManagedRuntime } from "effect";

import { causeToThrowable } from "./errors.js";

/**
 * Requirements-free effect runner for the home modules that are reachable
 * from the Bun worker bundle (kernel/personality). The
 * HomeService runtime in home-runtime.ts statically imports the full home
 * graph — including electron-only modules (stella-home.ts, skills-sync.ts) —
 * which the worker bundle must never reach. Effects that require no service
 * context run here instead; rejections rethrow the ORIGINAL failure object
 * via `Cause.squash` (same facade contract as home-runtime.ts).
 */
let runtimeSingleton: ManagedRuntime.ManagedRuntime<never, never> | null = null;

const runtime = (): ManagedRuntime.ManagedRuntime<never, never> =>
  (runtimeSingleton ??= ManagedRuntime.make(Layer.empty));

/** Run a requirements-free home Effect, rejecting with the original failure. */
export const runHomeEffect = async <A>(
  effect: Effect.Effect<A, unknown>,
): Promise<A> => {
  const exit = await runtime().runPromiseExit(effect);
  if (Exit.isSuccess(exit)) {
    return exit.value;
  }
  throw causeToThrowable(exit.cause);
};
