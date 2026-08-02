/**
 * Run-owned provider stream lifecycle (M5 surface 3; phase 2 batch 1,
 * upgraded to true Effect Stream delivery in phase 3).
 *
 * Every provider stream a Pi turn opens is registered as a child resource of
 * its run's supervision scope (`kernel/runner/supervision/run-supervisor.ts`):
 *
 * - **True Effect Stream delivery.** The supervised path returns a fresh
 *   `AssistantMessageEventStream` fed by a `Stream.fromAsyncIterable`
 *   pipeline over the provider's stream. Every element is forwarded
 *   untouched in order (byte/order parity), terminal `done`/`error` events
 *   settle `result()` exactly as the provider's own stream would, and
 *   `end` runs exactly once (`ensuring`) — so agent-loop consumption and
 *   backpressure semantics are unchanged while delivery itself is an
 *   interruptible Effect pipeline owned by the run.
 * - **Fiber-derived cancellation, close-once.** The provider receives a
 *   relay `AbortController`'s signal. The run signal forwards into the
 *   relay (same tick, reason preserved) and fiber interruption fires the
 *   same relay — one idempotent transport close, after which the pipeline
 *   drains the provider's terminal and joins cleanup.
 * - **Teardown-before-settlement.** The resource settles only when the
 *   delivery pipeline has finished (terminal forwarded + `end` ran), so
 *   closing the run scope joins actual cleanup, not just the terminal.
 * - **Bounded abandonment.** After the relay aborts, the join is bounded
 *   by a grace (default 5s); an abandoned stream is logged and released
 *   without fabricating a terminal result.
 * - **No leaked listeners.** The run-signal forwarding listener is removed
 *   as soon as the pipeline settles (or is abandoned).
 */

import { Effect, Layer, ManagedRuntime, Stream } from "effect";
import { streamSimple } from "../../ai/stream.js";
import { AssistantMessageEventStream } from "../../ai/utils/event-stream.js";
import type { AssistantMessageEvent } from "../../ai/types.js";
import type { StreamFn } from "../agent-core/types.js";
import { createRuntimeLogger } from "../debug.js";
import type { RunResourceRegistrar } from "./run-resources.js";
import { RunResourceAbandonedError } from "./run-resource-errors.js";

const logger = createRuntimeLogger("provider-stream-lifecycle");

/** Requirements-free runtime for the delivery pipelines (context in closures). */
const deliveryRuntime = ManagedRuntime.make(Layer.empty);

/**
 * How long a cancelled provider stream may keep running before its fiber is
 * released as abandoned. Mirrors the agent-core tool abort grace: after a
 * cooperative abort, a healthy provider terminates almost immediately; one
 * that ignores its signal must not hold run cancellation hostage.
 */
const PROVIDER_STREAM_ABORT_JOIN_GRACE_MS = 5_000;

type StreamOptions = NonNullable<Parameters<StreamFn>[2]>;
type ProviderStream = Awaited<ReturnType<StreamFn>>;

/**
 * Wrap a `StreamFn` so every stream it opens is supervised as a child
 * resource of the owning run and delivered through a run-owned Effect
 * Stream pipeline. The returned function preserves the base function's
 * sync/async shape; the stream handed back settles and iterates exactly
 * like the provider's own (same events, same order, same terminals).
 */
export const createRunScopedStreamFn = (args: {
  /** Registers the stream resource into the owning run's scope. */
  supervise: RunResourceRegistrar;
  /** Run that owns every stream opened through this function. */
  runId: string;
}): StreamFn => {
  const base = streamSimple;
  const graceMs = PROVIDER_STREAM_ABORT_JOIN_GRACE_MS;
  let sequence = 0;

  return (model, context, options) => {
    sequence += 1;
    const label = `provider-stream:${args.runId}:${sequence}`;
    const outer = options?.signal;
    // Effect-ratchet pin (1 new AbortController): the relay seam controller —
    // provider adapters take a REAL AbortSignal, and the run supervisor's
    // cooperative abort must fire it independently of the outer signal.
    const relay = new AbortController();
    const onOuterAbort = () => relay.abort(outer?.reason);
    if (outer?.aborted) {
      relay.abort(outer.reason);
    } else {
      outer?.addEventListener("abort", onOuterAbort);
    }

    const release = () => outer?.removeEventListener("abort", onOuterAbort);

    const superviseStream = (inner: ProviderStream): ProviderStream => {
      // True Effect Stream delivery: forward every provider event, in
      // order and untouched, into the stream the agent loop consumes.
      // Iteration ends when the provider's terminal event lands (the
      // EventStream iterator drains and closes on done/error), so the
      // pipeline promise settles only after terminal + cleanup.
      const out = new AssistantMessageEventStream();
      const delivered = deliveryRuntime.runPromise(
        Stream.fromAsyncIterable(
          inner as AsyncIterable<AssistantMessageEvent>,
          (error) => error,
        ).pipe(
          Stream.runForEach((event) =>
            Effect.sync(() => {
              out.push(event);
            }),
          ),
          // Provider streams encode failures as terminal error events
          // (StreamFn contract); a raw iteration failure here is a defect.
          // Log it — never silently swallow — but still fall through to the
          // terminal `end` below instead of rejecting the supervision join.
          Effect.catch((error) =>
            Effect.sync(() => {
              logger.warn("provider-stream.delivery-defect", {
                label,
                model: model.id,
                error: error instanceof Error ? error.message : String(error),
              });
            }),
          ),
          Effect.ensuring(
            Effect.sync(() => {
              out.end();
            }),
          ),
        ),
      );

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
        delivered.then(
          () => finish(false),
          () => finish(false),
        );
        const armAbandonment = () => {
          if (settledFlag || abandonTimer) return;
          if (!Number.isFinite(graceMs) || graceMs <= 0) return;
          // Effect-ratchet pin (1 setTimeout): the post-abort abandonment
          // grace is a deliberately unref'd raw timer — the bounded join
          // must never keep the process alive for a stream that ignores its
          // abort; an Effect sleep fiber would hold the event loop.
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
      return out;
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
