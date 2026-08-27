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
  quiesceOwnerExecutionPlacement,
  quiesceOwnerIntegrationCalls,
  stopOwnerSchedules,
} from "./cloud_purge";
import {
  assertOwnerDataWriteAllowed,
  assertOwnerPurgeLease,
  assertOwnerPurgeOperation,
} from "./owner_lifecycle";
import { purgeOwnerMigrationSourceDependencies } from "./lib/owner_migration_purge";
import { deleteComponentR2ObjectsRef } from "./lib/component_r2_deletion";

const OWNER_TABLES = [
  "user_preferences",
  "devices",
  "device_identity_successors",
  "auth_session_policies",
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

type LegacyBackupSweepSnapshot = {
  revision: number;
  notBefore: number;
  legacyRowFenceComplete: boolean;
  goal: "preserve_refs" | "empty";
  phase: "cleanup" | "verify" | "ready";
  targetIndex: number;
  startAfter?: string;
  targetPrefix?: string;
};

const advancePurgeLegacyR2SweepRef = makeFunctionReference<
  "action",
  {
    ownerId: string;
    operationId: string;
    generation: string;
    leaseId: string;
    mode: "reset" | "delete";
  },
  { ready: boolean; retryAfterMs?: number }
>("backup_legacy_r2_sweep:advancePurgeLegacyR2SweepInternal");

const upgradePurgeLegacyR2SweepToEmptyRef = makeFunctionReference<
  "mutation",
  {
    ownerId: string;
    operationId: string;
    generation: string;
    leaseId: string;
    mode: "reset" | "delete";
  },
  LegacyBackupSweepSnapshot
>("backup_legacy_r2_sweep_store:upgradePurgeSweepToEmptyInternal");

const purgeAbandonedLegacyR2SweepReceiptsRef = makeFunctionReference<
  "mutation",
  {
    ownerId: string;
    operationId: string;
    generation: string;
    leaseId: string;
    mode: "reset" | "delete";
  },
  { hasMore: boolean; deleted: number }
>("backup_legacy_r2_sweep_store:purgeOwnerAbandonedSweepReceiptsInternal");

const backupSweepPending = (message: string, retryAfterMs: number): never => {
  throw new ConvexError({
    code: "BACKUP_LEGACY_SWEEP_PENDING",
    message,
    retryAfterMs: Math.max(1_000, Math.floor(retryAfterMs)),
  });
};

const backupSweepRetryAfter = (error: unknown): number | undefined => {
  const data =
    error && typeof error === "object" && "data" in error
      ? error.data
      : undefined;
  if (
    !data ||
    typeof data !== "object" ||
    !("code" in data) ||
    data.code !== "BACKUP_LEGACY_SWEEP_PENDING" ||
    !("retryAfterMs" in data) ||
    typeof data.retryAfterMs !== "number" ||
    !Number.isFinite(data.retryAfterMs)
  ) {
    return undefined;
  }
  return Math.max(1_000, Math.floor(data.retryAfterMs));
};

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
    operationId: v.string(),
    generation: v.string(),
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
  handler: async (ctx, args) => {
    await assertOwnerPurgeOperation(ctx, args);
    const { ownerId, table } = args;
    const deleted = await deleteOneMobileTableBatch(ctx, ownerId, table);
    return { hasMore: deleted === MOBILE_BATCH };
  },
});

const drainMobileTable = async (
  ctx: ActionCtx,
  fence: { ownerId: string; operationId: string; generation: string },
  table: MobileTable,
) => {
  let hasMore = true;
  while (hasMore) {
    const result: { hasMore: boolean } = await ctx.runMutation(
      internal.account_deletion._deleteMobileTableBatch,
      { ...fence, table },
    );
    hasMore = result.hasMore;
  }
};

/**
 * Owner-keyed tables not covered by `reset._deleteOwnerTableBatch` (whose
 * list doubles as the user-facing "reset my data" scope). Account deletion
 * must additionally wipe private/user-content tables: secrets, integrations,
 * media, channel links, and fashion. External media, billing, TTS, and social
 * state each have dedicated strict purge helpers because they require
 * external-object-first deletion or shared-resource attribution handling.
 */
