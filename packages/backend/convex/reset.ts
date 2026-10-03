import {
  internalAction,
  internalMutation,
  internalQuery,
  type ActionCtx,
  type MutationCtx,
  type QueryCtx,
} from "./_generated/server";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { type Infer, v } from "convex/values";
import { ensureExternalOwnerPurge } from "./cloud_purge";
import { purgeOwnerMigrationSourceDependencies } from "./lib/owner_migration_purge";
import { assertOwnerPurgeOperation } from "./owner_lifecycle";

/**
 * Per-mutation deletion batch size. Conservative because each `reset.*` call
 * runs inside a single Convex transaction and we want to stay well below the
 * read/write limits even when the caller chains many invocations.
 */
const BATCH = 200;

/**
 * Tables that hold owner-scoped data and can be drained per-table without
 * needing per-conversation traversal. Each entry maps to the index that lets
 * us look the rows up by `ownerId`.
 *
 * Kept here as a typed tuple so the orchestrator action can iterate over them
 * without losing the strong typing on `ctx.db.query` / `withIndex`.
 */
const OWNER_TABLES = [
  ["auth_revoked_sessions", "by_ownerId_and_sessionId"],
  ["auth_link_requests", "by_fromOwnerId_and_createdAt"],
  ["auth_browser_handoffs", "by_fromOwnerId"],
] as const;

type OwnerTable = (typeof OWNER_TABLES)[number][0];

/**
 * Reset rotates the owner's data generation, but it must not erase account
 * security or commercial entitlement state. In particular, deleting the
 * session-revocation tombstones could make a revoked token valid again, while
 * deleting billing history/windows/profiles could grant fresh quota or sever
 * Stripe reconciliation. Billing is deliberately outside this generic table
 * registry; account deletion delegates it to `account_billing_purge.ts`.
 */
const RESET_OWNER_TABLES = OWNER_TABLES.filter(
  ([table]) => table !== "auth_revoked_sessions",
);

type OwnerPurgeFence = {
  ownerId: string;
  operationId: string;
  generation: string;
};

const runOwnerReset = async (
  ctx: ActionCtx,
  fence: OwnerPurgeFence,
): Promise<void> => {
  const leaseId = crypto.randomUUID();
  const claim: {
    claimed: boolean;
    complete: boolean;
    mode: "reset" | "delete";
  } = await ctx.runMutation(
    internal.owner_lifecycle.claimOwnerPurgeStageInternal,
    {
      ...fence,
      stage: "core",
      leaseId,
      now: Date.now(),
    },
  );
  if (claim.complete) return;
  if (claim.mode !== "reset") {
    throw new Error("An account deletion superseded this reset.");
  }
  if (!claim.claimed) {
    const job: { stage: "core" | "cloud" | "complete" } | null =
      await ctx.runQuery(internal.owner_lifecycle.getOwnerPurgeJobInternal, {
        ownerId: fence.ownerId,
        operationId: fence.operationId,
      });
    if (job?.stage === "cloud") {
      await ctx.runAction(internal.cloud_purge.purgeOwnerCloudStack, fence);
      return;
    }
    throw new Error("Owner reset core stage is already leased.");
  }

  let retryStage: "core" | "cloud" = "core";
  try {
    await ensureExternalOwnerPurge(ctx, { ...fence, mode: "reset" });
    await purgeOwnerMigrationSourceDependencies(ctx, {
      ...fence,
      leaseId,
      mode: "reset",
    });
    const authMigration = await ctx.runMutation(
      internal.auth_migration.quiesceAndMinimizeOwnerAuthMigrationsInternal,
      { ...fence, leaseId, mode: "reset" },
    );
    if (!authMigration.ready) {
      throw new Error(
        `Owner reset is waiting for auth migration quiescence: ${authMigration.pending.join(", ")}`,
      );
    }
    await Promise.all([
      ...RESET_OWNER_TABLES.map(async ([table]) => {
        let hasMore = true;
        while (hasMore) {
          const result: { hasMore: boolean } = await ctx.runMutation(
            internal.reset._deleteOwnerTableBatch,
            { ...fence, table },
          );
          hasMore = result.hasMore;
        }
      }),
    ]);

    const remainingCore: string[] = await ctx.runQuery(
      internal.reset.remainingOwnerResetStoresInternal,
      { ownerId: fence.ownerId },
    );
    if (remainingCore.length > 0) {
      throw new Error(
        `Owner reset core purge is incomplete: ${remainingCore.join(", ")}`,
      );
    }
    const remainingAuth = await ctx.runMutation(
      internal.auth_migration.remainingOwnerAuthMigrationResidueInternal,
      { ...fence, leaseId, mode: "reset" },
    );
    if (remainingAuth.length > 0) {
      throw new Error(
        `Owner reset auth purge is incomplete: ${remainingAuth.join(", ")}`,
      );
    }

    const advanced: boolean = await ctx.runMutation(
      internal.owner_lifecycle.advanceOwnerPurgeStageInternal,
      {
        ...fence,
        leaseId,
        stage: "core",
        nextStage: "cloud",
        now: Date.now(),
      },
    );
    if (!advanced) throw new Error("Owner reset core lease was superseded.");
    retryStage = "cloud";
    await ctx.runAction(internal.cloud_purge.purgeOwnerCloudStack, fence);
  } catch (error) {
    await ctx.runMutation(
      internal.owner_lifecycle.scheduleOwnerPurgeRetryInternal,
      {
        ...fence,
        stage: retryStage,
        leaseId,
        error: error instanceof Error ? error.message : String(error),
        now: Date.now(),
      },
    );
    throw error;
  }
};

