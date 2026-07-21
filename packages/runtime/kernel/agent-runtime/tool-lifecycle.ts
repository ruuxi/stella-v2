/**
 * Run-owned tool execution lifecycle (M5 surface 3, phase 2 batch 2).
 *
 * Every Pi tool call executes as a child resource of its owning run's
 * supervision scope:
 *
 * - **Fiber-derived cancellation.** The tool body receives a child
 *   `AbortController`'s signal derived from the agent-loop's per-tool signal
 *   (which already composes the run signal and the inactivity bound).
 *   Interrupting the tool's fiber — run cancel, runtime shutdown — fires the
 *   same child controller, so a cooperative tool tears down identically on
 *   both paths.
 * - **Settlement joins cleanup.** The registered resource settles only when
 *   the tool body (including its own finally/cleanup and the after-tool
 *   hooks wrapped by the caller) has finished, so closing the run scope
 *   waits for tool teardown before cancellation resolves.
 * - **Bounded abandonment.** A tool that ignores its abort signal must not
 *   hold run cancellation forever: after the child controller aborts, the
 *   supervision join is bounded by the same 5s grace the agent loop uses
 *   before abandoning a cancelled tool. The abandoned execution is logged;
 *   its external work is left to the tool host's own reaping (shell
 *   kill-all on shutdown), exactly as before.
 * - **No duplicate execution.** A `toolCallId` can have at most one live
 *   execution; a second concurrent attempt fails with a canonical error
 *   instead of silently double-running side effects. The guard clears on
 *   settlement so legitimate re-issues after completion still work.
 *
 * Concurrency semantics are unchanged: sequential/parallel fan-out stays in
 * `agent-core/agent-loop.ts` (sequential = one at a time, parallel =
 * unbounded, results in source order).
 */

import { createRuntimeLogger } from "../debug.js";
import type { RunResourceRegistrar } from "./run-resources.js";

const logger = createRuntimeLogger("tool-lifecycle");

/**
 * How long a cancelled tool may keep running before its fiber is released
 * as abandoned. Mirrors `agent-core/agent-loop.ts`
 * DEFAULT_TOOL_ABORT_GRACE_MS: the loop abandons the pending tool call on
 * the same bound, so supervision never out-waits the loop by more than the
 * grace itself.
 */
export const TOOL_ABORT_JOIN_GRACE_MS = 5_000;

export type ToolExecutionSupervisor = <T>(args: {
  toolCallId: string;
  toolName: string;
  /** The agent-loop per-tool signal (run signal + inactivity bound). */
  signal: AbortSignal | undefined;
  /** The tool body. Receives the signal it must observe. */
  run: (signal: AbortSignal | undefined) => Promise<T>;
}) => Promise<T>;

/**
 * Build the per-turn tool execution supervisor. One instance per
 * `createPiTools` call, so the duplicate-execution guard is scoped to the
 * turn that issued the tool calls.
 */
export const createToolExecutionSupervisor = (opts: {
  /** Absent (tests/one-shot paths): passthrough minus the duplicate guard. */
  supervise?: RunResourceRegistrar | undefined;
  /** Test seam; production uses {@link TOOL_ABORT_JOIN_GRACE_MS}. */
  abortJoinGraceMs?: number;
}): ToolExecutionSupervisor => {
  const graceMs = opts.abortJoinGraceMs ?? TOOL_ABORT_JOIN_GRACE_MS;
  const inFlight = new Set<string>();

  return async ({ toolCallId, toolName, signal, run }) => {
    if (inFlight.has(toolCallId)) {
      // Never double-run side effects: the first execution keeps the slot
      // until it settles. Surfaces as a canonical error tool result via the
      // agent loop's existing catch path.
      throw new Error(
        `Tool call ${toolCallId} (${toolName}) is already executing.`,
      );
    }
    inFlight.add(toolCallId);

    if (!opts.supervise) {
      try {
        return await run(signal);
      } finally {
        inFlight.delete(toolCallId);
      }
    }

    const label = `tool:${toolName}:${toolCallId}`;
    const child = new AbortController();
    const onOuterAbort = () => child.abort(signal?.reason);
    if (signal?.aborted) {
      child.abort(signal.reason);
    } else {
      signal?.addEventListener("abort", onOuterAbort);
    }

    const work = (async () => {
      try {
        return await run(child.signal);
      } finally {
        inFlight.delete(toolCallId);
        signal?.removeEventListener("abort", onOuterAbort);
      }
    })();

    // Supervision join: settles with the tool's own teardown, bounded by
    // the abandonment grace once the child controller has aborted.
    let settledFlag = false;
    let abandonTimer: ReturnType<typeof setTimeout> | null = null;
    const settled = new Promise<void>((resolve) => {
      const finish = (abandoned: boolean) => {
        if (settledFlag) return;
        settledFlag = true;
        if (abandonTimer) clearTimeout(abandonTimer);
        if (abandoned) {
          logger.warn("tool-execution.abandoned", { label, graceMs });
        }
        resolve();
      };
      work.then(
        () => finish(false),
        () => finish(false),
      );
      const armAbandonment = () => {
        if (settledFlag || abandonTimer) return;
        if (!Number.isFinite(graceMs) || graceMs <= 0) return;
        abandonTimer = setTimeout(() => finish(true), graceMs);
        abandonTimer.unref?.();
      };
      if (child.signal.aborted) {
        armAbandonment();
      } else {
        child.signal.addEventListener("abort", armAbandonment, {
          once: true,
        });
      }
    });

    opts.supervise({
      label,
      abort: (reason) => child.abort(reason),
      settled,
    });

    return work;
  };
};
