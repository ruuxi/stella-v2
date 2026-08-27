import { Deferred, Effect, Fiber } from "effect";
import {
  runToolEffect,
  toolsRuntime,
} from "@stella/runtime/kernel/tools/effect-runtime.js";

/**
 * Effect-owned cancellation for the cloud turn retry ladder.
 *
 * The Agent owns the real provider transport signal and is still aborted via
 * `Agent.abort()`. This latch owns only the gap between provider attempts: it
 * stops a fiber-backed retry sleep immediately and gives failure
 * classification an `aborted` bit, without allocating a second platform
 * AbortController whose lifetime is outside the run scope.
 */
export type TurnRetryCancellation = {
  readonly aborted: boolean;
  readonly reason: unknown;
  abort(reason?: unknown): void;
  sleep(milliseconds: number): Promise<void>;
};

const cancellationError = (reason: unknown): Error =>
  reason instanceof Error ? reason : new Error("Request was aborted");

/**
 * Fail immediately at a side-effect admission boundary after an exact Stop.
 * The signal is owned by the supervising Effect fiber; the Deferred-backed
 * latch remains readable by promise-native retry code after that fiber has
 * been interrupted.
 */
export const assertTurnExecutionActive = (
  cancellation: TurnRetryCancellation,
  signal?: AbortSignal,
): void => {
  signal?.throwIfAborted();
  if (cancellation.aborted) throw cancellationError(cancellation.reason);
};

export const createTurnRetryCancellation = (): TurnRetryCancellation => {
  const canceled = Deferred.makeUnsafe<void>();
  let aborted = false;
  let abortReason: unknown;
  const state = {
    get aborted() {
      return aborted;
    },
    get reason() {
      return abortReason;
    },
  };

  return {
    get aborted() {
      return state.aborted;
    },
    get reason() {
      return state.reason;
    },
    abort: (reason?: unknown) => {
      if (aborted) return;
      aborted = true;
      abortReason = reason ?? new Error("Request was aborted");
      Deferred.doneUnsafe(canceled, Effect.void);
    },
    sleep: async (milliseconds: number) => {
      await runToolEffect(
        Effect.raceFirst(
          Effect.sleep(milliseconds),
          Deferred.await(canceled).pipe(
            Effect.flatMap(() =>
              Effect.fail(
                abortReason instanceof Error
                  ? abortReason
                  : new Error("Request was aborted"),
              ),
            ),
          ),
        ),
      );
    },
  };
};

export type TurnExecutionContext = {
  cancellation: TurnRetryCancellation;
  signal: AbortSignal;
  assertActive(): void;
};

/** Promise-free control surface for one Effect-supervised cloud turn. */
export type TurnExecution<T> = {
  /** Actual promise work, used only to retain same-DO turn serialization. */
  readonly settled: Promise<T>;
  readonly cancellation: TurnRetryCancellation;
  /** Aborts in-flight platform I/O when the supervising turn is interrupted. */
  readonly signal: AbortSignal;
  /** Interrupt the supervising fiber and run bounded resource teardown. */
  interrupt(reason?: unknown): Promise<void>;
  /** Join the Effect fiber (rejections and interruption count as settled). */
  join(): Promise<void>;
};

/**
 * Start promise-native cloud work under an Effect fiber.
 *
 * Fiber interruption aborts the signal handed to the work. Stop then performs
 * resource teardown and *boundedly confirms* that the promise-native work has
 * unwound before it acknowledges cancellation. This second join matters:
 * interrupting Effect.tryPromise detaches an underlying platform promise that
 * ignores AbortSignal, and that promise could otherwise create a fresh
 * sandbox/session after teardown. Every external side effect must still call
 * `assertActive()` immediately before admission so the bounded join converges
 * instead of allowing new work after cancellation.
 */
