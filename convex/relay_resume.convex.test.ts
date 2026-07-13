/// <reference types="vite/client" />

import { convexTest, type TestConvex } from "convex-test";
import rateLimiterTest from "@convex-dev/rate-limiter/test";
import { describe, expect, it, vi } from "vitest";
import { internal } from "./_generated/api";
import schema from "./schema";
import {
  STELLA_RELAY_CLEANUP_MAX_BYTES,
  STELLA_RELAY_CLEANUP_MAX_DOCS,
  STELLA_RELAY_CLEANUP_MAX_INTENT_DOCS,
  STELLA_RELAY_RESUME_MAX_STREAM_LEASES,
  STELLA_RELAY_RESUME_MAX_GLOBAL_STREAMS,
  STELLA_RELAY_RESUME_MAX_OWNER_INTENTS,
  STELLA_RELAY_RESUME_MAX_OWNER_STREAMS,
  STELLA_RELAY_RESUME_QUERY_MAX_CHUNKS,
} from "./stella_provider/relay_resume";

const modules = import.meta.glob("./**/*.ts");
const ownerA = "https://issuer.test|owner-a";
const ownerB = "https://issuer.test|owner-b";
const createTest = () => {
  const t = convexTest(schema, modules);
  rateLimiterTest.register(t);
  return t;
};

const reserve = async (
  t: TestConvex<typeof schema>,
  relayRequestId: string,
  ownerId = ownerA,
  nowMs = Date.now(),
) =>
  await t.mutation(
    internal.stella_provider.relay_resume_store.reserveRelayResumeStream,
    {
      relayRequestId,
      ownerId,
      provider: "openai",
      model: "openai/gpt-test",
      nowMs,
    },
  );

const asIdentity = (t: TestConvex<typeof schema>, subject: string) =>
  t.withIdentity({
    issuer: "https://issuer.test",
    subject,
    tokenIdentifier: `https://issuer.test|${subject}`,
  });

const insertLiveStream = async (
  t: TestConvex<typeof schema>,
  args: {
    relayRequestId: string;
    ownerId?: string;
    expiresInMs: number;
    frames: string[];
  },
) => {
  const nowMs = Date.now();
  await t.run(async (ctx) => {
    const storedBytes = args.frames.reduce(
      (sum, frame) => sum + new TextEncoder().encode(frame).byteLength,
      0,
    );
    await ctx.db.insert("stella_relay_response_streams", {
      relayRequestId: args.relayRequestId,
      ownerId: args.ownerId ?? ownerA,
      provider: "openai",
      model: "openai/gpt-test",
      status: "streaming",
      lastSequence: args.frames.length,
      eventCount: args.frames.length,
      storedBytes,
      nextChunkIndex: 1,
      createdAt: nowMs,
      updatedAt: nowMs,
      expiresAt: nowMs + args.expiresInMs,
      hardExpiresAt: nowMs + 10 * 60 * 1000,
    });
    await ctx.db.insert("stella_relay_response_chunks", {
      relayRequestId: args.relayRequestId,
      chunkIndex: 0,
      firstSequence: 1,
      lastSequence: args.frames.length,
      events: args.frames.map((frame, index) => ({
        sequence: index + 1,
        frame,
      })),
      storedBytes,
      createdAt: nowMs,
      hardExpiresAt: nowMs + 10 * 60 * 1000,
    });
  });
};

// The relay resume body is strictly demand-driven (highWaterMark 0), so its
// pull callbacks execute Convex syscalls when the test reads it. Drive reads
// inside `t.run` to give them an active convex-test AsyncLocalStorage
// context; the production Convex runtime keeps syscalls isolate-global.
const readSseFrames = async (
  t: TestConvex<typeof schema>,
  body: ReadableStream<Uint8Array>,
  onFrame?: (frame: string, index: number) => Promise<void> | void,
): Promise<string[]> =>
  await t.run(async () => {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    const frames: string[] = [];
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const frame = decoder.decode(value);
      frames.push(frame);
      await onFrame?.(frame, frames.length - 1);
    }
    return frames;
  });

const cancelBody = async (
  t: TestConvex<typeof schema>,
  response: Response,
): Promise<void> => {
  await t.run(async () => {
    await response.body!.cancel();
  });
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const waitFor = async (predicate: () => boolean | Promise<boolean>) => {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (await predicate()) return;
    await sleep(10);
  }
  throw new Error("Timed out waiting for relay test state");
};