const EXTRA_TABLES = [
  "secrets",
  "secret_access_audit",
  "agents",
  "media_jobs",
  "media_job_logs",
  "media_request_cancellations",
  "media_webhook_events",
  "fashion_profiles",
  "fashion_outfits",
  "fashion_likes",
  "fashion_cart_items",
  "fashion_checkout_sessions",
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
              ownerGeneration: row.ownerGeneration ?? "legacy",
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

// ─── Emoji packs (tag membership/facet cleanup per pack) ────────────────────

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
      accountResidueCheck("auth_session_policies", () =>
        ctx.db
          .query("auth_session_policies")
          .withIndex("by_ownerId", (q) => q.eq("ownerId", ownerId))
          .take(1),
      ),
      accountResidueCheck("mobile_pairing_sessions", () =>
        ctx.db
          .query("mobile_pairing_sessions")
          .withIndex("by_ownerId_and_desktopDeviceId", (q) =>
            q.eq("ownerId", ownerId),
          )
          .take(1),
      ),
      accountResidueCheck("paired_mobile_devices", () =>
        ctx.db
          .query("paired_mobile_devices")
          .withIndex("by_ownerId_and_desktopDeviceId", (q) =>
            q.eq("ownerId", ownerId),
          )
          .take(1),
      ),
      accountResidueCheck("mobile_connect_intents", () =>
        ctx.db
          .query("mobile_connect_intents")
          .withIndex("by_ownerId_and_desktopDeviceId_and_expiresAt", (q) =>
            q.eq("ownerId", ownerId),
          )
          .take(1),
      ),
      accountResidueCheck("mobile_bridge_registrations", () =>
        ctx.db
          .query("mobile_bridge_registrations")
          .withIndex("by_ownerId_and_deviceId", (q) => q.eq("ownerId", ownerId))
          .take(1),
      ),
      accountResidueCheck("mobile_bridge_registration_limits", () =>
        ctx.db
          .query("mobile_bridge_registration_limits")
          .withIndex("by_ownerId", (q) => q.eq("ownerId", ownerId))
          .take(1),
      ),
      accountResidueCheck("mobile_bridge_sessions", () =>
        ctx.db
          .query("mobile_bridge_sessions")
          .withIndex("by_ownerId_and_desktopDeviceId_and_mobileDeviceId", (q) =>
            q.eq("ownerId", ownerId),
          )
          .take(1),
      ),
      accountResidueCheck("mobile_push_tokens", () =>
        ctx.db
          .query("mobile_push_tokens")
          .withIndex("by_ownerId", (q) => q.eq("ownerId", ownerId))
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
      accountResidueCheck("media_jobs", () =>
        ctx.db
          .query("media_jobs")
          .withIndex("by_ownerId_and_createdAt", (q) =>
            q.eq("ownerId", ownerId),
          )
          .take(1),
      ),
      accountResidueCheck("media_job_logs", () =>
        ctx.db
          .query("media_job_logs")
          .withIndex("by_ownerId_and_jobId", (q) => q.eq("ownerId", ownerId))
          .take(1),
      ),
      accountResidueCheck("media_request_cancellations", () =>
        ctx.db
          .query("media_request_cancellations")
          .withIndex("by_ownerId_and_clientRequestKey", (q) =>
            q.eq("ownerId", ownerId),
          )
          .take(1),
      ),
      accountResidueCheck("media_webhook_events", () =>
        ctx.db
          .query("media_webhook_events")
          .withIndex("by_ownerId_and_receivedAt", (q) =>
            q.eq("ownerId", ownerId),
          )
          .take(1),
      ),
      accountResidueCheck("media_private_blob_cleanup", () =>
        ctx.db
          .query("media_private_blob_cleanup")
          .withIndex("by_ownerId_and_state", (q) => q.eq("ownerId", ownerId))
          .take(1),
      ),
      accountResidueCheck("media_private_payload_manifests", () =>
        ctx.db
          .query("media_private_payload_manifests")
          .withIndex("by_ownerId_and_state", (q) => q.eq("ownerId", ownerId))
          .take(1),
      ),
      accountResidueCheck("media_private_payload_chunks", () =>
        ctx.db
          .query("media_private_payload_chunks")
          .withIndex("by_ownerId_and_manifestId", (q) =>
            q.eq("ownerId", ownerId),
          )
          .take(1),
      ),
      accountResidueCheck("media_provider_cancellations", () =>
        ctx.db
          .query("media_provider_cancellations")
          .withIndex("by_ownerId", (q) => q.eq("ownerId", ownerId))
          .take(1),
      ),
      accountResidueCheck("fashion_profiles", () =>
        ctx.db
          .query("fashion_profiles")
          .withIndex("by_ownerId", (q) => q.eq("ownerId", ownerId))
          .take(1),
      ),
      accountResidueCheck("fashion_outfits", () =>
        ctx.db
          .query("fashion_outfits")
          .withIndex("by_ownerId_and_createdAt", (q) =>
            q.eq("ownerId", ownerId),
          )
          .take(1),
      ),
      accountResidueCheck("fashion_likes", () =>
        ctx.db
          .query("fashion_likes")
          .withIndex("by_ownerId_and_likedAt", (q) => q.eq("ownerId", ownerId))
          .take(1),
      ),
      accountResidueCheck("fashion_cart_items", () =>
        ctx.db
          .query("fashion_cart_items")
          .withIndex("by_ownerId_and_addedAt", (q) => q.eq("ownerId", ownerId))
          .take(1),
      ),
      accountResidueCheck("fashion_checkout_sessions", () =>
        ctx.db
          .query("fashion_checkout_sessions")
          .withIndex("by_ownerId_and_createdAt", (q) =>
            q.eq("ownerId", ownerId),
          )
          .take(1),
      ),
      accountResidueCheck("backup_key_escrows", () =>
        ctx.db
          .query("backup_key_escrows")
          .withIndex("by_ownerId", (q) => q.eq("ownerId", ownerId))
          .take(1),
      ),
      accountResidueCheck("backup_objects", () =>
        ctx.db
          .query("backup_objects")
          .withIndex("by_ownerId_and_createdAt", (q) =>
            q.eq("ownerId", ownerId),
          )
          .take(1),
      ),
      accountResidueCheck("backup_manifests", () =>
        ctx.db
          .query("backup_manifests")
          .withIndex("by_ownerId_and_createdAt", (q) =>
            q.eq("ownerId", ownerId),
          )
          .take(1),
      ),
      accountResidueCheck("backup_upload_reservations", () =>
        ctx.db
          .query("backup_upload_reservations")
          .withIndex("by_ownerId_and_uploadExpiresAt", (q) =>
            q.eq("ownerId", ownerId),
          )
          .take(1),
      ),
      accountResidueCheck("backup_legacy_r2_sweeps_source", () =>
        ctx.db
          .query("backup_legacy_r2_sweeps")
          .withIndex("by_sourceOwnerId_and_kind", (q) =>
            q.eq("sourceOwnerId", ownerId).eq("kind", "migration"),
          )
          .take(1),
      ),
      accountResidueCheck("backup_legacy_r2_sweeps_destination", () =>
        ctx.db
          .query("backup_legacy_r2_sweeps")
          .withIndex("by_destinationOwnerId_and_kind", (q) =>
            q.eq("destinationOwnerId", ownerId).eq("kind", "migration"),
          )
          .take(1),
      ),
    ]);
    return checks.filter((name): name is string => name !== null).sort();
  },
});

// ─── Backups (R2 blobs + rows) ───────────────────────────────────────────────

const BACKUP_BATCH = 100;
const BACKUP_MIGRATION_DELETE_BATCH = 24;
// Historical finalized rows predate durable PUT-expiry tracking. Before any
// physical delete, give every such locator a full conservative R2 upload-URL
// lifetime so a still-live legacy PUT cannot recreate bytes after the locator
// has been acknowledged away.
const LEGACY_BACKUP_UPLOAD_AUTHORITY_FENCE_MS = 20 * 60_000;

const backupReservationLocatorValidator = v.object({
  id: v.id("backup_upload_reservations"),
  ownerId: v.string(),
  ownerGeneration: v.string(),
  keyFingerprint: v.string(),
  kind: v.union(v.literal("object"), v.literal("manifest")),
  snapshotId: v.string(),
  objectId: v.optional(v.string()),
  r2Key: v.string(),
  ciphertextBinding: v.optional(v.string()),
  uploadExpiresAt: v.number(),
});

type BackupReservationLocator = {
  id: Id<"backup_upload_reservations">;
  ownerId: string;
  ownerGeneration: string;
  keyFingerprint: string;
  kind: "object" | "manifest";
  snapshotId: string;
  objectId?: string;
  r2Key: string;
  ciphertextBinding?: string;
  uploadExpiresAt: number;
};

