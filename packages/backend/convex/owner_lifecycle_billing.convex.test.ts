/// <reference types="vite/client" />

import { convexTest } from "convex-test";
import type { FunctionReference } from "convex/server";
import { beforeAll, describe, expect, it } from "vitest";
import { internal } from "./_generated/api";
import schema from "./schema";
import { seedReadyPurgeBackupSweep } from "../tests/convex_backup_sweep_test_helpers";

const modules = import.meta.glob("./**/*.ts");
const createTest = () => convexTest(schema, modules);
type TestHarness = ReturnType<typeof createTest>;

type PurgeMode = "reset" | "delete";
type PurgeStage = "core" | "cloud" | "complete";
type PurgeIdentity = {
  operationId: string;
  generation: string;
  mode: PurgeMode;
  stage: PurgeStage;
};

const lifecycleInternal = (
  internal as unknown as {
    owner_lifecycle: {
      getOwnerDataAccessStateInternal: FunctionReference<
        "query",
        "internal",
        { ownerId: string },
        {
          allowed: boolean;
          state: "open" | "resetting" | "deleting";
          generation: string;
        }
      >;
      assertOwnerDataDispatchAllowedInternal: FunctionReference<
        "mutation",
        "internal",
        { ownerId: string; ownerGeneration: string },
        null
      >;
      beginOwnerDataPurgeInternal: FunctionReference<
        "mutation",
        "internal",
        {
          ownerId: string;
          operationId: string;
          mode: PurgeMode;
          now: number;
        },
        PurgeIdentity
      >;
      claimOwnerPurgeStageInternal: FunctionReference<
        "mutation",
        "internal",
        {
          ownerId: string;
          operationId: string;
          generation: string;
          stage: PurgeStage;
          leaseId: string;
          now: number;
        },
        { claimed: boolean; complete: boolean; mode: PurgeMode }
      >;
      advanceOwnerPurgeStageInternal: FunctionReference<
        "mutation",
        "internal",
        {
          ownerId: string;
          operationId: string;
          generation: string;
          leaseId: string;
          stage: PurgeStage;
          nextStage: PurgeStage;
          now: number;
        },
        boolean
      >;
      assertOwnerPurgeLeaseInternal: FunctionReference<
        "mutation",
        "internal",
        {
          ownerId: string;
          operationId: string;
          generation: string;
          stage: PurgeStage;
          leaseId: string;
          mode: PurgeMode;
        },
        null
      >;
      scheduleOwnerPurgeRetryInternal: FunctionReference<
        "mutation",
        "internal",
        {
          ownerId: string;
          operationId: string;
          generation: string;
          stage: PurgeStage;
          leaseId: string;
          error: string;
          retryAfterMs?: number;
          now: number;
        },
        boolean
      >;
      finishOwnerCloudPurgeInternal: FunctionReference<
        "mutation",
        "internal",
        {
          ownerId: string;
          operationId: string;
          generation: string;
          leaseId: string;
          nextGeneration: string;
          now: number;
        },
        boolean
      >;
      getOwnerPurgeJobInternal: FunctionReference<
        "query",
        "internal",
        { ownerId: string; operationId?: string },
        null | {
          operationId: string;
          generation: string;
          mode: PurgeMode;
          stage: PurgeStage;
          attempts: number;
          nextRetryAt: number;
          leaseId?: string;
          leaseExpiresAt?: number;
        }
      >;
    };
  }
).owner_lifecycle;

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

const billingSnapshot = async (t: TestHarness, ownerId: string) =>
  await t.run(async (ctx) => {
    const [profiles, windows, credits, logs] = await Promise.all([
      ctx.db
        .query("billing_profiles")
        .withIndex("by_ownerId", (q) => q.eq("ownerId", ownerId))
        .take(10),
      ctx.db
        .query("billing_usage_windows")
        .withIndex("by_ownerId", (q) => q.eq("ownerId", ownerId))
        .take(10),
      ctx.db
        .query("billing_usage_credits")
        .withIndex("by_ownerId", (q) => q.eq("ownerId", ownerId))
        .take(10),
      ctx.db
        .query("usage_logs")
        .withIndex("by_ownerId_and_createdAt", (q) => q.eq("ownerId", ownerId))
        .take(10),
    ]);
    return {
      profiles: profiles.length,
      windows: windows.length,
      credits: credits.length,
      logs: logs.length,
      totalRequestCount: windows[0]?.totalRequestCount ?? 0,
    };
  });

