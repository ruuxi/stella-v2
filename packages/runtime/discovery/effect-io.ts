import {
  Cause,
  Effect,
  Exit,
  Layer,
  ManagedRuntime,
  type Scope,
} from "effect";

/**
 * Shared Effect adapters for the discovery collectors. Pure parsers,
 * formatters, and platform-path helpers stay plain functions in the modules
 * that own them; these wrappers exist so collector IO runs as Effects while
 * every exported collector keeps its plain-Promise signature (facades over
 * the single module-level ManagedRuntime below) and rejects with the exact
 * error object the pre-Effect implementation threw.
 */

/** The ONE module-level runtime every discovery Promise facade runs on. */
export const discoveryRuntime = ManagedRuntime.make(Layer.empty);

/**
 * Run a discovery Effect on the shared runtime, rejecting with the original
 * failure object (`Cause.squash` — the `host/lifecycle.ts` facade pattern) so
 * callers observe byte-identical error messages and shapes.
 */
export const runDiscovery = async <A>(
  effect: Effect.Effect<A, unknown>,
): Promise<A> => {
  const exit = await discoveryRuntime.runPromiseExit(effect);
  if (Exit.isSuccess(exit)) {
    return exit.value;
  }
  throw Cause.squash(exit.cause);
};

/** Wrap one async call; failures carry the original rejection value. */
export const tryDiscovery = <A>(
  op: () => Promise<A>,
): Effect.Effect<A, unknown> =>
  Effect.tryPromise({ try: op, catch: (error) => error });

/** Wrap one sync call; failures carry the original thrown value. */
export const tryDiscoverySync = <A>(op: () => A): Effect.Effect<A, unknown> =>
  Effect.try({ try: op, catch: (error) => error });

/**
 * Parity port of the collectors' `withTimeout` helper — `Promise.race`
 * against a timer that RESOLVES with `fallback`:
 *
 * - a settlement (success or failure) before `ms` wins the race;
 * - after `ms` the fallback value wins. The losing collector is interrupted,
 *   but its promise-based leaves keep running to completion in the
 *   background and clean up after themselves, exactly as the abandoned
 *   `Promise.race` loser did.
 */
export const timeoutFallback = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
  ms: number,
  fallback: A,
): Effect.Effect<A, E, R> =>
  Effect.timeoutOrElse(effect, {
    duration: ms,
    orElse: () => Effect.succeed(fallback),
  });

/**
 * Open a closeable handle (sqlite database, file handle) as a scoped
 * resource: the release runs on success, failure, and interruption, so an
 * open handle can never leak past the collector that acquired it.
 */
export const acquireCloseable = <Db extends { close: () => void }>(
  open: () => Promise<Db>,
): Effect.Effect<Db, unknown, Scope.Scope> =>
  Effect.acquireRelease(tryDiscovery(open), (db) =>
    Effect.sync(() => db.close()),
  );
