import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";

/**
 * Effect-owned cancellation for one native CLI turn.
 *
 * A turn has two cancellation sources — the DO declaring the turn over and the
 * executor's own verdict on a runaway compaction loop — and exactly one
 * subject: the `claude` child process. A Deferred-backed latch carries both
 * without allocating a platform AbortController whose lifetime would sit
 * outside the turn, and it stays synchronously readable by the promise-native
 * turn code that reports the reason back to its caller.
 *
 * The latch is one-shot: the first reason wins, as the reported turn error.
 */
export type NativeTurnCancellation = {
  readonly aborted: boolean;
  readonly reason: Error | undefined;
  abort(reason: Error): void;
  /** Fails with the abort reason once the latch is settled; never succeeds. */
  readonly awaitAborted: Effect.Effect<never, Error>;
};

export const createNativeTurnCancellation = (): NativeTurnCancellation => {
  const canceled = Deferred.makeUnsafe<void>();
  let abortReason: Error | undefined;
  return {
    get aborted() {
      return abortReason !== undefined;
    },
    get reason() {
      return abortReason;
    },
    abort: (reason: Error) => {
      if (abortReason) return;
      abortReason = reason;
      Deferred.doneUnsafe(canceled, Effect.void);
    },
    awaitAborted: Deferred.await(canceled).pipe(
      Effect.flatMap(() =>
        Effect.fail(abortReason ?? new Error("Claude Code turn was canceled.")),
      ),
    ),
  };
};