const drainBillingRows = async (t: TestHarness, ownerId: string) => {
  await t.run(async (ctx) => {
    const [profiles, windows, credits, logs] = await Promise.all([
      ctx.db
        .query("billing_profiles")
        .withIndex("by_ownerId", (q) => q.eq("ownerId", ownerId))
        .take(10),
      ctx.db
        .query("billing_usage_windows")
        .withIndex("by_ownerId", (q) => q.eq("ownerId", ownerId))
        .take(10),
      ctx.db
        .query("billing_usage_credits")
        .withIndex("by_ownerId", (q) => q.eq("ownerId", ownerId))
        .take(10),
      ctx.db
        .query("usage_logs")
        .withIndex("by_ownerId_and_createdAt", (q) => q.eq("ownerId", ownerId))
        .take(10),
    ]);
    for (const row of [...profiles, ...windows, ...credits, ...logs]) {
      await ctx.db.delete(row._id);
    }
  });
};

const beginPurge = async (
  t: TestHarness,
  args: { ownerId: string; operationId: string; mode: PurgeMode; now: number },
) => await t.mutation(lifecycleInternal.beginOwnerDataPurgeInternal, args);

describe("owner lifecycle billing fence", () => {
  it("rejects a pre-deletion turn-token dispatch at the final transaction seam", async () => {
    const t = createTest();
    const ownerId = "turn-token-delete-race";
    const admitted = await t.query(
      lifecycleInternal.getOwnerDataAccessStateInternal,
      { ownerId },
    );
    await beginPurge(t, {
      ownerId,
      operationId: "delete-before-dispatch",
      mode: "delete",
      now: 9_000,
    });

    await expect(
      t.mutation(lifecycleInternal.assertOwnerDataDispatchAllowedInternal, {
        ownerId,
        ownerGeneration: admitted.generation,
      }),
    ).rejects.toThrow(/account is being deleted/u);
  });

  for (const testCase of [
    {
      mode: "reset" as const,
      expectedError: /data is being reset/u,
    },
    {
      mode: "delete" as const,
      expectedError: /account is being deleted/u,
    },
  ]) {
    it(`prevents ${testCase.mode} races from recreating billing rows`, async () => {
      const t = createTest();
      const ownerId = `billing-fence-${testCase.mode}`;
      const admitted = await t.query(
        lifecycleInternal.getOwnerDataAccessStateInternal,
        { ownerId },
      );

      // Establish the exact state a purge normally removes. The generation is
      // captured at request admission, just as the provider callback does.
      await t.mutation(internal.billing.resolveManagedModelAccess, {
        ownerId,
        ownerGeneration: admitted.generation,
      });
      expect(await billingSnapshot(t, ownerId)).toMatchObject({
        profiles: 1,
        windows: 1,
      });

      await beginPurge(t, {
        ownerId,
        operationId: `${testCase.mode}-operation`,
        mode: testCase.mode,
        now: 10_000,
      });
      await drainBillingRows(t, ownerId);

      const lateMutations = [
        () =>
          t.mutation(internal.billing.resolveManagedModelAccess, {
            ownerId,
            ownerGeneration: admitted.generation,
          }),
        () =>
          t.mutation(internal.billing.enforceManagedUsageLimit, {
            ownerId,
            ownerGeneration: admitted.generation,
          }),
        () =>
          t.mutation(internal.billing.logManagedUsage, {
            ownerId,
            ownerGeneration: admitted.generation,
            agentType: "orchestrator",
            model: "test/model",
            durationMs: 25,
            success: true,
            costMicroCents: 100,
          }),
      ];

      for (const lateMutation of lateMutations) {
        await expect(lateMutation()).rejects.toThrow(testCase.expectedError);
      }

      expect(await billingSnapshot(t, ownerId)).toEqual({
        profiles: 0,
        windows: 0,
        credits: 0,
        logs: 0,
        totalRequestCount: 0,
      });
    });
  }

  it("rejects a delayed pre-reset callback after the owner reopens", async () => {
    const t = createTest();
    const ownerId = "stale-generation-owner";
    const admitted = await t.query(
      lifecycleInternal.getOwnerDataAccessStateInternal,
      { ownerId },
    );
    const purge = await beginPurge(t, {
      ownerId,
      operationId: "reset-for-generation-rotation",
      mode: "reset",
      now: 20_000,
    });

    const coreLeaseId = "core-lease";
    expect(
      await t.mutation(lifecycleInternal.claimOwnerPurgeStageInternal, {
        ownerId,
        operationId: purge.operationId,
        generation: purge.generation,
        stage: "core",
        leaseId: coreLeaseId,
        now: 20_001,
      }),
    ).toMatchObject({ claimed: true, complete: false, mode: "reset" });
    expect(
      await t.mutation(lifecycleInternal.advanceOwnerPurgeStageInternal, {
        ownerId,
        operationId: purge.operationId,
        generation: purge.generation,
        leaseId: coreLeaseId,
        stage: "core",
        nextStage: "cloud",
        now: 20_002,
      }),
    ).toBe(true);

    const cloudLeaseId = "cloud-lease";
    expect(
      await t.mutation(lifecycleInternal.claimOwnerPurgeStageInternal, {
        ownerId,
        operationId: purge.operationId,
        generation: purge.generation,
        stage: "cloud",
        leaseId: cloudLeaseId,
        now: 20_003,
      }),
    ).toMatchObject({ claimed: true, complete: false, mode: "reset" });

    const nextGeneration = "generation-after-reset";
    await t.run(async (ctx) => {
      await seedReadyPurgeBackupSweep(ctx, {
        ownerId,
        operationId: purge.operationId,
        generation: purge.generation,
        now: 20_004,
      });
    });
    expect(
      await t.mutation(lifecycleInternal.finishOwnerCloudPurgeInternal, {
        ownerId,
        operationId: purge.operationId,
        generation: purge.generation,
        leaseId: cloudLeaseId,
        nextGeneration,
        now: 20_004,
      }),
    ).toBe(true);

    expect(
      await t.query(lifecycleInternal.getOwnerDataAccessStateInternal, {
        ownerId,
      }),
    ).toEqual({ allowed: true, state: "open", generation: nextGeneration });

    await expect(
      t.mutation(internal.billing.logManagedUsage, {
        ownerId,
        ownerGeneration: admitted.generation,
        agentType: "orchestrator",
        model: "test/model",
        durationMs: 50,
        success: true,
        costMicroCents: 100,
      }),
    ).rejects.toThrow(/started before the account data was reset/u);
    expect(await billingSnapshot(t, ownerId)).toEqual({
      profiles: 0,
      windows: 0,
      credits: 0,
      logs: 0,
      totalRequestCount: 0,
    });

    // A callback admitted after the reopen carries the rotated generation and
    // remains valid, proving the fence is selective rather than permanent.
    await t.mutation(internal.billing.logManagedUsage, {
      ownerId,
      ownerGeneration: nextGeneration,
      agentType: "orchestrator",
      model: "test/model",
      durationMs: 50,
      success: true,
      costMicroCents: 100,
    });
    expect(await billingSnapshot(t, ownerId)).toMatchObject({
      profiles: 1,
      windows: 1,
      totalRequestCount: 1,
    });
  });
});

