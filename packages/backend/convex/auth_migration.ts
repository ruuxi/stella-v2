import { v } from "convex/values";
import {
  internalAction,
  internalMutation,
  type ActionCtx,
  type MutationCtx,
} from "./_generated/server";
import { internal } from "./_generated/api";
import type { FunctionReference } from "convex/server";

const BATCH_SIZE = 500;

const ownerArgs = { fromOwnerId: v.string(), toOwnerId: v.string() } as const;
const hasMoreReturn = v.object({ hasMore: v.boolean() });

const isFullPage = (rows: readonly unknown[]) => rows.length === BATCH_SIZE;

export const migrateConversationsBatch = internalMutation({
  args: ownerArgs,
  returns: hasMoreReturn,
  handler: async (ctx: MutationCtx, args) => {
    const rows = await ctx.db
      .query("conversations")
      .withIndex("by_ownerId_and_updatedAt", (q) =>
        q.eq("ownerId", args.fromOwnerId),
      )
      .take(BATCH_SIZE);
    await Promise.all(
      rows.map((row) => ctx.db.patch(row._id, { ownerId: args.toOwnerId })),
    );
    return { hasMore: isFullPage(rows) };
  },
});

export const migrateUserPreferencesBatch = internalMutation({
  args: ownerArgs,
  returns: hasMoreReturn,
  handler: async (ctx: MutationCtx, args) => {
    const rows = await ctx.db
      .query("user_preferences")
      .withIndex("by_ownerId_and_key", (q) => q.eq("ownerId", args.fromOwnerId))
      .take(BATCH_SIZE);

    for (const row of rows) {
      const existing = await ctx.db
        .query("user_preferences")
        .withIndex("by_ownerId_and_key", (q) =>
          q.eq("ownerId", args.toOwnerId).eq("key", row.key),
        )
        .unique();
      if (existing) {
        await ctx.db.delete(row._id);
      } else {
        await ctx.db.patch(row._id, { ownerId: args.toOwnerId });
      }
    }
    return { hasMore: isFullPage(rows) };
  },
});

export const migrateAuthSessionPoliciesBatch = internalMutation({
  args: ownerArgs,
  returns: hasMoreReturn,
  handler: async (ctx: MutationCtx, args) => {
    const rows = await ctx.db
      .query("auth_revoked_sessions")
      .withIndex("by_ownerId_and_sessionId", (q) =>
        q.eq("ownerId", args.fromOwnerId),
      )
      .take(BATCH_SIZE);

    for (const row of rows) {
      const existing = await ctx.db
        .query("auth_revoked_sessions")
        .withIndex("by_ownerId_and_sessionId", (q) =>
          q.eq("ownerId", args.toOwnerId).eq("sessionId", row.sessionId),
        )
        .unique();
      if (existing) {
        if (row.expiresAt > existing.expiresAt) {
          await ctx.db.patch(existing._id, {
            expiresAt: row.expiresAt,
            revokedAt: Math.max(existing.revokedAt, row.revokedAt),
          });
        }
        await ctx.db.delete(row._id);
      } else {
        await ctx.db.patch(row._id, { ownerId: args.toOwnerId });
      }
    }
    return { hasMore: isFullPage(rows) };
  },
});

export const migrateSecretsBatch = internalMutation({
  args: ownerArgs,
  returns: hasMoreReturn,
  handler: async (ctx: MutationCtx, args) => {
    const rows = await ctx.db
      .query("secrets")
      .withIndex("by_ownerId_and_updatedAt", (q) =>
        q.eq("ownerId", args.fromOwnerId),
      )
      .take(BATCH_SIZE);
    await Promise.all(
      rows.map((row) => ctx.db.patch(row._id, { ownerId: args.toOwnerId })),
    );
    return { hasMore: isFullPage(rows) };
  },
});

