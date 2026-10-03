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
import { makeFunctionReference } from "convex/server";
import {
  ensureExternalOwnerPurge,
  quiesceOwnerIntegrationCalls,
} from "./cloud_purge";
import { purgeOwnerMigrationSourceDependencies } from "./lib/owner_migration_purge";
import { assertOwnerPurgeOperation } from "./owner_lifecycle";

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
 * Per-mutation deletion batch size. Conservative because each `reset.*` call
 * runs inside a single Convex transaction and we want to stay well below the
 * read/write limits even when the caller chains many invocations.
 */
const BATCH = 200;

/** How many conversation ids we'll fetch in one paginated page. */
const CONVERSATION_PAGE = 200;

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
  ["user_counters", "by_ownerId"],
  ["x_oauth_states", "by_ownerId_and_expiresAt"],
  ["x_oauth_tokens", "by_ownerId"],
  ["connector_turn_payloads", "by_ownerId_and_createdAt"],
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
    const remoteTurns = await ctx.runMutation(
      internal.channels.connector_delivery
        .quiesceOwnerRemoteTurnsForPurgeInternal,
      { ...fence, leaseId, mode: "reset", now: Date.now() },
    );
    if (!remoteTurns.ready) {
      throw new Error(
        `Owner reset is waiting for remote-turn execution quiescence${remoteTurns.retryAfterAt === null ? "" : ` until ${remoteTurns.retryAfterAt}`}.`,
      );
    }
    const integrationCalls = await quiesceOwnerIntegrationCalls(
      ctx,
      fence.ownerId,
    );
    if (!integrationCalls.ready) {
      throw new Error(
        "Owner reset is waiting for a Code connected-tool dispatch lease to expire; its replay receipt was retained for retry.",
      );
    }
    const composioProvisioning = await ctx.runMutation(
      quiesceOwnerComposioProvisioningRef,
      { ...fence, leaseId, mode: "reset", now: Date.now() },
    );
    if (!composioProvisioning.ready) {
      throw new Error(
        `Owner reset is waiting for Composio session provisioning to reconcile: ${composioProvisioning.pending.join(", ")}`,
      );
    }
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
    let cursor: string | null = null;
    while (true) {
      const page: { ids: Id<"conversations">[]; nextCursor: string | null } =
        await ctx.runQuery(internal.reset._listConversationIdsPage, {
          ownerId: fence.ownerId,
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
      ctx.runAction(internal.data.canvas_shares_actions.purgeOwnerShares, {
        ownerUserId: fence.ownerId,
        operationId: fence.operationId,
        generation: fence.generation,
        leaseId,
        mode: "reset",
      }),
    ]);

    // Close the admission-to-dispatch edge for creators that reserved their
    // external locator just before the lifecycle fence became visible.
    await ctx.runAction(internal.data.canvas_shares_actions.purgeOwnerShares, {
      ownerUserId: fence.ownerId,
      operationId: fence.operationId,
      generation: fence.generation,
      leaseId,
      mode: "reset",
    });
    const finalRemoteTurns = await ctx.runMutation(
      internal.channels.connector_delivery
        .quiesceOwnerRemoteTurnsForPurgeInternal,
      { ...fence, leaseId, mode: "reset", now: Date.now() },
    );
    if (!finalRemoteTurns.ready) {
      throw new Error(
        "Owner reset remote-turn execution debt reappeared after the conversation drain.",
      );
    }
    const [
      remainingResetCore,
      remainingComposioProvisioning,
    ] = await Promise.all([
      ctx.runQuery(internal.reset.remainingOwnerResetStoresInternal, {
        ownerId: fence.ownerId,
      }),
      ctx.runQuery(remainingOwnerComposioProvisioningRef, {
        ownerId: fence.ownerId,
      }),
    ]);
    const remainingCore = [
      ...remainingResetCore,
      ...remainingComposioProvisioning,
    ];
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
      ownerResidueCheck("conversations", () =>
        ctx.db
          .query("conversations")
          .withIndex("by_ownerId_and_updatedAt", (q) =>
            q.eq("ownerId", ownerId),
          )
          .first(),
      ),
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
      ownerResidueCheck("user_counters", () =>
        ctx.db
          .query("user_counters")
          .withIndex("by_ownerId", (q) => q.eq("ownerId", ownerId))
          .first(),
      ),
      ownerResidueCheck("x_oauth_states", () =>
        ctx.db
          .query("x_oauth_states")
          .withIndex("by_ownerId_and_expiresAt", (q) =>
            q.eq("ownerId", ownerId),
          )
          .first(),
      ),
      ownerResidueCheck("x_oauth_tokens", () =>
        ctx.db
          .query("x_oauth_tokens")
          .withIndex("by_ownerId", (q) => q.eq("ownerId", ownerId))
          .first(),
      ),
      ownerResidueCheck("connector_turn_payloads", () =>
        ctx.db
          .query("connector_turn_payloads")
          .withIndex("by_ownerId_and_createdAt", (q) =>
            q.eq("ownerId", ownerId),
          )
          .first(),
      ),
      ownerResidueCheck("canvas_shares", () =>
        ctx.db
          .query("canvas_shares")
          .withIndex("by_ownerUserId", (q) => q.eq("ownerUserId", ownerId))
          .first(),
      ),
    ]);
    return checks.filter((name): name is string => name !== null);
  },
});

