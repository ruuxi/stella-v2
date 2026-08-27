/// <reference types="vite/client" />

import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FunctionReference } from "convex/server";
import { internal } from "./_generated/api";
import { executeWebSearch } from "./tools/backend";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");
const createTest = () => convexTest(schema, modules);
const originalParallelApiKey = process.env.PARALLEL_API_KEY;

beforeEach(() => {
  process.env.PARALLEL_API_KEY = "parallel-generation-test-key";
});

afterEach(() => {
  vi.restoreAllMocks();
  if (originalParallelApiKey === undefined) {
    delete process.env.PARALLEL_API_KEY;
  } else {
    process.env.PARALLEL_API_KEY = originalParallelApiKey;
  }
});

const currentGeneration = async (
  t: ReturnType<typeof createTest>,
  ownerId: string,
) => {
  const state = await t.query(
    internal.owner_lifecycle.getOwnerDataAccessStateInternal,
    { ownerId },
  );
  expect(state.allowed).toBe(true);
  return state.generation;
};

const executeForOwner = async (
  t: ReturnType<typeof createTest>,
  args: { ownerId: string; ownerGeneration: string },
) =>
  await executeWebSearch(
    {
      runMutation: async (
        reference: FunctionReference<"mutation", "internal">,
        mutationArgs: Record<string, unknown>,
      ) => await t.mutation(reference, mutationArgs),
    } as never,
    "latest durable agents",
    {
      ...args,
      signal: new AbortController().signal,
    },
  );

const expectNoSearchSideEffects = async (
  t: ReturnType<typeof createTest>,
  ownerId: string,
) => {
  const state = await t.run(async (ctx) => {
    const [leases, usageWindow, logs] = await Promise.all([
      ctx.db
        .query("billing_managed_dispatch_leases")
        .withIndex("by_ownerId_and_createdAt", (q) => q.eq("ownerId", ownerId))
        .take(10),
      ctx.db
        .query("billing_usage_windows")
        .withIndex("by_ownerId", (q) => q.eq("ownerId", ownerId))
        .unique(),
      ctx.db
        .query("usage_logs")
        .withIndex("by_ownerId_and_createdAt", (q) => q.eq("ownerId", ownerId))
        .take(10),
    ]);
    return { leases, usageWindow, logs };
  });
  expect(state.leases).toEqual([]);
  expect(state.logs).toEqual([]);
  expect(state.usageWindow?.totalRequestCount ?? 0).toBe(0);
  expect(state.usageWindow?.totalUsageMicroCents ?? 0).toBe(0);
};

describe("Parallel search owner-generation dispatch fencing", () => {
  it("performs zero provider fetches after reset closes the admitted generation", async () => {
    const t = createTest();
    const ownerId = "parallel-reset-owner";
    const ownerGeneration = await currentGeneration(t, ownerId);
    await t.mutation(internal.owner_lifecycle.beginOwnerDataPurgeInternal, {
      ownerId,
      operationId: "parallel-reset-operation",
      mode: "reset",
      now: 1_000,
    });
    const providerFetch = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(new Error("Parallel must not be called"));

    await expect(
      executeForOwner(t, { ownerId, ownerGeneration }),
    ).rejects.toThrow(/reset|unavailable|purge/iu);
    expect(providerFetch).not.toHaveBeenCalled();
    await expectNoSearchSideEffects(t, ownerId);
  });

  it("performs zero provider fetches for a fenced migration source", async () => {
    const t = createTest();
    const ownerId = "parallel-migration-source";
    const ownerGeneration = await currentGeneration(t, ownerId);
    await t.run(async (ctx) => {
      await ctx.db.insert("auth_owner_migrations", {
        fromOwnerId: ownerId,
        toOwnerId: "parallel-migration-target",
        status: "pending",
        leaseGeneration: 0,
        fromOwnerGeneration: ownerGeneration,
        toOwnerGeneration: "legacy",
        planRevision: 1,
        createdAt: 2_000,
        updatedAt: 2_000,
      });
    });
    const providerFetch = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(new Error("Parallel must not be called"));

    await expect(
      executeForOwner(t, { ownerId, ownerGeneration }),
    ).rejects.toThrow(/migrat|ownership_migrated|linked/iu);
    expect(providerFetch).not.toHaveBeenCalled();
    await expectNoSearchSideEffects(t, ownerId);
  });

  it("performs zero provider fetches for a fenced migration destination", async () => {
    const t = createTest();
    const ownerId = "parallel-incoming-target";
    const ownerGeneration = await currentGeneration(t, ownerId);
    await t.run(async (ctx) => {
      await ctx.db.insert("auth_owner_migrations", {
        fromOwnerId: "parallel-incoming-source",
        toOwnerId: ownerId,
        status: "running",
        leaseGeneration: 1,
        fromOwnerGeneration: "legacy",
        toOwnerGeneration: ownerGeneration,
        planRevision: 1,
        createdAt: 3_000,
        updatedAt: 3_000,
      });
    });
    const providerFetch = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(new Error("Parallel must not be called"));

    await expect(
      executeForOwner(t, { ownerId, ownerGeneration }),
    ).rejects.toThrow(/migrat|ownership_migrated|linked/iu);
    expect(providerFetch).not.toHaveBeenCalled();
    await expectNoSearchSideEffects(t, ownerId);
  });
});
