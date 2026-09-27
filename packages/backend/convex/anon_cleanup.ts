import { v } from "convex/values";
import { internalAction, internalQuery } from "./_generated/server";
import { components, internal } from "./_generated/api";
import { tokenIdentifierForBetterAuthUserId } from "./auth";

const STALE_THRESHOLD_MS = 30 * 24 * 60 * 60 * 1000;
const PAGE_SIZE = 100;
/** Upper bound on resets one daily run (the whole page chain) schedules. */
export const MAX_RESETS_PER_RUN = 200;

type PaginatedResult = {
  page: Array<{ _id: string; isAnonymous?: boolean | null; updatedAt: number }>;
  continueCursor?: string;
  isDone?: boolean;
};

/**
 * One page of anonymous Better Auth users that still need a retention reset.
 *
 * The reset deliberately keeps the Better Auth user (the anonymous JWT may
 * still be live and `cloud_owner_lifecycles` must keep its generation), so the
 * durable "already cleaned" marker is the owner's `cloud_owner_purge_jobs`
 * row: it survives completion in stage `complete` with `updatedAt` at finish.
 * An owner is skipped when
 *  - a purge (reset or delete) is still in flight — its own retry sweep owns it;
 *  - a completed purge finished after the user's last Better Auth update, i.e.
 *    nothing on the user has changed since it was cleaned;
 *  - it is the source of an unfinished ownership migration.
 */
export const _listStaleAnonymousOwnerIds = internalQuery({
  args: {
    cursor: v.union(v.string(), v.null()),
    cutoffMs: v.number(),
  },
  returns: v.object({
    ownerIds: v.array(v.string()),
    nextCursor: v.union(v.string(), v.null()),
  }),
  handler: async (ctx, args) => {
    // Only pass isAnonymous in the where clause so the adapter's findIndex
    // matches the isAnonymous_updatedAt index prefix. The updatedAt range
    // filter is applied below; this works around a bug in
    // @convex-dev/better-auth <=0.10.10 where findIndex prepends "_" to
    // bound fields in compound lookups, turning "updatedAt" into
    // "_updatedAt" and missing the index.
    const result: PaginatedResult = await ctx.runQuery(
      components.betterAuth.adapter.findMany,
      {
        model: "user" as const,
        where: [{ field: "isAnonymous", value: true }],
        paginationOpts: { cursor: args.cursor, numItems: PAGE_SIZE },
      },
    );

    const stale = result.page.filter((u) => u.updatedAt < args.cutoffMs);
    const eligible = await Promise.all(
      stale.map(async (user) => {
        // App tables key `ownerId` by the Convex tokenIdentifier
        // (`${issuer}|${betterAuthUserId}`), not the raw Better Auth user id.
        const ownerId = tokenIdentifierForBetterAuthUserId(user._id);
        const [purgeJob, migrations] = await Promise.all([
          ctx.db
            .query("cloud_owner_purge_jobs")
            .withIndex("by_ownerId", (q) => q.eq("ownerId", ownerId))
            .unique(),
          ctx.db
            .query("auth_owner_migrations")
            .withIndex("by_fromOwnerId_and_updatedAt", (q) =>
              q.eq("fromOwnerId", ownerId),
            )
            .take(2),
        ]);
        if (migrations.some((row) => row.status !== "complete")) return null;
        if (purgeJob) {
          if (purgeJob.stage !== "complete") return null;
          if (purgeJob.updatedAt >= user.updatedAt) return null;
        }
        return ownerId;
      }),
    );

    const done = result.isDone === true;
    return {
      ownerIds: eligible.filter((id): id is string => id !== null),
      nextCursor: done ? null : (result.continueCursor ?? null),
    };
  },
});

/**
 * Daily retention sweep. Each invocation handles one page and continues the
 * chain with `ctx.scheduler.runAfter`, so no single action walks every
 * anonymous user. A run stops once it has scheduled `MAX_RESETS_PER_RUN`
 * resets; the remainder is picked up by the next daily run (cleaned owners
 * are skipped, so the backlog always makes progress).
 */
export const purgeStaleAnonymousData = internalAction({
  args: {
    cursor: v.optional(v.union(v.string(), v.null())),
    cutoffMs: v.optional(v.number()),
    scheduledSoFar: v.optional(v.number()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const cutoffMs = args.cutoffMs ?? Date.now() - STALE_THRESHOLD_MS;
    let scheduledSoFar = args.scheduledSoFar ?? 0;

    const batch: {
      ownerIds: string[];
      nextCursor: string | null;
    } = await ctx.runQuery(internal.anon_cleanup._listStaleAnonymousOwnerIds, {
      cursor: args.cursor ?? null,
      cutoffMs,
    });

    const budget = Math.max(0, MAX_RESETS_PER_RUN - scheduledSoFar);
    const toReset = batch.ownerIds.slice(0, budget);
    await Promise.all(
      toReset.map((ownerId) =>
        ctx.scheduler.runAfter(0, internal.reset.resetOwnerDataInternal, {
          ownerId,
        }),
      ),
    );
    scheduledSoFar += toReset.length;

    const capped = scheduledSoFar >= MAX_RESETS_PER_RUN;
    if (batch.nextCursor !== null && !capped) {
      await ctx.scheduler.runAfter(
        0,
        internal.anon_cleanup.purgeStaleAnonymousData,
        { cursor: batch.nextCursor, cutoffMs, scheduledSoFar },
      );
    } else if (scheduledSoFar > 0) {
      console.log(
        `[anon_cleanup] Scheduled purge for ${scheduledSoFar} stale anonymous users${capped ? " (per-run cap reached)" : ""}`,
      );
    }

    return null;
  },
});
