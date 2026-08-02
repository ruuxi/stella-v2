/**
 * The one module-level ManagedRuntime for the third-party migration tree
 * (M5 kernel/migration pass), plus the shared IO adapter.
 *
 * House conventions (docs/effect-architecture.md, kernel/tools/effect-runtime.ts):
 * - Exactly ONE requirements-free runtime per facade module family; context
 *   rides in closures, never per-call `Effect.runPromise`.
 * - Promise facades reject with the ORIGINAL failure object (`Cause.squash`),
 *   so callers observe byte-identical error objects and messages.
 * - The importer's leaf helpers (per-file reads, per-section importers) stay
 *   plain async functions with their own best-effort error reporting; each
 *   crosses into Effect through one `tryMigrationOp` seam at the
 *   orchestration level, and the migration database is a scoped resource so
 *   an owned handle can never leak past a failed run.
 */

import { Cause, Effect, Exit, Layer, ManagedRuntime } from "effect";

/** Shared runtime for every Effect run in `kernel/migration`. */
export const migrationRuntime = ManagedRuntime.make(Layer.empty);

/**
 * Run a migration Effect on the shared runtime, rejecting with the ORIGINAL
 * failure object (`Cause.squash`) so facade callers see the exact error the
 * pre-Effect code would have thrown.
 */
export const runMigrationEffect = async <A>(
  effect: Effect.Effect<A, unknown>,
): Promise<A> => {
  const exit = await migrationRuntime.runPromiseExit(effect);
  if (Exit.isSuccess(exit)) {
    return exit.value;
  }
  throw Cause.squash(exit.cause);
};

/** Wrap one async migration IO step; failures carry the original error. */
export const tryMigrationOp = <A>(
  op: () => Promise<A>,
): Effect.Effect<A, unknown> =>
  Effect.tryPromise({
    try: op,
    catch: (error) => error,
  });
