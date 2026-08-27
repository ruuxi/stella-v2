import {
  internalAction,
  internalMutation,
  internalQuery,
  type ActionCtx,
  type MutationCtx,
} from "./_generated/server";
import { internal } from "./_generated/api";
import type { Id, TableNames } from "./_generated/dataModel";
import { v, type VLiteral } from "convex/values";
import { syncTagMembership } from "./data/emoji_packs";
import { r2 } from "./r2_files";

const OWNER_TABLES = [
  "user_preferences",
  "devices",
  "device_presence",
  "cloudflare_tunnels",
  "auth_revoked_sessions",
  "usage_logs",
  "usage_rollups",
  "billing_usage_windows",
  "billing_profiles",
  "user_counters",
  "x_oauth_states",
  "x_oauth_tokens",
  "connector_turn_payloads",
] as const;

type OwnerTable = (typeof OWNER_TABLES)[number];

const MOBILE_TABLES = [
  "mobile_pairing_sessions",
  "paired_mobile_devices",
  "mobile_connect_intents",
  "mobile_bridge_registrations",
  "mobile_bridge_registration_limits",
  "mobile_bridge_sessions",
  "mobile_push_tokens",
] as const;

type MobileTable = (typeof MOBILE_TABLES)[number];

const MOBILE_BATCH = 200;

async function deleteOneMobileTableBatch(
  ctx: MutationCtx,
  ownerId: string,
  table: MobileTable,
): Promise<number> {
  let ids: Id<MobileTable>[] = [];
  switch (table) {
    case "mobile_pairing_sessions": {
      const rows = await ctx.db
        .query("mobile_pairing_sessions")
        .withIndex("by_ownerId_and_desktopDeviceId", (q) =>
          q.eq("ownerId", ownerId),
        )
        .take(MOBILE_BATCH);
      ids = rows.map((r) => r._id) as Id<MobileTable>[];
      break;
    }
    case "paired_mobile_devices": {
      const rows = await ctx.db
        .query("paired_mobile_devices")
        .withIndex("by_ownerId_and_desktopDeviceId", (q) =>
          q.eq("ownerId", ownerId),
        )
        .take(MOBILE_BATCH);
      ids = rows.map((r) => r._id) as Id<MobileTable>[];
      break;
    }
    case "mobile_connect_intents": {
      const rows = await ctx.db
        .query("mobile_connect_intents")
        .withIndex("by_ownerId_and_desktopDeviceId_and_expiresAt", (q) =>
          q.eq("ownerId", ownerId),
        )
        .take(MOBILE_BATCH);
      ids = rows.map((r) => r._id) as Id<MobileTable>[];
      break;
    }
    case "mobile_bridge_registrations": {
      const rows = await ctx.db
        .query("mobile_bridge_registrations")
        .withIndex("by_ownerId_and_deviceId", (q) => q.eq("ownerId", ownerId))
        .take(MOBILE_BATCH);
      ids = rows.map((r) => r._id) as Id<MobileTable>[];
      break;
    }
    case "mobile_bridge_registration_limits": {
      const rows = await ctx.db
        .query("mobile_bridge_registration_limits")
        .withIndex("by_ownerId", (q) => q.eq("ownerId", ownerId))
        .take(MOBILE_BATCH);
      ids = rows.map((r) => r._id) as Id<MobileTable>[];
      break;
    }
    case "mobile_bridge_sessions": {
      const rows = await ctx.db
        .query("mobile_bridge_sessions")
        .withIndex("by_ownerId_and_desktopDeviceId_and_mobileDeviceId", (q) =>
          q.eq("ownerId", ownerId),
        )
        .take(MOBILE_BATCH);
      ids = rows.map((r) => r._id) as Id<MobileTable>[];
      break;
    }
    case "mobile_push_tokens": {
      const rows = await ctx.db
        .query("mobile_push_tokens")
        .withIndex("by_ownerId", (q) => q.eq("ownerId", ownerId))
        .take(MOBILE_BATCH);
      ids = rows.map((r) => r._id) as Id<MobileTable>[];
      break;
    }
    default: {
      const exhaustive: never = table;
      throw new Error(`Unhandled mobile table: ${String(exhaustive)}`);
    }
  }
  await Promise.all(ids.map((id) => ctx.db.delete(id)));
  return ids.length;
}

