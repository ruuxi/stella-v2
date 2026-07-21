/**
 * Run-owned provider stream lifecycle (M5 surface 3, phase 2 batch 1).
 *
 * Every provider stream a Pi turn opens is registered as a child resource of
 * its run's supervision scope (`kernel/runner/supervision/run-supervisor.ts`),
 * where a dedicated Effect fiber owns its lifecycle:
 *
 * - **Fiber-derived cancellation.** The provider receives a relay
 *   `AbortController`'s signal instead of the run signal directly. The run
 *   signal forwards into the relay (same tick, reason preserved), and
 *   interrupting the stream's fiber (run cancel / runtime shutdown) fires
 *   the same relay — `ai/stream.ts` and the provider adapters stay untouched
 *   behind their existing signal contract.
 * - **Terminal detection & teardown-before-settlement.** The resource's
 *   `settled` promise tracks the stream's terminal event
 *   (`AssistantMessageEventStream.result()`), so closing the run scope joins
 *   the stream until the provider's own `done`/`error` terminal has landed —
 *   the outcome the caller observes is always the provider's truthful one.
 * - **Bounded abandonment.** A provider that ignores its abort signal would
 *   otherwise hold run cancellation forever. After the relay aborts, the
 *   join is bounded by an abandonment grace (default 5s, mirroring the
 *   agent-core tool abort grace); an abandoned stream is logged and released
 *   without fabricating a terminal result.
 * - **No leaked listeners.** The run-signal forwarding listener is removed
 *   as soon as the stream settles (or is abandoned).
 *
 * Consumption/backpressure semantics stay in `agent-core/agent-loop.ts`
 * (WRAP, don't rewrite): the loop iterates the same stream object the
 * provider produced; this module owns lifecycle, not event delivery.
 */

import { streamSimple } from "../../ai/stream.js";
import type { StreamFn } from "../agent-core/types.js";
import { createRuntimeLogger } from "../debug.js";
import type { RunResourceRegistrar } from "./run-resources.js";
import { RunResourceAbandonedError } from "./run-resource-errors.js";

const logger = createRuntimeLogger("provider-stream-lifecycle");

/**
 * How long a cancelled provider stream may keep running before its fiber is
 * released as abandoned. Mirrors the agent-core tool abort grace: after a
 * cooperative abort, a healthy provider terminates almost immediately; one
 * that ignores its signal must not hold run cancellation hostage.
 */
export const PROVIDER_STREAM_ABORT_JOIN_GRACE_MS = 5_000;

type StreamOptions = NonNullable<Parameters<StreamFn>[2]>;
type ProviderStream = Awaited<ReturnType<StreamFn>>;

/**
 * Wrap a `StreamFn` so every stream it opens is supervised as a child
 * resource of the owning run. The returned function preserves the base
 * function's sync/async shape and returns the provider's stream object
 * unchanged, so agent-loop consumption is byte-for-byte identical.
 */
export const createRunScopedStreamFn = (args: {
  /** Underlying provider entry. Defaults to `ai/stream.ts#streamSimple`. */
  base?: StreamFn;
  /** Registers the stream resource into the owning run's scope. */
  supervise: RunResourceRegistrar;
  /** Run that owns every stream opened through this function. */
  runId: string;
  /** Test seam; production uses {@link PROVIDER_STREAM_ABORT_JOIN_GRACE_MS}. */
  abortJoinGraceMs?: number;
}): StreamFn => {
  const base = args.base ?? streamSimple;
  const graceMs = args.abortJoinGraceMs ?? PROVIDER_STREAM_ABORT_JOIN_GRACE_MS;
  let sequence = 0;

  return (model, context, options) => {
    sequence += 1;
    const label = `provider-stream:${args.runId}:${sequence}`;
    const outer = options?.signal;
    const relay = new AbortController();
    const onOuterAbort = () => relay.abort(outer?.reason);
    if (outer?.aborted) {
      relay.abort(outer.reason);
    } else {
      outer?.addEventListener("abort", onOuterAbort);
    }

    const release = () => outer?.removeEventListener("abort", onOuterAbort);

    const superviseStream = (inner: ProviderStream): ProviderStream => {
      let settledFlag = false;
      let abandonTimer: ReturnType<typeof setTimeout> | null = null;
      const settled = new Promise<void>((resolve) => {
        const finish = (abandoned: boolean) => {
          if (settledFlag) return;
          settledFlag = true;
          if (abandonTimer) clearTimeout(abandonTimer);
          release();
          if (abandoned) {
            logger.warn("provider-stream.abandoned", {
              label,
              graceMs,
              model: model.id,
              error: new RunResourceAbandonedError({ label, graceMs }).message,
            });
          }
          resolve();
        };
        inner.result().then(
          () => finish(false),
          () => finish(false),
        );
        const armAbandonment = () => {
          if (settledFlag || abandonTimer) return;
          if (!Number.isFinite(graceMs) || graceMs <= 0) return;
          abandonTimer = setTimeout(() => finish(true), graceMs);
          abandonTimer.unref?.();
        };
        if (relay.signal.aborted) {
          armAbandonment();
        } else {
          relay.signal.addEventListener("abort", armAbandonment, {
            once: true,
          });
        }
      });
      args.supervise({
        label,
        abort: (reason) => relay.abort(reason),
        settled,
      });
      return inner;
    };

    const relayOptions = {
      ...(options ?? {}),
      signal: relay.signal,
    } as StreamOptions;

    let produced: ReturnType<StreamFn>;
    try {
      produced = base(model, context, relayOptions);
    } catch (error) {
      // Synchronous provider-entry failure: nothing started, nothing to
      // supervise. Propagate untouched (agent-loop's catch owns it).
      release();
      throw error;
    }
    if (produced instanceof Promise) {
      return produced.then(superviseStream, (error) => {
        release();
        throw error;
      });
    }
    return superviseStream(produced);
  };
};