const backupMigrationArgsValidator = {
  fromOwnerId: v.string(),
  toOwnerId: v.string(),
  migrationId: v.string(),
  leaseId: v.string(),
  leaseGeneration: v.number(),
  fromOwnerGeneration: v.string(),
  toOwnerGeneration: v.string(),
  planRevision: v.number(),
  now: v.number(),
};

type BackupMigrationArgs = {
  fromOwnerId: string;
  toOwnerId: string;
  migrationId: string;
  leaseId: string;
  leaseGeneration: number;
  fromOwnerGeneration: string;
  toOwnerGeneration: string;
  planRevision: number;
  now: number;
};

const assertBackupMigrationLease = async (
  ctx: MutationCtx,
  args: BackupMigrationArgs,
) => {
  const rows = await ctx.db
    .query("auth_owner_migrations")
    .withIndex("by_fromOwnerId_and_updatedAt", (q) =>
      q.eq("fromOwnerId", args.fromOwnerId),
    )
    .take(2);
  const migration = rows[0];
  if (
    rows.length !== 1 ||
    !migration ||
    String(migration._id) !== args.migrationId ||
    migration.toOwnerId !== args.toOwnerId ||
    migration.status !== "running" ||
    migration.leaseId !== args.leaseId ||
    migration.leaseGeneration !== args.leaseGeneration ||
    (migration.leaseExpiresAt ?? 0) <= Date.now() ||
    migration.fromOwnerGeneration !== args.fromOwnerGeneration ||
    migration.toOwnerGeneration !== args.toOwnerGeneration ||
    (migration.planRevision ?? 1) !== args.planRevision
  ) {
    throw new ConvexError({
      code: "STALE_OWNERSHIP_MIGRATION_LEASE",
      message: "Backup cleanup no longer owns the migration lease.",
    });
  }
  await Promise.all([
    assertOwnerDataWriteAllowed(
      ctx,
      args.fromOwnerId,
      args.fromOwnerGeneration,
    ),
    assertOwnerDataWriteAllowed(ctx, args.toOwnerId, args.toOwnerGeneration),
  ]);
};

export const _listBackupObjectBatch = internalQuery({
  args: { ownerId: v.string() },
  returns: v.array(
    v.object({
      id: v.id("backup_objects"),
      r2Key: v.string(),
      uploadExpiresAt: v.optional(v.number()),
    }),
  ),
  handler: async (ctx, { ownerId }) => {
    const rows = await ctx.db
      .query("backup_objects")
      .withIndex("by_ownerId_and_createdAt", (q) => q.eq("ownerId", ownerId))
      .take(BACKUP_BATCH);
    return rows.map((row) => ({
      id: row._id,
      r2Key: row.r2Key,
      uploadExpiresAt: row.uploadExpiresAt,
    }));
  },
});

export const _listBackupManifestBatch = internalQuery({
  args: { ownerId: v.string() },
  returns: v.array(
    v.object({
      id: v.id("backup_manifests"),
      r2Key: v.string(),
      uploadExpiresAt: v.optional(v.number()),
    }),
  ),
  handler: async (ctx, { ownerId }) => {
    const rows = await ctx.db
      .query("backup_manifests")
      .withIndex("by_ownerId_and_createdAt", (q) => q.eq("ownerId", ownerId))
      .take(BACKUP_BATCH);
    return rows.map((row) => ({
      id: row._id,
      r2Key: row.manifestR2Key,
      uploadExpiresAt: row.uploadExpiresAt,
    }));
  },
});

export const fenceLegacyBackupUploadAuthorityInternal = internalMutation({
  args: {
    ownerId: v.string(),
    operationId: v.string(),
    generation: v.string(),
  },
  returns: v.object({
    fenced: v.number(),
    hasMore: v.boolean(),
  }),
  handler: async (ctx, args) => {
    await assertOwnerPurgeOperation(ctx, args);
    const [objects, manifests] = await Promise.all([
      ctx.db
        .query("backup_objects")
        .withIndex("by_ownerId_and_uploadExpiresAt", (q) =>
          q.eq("ownerId", args.ownerId).eq("uploadExpiresAt", undefined),
        )
        .take(BACKUP_BATCH + 1),
      ctx.db
        .query("backup_manifests")
        .withIndex("by_ownerId_and_uploadExpiresAt", (q) =>
          q.eq("ownerId", args.ownerId).eq("uploadExpiresAt", undefined),
        )
        .take(BACKUP_BATCH + 1),
    ]);
    const boundedObjects = objects.slice(0, BACKUP_BATCH);
    const boundedManifests = manifests.slice(0, BACKUP_BATCH);
    if (boundedObjects.length === 0 && boundedManifests.length === 0) {
      return { fenced: 0, hasMore: false };
    }
    const uploadExpiresAt =
      Date.now() + LEGACY_BACKUP_UPLOAD_AUTHORITY_FENCE_MS;
    await Promise.all([
      ...boundedObjects.map((row) =>
        ctx.db.patch(row._id, { uploadExpiresAt }),
      ),
      ...boundedManifests.map((row) =>
        ctx.db.patch(row._id, { uploadExpiresAt }),
      ),
    ]);
    return {
      fenced: boundedObjects.length + boundedManifests.length,
      hasMore: objects.length > BACKUP_BATCH || manifests.length > BACKUP_BATCH,
    };
  },
});

export const _listBackupUploadReservationBatch = internalQuery({
  args: { ownerId: v.string() },
  returns: v.array(
    v.object({
      id: v.id("backup_upload_reservations"),
      ownerId: v.string(),
      ownerGeneration: v.string(),
      keyFingerprint: v.string(),
      kind: v.union(v.literal("object"), v.literal("manifest")),
      snapshotId: v.string(),
      objectId: v.optional(v.string()),
      r2Key: v.string(),
      ciphertextBinding: v.optional(v.string()),
      uploadExpiresAt: v.number(),
    }),
  ),
  handler: async (ctx, { ownerId }) => {
    const rows = await ctx.db
      .query("backup_upload_reservations")
      .withIndex("by_ownerId_and_uploadExpiresAt", (q) =>
        q.eq("ownerId", ownerId),
      )
      .take(BACKUP_BATCH);
    return rows.map((row) => ({
      id: row._id,
      ownerId: row.ownerId,
      ownerGeneration: row.ownerGeneration,
      keyFingerprint: row.keyFingerprint,
      kind: row.kind,
      snapshotId: row.snapshotId,
      ...(row.objectId ? { objectId: row.objectId } : {}),
      r2Key: row.r2Key,
      ciphertextBinding: row.ciphertextBinding,
      uploadExpiresAt: row.uploadExpiresAt,
    }));
  },
});