const ensureBillingTestEnv = () => {
  const values: Record<string, string> = {
    STELLA_INCLUDED_USAGE_UTILIZATION_RATE: "0.5",
    STELLA_FREE_ROLLING_LIMIT_USD: "10",
    STELLA_FREE_ROLLING_WINDOW_HOURS: "5",
    STELLA_FREE_WEEKLY_LIMIT_USD: "20",
    STELLA_FREE_MONTHLY_LIMIT_USD: "30",
    STELLA_GO_PRICE_CENTS: "1000",
    STELLA_PRO_PRICE_CENTS: "2000",
    STELLA_PLUS_PRICE_CENTS: "3000",
    STELLA_ULTRA_PRICE_CENTS: "4000",
    STELLA_MAX_PRICE_CENTS: "5000",
    OPENAI_API_KEY: "test-openai-key",
    FIREWORKS_API_KEY: "test-fireworks-key",
    OPENROUTER_API_KEY: "test-openrouter-key",
    ANTHROPIC_API_KEY: "test-anthropic-key",
    GOOGLE_AI_API_KEY: "test-google-key",
    META_MODEL_API_KEY: "test-meta-key",
  };
  for (const [key, value] of Object.entries(values)) {
    process.env[key] ??= value;
  }
};

const relayPost = (
  relayRequestId?: string,
  signal?: AbortSignal,
  idempotencyKey = "stella-response-test-idempotency-key",
): RequestInit => ({
  method: "POST",
  headers: {
    "content-type": "application/json",
    "idempotency-key": idempotencyKey,
    "x-stella-agent-type": "synthesis",
    ...(relayRequestId
      ? { "x-stella-relay-request-id": relayRequestId }
      : {}),
  },
  body: JSON.stringify({
    model: "stella/openai/gpt-5.6-luna",
    input: "hello",
    stream: true,
    store: false,
  }),
  ...(signal ? { signal } : {}),
});

const event = (
  sequence: number,
  type = "response.output_text.delta",
  payload = "x",
) => ({
  sequence,
  eventType: type,
  frame: `data: ${JSON.stringify({
    type,
    delta: payload,
    stella_relay_sequence: sequence,
  })}\n\n`,
  ...(type === "response.completed"
    ? {
        terminalStatus: "completed" as const,
        responseStatus: "completed",
        responseId: "resp-test",
      }
    : {}),
});