// ---------------------------------------------------------------------------
// Entry points. A user's reset arrives as the owner object's `account.reset`,
// which posts to `/api/cloud/owners/reset` (http_routes/gateway.ts): that route
// opens the purge and schedules `resumeOwnerResetInternal`.
// ---------------------------------------------------------------------------

export const resumeOwnerResetInternal = internalAction({
  args: {
    ownerId: v.string(),
    operationId: v.string(),
    generation: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    await runOwnerReset(ctx, args);
    return null;
  },
});

/** Data-retention cleanup for a Better Auth anonymous user that still exists. */
export const resetOwnerDataInternal = internalAction({
  args: { ownerId: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const lifecycle = await ctx.runMutation(
      internal.owner_lifecycle.beginOwnerDataPurgeInternal,
      {
        ownerId: args.ownerId,
        operationId: crypto.randomUUID(),
        mode: "reset",
        now: Date.now(),
      },
    );
    const fence: OwnerPurgeFence = {
      ownerId: args.ownerId,
      operationId: lifecycle.operationId,
      generation: lifecycle.generation,
    };
    await runOwnerReset(ctx, fence);
    return null;
  },
});

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

const ownerResidueCheck = async (
  name: string,
  read: () => Promise<unknown | null>,
): Promise<string | null> => ((await read()) === null ? null : name);

/**
 * Strict readback for the reset-owned core surfaces. Account/security and
 * billing rows intentionally retained by reset are excluded; account deletion
 * delegates billing removal/readback to `account_billing_purge.ts`.
 */
export const remainingOwnerResetStoresInternal = internalQuery({
  args: { ownerId: v.string() },
  returns: v.array(v.string()),
  handler: async (ctx: QueryCtx, { ownerId }) => {
    const checks = await Promise.all([
      ownerResidueCheck("auth_link_requests.fromOwnerId", () =>
        ctx.db
          .query("auth_link_requests")
          .withIndex("by_fromOwnerId_and_createdAt", (q) =>
            q.eq("fromOwnerId", ownerId),
          )
          .first(),
      ),
      ownerResidueCheck("auth_link_requests.toOwnerId", () =>
        ctx.db
          .query("auth_link_requests")
          .withIndex("by_toOwnerId_and_createdAt", (q) =>
            q.eq("toOwnerId", ownerId),
          )
          .first(),
      ),
      ownerResidueCheck("auth_browser_handoffs", () =>
        ctx.db
          .query("auth_browser_handoffs")
          .withIndex("by_fromOwnerId", (q) => q.eq("fromOwnerId", ownerId))
          .first(),
      ),
    ]);
    return checks.filter((name): name is string => name !== null);
  },
});

