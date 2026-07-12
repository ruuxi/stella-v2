/// <reference types="vite/client" />

import { convexTest, type TestConvex } from "convex-test";
import rateLimiterTest from "@convex-dev/rate-limiter/test";
import { describe, expect, it } from "vitest";
import { internal } from "./_generated/api";
import schema from "./schema";
import {
  STELLA_RELAY_CLEANUP_MAX_BYTES,
  STELLA_RELAY_CLEANUP_MAX_DOCS,
  STELLA_RELAY_RESUME_MAX_STREAM_LEASES,
  STELLA_RELAY_RESUME_MAX_GLOBAL_STREAMS,
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
    const body = await response.text();
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