const consumeReservationsBackedByFinalizedRows = async (
  ctx: MutationCtx,
  candidates: BackupReservationLocator[],
) => {
  if (candidates.length > BACKUP_BATCH) {
    throw new ConvexError({
      code: "INVALID_ARGUMENT",
      message: "Backup reservation reference batch is too large.",
    });
  }
  let consumed = 0;
  for (const candidate of candidates) {
    const current = await ctx.db.get(candidate.id);
    if (
      current?.ownerId !== candidate.ownerId ||
      current.ownerGeneration !== candidate.ownerGeneration ||
      current.keyFingerprint !== candidate.keyFingerprint ||
      current.kind !== candidate.kind ||
      current.snapshotId !== candidate.snapshotId ||
      current.objectId !== candidate.objectId ||
      current.r2Key !== candidate.r2Key ||
      current.ciphertextBinding !== candidate.ciphertextBinding ||
      current.uploadExpiresAt !== candidate.uploadExpiresAt
    ) {
      continue;
    }
    const [objects, manifests] = await Promise.all([
      ctx.db
        .query("backup_objects")
        .withIndex("by_r2Key", (q) => q.eq("r2Key", current.r2Key))
        .take(2),
      ctx.db
        .query("backup_manifests")
        .withIndex("by_manifestR2Key", (q) =>
          q.eq("manifestR2Key", current.r2Key),
        )
        .take(2),
    ]);
    if (objects.length + manifests.length === 0) continue;
    if (objects.length + manifests.length !== 1) {
      throw new Error(
        "backup_reservation_repair_required: finalized R2 locator is not globally unique.",
      );
    }
    const object = objects[0];
    const manifest = manifests[0];
    if (object) {
      if (
        current.kind !== "object" ||
        object.ownerId !== current.ownerId ||
        object.objectId !== current.objectId ||
        (object.ownerGeneration !== undefined &&
          object.ownerGeneration !== current.ownerGeneration) ||
        (object.keyFingerprint !== undefined &&
          object.keyFingerprint !== current.keyFingerprint)
      ) {
        throw new Error(
          "backup_reservation_repair_required: object reservation conflicts with finalized authority.",
        );
      }
      await ctx.db.patch(object._id, {
        uploadExpiresAt: Math.max(
          object.uploadExpiresAt ?? 0,
          current.uploadExpiresAt,
        ),
      });
    } else if (manifest) {
      if (
        current.kind !== "manifest" ||
        manifest.ownerId !== current.ownerId ||
        manifest.snapshotId !== current.snapshotId ||
        (manifest.ownerGeneration !== undefined &&
          manifest.ownerGeneration !== current.ownerGeneration) ||
        (manifest.keyFingerprint !== undefined &&
          manifest.keyFingerprint !== current.keyFingerprint)
      ) {
        throw new Error(
          "backup_reservation_repair_required: manifest reservation conflicts with finalized authority.",
        );
      }
      await ctx.db.patch(manifest._id, {
        uploadExpiresAt: Math.max(
          manifest.uploadExpiresAt ?? 0,
          current.uploadExpiresAt,
        ),
      });
    }
    await ctx.db.delete(current._id);
    consumed += 1;
  }
  return consumed;
};

export const consumeReferencedBackupReservationsForMigrationInternal =
  internalMutation({
    args: {
      ...backupMigrationArgsValidator,
      reservations: v.array(backupReservationLocatorValidator),
    },
    returns: v.number(),
    handler: async (ctx, args) => {
      await assertBackupMigrationLease(ctx, args);
      for (const candidate of args.reservations) {
        const expectedGeneration =
          candidate.ownerId === args.fromOwnerId
            ? args.fromOwnerGeneration
            : candidate.ownerId === args.toOwnerId
              ? args.toOwnerGeneration
              : null;
        if (expectedGeneration !== candidate.ownerGeneration) {
          throw new ConvexError({
            code: "STALE_OWNERSHIP_MIGRATION_LEASE",
            message:
              "Backup reservation is outside the active ownership migration.",
          });
        }
      }
      return await consumeReservationsBackedByFinalizedRows(
        ctx,
        args.reservations,
      );
    },
  });

export const consumeReferencedBackupReservationsForPurgeInternal =
  internalMutation({
    args: {
      ownerId: v.string(),
      operationId: v.string(),
      generation: v.string(),
      reservations: v.array(backupReservationLocatorValidator),
    },
    returns: v.number(),
    handler: async (ctx, args) => {
      await assertOwnerPurgeOperation(ctx, args);
      if (
        args.reservations.some(
          (candidate) => candidate.ownerId !== args.ownerId,
        )
      ) {
        throw new ConvexError({
          code: "INVALID_ARGUMENT",
          message: "Backup reservation is outside the owner purge.",
        });
      }
      return await consumeReservationsBackedByFinalizedRows(
        ctx,
        args.reservations,
      );
    },
  });

export const assertBackupMigrationLeaseInternal = internalMutation({
  args: backupMigrationArgsValidator,
  returns: v.null(),
  handler: async (ctx, args) => {
    await assertBackupMigrationLease(ctx, args);
    return null;
  },
});

export const acknowledgeBackupMigrationReservationCleanupInternal =
  internalMutation({
    args: {
      ...backupMigrationArgsValidator,
      reservations: v.array(
        v.object({
          id: v.id("backup_upload_reservations"),
          ownerId: v.string(),
          ownerGeneration: v.string(),
          keyFingerprint: v.string(),
          kind: v.union(v.literal("object"), v.literal("manifest")),
          snapshotId: v.string(),
          objectId: v.optional(v.string()),
          r2Key: v.string(),
          ciphertextBinding: v.optional(v.string()),
          uploadExpiresAt: v.number(),
        }),
      ),
    },
    returns: v.number(),
    handler: async (ctx, args) => {
      await assertBackupMigrationLease(ctx, args);
      if (args.reservations.length > BACKUP_MIGRATION_DELETE_BATCH) {
        throw new ConvexError({
          code: "INVALID_ARGUMENT",
          message: "Backup migration cleanup acknowledgement is too large.",
        });
      }
      let acknowledged = 0;
      for (const candidate of args.reservations) {
        const expectedGeneration =
          candidate.ownerId === args.fromOwnerId
            ? args.fromOwnerGeneration
            : candidate.ownerId === args.toOwnerId
              ? args.toOwnerGeneration
              : null;
        const current = await ctx.db.get(candidate.id);
        if (
          expectedGeneration === null ||
          current?.ownerId !== candidate.ownerId ||
          current.ownerGeneration !== expectedGeneration ||
          current.ownerGeneration !== candidate.ownerGeneration ||
          current.keyFingerprint !== candidate.keyFingerprint ||
          current.kind !== candidate.kind ||
          current.snapshotId !== candidate.snapshotId ||
          current.objectId !== candidate.objectId ||
          current.r2Key !== candidate.r2Key ||
          current.ciphertextBinding !== candidate.ciphertextBinding ||
          current.uploadExpiresAt !== candidate.uploadExpiresAt ||
          current.uploadExpiresAt > Date.now()
        ) {
          continue;
        }
        await ctx.db.delete(current._id);
        acknowledged += 1;
      }
      return acknowledged;
    },
  });

