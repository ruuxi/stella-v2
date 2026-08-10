/**
 * One-off maintenance that retires the anonymous cost-tracking fields on
 * `anon_device_usage` (`usageMicroCents` and `bucket`).
 *
 * Those fields recorded what anonymous requests cost, to help size the
 * anonymous allowance. The allowance is a single request, so there was never
 * a number to tune and the measurement had no consumer. The code that wrote
 * them is gone; this clears what production already stored.
 *
 * It exists because Convex validates every document against the schema:
 * dropping the two fields from `schema/devices.ts` while live documents still
 * carry them fails the push. So this runs FIRST, against the current schema,
 * and the schema shrinks only once every row is clear.
 *
 * Deploy order — the steps are not interchangeable:
 *   1. Deploy the code that stops writing the fields (already the case if you
 *      are reading this file on the deployed backend).
 *   2. Run this, `dryRun` first, then `{"dryRun": false}`.
 *   3. Only then drop the fields from the schema and delete this file.
 *
 * Running it before step 1 is harmless but pointless: live anonymous traffic
 * would immediately write the fields back.
 *
 * The counters are measurement-only and feed nothing else — no billing, no
 * revenue accounting, and not the request cap that actually gates anonymous
 * access. Clearing them loses nothing but the measurement itself.
 *
 * Internal only, and a dry run unless told otherwise:
 *
 *   bunx convex run anon_usage_migrations:clearAnonymousUsageCost
 *   bunx convex run anon_usage_migrations:clearAnonymousUsageCost '{"dryRun":false}'
 */
import { v } from "convex/values";
import { internalMutation } from "./_generated/server";
import { microCentsToDollars } from "./lib/billing_money";
import { clampIntToRange } from "./lib/number_utils";

const DEFAULT_BATCH_LIMIT = 1_000;
const MAX_BATCH_LIMIT = 10_000;

export const clearAnonymousUsageCost = internalMutation({
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

    const rows = await ctx.db.query("anon_device_usage").take(limit + 1);
    const truncated = rows.length > limit;
    const batch = rows.slice(0, limit);

    let clearedCount = 0;
    let alreadyClear = 0;
    let clearedMicroCents = 0;

    for (const row of batch) {
      const usage = row.usageMicroCents;
      const hasCost = usage !== undefined;
      const hasBucket = row.bucket !== undefined;
      if (!hasCost && !hasBucket) {
        alreadyClear += 1;
        continue;
      }

      clearedCount += 1;
      clearedMicroCents += Math.max(0, usage ?? 0);
      if (dryRun) continue;

      // Patching a field to `undefined` removes it from the document, which
      // is what lets the schema drop it afterwards. The request counter and
      // the timestamps behind the 7-day reset are deliberately untouched —
      // they are the live allowance, not measurement.
      await ctx.db.patch(row._id, {
        usageMicroCents: undefined,
        bucket: undefined,
      });
    }

    return {
      dryRun,
      scanned: batch.length,
      truncated,
      rowsCleared: clearedCount,
      rowsAlreadyClear: alreadyClear,
      clearedUsd: microCentsToDollars(clearedMicroCents),
    };
  },
});
