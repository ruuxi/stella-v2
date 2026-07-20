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
  "auth_session_policies",
  "usage_logs",
  "usage_rollups",
  "billing_usage_windows",
  "billing_profiles",
  "user_counters",
  "slack_oauth_states",
  "x_oauth_states",
  "x_oauth_tokens",
  "connector_turn_payloads",
] as const;

type OwnerTable = (typeof OWNER_TABLES)[number];

/**
 * Mobile pairing/bridge/push tables hold device credentials and push tokens
 * that must not survive account deletion. Drained here because
 * `reset._deleteOwnerTableBatch` does not cover them.
 */
const MOBILE_TABLES = [
  "mobile_pairing_sessions",
  "paired_mobile_devices",
  "mobile_connect_intents",
  "mobile_bridge_registrations",
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

/**
 * Owner-keyed tables not covered by `reset._deleteOwnerTableBatch` (whose
 * list doubles as the user-facing "reset my data" scope). Account deletion
 * must additionally wipe private/user-content tables: secrets, integrations,
 * media, channel links, billing receipts, fashion, pets, store content, and
 * the user's social footprint. The two `social_relationships_*` entries are
 * the same table drained via its requester/addressee indexes.
 */
const EXTRA_TABLES = [
  "secrets",
  "secret_access_audit",
  "user_integrations",
  "agents",
  "media_jobs",
  "media_job_logs",
  "media_request_cancellations",
  "media_webhook_events",
  "transient_channel_events",
  "transient_cleanup_failures",
  "channel_connections",
  "link_codes",
  "billing_usage_credits",
  "billing_voice_usage_receipts",
  "billing_media_usage_receipts",
  "billing_voice_sessions",
  "fashion_profiles",
  "fashion_outfits",
  "fashion_likes",
  "fashion_cart_items",
  "fashion_checkout_sessions",
  "user_pets",
  "store_packages",
  "store_package_releases",
  "backup_key_escrows",
  "social_profiles",
  "social_relationships_as_requester",
  "social_relationships_as_addressee",
  "social_room_members",
  "social_messages",
  "stella_session_members",
] as const;

type ExtraTable = (typeof EXTRA_TABLES)[number];

const EXTRA_BATCH = 200;

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
      // Output payloads can be large — keep the per-transaction read small.
      batch = 50;
      const rows = await ctx.db
        .query("media_jobs")
        .withIndex("by_ownerId_and_createdAt", (q) => q.eq("ownerId", ownerId))
        .take(batch);
      // Scheduler writes commit atomically with this mutation. A transaction
      // retry cannot orphan an encrypted blob or schedule cleanup for a row
      // whose state change did not commit.
      let deleted = 0;
      for (const row of rows) {
        if (row.submissionState === "dispatching" && !row.providerRequestId) {
          const canceledAt = Date.now();
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
          await ctx.db.patch(row._id, {
            status: "canceled",
            request: {},
            submissionPayloadStorageId: undefined,
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
        await ctx.db.delete(row._id);
        deleted += 1;
      }
      // A claimed POST with no provider response is irreducibly ambiguous.
      // Leave its canceled tombstone for markSubmitted/a webhook to attach a
      // provider id, but stop this drain instead of hot-looping until the
      // action timeout. The outer purge fails closed and is safe to retry.
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
    case "transient_channel_events": {
      const rows = await ctx.db
        .query("transient_channel_events")
        .withIndex("by_ownerId_and_createdAt", (q) => q.eq("ownerId", ownerId))
        .take(batch);
      ids = rows.map((r) => r._id);
      break;
    }
    case "transient_cleanup_failures": {
      const rows = await ctx.db
        .query("transient_cleanup_failures")
        .withIndex("by_ownerId_and_createdAt", (q) => q.eq("ownerId", ownerId))
        .take(batch);
      ids = rows.map((r) => r._id);
      break;
    }
    case "channel_connections": {
      const rows = await ctx.db
        .query("channel_connections")
        .withIndex("by_ownerId_and_provider", (q) => q.eq("ownerId", ownerId))
        .take(batch);
      ids = rows.map((r) => r._id);
      break;
    }
    case "link_codes": {
      const rows = await ctx.db
        .query("link_codes")
        .withIndex("by_ownerId_and_provider", (q) => q.eq("ownerId", ownerId))
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
    case "user_pets": {
      batch = 50;
      const rows = await ctx.db
        .query("user_pets")
        .withIndex("by_ownerId_and_updatedAt", (q) => q.eq("ownerId", ownerId))
        .take(batch);
      ids = rows.map((r) => r._id);
      break;
    }
    case "store_packages": {
      batch = 50;
      const rows = await ctx.db
        .query("store_packages")
        .withIndex("by_ownerId_and_updatedAt", (q) => q.eq("ownerId", ownerId))
        .take(batch);
      ids = rows.map((r) => r._id);
      break;
    }
    case "store_package_releases": {
      // Releases can carry blueprints of up to 750 KB each.
      batch = 8;
      const rows = await ctx.db
        .query("store_package_releases")
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
    case "social_profiles": {
      const rows = await ctx.db
        .query("social_profiles")
        .withIndex("by_ownerId", (q) => q.eq("ownerId", ownerId))
        .take(batch);
      ids = rows.map((r) => r._id);
      break;
    }
    case "social_relationships_as_requester": {
      const rows = await ctx.db
        .query("social_relationships")
        .withIndex("by_requesterOwnerId_and_status", (q) =>
          q.eq("requesterOwnerId", ownerId),
        )
        .take(batch);
      ids = rows.map((r) => r._id);
      break;
    }
    case "social_relationships_as_addressee": {
      const rows = await ctx.db
        .query("social_relationships")
        .withIndex("by_addresseeOwnerId_and_status", (q) =>
          q.eq("addresseeOwnerId", ownerId),
        )
        .take(batch);
      ids = rows.map((r) => r._id);
      break;
    }
    case "social_room_members": {
      const rows = await ctx.db
        .query("social_room_members")
        .withIndex("by_ownerId_and_updatedAt", (q) => q.eq("ownerId", ownerId))
        .take(batch);
      ids = rows.map((r) => r._id);
      break;
    }
    case "social_messages": {
      const rows = await ctx.db
        .query("social_messages")
        .withIndex("by_senderOwnerId_and_createdAt", (q) =>
          q.eq("senderOwnerId", ownerId),
        )
        .take(batch);
      ids = rows.map((r) => r._id);
      break;
    }
    case "stella_session_members": {
      const rows = await ctx.db
        .query("stella_session_members")
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

// ─── Emoji packs (tag membership/facet cleanup per pack) ────────────────────

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
      // Clears tag membership rows and decrements public facet counts the
      // same way the user-facing `deletePack` mutation does.
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

// ─── Backups (R2 blobs + rows) ───────────────────────────────────────────────

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
    // Best-effort R2 cleanup first; rows are deleted regardless so the purge
    // terminates even when individual R2 deletes fail.
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

// ─── Hosted stella_sessions (phased child-table teardown) ───────────────────

const SESSION_CHILD_BATCH = 200;

export const _listHostedSessionIds = internalQuery({
  args: { ownerId: v.string() },
  returns: v.array(v.id("stella_sessions")),
  handler: async (ctx, { ownerId }) => {
    const rows = await ctx.db
      .query("stella_sessions")
      .withIndex("by_hostOwnerId_and_status", (q) =>
        q.eq("hostOwnerId", ownerId),
      )
      .take(50);
    return rows.map((row) => row._id);
  },
});

export const _deleteHostedSessionBatch = internalMutation({
  args: { sessionId: v.id("stella_sessions") },
  returns: v.object({ hasMore: v.boolean() }),
  handler: async (ctx, { sessionId }) => {
    const turns = await ctx.db
      .query("stella_session_turns")
      .withIndex("by_sessionId_and_ordinal", (q) =>
        q.eq("sessionId", sessionId),
      )
      .take(SESSION_CHILD_BATCH);
    if (turns.length > 0) {
      await Promise.all(turns.map((row) => ctx.db.delete(row._id)));
      return { hasMore: true };
    }

    const fileOps = await ctx.db
      .query("stella_session_file_ops")
      .withIndex("by_sessionId_and_ordinal", (q) =>
        q.eq("sessionId", sessionId),
      )
      .take(SESSION_CHILD_BATCH);
    if (fileOps.length > 0) {
      await Promise.all(fileOps.map((row) => ctx.db.delete(row._id)));
      return { hasMore: true };
    }

    const files = await ctx.db
      .query("stella_session_files")
      .withIndex("by_sessionId_and_updatedAt", (q) =>
        q.eq("sessionId", sessionId),
      )
      .take(SESSION_CHILD_BATCH);
    if (files.length > 0) {
      await Promise.all(files.map((row) => ctx.db.delete(row._id)));
      return { hasMore: true };
    }

    // Blobs are the canonical content-addressed storage layer (file rows
    // reference the same storage ids), so storage cleanup happens here.
    const blobs = await ctx.db
      .query("stella_session_file_blobs")
      .withIndex("by_sessionId_and_createdAt", (q) =>
        q.eq("sessionId", sessionId),
      )
      .take(100);
    if (blobs.length > 0) {
      await Promise.all(
        blobs.map(async (row) => {
          await ctx.storage.delete(row.storageId);
          await ctx.db.delete(row._id);
        }),
      );
      return { hasMore: true };
    }

    const members = await ctx.db
      .query("stella_session_members")
      .withIndex("by_sessionId_and_updatedAt", (q) =>
        q.eq("sessionId", sessionId),
      )
      .take(SESSION_CHILD_BATCH);
    if (members.length > 0) {
      await Promise.all(members.map((row) => ctx.db.delete(row._id)));
      return { hasMore: true };
    }

    const session = await ctx.db.get(sessionId);
    if (session) {
      // Unlink the room pointer if it still references this session.
      const room = await ctx.db.get(session.roomId);
      if (room?.stellaSessionId === sessionId) {
        await ctx.db.patch(room._id, { stellaSessionId: undefined });
      }
      await ctx.db.delete(sessionId);
    }
    return { hasMore: false };
  },
});

const drainHostedSessions = async (ctx: ActionCtx, ownerId: string) => {
  while (true) {
    const sessionIds: Id<"stella_sessions">[] = await ctx.runQuery(
      internal.account_deletion._listHostedSessionIds,
      { ownerId },
    );
    if (sessionIds.length === 0) break;
    for (const sessionId of sessionIds) {
      let hasMore = true;
      while (hasMore) {
        const result: { hasMore: boolean } = await ctx.runMutation(
          internal.account_deletion._deleteHostedSessionBatch,
          { sessionId },
        );
        hasMore = result.hasMore;
      }
    }
  }
};

/**
 * Drain a single owner-scoped table by repeatedly invoking
 * `_deleteOwnerTableBatch` until `hasMore: false`. Each invocation is its
 * own Convex transaction so the per-mutation read/write limits stay
 * respected.
 */
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

/**
 * Removes Convex-owned data for an owner before Better Auth deletes the user
 * row. Mirrors `reset.resetAllUserData` but takes an explicit owner id (used
 * at account-deletion time, when there is no `ctx.auth.getUserIdentity()`).
 */
export const purgeOwnerCloudData = internalAction({
  args: { ownerId: v.string() },
  returns: v.null(),
  handler: async (ctx, { ownerId }) => {
    // Open the media gate before any other deletion work or parallel drain.
    // Reservations and dispatch claims observe this same durable row
    // transactionally, so no new provider work can cross the purge boundary.
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

    // Hosted social sessions need per-session child teardown before their
    // member/message rows are swept by the generic drains below.
    await drainHostedSessions(ctx, ownerId);

    // Owner-scoped tables are independent — drain them concurrently.
    await Promise.all([
      ...OWNER_TABLES.map((table) => drainOwnerTable(ctx, ownerId, table)),
      ...MOBILE_TABLES.map((table) => drainMobileTable(ctx, ownerId, table)),
      ...EXTRA_TABLES.map((table) => drainExtraTable(ctx, ownerId, table)),
      (async () => {
        // Gate first: while the purge gate is open no relay resume rows can
        // be created for this owner, so deletion cannot race with in-flight
        // relay streams re-buffering response plaintext after it returns.
        await ctx.runMutation(
          internal.stella_provider.relay_resume_store
            .beginOwnerRelayResumePurge,
          { ownerId, nowMs: Date.now() },
        );
        const drain = async () => {
          let hasMore = true;
          while (hasMore) {
            const result: { hasMore: boolean } = await ctx.runMutation(
              internal.stella_provider.relay_resume_store
                .deleteOwnerRelayResumeBatch,
              { ownerId, nowMs: Date.now() },
            );
            hasMore = result.hasMore;
          }
        };
        await drain();
        // Final pass after active relay work has been rejected by the gate.
        // The gate itself stays in place for still-valid tokens; the cleanup
        // sweep removes it after its TTL.
        await drain();
      })(),
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
      // Canvas shares: delete R2 objects + rows for this owner.
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