/**
 * Cancels unfinalized source and destination backup uploads during account
 * linking.
 * Finalized backup rows and escrows are preserved for backup_migration, which
 * waits out their PUT authority before re-owning immutable R2 locators.
 */
export const cleanupOwnerBackupReservationsForMigrationInternal =
  internalAction({
    args: backupMigrationArgsValidator,
    returns: v.object({
      ready: v.boolean(),
      retryAfterMs: v.optional(v.number()),
    }),
    handler: async (ctx, args) => {
      await ctx.runMutation(
        internal.account_deletion.assertBackupMigrationLeaseInternal,
        args,
      );
      const [sourceBatch, destinationBatch] = await Promise.all([
        ctx.runQuery(
          internal.account_deletion._listBackupUploadReservationBatch,
          { ownerId: args.fromOwnerId },
        ),
        ctx.runQuery(
          internal.account_deletion._listBackupUploadReservationBatch,
          { ownerId: args.toOwnerId },
        ),
      ]);
      const batch = [...sourceBatch, ...destinationBatch].slice(
        0,
        BACKUP_BATCH,
      );
      if (batch.length === 0) return { ready: true };

      const consumedReferences = await ctx.runMutation(
        internal.account_deletion
          .consumeReferencedBackupReservationsForMigrationInternal,
        { ...args, reservations: batch },
      );
      if (consumedReferences > 0) {
        return { ready: false, retryAfterMs: 1_000 };
      }

      const now = Date.now();
      const eligible = batch
        .filter((row) => row.uploadExpiresAt <= now)
        .slice(0, BACKUP_MIGRATION_DELETE_BATCH);
      if (eligible.length > 0) {
        // Revalidate immediately before physical I/O. The acknowledgement
        // mutation repeats the exact lease + locator tuple checks after I/O.
        await ctx.runMutation(
          internal.account_deletion.assertBackupMigrationLeaseInternal,
          args,
        );
        const deletion = await ctx.runAction(deleteComponentR2ObjectsRef, {
          objects: eligible.map((row) => ({
            locatorId: String(row.id),
            r2Key: row.r2Key,
          })),
        });
        const confirmedIds = new Set(deletion.confirmedLocatorIds);
        const confirmed = eligible.filter((row) =>
          confirmedIds.has(String(row.id)),
        );
        if (confirmed.length > 0) {
          await ctx.runMutation(
            internal.account_deletion
              .acknowledgeBackupMigrationReservationCleanupInternal,
            { ...args, reservations: confirmed },
          );
        }
        if (confirmed.length !== eligible.length) {
          return { ready: false, retryAfterMs: 5_000 };
        }
      }

      const [remainingSource, remainingDestination] = await Promise.all([
        ctx.runQuery(
          internal.account_deletion._listBackupUploadReservationBatch,
          { ownerId: args.fromOwnerId },
        ),
        ctx.runQuery(
          internal.account_deletion._listBackupUploadReservationBatch,
          { ownerId: args.toOwnerId },
        ),
      ]);
      const remaining = [...remainingSource, ...remainingDestination];
      if (remaining.length === 0) return { ready: true };
      const nextExpiry = Math.min(
        ...remaining.map((row) => row.uploadExpiresAt),
      );
      return {
        ready: false,
        retryAfterMs:
          nextExpiry > now ? Math.max(1_000, nextExpiry - now) : 1_000,
      };
    },
  });

export const _deleteBackupRows = internalMutation({
  args: {
    ownerId: v.string(),
    operationId: v.string(),
    generation: v.string(),
    objects: v.array(
      v.object({
        id: v.id("backup_objects"),
        r2Key: v.string(),
        uploadExpiresAt: v.optional(v.number()),
      }),
    ),
    manifests: v.array(
      v.object({
        id: v.id("backup_manifests"),
        r2Key: v.string(),
        uploadExpiresAt: v.optional(v.number()),
      }),
    ),
    reservations: v.optional(
      v.array(
        v.object({
          id: v.id("backup_upload_reservations"),
          ownerId: v.string(),
          ownerGeneration: v.string(),
          keyFingerprint: v.string(),
          kind: v.union(v.literal("object"), v.literal("manifest")),
          snapshotId: v.string(),
          objectId: v.optional(v.string()),
          r2Key: v.string(),
          ciphertextBinding: v.optional(v.string()),
          uploadExpiresAt: v.number(),
        }),
      ),
    ),
  },
  returns: v.object({ deleted: v.number() }),
  handler: async (ctx, args) => {
    await assertOwnerPurgeOperation(ctx, args);
    let deleted = 0;
    for (const candidate of args.objects) {
      const current = await ctx.db.get(candidate.id);
      if (
        current?.ownerId === args.ownerId &&
        current.r2Key === candidate.r2Key &&
        (current.uploadExpiresAt ?? 0) === (candidate.uploadExpiresAt ?? 0) &&
        (current.uploadExpiresAt ?? 0) <= Date.now()
      ) {
        await ctx.db.delete(current._id);
        deleted += 1;
      }
    }
    for (const candidate of args.manifests) {
      const current = await ctx.db.get(candidate.id);
      if (
        current?.ownerId === args.ownerId &&
        current.manifestR2Key === candidate.r2Key &&
        (current.uploadExpiresAt ?? 0) === (candidate.uploadExpiresAt ?? 0) &&
        (current.uploadExpiresAt ?? 0) <= Date.now()
      ) {
        await ctx.db.delete(current._id);
        deleted += 1;
      }
    }
    for (const candidate of args.reservations ?? []) {
      const current = await ctx.db.get(candidate.id);
      if (
        candidate.ownerId === args.ownerId &&
        current?.ownerId === candidate.ownerId &&
        current.ownerGeneration === candidate.ownerGeneration &&
        current.keyFingerprint === candidate.keyFingerprint &&
        current.kind === candidate.kind &&
        current.snapshotId === candidate.snapshotId &&
        current.objectId === candidate.objectId &&
        current.r2Key === candidate.r2Key &&
        current.ciphertextBinding === candidate.ciphertextBinding &&
        current.uploadExpiresAt === candidate.uploadExpiresAt &&
        current.uploadExpiresAt <= Date.now()
      ) {
        await ctx.db.delete(current._id);
        deleted += 1;
      }
    }
    return { deleted };
  },
});

