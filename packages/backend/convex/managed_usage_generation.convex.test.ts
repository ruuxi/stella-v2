/// <reference types="vite/client" />

import { convexTest } from "convex-test";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { internal } from "./_generated/api";
import schema from "./schema";
import { seedReadyPurgeBackupSweep } from "../tests/convex_backup_sweep_test_helpers";

const modules = import.meta.glob("./**/*.ts");
const createTest = () => convexTest(schema, modules);

beforeAll(() => {
  const values: Record<string, string> = {
    STELLA_INCLUDED_USAGE_UTILIZATION_RATE: "0.5",
    STELLA_FREE_ROLLING_LIMIT_USD: "1",
    STELLA_FREE_ROLLING_WINDOW_HOURS: "5",
    STELLA_FREE_WEEKLY_LIMIT_USD: "1",
    STELLA_FREE_MONTHLY_LIMIT_USD: "1",
    STELLA_FREE_LIFETIME_LIMIT_USD: "0.5",
    STELLA_GO_PRICE_CENTS: "1000",
    STELLA_PRO_PRICE_CENTS: "2000",
  };
  for (const [key, value] of Object.entries(values)) process.env[key] = value;
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const reopenOwnerAfterReset = async (
  t: ReturnType<typeof createTest>,
  ownerId: string,
) => {
  const purge = await t.mutation(
    internal.owner_lifecycle.beginOwnerDataPurgeInternal,
    { ownerId, operationId: "reset-operation", mode: "reset", now: 10_000 },
  );
  const coreLeaseId = "core-lease";
  await t.mutation(internal.owner_lifecycle.claimOwnerPurgeStageInternal, {
    ownerId,
    operationId: purge.operationId,
    generation: purge.generation,
    stage: "core",
    leaseId: coreLeaseId,
    now: 10_001,
  });
  await t.mutation(internal.owner_lifecycle.advanceOwnerPurgeStageInternal, {
    ownerId,
    operationId: purge.operationId,
    generation: purge.generation,
    leaseId: coreLeaseId,
    stage: "core",
    nextStage: "cloud",
    now: 10_002,
  });
  const cloudLeaseId = "cloud-lease";
  await t.mutation(internal.owner_lifecycle.claimOwnerPurgeStageInternal, {
    ownerId,
    operationId: purge.operationId,
    generation: purge.generation,
    stage: "cloud",
    leaseId: cloudLeaseId,
    now: 10_003,
  });
  const nextGeneration = "reopened-generation";
  await t.run(async (ctx) => {
    await seedReadyPurgeBackupSweep(ctx, {
      ownerId,
      operationId: purge.operationId,
      generation: purge.generation,
      now: 10_004,
    });
  });
  expect(
    await t.mutation(internal.owner_lifecycle.finishOwnerCloudPurgeInternal, {
      ownerId,
      operationId: purge.operationId,
      generation: purge.generation,
      leaseId: cloudLeaseId,
      nextGeneration,
      now: 10_004,
    }),
  ).toBe(true);
  return nextGeneration;
};

const readUsage = async (t: ReturnType<typeof createTest>, ownerId: string) =>
  await t.run(async (ctx) => {
    const [window, logs, rollups] = await Promise.all([
      ctx.db
        .query("billing_usage_windows")
        .withIndex("by_ownerId", (q) => q.eq("ownerId", ownerId))
        .unique(),
      ctx.db
        .query("usage_logs")
        .withIndex("by_ownerId_and_createdAt", (q) => q.eq("ownerId", ownerId))
        .take(10),
      ctx.db
        .query("usage_rollups")
        .withIndex("by_ownerId_and_bucketStartMs", (q) =>
          q.eq("ownerId", ownerId),
        )
        .take(10),
    ]);
    return { window, logs, rollups };
  });

describe("managed usage generation fencing", () => {
  it("keeps delayed tool audit generation-fenced without exposing an alternate billing writer", async () => {
    const t = createTest();
    const ownerId = "managed-generation-owner";
    const admitted = await t.mutation(
      internal.lib.gate_and_meter.enforceManagedGate,
      { ownerId, order: ["usage"], usage: {} },
    );
    expect(admitted.ok).toBe(true);
    if (!admitted.ok) throw new Error("managed gate unexpectedly denied");
    const staleGeneration = admitted.ownerGeneration;

    const reopenedGeneration = await reopenOwnerAfterReset(t, ownerId);
    expect(reopenedGeneration).not.toBe(staleGeneration);

    const conversationId = await t.run(async (ctx) =>
      ctx.db.insert("conversations", {
        ownerId,
        isDefault: true,
        eventCount: 0,
        createdAt: 20_000,
        updatedAt: 20_000,
      }),
    );
    await expect(
      t.mutation(internal.agent.hooks.logToolExecution, {
        ownerId,
        ownerGeneration: staleGeneration,
        conversationId,
        agentType: "test",
        toolName: "stale-tool",
        durationMs: 1,
        success: true,
      }),
    ).rejects.toThrow(/started before the account data was reset/u);

    expect(await readUsage(t, ownerId)).toMatchObject({
      window: { totalUsageMicroCents: 0 },
      logs: [],
      rollups: [],
    });

    await t.mutation(internal.agent.hooks.logToolExecution, {
      ownerId,
      ownerGeneration: reopenedGeneration,
      conversationId,
      agentType: "test",
      toolName: "current-tool",
      durationMs: 1,
      success: true,
    });

    expect(await readUsage(t, ownerId)).toMatchObject({
      window: { totalUsageMicroCents: 0 },
      logs: [
        {
          ownerId,
          conversationId,
          agentType: "test",
          model: "tool:current-tool",
          durationMs: 1,
          success: true,
        },
      ],
      rollups: [{ toolCallCount: 1, requestCount: 0 }],
    });
  });

  it("rejects a delayed asset enrichment admitted before reset without provider I/O", async () => {
    const t = createTest();
    const ownerId = "asset-metadata-generation-owner";
    const admitted = await t.mutation(
      internal.lib.gate_and_meter.enforceManagedGate,
      { ownerId, order: ["usage"], usage: {} },
    );
    expect(admitted.ok).toBe(true);
    if (!admitted.ok) throw new Error("managed gate unexpectedly denied");
    const packId = await t.run(
      async (ctx) =>
        await ctx.db.insert("emoji_packs", {
          ownerId,
          packId: "stale-metadata-pack",
          displayName: "Stale metadata pack",
          description: "A test pack",
          tags: [],
          coverEmoji: "\u2b50",
          sheetUrls: ["https://assets.invalid/pack.png"],
          visibility: "private",
          searchText: "stale metadata pack",
          installCount: 0,
          createdAt: 1,
          updatedAt: 1,
        }),
    );
    await reopenOwnerAfterReset(t, ownerId);
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(new Error("provider I/O must not run"));

    await expect(
      t.action(internal.data.asset_metadata.enrichEmojiPack, {
        packId,
        ownerId,
        ownerGeneration: admitted.ownerGeneration,
      }),
    ).rejects.toThrow(/started before the account data was reset/u);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("rejects a delayed asset enrichment after source-owner migration fencing", async () => {
    const t = createTest();
    const ownerId = "asset-metadata-migration-source";
    const admitted = await t.mutation(
      internal.lib.gate_and_meter.enforceManagedGate,
      { ownerId, order: ["usage"], usage: {} },
    );
    expect(admitted.ok).toBe(true);
    if (!admitted.ok) throw new Error("managed gate unexpectedly denied");
    const packId = await t.run(async (ctx) => {
      const id = await ctx.db.insert("emoji_packs", {
        ownerId,
        packId: "migration-fenced-metadata-pack",
        displayName: "Migration fenced metadata pack",
        description: "A test pack",
        tags: [],
        coverEmoji: "\u2b50",
        sheetUrls: ["https://assets.invalid/pack.png"],
        visibility: "private",
        searchText: "migration fenced metadata pack",
        installCount: 0,
        createdAt: 1,
        updatedAt: 1,
      });
      await ctx.db.insert("auth_owner_migrations", {
        fromOwnerId: ownerId,
        toOwnerId: "asset-metadata-migration-target",
        status: "pending",
        leaseGeneration: 0,
        fromOwnerGeneration: admitted.ownerGeneration,
        toOwnerGeneration: "legacy",
        planRevision: 1,
        createdAt: 2,
        updatedAt: 2,
      });
      return id;
    });
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(new Error("provider I/O must not run"));

    await expect(
      t.action(internal.data.asset_metadata.enrichEmojiPack, {
        packId,
        ownerId,
        ownerGeneration: admitted.ownerGeneration,
      }),
    ).rejects.toThrow(/linked to an account|ownership_migrated/iu);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("rejects destination-owner provider I/O and metering while migration is active", async () => {
    const t = createTest();
    const sourceOwnerId = "asset-metadata-incoming-source";
    const ownerId = "asset-metadata-incoming-target";
    const admitted = await t.mutation(
      internal.lib.gate_and_meter.enforceManagedGate,
      { ownerId, order: ["usage"], usage: {} },
    );
    expect(admitted.ok).toBe(true);
    if (!admitted.ok) throw new Error("managed gate unexpectedly denied");
    const packId = await t.run(async (ctx) => {
      const id = await ctx.db.insert("emoji_packs", {
        ownerId,
        packId: "incoming-migration-fenced-metadata-pack",
        displayName: "Incoming migration fenced metadata pack",
        description: "A test pack",
        tags: [],
        coverEmoji: "\u2b50",
        sheetUrls: ["https://assets.invalid/pack.png"],
        visibility: "private",
        searchText: "incoming migration fenced metadata pack",
        installCount: 0,
        createdAt: 1,
        updatedAt: 1,
      });
      await ctx.db.insert("auth_owner_migrations", {
        fromOwnerId: sourceOwnerId,
        toOwnerId: ownerId,
        status: "running",
        leaseGeneration: 1,
        fromOwnerGeneration: "legacy",
        toOwnerGeneration: admitted.ownerGeneration,
        planRevision: 1,
        createdAt: 2,
        updatedAt: 2,
      });
      return id;
    });
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(new Error("provider I/O must not run"));

    await expect(
      t.action(internal.data.asset_metadata.enrichEmojiPack, {
        packId,
        ownerId,
        ownerGeneration: admitted.ownerGeneration,
      }),
    ).rejects.toThrow(/migrat|ownership_migrated/iu);
    expect(fetchSpy).not.toHaveBeenCalled();
    await expect(
      t.mutation(internal.billing.logManagedUsage, {
        ownerId,
        ownerGeneration: admitted.ownerGeneration,
        agentType: "asset-metadata",
        model: "openai/gpt-5-mini",
        durationMs: 1,
        success: true,
        costMicroCents: 100,
      }),
    ).rejects.toThrow(/migrat|ownership_migrated/iu);
    expect(await readUsage(t, ownerId)).toMatchObject({
      window: { totalUsageMicroCents: 0 },
      logs: [],
      rollups: [],
    });
  });

  it("does not recapture a migrated asset row under its new owner", async () => {
    const t = createTest();
    const sourceOwnerId = "asset-metadata-source-owner";
    const targetOwnerId = "asset-metadata-target-owner";
    const packId = await t.run(
      async (ctx) =>
        await ctx.db.insert("emoji_packs", {
          ownerId: sourceOwnerId,
          packId: "migrated-metadata-pack",
          displayName: "Migrated metadata pack",
          description: "A test pack",
          tags: [],
          coverEmoji: "\u2b50",
          sheetUrls: ["https://assets.invalid/pack.png"],
          visibility: "private",
          searchText: "migrated metadata pack",
          installCount: 0,
          createdAt: 1,
          updatedAt: 1,
        }),
    );
    await t.run(async (ctx) => {
      await ctx.db.patch(packId, { ownerId: targetOwnerId });
    });
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(new Error("provider I/O must not run"));

    expect(
      await t.action(internal.data.asset_metadata.enrichEmojiPack, {
        packId,
        ownerId: sourceOwnerId,
        ownerGeneration: "legacy",
      }),
    ).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(
      await t.mutation(internal.data.emoji_packs.patchGeneratedMetadata, {
        packId,
        ownerId: sourceOwnerId,
        ownerGeneration: "legacy",
        metadata: {
          displayName: "Stale generated name",
          description: "Stale generated description",
          tags: ["stale"],
          searchText: "stale generated name",
          updatedAt: 2,
        },
      }),
    ).toBeNull();
    expect(
      await t.run(async (ctx) => (await ctx.db.get(packId))?.displayName),
    ).toBe("Migrated metadata pack");
  });
});
