import { closeBilling, closeDevices } from "./billing_bridge";
import {
  internalAction,
  internalMutation,
  internalQuery,
  type ActionCtx,
  type MutationCtx,
  type QueryCtx,
} from "./_generated/server";
import { internal } from "./_generated/api";
import type { Id, TableNames } from "./_generated/dataModel";
import { ConvexError, v, type VLiteral } from "convex/values";
import { makeFunctionReference } from "convex/server";
import {
  ensureExternalOwnerPurge,
  quiesceOwnerIntegrationCalls,
} from "./cloud_purge";
import {
  assertOwnerDataWriteAllowed,
  assertOwnerPurgeLease,
  assertOwnerPurgeOperation,
} from "./owner_lifecycle";
import { purgeOwnerMigrationSourceDependencies } from "./lib/owner_migration_purge";

const OWNER_TABLES = [
  "auth_revoked_sessions",
  "auth_link_requests",
  "auth_browser_handoffs",
  "user_counters",
  "x_oauth_states",
  "x_oauth_tokens",
  "connector_turn_payloads",
] as const;

type OwnerTable = (typeof OWNER_TABLES)[number];

const purgeOwnerComposioSessionsRef = makeFunctionReference<
  "action",
  {
    ownerId: string;
    operationId: string;
    generation: string;
    leaseId: string;
  },
  { ready: boolean; pending: string[] }
>("composio_purge:purgeOwnerComposioSessionsInternal");
const remainingOwnerComposioSessionsRef = makeFunctionReference<
  "action",
  { ownerId: string },
  string[]
>("composio_purge:remainingOwnerComposioSessionsInternal");
const quiesceOwnerComposioProvisioningRef = makeFunctionReference<
  "mutation",
  {
    ownerId: string;
    operationId: string;
    generation: string;
    leaseId: string;
    mode: "reset" | "delete";
    now: number;
  },
  { ready: boolean; pending: string[]; retryAt: number | null }
>(
  "composio_session_dispatch:quiesceOwnerComposioSessionProvisioningForPurgeInternal",
);
const remainingOwnerComposioProvisioningRef = makeFunctionReference<
  "query",
  { ownerId: string },
  string[]
>(
  "composio_session_dispatch:remainingOwnerComposioSessionProvisioningInternal",
);

/**
 * Owner-keyed tables not covered by `reset._deleteOwnerTableBatch` (whose
 * list doubles as the user-facing "reset my data" scope). Account deletion
 * must additionally wipe private/user-content tables: secrets, integrations,
 * and channel links.
 */
const EXTRA_TABLES = [
  "secrets",
  "secret_access_audit",
  "agents",
] as const;

type ExtraTable = (typeof EXTRA_TABLES)[number];

const EXTRA_BATCH = 200;

async function deleteOneExtraTableBatch(
  ctx: MutationCtx,
  ownerId: string,
  table: ExtraTable,
): Promise<boolean> {
  const batch = EXTRA_BATCH;
  let ids: Id<TableNames>[] = [];
  switch (table) {
    case "secrets": {
      const rows = await ctx.db
        .query("secrets")
        .withIndex("by_ownerId_and_updatedAt", (q) => q.eq("ownerId", ownerId))
        .take(batch);
      ids = rows.map((r) => r._id);
      break;
    }
    case "secret_access_audit": {
      const rows = await ctx.db
        .query("secret_access_audit")
        .withIndex("by_ownerId_and_createdAt", (q) => q.eq("ownerId", ownerId))
        .take(batch);
      ids = rows.map((r) => r._id);
      break;
    }
    case "agents": {
      const rows = await ctx.db
        .query("agents")
        .withIndex("by_ownerId_and_updatedAt", (q) => q.eq("ownerId", ownerId))
        .take(batch);
      ids = rows.map((r) => r._id);
      break;
    }
    default: {
      const exhaustive: never = table;
      throw new Error(`Unhandled extra table: ${String(exhaustive)}`);
    }
  }
  await Promise.all(ids.map((id) => ctx.db.delete(id)));
  return ids.length === batch;
}