const drainBackups = async (
  ctx: ActionCtx,
  fence: { ownerId: string; operationId: string; generation: string },
  leaseId: string,
  mode: "reset" | "delete",
) => {
  const { ownerId } = fence;
  const sweepArgs = { ...fence, leaseId, mode };
  await ctx.runMutation(internal.owner_lifecycle.renewOwnerPurgeLeaseInternal, {
    ...sweepArgs,
    stage: "core",
    now: Date.now(),
  });
  let legacySweep: { ready: boolean; retryAfterMs?: number } = {
    ready: false,
    retryAfterMs: 1_000,
  };
  for (let step = 0; step < 8; step += 1) {
    legacySweep = await ctx.runAction(advancePurgeLegacyR2SweepRef, sweepArgs);
    if (legacySweep.ready || (legacySweep.retryAfterMs ?? 1_000) > 1_000) {
      break;
    }
  }
  if (!legacySweep.ready) {
    backupSweepPending(
      "Account deletion is waiting for legacy backup raw-storage quiescence.",
      legacySweep.retryAfterMs ?? 1_000,
    );
  }

  while (true) {
    const batch: Array<{
      id: Id<"backup_upload_reservations">;
      ownerId: string;
      ownerGeneration: string;
      keyFingerprint: string;
      kind: "object" | "manifest";
      snapshotId: string;
      objectId?: string;
      r2Key: string;
      ciphertextBinding?: string;
      uploadExpiresAt: number;
    }> = await ctx.runQuery(
      internal.account_deletion._listBackupUploadReservationBatch,
      { ownerId },
    );
    if (batch.length === 0) break;
    const consumedReferences = await ctx.runMutation(
      internal.account_deletion
        .consumeReferencedBackupReservationsForPurgeInternal,
      { ...fence, reservations: batch },
    );
    if (consumedReferences > 0) continue;
    const deleteStartedAt = Date.now();
    const eligible = batch.filter(
      (row) => row.uploadExpiresAt <= deleteStartedAt,
    );
    if (eligible.length > 0) {
      await ctx.runMutation(
        internal.owner_lifecycle.renewOwnerPurgeLeaseInternal,
        {
          ...fence,
          stage: "core",
          leaseId,
          mode,
          now: deleteStartedAt,
        },
      );
      const deletion = await ctx.runAction(deleteComponentR2ObjectsRef, {
        objects: eligible.map((row) => ({
          locatorId: String(row.id),
          r2Key: row.r2Key,
        })),
      });
      const confirmedIds = new Set(deletion.confirmedLocatorIds);
      const confirmed = eligible.filter((row) =>
        confirmedIds.has(String(row.id)),
      );
      await ctx.runMutation(internal.account_deletion._deleteBackupRows, {
        ...fence,
        objects: [],
        manifests: [],
        reservations: confirmed,
      });
      if (confirmed.length !== eligible.length) {
        throw new Error(
          "Account deletion is waiting for reserved backup upload deletion; locator rows were retained for retry.",
        );
      }
    }
    if (eligible.length !== batch.length) {
      throw new Error(
        "Account deletion is waiting for active backup upload authority to expire.",
      );
    }
  }

  while (true) {
    const batch: Array<{
      id: Id<"backup_objects">;
      r2Key: string;
      uploadExpiresAt?: number;
    }> = await ctx.runQuery(internal.account_deletion._listBackupObjectBatch, {
      ownerId,
    });
    if (batch.length === 0) break;
    if (batch.some((row) => row.uploadExpiresAt === undefined)) {
      throw new Error(
        "Account deletion is waiting for legacy backup upload authority to be fenced.",
      );
    }
    const deleteStartedAt = Date.now();
    const eligible = batch.filter(
      (row) =>
        row.uploadExpiresAt !== undefined &&
        row.uploadExpiresAt <= deleteStartedAt,
    );
    if (eligible.length === 0) {
      throw new Error(
        "Account deletion is waiting for active backup object upload authority to expire.",
      );
    }
    await ctx.runMutation(
      internal.owner_lifecycle.renewOwnerPurgeLeaseInternal,
      {
        ...fence,
        stage: "core",
        leaseId,
        mode,
        now: deleteStartedAt,
      },
    );
    const deletion = await ctx.runAction(deleteComponentR2ObjectsRef, {
      objects: eligible.map((row) => ({
        locatorId: String(row.id),
        r2Key: row.r2Key,
      })),
    });
    const confirmedIds = new Set(deletion.confirmedLocatorIds);
    const confirmed = eligible.filter((row) =>
      confirmedIds.has(String(row.id)),
    );
    await ctx.runMutation(internal.account_deletion._deleteBackupRows, {
      ...fence,
      objects: confirmed,
      manifests: [],
    });
    if (confirmed.length !== eligible.length) {
      throw new Error(
        "Account deletion is waiting for backup object deletion; locator rows were retained for retry.",
      );
    }
    if (eligible.length !== batch.length) {
      throw new Error(
        "Account deletion is waiting for active backup object upload authority to expire.",
      );
    }
  }
  while (true) {
    const batch: Array<{
      id: Id<"backup_manifests">;
      r2Key: string;
      uploadExpiresAt?: number;
    }> = await ctx.runQuery(
      internal.account_deletion._listBackupManifestBatch,
      { ownerId },
    );
    if (batch.length === 0) break;
    if (batch.some((row) => row.uploadExpiresAt === undefined)) {
      throw new Error(
        "Account deletion is waiting for legacy backup upload authority to be fenced.",
      );
    }
    const deleteStartedAt = Date.now();
    const eligible = batch.filter(
      (row) =>
        row.uploadExpiresAt !== undefined &&
        row.uploadExpiresAt <= deleteStartedAt,
    );
    if (eligible.length === 0) {
      throw new Error(
        "Account deletion is waiting for active backup manifest upload authority to expire.",
      );
    }
    await ctx.runMutation(
      internal.owner_lifecycle.renewOwnerPurgeLeaseInternal,
      {
        ...fence,
        stage: "core",
        leaseId,
        mode,
        now: deleteStartedAt,
      },
    );
    const deletion = await ctx.runAction(deleteComponentR2ObjectsRef, {
      objects: eligible.map((row) => ({
        locatorId: String(row.id),
        r2Key: row.r2Key,
      })),
    });
    const confirmedIds = new Set(deletion.confirmedLocatorIds);
    const confirmed = eligible.filter((row) =>
      confirmedIds.has(String(row.id)),
    );
    await ctx.runMutation(internal.account_deletion._deleteBackupRows, {
      ...fence,
      objects: [],
      manifests: confirmed,
    });
    if (confirmed.length !== eligible.length) {
      throw new Error(
        "Account deletion is waiting for backup manifest deletion; locator rows were retained for retry.",
      );
    }
    if (eligible.length !== batch.length) {
      throw new Error(
        "Account deletion is waiting for active backup manifest upload authority to expire.",
      );
    }
  }
  await ctx.runMutation(internal.account_deletion._deleteBackupEscrow, fence);
  await ctx.runMutation(internal.owner_lifecycle.renewOwnerPurgeLeaseInternal, {
    ...sweepArgs,
    stage: "core",
    now: Date.now(),
  });
  await ctx.runMutation(upgradePurgeLegacyR2SweepToEmptyRef, sweepArgs);
  let emptyProof: { ready: boolean; retryAfterMs?: number } = {
    ready: false,
    retryAfterMs: 1_000,
  };
  for (let step = 0; step < 8; step += 1) {
    emptyProof = await ctx.runAction(advancePurgeLegacyR2SweepRef, sweepArgs);
    if (emptyProof.ready) break;
  }
  if (!emptyProof.ready) {
    backupSweepPending(
      "Account deletion is waiting for final legacy backup absence verification.",
      emptyProof.retryAfterMs ?? 1_000,
    );
  }
};

