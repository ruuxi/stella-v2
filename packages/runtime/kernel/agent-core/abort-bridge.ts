import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";

/**
 * The single site where a caller-owned `AbortSignal` crosses into the loop's
 * Effect world (M5 surface 3).
 *
 * The signal is bridged exactly once per run into a `Deferred` completed with
 * the signal's abort reason. Everything downstream — tool cancellation, the
 * post-abort abandonment grace — races or awaits the latch instead of
 * sprinkling `signal.aborted` checks and `addEventListener` plumbing through
 * the loop body. The listener registration is an `acquireRelease` resource,
 * so it is removed when the owning scope closes on every exit path (success,
 * failure, interruption) — the Effect replacement for the old `finally {
 * signal.removeEventListener(...) }` blocks.
 *
 * The signal itself stays caller-owned: the latch never aborts it, and the
 * raw signal object continues to flow unchanged through the caller-facing
 * seams (`streamFn` options, `beforeToolCall`/`afterToolCall`,
 * `transformContext`) exactly as before.
 */
export const acquireAbortLatch = (
	signal: AbortSignal | undefined,
): Effect.Effect<Deferred.Deferred<unknown>, never, Scope.Scope> =>
	Effect.gen(function* () {
		const latch = yield* Deferred.make<unknown>();
		if (!signal) {
			return latch;
		}
		if (signal.aborted) {
			yield* Deferred.succeed(latch, signal.reason);
			return latch;
		}
		const onAbort = () => {
			Deferred.doneUnsafe(latch, Effect.succeed(signal.reason));
		};
		yield* Effect.acquireRelease(
			Effect.sync(() => signal.addEventListener("abort", onAbort)),
			() => Effect.sync(() => signal.removeEventListener("abort", onAbort)),
		);
		return latch;
	});
