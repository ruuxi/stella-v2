/**
 * Run-owned external engine turn lifecycle (M5 surface 3, phase 2 batch 3).
 *
 * Claude Code and Codex turns execute inside session-keyed CLI processes
 * that deliberately outlive individual runs (resume affinity: the durable
 * `external_session_id` in SQLite plus the 30-minute idle TTL). Ownership
 * therefore migrates at the TURN seam, not the process seam:
 *
 * - Each engine turn registers as a child resource of its run's supervision
 *   scope. The engine receives a relay signal derived from the run signal;
 *   interrupting the turn's fiber fires the same relay, which drives the
 *   runtime's existing teardown (abort listener → MCP client reset →
 *   SIGINT → 1.5s → SIGTERM → 4s → SIGKILL ladder).
 * - The resource settles with the engine turn itself (its promise settles
 *   only after the runtime's own teardown obligations for the turn ran),
 *   so run cancel/shutdown joins engine teardown before resolving.
 * - The post-abort join is bounded (default 10s — comfortably past the
 *   full kill ladder) so a wedged CLI can never hang cancellation; an
 *   abandoned turn is logged and left to the runtime's session reaping.
 * - Natural completion never touches the process: the fiber simply ends
 *   and the session process stays warm for the next turn, exactly as
 *   before. Durable session identity and restart semantics are untouched.
 */

import { createRuntimeLogger } from "../debug.js";
import type { RunResourceRegistrar } from "./run-resources.js";
import { RunResourceAbandonedError } from "./run-resource-errors.js";

const logger = createRuntimeLogger("external-engine-lifecycle");

/**
 * Post-abort join bound. The engine kill ladders top out at ~5.5s
 * (SIGINT → 1.5s → SIGTERM → 4s → SIGKILL); 10s leaves margin for exit
 * handlers to settle the pending step without ever hanging cancellation.
 */
export const ENGINE_ABORT_JOIN_GRACE_MS = 10_000;

export const superviseExternalEngineTurn = async <T>(args: {
  /** Absent (tests/unwired paths): exact passthrough. */
  supervise: RunResourceRegistrar | undefined;
  engine: "claude-code" | "codex";
  runId: string;
  /** The run's abort signal. */
  signal: AbortSignal | undefined;
  /** The engine turn body. Must observe the signal it is handed. */
  run: (signal: AbortSignal | undefined) => Promise<T>;
  /** Test seam; production uses {@link ENGINE_ABORT_JOIN_GRACE_MS}. */
  abortJoinGraceMs?: number;
}): Promise<T> => {
  if (!args.supervise) {
    return args.run(args.signal);
  }
  const graceMs = args.abortJoinGraceMs ?? ENGINE_ABORT_JOIN_GRACE_MS;
  const label = `external-engine:${args.engine}:${args.runId}`;
  const outer = args.signal;
  // Effect-ratchet pin (1 new AbortController): the relay seam controller —
  // the engine turn body takes a REAL AbortSignal (CLI child kill ladders),
  // and the run supervisor's cooperative abort must fire it independently
  // of the outer run signal.
  const relay = new AbortController();
  const onOuterAbort = () => relay.abort(outer?.reason);
  if (outer?.aborted) {
    relay.abort(outer.reason);
  } else {
    outer?.addEventListener("abort", onOuterAbort);
  }

  const work = (async () => {
    try {
      return await args.run(relay.signal);
    } finally {
      outer?.removeEventListener("abort", onOuterAbort);
    }
  })();

  let settledFlag = false;
  let abandonTimer: ReturnType<typeof setTimeout> | null = null;
  const settled = new Promise<void>((resolve) => {
    const finish = (abandoned: boolean) => {
      if (settledFlag) return;
      settledFlag = true;
      if (abandonTimer) clearTimeout(abandonTimer);
      if (abandoned) {
        logger.warn("external-engine-turn.abandoned", {
          label,
          graceMs,
          error: new RunResourceAbandonedError({ label, graceMs }).message,
        });
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
      // Effect-ratchet pin (1 setTimeout): the post-abort abandonment grace
      // is a deliberately unref'd raw timer — the bounded join must never
      // keep the process alive for an engine turn that outlives its kill
      // ladder; an Effect sleep fiber would hold the event loop.
      abandonTimer = setTimeout(() => finish(true), graceMs);
      abandonTimer.unref?.();
    };
    if (relay.signal.aborted) {
      armAbandonment();
    } else {
      relay.signal.addEventListener("abort", armAbandonment, { once: true });
    }
  });

  args.supervise({
    label,
    abort: (reason) => relay.abort(reason),
    settled,
  });

  return work;
};