export const _deleteExtraTableBatch = internalMutation({
  args: {
    ownerId: v.string(),
    operationId: v.string(),
    generation: v.string(),
    table: v.union(
      ...(EXTRA_TABLES.map((table) => v.literal(table)) as [
        VLiteral<ExtraTable>,
        VLiteral<ExtraTable>,
        ...VLiteral<ExtraTable>[],
      ]),
    ),
  },
  returns: v.object({ hasMore: v.boolean() }),
  handler: async (ctx, args) => {
    await assertOwnerPurgeOperation(ctx, args);
    const { ownerId, table } = args;
    const hasMore = await deleteOneExtraTableBatch(ctx, ownerId, table);
    return { hasMore };
  },
});

/**
 * Composio-mode rows are durable external-deletion locators and are never
 * touched by a generic drain. Once the provider-owned action proves that
 * partition empty, this exact delete-lease mutation removes local-only
 * integration rows in bounded batches.
 */
export const _deleteOwnerNonComposioIntegrationsBatch = internalMutation({
  args: {
    ownerId: v.string(),
    operationId: v.string(),
    generation: v.string(),
    leaseId: v.string(),
  },
  returns: v.object({ hasMore: v.boolean() }),
  handler: async (ctx, args) => {
    await assertOwnerPurgeLease(ctx, {
      ...args,
      stage: "core",
      mode: "delete",
    });
    const rows = await ctx.db
      .query("user_integrations")
      .withIndex("by_ownerId_and_updatedAt", (q) =>
        q.eq("ownerId", args.ownerId),
      )
      .take(EXTRA_BATCH);
    if (rows.some((row) => row.mode === "composio")) {
      throw new Error(
        "Composio external deletion debt must clear before local integration rows are drained.",
      );
    }
    await Promise.all(rows.map((row) => ctx.db.delete(row._id)));
    return { hasMore: rows.length === EXTRA_BATCH };
  },
});

const drainOwnerNonComposioIntegrations = async (
  ctx: ActionCtx,
  fence: {
    ownerId: string;
    operationId: string;
    generation: string;
    leaseId: string;
  },
) => {
  let hasMore = true;
  while (hasMore) {
    const result: { hasMore: boolean } = await ctx.runMutation(
      internal.account_deletion._deleteOwnerNonComposioIntegrationsBatch,
      fence,
    );
    hasMore = result.hasMore;
  }
};

