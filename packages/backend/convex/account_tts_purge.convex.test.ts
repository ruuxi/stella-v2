/// <reference types="vite/client" />

import { convexTest } from "convex-test";
import type { FunctionReference } from "convex/server";
import { describe, expect, it } from "vitest";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";

const modules = import.meta.glob(["./**/*.ts", "./**/*.js"]);
const createTest = () => convexTest(schema, modules);
type TestHarness = ReturnType<typeof createTest>;
type Mode = "reset" | "delete";
type Fence = {
  ownerId: string;
  operationId: string;
  generation: string;
  leaseId: string;
};

const functions = internal as unknown as {
  owner_lifecycle: {
    beginOwnerDataPurgeInternal: FunctionReference<
      "mutation",
      "internal",
      { ownerId: string; operationId: string; mode: Mode; now: number },
      {
        operationId: string;
        generation: string;
        mode: Mode;
        stage: "core" | "cloud" | "complete";
      }
    >;
    claimOwnerPurgeStageInternal: FunctionReference<
      "mutation",
      "internal",
      Omit<Fence, "leaseId"> & {
        stage: "core";
        leaseId: string;
        now: number;
      },
      { claimed: boolean; complete: boolean; mode: Mode }
    >;
  };
  account_tts_purge: {
    purgeOwnerTtsBatchInternal: FunctionReference<
      "mutation",
      "internal",
      Fence & { mode: Mode },
      { progress: boolean; pending: string }
    >;
    purgeOwnerTtsInternal: FunctionReference<
      "action",
      "internal",
      Fence,
      { ready: boolean; pending: string[] }
    >;
    purgeOwnerTtsResetInternal: FunctionReference<
      "action",
      "internal",
      Fence,
      { ready: boolean; pending: string[] }
    >;
  };
  tts_hls: {
    claimHlsSynthesis: FunctionReference<
      "mutation",
      "internal",
      {
        ticket: string;
        ownerId: string;
        ownerGeneration: string;
        attemptId: string;
        nowMs: number;
      },
      null | {
        text: string;
        voice: string;
        model: string;
        speed: number | null;
        conversationId: Id<"conversations"> | null;
        expiresAt: number;
      }
    >;
    appendHlsSegment: FunctionReference<
      "mutation",
      "internal",
      {
        ticket: string;
        ownerId: string;
        ownerGeneration: string;
        attemptId: string;
        seq: number;
        audio: string;
        durationSec: number;
      },
      { accepted: boolean; appended: boolean }
    >;
  };
  tts_stream: {
    readTicket: FunctionReference<
      "mutation",
      "internal",
      {
        ticket: string;
        ownerId: string;
        ownerGeneration: string;
        attemptId: string;
        nowMs: number;
      },
      null | { state: string }
    >;
    failTicketAudio: FunctionReference<
      "mutation",
      "internal",
      {
        ticket: string;
        ownerId: string;
        ownerGeneration: string;
        attemptId: string;
      },
      boolean
    >;
    purgeExpired: FunctionReference<
      "mutation",
      "internal",
      { nowMs?: number; limit?: number; maxBatches?: number },
      number
    >;
  };
};

const beginCorePurge = async (
  t: TestHarness,
  ownerId: string,
  mode: Mode,
): Promise<Fence> => {
  const operationId = `${mode}-${ownerId}`;
  const begun = await t.mutation(
    functions.owner_lifecycle.beginOwnerDataPurgeInternal,
    { ownerId, operationId, mode, now: 10_000 },
  );
  const leaseId = `lease-${ownerId}`;
  const claim = await t.mutation(
    functions.owner_lifecycle.claimOwnerPurgeStageInternal,
    {
      ownerId,
      operationId: begun.operationId,
      generation: begun.generation,
      stage: "core",
      leaseId,
      now: 10_001,
    },
  );
  expect(claim).toMatchObject({ claimed: true, mode });
  return {
    ownerId,
    operationId: begun.operationId,
    generation: begun.generation,
    leaseId,
  };
};