const ownerTableValidator = v.union(
  v.literal("auth_revoked_sessions"),
  v.literal("auth_link_requests"),
  v.literal("auth_browser_handoffs"),
);

// Static guard: keeps `ownerTableValidator` and `OWNER_TABLES` in sync. If
// a table is added/removed from one but not the other this file stops
// type-checking. Matches both directions so neither side can drift.
type _OwnerTableMatchesValidator =
  OwnerTable extends Infer<typeof ownerTableValidator>
    ? Infer<typeof ownerTableValidator> extends OwnerTable
      ? true
      : never
    : never;
const _ownerTablesInSync: _OwnerTableMatchesValidator = true;
void _ownerTablesInSync;

/**
 * Deletes one batch of rows from a single owner-scoped table. The orchestrator
 * action loops on `hasMore` and walks `OWNER_TABLES` so that each invocation
 * stays inside one mutation transaction.
 */
export const _deleteOwnerTableBatch = internalMutation({
  args: {
    ownerId: v.string(),
    operationId: v.string(),
    generation: v.string(),
    table: ownerTableValidator,
  },
  returns: v.object({ hasMore: v.boolean() }),
  handler: async (ctx, args) => {
    await assertOwnerPurgeOperation(ctx, args);
    const deleted = await deleteOneOwnerTableBatch(
      ctx,
      args.ownerId,
      args.table,
    );
    return { hasMore: deleted === BATCH };
  },
});

/**
 * Per-table dispatch that keeps the typed `ctx.db.query` / `withIndex`
 * builder. Adding a new owner-scoped table here is a single switch case
 * addition (plus an entry in `OWNER_TABLES`).
 */
async function deleteOneOwnerTableBatch(
  ctx: MutationCtx,
  ownerId: string,
  table: OwnerTable,
): Promise<number> {
  let ids: Id<OwnerTable>[] = [];
  switch (table) {
    case "auth_revoked_sessions": {
      const rows = await ctx.db
        .query("auth_revoked_sessions")
        .withIndex("by_ownerId_and_sessionId", (q) =>
          q.eq("ownerId", ownerId),
        )
        .take(BATCH);
      ids = rows.map((r) => r._id) as Id<OwnerTable>[];
      break;
    }
    case "auth_link_requests": {
      // A completed handoff can name the same account as either principal.
      // Read both indexes, deduplicate, and cap the combined write set.
      const [fromRows, toRows] = await Promise.all([
        ctx.db
          .query("auth_link_requests")
          .withIndex("by_fromOwnerId_and_createdAt", (q) =>
            q.eq("fromOwnerId", ownerId),
          )
          .take(BATCH),
        ctx.db
          .query("auth_link_requests")
          .withIndex("by_toOwnerId_and_createdAt", (q) =>
            q.eq("toOwnerId", ownerId),
          )
          .take(BATCH),
      ]);
      ids = [
        ...new Map(
          [...fromRows, ...toRows].map((row) => [String(row._id), row._id]),
        ).values(),
      ].slice(0, BATCH) as Id<OwnerTable>[];
      break;
    }
    case "auth_browser_handoffs": {
      const rows = await ctx.db
        .query("auth_browser_handoffs")
        .withIndex("by_fromOwnerId", (q) => q.eq("fromOwnerId", ownerId))
        .take(BATCH);
      ids = rows.map((r) => r._id) as Id<OwnerTable>[];
      break;
    }
  }
  await Promise.all(ids.map((id) => ctx.db.delete(id)));
  return ids.length;
}
