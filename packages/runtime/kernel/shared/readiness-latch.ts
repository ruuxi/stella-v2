/**
 * Effect-owned readiness latch (M5 surface 3, phase 3 batch 5).
 *
 * Replaces fixed-interval "is it set yet?" polling with a Deferred-backed
 * signal: waiters park on `awaitOpen` and wake the moment `open()` fires.
 * Restart-safe — `reset()` re-arms the latch with a fresh Deferred (a
 * stopped runner that boots again gets a closed latch, and waiters parked
 * across the reset stay attached to the generation they observed). The
 * optional wait bound uses one cleared, unref'd timer per call, so no
 * timers or listeners can leak past settlement.
 *
 * Only promise/data shapes cross the exported API; Effect stays inside
 * (same fence as `shared/supervised-scope.ts`).
 */

import { Deferred, Effect, Layer, ManagedRuntime } from "effect";

const latchRuntime = ManagedRuntime.make(Layer.empty);

export type ReadinessLatch = {
  /** Open the latch, waking every parked waiter. Idempotent. */
  open: () => void;
  /** True once the current generation has opened. */
  isOpen: () => boolean;
  /**
   * Re-arm with a fresh closed generation (runner stop → next boot).
   * Idempotent when already closed.
   */
  reset: () => void;
  /**
   * Resolve `"open"` when the latch opens, or `"timeout"` after
   * `timeoutMs` (omit for an unbounded wait). Never rejects.
   */
  awaitOpen: (timeoutMs?: number) => Promise<"open" | "timeout">;
};

export const createReadinessLatch = (): ReadinessLatch => {
  let gate = Deferred.makeUnsafe<void>();
  let opened = false;

  return {
    open: () => {
      if (opened) return;
      opened = true;
      Deferred.doneUnsafe(gate, Effect.void);
    },
    isOpen: () => opened,
    reset: () => {
      if (!opened) return;
      opened = false;
      gate = Deferred.makeUnsafe<void>();
    },
    awaitOpen: (timeoutMs) => {
      if (opened) return Promise.resolve("open");
      const openWait = latchRuntime
        .runPromise(Deferred.await(gate))
        .then(() => "open" as const);
      if (!Number.isFinite(timeoutMs) || (timeoutMs ?? 0) <= 0) {
        return openWait;
      }
      return new Promise((resolve) => {
        let settled = false;
        const timer = setTimeout(() => {
          if (settled) return;
          settled = true;
          resolve("timeout");
        }, timeoutMs);
        timer.unref?.();
        void openWait.then((outcome) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve(outcome);
        });
      });
    },
  };
};