describe("TTS account purge", () => {
  it("rejects a delayed HLS append after the lifecycle fence", async () => {
    const t = createTest();
    const ownerId = "hls-race-owner";
    await t.run(async (ctx) => {
      await ctx.db.insert("tts_stream_tickets", {
        ticket: "race-ticket",
        ownerId,
        ownerGeneration: "legacy",
        text: "private speech",
        voice: "Brooke",
        model: "inworld-tts-2-flash",
        hlsStatus: "synthesizing",
        hlsAttemptId: "attempt-before-delete",
        hlsLeaseExpiresAt: Date.now() + 60_000,
        synthesisTransport: "hls",
        hlsSegments: [],
        hlsDone: false,
        createdAt: 1,
        expiresAt: Date.now() + 60_000,
      });
    });
    const fence = await beginCorePurge(t, ownerId, "delete");
    await expect(
      t.mutation(functions.tts_hls.appendHlsSegment, {
        ticket: "race-ticket",
        ownerId,
        ownerGeneration: "legacy",
        attemptId: "attempt-before-delete",
        seq: 0,
        audio: "cHJpdmF0ZQ==",
        durationSec: 1,
      }),
    ).rejects.toThrow(/account is being deleted/u);
    const segments = await t.run(async (ctx) =>
      ctx.db.query("tts_hls_segments").take(1),
    );
    expect(segments).toEqual([]);

    const purged = await t.action(
      functions.account_tts_purge.purgeOwnerTtsInternal,
      fence,
    );
    expect(purged).toEqual({ ready: true, pending: [] });
  });

  it("uses a ticket-specific eight-row purge bound", async () => {
    const t = createTest();
    const ownerId = "large-ticket-owner";
    await t.run(async (ctx) => {
      for (let index = 0; index < 10; index += 1) {
        await ctx.db.insert("tts_stream_tickets", {
          ticket: `large-${index}`,
          ownerId,
          ownerGeneration: "legacy",
          text: "x",
          voice: "Brooke",
          model: "inworld-tts-2-flash",
          audio: "YQ==",
          createdAt: index,
          expiresAt: 100_000,
        });
      }
    });
    const fence = await beginCorePurge(t, ownerId, "delete");
    await t.mutation(functions.account_tts_purge.purgeOwnerTtsBatchInternal, {
      ...fence,
      mode: "delete",
    });
    const remaining = await t.run(async (ctx) =>
      ctx.db
        .query("tts_stream_tickets")
        .withIndex("by_ownerId_and_createdAt", (q) => q.eq("ownerId", ownerId))
        .take(20),
    );
    expect(remaining).toHaveLength(2);
  });

  it("recovers an expired HLS claim and fences every callback from the old attempt", async () => {
    const t = createTest();
    const ownerId = "hls-recovery-owner";
    const now = Date.now();
    await t.run(async (ctx) => {
      await ctx.db.insert("tts_stream_tickets", {
        ticket: "recovery-ticket",
        ownerId,
        ownerGeneration: "legacy",
        text: "recover me",
        voice: "Brooke",
        model: "inworld-tts-2-flash",
        hlsStatus: "pending",
        hlsSegments: [],
        hlsDone: false,
        createdAt: now,
        expiresAt: now + 15 * 60_000,
      });
    });
    const first = await t.mutation(functions.tts_hls.claimHlsSynthesis, {
      ticket: "recovery-ticket",
      ownerId,
      ownerGeneration: "legacy",
      attemptId: "attempt-one",
      nowMs: now,
    });
    expect(first).not.toBeNull();
    await expect(
      t.mutation(functions.tts_hls.claimHlsSynthesis, {
        ticket: "recovery-ticket",
        ownerId,
        ownerGeneration: "legacy",
        attemptId: "attempt-two",
        nowMs: now + 1,
      }),
    ).resolves.toBeNull();

    const recovered = await t.mutation(functions.tts_hls.claimHlsSynthesis, {
      ticket: "recovery-ticket",
      ownerId,
      ownerGeneration: "legacy",
      attemptId: "attempt-two",
      nowMs: now + 9 * 60_000,
    });
    expect(recovered).not.toBeNull();
    await expect(
      t.mutation(functions.tts_hls.appendHlsSegment, {
        ticket: "recovery-ticket",
        ownerId,
        ownerGeneration: "legacy",
        attemptId: "attempt-one",
        seq: 0,
        audio: "b2xk",
        durationSec: 1,
      }),
    ).resolves.toEqual({ accepted: false, appended: false });
    await expect(
      t.mutation(functions.tts_hls.appendHlsSegment, {
        ticket: "recovery-ticket",
        ownerId,
        ownerGeneration: "legacy",
        attemptId: "attempt-two",
        seq: 0,
        audio: "bmV3",
        durationSec: 1,
      }),
    ).resolves.toEqual({ accepted: true, appended: true });
  });

  it("sweeps large HLS children before parents and keeps per-table read bounds", async () => {
    const t = createTest();
    const expiredAt = Date.now() - 1;
    await t.run(async (ctx) => {
      for (let index = 0; index < 10; index += 1) {
        await ctx.db.insert("tts_stream_tickets", {
          ticket: `expired-${index}`,
          ownerId: "expiry-owner",
          ownerGeneration: "legacy",
          text: "expired",
          voice: "Brooke",
          model: "inworld-tts-2-flash",
          createdAt: index,
          expiresAt: expiredAt,
        });
      }
      for (let index = 0; index < 49; index += 1) {
        await ctx.db.insert("tts_hls_segments", {
          ticket: `expired-${index % 10}`,
          ownerId: "expiry-owner",
          ownerGeneration: "legacy",
          seq: index,
          audio: "YQ==",
          durationSec: 1,
          createdAt: index,
          expiresAt: expiredAt,
        });
      }
    });

    await t.mutation(functions.tts_stream.purgeExpired, {
      nowMs: Date.now(),
      maxBatches: 1,
    });
    let counts = await t.run(async (ctx) => ({
      segments: (await ctx.db.query("tts_hls_segments").take(100)).length,
      tickets: (await ctx.db.query("tts_stream_tickets").take(100)).length,
    }));
    expect(counts).toEqual({ segments: 1, tickets: 10 });

    await t.mutation(functions.tts_stream.purgeExpired, {
      nowMs: Date.now(),
      maxBatches: 1,
    });
    counts = await t.run(async (ctx) => ({
      segments: (await ctx.db.query("tts_hls_segments").take(100)).length,
      tickets: (await ctx.db.query("tts_stream_tickets").take(100)).length,
    }));
    expect(counts).toEqual({ segments: 0, tickets: 2 });
  });

  it("makes a failed buffered claim terminal instead of spending again", async () => {
    const t = createTest();
    const ownerId = "buffer-failure-owner";
    const now = Date.now();
    await t.run(async (ctx) => {
      await ctx.db.insert("tts_stream_tickets", {
        ticket: "failed-buffer",
        ownerId,
        ownerGeneration: "legacy",
        text: "do not retry",
        voice: "Brooke",
        model: "inworld-tts-2-flash",
        bufferStatus: "synthesizing",
        bufferAttemptId: "failed-attempt",
        bufferLeaseExpiresAt: now + 60_000,
        synthesisTransport: "buffered",
        createdAt: now,
        expiresAt: now + 60_000,
      });
    });
    await expect(
      t.mutation(functions.tts_stream.failTicketAudio, {
        ticket: "failed-buffer",
        ownerId,
        ownerGeneration: "legacy",
        attemptId: "failed-attempt",
      }),
    ).resolves.toBe(true);
    await expect(
      t.mutation(functions.tts_stream.readTicket, {
        ticket: "failed-buffer",
        ownerId,
        ownerGeneration: "legacy",
        attemptId: "retry-attempt",
        nowMs: now + 1,
      }),
    ).resolves.toMatchObject({ state: "unavailable" });
  });

  it("reset purges transient TTS rows while preserving spend audit", async () => {
    const t = createTest();
    const ownerId = "reset-tts-owner";
    await t.run(async (ctx) => {
      await ctx.db.insert("tts_stream_tickets", {
        ticket: "reset-ticket",
        ownerId,
        ownerGeneration: "legacy",
        text: "reset me",
        voice: "Brooke",
        model: "inworld-tts-2-flash",
        createdAt: 1,
        expiresAt: 100_000,
      });
      await ctx.db.insert("internal_tts_usage", {
        ownerId,
        ownerGeneration: "legacy",
        provider: "inworld",
        model: "inworld-tts-2-flash",
        voice: "Brooke",
        streaming: false,
        status: "completed",
        requestChars: 8,
        synthesizedChars: 8,
        audioBytes: 10,
        textInputTokens: 2,
        audioOutputTokens: 1,
        costMicroCents: 1,
        durationMs: 1,
        createdAt: 1,
      });
    });
    const fence = await beginCorePurge(t, ownerId, "reset");
    const result = await t.action(
      functions.account_tts_purge.purgeOwnerTtsResetInternal,
      fence,
    );
    expect(result).toEqual({ ready: true, pending: [] });
    const snapshot = await t.run(async (ctx) => ({
      tickets: await ctx.db
        .query("tts_stream_tickets")
        .withIndex("by_ownerId_and_createdAt", (q) => q.eq("ownerId", ownerId))
        .take(1),
      usage: await ctx.db
        .query("internal_tts_usage")
        .withIndex("by_ownerId_and_createdAt", (q) => q.eq("ownerId", ownerId))
        .take(1),
    }));
    expect(snapshot.tickets).toEqual([]);
    expect(snapshot.usage).toHaveLength(1);
  });
});