export const migrateSecretAccessAuditBatch = internalMutation({
  args: ownerArgs,
  returns: hasMoreReturn,
  handler: async (ctx: MutationCtx, args) => {
    const rows = await ctx.db
      .query("secret_access_audit")
      .withIndex("by_ownerId_and_createdAt", (q) =>
        q.eq("ownerId", args.fromOwnerId),
      )
      .take(BATCH_SIZE);
    await Promise.all(
      rows.map((row) => ctx.db.patch(row._id, { ownerId: args.toOwnerId })),
    );
    return { hasMore: isFullPage(rows) };
  },
});

export const migrateUserIntegrationsBatch = internalMutation({
  args: ownerArgs,
  returns: hasMoreReturn,
  handler: async (ctx: MutationCtx, args) => {
    const rows = await ctx.db
      .query("user_integrations")
      .withIndex("by_ownerId_and_updatedAt", (q) =>
        q.eq("ownerId", args.fromOwnerId),
      )
      .take(BATCH_SIZE);

    for (const row of rows) {
      const existing = await ctx.db
        .query("user_integrations")
        .withIndex("by_ownerId_and_provider", (q) =>
          q.eq("ownerId", args.toOwnerId).eq("provider", row.provider),
        )
        .unique();
      if (existing) {
        await ctx.db.delete(row._id);
      } else {
        await ctx.db.patch(row._id, { ownerId: args.toOwnerId });
      }
    }
    return { hasMore: isFullPage(rows) };
  },
});

export const migrateUsageLogsBatch = internalMutation({
  args: ownerArgs,
  returns: hasMoreReturn,
  handler: async (ctx: MutationCtx, args) => {
    const rows = await ctx.db
      .query("usage_logs")
      .withIndex("by_ownerId_and_createdAt", (q) =>
        q.eq("ownerId", args.fromOwnerId),
      )
      .take(BATCH_SIZE);
    await Promise.all(
      rows.map((row) => ctx.db.patch(row._id, { ownerId: args.toOwnerId })),
    );
    return { hasMore: isFullPage(rows) };
  },
});

export const migrateConnectorTurnPayloadsBatch = internalMutation({
  args: ownerArgs,
  returns: hasMoreReturn,
  handler: async (ctx: MutationCtx, args) => {
    const rows = await ctx.db
      .query("connector_turn_payloads")
      .withIndex("by_ownerId_and_createdAt", (q) =>
        q.eq("ownerId", args.fromOwnerId),
      )
      .take(BATCH_SIZE);
    await Promise.all(
      rows.map((row) => ctx.db.patch(row._id, { ownerId: args.toOwnerId })),
    );
    return { hasMore: isFullPage(rows) };
  },
});

export const migrateAgentsBatch = internalMutation({
  args: ownerArgs,
  returns: hasMoreReturn,
  handler: async (ctx: MutationCtx, args) => {
    const rows = await ctx.db
      .query("agents")
      .withIndex("by_ownerId_and_updatedAt", (q) =>
        q.eq("ownerId", args.fromOwnerId),
      )
      .take(BATCH_SIZE);
    await Promise.all(
      rows.map((row) => ctx.db.patch(row._id, { ownerId: args.toOwnerId })),
    );
    return { hasMore: isFullPage(rows) };
  },
});

export const migrateMediaJobsBatch = internalMutation({
  args: ownerArgs,
  returns: hasMoreReturn,
  handler: async (ctx: MutationCtx, args) => {
    const rows = await ctx.db
      .query("media_jobs")
      .withIndex("by_ownerId_and_createdAt", (q) =>
        q.eq("ownerId", args.fromOwnerId),
      )
      .take(BATCH_SIZE);
    for (const row of rows) {
      const existing = row.clientRequestKey
        ? await ctx.db
            .query("media_jobs")
            .withIndex("by_ownerId_and_clientRequestKey", (q) =>
              q
                .eq("ownerId", args.toOwnerId)
                .eq("clientRequestKey", row.clientRequestKey),
            )
            .unique()
        : null;

      await ctx.db.patch(row._id, {
        ownerId: args.toOwnerId,
        ...(existing
          ? { clientRequestKey: undefined, clientRequestHash: undefined }
          : {}),
      });
    }
    return { hasMore: isFullPage(rows) };
  },
});