describe("relay resume Convex persistence and HTTP actions", () => {
  it("allows stable idempotency keys through the registered POST preflight", async () => {
    const t = createTest();
    const response = await t.fetch(
      "/api/stella/relay/openai/v1/responses",
      {
        method: "OPTIONS",
        headers: {
          origin: "http://localhost:57314",
          "access-control-request-method": "POST",
          "access-control-request-headers":
            "authorization,content-type,idempotency-key",
        },
      },
    );
    expect(response.status).toBe(204);
    expect(response.headers.get("Access-Control-Allow-Headers")).toContain(
      "Idempotency-Key",
    );
  });

  it("dispatches the registered POST route through the authentication adapter", async () => {
    const t = createTest();
    ensureBillingTestEnv();
    const fetchMock = vi.spyOn(globalThis, "fetch");
    try {
      const response = await t.fetch(
        "/api/stella/relay/openai/v1/responses",
        relayPost("stella-relay-unauthenticated-route"),
      );
      expect(response.status).toBe(401);
      expect(await response.text()).toContain("Unauthorized");
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      fetchMock.mockRestore();
    }
  });

  it("runs one POST upstream, persists before forwarding, and resumes through GET", async () => {
    const t = createTest();
    ensureBillingTestEnv();
    const relayRequestId = "stella-relay-e2e-persist-resume";
    const upstreamBodies: string[] = [];
    const originalApiKey = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = "test-openai-key";
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (_input, init) => {
        upstreamBodies.push(String(init?.body ?? ""));
        return new Response(
          [
            event(1, "response.created"),
            event(2, "response.output_text.delta", "durable"),
            event(3, "response.completed"),
          ]
            .map((item) => item.frame)
            .join("") + "data: [DONE]\n\n",
          {
            status: 200,
            headers: {
              "content-type": "text/event-stream",
              "x-request-id": "upstream-e2e-1",
            },
          },
        );
      });

    try {
      const asOwner = asIdentity(t, "owner-a");
      const post = await asOwner.fetch(
        "/api/stella/relay/openai/v1/responses",
        relayPost(relayRequestId),
      );
      expect(post.status).toBe(200);
      expect(post.headers.get("x-stella-relay-resume")).toBe("1");
      expect(post.headers.get("x-stella-relay-request-id")).toBe(
        relayRequestId,
      );

      await waitFor(async () => {
        const page = await t.query(
          internal.stella_provider.relay_resume_store.getRelayResumePage,
          { relayRequestId, startingAfter: 0 },
        );
        return page?.lastSequence === 3;
      });
      const reader = post.body!.getReader();
      const first = await reader.read();
      expect(first.done).toBe(false);
      const firstFrame = new TextDecoder().decode(first.value);
      await reader.cancel();
      expect(firstFrame).toContain("response.created");

      // The upstream chunk is one persistence batch. Seeing its first frame
      // downstream therefore proves all three events committed before the
      // first enqueue, including the content that the interrupted POST did
      // not consume.
      const persisted = await t.query(
        internal.stella_provider.relay_resume_store.getRelayResumePage,
        { relayRequestId, startingAfter: 0 },
      );
      expect(persisted?.events.map((stored) => stored.sequence)).toEqual([
        1, 2, 3,
      ]);

      const resumed = await asOwner.fetch(
        `/api/stella/relay/responses/${relayRequestId}?starting_after=1`,
      );
      expect(resumed.status).toBe(200);
      const resumedBody = (await readSseFrames(t, resumed.body!)).join("");
      expect(resumedBody).not.toContain("response.created");
      expect(resumedBody).toContain("durable");
      expect(resumedBody).toContain("response.completed");
      expect(resumedBody).toContain("data: [DONE]");
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(JSON.parse(upstreamBodies[0]!)).toMatchObject({ store: false });
    } finally {
      fetchMock.mockRestore();
      if (originalApiKey === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = originalApiKey;
    }
  });

  it("deduplicates an old-client repeated POST through the registered route", async () => {
    const t = createTest();
    ensureBillingTestEnv();
    const idempotencyKey = "stella-response-old-client-reconnect";
    let upstreamExecutions = 0;
    let upstreamController:
      | ReadableStreamDefaultController<Uint8Array>
      | undefined;
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async () => {
        upstreamExecutions += 1;
        return new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              upstreamController = controller;
            },
          }),
          {
            status: 200,
            headers: { "content-type": "text/event-stream" },
          },
        );
      });

    try {
      const asOwner = asIdentity(t, "owner-a");
      const first = await asOwner.fetch(
        "/api/stella/relay/openai/v1/responses",
        relayPost(undefined, undefined, idempotencyKey),
      );
      expect(first.status).toBe(200);
      const assignedRelayId = first.headers.get("x-stella-relay-request-id");
      expect(assignedRelayId).toMatch(/^stella-relay-[a-f0-9]{64}$/u);
      expect(first.headers.get("x-stella-relay-resume")).toBe("1");

      // Simulate the old client losing the POST body before event one. The
      // relay continues persisting upstream even though this body is closed.
      await first.body!.cancel();

      // Retry immediately, while the first upstream execution has not emitted
      // an event. The stable key must hit the existing reservation.
      const repeated = await asOwner.fetch(
        "/api/stella/relay/openai/v1/responses",
        relayPost(undefined, undefined, idempotencyKey),
      );
      expect(repeated.status).toBe(200);
      expect(repeated.headers.get("x-stella-relay-request-id")).toBe(
        assignedRelayId,
      );
      expect(upstreamExecutions).toBe(1);

      const wire =
        [
          event(1, "response.created"),
          event(2, "response.output_text.delta", "old-client-durable"),
          event(3, "response.completed"),
        ]
          .map((item) => item.frame)
          .join("") + "data: [DONE]\n\n";
      upstreamController!.enqueue(new TextEncoder().encode(wire));
      upstreamController!.close();
      await waitFor(async () => {
        const page = await t.query(
          internal.stella_provider.relay_resume_store.getRelayResumePage,
          { relayRequestId: assignedRelayId!, startingAfter: 0 },
        );
        return page?.lastSequence === 3;
      });

      const replay = (await readSseFrames(t, repeated.body!)).join("");
      expect(replay).toContain("old-client-durable");
      expect(replay).toContain("response.completed");
      expect(upstreamExecutions).toBe(1);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    } finally {
      fetchMock.mockRestore();
    }
  });

  it("rejects an eligible stream without either stable request identity before upstream", async () => {
    const t = createTest();
    ensureBillingTestEnv();
    const fetchMock = vi.spyOn(globalThis, "fetch");
    try {
      const response = await asIdentity(t, "owner-a").fetch(
        "/api/stella/relay/openai/v1/responses",
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-stella-agent-type": "synthesis",
          },
          body: JSON.stringify({
            model: "stella/openai/gpt-5.6-luna",
            input: "hello",
            stream: true,
            store: false,
          }),
        },
      );
      expect(response.status).toBe(400);
      expect(await response.text()).toContain("Idempotency-Key");
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      fetchMock.mockRestore();
    }
  });

  it("lets DELETE win a live POST reservation without a second upstream execution", async () => {
    const t = createTest();
    ensureBillingTestEnv();
    const relayRequestId = "stella-relay-e2e-cancel-race";
    const originalApiKey = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = "test-openai-key";
    let upstreamExecutions = 0;
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (_input, init) => {
        upstreamExecutions += 1;
        return await new Promise<Response>((_resolve, reject) => {
          const signal = init?.signal;
          const abort = () =>
            reject(
              signal?.reason instanceof Error
                ? signal.reason
                : new Error("upstream aborted"),
            );
          if (signal?.aborted) abort();
          else signal?.addEventListener("abort", abort, { once: true });
        });
      });

    try {
      const asOwner = asIdentity(t, "owner-a");
      const postPromise = asOwner.fetch(
        "/api/stella/relay/openai/v1/responses",
        relayPost(relayRequestId),
      );
      await waitFor(async () => {
        const status = await t.query(
          internal.stella_provider.relay_resume_store.getRelayResumeStatus,
          { relayRequestId, ownerId: ownerA },
        );
        return status === "streaming" && upstreamExecutions === 1;
      });

      const canceled = await asOwner.fetch(
        `/api/stella/relay/responses/${relayRequestId}`,
        { method: "DELETE" },
      );
      expect(canceled.status).toBe(204);
      const post = await postPromise;
      expect(post.status).toBe(499);
      expect(upstreamExecutions).toBe(1);
      expect(
        await t.query(
          internal.stella_provider.relay_resume_store.getRelayResumeStatus,
          { relayRequestId, ownerId: ownerA },
        ),
      ).toBe("canceled");
    } finally {
      fetchMock.mockRestore();
      if (originalApiKey === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = originalApiKey;
    }
  });

  it("reserves a client cancellation identity idempotently before upstream work", async () => {
    const t = createTest();
    expect(await reserve(t, "stella-relay-preheader-test")).toBe("reserved");
    expect(await reserve(t, "stella-relay-preheader-test")).toBe("existing");
    const quota = await t.run(
      async (ctx) =>
        await ctx.db
          .query("stella_relay_response_quotas")
          .withIndex("by_scopeKey", (q) => q.eq("scopeKey", "global"))
          .unique(),
    );
    expect(quota).toMatchObject({ streamCount: 1, storedBytes: 0 });

    const canceled = await t.mutation(
      internal.stella_provider.relay_resume_store.cancelRelayResumeStream,
      {
        relayRequestId: "stella-relay-preheader-test",
        ownerId: ownerA,
        nowMs: Date.now(),
      },
    );
    expect(canceled).toBe("canceled");
  });

  it("persists an authenticated pre-reservation abort and prevents upstream allocation", async () => {
    const t = createTest();
    const canceled = await t.mutation(
      internal.stella_provider.relay_resume_store.cancelRelayResumeStream,
      {
        relayRequestId: "stella-relay-delete-won-race",
        ownerId: ownerA,
        nowMs: 1_000,
      },
    );
    expect(canceled).toBe("canceled");
    expect(
      await reserve(t, "stella-relay-delete-won-race", ownerA, 1_001),
    ).toBe("canceled");
    expect(
      await reserve(t, "stella-relay-delete-won-race", ownerB, 1_001),
    ).toBe("conflict");

    const streams = await t.run(
      async (ctx) =>
        await ctx.db.query("stella_relay_response_streams").collect(),
    );
    expect(streams).toEqual([]);
  });

  it("enforces global and per-owner stream quotas before allocation", async () => {
    const ownerLimited = createTest();
    await ownerLimited.run(async (ctx) => {
      await ctx.db.insert("stella_relay_response_quotas", {
        scopeKey: `owner:${ownerA}`,
        streamCount: STELLA_RELAY_RESUME_MAX_OWNER_STREAMS,
        storedBytes: 0,
        updatedAt: Date.now(),
      });
    });
    expect(await reserve(ownerLimited, "stella-relay-owner-quota")).toBe(
      "owner_quota",
    );

    const globallyLimited = createTest();
    await globallyLimited.run(async (ctx) => {
      await ctx.db.insert("stella_relay_response_quotas", {
        scopeKey: "global",
        streamCount: STELLA_RELAY_RESUME_MAX_GLOBAL_STREAMS,
        storedBytes: 0,
        updatedAt: Date.now(),
      });
    });
    expect(await reserve(globallyLimited, "stella-relay-global-quota")).toBe(
      "global_quota",
    );
  });

  it("authenticates terminal replay and hides streams from another owner", async () => {
    const t = createTest();
    await reserve(t, "stella-relay-http-test");
    await t.mutation(
      internal.stella_provider.relay_resume_store.appendRelayResumeEvents,
      {
        relayRequestId: "stella-relay-http-test",
        events: [event(1, "response.completed")],
        nowMs: Date.now(),
      },
    );

    const asOwner = t.withIdentity({
      issuer: "https://issuer.test",
      subject: "owner-a",
      tokenIdentifier: ownerA,
    });
    const response = await asOwner.fetch(
      "/api/stella/relay/responses/stella-relay-http-test?starting_after=0",
    );
    expect(response.status).toBe(200);
    const body = (await readSseFrames(t, response.body!)).join("");
    expect(body).toContain('"type":"response.completed"');
    expect(body).toContain("data: [DONE]");

    const asOtherOwner = t.withIdentity({
      issuer: "https://issuer.test",
      subject: "owner-b",
      tokenIdentifier: ownerB,
    });
    const denied = await asOtherOwner.fetch(
      "/api/stella/relay/responses/stella-relay-http-test?starting_after=0",
    );
    expect(denied.status).toBe(404);
  });

  it("serializes competing appends without accepting duplicate sequences", async () => {
    const t = createTest();
    await reserve(t, "stella-relay-race-test");
    const append = () =>
      t.mutation(
        internal.stella_provider.relay_resume_store.appendRelayResumeEvents,
        {
          relayRequestId: "stella-relay-race-test",
          events: [event(1)],
          nowMs: Date.now(),
        },
      );
    const results = await Promise.allSettled([append(), append()]);
    expect(
      results.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    expect(
      results.filter((result) => result.status === "rejected"),
    ).toHaveLength(1);

    const page = await t.query(
      internal.stella_provider.relay_resume_store.getRelayResumePage,
      { relayRequestId: "stella-relay-race-test", startingAfter: 0 },
    );
    expect(page?.events.map((stored) => stored.sequence)).toEqual([1]);
  });

  it("bounds page reads and concurrent leases", async () => {
    const t = createTest();
    await reserve(t, "stella-relay-resource-test");
    await t.mutation(
      internal.stella_provider.relay_resume_store.appendRelayResumeEvents,
      {
        relayRequestId: "stella-relay-resource-test",
        events: Array.from({ length: 6 }, (_, index) =>
          event(index + 1, "response.output_text.delta", "x".repeat(40_000)),
        ),
        nowMs: Date.now(),
      },
    );
    const page = await t.query(
      internal.stella_provider.relay_resume_store.getRelayResumePage,
      { relayRequestId: "stella-relay-resource-test", startingAfter: 0 },
    );
    expect(page?.chunksRead).toBe(STELLA_RELAY_RESUME_QUERY_MAX_CHUNKS);
    expect(page?.bytesRead).toBeLessThanOrEqual(128 * 1024);
    expect(page?.hasMore).toBe(true);

    const leaseResults = [];
    for (
      let index = 0;
      index < STELLA_RELAY_RESUME_MAX_STREAM_LEASES + 1;
      index += 1
    ) {
      leaseResults.push(
        await t.mutation(
          internal.stella_provider.relay_resume_store.acquireRelayResumeLease,
          {
            leaseId: `lease-${index}`,
            relayRequestId: "stella-relay-resource-test",
            ownerId: ownerA,
            startingAfter: 0,
            nowMs: Date.now(),
          },
        ),
      );
    }
    expect(
      leaseResults.slice(0, STELLA_RELAY_RESUME_MAX_STREAM_LEASES),
    ).toEqual(Array(STELLA_RELAY_RESUME_MAX_STREAM_LEASES).fill("acquired"));
    expect(leaseResults[leaseResults.length - 1]).toBe("stream_limit");
  });

  it("drains expired volume in document and byte bounded batches", async () => {
    const t = createTest();
    await reserve(t, "stella-relay-cleanup-test", ownerA, 0);
    await t.mutation(
      internal.stella_provider.relay_resume_store.appendRelayResumeEvents,
      {
        relayRequestId: "stella-relay-cleanup-test",
        events: Array.from({ length: 8 }, (_, index) =>
          event(index + 1, "response.output_text.delta", "x".repeat(40_000)),
        ),
        nowMs: 1,
      },
    );

    let batches = 0;
    while (batches < 50) {
      const result = await t.mutation(
        internal.stella_provider.relay_resume_store.cleanupRelayResumeBatch,
        { nowMs: 1_000_000 },
      );
      expect(result.deletedDocuments).toBeLessThanOrEqual(
        STELLA_RELAY_CLEANUP_MAX_DOCS,
      );
      expect(result.deletedBytes).toBeLessThanOrEqual(
        STELLA_RELAY_CLEANUP_MAX_BYTES,
      );
      batches += 1;
      if (!result.hasMore) break;
    }

    const state = await t.run(async (ctx) => ({
      streams: await ctx.db.query("stella_relay_response_streams").take(1),
      chunks: await ctx.db.query("stella_relay_response_chunks").take(1),
      quota: await ctx.db
        .query("stella_relay_response_quotas")
        .withIndex("by_scopeKey", (q) => q.eq("scopeKey", "global"))
        .unique(),
      cleanup: await ctx.db
        .query("stella_relay_resume_cleanup_state")
        .withIndex("by_key", (q) => q.eq("key", "relay-resume"))
        .unique(),
    }));
    expect(state.streams).toEqual([]);
    expect(state.chunks).toEqual([]);
    expect(state.quota).toMatchObject({ streamCount: 0, storedBytes: 0 });
    expect(state.cleanup).toMatchObject({
      consecutiveFailures: 0,
      lastObservedLagMs: expect.any(Number),
    });
    expect(batches).toBeGreaterThan(1);
  });
});

