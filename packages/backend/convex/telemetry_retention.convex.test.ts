import { convexTest } from "convex-test";
import { describe, expect, it } from "vitest";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");

const insertUsageLog = async (t: ReturnType<typeof convexTest>) =>
  await t.run(async (ctx) => {
    const conversationId: Id<"conversations"> = await ctx.db.insert(
      "conversations",
      {
        ownerId: "owner-1",
        isDefault: false,
        eventCount: 0,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      },
    );
    return await ctx.db.insert("usage_logs", {
      ownerId: "owner-1",
      conversationId,
      agentType: "orchestrator",
      model: "test-model",
      durationMs: 10,
      success: true,
      createdAt: Date.now(),
    });
  });

describe("telemetry retention", () => {
  it("deletes usage_logs older than the cutoff and keeps newer rows", async () => {
    const t = convexTest(schema, modules);
    await insertUsageLog(t);
    await insertUsageLog(t);

    const kept = await t.mutation(
      internal.telemetry_retention.purgeOldUsageLogs,
      { cutoffMs: 0 },
    );
    expect(kept).toEqual({ deleted: 0, hasMore: false });

    const purged = await t.mutation(
      internal.telemetry_retention.purgeOldUsageLogs,
      { cutoffMs: Date.now() + 60_000 },
    );
    expect(purged).toEqual({ deleted: 2, hasMore: false });

    const remaining = await t.run(
      async (ctx) => await ctx.db.query("usage_logs").collect(),
    );
    expect(remaining).toHaveLength(0);
  });

  it("reports hasMore and reschedules itself when a full batch is deleted", async () => {
    const t = convexTest(schema, modules);
    await insertUsageLog(t);
    await insertUsageLog(t);
    await insertUsageLog(t);

    const result = await t.mutation(
      internal.telemetry_retention.purgeOldUsageLogs,
      { cutoffMs: Date.now() + 60_000, batchSize: 2 },
    );
    expect(result).toEqual({ deleted: 2, hasMore: true });

    const scheduled = await t.run(
      async (ctx) =>
        await ctx.db.system.query("_scheduled_functions").collect(),
    );
    expect(
      scheduled.filter((job) =>
        job.name.includes("telemetry_retention:purgeOldUsageLogs"),
      ),
    ).toHaveLength(1);
  });

  it("deletes old media_job_logs rows", async () => {
    const t = convexTest(schema, modules);
    await t.run(async (ctx) => {
      await ctx.db.insert("media_job_logs", {
        ownerId: "owner-1",
        jobId: "job-1",
        ordinal: 0,
        receivedAt: Date.now(),
        entry: { message: "queued" },
      });
    });

    const purged = await t.mutation(
      internal.telemetry_retention.purgeOldMediaJobLogs,
      { cutoffMs: Date.now() + 60_000 },
    );
    expect(purged).toEqual({ deleted: 1, hasMore: false });

    const remaining = await t.run(
      async (ctx) => await ctx.db.query("media_job_logs").collect(),
    );
    expect(remaining).toHaveLength(0);
  });
});