export const _deleteMobileTableBatch = internalMutation({
  args: {
    ownerId: v.string(),
    table: v.union(
      v.literal("mobile_pairing_sessions"),
      v.literal("paired_mobile_devices"),
      v.literal("mobile_connect_intents"),
      v.literal("mobile_bridge_registrations"),
      v.literal("mobile_bridge_registration_limits"),
      v.literal("mobile_bridge_sessions"),
      v.literal("mobile_push_tokens"),
    ),
  },
  returns: v.object({ hasMore: v.boolean() }),
  handler: async (ctx, { ownerId, table }) => {
    const deleted = await deleteOneMobileTableBatch(ctx, ownerId, table);
    return { hasMore: deleted === MOBILE_BATCH };
  },
});

const drainMobileTable = async (
  ctx: ActionCtx,
  ownerId: string,
  table: MobileTable,
) => {
  let hasMore = true;
  while (hasMore) {
    const result: { hasMore: boolean } = await ctx.runMutation(
      internal.account_deletion._deleteMobileTableBatch,
      { ownerId, table },
    );
    hasMore = result.hasMore;
  }
};

const EXTRA_TABLES = [
  "secrets",
  "secret_access_audit",
  "user_integrations",
  "agents",
  "media_jobs",
  "media_job_logs",
  "media_request_cancellations",
  "media_webhook_events",
  "billing_usage_credits",
  "billing_voice_usage_receipts",
  "billing_media_usage_receipts",
  "billing_voice_sessions",
  "fashion_profiles",
  "fashion_outfits",
  "fashion_likes",
  "fashion_cart_items",
  "fashion_checkout_sessions",
  "backup_key_escrows",
] as const;

type ExtraTable = (typeof EXTRA_TABLES)[number];

const EXTRA_BATCH = 200;
const AMBIGUOUS_MEDIA_PURGE_RETENTION_MS = 3 * 60 * 60_000 + 15 * 60_000;

const queuePrivatePayloadManifestDeletion = async (
  ctx: MutationCtx,
  manifestId: string,
  now: number,
) => {
  const manifest = await ctx.db
    .query("media_private_payload_manifests")
    .withIndex("by_manifestId", (q) => q.eq("manifestId", manifestId))
    .unique();
  if (manifest) {
    await ctx.db.patch(manifest._id, {
      state: "pending",
      nextAttemptAt: now,
      updatedAt: now,
    });
  }
  await ctx.scheduler.runAfter(
    0,
    internal.media_image_submission.deletePrivatePayloadManifest,
    { manifestId },
  );
};