export const startTurnExecution = <T>(args: {
  work: (context: TurnExecutionContext) => Promise<T>;
  /** Immediate abort/teardown, used to make in-flight work unwind promptly. */
  onInterrupt?: (reason: unknown) => void | Promise<void>;
  /**
   * Final resource sweep after promise-native work has physically settled.
   * This closes the create-after-destroy race for platform APIs that ignore
   * AbortSignal while provisioning a sandbox or session.
   */
  afterInterrupt?: (reason: unknown) => void | Promise<void>;
  cleanupTimeoutMs?: number;
}): TurnExecution<T> => {
  const cancellation = createTurnRetryCancellation();
  const requestController = new AbortController();
  let resolveSettled!: (value: T | PromiseLike<T>) => void;
  let rejectSettled!: (reason?: unknown) => void;
  let workStarted = false;
  const settled = new Promise<T>((resolve, reject) => {
    resolveSettled = resolve;
    rejectSettled = reject;
  });

  const execution = Effect.tryPromise({
    try: (effectSignal) => {
      workStarted = true;
      const relayEffectAbort = () => {
        if (!requestController.signal.aborted) {
          requestController.abort(
            effectSignal.reason ?? new Error("Turn execution interrupted."),
          );
        }
      };
      if (effectSignal.aborted) relayEffectAbort();
      else effectSignal.addEventListener("abort", relayEffectAbort, { once: true });
      let work: Promise<T>;
      try {
        work = args.work({
          cancellation,
          signal: requestController.signal,
          assertActive: () =>
            assertTurnExecutionActive(cancellation, requestController.signal),
        });
      } catch (error) {
        effectSignal.removeEventListener("abort", relayEffectAbort);
        rejectSettled(error);
        throw error;
      }
      void work.finally(() => {
        effectSignal.removeEventListener("abort", relayEffectAbort);
      }).catch(() => undefined);
      void work.then(resolveSettled, rejectSettled);
      return work;
    },
    catch: (error) => error,
  });
  const fiber = toolsRuntime.runFork(execution);
  const joined = runToolEffect(Fiber.join(fiber));
  // `join()` below observes the outcome. Keep a handler attached immediately
  // so a detached DO turn cannot create an unhandled rejection meanwhile.
  void joined.catch(() => undefined);
  let interruption: Promise<void> | undefined;

  const awaitUnderlyingSettlement = async (): Promise<void> => {
    const observed = settled.then(
      () => undefined,
      () => undefined,
    );
    await runToolEffect(
      Effect.tryPromise({
        try: () => observed,
        catch: (error) => cancellationError(error),
      }).pipe(Effect.timeout(args.cleanupTimeoutMs ?? 30_000)),
    );
  };

  const runBoundedCleanup = async (
    cleanup: (reason: unknown) => void | Promise<void>,
    reason: unknown,
  ): Promise<void> => {
    await runToolEffect(
      Effect.tryPromise({
        try: () => Promise.resolve(cleanup(reason)),
        catch: (error) => cancellationError(error),
      }).pipe(Effect.timeout(args.cleanupTimeoutMs ?? 30_000)),
    );
  };

  return {
    settled,
    cancellation,
    signal: requestController.signal,
    interrupt: (reason?: unknown) => {
      if (interruption) return interruption;
      const interruptReason = reason ?? new Error("Turn was canceled.");
      cancellation.abort(interruptReason);
      if (!requestController.signal.aborted) {
        requestController.abort(interruptReason);
      }
      interruption = (async () => {
        await runToolEffect(Fiber.interrupt(fiber)).catch(() => undefined);
        if (!workStarted) rejectSettled(cancellationError(interruptReason));
        let immediateCleanupError: unknown;
        if (args.onInterrupt) {
          try {
            await runBoundedCleanup(args.onInterrupt, interruptReason);
          } catch (error) {
            immediateCleanupError = error;
          }
        }
        let settlementError: unknown;
        try {
          await awaitUnderlyingSettlement();
        } catch (error) {
          settlementError = error;
        }
        // A pending createSession() can resolve after the immediate destroy.
        // Sweep once more only after that promise has either settled or hit
        // the bounded timeout. Stop is acknowledged only if both settlement
        // and this final cleanup succeed.
        let finalCleanupError: unknown;
        if (args.afterInterrupt) {
          try {
            await runBoundedCleanup(args.afterInterrupt, interruptReason);
          } catch (error) {
            finalCleanupError = error;
          }
        }
        if (immediateCleanupError) throw immediateCleanupError;
        if (settlementError) throw settlementError;
        if (finalCleanupError) throw finalCleanupError;
      })();
      return interruption;
    },
    join: async () => {
      await joined.catch(() => undefined);
      // Fiber.interrupt settles the Effect fiber as soon as interruption has
      // been delivered. Effect.tryPromise cannot force a promise-native
      // operation to stop, though, so the underlying work may still be
      // unwinding after `joined` resolves. Replayed Stop requests use join()
      // rather than calling interrupt() a second time; make their ACK obey the
      // same bounded physical-settlement contract as the first request.
      await awaitUnderlyingSettlement();
    },
  };
};
