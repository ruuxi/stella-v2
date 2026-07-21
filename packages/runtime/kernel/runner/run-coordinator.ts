/**
 * Effect-owned run coordinator (M5 surface 3, phase 1).
 *
 * Owns run admission and queued-turn draining for the runner's durable
 * orchestrator lane. The lane's mutable mirror stays on `RunnerState`
 * (`activeOrchestratorRunId` & co. plus `queuedOrchestratorTurns`) so every
 * existing reader — busy gates, health snapshots, `stop()`, restart
 * rehydration — keeps observing the same fields; this module is the single
 * writer for admission and the only consumer of the queue.
 *
 * Structural guarantees (each pinned by
 * `tests/runtime/kernel/runner/run-coordinator.test.ts`):
 *
 * - **One active drain per lane.** The drain runs as one Effect fiber forked
 *   into the coordinator's scope; overlapping wakeups can never start a
 *   second concurrent drain of the same lane.
 * - **Coalesced wakeups.** A wake landing while a drain pass is live sets a
 *   pending flag consumed at the end of the pass instead of forking again.
 * - **Queued-message wakeup.** Enqueueing onto an idle lane schedules a
 *   drain on the microtask queue (the historical `queueMicrotask` timing).
 * - **Concurrent caller joining.** Callers park behind queued turns whose
 *   `execute` settles their own promise (`orchestrator-dispatch.ts`); the
 *   drain executes turns strictly one at a time in queue order.
 * - **Cancellation/interruption & teardown before terminal settlement.**
 *   `shutdown()` interrupts the drain fiber via `Scope.close`; turn
 *   execution is uninterruptible, so the interrupt lands at the turn
 *   boundary and shutdown resolves only after the in-flight turn has fully
 *   settled. No turn is ever admitted after shutdown.
 * - **Truthful terminal state.** Only the owning `runId` can release the
 *   active slot; releasing with a stale id is a no-op that reports `false`.
 * - **Restart/rehydration compatibility.** The coordinator holds no durable
 *   state of its own: a worker restart builds a fresh coordinator over the
 *   same `RunnerState` shape and restart-continuation turns admit through
 *   the normal queue path.
 *
 * Only promise/data-shaped values cross the exported API; Effect stays an
 * implementation detail (same fence as `shared/supervised-scope.ts` and
 * `host/lifecycle.ts`).
 */

import { Cause, Effect, Exit, Layer, ManagedRuntime, Scope } from "effect";
import { createRuntimeLogger } from "../debug.js";
import type { QueuedOrchestratorTurn } from "./types.js";

const logger = createRuntimeLogger("run-coordinator");

/**
 * Shared runtime for coordinator fibers. Requirements-free (Layer.empty):
 * the coordinated work carries its own context via closures, mirroring the
 * supervised-scope convention.
 */
const coordinatorRuntime = ManagedRuntime.make(Layer.empty);

export type ActiveOrchestratorRunRegistration = {
  runId: string;
  conversationId: string;
  uiVisibility: "visible" | "hidden";
};

/**
 * The mutable lane mirror the coordinator administers. Structurally a subset
 * of `RunnerState`, kept loose so unit tests can drive the coordinator with
 * a minimal state object.
 */
export type RunCoordinatorHost = {
  state: {
    activeOrchestratorRunId: string | null;
    activeOrchestratorConversationId: string | null;
    activeOrchestratorUiVisibility: "visible" | "hidden";
    activeOrchestratorSession: unknown;
    queuedOrchestratorTurns: QueuedOrchestratorTurn[];
    runCoordinator?: RunCoordinator | null;
  };
};

export type RunCoordinator = {
  /**
   * Claim the lane for `run`. Idempotent for the same `runId`; throws the
   * canonical already-running error when another run owns the lane (every
   * caller pre-checks occupancy, so a throw here surfaces a latent
   * double-admission instead of silently overwriting the active run).
   */
  beginRun: (run: ActiveOrchestratorRunRegistration) => void;
  /**
   * Release the lane if — and only if — `runId` owns it. Clears the full
   * active-run mirror (including the live session). Returns whether the
   * release happened, so stale terminal callbacks cannot clobber a
   * successor run's state.
   */
  releaseRun: (runId: string) => boolean;
  getActiveRun: () => ActiveOrchestratorRunRegistration | null;
  /**
   * Queue a turn with the lane's priority ordering (user turns ahead of the
   * first non-user entry, FIFO within each class) and wake the drain when
   * the lane is idle.
   */
  enqueueTurn: (turn: QueuedOrchestratorTurn) => void;
  /** Coalesced wakeup: schedule a drain pass on the microtask queue. */
  wake: () => void;
  /** Start a drain pass immediately and resolve when the pass ends. */
  drainNow: () => Promise<void>;
  pendingTurnCount: () => number;
  isDraining: () => boolean;
  /** Number of drain fibers ever forked (coalescing assertions in tests). */
  drainPassCount: () => number;
  /**
   * Interrupt the drain fiber and join the in-flight turn. Idempotent and
   * terminal: no wakeup or drain runs afterwards. Queue/slot mirrors are
   * left to the runner's own teardown (`runtime-initialization.ts:stop`).
   */
  shutdown: () => Promise<void>;
};

