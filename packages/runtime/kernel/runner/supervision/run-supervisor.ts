/**
 * Kernel run supervisor (M5 surface 3).
 *
 * Owns the fiber tree for orchestrator runs and their descendants. Every
 * orchestrator run registers its cooperative abort at admission
 * (`registerRun`, before the root fiber exists), every launched turn
 * registers a root fiber keyed by `runId` (`startRun`), and every subagent
 * attempt spawned with that `rootRunId` registers a child fiber in the same
 * per-run cancellation scope. This keyed structure replaced the runner's
 * `activeRunAbortControllers` map: run lookup, pre-launch cancellation, and
 * worker-stop abort fan-out all key off the run scopes. The structural
 * guarantees:
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
  /**
   * Register the run's cooperative abort at admission time, before the root
   * fiber exists. The registration lives with the run's scope entry (it is
   * reclaimed with it), so the pre-launch admission window — model-route
   * resolution, agent-context build — is cancellable through the same keyed
   * structure as the launched fiber tree. Replaces the runner's
   * `activeRunAbortControllers` map.
   */
  registerRun: (runId: string, abort: (reason?: unknown) => void) => void;
  /**
   * Whether `runId` has a registered or live scope (including a cancel that
   * is still joining teardown). The cancel path's admission gate.
   */
  hasRun: (runId: string) => boolean;
  /**
   * Fire the run's registered cooperative abort without interrupting or
   * joining anything — the synchronous "abort first, join after" half of
   * the cancel path. No-op for unknown runs.
   */
  abortRun: (runId: string, reason?: unknown) => void;
  /**
   * Drop a registration whose launch never happened (admission failure or
   * pre-execution cancel). Closes the run's — necessarily fiberless — scope
   * so the entry cannot leak. No-op for unknown runs.
   */
  discardRun: (runId: string) => void;
  /** Number of registered run scopes (stop()-time telemetry). */
  activeRunCount: () => number;
  /** Fire every registered run abort (worker-stop fan-out). */
  abortAllRuns: () => void;
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
  /** Total live supervised fibers across all runs for runtime telemetry. */
  liveFiberCount: () => number;
  /** Interrupt and join everything (runs + detached children). Idempotent. */
  shutdown: () => Promise<void>;
};

type RunEntry = {
  scope: SupervisedScope;
  /**
   * Cooperative pre-launch abort registered by `registerRun`. Kept for the
   * run's whole life so the cancel path can abort synchronously before
   * joining the fiber tree. Firing it is always idempotent (it wraps an
   * `AbortController.abort`).
   */
  abort?: (reason?: unknown) => void;
};

export const createKernelRunSupervisor = (): KernelRunSupervisor => {
  const entries = new Map<string, RunEntry>();
  /** In-flight per-run closes; concurrent cancels join the same promise. */
  const closing = new Map<string, Promise<void>>();
  const detached = createSupervisedScope("kernel-runs:detached");
  let shutdownPromise: Promise<void> | null = null;

  const reclaimWhenQuiescent = (runId: string, entry: RunEntry) => {
    void entry.scope.quiesced().then(() => {
      if (
        entries.get(runId) === entry &&
        entry.scope.liveCount() === 0 &&
        !entry.scope.closed()
      ) {
        entries.delete(runId);
        void entry.scope.close("quiescent");
      }
    });
  };

  const ensureRunEntry = (runId: string): RunEntry => {
    const existing = entries.get(runId);
    if (existing && !existing.scope.closed()) return existing;
    const entry: RunEntry = {
      scope: createSupervisedScope(`kernel-run:${runId}`),
    };
    entries.set(runId, entry);
    return entry;
  };

  const fireRegisteredAbort = (entry: RunEntry, reason?: unknown): void => {
    try {
      entry.abort?.(reason);
    } catch {
      // Cooperative abort is best-effort; the fiber finalizers own joins.
    }
  };

  return {
    registerRun: (runId, abort) => {
      if (shutdownPromise) {
        try {
          abort(new Error("Runtime is shutting down."));
        } catch {
          // Best-effort.
        }
        return;
      }
      ensureRunEntry(runId).abort = abort;
    },
    hasRun: (runId) => entries.has(runId) || closing.has(runId),
    abortRun: (runId, reason) => {
      const entry = entries.get(runId);
      if (!entry) return;
      fireRegisteredAbort(entry, reason);
    },
    discardRun: (runId) => {
      const entry = entries.get(runId);
      if (!entry) return;
      // Admission never launched a fiber for this run, so the close is an
      // immediate finalizer walk over an empty scope — nothing to join.
      entries.delete(runId);
      void entry.scope.close("discarded");
    },
    activeRunCount: () => entries.size,
    abortAllRuns: () => {
      for (const entry of entries.values()) {
        fireRegisteredAbort(entry);
      }
    },
    startRun: (runId, work) => {
      if (shutdownPromise) {
        work.abort(new Error("Runtime is shutting down."));
        return;
      }
      const entry = ensureRunEntry(runId);
      entry.scope.supervise({ label: `orchestrator-turn:${runId}`, ...work });
      reclaimWhenQuiescent(runId, entry);
    },
    adoptChild: (rootRunId, childId, work) => {
      if (shutdownPromise) {
        work.abort(new Error("Runtime is shutting down."));
        return;
      }
      if (!rootRunId) {
        detached.supervise({ label: `subagent-attempt:${childId}`, ...work });
        return;
      }
      const entry = ensureRunEntry(rootRunId);
      entry.scope.supervise({ label: `subagent-attempt:${childId}`, ...work });
      reclaimWhenQuiescent(rootRunId, entry);
    },
    adoptResource: (rootRunId, label, work) => {
      if (shutdownPromise) {
        work.abort(new Error("Runtime is shutting down."));
        return;
      }
      if (!rootRunId) {
        detached.supervise({ label, ...work });
        return;
      }
      const entry = ensureRunEntry(rootRunId);
      entry.scope.supervise({ label, ...work });
      reclaimWhenQuiescent(rootRunId, entry);
    },
    cancelRun: (runId, reason) => {
      // Double-cancel join: concurrent cancels for the same run must all
      // await the SAME teardown. Without the memo, the second caller would
      // observe the deleted entry and resolve immediately — releasing the
      // lane while the first close is still joining fibers.
      const inFlight = closing.get(runId);
      if (inFlight) return inFlight;
      const entry = entries.get(runId);
      if (!entry) return Promise.resolve();
      entries.delete(runId);
      const close = entry.scope
        .close(reason ?? "canceled")
        .finally(() => closing.delete(runId));
      closing.set(runId, close);
      return close;
    },
    awaitRunTermination: (runId) =>
      closing.get(runId) ??
      entries.get(runId)?.scope.quiesced() ??
      Promise.resolve(),
    liveFiberCount: () =>
      [...entries.values()].reduce(
        (total, entry) => total + entry.scope.liveCount(),
        detached.liveCount(),
      ),
    shutdown: () => {
      if (shutdownPromise) return shutdownPromise;
      // Fire every registered cooperative abort first (the worker-stop
      // ordering the runner previously implemented by walking its
      // AbortController map), then interrupt + join the whole tree.
      for (const entry of entries.values()) {
        fireRegisteredAbort(entry);
      }
      const scopes = [
        ...[...entries.values()].map((entry) => entry.scope),
        detached,
      ];
      entries.clear();
      shutdownPromise = Promise.all(
        scopes.map((scope) => scope.close("runtime-shutdown")),
      ).then(() => undefined);
      return shutdownPromise;
    },
  };
};
