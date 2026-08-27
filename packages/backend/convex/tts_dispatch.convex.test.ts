/// <reference types="vite/client" />

import { convexTest } from "convex-test";
import { describe, expect, it } from "vitest";
import { internal } from "./_generated/api";
import schema from "./schema";
import {
  TTS_DISPATCH_ABORT_GRACE_MS,
  TTS_DISPATCH_HARD_DEADLINE_MS,
  TTS_DISPATCH_HEARTBEAT_LEASE_MS,
} from "./tts_dispatch";

const modules = import.meta.glob("./**/*.ts");
const createTest = () => convexTest(schema, modules);
type TestHarness = ReturnType<typeof createTest>;
const TEST_NOW = Date.now() + 60_000;

const reserve = async (
  t: TestHarness,
  overrides: Partial<{
    ownerId: string;
    ownerGeneration: string;
    dispatchId: string;
    attemptId: string;
    leaseId: string;
    kind:
      | "buffered"
      | "desktop_stream"
      | "hls"
      | "oneshot_inworld"
      | "oneshot_openai";
    now: number;
    usage: {
      provider: "inworld" | "openai";
      model: string;
      voice?: string;
      streaming: boolean;
      requestChars: number;
      textInputTokens?: number;
      audioOutputTokens?: number;
    };
  }> = {},
) =>
  await t.mutation(internal.tts_dispatch.reserveTtsProviderDispatchInternal, {
    ownerId: overrides.ownerId ?? "owner-a",
    ownerGeneration: overrides.ownerGeneration ?? "legacy",
    dispatchId: overrides.dispatchId ?? "dispatch-a",
    attemptId: overrides.attemptId ?? "attempt-a",
    leaseId: overrides.leaseId ?? "lease-a",
    kind: overrides.kind ?? "buffered",
    usage: overrides.usage ?? {
      provider: overrides.kind === "oneshot_openai" ? "openai" : "inworld",
      model:
        overrides.kind === "oneshot_openai"
          ? "gpt-4o-mini-tts"
          : "inworld-tts-1.5-max",
      voice: "voice-a",
      streaming:
        overrides.kind === "desktop_stream" || overrides.kind === "hls",
      requestChars: 400,
      ...(overrides.kind === "oneshot_openai"
        ? { textInputTokens: 100, audioOutputTokens: 200 }
        : {}),
    },
    now: overrides.now ?? TEST_NOW,
  });

const readReceipt = async (
  t: TestHarness,
  dispatchId: string,
  attemptId: string,
) =>
  await t.run(
    async (ctx) =>
      await ctx.db
        .query("internal_tts_usage")
        .withIndex("by_dispatchId_and_attemptId", (q) =>
          q.eq("dispatchId", dispatchId).eq("attemptId", attemptId),
        )
        .unique(),
  );

const beginAndClaimCorePurge = async (
  t: TestHarness,
  ownerId: string,
  mode: "reset" | "delete",
  now = TEST_NOW + 1_000,
) => {
  const purge = await t.mutation(
    internal.owner_lifecycle.beginOwnerDataPurgeInternal,
    {
      ownerId,
      operationId: `${mode}-${ownerId}`,
      mode,
      now,
    },
  );
  const leaseId = `lease-${mode}-${ownerId}`;
  expect(
    await t.mutation(internal.owner_lifecycle.claimOwnerPurgeStageInternal, {
      ownerId,
      operationId: purge.operationId,
      generation: purge.generation,
      stage: "core",
      leaseId,
      now: now + 1,
    }),
  ).toMatchObject({ claimed: true, mode });
  return {
    ownerId,
    operationId: purge.operationId,
    generation: purge.generation,
    leaseId,
    mode,
  };
};

