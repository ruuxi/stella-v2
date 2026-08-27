import { v } from "convex/values";
import { internalMutation } from "./_generated/server";
import { internal } from "./_generated/api";

export const USAGE_LOGS_RETENTION_MS = 90 * 24 * 60 * 60_000;
export const MEDIA_JOB_LOGS_RETENTION_MS = 30 * 24 * 60 * 60_000;

const clampBatchSize = (value: number | undefined): number => {
  const raw = Math.floor(value ?? 500);
  return Math.max(1, Math.min(raw, 1000));
};

export const purgeOldUsageLogs = internalMutation({
  args: {
    batchSize: v.optional(v.number()),

    cutoffMs: v.optional(v.number()),
  },
  returns: v.object({ deleted: v.number(), hasMore: v.boolean() }),
  handler: async (ctx, args) => {
    const batchSize = clampBatchSize(args.batchSize);
    const cutoff = args.cutoffMs ?? Date.now() - USAGE_LOGS_RETENTION_MS;
    const expired = await ctx.db
      .query("usage_logs")
      .withIndex("by_creation_time", (q) => q.lt("_creationTime", cutoff))
      .take(batchSize);
    await Promise.all(expired.map((row) => ctx.db.delete(row._id)));
    const hasMore = expired.length === batchSize;
    if (hasMore) {
      await ctx.scheduler.runAfter(
        0,
        internal.telemetry_retention.purgeOldUsageLogs,
        { batchSize: args.batchSize, cutoffMs: args.cutoffMs },
      );
    }
    return { deleted: expired.length, hasMore };
  },
});

export const purgeOldMediaJobLogs = internalMutation({
  args: {
    batchSize: v.optional(v.number()),

    cutoffMs: v.optional(v.number()),
  },
  returns: v.object({ deleted: v.number(), hasMore: v.boolean() }),
  handler: async (ctx, args) => {
    const batchSize = clampBatchSize(args.batchSize);
    const cutoff = args.cutoffMs ?? Date.now() - MEDIA_JOB_LOGS_RETENTION_MS;
    const expired = await ctx.db
      .query("media_job_logs")
      .withIndex("by_creation_time", (q) => q.lt("_creationTime", cutoff))
      .take(batchSize);
    await Promise.all(expired.map((row) => ctx.db.delete(row._id)));
    const hasMore = expired.length === batchSize;
    if (hasMore) {
      await ctx.scheduler.runAfter(
        0,
        internal.telemetry_retention.purgeOldMediaJobLogs,
        { batchSize: args.batchSize, cutoffMs: args.cutoffMs },
      );
    }
    return { deleted: expired.length, hasMore };
  },
});