async function deleteOneExtraTableBatch(
  ctx: MutationCtx,
  ownerId: string,
  table: ExtraTable,
): Promise<boolean> {
  let batch = EXTRA_BATCH;
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
    case "user_integrations": {
      const rows = await ctx.db
        .query("user_integrations")
        .withIndex("by_ownerId_and_provider", (q) => q.eq("ownerId", ownerId))
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
    case "media_jobs": {

      batch = 50;
      const rows = await ctx.db
        .query("media_jobs")
        .withIndex("by_ownerId_and_createdAt", (q) => q.eq("ownerId", ownerId))
        .take(batch);

      let deleted = 0;
      for (const row of rows) {
        const canceledAt = Date.now();
        const ambiguousPurgeExpired =
          row.status === "canceled" &&
          row.error?.code === "OWNER_PURGED" &&
          canceledAt - (row.submissionClaimedAt ?? row.updatedAt) >=
            AMBIGUOUS_MEDIA_PURGE_RETENTION_MS;
        if (
          row.submissionState === "dispatching" &&
          !row.providerRequestId &&
          !ambiguousPurgeExpired
        ) {
          if (row.submissionPayloadStorageId) {
            const cleanup = await ctx.db
              .query("media_private_blob_cleanup")
              .withIndex("by_storageId", (q) =>
                q.eq("storageId", row.submissionPayloadStorageId!),
              )
              .unique();
            const cleanupPatch = {
              jobId: row.jobId,
              state: "pending" as const,
              nextAttemptAt: canceledAt,
              updatedAt: canceledAt,
            };
            if (cleanup) {
              await ctx.db.patch(cleanup._id, cleanupPatch);
            } else {
              await ctx.db.insert("media_private_blob_cleanup", {
                ownerId,
                storageId: row.submissionPayloadStorageId,
                ...cleanupPatch,
                attempts: 0,
                createdAt: canceledAt,
              });
            }
            await ctx.scheduler.runAfter(
              0,
              internal.media_image_submission.deleteSubmissionPayload,
              { storageId: row.submissionPayloadStorageId },
            );
          }
          if (row.submissionPayloadManifestId) {
            await queuePrivatePayloadManifestDeletion(
              ctx,
              row.submissionPayloadManifestId,
              canceledAt,
            );
          }
          await ctx.db.patch(row._id, {
            status: "canceled",
            request: {},
            submissionPayloadStorageId: undefined,
            submissionPayloadManifestId: undefined,
            upstreamStatus: "OWNER_PURGED",
            queuePosition: null,
            error: {
              code: "OWNER_PURGED",
              message: "Media generation canceled during account deletion.",
            },
            updatedAt: canceledAt,
            completedAt: canceledAt,
          });
          continue;
        }
        if (row.providerRequestId) {
          const existingCancellation = await ctx.db
            .query("media_provider_cancellations")
            .withIndex("by_jobId", (q) => q.eq("jobId", row.jobId))
            .unique();
          if (!existingCancellation) {
            const cancellationAt = Date.now();
            await ctx.db.insert("media_provider_cancellations", {
              ownerId,
              jobId: row.jobId,
              endpointId: row.endpointId,
              providerRequestId: row.providerRequestId,
              attempts: 0,
              nextAttemptAt: cancellationAt,
              createdAt: cancellationAt,
              updatedAt: cancellationAt,
            });
          }
          await ctx.scheduler.runAfter(
            0,
            internal.media_image_submission.cancelPurgedProviderRequest,
            { jobId: row.jobId },
          );
        }
        const webhookEvents = await ctx.db
          .query("media_webhook_events")
          .withIndex("by_jobId_and_receivedAt", (q) => q.eq("jobId", row.jobId))
          .take(200);
        for (const event of webhookEvents) await ctx.db.delete(event._id);
        if (webhookEvents.length === 200) continue;
        if (row.submissionPayloadStorageId) {
          const cleanup = await ctx.db
            .query("media_private_blob_cleanup")
            .withIndex("by_storageId", (q) =>
              q.eq("storageId", row.submissionPayloadStorageId!),
            )
            .unique();
          const cleanupPatch = {
            jobId: row.jobId,
            state: "pending" as const,
            nextAttemptAt: Date.now(),
            updatedAt: Date.now(),
          };
          if (cleanup) {
            await ctx.db.patch(cleanup._id, cleanupPatch);
          } else {
            await ctx.db.insert("media_private_blob_cleanup", {
              ownerId,
              storageId: row.submissionPayloadStorageId,
              ...cleanupPatch,
              attempts: 0,
              createdAt: Date.now(),
            });
          }
          await ctx.scheduler.runAfter(
            0,
            internal.media_image_submission.deleteSubmissionPayload,
            { storageId: row.submissionPayloadStorageId },
          );
        }
        if (row.submissionPayloadManifestId) {
          await queuePrivatePayloadManifestDeletion(
            ctx,
            row.submissionPayloadManifestId,
            Date.now(),
          );
        }
        await ctx.db.delete(row._id);
        deleted += 1;
      }

      return deleted > 0;
    }
    case "media_webhook_events": {
      const rows = await ctx.db
        .query("media_webhook_events")
        .withIndex("by_ownerId_and_receivedAt", (q) => q.eq("ownerId", ownerId))
        .take(batch);
      ids = rows.map((row) => row._id);
      break;
    }
    case "media_job_logs": {
      const rows = await ctx.db
        .query("media_job_logs")
        .withIndex("by_ownerId_and_jobId", (q) => q.eq("ownerId", ownerId))
        .take(batch);
      ids = rows.map((r) => r._id);
      break;
    }
    case "media_request_cancellations": {
      const rows = await ctx.db
        .query("media_request_cancellations")
        .withIndex("by_ownerId_and_clientRequestKey", (q) =>
          q.eq("ownerId", ownerId),
        )
        .take(batch);
      ids = rows.map((r) => r._id);
      break;
    }
    case "billing_usage_credits": {
      const rows = await ctx.db
        .query("billing_usage_credits")
        .withIndex("by_ownerId", (q) => q.eq("ownerId", ownerId))
        .take(batch);
      ids = rows.map((r) => r._id);
      break;
    }
    case "billing_voice_usage_receipts": {
      const rows = await ctx.db
        .query("billing_voice_usage_receipts")
        .withIndex("by_ownerId_and_createdAt", (q) => q.eq("ownerId", ownerId))
        .take(batch);
      ids = rows.map((r) => r._id);
      break;
    }
    case "billing_media_usage_receipts": {
      const rows = await ctx.db
        .query("billing_media_usage_receipts")
        .withIndex("by_ownerId_and_createdAt", (q) => q.eq("ownerId", ownerId))
        .take(batch);
      ids = rows.map((r) => r._id);
      break;
    }
    case "billing_voice_sessions": {
      const rows = await ctx.db
        .query("billing_voice_sessions")
        .withIndex("by_ownerId_and_createdAt", (q) => q.eq("ownerId", ownerId))
        .take(batch);
      ids = rows.map((r) => r._id);
      break;
    }
    case "fashion_profiles": {
      const rows = await ctx.db
        .query("fashion_profiles")
        .withIndex("by_ownerId", (q) => q.eq("ownerId", ownerId))
        .take(batch);
      ids = rows.map((r) => r._id);
      break;
    }
    case "fashion_outfits": {
      batch = 100;
      const rows = await ctx.db
        .query("fashion_outfits")
        .withIndex("by_ownerId_and_createdAt", (q) => q.eq("ownerId", ownerId))
        .take(batch);
      ids = rows.map((r) => r._id);
      break;
    }
    case "fashion_likes": {
      const rows = await ctx.db
        .query("fashion_likes")
        .withIndex("by_ownerId_and_likedAt", (q) => q.eq("ownerId", ownerId))
        .take(batch);
      ids = rows.map((r) => r._id);
      break;
    }
    case "fashion_cart_items": {
      const rows = await ctx.db
        .query("fashion_cart_items")
        .withIndex("by_ownerId_and_addedAt", (q) => q.eq("ownerId", ownerId))
        .take(batch);
      ids = rows.map((r) => r._id);
      break;
    }
    case "fashion_checkout_sessions": {
      const rows = await ctx.db
        .query("fashion_checkout_sessions")
        .withIndex("by_ownerId_and_createdAt", (q) => q.eq("ownerId", ownerId))
        .take(batch);
      ids = rows.map((r) => r._id);
      break;
    }
    case "backup_key_escrows": {
      const rows = await ctx.db
        .query("backup_key_escrows")
        .withIndex("by_ownerId", (q) => q.eq("ownerId", ownerId))
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
    table: v.union(
      ...(EXTRA_TABLES.map((table) => v.literal(table)) as [
        VLiteral<ExtraTable>,
        VLiteral<ExtraTable>,
        ...VLiteral<ExtraTable>[],
      ]),
    ),
  },
  returns: v.object({ hasMore: v.boolean() }),
  handler: async (ctx, { ownerId, table }) => {
    const hasMore = await deleteOneExtraTableBatch(ctx, ownerId, table);
    return { hasMore };
  },
});

