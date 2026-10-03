import { closeBilling, closeDevices } from "./billing_bridge";
import {
  internalAction,
  internalQuery,
  type ActionCtx,
  type QueryCtx,
} from "./_generated/server";
import { internal } from "./_generated/api";
import { v } from "convex/values";
import { ensureExternalOwnerPurge } from "./cloud_purge";
import { purgeOwnerMigrationSourceDependencies } from "./lib/owner_migration_purge";

const OWNER_TABLES = [
  "auth_revoked_sessions",
  "auth_link_requests",
  "auth_browser_handoffs",
] as const;

type OwnerTable = (typeof OWNER_TABLES)[number];

const accountResidueCheck = async (
  name: string,
  read: () => Promise<{ length: number }>,
): Promise<string | null> => ((await read()).length > 0 ? name : null);

/** Strict readback for the account-only core surfaces owned by this module. */
export const remainingOwnerAccountCoreStoresInternal = internalQuery({
  args: { ownerId: v.string() },
  returns: v.array(v.string()),
  handler: async (ctx: QueryCtx, { ownerId }) => {
    const checks = await Promise.all([
      accountResidueCheck("auth_revoked_sessions", () =>
        ctx.db
          .query("auth_revoked_sessions")
          .withIndex("by_ownerId_and_sessionId", (q) =>
            q.eq("ownerId", ownerId),
          )
          .take(1),
      ),
    ]);
    return checks.filter((name): name is string => name !== null).sort();
  },
});

/**
 * Drain a single owner-scoped table by repeatedly invoking
 * `_deleteOwnerTableBatch` until `hasMore: false`. Each invocation is its
 * own Convex transaction so the per-mutation read/write limits stay
 * respected.
 */
const drainOwnerTable = async (
  ctx: ActionCtx,
  fence: { ownerId: string; operationId: string; generation: string },
  table: OwnerTable,
) => {
  let hasMore = true;
  while (hasMore) {
    const result: { hasMore: boolean } = await ctx.runMutation(
      internal.reset._deleteOwnerTableBatch,
      { ...fence, table },
    );
    hasMore = result.hasMore;
  }
};

/**
 * Removes Convex-owned data for an owner before Better Auth deletes the user
 * row. The delete-mode counterpart of `resumeOwnerResetInternal` in
 * `reset.ts`, taking an explicit owner id.
 */
export const purgeOwnerCloudData = internalAction({
  args: {
    ownerId: v.string(),
    operationId: v.string(),
    generation: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const lifecycle: {
      operationId: string;
      generation: string;
      mode: "reset" | "delete";
    } = await ctx.runMutation(
      internal.owner_lifecycle.beginOwnerDataPurgeInternal,
      {
        ownerId: args.ownerId,
        operationId: args.operationId,
        mode: "delete",
        now: Date.now(),
      },
    );
    if (
      lifecycle.operationId !== args.operationId ||
      lifecycle.generation !== args.generation ||
      lifecycle.mode !== "delete"
    ) {
      throw new Error("Account deletion lifecycle generation changed.");
    }
    const fence = {
      ownerId: args.ownerId,
      operationId: args.operationId,
      generation: args.generation,
    };
    const { ownerId } = fence;
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
    if (claim.complete) return null;
    if (!claim.claimed) {
      const job: { stage: "core" | "cloud" | "complete" } | null =
        await ctx.runQuery(internal.owner_lifecycle.getOwnerPurgeJobInternal, {
          ownerId,
          operationId: fence.operationId,
        });
      if (job?.stage === "cloud") {
        await ctx.runAction(internal.cloud_purge.purgeOwnerCloudStack, fence);
        return null;
      }
      throw new Error("Account deletion core stage is already leased.");
    }
    let retryStage: "core" | "cloud" = "core";
    try {
      await ensureExternalOwnerPurge(ctx, { ...fence, mode: "delete" });
      await purgeOwnerMigrationSourceDependencies(ctx, {
        ...fence,
        leaseId,
        mode: "delete",
      });
      const authMigration = await ctx.runMutation(
        internal.auth_migration.quiesceAndMinimizeOwnerAuthMigrationsInternal,
        { ...fence, leaseId, mode: "delete" },
      );
      if (!authMigration.ready) {
        throw new Error(
          `Account deletion is waiting for auth migration quiescence: ${authMigration.pending.join(", ")}`,
        );
      }
      // Billing and devices live in the owner's object on cloud-builder:
      // deleting the Stripe customer ends any subscription, and the owner's
      // Cloudflare tunnels go with the account.
      await closeBilling(ownerId);
      await closeDevices(ownerId);
      // Owner-scoped tables are independent — drain them concurrently.
      await Promise.all(
        OWNER_TABLES.map((table) => drainOwnerTable(ctx, fence, table)),
      );

      const remainingAuth = await ctx.runMutation(
        internal.auth_migration.remainingOwnerAuthMigrationResidueInternal,
        { ...fence, leaseId, mode: "delete" },
      );
      if (remainingAuth.length > 0) {
        throw new Error(
          `Account deletion auth purge is incomplete: ${remainingAuth.join(", ")}`,
        );
      }
      const [remainingResetCore, remainingAccountCore] = await Promise.all([
        ctx.runQuery(internal.reset.remainingOwnerResetStoresInternal, {
          ownerId,
        }),
        ctx.runQuery(
          internal.account_deletion.remainingOwnerAccountCoreStoresInternal,
          { ownerId },
        ),
      ]);
      const remainingCore = [...remainingResetCore, ...remainingAccountCore];
      if (remainingCore.length > 0) {
        throw new Error(
          `Account deletion core purge is incomplete: ${remainingCore.join(", ")}`,
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
      if (!advanced) {
        throw new Error("Account deletion core lease was superseded.");
      }
      retryStage = "cloud";
      // Whole cloud-stack completeness is strict for both modes. Delete keeps
      // every external/relay/lifecycle fence permanently blocked on success.
      await ctx.runAction(internal.cloud_purge.purgeOwnerCloudStack, fence);
      return null;
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
  },
});
