"use node";

import { v } from "convex/values";
import { makeFunctionReference } from "convex/server";
import { internal } from "./_generated/api";
import { internalAction, type ActionCtx } from "./_generated/server";
import { deleteR2Object } from "./lib/r2_sigv4";
import { deleteComponentR2Object } from "./component_r2_deletion";

const MAX_DELETE_BATCH = 24;
const MAX_PENDING_DETAILS = 24;

type ExternalObjectRef = {
  id: import("./_generated/dataModel").Id<"account_external_media_objects">;
  storageKind: "raw-r2" | "component-r2";
  bucket?: string;
  r2Key: string;
};

type ExternalMediaMigrationCleanupArgs = {
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

const assertExternalMediaMigrationLeaseRef = makeFunctionReference<
  "mutation",
  ExternalMediaMigrationCleanupArgs,
  null
>("auth_migration:assertExternalMediaMigrationLeaseInternal");

const requireRawR2Credentials = (bucket: string) => {
  const accessKeyId = process.env.R2_ACCESS_KEY_ID?.trim();
  const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY?.trim();
  const endpoint = process.env.R2_ENDPOINT?.trim();
  if (!accessKeyId || !secretAccessKey || !endpoint) {
    throw new Error(
      "Raw R2 credentials are unavailable for external-media purge.",
    );
  }
  return { accessKeyId, secretAccessKey, endpoint, bucket };
};

const deleteExternalObject = async (
  ctx: ActionCtx,
  ref: ExternalObjectRef,
): Promise<void> => {
  if (ref.storageKind === "component-r2") {
    await deleteComponentR2Object(ctx, ref.r2Key);
    return;
  }
  const credentials = ref.bucket ? requireRawR2Credentials(ref.bucket) : null;
  if (!credentials) {
    throw new Error("Raw R2 deletion is missing its exact bucket.");
  }

  // Raw-R2 locators have no component metadata. Cloudflare R2 DELETE is
  // strongly consistent, and the signer accepts only a 2xx or an already
  // absent 404. A lost response leaves this durable locator in place; the next
  // pass safely repeats the idempotent delete.
  await deleteR2Object({
    key: ref.r2Key,
    r2: credentials,
  });
};

const pendingDeleteLabel = (ref: ExternalObjectRef): string =>
  `delete_failed:${ref.storageKind}:locator:${ref.id}`;

/**
 * One bounded, retry-safe account-deletion pass. Reset intentionally does not
 * call this: public pets, emoji packs, and Store releases survive Reset Data.
 */
export const purgeOwnerExternalMediaInternal = internalAction({
  args: {
    ownerId: v.string(),
    operationId: v.string(),
    generation: v.string(),
    leaseId: v.string(),
  },
  returns: v.object({ ready: v.boolean(), pending: v.array(v.string()) }),
  handler: async (ctx, args) => {
    await ctx.runMutation(
      internal.account_external_media_store
        .materializeLegacyExternalMediaInternal,
      args,
    );
    const now = Date.now();
    const batch: {
      targets: ExternalObjectRef[];
      activeReservation?: { uploadId: string; uploadExpiresAt: number };
    } = await ctx.runQuery(
      internal.account_external_media_store
        .getOwnerExternalMediaPurgeBatchInternal,
      { ownerId: args.ownerId, now },
    );
    const pending: string[] = [];
    if (batch.activeReservation) {
      pending.push(
        `active_upload:${batch.activeReservation.uploadId}:until:${batch.activeReservation.uploadExpiresAt}`,
      );
    }
    if (batch.targets.length > 0) {
      await ctx.runMutation(
        internal.owner_lifecycle.renewOwnerPurgeLeaseInternal,
        {
          ...args,
          stage: "core",
          mode: "delete",
          now: Date.now(),
        },
      );
      const results = await Promise.allSettled(
        batch.targets.slice(0, MAX_DELETE_BATCH).map(async (target) => {
          await deleteExternalObject(ctx, target);
          return target;
        }),
      );
      const deleted: ExternalObjectRef[] = [];
      results.forEach((result, index) => {
        if (result.status === "fulfilled") {
          deleted.push(result.value);
        } else if (pending.length < MAX_PENDING_DETAILS) {
          pending.push(pendingDeleteLabel(batch.targets[index]!));
        }
      });
      if (deleted.length > 0) {
        await ctx.runMutation(
          internal.account_external_media_store
            .acknowledgeOwnerExternalMediaDeletedInternal,
          { ...args, refs: deleted },
        );
      }
    }
    const remaining: string[] = await ctx.runQuery(
      internal.account_external_media_store
        .remainingOwnerExternalMediaRowsInternal,
      { ownerId: args.ownerId },
    );
    for (const entry of remaining) {
      if (pending.length >= MAX_PENDING_DETAILS) break;
      if (!pending.includes(entry)) pending.push(entry);
    }
    return { ready: pending.length === 0, pending };
  },
});

/** Strict final account-deletion readback; no lifecycle gate rows are counted. */
export const remainingOwnerExternalMediaInternal = internalAction({
  args: { ownerId: v.string() },
  returns: v.array(v.string()),
  handler: async (ctx, args): Promise<string[]> =>
    await ctx.runQuery(
      internal.account_external_media_store
        .remainingOwnerExternalMediaRowsInternal,
      args,
    ),
});

/**
 * Ownership migration cancels prepared writes instead of re-owning them. A
 * live credential is transient retry debt; after its full barrier expires the
 * exact external object is removed before its reservation row.
 */
export const cleanupOwnerExternalMediaReservationsForMigrationInternal =
  internalAction({
    args: {
      fromOwnerId: v.string(),
      toOwnerId: v.string(),
      migrationId: v.string(),
      leaseId: v.string(),
      leaseGeneration: v.number(),
      fromOwnerGeneration: v.string(),
      toOwnerGeneration: v.string(),
      planRevision: v.number(),
      now: v.number(),
    },
    returns: v.object({
      ready: v.boolean(),
      retryAfterMs: v.optional(v.number()),
    }),
    handler: async (ctx, args) => {
      await ctx.runMutation(assertExternalMediaMigrationLeaseRef, args);
      const batch: {
        targets: ExternalObjectRef[];
        activeReservation?: { uploadId: string; uploadExpiresAt: number };
      } = await ctx.runQuery(
        internal.account_external_media_store
          .getOwnerExternalMediaMigrationCleanupBatchInternal,
        { ownerId: args.fromOwnerId, now: args.now },
      );
      let deleteFailed = false;
      if (batch.targets.length > 0) {
        // Revalidate immediately before the external side effect. The exact
        // lease is checked again transactionally when successful deletes are
        // acknowledged below.
        await ctx.runMutation(assertExternalMediaMigrationLeaseRef, args);
        const results = await Promise.allSettled(
          batch.targets.map(async (target) => {
            await deleteExternalObject(ctx, target);
            return target;
          }),
        );
        const deleted: ExternalObjectRef[] = [];
        for (const result of results) {
          if (result.status === "fulfilled") deleted.push(result.value);
          else deleteFailed = true;
        }
        if (deleted.length > 0) {
          await ctx.runMutation(
            internal.account_external_media_store
              .acknowledgeExternalMediaMigrationCleanupInternal,
            { ...args, refs: deleted },
          );
        }
      }
      const hasReservations: boolean = await ctx.runQuery(
        internal.account_external_media_store
          .hasOwnerExternalMediaReservationsInternal,
        { ownerId: args.fromOwnerId },
      );
      if (!hasReservations && !batch.activeReservation) {
        return { ready: true };
      }
      const activeDelay = batch.activeReservation
        ? Math.max(1_000, batch.activeReservation.uploadExpiresAt - args.now)
        : 1_000;
      return {
        ready: false,
        retryAfterMs: deleteFailed ? 5_000 : activeDelay,
      };
    },
  });