const drainExtraTable = async (
  ctx: ActionCtx,
  ownerId: string,
  table: ExtraTable,
) => {
  let hasMore = true;
  while (hasMore) {
    const result: { hasMore: boolean } = await ctx.runMutation(
      internal.account_deletion._deleteExtraTableBatch,
      { ownerId, table },
    );
    hasMore = result.hasMore;
  }
};

const EMOJI_PACK_BATCH = 5;

export const _deleteEmojiPackBatch = internalMutation({
  args: { ownerId: v.string() },
  returns: v.object({ hasMore: v.boolean() }),
  handler: async (ctx, { ownerId }) => {
    const packs = await ctx.db
      .query("emoji_packs")
      .withIndex("by_ownerId_and_updatedAt", (q) => q.eq("ownerId", ownerId))
      .take(EMOJI_PACK_BATCH);
    for (const pack of packs) {

      await syncTagMembership(ctx, pack, [], {
        visibility: pack.visibility,
        displayName: pack.displayName,
        installCount: pack.installCount ?? 0,
      });
      await ctx.db.delete(pack._id);
    }
    return { hasMore: packs.length === EMOJI_PACK_BATCH };
  },
});

const BACKUP_BATCH = 100;

export const _listBackupObjectBatch = internalQuery({
  args: { ownerId: v.string() },
  returns: v.array(v.object({ id: v.id("backup_objects"), r2Key: v.string() })),
  handler: async (ctx, { ownerId }) => {
    const rows = await ctx.db
      .query("backup_objects")
      .withIndex("by_ownerId_and_createdAt", (q) => q.eq("ownerId", ownerId))
      .take(BACKUP_BATCH);
    return rows.map((row) => ({ id: row._id, r2Key: row.r2Key }));
  },
});

