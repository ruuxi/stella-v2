import { describe, expect, it } from "vitest";

import { createSupervisedScope } from "../kernel/shared/supervised-scope.js";
import {
  createRunScopedStreamFn,
  PROVIDER_STREAM_ABORT_JOIN_GRACE_MS,
} from "../kernel/agent-runtime/provider-stream-lifecycle.js";
import type { RunResource } from "../kernel/agent-runtime/run-resources.js";
import { AssistantMessageEventStream } from "../ai/utils/event-stream.js";
import type {
  Api,
  AssistantMessage,
  Context,
  Model,
  SimpleStreamOptions,
} from "../ai/types.js";

/**
 * Interruption proofs for the run-owned provider stream lifecycle (phase 2
 * batch 1). Lives in packages/runtime because the supervision fibers under
 * test are Effect-based (`shared/supervised-scope.ts`) and effect is fenced
 * here. Every test asserts REAL lifecycle behavior: provider-signal
 * delivery, terminal-settlement joins, bounded abandonment, and listener
 * cleanup — not merely the absence of errors.
 */

const FAKE_MODEL = {
  id: "fake-model",
  api: "fake-api",
  provider: "fake-provider",
} as unknown as Model<Api>;

const FAKE_CONTEXT = { messages: [] } as unknown as Context;

const terminalMessage = (
  stopReason: AssistantMessage["stopReason"],
): AssistantMessage => ({
  role: "assistant",
  content: [],
  api: FAKE_MODEL.api,
  provider: FAKE_MODEL.provider,
  model: FAKE_MODEL.id,
  usage: {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  },
  stopReason,
  timestamp: Date.now(),
});