export const _listConversationIdsPage = internalQuery({
  args: {
    ownerId: v.string(),
    cursor: v.union(v.string(), v.null()),
  },
  returns: v.object({
    ids: v.array(v.id("conversations")),
    nextCursor: v.union(v.string(), v.null()),
  }),
  handler: async (ctx, { ownerId, cursor }) => {
    const page = await ctx.db
      .query("conversations")
      .withIndex("by_ownerId_and_updatedAt", (q) => q.eq("ownerId", ownerId))
      .paginate({ cursor, numItems: CONVERSATION_PAGE });
    return {
      ids: page.page.map((c) => c._id),
      nextCursor: page.isDone ? null : page.continueCursor,
    };
  },
});

export const _deleteConversationBatch = internalMutation({
  args: {
    ownerId: v.string(),
    operationId: v.string(),
    generation: v.string(),
    conversationId: v.id("conversations"),
  },
  returns: v.object({ hasMore: v.boolean() }),
  handler: async (ctx, args) => {
    await assertOwnerPurgeOperation(ctx, args);
    const { conversationId } = args;
    const conv = await ctx.db.get(conversationId);
    if (!conv || conv.ownerId !== args.ownerId) return { hasMore: false };
    // Conversation rows are the authority/locator for remote execution. Even
    // if a future orchestrator accidentally skips the explicit quiescence
    // phase, fail closed before deleting *any* event while an owner-bound or
    // legacy attempt is active or waiting through its transport grace period.
    // The conversation-local lookups are required for pre-schema rows that do
    // not have an ownerId at all; owner-wide indexes alone cannot see them.
    const [
      activeRemoteTurn,
      cancellingRemoteTurn,
      activeConversationRemoteTurn,
      cancellingConversationRemoteTurn,
    ] = await Promise.all([
      ctx.db
        .query("events")
        .withIndex("by_ownerId_activeAttemptState", (q) =>
          q.eq("ownerId", args.ownerId).eq("activeAttemptState", "active"),
        )
        .first(),
      ctx.db
        .query("events")
        .withIndex("by_ownerId_activeAttemptState", (q) =>
          q
            .eq("ownerId", args.ownerId)
            .eq("activeAttemptState", "cancel_requested"),
        )
        .first(),
      ctx.db
        .query("events")
        .withIndex("by_conversationId_activeAttemptState", (q) =>
          q
            .eq("conversationId", conversationId)
            .eq("activeAttemptState", "active"),
        )
        .first(),
      ctx.db
        .query("events")
        .withIndex("by_conversationId_activeAttemptState", (q) =>
          q
            .eq("conversationId", conversationId)
            .eq("activeAttemptState", "cancel_requested"),
        )
        .first(),
    ]);
    if (
      activeRemoteTurn ||
      cancellingRemoteTurn ||
      activeConversationRemoteTurn ||
      cancellingConversationRemoteTurn
    ) {
      throw new Error(
        "Remote-turn execution must be quiescent before conversation deletion.",
      );
    }
    // Phase A: drain `events` for this conversation in tight batches. We
    // process events first so they always disappear before the conversation
    // row itself.
    const events = await ctx.db
      .query("events")
      .withIndex("by_conversationId_and_timestamp", (q) =>
        q.eq("conversationId", conversationId),
      )
      .take(BATCH);
    if (events.length > 0) {
      await Promise.all(events.map((e) => ctx.db.delete(e._id)));
      return { hasMore: true };
    }

    // Phase B: drain ONE thread's messages per call. Doing this per-thread
    // keeps the per-mutation read/write count bounded by `BATCH` even if a
    // conversation has hundreds of threads with thousands of messages each.
    const [thread] = await ctx.db
      .query("threads")
      .withIndex("by_conversationId_and_lastUsedAt", (q) =>
        q.eq("conversationId", conversationId),
      )
      .take(1);
    if (thread) {
      const messages = await ctx.db
        .query("thread_messages")
        .withIndex("by_threadId_and_ordinal", (q) =>
          q.eq("threadId", thread._id),
        )
        .take(BATCH);
      if (messages.length > 0) {
        await Promise.all(messages.map((m) => ctx.db.delete(m._id)));
        return { hasMore: true };
      }
      // No more messages for this thread — delete the thread row and let the
      // caller invoke us again to advance to the next thread / conversation
      // tear-down phase.
      await ctx.db.delete(thread._id);
      return { hasMore: true };
    }

    // Phase B': connector_turn_payloads is a child table keyed by
    // conversationId. Drain it before deleting the conversation row so we
    // don't leave dangling FK references.
    const turnPayloads = await ctx.db
      .query("connector_turn_payloads")
      .withIndex("by_conversationId", (q) =>
        q.eq("conversationId", conversationId),
      )
      .take(BATCH);
    if (turnPayloads.length > 0) {
      await Promise.all(turnPayloads.map((row) => ctx.db.delete(row._id)));
      return { hasMore: true };
    }

    // Phase B'': attachments reference both the conversation and a
    // `_storage` blob. Delete the blob alongside each row so reset doesn't
    // leave dangling FK references or leak storage objects.
    const attachments = await ctx.db
      .query("attachments")
      .withIndex("by_conversationId", (q) =>
        q.eq("conversationId", conversationId),
      )
      .take(BATCH);
    if (attachments.length > 0) {
      await Promise.all(
        attachments.map(async (row) => {
          await ctx.storage.delete(row.storageKey);
          await ctx.db.delete(row._id);
        }),
      );
      return { hasMore: true };
    }

    // Phase B''': pending_device_selections is a child table keyed by
    // conversationId. Drain it before deleting the conversation row so we
    // don't leave dangling FK references.
    const pendingSelections = await ctx.db
      .query("pending_device_selections")
      .withIndex("by_conversationId", (q) =>
        q.eq("conversationId", conversationId),
      )
      .take(BATCH);
    if (pendingSelections.length > 0) {
      await Promise.all(pendingSelections.map((row) => ctx.db.delete(row._id)));
      // The unique constraint means this almost always returns 0 or 1, so
      // we don't need a `hasMore: true` round-trip here.
    }

    // Phase C: events + threads are gone — delete the conversation row and
    // decrement the denormalized counter so quota checks stay accurate.
    await ctx.db.delete(conversationId);
    const counter = await ctx.db
      .query("user_counters")
      .withIndex("by_ownerId", (q) => q.eq("ownerId", conv.ownerId))
      .unique();
    if (counter) {
      const next = Math.max(0, (counter.conversationCount ?? 0) - 1);
      await ctx.db.patch(counter._id, {
        conversationCount: next,
        updatedAt: Date.now(),
      });
    }
    return { hasMore: false };
  },
});