export const _listBackupManifestBatch = internalQuery({
  args: { ownerId: v.string() },
  returns: v.array(
    v.object({ id: v.id("backup_manifests"), r2Key: v.string() }),
  ),
  handler: async (ctx, { ownerId }) => {
    const rows = await ctx.db
      .query("backup_manifests")
      .withIndex("by_ownerId_and_createdAt", (q) => q.eq("ownerId", ownerId))
      .take(BACKUP_BATCH);
    return rows.map((row) => ({ id: row._id, r2Key: row.manifestR2Key }));
  },
});

export const _deleteBackupRows = internalMutation({
  args: {
    objectIds: v.array(v.id("backup_objects")),
    manifestIds: v.array(v.id("backup_manifests")),
  },
  returns: v.null(),
  handler: async (ctx, { objectIds, manifestIds }) => {
    await Promise.all([
      ...objectIds.map((id) => ctx.db.delete(id)),
      ...manifestIds.map((id) => ctx.db.delete(id)),
    ]);
    return null;
  },
});

const drainBackups = async (ctx: ActionCtx, ownerId: string) => {
  while (true) {
    const batch: { id: Id<"backup_objects">; r2Key: string }[] =
      await ctx.runQuery(internal.account_deletion._listBackupObjectBatch, {
        ownerId,
      });
    if (batch.length === 0) break;

    await Promise.all(
      batch.map(({ r2Key }) =>
        r2.deleteObject(ctx, r2Key).catch((error) => {
          console.error(
            `[account_deletion] Failed to delete backup object ${r2Key}:`,
            error,
          );
        }),
      ),
    );
    await ctx.runMutation(internal.account_deletion._deleteBackupRows, {
      objectIds: batch.map(({ id }) => id),
      manifestIds: [],
    });
  }
  while (true) {
    const batch: { id: Id<"backup_manifests">; r2Key: string }[] =
      await ctx.runQuery(internal.account_deletion._listBackupManifestBatch, {
        ownerId,
      });
    if (batch.length === 0) break;
    await Promise.all(
      batch.map(({ r2Key }) =>
        r2.deleteObject(ctx, r2Key).catch((error) => {
          console.error(
            `[account_deletion] Failed to delete backup manifest ${r2Key}:`,
            error,
          );
        }),
      ),
    );
    await ctx.runMutation(internal.account_deletion._deleteBackupRows, {
      objectIds: [],
      manifestIds: batch.map(({ id }) => id),
    });
  }
};