const drainExtraTable = async (
  ctx: ActionCtx,
  fence: { ownerId: string; operationId: string; generation: string },
  table: ExtraTable,
) => {
  let hasMore = true;
  while (hasMore) {
    const result: { hasMore: boolean } = await ctx.runMutation(
      internal.account_deletion._deleteExtraTableBatch,
      { ...fence, table },
    );
    hasMore = result.hasMore;
  }
};

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
      accountResidueCheck("secrets", () =>
        ctx.db
          .query("secrets")
          .withIndex("by_ownerId_and_updatedAt", (q) =>
            q.eq("ownerId", ownerId),
          )
          .take(1),
      ),
      accountResidueCheck("secret_access_audit", () =>
        ctx.db
          .query("secret_access_audit")
          .withIndex("by_ownerId_and_createdAt", (q) =>
            q.eq("ownerId", ownerId),
          )
          .take(1),
      ),
      accountResidueCheck("user_integrations", () =>
        ctx.db
          .query("user_integrations")
          .withIndex("by_ownerId_and_provider", (q) => q.eq("ownerId", ownerId))
          .take(1),
      ),
      accountResidueCheck("agents", () =>
        ctx.db
          .query("agents")
          .withIndex("by_ownerId_and_updatedAt", (q) =>
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
      const remoteTurns = await ctx.runMutation(
        internal.channels.connector_delivery
          .quiesceOwnerRemoteTurnsForPurgeInternal,
        { ...fence, leaseId, mode: "delete", now: Date.now() },
      );
      if (!remoteTurns.ready) {
        throw new Error(
          `Account deletion is waiting for remote-turn execution quiescence${remoteTurns.retryAfterAt === null ? "" : ` until ${remoteTurns.retryAfterAt}`}.`,
        );
      }
      const integrationCalls = await quiesceOwnerIntegrationCalls(ctx, ownerId);
      if (!integrationCalls.ready) {
        throw new Error(
          "Account deletion is waiting for a Code connected-tool dispatch lease to expire; its replay receipt was retained for retry.",
        );
      }
      const composioProvisioning = await ctx.runMutation(
        quiesceOwnerComposioProvisioningRef,
        { ...fence, leaseId, mode: "delete", now: Date.now() },
      );
      if (!composioProvisioning.ready) {
        throw new Error(
          `Account deletion is waiting for Composio session provisioning to reconcile: ${composioProvisioning.pending.join(", ")}`,
        );
      }
      // A read-only Code integration call can still be physically executing
      // through the owner's Composio session when the deletion fence lands.
      // Keep the external credential/session locator intact until that exact
      // dispatch lease is terminal or expired, then revoke provider state
      // before deleting any local integration row.
      const composio = await ctx.runAction(purgeOwnerComposioSessionsRef, {
        ...fence,
        leaseId,
      });
      if (!composio.ready) {
        throw new Error(
          `Account deletion is waiting for Composio credential/session revocation: ${composio.pending.join(", ")}`,
        );
      }
      await drainOwnerNonComposioIntegrations(ctx, { ...fence, leaseId });
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
      let cursor: string | null = null;
      while (true) {
        const page: { ids: Id<"conversations">[]; nextCursor: string | null } =
          await ctx.runQuery(internal.reset._listConversationIdsPage, {
            ownerId,
            cursor,
          });
        for (const conversationId of page.ids) {
          let hasMore = true;
          while (hasMore) {
            const result: { hasMore: boolean } = await ctx.runMutation(
              internal.reset._deleteConversationBatch,
              { ...fence, conversationId },
            );
            hasMore = result.hasMore;
          }
        }
        if (page.nextCursor === null) break;
        cursor = page.nextCursor;
      }

      // Owner-scoped tables are independent — drain them concurrently.
      await Promise.all([
        ...OWNER_TABLES.map((table) => drainOwnerTable(ctx, fence, table)),
        ...EXTRA_TABLES.map((table) => drainExtraTable(ctx, fence, table)),
        // Canvas shares: delete R2 objects + rows for this owner.
        ctx.runAction(internal.data.canvas_shares_actions.purgeOwnerShares, {
          ownerUserId: ownerId,
          operationId: fence.operationId,
          generation: fence.generation,
          leaseId,
          mode: "delete",
        }),
      ]);

      // Final external re-drain closes the window for a creator that reserved
      // its durable locator immediately before the deletion fence. Active
      // reservations remain retry debt until their bounded lease ends.
      await ctx.runAction(
        internal.data.canvas_shares_actions.purgeOwnerShares,
        {
          ownerUserId: ownerId,
          operationId: fence.operationId,
          generation: fence.generation,
          leaseId,
          mode: "delete",
        },
      );

      const finalRemoteTurns = await ctx.runMutation(
        internal.channels.connector_delivery
          .quiesceOwnerRemoteTurnsForPurgeInternal,
        { ...fence, leaseId, mode: "delete", now: Date.now() },
      );
      if (!finalRemoteTurns.ready) {
        throw new Error(
          "Account deletion remote-turn execution debt reappeared after the conversation drain.",
        );
      }

      const remainingAuth = await ctx.runMutation(
        internal.auth_migration.remainingOwnerAuthMigrationResidueInternal,
        { ...fence, leaseId, mode: "delete" },
      );
      if (remainingAuth.length > 0) {
        throw new Error(
          `Account deletion auth purge is incomplete: ${remainingAuth.join(", ")}`,
        );
      }
      const [
        remainingResetCore,
        remainingAccountCore,
        remainingComposio,
        remainingComposioProvisioning,
      ] = await Promise.all([
        ctx.runQuery(internal.reset.remainingOwnerResetStoresInternal, {
          ownerId,
        }),
        ctx.runQuery(
          internal.account_deletion.remainingOwnerAccountCoreStoresInternal,
          { ownerId },
        ),
        ctx.runAction(remainingOwnerComposioSessionsRef, { ownerId }),
        ctx.runQuery(remainingOwnerComposioProvisioningRef, { ownerId }),
      ]);
      const remainingCore = [
        ...remainingResetCore,
        ...remainingAccountCore,
        ...remainingComposio,
        ...remainingComposioProvisioning,
      ];
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