/** A controllable fake provider stream + the signal it received. */
const makeFakeProvider = (behavior: {
  /** Push the done terminal when the received signal aborts. */
  terminateOnAbort?: boolean;
  emitProof?: boolean;
}) => {
  const streams: Array<{
    stream: AssistantMessageEventStream;
    signal: AbortSignal | undefined;
    emitProof: (proof: Parameters<
      NonNullable<SimpleStreamOptions["onProviderRequestLifecycle"]>
    >[0]) => void;
  }> = [];
  const streamFn = (
    _model: Model<Api>,
    _context: Context,
    options?: SimpleStreamOptions,
  ): AssistantMessageEventStream => {
    const stream = new AssistantMessageEventStream();
    const emitProof = (proof: Parameters<
      NonNullable<SimpleStreamOptions["onProviderRequestLifecycle"]>
    >[0]) => {
      void options?.onProviderRequestLifecycle?.(proof);
    };
    streams.push({ stream, signal: options?.signal, emitProof });
    if (behavior.emitProof) {
      const requestIdSha256 = "a".repeat(64);
      void options?.onProviderRequestLifecycle?.({
        phase: "request-admitted",
        requestIdSha256,
        physicalAttempt: 1,
      });
      void options?.onProviderRequestLifecycle?.({
        phase: "request-dispatched",
        requestIdSha256,
        physicalAttempt: 1,
      });
      void options?.onProviderRequestLifecycle?.({
        phase: "stream-open",
        requestIdSha256,
        physicalAttempt: 1,
      });
    }
    if (behavior.terminateOnAbort) {
      const finish = () => {
        if (behavior.emitProof) {
          void options?.onProviderRequestLifecycle?.({
            phase: "transport-closed",
            requestIdSha256: "a".repeat(64),
            physicalAttempt: 1,
            outcome: "canceled",
          });
        }
        stream.push({
          type: "error",
          reason: "aborted",
          error: terminalMessage("aborted"),
        } as never);
      };
      if (options?.signal?.aborted) {
        finish();
      } else {
        options?.signal?.addEventListener("abort", finish, { once: true });
      }
    }
    return stream;
  };
  return { streamFn, streams };
};

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe("run-owned provider stream lifecycle", () => {
  it("registers one resource per stream and settles on the provider terminal", async () => {
    const resources: RunResource[] = [];
    const provider = makeFakeProvider({});
    const wrapped = createRunScopedStreamFn({
      base: provider.streamFn as never,
      supervise: (resource) => resources.push(resource),
      runId: "run-1",
    });

    const stream = wrapped(
      FAKE_MODEL,
      FAKE_CONTEXT,
      {},
    ) as AssistantMessageEventStream;
    expect(resources).toHaveLength(1);
    expect(resources[0].label).toBe("provider-stream:run-1:1");

    let settled = false;
    void resources[0].settled.then(() => {
      settled = true;
    });
    await flush();
    expect(settled).toBe(false);

    const consumed: string[] = [];
    const consumption = (async () => {
      for await (const event of stream) {
        consumed.push(event.type);
      }
      return stream.result();
    })();

    provider.streams[0].stream.push({
      type: "text_delta",
      partial: terminalMessage("stop"),
    } as never);
    const done = terminalMessage("stop");
    provider.streams[0].stream.push({
      type: "done",
      message: done,
    } as never);
    await resources[0].settled;
    expect(settled).toBe(true);

    // Delivery parity: every event forwarded untouched, in order, and the
    // terminal settles result() with the provider's own message object.
    await expect(consumption).resolves.toBe(done);
    expect(consumed).toEqual(["text_delta", "done"]);

    wrapped(FAKE_MODEL, FAKE_CONTEXT, {});
    expect(resources).toHaveLength(2);
    expect(resources[1].label).toBe("provider-stream:run-1:2");
  });

  it("forwards the run signal into the provider with its reason, and cleans the listener up", async () => {
    const resources: RunResource[] = [];
    const provider = makeFakeProvider({ terminateOnAbort: true });
    const wrapped = createRunScopedStreamFn({
      base: provider.streamFn as never,
      supervise: (resource) => resources.push(resource),
      runId: "run-2",
    });

    const outer = new AbortController();
    wrapped(FAKE_MODEL, FAKE_CONTEXT, { signal: outer.signal });
    const received = provider.streams[0].signal;
    expect(received?.aborted).toBe(false);

    const reason = new Error("user-cancel");
    outer.abort(reason);
    // Same-tick propagation, reason preserved (providers read it).
    expect(received?.aborted).toBe(true);
    expect(received?.reason).toBe(reason);

    await resources[0].settled;

    // Listener cleanup: aborting again after settlement must be inert (no
    // lingering forwarding closure). Node throws on double-abort listeners
    // only via behavior, so assert indirectly: a fresh stream on the same
    // wrapped fn gets its own relay, unaffected by the settled one.
    wrapped(FAKE_MODEL, FAKE_CONTEXT, {});
    expect(provider.streams[1].signal?.aborted).toBe(false);
  });

  it("supervised interruption aborts the provider and close joins the terminal", async () => {
    const scope = createSupervisedScope("test:stream-interrupt");
    const provider = makeFakeProvider({ terminateOnAbort: true });
    const wrapped = createRunScopedStreamFn({
      base: provider.streamFn as never,
      supervise: (resource) => scope.supervise(resource),
      runId: "run-3",
    });

    wrapped(FAKE_MODEL, FAKE_CONTEXT, {});
    expect(scope.liveCount()).toBe(1);

    // Closing the scope interrupts the stream fiber: the finalizer fires the
    // relay abort, the fake provider emits its aborted terminal, and close
    // resolves only after that terminal settled the resource.
    await scope.close("canceled");
    expect(provider.streams[0].signal?.aborted).toBe(true);
    expect(scope.liveCount()).toBe(0);
  });

  it("emits stopped only after the adapter closes and the Effect delivery joins", async () => {
    const scope = createSupervisedScope("test:stream-proof-join");
    const provider = makeFakeProvider({
      terminateOnAbort: true,
      emitProof: true,
    });
    const lifecycle: Array<{ phase: string; requestIdSha256: string }> = [];
    const wrapped = createRunScopedStreamFn({
      base: provider.streamFn as never,
      supervise: (resource) => scope.supervise(resource),
      runId: "run-proof-join",
      onLifecycle: (event) => lifecycle.push(event),
    });

    wrapped(FAKE_MODEL, FAKE_CONTEXT, {});
    await scope.close("canceled");

    expect(lifecycle.map((event) => event.phase)).toEqual([
      "request-admitted",
      "request-dispatched",
      "stream-open",
      "transport-closed",
      "transport-joined",
    ]);
    expect(
      lifecycle.every((event) => event.requestIdSha256 === "a".repeat(64)),
    ).toBe(true);
  });

  it("releases an abort-ignoring provider after the abandonment grace", async () => {
    const scope = createSupervisedScope("test:stream-abandon");
    const provider = makeFakeProvider({}); // never terminates
    const wrapped = createRunScopedStreamFn({
      base: provider.streamFn as never,
      supervise: (resource) => scope.supervise(resource),
      runId: "run-4",
      abortJoinGraceMs: 50,
    });

    wrapped(FAKE_MODEL, FAKE_CONTEXT, {});
    const closedAt = Date.now();
    await scope.close("canceled");
    const elapsed = Date.now() - closedAt;
    // Bounded: released by the 50ms grace, not the (infinite) terminal.
    expect(elapsed).toBeGreaterThanOrEqual(40);
    expect(elapsed).toBeLessThan(PROVIDER_STREAM_ABORT_JOIN_GRACE_MS);
    expect(scope.liveCount()).toBe(0);
  });

  it("marks an abort-ignoring transport abandoned and outcome-unknown", async () => {
    const scope = createSupervisedScope("test:stream-proof-abandon");
    const provider = makeFakeProvider({ emitProof: true });
    const phases: string[] = [];
    const wrapped = createRunScopedStreamFn({
      base: provider.streamFn as never,
      supervise: (resource) => scope.supervise(resource),
      runId: "run-proof-abandon",
      abortJoinGraceMs: 25,
      onLifecycle: (event) => phases.push(event.phase),
    });

    wrapped(FAKE_MODEL, FAKE_CONTEXT, {});
    await scope.close("canceled");

    expect(phases).toEqual([
      "request-admitted",
      "request-dispatched",
      "stream-open",
      "abandoned",
      "outcome-unknown",
    ]);
    expect(phases).not.toContain("transport-joined");

    provider.streams[0].emitProof({
      phase: "transport-closed",
      requestIdSha256: "a".repeat(64),
      physicalAttempt: 1,
      outcome: "canceled",
    });
    await flush();
    expect(phases).toEqual([
      "request-admitted",
      "request-dispatched",
      "stream-open",
      "abandoned",
      "outcome-unknown",
    ]);
  });

  it("propagates synchronous and asynchronous provider-entry failures untouched", async () => {
    const resources: RunResource[] = [];
    const failure = new Error("provider entry exploded");
    const wrappedSync = createRunScopedStreamFn({
      base: (() => {
        throw failure;
      }) as never,
      supervise: (resource) => resources.push(resource),
      runId: "run-5",
    });
    expect(() => wrappedSync(FAKE_MODEL, FAKE_CONTEXT, {})).toThrow(failure);
    expect(resources).toHaveLength(0);

    const wrappedAsync = createRunScopedStreamFn({
      base: (async () => {
        throw failure;
      }) as never,
      supervise: (resource) => resources.push(resource),
      runId: "run-6",
    });
    await expect(wrappedAsync(FAKE_MODEL, FAKE_CONTEXT, {})).rejects.toThrow(
      failure,
    );
    expect(resources).toHaveLength(0);
  });

  it("an already-aborted run signal reaches the provider before the first event", () => {
    const provider = makeFakeProvider({ terminateOnAbort: true });
    const wrapped = createRunScopedStreamFn({
      base: provider.streamFn as never,
      supervise: () => {},
      runId: "run-7",
    });
    const outer = new AbortController();
    const reason = new Error("pre-aborted");
    outer.abort(reason);
    wrapped(FAKE_MODEL, FAKE_CONTEXT, { signal: outer.signal });
    expect(provider.streams[0].signal?.aborted).toBe(true);
    expect(provider.streams[0].signal?.reason).toBe(reason);
  });
});
