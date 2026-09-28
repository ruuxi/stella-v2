/// <reference types="vite/client" />

import { convexTest } from "convex-test";
import { describe, expect, it } from "vitest";
import { components, internal } from "./_generated/api";
import { tokenIdentifierForBetterAuthUserId } from "./auth";
import betterAuthSchema from "./betterAuth/schema";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");
const betterAuthModules = import.meta.glob("./betterAuth/**/*.ts");

const createTest = () => {
  const t = convexTest(schema, modules);
  t.registerComponent("betterAuth", betterAuthSchema, betterAuthModules);
  return t;
};
type Harness = ReturnType<typeof createTest>;

const seedAnonUser = async (t: Harness, key: string, updatedAt: number) => {
  const user = (await t.mutation(components.betterAuth.adapter.create, {
    input: {
      model: "user",
      data: {
        name: key,
        email: `${key}@anon.stella.test`,
        emailVerified: false,
        isAnonymous: true,
        createdAt: updatedAt,
        updatedAt,
      },
    },
  })) as { _id: string };
  return tokenIdentifierForBetterAuthUserId(user._id);
};

const seedPurgeJob = async (
  t: Harness,
  ownerId: string,
  stage: "core" | "cloud" | "complete",
  updatedAt: number,
) =>
  await t.run(async (ctx) => {
    await ctx.db.insert("cloud_owner_purge_jobs", {
      ownerId,
      operationId: `op-${ownerId}`,
      generation: "g",
      mode: "reset",
      stage,
      attempts: 0,
      nextRetryAt: updatedAt,
      createdAt: updatedAt,
      updatedAt,
    });
  });

const scheduledResets = async (t: Harness) =>
  await t.run(async (ctx) =>
    (await ctx.db.system.query("_scheduled_functions").collect())
      .filter((job) => job.name === "reset:resetOwnerDataInternal")
      .map((job) => (job.args[0] as { ownerId: string }).ownerId),
  );

describe("anon_cleanup", () => {
  it("skips fresh, already-cleaned, in-flight, and migrating owners in one page query", async () => {
    const t = createTest();
    const cutoffMs = 10_000;
    const stale = await seedAnonUser(t, "stale", 100);
    const fresh = await seedAnonUser(t, "fresh", 20_000);
    const cleaned = await seedAnonUser(t, "cleaned", 100);
    const inFlight = await seedAnonUser(t, "inflight", 100);
    const cleanedThenUpdated = await seedAnonUser(t, "updated", 5_000);
    const migrating = await seedAnonUser(t, "migrating", 100);
    await seedPurgeJob(t, cleaned, "complete", 200);
    await seedPurgeJob(t, inFlight, "core", 200);
    await seedPurgeJob(t, cleanedThenUpdated, "complete", 200);
    await t.run(async (ctx) => {
      await ctx.db.insert("auth_owner_migrations", {
        fromOwnerId: migrating,
        toOwnerId: "https://stella.test|dest",
        status: "pending",
        createdAt: 1,
        updatedAt: 1,
      });
    });

    const page = await t.query(
      internal.anon_cleanup._listStaleAnonymousOwnerIds,
      { cursor: null, cutoffMs },
    );
    expect(page.nextCursor).toBeNull();
    expect(new Set(page.ownerIds)).toEqual(
      new Set([stale, cleanedThenUpdated]),
    );
    expect(page.ownerIds).not.toContain(fresh);
  });

  it("schedules resets and never re-schedules an owner once its reset completed", async () => {
    const t = createTest();
    const owner = await seedAnonUser(t, "once", 1);
    await t.action(internal.anon_cleanup.purgeStaleAnonymousData, {});
    expect(await scheduledResets(t)).toEqual([owner]);

    // The reset's purge job survives completion; the next daily run skips it.
    await seedPurgeJob(t, owner, "complete", 2);
    await t.action(internal.anon_cleanup.purgeStaleAnonymousData, {});
    expect(await scheduledResets(t)).toEqual([owner]);
  });

  it("continues paging via the scheduler instead of looping in one action", async () => {
    const t = createTest();
    for (let i = 0; i < 101; i++) await seedAnonUser(t, `page-${i}`, 1);
    await t.action(internal.anon_cleanup.purgeStaleAnonymousData, {});
    const continuations = await t.run(async (ctx) =>
      (await ctx.db.system.query("_scheduled_functions").collect()).filter(
        (job) => job.name === "anon_cleanup:purgeStaleAnonymousData",
      ),
    );
    expect(continuations).toHaveLength(1);
    expect(continuations[0]!.args[0]).toMatchObject({ scheduledSoFar: 100 });
    expect(await scheduledResets(t)).toHaveLength(100);
  });

  it("stops the chain once the per-run cap is reached", async () => {
    const t = createTest();
    await seedAnonUser(t, "capped", 1);
    await t.action(internal.anon_cleanup.purgeStaleAnonymousData, {
      cursor: null,
      scheduledSoFar: 200,
    });
    expect(await scheduledResets(t)).toEqual([]);
  });
});
