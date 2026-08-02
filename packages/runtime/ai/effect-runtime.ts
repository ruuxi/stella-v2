/**
 * The one module-level ManagedRuntime for the ai/ provider-gateway tree
 * (M5 phase 3 ProviderGateway pass), plus the small Effect combinators the
 * provider adapters share.
 *
 * House conventions (docs/effect-architecture.md, kernel/tools/effect-runtime.ts):
 * - Exactly ONE requirements-free runtime per facade module family; context
 *   rides in closures, never ad-hoc per-call runtimes.
 * - Promise facades rethrow the ORIGINAL failure via `Cause.squash`, so
 *   callers observe byte-identical error objects and messages.
 * - Timer substrate rides on fibers (`Effect.sleep` / `forkCancelableTimeout`)
 *   while every delay VALUE stays data computed by the callers (retry-after
 *   headers, jittered exponential schedules with injectable `random`), per the
 *   storage-wave precedent for data-derived backoff.
 * - `AbortController`s that hand a REAL `AbortSignal` to an SDK/fetch/reader
 *   seam are documented pins at their call sites and are NOT recreated here;
 *   caller-owned signals cross into Effect through the listener-as-resource
 *   bridge in `sleepWithAbortEffect` (same shape as agent-core's abort latch,
 *   inlined so ai/ does not import upward into kernel/agent-core).
 *
 * Note on `unref`: the pre-Effect timers in this tree called `.unref?.()` so a
 * pending backoff or deferral timer never held the process open on its own.
 * Fiber timers do not unref, but every use below is bounded (seconds) and only
 * pending while an in-flight request/session already holds the event loop —
 * the same trade the kernel timer fibers accepted.
 */

import {
	Cause,
	Channel,
	Deferred,
	Effect,
	Exit,
	Layer,
	ManagedRuntime,
	Scope,
	Stream,
} from "effect";

/** Shared runtime for every Effect run in the ai/ provider gateway. */
export const aiRuntime = ManagedRuntime.make(Layer.empty);

/**
 * Run an ai/ Effect on the shared runtime, rejecting with the ORIGINAL
 * failure object (`Cause.squash`) so facade callers see the exact error the
 * pre-Effect code would have thrown.
 */
export const runAiEffect = async <A>(
	effect: Effect.Effect<A, unknown>,
): Promise<A> => {
	const exit = await aiRuntime.runPromiseExit(effect);
	if (Exit.isSuccess(exit)) {
		return exit.value;
	}
	throw Cause.squash(exit.cause);
};

/**
 * Abortable sleep as an Effect: succeeds after `ms`, fails with
 * `makeAbortError(signal)` when the signal aborts first (including a signal
 * that is already aborted on entry). Each caller keeps its own error builder
 * so the legacy per-module abort messages ("Request was aborted",
 * "Login cancelled", ...) stay byte-identical. The abort listener is an
 * `acquireRelease` resource, removed on every exit path.
 */
export const sleepWithAbortEffect = (
	ms: number,
	signal: AbortSignal | undefined,
	makeAbortError: (signal: AbortSignal) => Error,
): Effect.Effect<void, unknown> =>
	Effect.scoped(
		Effect.gen(function* () {
			if (!signal) {
				return yield* Effect.sleep(ms);
			}
			if (signal.aborted) {
				return yield* Effect.fail(makeAbortError(signal));
			}
			const latch = yield* Deferred.make<void>();
			const onAbort = () => {
				Deferred.doneUnsafe(latch, Effect.void);
			};
			yield* Effect.acquireRelease(
				Effect.sync(() => signal.addEventListener("abort", onAbort)),
				() => Effect.sync(() => signal.removeEventListener("abort", onAbort)),
			);
			yield* Effect.raceFirst(
				Effect.sleep(ms),
				Deferred.await(latch).pipe(
					Effect.flatMap(() => Effect.fail(makeAbortError(signal))),
				),
			);
		}),
	);

/**
 * Promise facade over `sleepWithAbortEffect` — the drop-in replacement for
 * the ai/ tree's hand-rolled `setTimeout` + abort-listener sleeps (provider
 * retry backoff, reconnect delays, OAuth device-flow polling).
 */
export const sleepWithAbort = (
	ms: number,
	signal: AbortSignal | undefined,
	makeAbortError: (signal: AbortSignal) => Error,
): Promise<void> => runAiEffect(sleepWithAbortEffect(ms, signal, makeAbortError));

