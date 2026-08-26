import { Effect, Exit, ManagedRuntime } from "effect";

import { causeToThrowable } from "./errors.js";
import * as HomeService from "./home-service.js";

/**
 * The single module-level ManagedRuntime for the Stella-home subsystem.
 * Every legacy plain-Promise export in `kernel/home/` runs through it; the
 * layer is memoized, so the HomeService is built once per process. Rejections
 * rethrow the ORIGINAL failure object via `Cause.squash` (the
 * `host/lifecycle.ts` facade pattern), keeping every escaping error message
 * byte-identical to the pre-Effect implementation.
 *
 * Constructed on first use rather than at module evaluation: this module is
 * inside the facade/service import cycle (facade modules → home-runtime →
 * home-service → facade modules), so when `home-service.ts` itself is the
 * import-graph entry, its `layer` binding is still in the temporal dead zone
 * while this module evaluates.
 */
let homeRuntimeSingleton: ManagedRuntime.ManagedRuntime<
  HomeService.Service,
  never
> | null = null;

const homeRuntime = (): ManagedRuntime.ManagedRuntime<
  HomeService.Service,
  never
> => (homeRuntimeSingleton ??= ManagedRuntime.make(HomeService.layer));

/** Run a home Effect, rejecting with the original failure object. */
export const runHome = async <A>(
  effect: Effect.Effect<A, unknown, HomeService.Service>,
): Promise<A> => {
  const exit = await homeRuntime().runPromiseExit(effect);
  if (Exit.isSuccess(exit)) {
    return exit.value;
  }
  throw causeToThrowable(exit.cause);
};

/** Run an operation against the HomeService instance on the shared runtime. */
export const withHome = <A>(
  use: (home: HomeService.Interface) => Effect.Effect<A, unknown>,
): Promise<A> =>
  runHome(
    Effect.gen(function* () {
      const home = yield* HomeService.Service;
      return yield* use(home);
    }),
  );