export const createRunCoordinator = (
  host: RunCoordinatorHost,
): RunCoordinator => {
  const scope = Scope.makeUnsafe();
  let draining = false;
  let wakePending = false;
  let closed = false;
  let drainPasses = 0;
  let closePromise: Promise<void> | null = null;
  const passWaiters: Array<() => void> = [];

  const settleTurn = (turn: QueuedOrchestratorTurn): Promise<void> =>
    turn.execute().then(
      () => undefined,
      // Individual queued turn handlers notify callers (drain parity).
      () => undefined,
    );

  const drainEffect: Effect.Effect<void> = Effect.gen(function* () {
    for (;;) {
      while (
        !closed &&
        !host.state.activeOrchestratorRunId &&
        host.state.queuedOrchestratorTurns.length > 0
      ) {
        const nextTurn = host.state.queuedOrchestratorTurns.shift();
        if (!nextTurn) {
          break;
        }
        // Turn execution is uninterruptible: a shutdown interrupt is
        // delivered at the turn boundary, so `Scope.close` joins the
        // in-flight turn instead of abandoning it mid-admission.
        yield* Effect.uninterruptible(
          Effect.promise(() => settleTurn(nextTurn)),
        );
      }
      if (!closed && wakePending) {
        // A wake landed during this pass — consume it here instead of
        // forking a second drain (coalescing).
        wakePending = false;
        continue;
      }
      break;
    }
  }).pipe(
    Effect.ensuring(
      Effect.sync(() => {
        draining = false;
        const waiters = passWaiters.splice(0, passWaiters.length);
        for (const resolve of waiters) resolve();
      }),
    ),
  );

  const startDrain = (): void => {
    if (closed) {
      return;
    }
    if (draining) {
      wakePending = true;
      return;
    }
    draining = true;
    drainPasses += 1;
    coordinatorRuntime.runSync(
      Effect.forkIn(drainEffect, scope, { startImmediately: true }),
    );
  };

  const awaitPassEnd = (): Promise<void> =>
    draining
      ? new Promise((resolve) => {
          passWaiters.push(resolve);
        })
      : Promise.resolve();

  return {
    beginRun: (run) => {
      const current = host.state.activeOrchestratorRunId;
      if (current && current !== run.runId) {
        throw new Error("The orchestrator is already running.");
      }
      host.state.activeOrchestratorRunId = run.runId;
      host.state.activeOrchestratorConversationId = run.conversationId;
      host.state.activeOrchestratorUiVisibility = run.uiVisibility;
    },
    releaseRun: (runId) => {
      if (host.state.activeOrchestratorRunId !== runId) {
        return false;
      }
      host.state.activeOrchestratorRunId = null;
      host.state.activeOrchestratorConversationId = null;
      host.state.activeOrchestratorUiVisibility = "visible";
      host.state.activeOrchestratorSession = null;
      return true;
    },
    getActiveRun: () => {
      if (
        !host.state.activeOrchestratorRunId ||
        !host.state.activeOrchestratorConversationId
      ) {
        return null;
      }
      return {
        runId: host.state.activeOrchestratorRunId,
        conversationId: host.state.activeOrchestratorConversationId,
        uiVisibility: host.state.activeOrchestratorUiVisibility,
      };
    },
    enqueueTurn: (turn) => {
      const queue = host.state.queuedOrchestratorTurns;
      if (turn.priority === "user") {
        const firstSystemIndex = queue.findIndex(
          (entry) => entry.priority !== "user",
        );
        if (firstSystemIndex === -1) {
          queue.push(turn);
        } else {
          queue.splice(firstSystemIndex, 0, turn);
        }
      } else {
        queue.push(turn);
      }
      if (!host.state.activeOrchestratorRunId) {
        queueMicrotask(startDrain);
      }
    },
    wake: () => {
      queueMicrotask(startDrain);
    },
    drainNow: () => {
      startDrain();
      return awaitPassEnd();
    },
    pendingTurnCount: () => host.state.queuedOrchestratorTurns.length,
    isDraining: () => draining,
    drainPassCount: () => drainPasses,
    shutdown: () => {
      if (closePromise) {
        return closePromise;
      }
      closed = true;
      closePromise = coordinatorRuntime
        .runPromise(Scope.close(scope, Exit.failCause(Cause.interrupt())))
        .catch((error) => {
          logger.warn("run-coordinator.shutdown-failed", {
            error: error instanceof Error ? error.message : String(error),
          });
        })
        .then(() => undefined);
      return closePromise;
    },
  };
};

/**
 * Install-or-reuse the coordinator on the runner state. Both the
 * orchestrator coordinator and `prepareOrchestratorRun` go through this, so
 * whichever touches the lane first binds the single writer for the runner's
 * lifetime.
 */
export const ensureRunCoordinator = (
  host: RunCoordinatorHost,
): RunCoordinator => {
  const existing = host.state.runCoordinator;
  if (existing) {
    return existing;
  }
  const coordinator = createRunCoordinator(host);
  host.state.runCoordinator = coordinator;
  return coordinator;
};