/**
 * Plain fiber-backed sleep for fire-and-forget pacing loops that have no
 * abort semantics of their own.
 */
export const sleepMs = (ms: number): Promise<void> => aiRuntime.runPromise(Effect.sleep(ms));

/**
 * Fork a bounded timeout fiber: after `timeoutMs`, run `onTimeout` (typically
 * an `AbortController.abort(...)` at a fetch seam, or an idle-connection
 * close). Returns a cancel thunk that settles the pending timeout without
 * firing it — the Effect replacement for `setTimeout`/`clearTimeout` pairs.
 * Same shape as kernel/tools' `forkAbortTimer`.
 */
export const forkCancelableTimeout = (
	timeoutMs: number,
	onTimeout: () => void,
): (() => void) => {
	const canceled = Deferred.makeUnsafe<void>();
	void aiRuntime
		.runPromise(
			Effect.raceFirst(
				Effect.sleep(timeoutMs).pipe(Effect.flatMap(() => Effect.sync(onTimeout))),
				Deferred.await(canceled),
			),
		)
		.catch(() => undefined);
	return () => {
		Deferred.doneUnsafe(canceled, Effect.void);
	};
};

/**
 * Stream of raw body chunks from an HTTP response body whose reader teardown
 * is a SCOPED FINALIZER instead of a hand-rolled `try/finally`: when the
 * stream's scope closes — normal EOF, pull failure, or early consumer exit —
 * the finalizer runs exactly once, `reader.cancel()` (rejection ignored; a
 * cancel on an already-finished stream is a no-op) then `releaseLock()`.
 * This is the close-exactly-once-on-every-reader-exit-path invariant the SSE
 * adapters previously enforced with `finally` blocks, now structural.
 *
 * `beforeRead` runs before EVERY read (including the first); returning an
 * Error fails the pull with exactly that error — this preserves the legacy
 * pre-read `signal.aborted` throw byte-identically.
 *
 * Read errors propagate as-is (`catch: (error) => error`), so the consumer
 * observes the original rejection object.
 */
export const scopedBodyChunks = (
	body: ReadableStream<Uint8Array>,
	options?: { readonly beforeRead?: () => Error | undefined },
): Stream.Stream<Uint8Array, unknown> =>
	Stream.fromChannel(
		Channel.fromTransform((_, scope) =>
			Effect.gen(function* () {
				const reader = body.getReader();
				yield* Scope.addFinalizer(
					scope,
					Effect.promise(async () => {
						try {
							await reader.cancel();
						} catch {
							// The stream may already be closed or errored.
						}
						try {
							reader.releaseLock();
						} catch {
							// The lock may already have been released with the stream.
						}
					}),
				);
				return Effect.suspend(() => {
					const abortError = options?.beforeRead?.();
					if (abortError) return Effect.fail(abortError);
					return Effect.tryPromise({
						try: () => reader.read(),
						catch: (error) => error,
					}).pipe(
						Effect.flatMap(({ done, value }) =>
							done ? Cause.done() : Effect.succeed([value] as [Uint8Array]),
						),
					);
				});
			}),
		),
	);

/**
 * Drive an Effect Stream as a plain AsyncGenerator with DETERMINISTIC scope
 * closure on every exit path.
 *
 * `Stream.toAsyncIterable` only releases its scope via the iterator's
 * `return()`; a `for await` loop calls `return()` on early break/throw but
 * NOT on normal completion or on a rejected `next()`. The wrapping
 * generator's `finally` closes the gap: whatever way the generator unwinds —
 * normal end, consumer break, consumer throw, or an error thrown out of
 * `next()` — `iterator.return()` runs, the scope closes, and the stream's
 * finalizers (e.g. `scopedBodyChunks`' reader teardown) execute exactly once
 * (scope close is idempotent) BEFORE control continues past the loop.
 *
 * Elements are pulled one buffer at a time on the caller's cadence, so event
 * ordering is identical to the hand-rolled read loops this replaces.
 */
export async function* iterateStream<A>(
	stream: Stream.Stream<A, unknown>,
): AsyncGenerator<A, void, void> {
	const iterator = Stream.toAsyncIterable(stream)[Symbol.asyncIterator]();
	try {
		for (;;) {
			const result = await iterator.next();
			if (result.done) return;
			yield result.value;
		}
	} finally {
		await iterator.return?.(undefined);
	}
}