const drainOwnerTable = async (
  ctx: ActionCtx,
  ownerId: string,
  table: OwnerTable,
) => {
  let hasMore = true;
  while (hasMore) {
    const result: { hasMore: boolean } = await ctx.runMutation(
      internal.reset._deleteOwnerTableBatch,
      { ownerId, table },
    );
    hasMore = result.hasMore;
  }
};

export const purgeOwnerCloudData = internalAction({
  args: { ownerId: v.string() },
  returns: v.null(),
  handler: async (ctx, { ownerId }) => {

    await ctx.runMutation(internal.media_jobs.beginOwnerMediaPurge, {
      ownerId,
      startedAt: Date.now(),
    });
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
            { conversationId },
          );
          hasMore = result.hasMore;
        }
      }
      if (page.nextCursor === null) break;
      cursor = page.nextCursor;
    }

    await Promise.all([
      ...OWNER_TABLES.map((table) => drainOwnerTable(ctx, ownerId, table)),
      ...MOBILE_TABLES.map((table) => drainMobileTable(ctx, ownerId, table)),
      ...EXTRA_TABLES.map((table) => drainExtraTable(ctx, ownerId, table)),
      (async () => {
        let hasMore = true;
        while (hasMore) {
          const result: { hasMore: boolean } = await ctx.runMutation(
            internal.account_deletion._deleteEmojiPackBatch,
            { ownerId },
          );
          hasMore = result.hasMore;
        }
      })(),
      drainBackups(ctx, ownerId),

      ctx.runAction(internal.data.canvas_shares_actions.purgeOwnerShares, {
        ownerUserId: ownerId,
      }),
    ]);

    const privateBlobDrain = await ctx.runAction(
      internal.media_image_submission.drainOwnerPrivateBlobCleanup,
      { ownerId, limit: 100 },
    );
    if (privateBlobDrain.remaining > 0) {
      throw new Error(
        "Account deletion is waiting for encrypted media payload cleanup; the durable purge gate remains active.",
      );
    }
    const privateManifestDrain = await ctx.runAction(
      internal.media_image_submission.drainOwnerPrivatePayloadManifests,
      { ownerId, limit: 100 },
    );
    if (privateManifestDrain.remaining > 0) {
      throw new Error(
        "Account deletion is waiting for encrypted media manifest cleanup; the durable purge gate remains active.",
      );
    }
    const providerCancellationDrain = await ctx.runAction(
      internal.media_image_submission.drainOwnerProviderCancellations,
      { ownerId, limit: 100 },
    );
    if (providerCancellationDrain.remaining > 0) {
      throw new Error(
        "Account deletion is waiting for provider media cancellation; the durable purge gate remains active.",
      );
    }
    const unresolvedMediaJobs = await ctx.runQuery(
      internal.media_jobs.hasOwnerMediaJobs,
      { ownerId },
    );
    if (unresolvedMediaJobs) {
      throw new Error(
        "Account deletion is waiting for an ambiguous in-flight media submission to reconcile; the durable purge gate remains active.",
      );
    }

    return null;
  },
});
