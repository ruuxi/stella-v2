/**
 * Fiber supervision over already-started promise work (M5 surface 3).
 *
 * The kernel's orchestration units (orchestrator turns, subagent attempts,
 * compaction runs, Dream runs) execute as promise chains whose cooperative
 * cancellation contract is an `AbortController`. A `SupervisedScope` gives
 * each unit a supervising Effect fiber forked into one shared `Scope`, so
 * teardown is structural instead of fire-and-forget:
 *
 * - Interrupting the fiber (individually or by closing the scope) runs an
 *   exit-aware finalizer that fires the unit's `abort` and then JOINS the
 *   unit's `settled` promise — the interruption is not considered finished
 *   until the underlying work has actually torn down.
 * - Natural completion simply lets the fiber end; the finalizer still joins
 *   `settled`, so the scope can never report quiescence while work is live.
 * - `close()` interrupts every live fiber via `Scope.close` and resolves only
 *   after every finalizer (abort + join) has run — the deterministic
 *   "interrupt the root, everything beneath is finalized" guarantee.
 *
 * Only promise-shaped values cross this module's exported API; Effect stays
 * an implementation detail (same boundary policy as `host/lifecycle.ts`).
 */

import {
  Cause,
  Effect,
  Exit,
  Fiber,
  Layer,
  ManagedRuntime,
  Scope,
} from "effect";
import { createRuntimeLogger } from "../debug.js";

const logger = createRuntimeLogger("supervised-scope");

/**
 * Shared runtime for all supervision fibers. Requirements-free (Layer.empty):
 * the supervised work carries its own context via closures, mirroring the
 * host-lifecycle facade convention.
 */
const supervisionRuntime = ManagedRuntime.make(Layer.empty);

export type SupervisedWork = {
  /** Short human tag for logs and diagnostics. */
  label: string;
  /**
   * Cooperative cancel for the underlying unit (typically
   * `AbortController.abort`). Must be idempotent; invoked exactly once per
   * fiber interruption, never on natural completion.
   */
  abort: (reason?: unknown) => void;
  /**
   * The already-started underlying promise. It must settle only once the
   * unit's own teardown (finalize callbacks, resource release) has run —
   * every kernel unit already has that shape. Rejections are treated as
   * settled (the unit's own error handling owns them).
   */
  settled: Promise<unknown>;
};

export type SupervisedScope = {
  /**
   * Fork a supervising fiber for `work`. If the scope is already closed the
   * work is aborted immediately (shutdown race) and no fiber is created.
   */
  supervise: (work: SupervisedWork) => void;
  /** Number of live supervised fibers for runtime telemetry. */
  liveCount: () => number;
  /** Resolves once every live fiber has finalized. Does not interrupt. */
  quiesced: () => Promise<void>;
  /**
   * Interrupt every live fiber and resolve after all finalizers (abort +
   * join of the underlying work) have completed. Idempotent.
   */
  close: (reason?: string) => Promise<void>;
  closed: () => boolean;
};

const settleSilently = (settled: Promise<unknown>): Promise<void> =>
  settled.then(
    () => undefined,
    () => undefined,
  );

export const createSupervisedScope = (label: string): SupervisedScope => {
  const scope = Scope.makeUnsafe();
  const live = new Set<SupervisedWork>();
  const quiescedWaiters: Array<() => void> = [];
  let closed = false;
  let closePromise: Promise<void> | null = null;

  const onFiberDone = (work: SupervisedWork): void => {
    live.delete(work);
    if (live.size === 0) {
      const waiters = quiescedWaiters.splice(0, quiescedWaiters.length);
      for (const resolve of waiters) resolve();
    }
  };

  const superviseEffect = (work: SupervisedWork): Effect.Effect<void> =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* Effect.acquireRelease(Effect.void, (_, exit) =>
          Effect.promise(async () => {
            if (Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause)) {
              // Interruption (not natural completion): fire the unit's
              // cooperative cancel, then join actual teardown below.
              try {
                work.abort(
                  new Error(`${label}: ${work.label} was interrupted.`),
                );
              } catch (error) {
                logger.warn("supervised-scope.abort-failed", {
                  scope: label,
                  work: work.label,
                  error:
                    error instanceof Error ? error.message : String(error),
                });
              }
            }
            // Join: the finalizer — and therefore Scope.close / interrupt —
            // completes only after the underlying unit has fully settled.
            await settleSilently(work.settled);
          }),
        );
        // Interruptible wait for natural completion. Interruption lands
        // here and unwinds through the release above.
        yield* Effect.promise(() => settleSilently(work.settled));
      }),
    ).pipe(Effect.ensuring(Effect.sync(() => onFiberDone(work))));

  return {
    supervise: (work) => {
      if (closed) {
        // Shutdown race: never admit unsupervised work after close.
        logger.warn("supervised-scope.closed-rejects-work", {
          scope: label,
          work: work.label,
        });
        try {
          work.abort(new Error(`${label} is closed; ${work.label} aborted.`));
        } catch {
          // Best-effort.
        }
        return;
      }
      live.add(work);
      supervisionRuntime.runSync(
        Effect.forkIn(superviseEffect(work), scope, {
          startImmediately: true,
        }),
      );
    },
    liveCount: () => live.size,
    quiesced: () =>
      live.size === 0
        ? Promise.resolve()
        : new Promise((resolve) => {
            quiescedWaiters.push(resolve);
          }),
    close: (reason) => {
      if (closePromise) return closePromise;
      closed = true;
      closePromise = supervisionRuntime
        .runPromise(
          Scope.close(
            scope,
            Exit.failCause(Cause.interrupt()),
          ),
        )
        .catch((error) => {
          logger.warn("supervised-scope.close-failed", {
            scope: label,
            reason,
            error: error instanceof Error ? error.message : String(error),
          });
        })
        .then(() => undefined);
      return closePromise;
    },
    closed: () => closed,
  };
};

// Bounded shutdown join. Implementation lives in the Effect-free
// `join-timeout.ts` so the fenced tools tree can consume it without
// importing an effect-bearing module; re-exported here for the
// supervision-side callers.
export { joinWithTimeout } from "./join-timeout.js";