describe("TTS provider dispatch leases", () => {
  it("reserves an exact zero-cost receipt and closes pre-dispatch work idempotently", async () => {
    const t = createTest();
    const first = await reserve(t);
    expect(first).toEqual({
      acquired: true,
      status: "reserved",
      leaseExpiresAt: TEST_NOW + TTS_DISPATCH_HEARTBEAT_LEASE_MS,
      hardExpiresAt: TEST_NOW + TTS_DISPATCH_HARD_DEADLINE_MS,
      quiescentAfterAt:
        TEST_NOW + TTS_DISPATCH_HARD_DEADLINE_MS + TTS_DISPATCH_ABORT_GRACE_MS,
    });
    await expect(reserve(t)).resolves.toEqual({
      ...first,
      acquired: false,
      status: "busy",
    });
    await expect(
      reserve(t, { attemptId: "attempt-b", leaseId: "lease-b" }),
    ).resolves.toEqual({
      ...first,
      acquired: false,
      status: "busy",
    });

    await expect(
      readReceipt(t, "dispatch-a", "attempt-a"),
    ).resolves.toMatchObject({
      ownerId: "owner-a",
      ownerGeneration: "legacy",
      dispatchId: "dispatch-a",
      attemptId: "attempt-a",
      leaseId: "lease-a",
      provider: "inworld",
      status: "failed",
      requestChars: 400,
      synthesizedChars: 0,
      audioBytes: 0,
      costMicroCents: 0,
    });

    await expect(
      t.mutation(internal.tts_dispatch.heartbeatTtsProviderDispatchInternal, {
        ownerId: "owner-a",
        ownerGeneration: "legacy",
        dispatchId: "dispatch-a",
        attemptId: "wrong-attempt",
        leaseId: "lease-a",
        now: TEST_NOW + 1_000,
      }),
    ).resolves.toMatchObject({ found: false, allowed: false });

    const heartbeat = await t.mutation(
      internal.tts_dispatch.heartbeatTtsProviderDispatchInternal,
      {
        ownerId: "owner-a",
        ownerGeneration: "legacy",
        dispatchId: "dispatch-a",
        attemptId: "attempt-a",
        leaseId: "lease-a",
        now: TEST_NOW + 1_000,
      },
    );
    expect(heartbeat).toMatchObject({
      found: true,
      allowed: true,
      cancelRequested: false,
      state: "active",
      hardExpiresAt: first.hardExpiresAt,
    });
    expect(heartbeat.leaseExpiresAt).toBe(
      TEST_NOW + 1_000 + TTS_DISPATCH_HEARTBEAT_LEASE_MS,
    );

    await expect(
      t.mutation(internal.tts_dispatch.settleTtsProviderDispatchInternal, {
        ownerId: "owner-a",
        ownerGeneration: "legacy",
        dispatchId: "dispatch-a",
        attemptId: "attempt-a",
        leaseId: "lease-a",
        outcome: "settled",
        settlement: {
          status: "completed",
          synthesizedChars: 400,
          audioBytes: 1_024,
          durationMs: 100,
        },
        now: TEST_NOW + 1_001,
      }),
    ).rejects.toThrow("must cross the dispatch marker");
    const closeArgs = {
      ownerId: "owner-a",
      ownerGeneration: "legacy",
      dispatchId: "dispatch-a",
      attemptId: "attempt-a",
      leaseId: "lease-a",
      outcome: "not_dispatched" as const,
      now: TEST_NOW + 1_002,
    };
    await expect(
      t.mutation(
        internal.tts_dispatch.settleTtsProviderDispatchInternal,
        closeArgs,
      ),
    ).resolves.toBe(true);
    await expect(
      t.mutation(
        internal.tts_dispatch.settleTtsProviderDispatchInternal,
        closeArgs,
      ),
    ).resolves.toBe(true);
    await expect(
      t.query(
        internal.tts_dispatch.remainingOwnerTtsProviderDispatchesInternal,
        { ownerId: "owner-a" },
      ),
    ).resolves.toEqual([]);
    await expect(
      readReceipt(t, "dispatch-a", "attempt-a"),
    ).resolves.toMatchObject({
      providerDispatchOutcome: "not_dispatched",
      status: "failed",
      synthesizedChars: 0,
      costMicroCents: 0,
    });
  });

  it("atomically marks pessimistic spend and rejects a marker replay behind migration", async () => {
    const t = createTest();
    await reserve(t, {
      ownerId: "migrating-owner",
      dispatchId: "migrating-dispatch",
      attemptId: "migrating-attempt",
      leaseId: "migrating-lease",
      kind: "oneshot_openai",
    });
    const markerArgs = {
      ownerId: "migrating-owner",
      ownerGeneration: "legacy",
      dispatchId: "migrating-dispatch",
      attemptId: "migrating-attempt",
      leaseId: "migrating-lease",
      now: TEST_NOW + 1,
    };
    await expect(
      t.mutation(
        internal.tts_dispatch.markTtsProviderDispatchMayHaveStartedInternal,
        markerArgs,
      ),
    ).resolves.toBe(true);
    await expect(
      readReceipt(t, "migrating-dispatch", "migrating-attempt"),
    ).resolves.toMatchObject({
      providerDispatchOutcome: "may_have_dispatched",
      status: "interrupted",
      requestedTextInputTokens: 100,
      requestedAudioOutputTokens: 200,
      synthesizedChars: 400,
      textInputTokens: 100,
      audioOutputTokens: 200,
    });

    await t.run(async (ctx) => {
      await ctx.db.insert("auth_owner_migrations", {
        fromOwnerId: "migrating-owner",
        toOwnerId: "destination-owner",
        status: "running",
        createdAt: TEST_NOW + 2,
        updatedAt: TEST_NOW + 2,
      });
    });
    await expect(
      t.mutation(
        internal.tts_dispatch.markTtsProviderDispatchMayHaveStartedInternal,
        { ...markerArgs, now: TEST_NOW + 3 },
      ),
    ).rejects.toThrow();

    await expect(
      t.mutation(internal.tts_dispatch.heartbeatTtsProviderDispatchInternal, {
        ...markerArgs,
        now: TEST_NOW + 4,
      }),
    ).resolves.toMatchObject({
      found: true,
      allowed: false,
      state: "cancel_requested",
    });

    const settleArgs = {
      ...markerArgs,
      outcome: "settled" as const,
      settlement: {
        status: "completed" as const,
        synthesizedChars: 400,
        audioBytes: 4_096,
        textInputTokens: 100,
        audioOutputTokens: 180,
        durationMs: 250,
      },
      now: TEST_NOW + 5,
    };
    await expect(
      t.mutation(
        internal.tts_dispatch.settleTtsProviderDispatchInternal,
        settleArgs,
      ),
    ).resolves.toBe(true);
    await expect(
      t.mutation(
        internal.tts_dispatch.settleTtsProviderDispatchInternal,
        settleArgs,
      ),
    ).resolves.toBe(true);
    await expect(
      readReceipt(t, "migrating-dispatch", "migrating-attempt"),
    ).resolves.toMatchObject({
      providerDispatchOutcome: "settled",
      status: "completed",
      audioBytes: 4_096,
      audioOutputTokens: 180,
    });
  });

  it.each(["reset", "delete"] as const)(
    "%s immediately closes reserved rows as definitely not dispatched",
    async (mode) => {
      const t = createTest();
      await reserve(t, {
        ownerId: `${mode}-owner`,
        dispatchId: `${mode}-dispatch`,
        attemptId: `${mode}-attempt`,
        leaseId: `${mode}-lease`,
        kind: "hls",
      });
      const purge = await beginAndClaimCorePurge(t, `${mode}-owner`, mode);
      await expect(
        t.mutation(
          internal.tts_dispatch.cancelOwnerTtsProviderDispatchesInternal,
          { ...purge, now: TEST_NOW + 1_002 },
        ),
      ).resolves.toMatchObject({
        ready: true,
        canceled: 0,
        reaped: 1,
        pending: [],
      });
      await expect(
        readReceipt(t, `${mode}-dispatch`, `${mode}-attempt`),
      ).resolves.toMatchObject({
        providerDispatchOutcome: "not_dispatched",
        costMicroCents: 0,
      });
    },
  );

  it("retains ambiguous cancellation debt until the hard provider deadline and abort grace", async () => {
    const t = createTest();
    const reserved = await reserve(t, {
      ownerId: "crashed-owner",
      dispatchId: "crashed-dispatch",
      attemptId: "crashed-attempt",
      leaseId: "crashed-lease",
      kind: "desktop_stream",
    });
    await t.mutation(
      internal.tts_dispatch.markTtsProviderDispatchMayHaveStartedInternal,
      {
        ownerId: "crashed-owner",
        ownerGeneration: "legacy",
        dispatchId: "crashed-dispatch",
        attemptId: "crashed-attempt",
        leaseId: "crashed-lease",
        now: TEST_NOW + 1,
      },
    );
    const purge = await beginAndClaimCorePurge(t, "crashed-owner", "delete");
    await expect(
      t.mutation(
        internal.tts_dispatch.cancelOwnerTtsProviderDispatchesInternal,
        { ...purge, now: TEST_NOW + 1_002 },
      ),
    ).resolves.toMatchObject({ ready: false, canceled: 1, reaped: 0 });

    await expect(
      t.mutation(
        internal.tts_dispatch.cancelOwnerTtsProviderDispatchesInternal,
        { ...purge, now: reserved.quiescentAfterAt - 1 },
      ),
    ).resolves.toMatchObject({ ready: false, reaped: 0 });
    await expect(
      t.mutation(
        internal.tts_dispatch.cancelOwnerTtsProviderDispatchesInternal,
        { ...purge, now: reserved.quiescentAfterAt },
      ),
    ).resolves.toMatchObject({ ready: true, reaped: 1 });
    await expect(
      t.query(
        internal.tts_dispatch.remainingOwnerTtsProviderDispatchesInternal,
        { ownerId: "crashed-owner" },
      ),
    ).resolves.toEqual([]);
    await expect(
      readReceipt(t, "crashed-dispatch", "crashed-attempt"),
    ).resolves.toMatchObject({
      providerDispatchOutcome: "may_have_dispatched",
      status: "interrupted",
      synthesizedChars: 400,
    });
  });

  it("rejects stale exact authority and blocks new reservations behind a purge fence", async () => {
    const t = createTest();
    await reserve(t, {
      ownerId: "fenced-owner",
      dispatchId: "fenced-dispatch",
      attemptId: "fenced-attempt",
      leaseId: "fenced-lease",
      kind: "oneshot_inworld",
    });
    const purge = await beginAndClaimCorePurge(t, "fenced-owner", "reset");

    await expect(
      t.mutation(
        internal.tts_dispatch.cancelOwnerTtsProviderDispatchesInternal,
        { ...purge, leaseId: "stale-worker", now: TEST_NOW + 1_002 },
      ),
    ).rejects.toThrow();
    await expect(
      t.mutation(
        internal.tts_dispatch.cancelOwnerTtsProviderDispatchesInternal,
        { ...purge, mode: "delete", now: TEST_NOW + 1_002 },
      ),
    ).rejects.toThrow();
    await expect(
      t.query(
        internal.tts_dispatch.remainingOwnerTtsProviderDispatchesInternal,
        { ownerId: "fenced-owner" },
      ),
    ).resolves.toEqual(["tts_provider_dispatch_active"]);
    await expect(
      t.mutation(
        internal.tts_dispatch.markTtsProviderDispatchMayHaveStartedInternal,
        {
          ownerId: "fenced-owner",
          ownerGeneration: "legacy",
          dispatchId: "fenced-dispatch",
          attemptId: "fenced-attempt",
          leaseId: "wrong-lease",
          now: TEST_NOW + 1_003,
        },
      ),
    ).rejects.toThrow("lost exact attempt authority");
    await expect(
      reserve(t, {
        ownerId: "fenced-owner",
        dispatchId: "blocked-dispatch",
        attemptId: "blocked-attempt",
      }),
    ).rejects.toThrow();
  });

  it("preserves ambiguous receipt debt and forbids a marked attempt from becoming zero-cost", async () => {
    const t = createTest();
    await reserve(t, {
      ownerId: "ambiguous-owner",
      dispatchId: "ambiguous-dispatch",
      attemptId: "ambiguous-attempt",
      leaseId: "ambiguous-lease",
      kind: "buffered",
    });
    await expect(
      t.mutation(
        internal.tts_dispatch.markTtsProviderDispatchMayHaveStartedInternal,
        {
          ownerId: "ambiguous-owner",
          ownerGeneration: "legacy",
          dispatchId: "ambiguous-dispatch",
          attemptId: "ambiguous-attempt",
          leaseId: "ambiguous-lease",
          now: TEST_NOW + 1,
        },
      ),
    ).resolves.toBe(true);
    await expect(
      t.mutation(internal.tts_dispatch.settleTtsProviderDispatchInternal, {
        ownerId: "ambiguous-owner",
        ownerGeneration: "legacy",
        dispatchId: "ambiguous-dispatch",
        attemptId: "ambiguous-attempt",
        leaseId: "ambiguous-lease",
        outcome: "not_dispatched",
        now: TEST_NOW + 2,
      }),
    ).rejects.toThrow("cannot become not-dispatched");
    await expect(
      t.mutation(internal.tts_dispatch.abandonTtsProviderDispatchInternal, {
        ownerId: "ambiguous-owner",
        ownerGeneration: "legacy",
        dispatchId: "ambiguous-dispatch",
        attemptId: "ambiguous-attempt",
        leaseId: "ambiguous-lease",
        settlement: {
          status: "partial",
          synthesizedChars: 100,
          audioBytes: 2_048,
          durationMs: 50,
        },
        now: TEST_NOW + 3,
      }),
    ).resolves.toBe(true);
    await expect(
      t.query(
        internal.tts_dispatch.remainingOwnerTtsProviderDispatchesInternal,
        { ownerId: "ambiguous-owner" },
      ),
    ).resolves.toEqual(["tts_provider_dispatch_debt"]);
    await expect(
      readReceipt(t, "ambiguous-dispatch", "ambiguous-attempt"),
    ).resolves.toMatchObject({
      providerDispatchOutcome: "may_have_dispatched",
      status: "partial",
      synthesizedChars: 400,
      audioBytes: 2_048,
    });
  });

  it("serializes stream-to-one-shot fallback under one logical operation id", async () => {
    const t = createTest();
    const dispatchId = "tts-operation:logical-operation-1234";
    const first = await reserve(t, {
      ownerId: "fallback-owner",
      dispatchId,
      attemptId: "hls-attempt",
      leaseId: "hls-lease",
      kind: "hls",
    });
    await t.mutation(
      internal.tts_dispatch.markTtsProviderDispatchMayHaveStartedInternal,
      {
        ownerId: "fallback-owner",
        ownerGeneration: "legacy",
        dispatchId,
        attemptId: "hls-attempt",
        leaseId: "hls-lease",
        now: TEST_NOW + 1,
      },
    );
    await t.mutation(internal.tts_dispatch.abandonTtsProviderDispatchInternal, {
      ownerId: "fallback-owner",
      ownerGeneration: "legacy",
      dispatchId,
      attemptId: "hls-attempt",
      leaseId: "hls-lease",
      now: TEST_NOW + 2,
    });

    await expect(
      reserve(t, {
        ownerId: "fallback-owner",
        dispatchId,
        attemptId: "oneshot-attempt",
        leaseId: "oneshot-lease",
        kind: "oneshot_inworld",
        now: TEST_NOW + 3,
      }),
    ).resolves.toMatchObject({ acquired: false, status: "canceled" });

    const fallback = await reserve(t, {
      ownerId: "fallback-owner",
      dispatchId,
      attemptId: "oneshot-attempt",
      leaseId: "oneshot-lease",
      kind: "oneshot_inworld",
      now: first.quiescentAfterAt,
    });
    expect(fallback).toMatchObject({ acquired: true, status: "reserved" });
    await expect(
      readReceipt(t, dispatchId, "hls-attempt"),
    ).resolves.toMatchObject({
      providerDispatchOutcome: "may_have_dispatched",
    });
    await expect(
      readReceipt(t, dispatchId, "oneshot-attempt"),
    ).resolves.toMatchObject({
      status: "failed",
      costMicroCents: 0,
    });

    await t.mutation(
      internal.tts_dispatch.markTtsProviderDispatchMayHaveStartedInternal,
      {
        ownerId: "fallback-owner",
        ownerGeneration: "legacy",
        dispatchId,
        attemptId: "oneshot-attempt",
        leaseId: "oneshot-lease",
        now: first.quiescentAfterAt + 1,
      },
    );
    await t.mutation(internal.tts_dispatch.settleTtsProviderDispatchInternal, {
      ownerId: "fallback-owner",
      ownerGeneration: "legacy",
      dispatchId,
      attemptId: "oneshot-attempt",
      leaseId: "oneshot-lease",
      outcome: "settled",
      settlement: {
        status: "completed",
        synthesizedChars: 400,
        audioBytes: 4_096,
        durationMs: 100,
      },
      now: first.quiescentAfterAt + 2,
    });
    await expect(
      reserve(t, {
        ownerId: "fallback-owner",
        dispatchId,
        attemptId: "response-loss-retry",
        leaseId: "response-loss-lease",
        kind: "oneshot_openai",
        now: first.quiescentAfterAt + 3,
      }),
    ).resolves.toMatchObject({ acquired: false, status: "completed" });
    await expect(
      reserve(t, {
        ownerId: "other-owner",
        dispatchId,
        attemptId: "other-owner-attempt",
        leaseId: "other-owner-lease",
        kind: "oneshot_openai",
        now: first.quiescentAfterAt + 3,
      }),
    ).resolves.toMatchObject({ acquired: true, status: "reserved" });
  });
});
