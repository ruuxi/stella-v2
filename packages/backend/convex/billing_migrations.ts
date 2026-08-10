/**
 * One-off maintenance run alongside the Free plan's switch to a lifetime
 * allowance (`STELLA_FREE_LIFETIME_LIMIT_USD`).
 *
 * The lifetime check reads `billing_usage_windows.totalUsageMicroCents`,
 * which has accumulated since long before the allowance existed. Turning
 * the limit on without clearing it would apply the new rule retroactively:
 * every Free account whose historical spend already passed the cap would be
 * locked out at once, having spent that money under the old monthly rules.
 * This resets those accounts so the allowance starts from the day it ships.
 *
 * Scoped to Free accounts on purpose. Paid accounts keep their history, so a
 * subscriber who later downgrades still arrives on Free with the allowance
 * already spent — which is the intended behaviour, not an oversight.
 *
 * The counter feeds the lifetime check, its own display, and
 * `billing_measurement`. It is not part of Stripe billing or revenue
 * accounting, so clearing it loses measurement history and nothing else.
 *
 * Internal only, and a dry run unless told otherwise:
 *
 *   bunx convex run billing_migrations:resetFreeLifetimeUsage
 *   bunx convex run billing_migrations:resetFreeLifetimeUsage '{"dryRun":false}'
 */
import { v } from "convex/values";
import { internalMutation } from "./_generated/server";
import { microCentsToDollars } from "./lib/billing_money";
import { clampIntToRange } from "./lib/number_utils";

const DEFAULT_BATCH_LIMIT = 1_000;
const MAX_BATCH_LIMIT = 10_000;

export const resetFreeLifetimeUsage = internalMutation({
  args: {
    limit: v.optional(v.number()),
    /** Defaults to true — pass `false` to actually write. */
    dryRun: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const limit = clampIntToRange(
      args.limit ?? DEFAULT_BATCH_LIMIT,
      1,
      MAX_BATCH_LIMIT,
    );
    const dryRun = args.dryRun !== false;

    // Scanned from the usage table rather than from profiles: an owner who
    // never subscribed has no profile row at all, and those accounts are
    // Free too — starting from profiles would silently skip them.
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
      // No profile means no subscription was ever started, which is Free.
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

      // The request counter is cleared with it: paired with the dollars it
      // is what makes requests-per-dollar answerable, and keeping requests
      // against zeroed spend would report an infinite rate.
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