export const _deleteBackupEscrow = internalMutation({
  args: {
    ownerId: v.string(),
    operationId: v.string(),
    generation: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    await assertOwnerPurgeOperation(ctx, args);
    const [object, manifest, reservation] = await Promise.all([
      ctx.db
        .query("backup_objects")
        .withIndex("by_ownerId_and_createdAt", (q) =>
          q.eq("ownerId", args.ownerId),
        )
        .first(),
      ctx.db
        .query("backup_manifests")
        .withIndex("by_ownerId_and_createdAt", (q) =>
          q.eq("ownerId", args.ownerId),
        )
        .first(),
      ctx.db
        .query("backup_upload_reservations")
        .withIndex("by_ownerId_and_uploadExpiresAt", (q) =>
          q.eq("ownerId", args.ownerId),
        )
        .first(),
    ]);
    if (object || manifest || reservation) {
      throw new Error(
        "Backup encryption authority cannot be removed before every object locator is gone.",
      );
    }
    const escrows = await ctx.db
      .query("backup_key_escrows")
      .withIndex("by_ownerId", (q) => q.eq("ownerId", args.ownerId))
      .take(BACKUP_BATCH);
    await Promise.all(escrows.map((escrow) => ctx.db.delete(escrow._id)));
    return null;
  },
});

/**
 * Focused action boundary for the backup object-first drain. The full account
 * deletion action uses the same helper; keeping this internal entrypoint also
 * makes response-loss/retry and exact readback independently verifiable.
 */
