import { v } from "convex/values";
import { internalMutation } from "./_generated/server";
import { microCentsToDollars } from "./lib/billing_money";
import { clampIntToRange } from "./lib/number_utils";

const DEFAULT_BATCH_LIMIT = 1_000;
const MAX_BATCH_LIMIT = 10_000;

export const resetFreeLifetimeUsage = internalMutation({
  args: {
    limit: v.optional(v.number()),

    dryRun: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const limit = clampIntToRange(
      args.limit ?? DEFAULT_BATCH_LIMIT,
      1,
      MAX_BATCH_LIMIT,
    );
    const dryRun = args.dryRun !== false;

    const rows = await ctx.db.query("billing_usage_windows").take(limit + 1);
    const truncated = rows.length > limit;
    const batch = rows.slice(0, limit);

    let paidSkipped = 0;
    let alreadyClear = 0;
    let resetCount = 0;
    let clearedMicroCents = 0;
    const now = Date.now();

    for (const row of batch) {
      const profile = await ctx.db
        .query("billing_profiles")
        .withIndex("by_ownerId", (q) => q.eq("ownerId", row.ownerId))
        .unique();

      const plan = profile?.activePlan ?? "free";
      if (plan !== "free") {
        paidSkipped += 1;
        continue;
      }

      const used = Math.max(0, row.totalUsageMicroCents);
      if (used === 0 && (row.totalRequestCount ?? 0) === 0) {
        alreadyClear += 1;
        continue;
      }

      resetCount += 1;
      clearedMicroCents += used;
      if (dryRun) continue;

      await ctx.db.patch(row._id, {
        totalUsageMicroCents: 0,
        totalRequestCount: 0,
        updatedAt: now,
      });
    }

    return {
      dryRun,
      scanned: batch.length,
      truncated,
      freeAccountsReset: resetCount,
      freeAccountsAlreadyClear: alreadyClear,
      paidAccountsSkipped: paidSkipped,
      clearedUsd: microCentsToDollars(clearedMicroCents),
    };
  },
});