describe("owner purge job coordination", () => {
  it("idempotently rejoins a purge, excludes live leases, and upgrades reset to delete", async () => {
    const t = createTest();
    const ownerId = "purge-coordination-owner";
    const now = 30_000;
    const first = await beginPurge(t, {
      ownerId,
      operationId: "original-operation",
      mode: "reset",
      now,
    });
    const duplicate = await beginPurge(t, {
      ownerId,
      operationId: "ignored-duplicate-operation",
      mode: "reset",
      now: now + 1,
    });
    expect(duplicate).toEqual(first);

    expect(
      await t.mutation(lifecycleInternal.claimOwnerPurgeStageInternal, {
        ownerId,
        operationId: first.operationId,
        generation: first.generation,
        stage: "core",
        leaseId: "worker-a",
        now: now + 2,
      }),
    ).toMatchObject({ claimed: true, complete: false });
    expect(
      await t.mutation(lifecycleInternal.claimOwnerPurgeStageInternal, {
        ownerId,
        operationId: first.operationId,
        generation: first.generation,
        stage: "core",
        leaseId: "worker-b",
        now: now + 3,
      }),
    ).toMatchObject({ claimed: false, complete: false });

    // A killed worker's lease is reclaimable after the durable expiry.
    expect(
      await t.mutation(lifecycleInternal.claimOwnerPurgeStageInternal, {
        ownerId,
        operationId: first.operationId,
        generation: first.generation,
        stage: "core",
        leaseId: "worker-b",
        now: now + 9 * 60_000 + 3,
      }),
    ).toMatchObject({ claimed: true, complete: false });
    expect(
      await t.query(lifecycleInternal.getOwnerPurgeJobInternal, { ownerId }),
    ).toMatchObject({ attempts: 2, leaseId: "worker-b", mode: "reset" });

    const upgraded = await beginPurge(t, {
      ownerId,
      operationId: "ignored-delete-operation",
      mode: "delete",
      now: now + 9 * 60_000 + 4,
    });
    expect(upgraded).toMatchObject({
      operationId: first.operationId,
      generation: first.generation,
      mode: "delete",
      stage: "core",
    });

    await expect(
      t.mutation(lifecycleInternal.assertOwnerPurgeLeaseInternal, {
        ownerId,
        operationId: first.operationId,
        generation: first.generation,
        stage: "core",
        leaseId: "worker-b",
        mode: "reset",
      }),
    ).rejects.toThrow(/started before the account data was reset/u);
    expect(
      await t.query(lifecycleInternal.getOwnerPurgeJobInternal, { ownerId }),
    ).toMatchObject({
      operationId: first.operationId,
      generation: first.generation,
      mode: "delete",
      stage: "core",
    });

    await expect(
      beginPurge(t, {
        ownerId,
        operationId: "must-not-downgrade",
        mode: "reset",
        now: now + 9 * 60_000 + 5,
      }),
    ).rejects.toThrow(/account is being deleted/u);
  });

  it("does not let a stale retry publisher clear a reclaimed lease", async () => {
    const t = createTest();
    const ownerId = "retry-lease-owner";
    const now = 50_000;
    const purge = await beginPurge(t, {
      ownerId,
      operationId: "retry-operation",
      mode: "reset",
      now,
    });
    const fence = {
      ownerId,
      operationId: purge.operationId,
      generation: purge.generation,
    };
    await t.mutation(lifecycleInternal.claimOwnerPurgeStageInternal, {
      ...fence,
      stage: "core",
      leaseId: "stale-worker",
      now: now + 1,
    });
    await t.mutation(lifecycleInternal.claimOwnerPurgeStageInternal, {
      ...fence,
      stage: "core",
      leaseId: "current-worker",
      now: now + 9 * 60_000 + 2,
    });

    expect(
      await t.mutation(lifecycleInternal.scheduleOwnerPurgeRetryInternal, {
        ...fence,
        stage: "core",
        leaseId: "stale-worker",
        error: "late failure",
        now: now + 9 * 60_000 + 3,
      }),
    ).toBe(false);
    expect(
      await t.query(lifecycleInternal.getOwnerPurgeJobInternal, { ownerId }),
    ).toMatchObject({ leaseId: "current-worker" });

    expect(
      await t.mutation(lifecycleInternal.scheduleOwnerPurgeRetryInternal, {
        ...fence,
        stage: "core",
        leaseId: "current-worker",
        error: "current failure",
        now: now + 9 * 60_000 + 4,
      }),
    ).toBe(true);
    expect(
      await t.query(lifecycleInternal.getOwnerPurgeJobInternal, { ownerId }),
    ).not.toHaveProperty("leaseId");
  });
});