export const purgeOwnerBackupsInternal = internalAction({
  args: {
    ownerId: v.string(),
    operationId: v.string(),
    generation: v.string(),
    leaseId: v.string(),
    mode: v.optional(v.union(v.literal("reset"), v.literal("delete"))),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    await drainBackups(
      ctx,
      {
        ownerId: args.ownerId,
        operationId: args.operationId,
        generation: args.generation,
      },
      args.leaseId,
      args.mode ?? "delete",
    );
    return null;
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
 * row. Mirrors `reset.resetAllUserData` but takes an explicit owner id (used
 * at account-deletion time, when there is no `ctx.auth.getUserIdentity()`).
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
      // Open the media gate before any other deletion work or parallel drain.
      // Reservations and dispatch claims observe this same durable row
      // transactionally, so no new provider work can cross the purge boundary.
      await ctx.runMutation(internal.media_jobs.beginOwnerMediaPurge, {
        ownerId,
        startedAt: Date.now(),
      });
      // Fence relay resume before any long-running deletion work. Reservations
      // and active stream appends reject this owner once the gate is visible, so
      // response plaintext cannot be recreated behind a completed drain.
      await ctx.runMutation(
        internal.stella_provider.relay_resume_store.beginOwnerRelayResumePurge,
        { ...fence, nowMs: Date.now() },
      );
      await ensureExternalOwnerPurge(ctx, { ...fence, mode: "delete" });
      await ctx.runMutation(
        internal.media_jobs.cancelOwnerMediaProviderDispatchesInternal,
        { ...fence, leaseId, mode: "delete", now: Date.now() },
      );
      await ctx.runAction(
        internal.media_image_submission.drainOwnerProviderCancellations,
        { ownerId, limit: 100 },
      );
      const mediaDispatches = await ctx.runMutation(
        internal.media_jobs.cancelOwnerMediaProviderDispatchesInternal,
        { ...fence, leaseId, mode: "delete", now: Date.now() },
      );
      if (!mediaDispatches.ready) {
        throw new Error(
          `Account deletion is waiting for media provider dispatch quiescence: ${mediaDispatches.pending.join(", ")}`,
        );
      }
      const voiceDispatches = await ctx.runMutation(
        internal.voice_dispatch.cancelOwnerVoiceProviderDispatchesInternal,
        { ...fence, leaseId, mode: "delete", now: Date.now() },
      );
      if (!voiceDispatches.ready) {
        throw new Error(
          `Account deletion is waiting for voice provider dispatch quiescence: ${voiceDispatches.pending.join(", ")}`,
        );
      }
      const managedDispatches = await ctx.runMutation(
        internal.account_billing_purge.quiesceOwnerManagedDispatchesInternal,
        { ...fence, leaseId, mode: "delete", now: Date.now() },
      );
      if (!managedDispatches.ready) {
        throw new Error(
          `Account deletion is waiting for managed provider dispatch quiescence: ${managedDispatches.pending.join(", ")}`,
        );
      }
      const stripeDispatches = await ctx.runMutation(
        internal.stripe_operation_dispatch
          .quiesceOwnerStripeOperationsForPurgeInternal,
        { ...fence, leaseId, mode: "delete", now: Date.now() },
      );
      if (!stripeDispatches.ready) {
        throw new Error(
          `Account deletion is waiting for Stripe operation reconciliation: ${stripeDispatches.pending.join(", ")}`,
        );
      }
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
      // Schedules are the only owner store that keeps creating conversations and
      // spending model tokens while deletion runs. Stop them before any long
      // table/R2 drain; the strict cloud-stack purge below repeats this guard.
      await stopOwnerSchedules(ctx, fence);
      const placement = await quiesceOwnerExecutionPlacement(ctx, fence);
      if (!placement.ready) {
        throw new Error(
          "Account deletion is waiting for accepted desktop/cloud execution to stop; device verification keys and dispatch locators were retained for retry.",
        );
      }
      const externalMedia = await ctx.runAction(
        internal.account_external_media.purgeOwnerExternalMediaInternal,
        { ...fence, leaseId },
      );
      if (!externalMedia.ready) {
        throw new Error(
          `Account deletion is waiting for external media cleanup: ${externalMedia.pending.join(", ")}`,
        );
      }
      // TTS owns its exact provider-attempt receipt. Quiesce/settle that
      // authority before any general billing teardown can remove audit rows.
      const ttsSocial = await ctx.runAction(
        internal.account_tts_social_purge.purgeOwnerTtsSocialInternal,
        { ...fence, leaseId },
      );
      if (!ttsSocial.ready) {
        throw new Error(
          `Account deletion is waiting for TTS/social cleanup: ${ttsSocial.pending.join(", ")}`,
        );
      }
      const billing = await ctx.runAction(
        internal.account_billing_purge.purgeOwnerBillingInternal,
        { ...fence, leaseId },
      );
      if (!billing.ready) {
        throw new Error(
          `Account deletion is waiting for billing cleanup: ${billing.pending.join(", ")}`,
        );
      }
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
        ...MOBILE_TABLES.map((table) => drainMobileTable(ctx, fence, table)),
        ...EXTRA_TABLES.map((table) => drainExtraTable(ctx, fence, table)),
        (async () => {
          const drain = async () => {
            let hasMore = true;
            while (hasMore) {
              const result: { hasMore: boolean } = await ctx.runMutation(
                internal.stella_provider.relay_resume_store
                  .deleteOwnerRelayResumeBatch,
                { ...fence, nowMs: Date.now() },
              );
              hasMore = result.hasMore;
            }
          };
          await drain();
          // A second pass closes the window for work that was already in flight
          // when the durable purge gate became visible. The account-deletion
          // gate remains until its TTL cleanup; unlike reset, it is not reopened.
          await drain();
        })(),
        drainBackups(ctx, fence, leaseId, "delete"),
        // Cloudflare DNS/tunnel first; the exact Convex locator row last.
        ctx.runAction(internal.cloudflare_tunnels.purgeOwnerTunnels, {
          ...fence,
          leaseId,
          mode: "delete",
        }),
        // Canvas shares: delete R2 objects + rows for this owner.
        ctx.runAction(internal.data.canvas_shares_actions.purgeOwnerShares, {
          ownerUserId: ownerId,
          operationId: fence.operationId,
          generation: fence.generation,
          leaseId,
          mode: "delete",
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

      // Final external re-drain closes the window for a creator that reserved
      // its durable locator immediately before the deletion fence. Active
      // reservations remain retry debt until their bounded lease ends.
      await ctx.runAction(internal.cloudflare_tunnels.purgeOwnerTunnels, {
        ...fence,
        leaseId,
        mode: "delete",
      });
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
      while (true) {
        const swept = await ctx.runMutation(
          purgeAbandonedLegacyR2SweepReceiptsRef,
          { ...fence, leaseId, mode: "delete" },
        );
        if (!swept.hasMore) break;
      }
      const [
        remainingResetCore,
        remainingAccountCore,
        remainingExternalMedia,
        remainingBilling,
        remainingTtsSocial,
        remainingVoice,
        remainingMedia,
        remainingComposio,
        remainingComposioProvisioning,
        remainingStripeDispatches,
      ] = await Promise.all([
        ctx.runQuery(internal.reset.remainingOwnerResetStoresInternal, {
          ownerId,
        }),
        ctx.runQuery(
          internal.account_deletion.remainingOwnerAccountCoreStoresInternal,
          { ownerId },
        ),
        ctx.runAction(
          internal.account_external_media.remainingOwnerExternalMediaInternal,
          { ownerId },
        ),
        ctx.runQuery(
          internal.account_billing_purge.remainingOwnerBillingInternal,
          { ownerId },
        ),
        ctx.runQuery(
          internal.account_tts_social_purge.remainingOwnerTtsSocialInternal,
          { ownerId },
        ),
        ctx.runQuery(
          internal.voice_dispatch.remainingOwnerVoiceProviderDispatchesInternal,
          { ownerId },
        ),
        ctx.runQuery(
          internal.media_jobs.remainingOwnerMediaProviderDispatchesInternal,
          { ownerId },
        ),
        ctx.runAction(remainingOwnerComposioSessionsRef, { ownerId }),
        ctx.runQuery(remainingOwnerComposioProvisioningRef, { ownerId }),
        ctx.runQuery(
          internal.stripe_operation_dispatch
            .remainingOwnerStripeOperationDispatchesInternal,
          { ownerId, now: Date.now() },
        ),
      ]);
      const remainingCore = [
        ...remainingResetCore,
        ...remainingAccountCore,
        ...remainingExternalMedia,
        ...remainingBilling,
        ...remainingTtsSocial,
        ...remainingVoice,
        ...remainingMedia,
        ...remainingComposio,
        ...remainingComposioProvisioning,
        ...remainingStripeDispatches,
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
      const retryAfterMs = backupSweepRetryAfter(error);
      await ctx.runMutation(
        internal.owner_lifecycle.scheduleOwnerPurgeRetryInternal,
        {
          ...fence,
          stage: retryStage,
          leaseId,
          error: error instanceof Error ? error.message : String(error),
          ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
          now: Date.now(),
        },
      );
      throw error;
    }
  },
});