export const migrateMediaRequestCancellationsBatch = internalMutation({
  args: ownerArgs,
  returns: hasMoreReturn,
  handler: async (ctx: MutationCtx, args) => {
    const rows = await ctx.db
      .query("media_request_cancellations")
      .withIndex("by_ownerId_and_clientRequestKey", (q) =>
        q.eq("ownerId", args.fromOwnerId),
      )
      .take(BATCH_SIZE);
    for (const row of rows) {
      const existing = await ctx.db
        .query("media_request_cancellations")
        .withIndex("by_ownerId_and_clientRequestKey", (q) =>
          q
            .eq("ownerId", args.toOwnerId)
            .eq("clientRequestKey", row.clientRequestKey),
        )
        .unique();
      if (existing) {
        await ctx.db.delete(row._id);
      } else {
        await ctx.db.patch(row._id, { ownerId: args.toOwnerId });
      }
    }
    return { hasMore: isFullPage(rows) };
  },
});

export const migrateMediaJobLogsBatch = internalMutation({
  args: ownerArgs,
  returns: hasMoreReturn,
  handler: async (ctx: MutationCtx, args) => {
    const rows = await ctx.db
      .query("media_job_logs")
      .withIndex("by_ownerId_and_jobId", (q) =>
        q.eq("ownerId", args.fromOwnerId),
      )
      .take(BATCH_SIZE);
    await Promise.all(
      rows.map((row) => ctx.db.patch(row._id, { ownerId: args.toOwnerId })),
    );
    return { hasMore: isFullPage(rows) };
  },
});

export const migrateUserCountersBatch = internalMutation({
  args: ownerArgs,
  returns: hasMoreReturn,
  handler: async (ctx: MutationCtx, args) => {
    const rows = await ctx.db
      .query("user_counters")
      .withIndex("by_ownerId", (q) => q.eq("ownerId", args.fromOwnerId))
      .take(BATCH_SIZE);
    await Promise.all(
      rows.map((row) => ctx.db.patch(row._id, { ownerId: args.toOwnerId })),
    );
    return { hasMore: isFullPage(rows) };
  },
});

const DEDUPLICATE_DEFAULT_BATCH = 200;

export const deduplicateDefaultConversation = internalMutation({
  args: {
    toOwnerId: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const defaults = await ctx.db
      .query("conversations")
      .withIndex("by_ownerId_and_isDefault", (q) =>
        q.eq("ownerId", args.toOwnerId).eq("isDefault", true),
      )
      .take(DEDUPLICATE_DEFAULT_BATCH);

    if (defaults.length <= 1) return null;

    defaults.sort((a, b) => a.createdAt - b.createdAt);
    const promises = [];
    for (let i = 1; i < defaults.length; i++) {
      promises.push(ctx.db.patch(defaults[i]._id, { isDefault: false }));
    }
    await Promise.all(promises);

    return null;
  },
});

export const deduplicateUserCounters = internalMutation({
  args: { toOwnerId: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query("user_counters")
      .withIndex("by_ownerId", (q) => q.eq("ownerId", args.toOwnerId))
      .take(64);

    if (rows.length <= 1) return null;

    rows.sort((a, b) => a._creationTime - b._creationTime);
    const [primary, ...duplicates] = rows;
    const totalCount = rows.reduce(
      (sum, row) => sum + (row.conversationCount ?? 0),
      0,
    );
    await ctx.db.patch(primary._id, {
      conversationCount: totalCount,
      updatedAt: Date.now(),
    });
    await Promise.all(duplicates.map((row) => ctx.db.delete(row._id)));
    return null;
  },
});