const ownerTableValidator = v.union(
  v.literal("auth_revoked_sessions"),
  v.literal("auth_link_requests"),
  v.literal("auth_browser_handoffs"),
  v.literal("user_counters"),
  v.literal("x_oauth_states"),
  v.literal("x_oauth_tokens"),
  v.literal("connector_turn_payloads"),
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
    case "user_counters": {
      const rows = await ctx.db
        .query("user_counters")
        .withIndex("by_ownerId", (q) => q.eq("ownerId", ownerId))
        .take(BATCH);
      ids = rows.map((r) => r._id) as Id<OwnerTable>[];
      break;
    }
    case "x_oauth_states": {
      const rows = await ctx.db
        .query("x_oauth_states")
        .withIndex("by_ownerId_and_expiresAt", (q) => q.eq("ownerId", ownerId))
        .take(BATCH);
      ids = rows.map((r) => r._id) as Id<OwnerTable>[];
      break;
    }
    case "x_oauth_tokens": {
      const rows = await ctx.db
        .query("x_oauth_tokens")
        .withIndex("by_ownerId", (q) => q.eq("ownerId", ownerId))
        .take(BATCH);
      ids = rows.map((r) => r._id) as Id<OwnerTable>[];
      break;
    }
    case "connector_turn_payloads": {
      const rows = await ctx.db
        .query("connector_turn_payloads")
        .withIndex("by_ownerId_and_createdAt", (q) => q.eq("ownerId", ownerId))
        .take(BATCH);
      ids = rows.map((r) => r._id) as Id<OwnerTable>[];
      break;
    }
  }
  await Promise.all(ids.map((id) => ctx.db.delete(id)));
  return ids.length;
}
