import { Cause, Context, Deferred, Effect, Exit, Layer } from "effect";

/**
 * Process-lifetime owner of the lazy runner-module import.
 *
 * The runner subgraph (`kernel/runner.ts`, esbuild's `runner-*` chunk) is the
 * biggest single piece of worker boot. The session's RunnerHandle used to
 * start `import()` from inside `internal.worker.initialize`, so the import
 * only began once the host had connected and sent initialize. `prefetch`
 * lets the entry start it as soon as the transport is attached, filling the
 * gap while the host connects (the desktop host polls the socket every
 * 50 ms) and while initialize waits on the host's device-identity round trip.
 * `load` joins the same in-flight import, or starts it if nothing has.
 *
 * The import runs as a fiber forked into this layer's scope and settles into
 * a Deferred, so a failure is stored (never an unhandled rejection) and is
 * re-raised to every `load` caller. RunnerHandle turns it into the same
 * runner-unavailable error as before. Import failures are cached for the
 * process, as the module loader already caches them.
 */
export type RunnerModuleExports = typeof import("../../kernel/runner.js");

export interface Interface {
  /** Start the import if it has not started. Idempotent; never fails. */
  readonly prefetch: Effect.Effect<void>;
  /** The runner module, from the in-flight or settled import. Rejects with
   * the import's original error. */
  readonly load: () => Promise<RunnerModuleExports>;
}

export class Service extends Context.Service<Service, Interface>()(
  "@stella/runtime/worker/RunnerModule",
) {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const scope = yield* Effect.scope;
    const loaded = yield* Deferred.make<RunnerModuleExports, unknown>();
    let started = false;

    const prefetch = Effect.suspend(() => {
      if (started) return Effect.void;
      started = true;
      return Effect.tryPromise({
        try: () => import("../../kernel/runner.js"),
        catch: (error) => error,
      }).pipe(
        Deferred.into(loaded),
        Effect.forkIn(scope, { startImmediately: true }),
        Effect.asVoid,
      );
    });

    const load = async (): Promise<RunnerModuleExports> => {
      const exit = await Effect.runPromiseExit(
        Effect.andThen(prefetch, Deferred.await(loaded)),
      );
      if (Exit.isSuccess(exit)) return exit.value;
      throw Cause.squash(exit.cause);
    };

    return { prefetch, load };
  }),
);