const PARALLEL_TABLE_MUTATIONS = [
  internal.auth_migration.migrateConversationsBatch,
  internal.auth_migration.migrateUserPreferencesBatch,
  internal.auth_migration.migrateAuthSessionPoliciesBatch,
  internal.auth_migration.migrateSecretsBatch,
  internal.auth_migration.migrateSecretAccessAuditBatch,
  internal.auth_migration.migrateUserIntegrationsBatch,
  internal.auth_migration.migrateUsageLogsBatch,
  internal.auth_migration.migrateConnectorTurnPayloadsBatch,
  internal.auth_migration.migrateAgentsBatch,
  internal.auth_migration.migrateMediaJobsBatch,
  internal.auth_migration.migrateMediaRequestCancellationsBatch,
  internal.auth_migration.migrateMediaJobLogsBatch,
  internal.auth_migration.migrateUserCountersBatch,
] as const;

type OwnerBatchMutation = FunctionReference<
  "mutation",
  "internal",
  { fromOwnerId: string; toOwnerId: string },
  { hasMore: boolean }
>;

async function drainTableMutation(
  ctx: ActionCtx,
  mutation: OwnerBatchMutation,
  args: { fromOwnerId: string; toOwnerId: string },
): Promise<void> {
  let hasMore = true;
  while (hasMore) {
    const result = await ctx.runMutation(mutation, args);
    hasMore = result.hasMore;
  }
}

export const migrateOwnership = internalAction({
  args: {
    fromOwnerId: v.string(),
    toOwnerId: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    if (args.fromOwnerId === args.toOwnerId) return null;

    let deviceMigrationHasMore = true;
    while (deviceMigrationHasMore) {
      const result: { hasMore: boolean } = await ctx.runMutation(
        internal.auth_migration.migrateDevicesForAccountLink,
        {
          fromOwnerId: args.fromOwnerId,
          toOwnerId: args.toOwnerId,
        },
      );
      deviceMigrationHasMore = result.hasMore;
    }

    await Promise.all(
      PARALLEL_TABLE_MUTATIONS.map((mutation) =>
        drainTableMutation(ctx, mutation as OwnerBatchMutation, {
          fromOwnerId: args.fromOwnerId,
          toOwnerId: args.toOwnerId,
        }),
      ),
    );

    await Promise.all([
      ctx.runMutation(internal.auth_migration.deduplicateDefaultConversation, {
        toOwnerId: args.toOwnerId,
      }),
      ctx.runMutation(internal.auth_migration.deduplicateUserCounters, {
        toOwnerId: args.toOwnerId,
      }),
    ]);

    console.log(
      `[auth_migration] Completed ownership migration from ${args.fromOwnerId} to ${args.toOwnerId}`,
    );
    return null;
  },
});

export const migrateDevicesForAccountLink = internalMutation({
  args: {
    fromOwnerId: v.string(),
    toOwnerId: v.string(),
  },
  returns: v.object({ hasMore: v.boolean() }),
  handler: async (ctx, args) => {

    const deviceRows = await ctx.db
      .query("devices")
      .withIndex("by_ownerId", (q) => q.eq("ownerId", args.fromOwnerId))
      .take(BATCH_SIZE);

    if (deviceRows.length > 0) {
      for (const row of deviceRows) {
        const existing = await ctx.db
          .query("devices")
          .withIndex("by_ownerId_and_deviceId", (q) =>
            q.eq("ownerId", args.toOwnerId).eq("deviceId", row.deviceId),
          )
          .unique();

        if (existing) {
          await ctx.db.delete(row._id);
        } else {
          await ctx.db.patch(row._id, { ownerId: args.toOwnerId });
        }
      }
      return { hasMore: deviceRows.length === BATCH_SIZE };
    }

    const presenceRows = await ctx.db
      .query("device_presence")
      .withIndex("by_ownerId", (q) => q.eq("ownerId", args.fromOwnerId))
      .take(BATCH_SIZE);

    for (const row of presenceRows) {
      const existing = await ctx.db
        .query("device_presence")
        .withIndex("by_ownerId_and_deviceId", (q) =>
          q.eq("ownerId", args.toOwnerId).eq("deviceId", row.deviceId),
        )
        .unique();

      if (existing) {
        await ctx.db.delete(row._id);
      } else {
        await ctx.db.patch(row._id, { ownerId: args.toOwnerId });
      }
    }
    return { hasMore: presenceRows.length === BATCH_SIZE };
  },
});