describe("relay resume delivery gating and abuse bounds", () => {
  it("stops delivering buffered plaintext to a slow consumer at logical expiry", async () => {
    const t = createTest();
    const frames = [1, 2, 3].map(
      (sequence) =>
        `data: ${JSON.stringify({
          type: "response.output_text.delta",
          delta: `secret-${sequence}`,
          stella_relay_sequence: sequence,
        })}\n\n`,
    );
    await insertLiveStream(t, {
      relayRequestId: "stella-relay-slow-consumer",
      expiresInMs: 350,
      frames,
    });

    const response = await asIdentity(t, "owner-a").fetch(
      "/api/stella/relay/responses/stella-relay-slow-consumer?starting_after=0",
    );
    expect(response.status).toBe(200);
    const delivered = await readSseFrames(
      t,
      response.body!,
      async (_, index) => {
        // Stall after the first frame until logical expiry has passed; the
        // remaining buffered plaintext must become undeliverable.
        if (index === 0) await sleep(500);
      },
    );

    expect(delivered[0]).toContain("secret-1");
    const plaintext = delivered.filter((frame) => frame.includes("secret-"));
    expect(plaintext).toHaveLength(1);
    expect(delivered.join("")).toContain("relay_stream_lost");
    expect(delivered.join("")).toContain(
      "The Stella relay resume cursor expired",
    );
    expect(delivered[delivered.length - 1]).toBe("data: [DONE]\n\n");
  });

  it("revalidates the lease before every buffered frame delivery", async () => {
    const t = createTest();
    await insertLiveStream(t, {
      relayRequestId: "stella-relay-frame-lease-gate",
      expiresInMs: 60_000,
      frames: ["lease-secret-1", "lease-secret-2"].map(
        (delta, index) =>
          `data: ${JSON.stringify({
            type: "response.output_text.delta",
            delta,
            stella_relay_sequence: index + 1,
          })}\n\n`,
      ),
    });
    const response = await asIdentity(t, "owner-a").fetch(
      "/api/stella/relay/responses/stella-relay-frame-lease-gate?starting_after=0",
    );
    const reader = response.body!.getReader();
    const firstFrame = await t.run(async () => {
      const first = await reader.read();
      return new TextDecoder().decode(first.value);
    });
    expect(firstFrame).toContain("lease-secret-1");

    await t.run(async (ctx) => {
      const [lease] = await ctx.db
        .query("stella_relay_response_leases")
        .withIndex("by_relayRequestId_and_expiresAt", (q) =>
          q.eq("relayRequestId", "stella-relay-frame-lease-gate"),
        )
        .take(1);
      expect(lease).toBeTruthy();
      await ctx.db.delete(lease!._id);
    });

    const remainder = await t.run(async () => {
      const frames: string[] = [];
      for (;;) {
        const read = await reader.read();
        if (read.done) break;
        frames.push(new TextDecoder().decode(read.value));
      }
      return frames.join("");
    });
    expect(remainder).not.toContain("lease-secret-2");
    expect(remainder).toContain("relay_stream_lost");
  });

  it("counts open consumers against the concurrency caps until they close", async () => {
    const t = createTest();
    await insertLiveStream(t, {
      relayRequestId: "stella-relay-open-consumers",
      expiresInMs: 60_000,
      frames: [
        `data: ${JSON.stringify({
          type: "response.output_text.delta",
          delta: "x",
          stella_relay_sequence: 1,
        })}\n\n`,
      ],
    });

    const asOwner = asIdentity(t, "owner-a");
    const url =
      "/api/stella/relay/responses/stella-relay-open-consumers?starting_after=0";
    const open: Response[] = [];
    for (
      let index = 0;
      index < STELLA_RELAY_RESUME_MAX_STREAM_LEASES;
      index += 1
    ) {
      const response = await asOwner.fetch(url);
      expect(response.status).toBe(200);
      open.push(response);
    }
    const rejected = await asOwner.fetch(url);
    expect(rejected.status).toBe(429);

    // Closing a consumer releases its lease and frees a slot.
    await cancelBody(t, open[0]!);
    const afterClose = await asOwner.fetch(url);
    expect(afterClose.status).toBe(200);
    await cancelBody(t, afterClose);
    await cancelBody(t, open[1]!);
  });

  it("keeps backpressured open consumers leased between reader pulls", async () => {
    vi.useFakeTimers();
    try {
      const t = createTest();
      await insertLiveStream(t, {
        relayRequestId: "stella-relay-backpressured-consumers",
        expiresInMs: 60_000,
        frames: [event(1).frame],
      });
      const asOwner = asIdentity(t, "owner-a");
      const url =
        "/api/stella/relay/responses/stella-relay-backpressured-consumers?starting_after=0";
      const open = await Promise.all(
        Array.from({ length: STELLA_RELAY_RESUME_MAX_STREAM_LEASES }, () =>
          asOwner.fetch(url),
        ),
      );
      expect(open.map((response) => response.status)).toEqual([200, 200]);

      // No body is read. Advance beyond the original 15-second lease TTL;
      // the independent five-second heartbeat must keep both slots occupied.
      await vi.advanceTimersByTimeAsync(16_000);
      const rejected = await asOwner.fetch(url);
      expect(rejected.status).toBe(429);

      await Promise.all(open.map((response) => cancelBody(t, response)));
    } finally {
      vi.useRealTimers();
    }
  });

  it("bounds cancellation tombstones with per-owner quotas and DELETE rate limits", async () => {
    const t = createTest();
    await t.run(async (ctx) => {
      await ctx.db.insert("stella_relay_response_quotas", {
        scopeKey: `intents:owner:${ownerA}`,
        streamCount: STELLA_RELAY_RESUME_MAX_OWNER_INTENTS,
        storedBytes: 0,
        updatedAt: Date.now(),
      });
    });
    expect(
      await t.mutation(
        internal.stella_provider.relay_resume_store.cancelRelayResumeStream,
        {
          relayRequestId: "stella-relay-quota-bypass",
          ownerId: ownerA,
          nowMs: Date.now(),
        },
      ),
    ).toBe("intent_quota");
    const denied = await asIdentity(t, "owner-a").fetch(
      "/api/stella/relay/responses/stella-relay-quota-bypass",
      { method: "DELETE" },
    );
    expect(denied.status).toBe(429);
    expect(denied.headers.get("Retry-After")).toBeTruthy();

    // Another owner is unaffected by owner A's quota, accounted, and 204s.
    const other = await asIdentity(t, "owner-b").fetch(
      "/api/stella/relay/responses/stella-relay-owner-b-ok",
      { method: "DELETE" },
    );
    expect(other.status).toBe(204);
    const ownerBCount = await t.run(
      async (ctx) =>
        await ctx.db
          .query("stella_relay_response_quotas")
          .withIndex("by_scopeKey", (q) =>
            q.eq("scopeKey", `intents:owner:${ownerB}`),
          )
          .unique(),
    );
    expect(ownerBCount).toMatchObject({ streamCount: 1 });

    // The DELETE handler itself is rate limited before any tombstone write.
    const fresh = createTest();
    const asFreshOwner = asIdentity(fresh, "owner-a");
    let limited: Response | undefined;
    for (let index = 0; index < 40; index += 1) {
      const response = await asFreshOwner.fetch(
        `/api/stella/relay/responses/stella-relay-rate-${String(index).padStart(4, "0")}`,
        { method: "DELETE" },
      );
      if (response.status === 429) {
        limited = response;
        break;
      }
      expect(response.status).toBe(204);
    }
    expect(limited?.status).toBe(429);
    const tombstones = await fresh.run(
      async (ctx) =>
        await ctx.db.query("stella_relay_cancellation_intents").collect(),
    );
    expect(tombstones.length).toBeLessThan(40);
  });

  it("gates reservation, appends, and resume during an owner purge and converges", async () => {
    const t = createTest();
    await reserve(t, "stella-relay-purge-victim");
    await t.mutation(
      internal.stella_provider.relay_resume_store.appendRelayResumeEvents,
      {
        relayRequestId: "stella-relay-purge-victim",
        events: [event(1), event(2)],
        nowMs: Date.now(),
      },
    );

    await t.mutation(
      internal.stella_provider.relay_resume_store.beginOwnerRelayResumePurge,
      { ownerId: ownerA, nowMs: Date.now() },
    );

    // Creation-after-purge regression: reservation is refused while the
    // purge gate is open, before and after the drain reaches zero rows.
    expect(await reserve(t, "stella-relay-purge-created-after")).toBe(
      "owner_purged",
    );
    // Active relay work is rejected so the drain converges.
    expect(
      await t.mutation(
        internal.stella_provider.relay_resume_store.appendRelayResumeEvents,
        {
          relayRequestId: "stella-relay-purge-victim",
          events: [event(3)],
          nowMs: Date.now(),
        },
      ),
    ).toEqual({ accepted: false, status: "canceled" });
    expect(
      await t.mutation(
        internal.stella_provider.relay_resume_store.acquireRelayResumeLease,
        {
          leaseId: "purge-lease",
          relayRequestId: "stella-relay-purge-victim",
          ownerId: ownerA,
          startingAfter: 0,
          nowMs: Date.now(),
        },
      ),
    ).toBe("not_found");
    const resumeDenied = await asIdentity(t, "owner-a").fetch(
      "/api/stella/relay/responses/stella-relay-purge-victim?starting_after=0",
    );
    expect(resumeDenied.status).toBe(404);
    // Cancellations stop persisting tombstones for a purging owner.
    expect(
      await t.mutation(
        internal.stella_provider.relay_resume_store.cancelRelayResumeStream,
        {
          relayRequestId: "stella-relay-purge-tombstone",
          ownerId: ownerA,
          nowMs: Date.now(),
        },
      ),
    ).toBe("canceled");

    const drain = async () => {
      for (let batch = 0; batch < 50; batch += 1) {
        const result = await t.mutation(
          internal.stella_provider.relay_resume_store
            .deleteOwnerRelayResumeBatch,
          { ownerId: ownerA, nowMs: Date.now() },
        );
        if (!result.hasMore) return;
      }
      throw new Error("owner purge drain did not converge");
    };
    await drain();
    await drain();

    const rows = await t.run(async (ctx) => ({
      streams: await ctx.db.query("stella_relay_response_streams").collect(),
      chunks: await ctx.db.query("stella_relay_response_chunks").collect(),
      intents: await ctx.db
        .query("stella_relay_cancellation_intents")
        .collect(),
      leases: await ctx.db.query("stella_relay_response_leases").collect(),
    }));
    expect(rows.streams).toEqual([]);
    expect(rows.chunks).toEqual([]);
    expect(rows.intents).toEqual([]);
    expect(rows.leases).toEqual([]);

    expect(await reserve(t, "stella-relay-post-purge")).toBe("owner_purged");
    await t.mutation(
      internal.stella_provider.relay_resume_store.finishOwnerRelayResumePurge,
      { ownerId: ownerA },
    );
    expect(await reserve(t, "stella-relay-post-purge")).toBe("reserved");
  });

  it("opens the account-deletion gate before its drain and leaves no creation-after-purge race", async () => {
    const t = createTest();
    await insertLiveStream(t, {
      relayRequestId: "stella-relay-account-delete-victim",
      expiresInMs: 60_000,
      frames: [event(1).frame],
    });
    // Force the real account-deletion action through enough bounded drain
    // transactions that the test can race a reservation against its gate.
    await t.run(async (ctx) => {
      const nowMs = Date.now();
      for (let index = 1; index <= 400; index += 1) {
        await ctx.db.insert("stella_relay_response_chunks", {
          relayRequestId: "stella-relay-account-delete-victim",
          chunkIndex: index,
          firstSequence: index + 1,
          lastSequence: index + 1,
          events: [],
          storedBytes: 0,
          createdAt: nowMs,
          hardExpiresAt: nowMs + 10 * 60 * 1000,
        });
      }
    });

    const purge = t.action(internal.account_deletion.purgeOwnerCloudData, {
      ownerId: ownerA,
    });
    await waitFor(
      async () =>
        await t.run(async (ctx) =>
          Boolean(
            await ctx.db
              .query("stella_relay_owner_purges")
              .withIndex("by_ownerId", (q) => q.eq("ownerId", ownerA))
              .unique(),
          ),
        ),
    );
    expect(await reserve(t, "stella-relay-account-delete-racer")).toBe(
      "owner_purged",
    );
    await purge;

    const rows = await t.run(async (ctx) => ({
      streams: await ctx.db.query("stella_relay_response_streams").take(1),
      chunks: await ctx.db.query("stella_relay_response_chunks").take(1),
      gate: await ctx.db
        .query("stella_relay_owner_purges")
        .withIndex("by_ownerId", (q) => q.eq("ownerId", ownerA))
        .unique(),
    }));
    expect(rows.streams).toEqual([]);
    expect(rows.chunks).toEqual([]);
    expect(rows.gate).not.toBeNull();
    expect(await reserve(t, "stella-relay-after-account-delete")).toBe(
      "owner_purged",
    );
  });

  it("keeps sweeping streams under a cancellation tombstone backlog", async () => {
    const t = createTest();
    await t.run(async (ctx) => {
      for (let index = 0; index < 40; index += 1) {
        await ctx.db.insert("stella_relay_cancellation_intents", {
          relayRequestId: `stella-relay-backlog-${String(index).padStart(4, "0")}`,
          ownerId: ownerA,
          createdAt: 0,
          expiresAt: 1,
        });
      }
      await ctx.db.insert("stella_relay_owner_purges", {
        ownerId: ownerB,
        createdAt: 0,
        expiresAt: 1,
      });
    });
    await reserve(t, "stella-relay-fair-sweep", ownerA, 0);
    await t.mutation(
      internal.stella_provider.relay_resume_store.appendRelayResumeEvents,
      {
        relayRequestId: "stella-relay-fair-sweep",
        events: [event(1, "response.output_text.delta", "x".repeat(20_000))],
        nowMs: 1,
      },
    );

    const first = await t.mutation(
      internal.stella_provider.relay_resume_store.cleanupRelayResumeBatch,
      { nowMs: 1_000_000 },
    );
    // Fairness: the intent backlog cannot starve stream/chunk deletion.
    expect(first.deletedDocuments).toBeLessThanOrEqual(
      STELLA_RELAY_CLEANUP_MAX_DOCS,
    );
    expect(first.deletedBytes).toBeGreaterThan(0);

    for (let batch = 0; batch < 50; batch += 1) {
      const result = await t.mutation(
        internal.stella_provider.relay_resume_store.cleanupRelayResumeBatch,
        { nowMs: 1_000_000 },
      );
      if (!result.hasMore) break;
    }
    const rows = await t.run(async (ctx) => ({
      intents: await ctx.db
        .query("stella_relay_cancellation_intents")
        .collect(),
      streams: await ctx.db.query("stella_relay_response_streams").collect(),
      chunks: await ctx.db.query("stella_relay_response_chunks").collect(),
      purges: await ctx.db.query("stella_relay_owner_purges").collect(),
    }));
    expect(rows.intents).toEqual([]);
    expect(rows.streams).toEqual([]);
    expect(rows.chunks).toEqual([]);
    expect(rows.purges).toEqual([]);
    expect(STELLA_RELAY_CLEANUP_MAX_INTENT_DOCS).toBeLessThan(
      STELLA_RELAY_CLEANUP_MAX_DOCS,
    );
  });
});
