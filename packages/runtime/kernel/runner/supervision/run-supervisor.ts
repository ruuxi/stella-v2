/**
 * Kernel run supervisor (M5 surface 3).
 *
 * Owns the fiber tree for orchestrator runs and their descendants. Every
 * launched orchestrator turn registers a root fiber keyed by `runId`; every
 * subagent attempt spawned with that `rootRunId` registers a child fiber in
 * the same per-run cancellation scope. The structural guarantees:
 *
 * - `cancelRun(runId)` closes the run's scope: the root fiber and every
 *   descendant fiber are interrupted, each interruption fires the unit's
 *   cooperative abort (AbortController / LocalAgentManager.cancelAgent), and
 *   the returned promise resolves only after every underlying unit has
 *   settled — user-cancel deterministically finalizes everything beneath
 *   the run, subagent sessions included.
 * - Natural root completion does NOT tear down still-running children
 *   (deliberately detached background agents keep their manager-owned
 *   lifecycle); the per-run scope stays open for late cancellation and is
 *   reclaimed once quiescent.
 * - Children spawned without a root run supervise under a detached scope so
 *   runtime shutdown still interrupts and joins them.
 * - `shutdown()` closes every scope and joins the whole tree.
 *
 * Exported signatures are promise/data-shaped only; Effect stays inside
 * `SupervisedScope`.
 */

import {
  createSupervisedScope,
  type SupervisedScope,
} from "../../shared/supervised-scope.js";

export type SupervisedRunWork = {
  /** Cooperative cancel for the unit. Idempotent. */
  abort: (reason?: unknown) => void;
  /** Already-started promise settling only after the unit's own teardown. */
  settled: Promise<unknown>;
};

export type KernelRunSupervisor = {
  /** Register the root orchestrator-turn fiber for `runId`. */
  startRun: (runId: string, work: SupervisedRunWork) => void;
  /**
   * Register a child unit (subagent attempt) under `rootRunId`'s
   * cancellation scope, or under the detached scope when no root exists.
   */
  adoptChild: (
    rootRunId: string | undefined,
    childId: string,
    work: SupervisedRunWork,
  ) => void;
  /**
   * Register an arbitrary run-owned resource (provider stream, tool call,
   * external engine process) under `rootRunId`'s cancellation scope with a
   * verbatim label, or under the detached scope when no root exists. Same
   * structural guarantees as `adoptChild`.
   */
  adoptResource: (
    rootRunId: string | undefined,
    label: string,
    work: SupervisedRunWork,
  ) => void;
  /**
   * Interrupt the run's root fiber and every descendant, firing each unit's
   * abort and joining its teardown. Resolves after all finalizers ran.
   * No-op for unknown runs.
   */
  cancelRun: (runId: string, reason?: string) => Promise<void>;
  /** Resolves once the run's scope has no live fibers. Does not interrupt. */
  awaitRunTermination: (runId: string) => Promise<void>;
  /** Total live supervised fibers across all runs (tests/telemetry). */
  liveFiberCount: () => number;
  /** Interrupt and join everything (runs + detached children). Idempotent. */
  shutdown: () => Promise<void>;
};

export const createKernelRunSupervisor = (): KernelRunSupervisor => {
  const entries = new Map<string, SupervisedScope>();
  /** In-flight per-run closes; concurrent cancels join the same promise. */
  const closing = new Map<string, Promise<void>>();
  const detached = createSupervisedScope("kernel-runs:detached");
  let shutdownPromise: Promise<void> | null = null;

  const reclaimWhenQuiescent = (runId: string, scope: SupervisedScope) => {
    void scope.quiesced().then(() => {
      if (
        entries.get(runId) === scope &&
        scope.liveCount() === 0 &&
        !scope.closed()
      ) {
        entries.delete(runId);
        void scope.close("quiescent");
      }
    });
  };

  const ensureRunScope = (runId: string): SupervisedScope => {
    const existing = entries.get(runId);
    if (existing && !existing.closed()) return existing;
    const scope = createSupervisedScope(`kernel-run:${runId}`);
    entries.set(runId, scope);
    return scope;
  };

  return {
    startRun: (runId, work) => {
      if (shutdownPromise) {
        work.abort(new Error("Runtime is shutting down."));
        return;
      }
      const scope = ensureRunScope(runId);
      scope.supervise({ label: `orchestrator-turn:${runId}`, ...work });
      reclaimWhenQuiescent(runId, scope);
    },
    adoptChild: (rootRunId, childId, work) => {
      if (shutdownPromise) {
        work.abort(new Error("Runtime is shutting down."));
        return;
      }
      const scope = rootRunId ? ensureRunScope(rootRunId) : detached;
      scope.supervise({ label: `subagent-attempt:${childId}`, ...work });
      if (rootRunId) reclaimWhenQuiescent(rootRunId, scope);
    },
    adoptResource: (rootRunId, label, work) => {
      if (shutdownPromise) {
        work.abort(new Error("Runtime is shutting down."));
        return;
      }
      const scope = rootRunId ? ensureRunScope(rootRunId) : detached;
      scope.supervise({ label, ...work });
      if (rootRunId) reclaimWhenQuiescent(rootRunId, scope);
    },
    cancelRun: (runId, reason) => {
      // Double-cancel join: concurrent cancels for the same run must all
      // await the SAME teardown. Without the memo, the second caller would
      // observe the deleted entry and resolve immediately — releasing the
      // lane while the first close is still joining fibers.
      const inFlight = closing.get(runId);
      if (inFlight) return inFlight;
      const scope = entries.get(runId);
      if (!scope) return Promise.resolve();
      entries.delete(runId);
      const close = scope
        .close(reason ?? "canceled")
        .finally(() => closing.delete(runId));
      closing.set(runId, close);
      return close;
    },
    awaitRunTermination: (runId) =>
      closing.get(runId) ??
      entries.get(runId)?.quiesced() ??
      Promise.resolve(),
    liveFiberCount: () =>
      [...entries.values()].reduce(
        (total, scope) => total + scope.liveCount(),
        detached.liveCount(),
      ),
    shutdown: () => {
      if (shutdownPromise) return shutdownPromise;
      const scopes = [...entries.values(), detached];
      entries.clear();
      shutdownPromise = Promise.all(
        scopes.map((scope) => scope.close("runtime-shutdown")),
      ).then(() => undefined);
      return shutdownPromise;
    },
  };
};
