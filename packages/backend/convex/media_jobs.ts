import { ConvexError, type Value, v } from "convex/values";
import {
  internalMutation,
  internalQuery,
  query,
  type MutationCtx,
  type QueryCtx,
} from "./_generated/server";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import type {
  MediaGenerateRequest,
  MediaRequestSummary,
  MediaJobStatus,
  MediaSourceReference,
} from "./media_contract";
import {
  mediaJobErrorValidator,
  mediaJobBillingValidator,
  mediaJobResponseValidator,
  mediaBillingDispositionStateValidator,
  mediaProviderDispatchKindValidator,
  mediaRequestSummaryValidator,
} from "./schema/media";
import {
  isRecord,
  jsonValueValidator,
  optionalJsonValueValidator,
} from "./shared_validators";
import { extractDeliveryMediaFromOutput } from "./channels/connector_media_types";
import {
  MAX_PRIVATE_MEDIA_PAYLOAD_CHARS,
  PRIVATE_MEDIA_PAYLOAD_CHUNK_CHARS,
} from "./media_image_limits";
import { assertOwnerMigrationWriteAllowed } from "./auth";
import {
  assertOwnerPurgeLease,
  LEGACY_OWNER_GENERATION,
} from "./owner_lifecycle";
import { ownerPurgeModeValidator } from "./schema/owner_lifecycle";
import { recordMediaCompletedUsageAuthorized } from "./billing";
import {
  meterCompletedMediaJob,
  type MediaBillingRecord,
} from "./media_billing";

export const PUBLIC_MEDIA_TEST_OWNER_ID = "__public_media_test__";
export {
  MAX_PRIVATE_MEDIA_PAYLOAD_CHARS,
  PRIVATE_MEDIA_PAYLOAD_CHUNK_CHARS,
} from "./media_image_limits";
const INCOMPLETE_PRIVATE_PAYLOAD_RETENTION_MS = 60 * 60_000;
const UNATTACHED_PRIVATE_PAYLOAD_RETENTION_MS = 24 * 60 * 60_000;
export const AMBIGUOUS_FAL_PROVIDER_RECONCILIATION_MS =
  3 * 60 * 60_000 + 15 * 60_000;
export const MEDIA_PROVIDER_TRANSPORT_TIMEOUT_MS = 60_000;
export const MEDIA_PROVIDER_DISPATCH_LEASE_GRACE_MS = 15_000;
export const MEDIA_PROVIDER_DISPATCH_ABORT_GRACE_MS = 30_000;
export const MEDIA_PROVIDER_CANCELLATION_TIMEOUT_MS = 30_000;
export const MEDIA_PROVIDER_CANCELLATION_ABORT_GRACE_MS = 30_000;
export const MEDIA_BILLING_RECONCILIATION_RETRY_MS = 30_000;

/**
 * A newly-created job has not yet crossed a Stella-paid provider boundary.
 * This named, durable exemption is replaced with `pending` by the exact
 * provider-attempt reservation transaction. It is never inferred later from
 * catalog normality or from a missing billing payload.
 */
export const MEDIA_BILLING_POLICY_NO_PROVIDER_DISPATCH =
  "no_stella_paid_provider_dispatch";
export const MEDIA_BILLING_POLICY_PAID_PROVIDER_DISPATCH =
  "stella_paid_provider_dispatch";
export const MEDIA_BILLING_POLICY_PROVIDER_NOT_STARTED =
  "provider_call_not_started";
export const MEDIA_BILLING_POLICY_DEFINITIVE_REJECTION =
  "provider_definitive_rejection_not_chargeable";
export const MEDIA_BILLING_POLICY_USER_PROVIDED_KEY =
  "user_provided_provider_key_not_chargeable";

export const isMediaPublicTestModeEnabled = (): boolean =>
  process.env.MEDIA_PUBLIC_TEST_MODE?.trim() === "1";

type MediaRequestSourceSummary = {
  kind: "url" | "data_uri" | "base64_object";
  mimeType?: string;
  url?: string;
};

type StoredMediaRequestSummary = MediaRequestSummary & {
  input?: Record<string, Value>;
};

const redactLargeString = (value: string): string => {
  const trimmed = value.trim();
  if (/^data:[^;,\s]+;base64,/i.test(trimmed)) {
    return "[data-uri omitted]";
  }
  if (trimmed.length > 2048 && /^[A-Za-z0-9+/=\s]+$/.test(trimmed)) {
    return "[base64 omitted]";
  }
  return trimmed;
};

const sanitizeJsonValue = (value: unknown, depth = 0): Value => {
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "number"
  ) {
    return value;
  }
  if (typeof value === "string") {
    return redactLargeString(value);
  }
  if (Array.isArray(value)) {
    if (depth >= 6) {
      return [];
    }
    return value.map((entry) => sanitizeJsonValue(entry, depth + 1));
  }
  if (isRecord(value)) {
    if (depth >= 6) {
      return {};
    }
    return Object.fromEntries(
      Object.entries(value).map(([key, entryValue]) => [
        key,
        sanitizeJsonValue(entryValue, depth + 1),
      ]),
    );
  }
  return String(value);
};

const ownerMediaPurgeActive = async (ctx: QueryCtx, ownerId: string) =>
  (await ctx.db
    .query("media_owner_purges")
    .withIndex("by_ownerId", (q) => q.eq("ownerId", ownerId))
    .unique()) !== null;

const mediaOwnerGeneration = (row: { ownerGeneration?: string }): string =>
  row.ownerGeneration ?? LEGACY_OWNER_GENERATION;

const staleMediaGenerationError = () =>
  new ConvexError({
    code: "OWNER_DATA_GENERATION_STALE",
    message: "This media request started before the account data was reset.",
  });

const isOwnerFenceError = (error: unknown): boolean => {
  const code =
    error instanceof ConvexError &&
    typeof error.data === "object" &&
    error.data !== null
      ? (error.data as { code?: unknown }).code
      : undefined;
  return (
    code === "OWNER_DATA_PURGE_ACTIVE" ||
    code === "OWNER_DATA_GENERATION_STALE" ||
    code === "OWNERSHIP_MIGRATED"
  );
};

const validateMediaBillingEnvelope = (
  job: Pick<Doc<"media_jobs">, "endpointId">,
  billing: MediaBillingRecord,
): string | null => {
  if (billing.endpointId !== job.endpointId) {
    return "Billing endpoint does not match the admitted media endpoint.";
  }
  if (
    !Number.isFinite(billing.unitPriceUsd) ||
    billing.unitPriceUsd <= 0 ||
    !Number.isFinite(billing.quantity) ||
    billing.quantity <= 0 ||
    !Number.isSafeInteger(billing.costMicroCents) ||
    billing.costMicroCents <= 0
  ) {
    return "Billing quantity, price, and cost must be finite and positive.";
  }
  return null;
};

const recordAuthorizedMediaBilling = async (
  ctx: MutationCtx,
  args: {
    job: Doc<"media_jobs">;
    ownerGeneration: string;
    providerRequestId?: string;
    billing: MediaBillingRecord;
  },
): Promise<void> => {
  await recordMediaCompletedUsageAuthorized(ctx, {
    ownerId: args.job.ownerId,
    ownerGeneration: args.ownerGeneration,
    jobId: args.job.jobId,
    ...(args.providerRequestId
      ? { providerRequestId: args.providerRequestId }
      : {}),
    endpointId: args.billing.endpointId,
    billingUnit: String(args.billing.billingUnit),
    quantity: args.billing.quantity,
    costMicroCents: args.billing.costMicroCents,
  });
};

type MediaBillingResolution =
  | { state: "billed"; billing?: MediaBillingRecord }
  | { state: "not_chargeable"; policy?: string }
  | { state: "pending" | "unknown"; reason: string };

const mediaBillingResolutionPatch = (
  resolution: MediaBillingResolution,
  now: number,
) => ({
  billingDispositionState: resolution.state,
  billingDispositionPolicy:
    resolution.state === "not_chargeable"
      ? (resolution.policy ?? MEDIA_BILLING_POLICY_NO_PROVIDER_DISPATCH)
      : MEDIA_BILLING_POLICY_PAID_PROVIDER_DISPATCH,
  ...(resolution.state === "pending" || resolution.state === "unknown"
    ? { billingDispositionReason: resolution.reason }
    : { billingDispositionReason: undefined }),
  billingDispositionUpdatedAt: now,
  ...(resolution.state === "billed"
    ? {
        ...(resolution.billing ? { billing: resolution.billing } : {}),
        billingDispositionAttemptId: undefined,
      }
    : {}),
});

/**
 * Resolve an accepted asynchronous request when its catalog entry is safely
 * request-metered. Output-metered and unsupported entries remain durable
 * pending debt; absence of a catalog entry is never treated as free work.
 */
const resolveAcceptedRequestBilling = async (
  ctx: MutationCtx,
  args: {
    job: Doc<"media_jobs">;
    ownerGeneration: string;
    providerRequestId: string;
  },
): Promise<MediaBillingResolution> => {
  if (args.job.billingDispositionState === "billed") {
    return {
      state: "billed",
      ...(args.job.billing ? { billing: args.job.billing } : {}),
    };
  }

  let candidate: ReturnType<typeof meterCompletedMediaJob>;
  try {
    candidate = meterCompletedMediaJob({
      endpointId: args.job.endpointId,
      request: args.job.request,
      output: undefined,
    });
  } catch (error) {
    return {
      state: "pending",
      reason: `Request billing evaluation failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  if ("supported" in candidate) {
    return { state: "pending", reason: candidate.reason };
  }
  if (candidate.meteredFrom !== "request") {
    return {
      state: "pending",
      reason: "The accepted request requires output metadata before billing.",
    };
  }
  const invalid = validateMediaBillingEnvelope(args.job, candidate);
  if (invalid) return { state: "pending", reason: invalid };

  await recordAuthorizedMediaBilling(ctx, {
    job: args.job,
    ownerGeneration: args.ownerGeneration,
    providerRequestId: args.providerRequestId,
    billing: candidate,
  });
  return { state: "billed", billing: candidate };
};

/** A provider success may publish only after durable billing is resolved. */
const resolveSuccessfulMediaBilling = async (
  ctx: MutationCtx,
  args: {
    job: Doc<"media_jobs">;
    ownerGeneration: string;
    providerRequestId?: string;
    billing?: MediaBillingRecord;
  },
): Promise<MediaBillingResolution> => {
  if (args.job.billingDispositionState === "billed") {
    return {
      state: "billed",
      ...(args.job.billing ? { billing: args.job.billing } : {}),
    };
  }
  if (!args.billing) {
    if (args.job.billingDispositionState === "not_chargeable") {
      return {
        state: "not_chargeable",
        ...(args.job.billingDispositionPolicy
          ? { policy: args.job.billingDispositionPolicy }
          : {}),
      };
    }
    return {
      state: "unknown",
      reason: "A paid provider succeeded without supported billing metadata.",
    };
  }
  const invalid = validateMediaBillingEnvelope(args.job, args.billing);
  if (invalid) return { state: "unknown", reason: invalid };

  await recordAuthorizedMediaBilling(ctx, {
    job: args.job,
    ownerGeneration: args.ownerGeneration,
    ...(args.providerRequestId
      ? { providerRequestId: args.providerRequestId }
      : {}),
    billing: args.billing,
  });
  return { state: "billed", billing: args.billing };
};

/**
 * Bind every owner-data mutation to both the current lifecycle row and the
 * exact media row that admitted the work. The lifecycle read is in the same
 * transaction as the write, so reset/delete cannot interleave a resurrection.
 */
const assertMediaJobWriteAllowed = async (
  ctx: MutationCtx,
  job: { ownerId: string; ownerGeneration?: string },
  expectedGeneration: string,
) => {
  if (mediaOwnerGeneration(job) !== expectedGeneration) {
    throw staleMediaGenerationError();
  }
  await assertOwnerMigrationWriteAllowed(ctx, job.ownerId, expectedGeneration);
};

/** Global watchdogs skip rows whose owner generation is no longer writable. */
const mediaJobWriteAllowedForWatchdog = async (
  ctx: MutationCtx,
  job: { ownerId: string; ownerGeneration?: string },
): Promise<boolean> => {
  try {
    await assertMediaJobWriteAllowed(ctx, job, mediaOwnerGeneration(job));
    return true;
  } catch (error) {
    if (isOwnerFenceError(error)) return false;
    throw error;
  }
};

const markPrivateBlobPending = async (
  ctx: MutationCtx,
  args: {
    ownerId: string;
    storageId: Id<"_storage">;
    jobId?: string;
    now: number;
  },
) => {
  const existing = await ctx.db
    .query("media_private_blob_cleanup")
    .withIndex("by_storageId", (q) => q.eq("storageId", args.storageId))
    .unique();
  if (existing) {
    await ctx.db.patch(existing._id, {
      state: "pending",
      nextAttemptAt: args.now,
      updatedAt: args.now,
      ...(args.jobId ? { jobId: args.jobId } : {}),
    });
    return;
  }
  await ctx.db.insert("media_private_blob_cleanup", {
    ownerId: args.ownerId,
    storageId: args.storageId,
    ...(args.jobId ? { jobId: args.jobId } : {}),
    state: "pending",
    attempts: 0,
    nextAttemptAt: args.now,
    createdAt: args.now,
    updatedAt: args.now,
  });
};

const markPrivatePayloadManifestPending = async (
  ctx: MutationCtx,
  args: { manifestId: string; now: number },
) => {
  const manifest = await ctx.db
    .query("media_private_payload_manifests")
    .withIndex("by_manifestId", (q) => q.eq("manifestId", args.manifestId))
    .unique();
  if (!manifest) return;
  await ctx.db.patch(manifest._id, {
    state: "pending",
    nextAttemptAt: args.now,
    updatedAt: args.now,
  });
};

const enqueueProviderCancellation = async (
  ctx: MutationCtx,
  args: {
    ownerId: string;
    ownerGeneration: string;
    jobId: string;
    endpointId: string;
    providerRequestId: string;
    now: number;
  },
) => {
  const existing = await ctx.db
    .query("media_provider_cancellations")
    .withIndex("by_jobId", (q) => q.eq("jobId", args.jobId))
    .unique();
  if (existing) {
    if (
      existing.ownerId !== args.ownerId ||
      mediaOwnerGeneration(existing) !== args.ownerGeneration ||
      existing.endpointId !== args.endpointId ||
      existing.providerRequestId !== args.providerRequestId
    ) {
      throw new ConvexError({
        code: "MEDIA_CANCELLATION_IDEMPOTENCY_CONFLICT",
        message: "The cancellation id is bound to different provider work.",
      });
    }
  } else {
    await ctx.db.insert("media_provider_cancellations", {
      ownerId: args.ownerId,
      ownerGeneration: args.ownerGeneration,
      jobId: args.jobId,
      endpointId: args.endpointId,
      providerRequestId: args.providerRequestId,
      attempts: 0,
      nextAttemptAt: args.now,
      createdAt: args.now,
      updatedAt: args.now,
    });
  }
};

export const beginOwnerMediaPurge = internalMutation({
  args: { ownerId: v.string(), startedAt: v.number() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("media_owner_purges")
      .withIndex("by_ownerId", (q) => q.eq("ownerId", args.ownerId))
      .unique();
    if (!existing) await ctx.db.insert("media_owner_purges", args);
    const held = await ctx.db
      .query("media_private_blob_cleanup")
      .withIndex("by_ownerId_and_state", (q) =>
        q.eq("ownerId", args.ownerId).eq("state", "held"),
      )
      .take(500);
    for (const row of held) {
      await ctx.db.patch(row._id, {
        state: "pending",
        nextAttemptAt: args.startedAt,
        updatedAt: args.startedAt,
      });
    }
    for (const state of ["uploading", "held"] as const) {
      const manifests = await ctx.db
        .query("media_private_payload_manifests")
        .withIndex("by_ownerId_and_state", (q) =>
          q.eq("ownerId", args.ownerId).eq("state", state),
        )
        .take(500);
      for (const manifest of manifests) {
        await ctx.db.patch(manifest._id, {
          state: "pending",
          nextAttemptAt: args.startedAt,
          updatedAt: args.startedAt,
        });
      }
    }
    return null;
  },
});

export const createPrivatePayloadManifest = internalMutation({
  args: {
    ownerId: v.string(),
    ownerGeneration: v.string(),
    manifestId: v.string(),
    jobId: v.string(),
    clientRequestKey: v.string(),
    expectedChunks: v.number(),
    totalChars: v.number(),
    createdAt: v.number(),
  },
  returns: v.union(
    v.literal("created"),
    v.literal("uploading"),
    v.literal("held"),
    v.literal("pending"),
    v.literal("owner_purged"),
  ),
  handler: async (ctx, args) => {
    await assertOwnerMigrationWriteAllowed(
      ctx,
      args.ownerId,
      args.ownerGeneration,
    );
    if (
      !Number.isInteger(args.expectedChunks) ||
      args.expectedChunks < 1 ||
      args.expectedChunks >
        Math.ceil(
          MAX_PRIVATE_MEDIA_PAYLOAD_CHARS / PRIVATE_MEDIA_PAYLOAD_CHUNK_CHARS,
        ) ||
      !Number.isInteger(args.totalChars) ||
      args.totalChars < 1 ||
      args.totalChars > MAX_PRIVATE_MEDIA_PAYLOAD_CHARS
    ) {
      throw new Error("Encrypted media payload manifest exceeds safe limits.");
    }
    const existing = await ctx.db
      .query("media_private_payload_manifests")
      .withIndex("by_manifestId", (q) => q.eq("manifestId", args.manifestId))
      .unique();
    if (existing) {
      if (
        existing.ownerId !== args.ownerId ||
        mediaOwnerGeneration(existing) !== args.ownerGeneration ||
        existing.jobId !== args.jobId ||
        existing.clientRequestKey !== args.clientRequestKey ||
        existing.expectedChunks !== args.expectedChunks ||
        existing.totalChars !== args.totalChars
      ) {
        throw new Error("Encrypted media payload manifest identity conflict.");
      }
      return existing.state;
    }
    const purged = await ownerMediaPurgeActive(ctx, args.ownerId);
    await ctx.db.insert("media_private_payload_manifests", {
      ownerId: args.ownerId,
      ownerGeneration: args.ownerGeneration,
      manifestId: args.manifestId,
      jobId: args.jobId,
      clientRequestKey: args.clientRequestKey,
      state: purged ? "pending" : "uploading",
      expectedChunks: args.expectedChunks,
      writtenChunks: 0,
      totalChars: args.totalChars,
      writtenChars: 0,
      createdAt: args.createdAt,
      updatedAt: args.createdAt,
      nextAttemptAt: purged
        ? args.createdAt
        : args.createdAt + INCOMPLETE_PRIVATE_PAYLOAD_RETENTION_MS,
    });
    return purged ? ("owner_purged" as const) : ("created" as const);
  },
});

export const appendPrivatePayloadChunk = internalMutation({
  args: {
    ownerId: v.string(),
    ownerGeneration: v.string(),
    manifestId: v.string(),
    index: v.number(),
    data: v.string(),
    writtenAt: v.number(),
  },
  returns: v.union(v.literal("appended"), v.literal("owner_purged")),
  handler: async (ctx, args) => {
    await assertOwnerMigrationWriteAllowed(
      ctx,
      args.ownerId,
      args.ownerGeneration,
    );
    if (
      !Number.isInteger(args.index) ||
      args.index < 0 ||
      args.data.length < 1 ||
      args.data.length > PRIVATE_MEDIA_PAYLOAD_CHUNK_CHARS
    ) {
      throw new Error("Encrypted media payload chunk exceeds safe limits.");
    }
    const manifest = await ctx.db
      .query("media_private_payload_manifests")
      .withIndex("by_manifestId", (q) => q.eq("manifestId", args.manifestId))
      .unique();
    if (
      !manifest ||
      manifest.ownerId !== args.ownerId ||
      mediaOwnerGeneration(manifest) !== args.ownerGeneration
    ) {
      throw new Error("Encrypted media payload manifest is unavailable.");
    }
    if (
      manifest.state === "pending" ||
      (await ownerMediaPurgeActive(ctx, args.ownerId))
    ) {
      await ctx.db.patch(manifest._id, {
        state: "pending",
        nextAttemptAt: args.writtenAt,
        updatedAt: args.writtenAt,
      });
      return "owner_purged" as const;
    }
    if (manifest.state !== "uploading") {
      throw new Error("Encrypted media payload upload is already finalized.");
    }
    const existing = await ctx.db
      .query("media_private_payload_chunks")
      .withIndex("by_manifestId_and_index", (q) =>
        q.eq("manifestId", args.manifestId).eq("index", args.index),
      )
      .unique();
    if (existing) {
      if (
        existing.ownerId !== args.ownerId ||
        mediaOwnerGeneration(existing) !== args.ownerGeneration ||
        existing.data !== args.data
      ) {
        throw new Error("Encrypted media payload chunk identity conflict.");
      }
      return "appended" as const;
    }
    if (
      args.index !== manifest.writtenChunks ||
      args.index >= manifest.expectedChunks ||
      manifest.writtenChars + args.data.length > manifest.totalChars
    ) {
      throw new Error(
        "Encrypted media payload chunks are incomplete or unordered.",
      );
    }
    await ctx.db.insert("media_private_payload_chunks", {
      ownerId: args.ownerId,
      ownerGeneration: args.ownerGeneration,
      manifestId: args.manifestId,
      jobId: manifest.jobId,
      index: args.index,
      data: args.data,
      createdAt: args.writtenAt,
    });
    await ctx.db.patch(manifest._id, {
      writtenChunks: manifest.writtenChunks + 1,
      writtenChars: manifest.writtenChars + args.data.length,
      updatedAt: args.writtenAt,
      nextAttemptAt: args.writtenAt + INCOMPLETE_PRIVATE_PAYLOAD_RETENTION_MS,
    });
    return "appended" as const;
  },
});

export const finalizePrivatePayloadManifest = internalMutation({
  args: {
    ownerId: v.string(),
    ownerGeneration: v.string(),
    manifestId: v.string(),
    finalizedAt: v.number(),
  },
  returns: v.union(v.literal("held"), v.literal("owner_purged")),
  handler: async (ctx, args) => {
    await assertOwnerMigrationWriteAllowed(
      ctx,
      args.ownerId,
      args.ownerGeneration,
    );
    const manifest = await ctx.db
      .query("media_private_payload_manifests")
      .withIndex("by_manifestId", (q) => q.eq("manifestId", args.manifestId))
      .unique();
    if (
      !manifest ||
      manifest.ownerId !== args.ownerId ||
      mediaOwnerGeneration(manifest) !== args.ownerGeneration
    ) {
      throw new Error("Encrypted media payload manifest is unavailable.");
    }
    if (
      manifest.state === "pending" ||
      (await ownerMediaPurgeActive(ctx, args.ownerId))
    ) {
      await ctx.db.patch(manifest._id, {
        state: "pending",
        nextAttemptAt: args.finalizedAt,
        updatedAt: args.finalizedAt,
      });
      return "owner_purged" as const;
    }
    if (
      manifest.writtenChunks !== manifest.expectedChunks ||
      manifest.writtenChars !== manifest.totalChars
    ) {
      throw new Error("Encrypted media payload upload is incomplete.");
    }
    await ctx.db.patch(manifest._id, {
      state: "held",
      updatedAt: args.finalizedAt,
      nextAttemptAt: args.finalizedAt + UNATTACHED_PRIVATE_PAYLOAD_RETENTION_MS,
    });
    return "held" as const;
  },
});

export const makePrivatePayloadManifestDeletable = internalMutation({
  args: { manifestId: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    await markPrivatePayloadManifestPending(ctx, {
      manifestId: args.manifestId,
      now: Date.now(),
    });
    await ctx.scheduler.runAfter(
      0,
      internal.media_image_submission.deletePrivatePayloadManifest,
      { manifestId: args.manifestId },
    );
    return null;
  },
});

export const getPrivatePayloadManifest = internalQuery({
  args: { manifestId: v.string() },
  handler: async (ctx, args) =>
    await ctx.db
      .query("media_private_payload_manifests")
      .withIndex("by_manifestId", (q) => q.eq("manifestId", args.manifestId))
      .unique(),
});

export const listPrivatePayloadChunks = internalQuery({
  args: { manifestId: v.string(), afterIndex: v.number(), limit: v.number() },
  handler: async (ctx, args) =>
    await ctx.db
      .query("media_private_payload_chunks")
      .withIndex("by_manifestId_and_index", (q) =>
        q.eq("manifestId", args.manifestId).gt("index", args.afterIndex),
      )
      .take(Math.max(1, Math.min(args.limit, 32))),
});

export const deletePrivatePayloadChunkBatch = internalMutation({
  args: { manifestId: v.string(), limit: v.number() },
  returns: v.object({ deleted: v.number(), hasMore: v.boolean() }),
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query("media_private_payload_chunks")
      .withIndex("by_manifestId_and_index", (q) =>
        q.eq("manifestId", args.manifestId),
      )
      .take(Math.max(1, Math.min(args.limit, 100)));
    for (const row of rows) await ctx.db.delete(row._id);
    return { deleted: rows.length, hasMore: rows.length > 0 };
  },
});

export const deletePrivatePayloadManifestIfEmpty = internalMutation({
  args: { manifestId: v.string() },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const remaining = await ctx.db
      .query("media_private_payload_chunks")
      .withIndex("by_manifestId_and_index", (q) =>
        q.eq("manifestId", args.manifestId),
      )
      .first();
    if (remaining) return false;
    const manifest = await ctx.db
      .query("media_private_payload_manifests")
      .withIndex("by_manifestId", (q) => q.eq("manifestId", args.manifestId))
      .unique();
    if (manifest) await ctx.db.delete(manifest._id);
    return true;
  },
});

export const listDuePrivatePayloadManifests = internalQuery({
  args: { now: v.number(), limit: v.number() },
  handler: async (ctx, args) => {
    const limit = Math.max(1, Math.min(args.limit, 100));
    const rows = [];
    for (const state of ["pending", "uploading", "held"] as const) {
      if (rows.length >= limit) break;
      rows.push(
        ...(await ctx.db
          .query("media_private_payload_manifests")
          .withIndex("by_state_and_nextAttemptAt", (q) =>
            q.eq("state", state).lte("nextAttemptAt", args.now),
          )
          .take(limit - rows.length)),
      );
    }
    return rows;
  },
});

export const listOwnerPrivatePayloadManifests = internalQuery({
  args: { ownerId: v.string(), limit: v.number() },
  handler: async (ctx, args) => {
    const limit = Math.max(1, Math.min(args.limit, 100));
    const rows = [];
    for (const state of ["pending", "uploading", "held"] as const) {
      if (rows.length >= limit) break;
      rows.push(
        ...(await ctx.db
          .query("media_private_payload_manifests")
          .withIndex("by_ownerId_and_state", (q) =>
            q.eq("ownerId", args.ownerId).eq("state", state),
          )
          .take(limit - rows.length)),
      );
    }
    return rows;
  },
});

export const registerPrivateSubmissionBlob = internalMutation({
  args: {
    ownerId: v.string(),
    storageId: v.id("_storage"),
    createdAt: v.number(),
  },
  returns: v.union(v.literal("registered"), v.literal("owner_purged")),
  handler: async (ctx, args) => {
    const state = (await ownerMediaPurgeActive(ctx, args.ownerId))
      ? "pending"
      : "held";
    const existing = await ctx.db
      .query("media_private_blob_cleanup")
      .withIndex("by_storageId", (q) => q.eq("storageId", args.storageId))
      .unique();
    if (!existing) {
      await ctx.db.insert("media_private_blob_cleanup", {
        ownerId: args.ownerId,
        storageId: args.storageId,
        state,
        attempts: 0,
        nextAttemptAt: args.createdAt,
        createdAt: args.createdAt,
        updatedAt: args.createdAt,
      });
    }
    return state === "pending" ? "owner_purged" : "registered";
  },
});

export const makePrivateSubmissionBlobDeletable = internalMutation({
  args: {
    ownerId: v.string(),
    storageId: v.id("_storage"),
    jobId: v.optional(v.string()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    await markPrivateBlobPending(ctx, { ...args, now: Date.now() });
    await ctx.scheduler.runAfter(
      0,
      internal.media_image_submission.deleteSubmissionPayload,
      {
        storageId: args.storageId,
      },
    );
    return null;
  },
});

export const getPrivateBlobCleanup = internalQuery({
  args: { storageId: v.id("_storage") },
  handler: async (ctx, args) =>
    await ctx.db
      .query("media_private_blob_cleanup")
      .withIndex("by_storageId", (q) => q.eq("storageId", args.storageId))
      .unique(),
});

export const deletePrivateBlobCleanup = internalMutation({
  args: { storageId: v.id("_storage") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const row = await ctx.db
      .query("media_private_blob_cleanup")
      .withIndex("by_storageId", (q) => q.eq("storageId", args.storageId))
      .unique();
    if (row) {
      // Storage deletion and outbox acknowledgement share one Convex
      // transaction. A thrown storage error retains both the object pointer
      // and retry record.
      await ctx.storage.delete(args.storageId);
      await ctx.db.delete(row._id);
    }
    return null;
  },
});

export const failPrivateBlobCleanup = internalMutation({
  args: {
    storageId: v.id("_storage"),
    error: v.string(),
    failedAt: v.number(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const row = await ctx.db
      .query("media_private_blob_cleanup")
      .withIndex("by_storageId", (q) => q.eq("storageId", args.storageId))
      .unique();
    if (row) {
      const attempts = row.attempts + 1;
      await ctx.db.patch(row._id, {
        state: "pending",
        attempts,
        lastError: args.error.slice(0, 1_000),
        nextAttemptAt:
          args.failedAt +
          Math.min(60 * 60_000, 2 ** Math.min(attempts, 10) * 1_000),
        updatedAt: args.failedAt,
      });
    }
    return null;
  },
});

export const listDuePrivateBlobCleanup = internalQuery({
  args: { now: v.number(), limit: v.number() },
  handler: async (ctx, args) =>
    await ctx.db
      .query("media_private_blob_cleanup")
      .withIndex("by_state_and_nextAttemptAt", (q) =>
        q.eq("state", "pending").lte("nextAttemptAt", args.now),
      )
      .take(Math.max(1, Math.min(args.limit, 100))),
});

export const listOwnerPrivateBlobCleanup = internalQuery({
  args: { ownerId: v.string(), limit: v.number() },
  handler: async (ctx, args) => {
    const pending = await ctx.db
      .query("media_private_blob_cleanup")
      .withIndex("by_ownerId_and_state", (q) =>
        q.eq("ownerId", args.ownerId).eq("state", "pending"),
      )
      .take(Math.max(1, Math.min(args.limit, 100)));
    const held = await ctx.db
      .query("media_private_blob_cleanup")
      .withIndex("by_ownerId_and_state", (q) =>
        q.eq("ownerId", args.ownerId).eq("state", "held"),
      )
      .take(Math.max(1, Math.min(args.limit - pending.length, 100)));
    return [...pending, ...held];
  },
});

export const listOwnerProviderCancellations = internalQuery({
  args: { ownerId: v.string(), limit: v.number() },
  handler: async (ctx, args) =>
    await ctx.db
      .query("media_provider_cancellations")
      .withIndex("by_ownerId", (q) => q.eq("ownerId", args.ownerId))
      .take(Math.max(1, Math.min(args.limit, 100))),
});

export const hasOwnerMediaJobs = internalQuery({
  args: { ownerId: v.string() },
  returns: v.boolean(),
  handler: async (ctx, args) =>
    Boolean(
      await ctx.db
        .query("media_jobs")
        .withIndex("by_ownerId_and_createdAt", (q) =>
          q.eq("ownerId", args.ownerId),
        )
        .first(),
    ),
});

export const getProviderCancellationByJob = internalQuery({
  args: { jobId: v.string() },
  handler: async (ctx, args) =>
    await ctx.db
      .query("media_provider_cancellations")
      .withIndex("by_jobId", (q) => q.eq("jobId", args.jobId))
      .unique(),
});

export const listDueProviderCancellations = internalQuery({
  args: { now: v.number(), limit: v.number() },
  handler: async (ctx, args) =>
    await ctx.db
      .query("media_provider_cancellations")
      .withIndex("by_nextAttemptAt", (q) => q.lte("nextAttemptAt", args.now))
      .take(Math.max(1, Math.min(args.limit, 100))),
});

const providerCancellationClaimValidator = v.union(
  v.null(),
  v.object({
    ownerId: v.string(),
    ownerGeneration: v.optional(v.string()),
    jobId: v.string(),
    endpointId: v.string(),
    providerRequestId: v.string(),
    attemptDeadlineAt: v.number(),
    attemptQuiescentAfterAt: v.number(),
  }),
);

/**
 * Exact physical-attempt claim for the cleanup PUT. It intentionally does not
 * require an open owner lifecycle: provider cleanup must remain authorized
 * after reset, deletion, or migration has fenced normal paid work.
 */
export const claimProviderCancellationAttempt = internalMutation({
  args: {
    jobId: v.string(),
    attemptId: v.string(),
    now: v.number(),
  },
  returns: providerCancellationClaimValidator,
  handler: async (ctx, args) => {
    const row = await ctx.db
      .query("media_provider_cancellations")
      .withIndex("by_jobId", (q) => q.eq("jobId", args.jobId))
      .unique();
    if (!row || row.nextAttemptAt > args.now) return null;
    if (
      row.activeAttemptId &&
      row.attemptQuiescentAfterAt !== undefined &&
      args.now < row.attemptQuiescentAfterAt
    ) {
      return null;
    }
    const attemptDeadlineAt = args.now + MEDIA_PROVIDER_CANCELLATION_TIMEOUT_MS;
    const attemptQuiescentAfterAt =
      attemptDeadlineAt + MEDIA_PROVIDER_CANCELLATION_ABORT_GRACE_MS;
    await ctx.db.patch(row._id, {
      activeAttemptId: args.attemptId,
      attemptStartedAt: args.now,
      attemptDeadlineAt,
      attemptQuiescentAfterAt,
      nextAttemptAt: attemptQuiescentAfterAt,
      updatedAt: args.now,
    });
    return {
      ownerId: row.ownerId,
      ...(row.ownerGeneration ? { ownerGeneration: row.ownerGeneration } : {}),
      jobId: row.jobId,
      endpointId: row.endpointId,
      providerRequestId: row.providerRequestId,
      attemptDeadlineAt,
      attemptQuiescentAfterAt,
    };
  },
});

/**
 * Cheap cron gate for the three media cleanup retry queues. The drain
 * `internalAction`s are expensive to spin up (Node isolates) yet their queues
 * are empty in the overwhelming majority of sweeps, so mirror the
 * `sweepOrphanedTurns` pattern: run the bounded "is there work?" index reads
 * in a single mutation and only schedule a drain action when its queue
 * actually has due rows. Preserves all real cleanup behavior — only the idle
 * per-minute action spin is cut.
 */
export const sweepMediaCleanupQueues = internalMutation({
  args: { limit: v.optional(v.number()) },
  returns: v.object({
    blobCleanupDue: v.boolean(),
    payloadManifestsDue: v.boolean(),
    providerCancellationsDue: v.boolean(),
  }),
  handler: async (ctx, args) => {
    const now = Date.now();

    const blobDue = await ctx.db
      .query("media_private_blob_cleanup")
      .withIndex("by_state_and_nextAttemptAt", (q) =>
        q.eq("state", "pending").lte("nextAttemptAt", now),
      )
      .first();

    let manifestDue = false;
    for (const state of ["pending", "uploading", "held"] as const) {
      const row = await ctx.db
        .query("media_private_payload_manifests")
        .withIndex("by_state_and_nextAttemptAt", (q) =>
          q.eq("state", state).lte("nextAttemptAt", now),
        )
        .first();
      if (row) {
        manifestDue = true;
        break;
      }
    }

    const cancellationDue = await ctx.db
      .query("media_provider_cancellations")
      .withIndex("by_nextAttemptAt", (q) => q.lte("nextAttemptAt", now))
      .first();

    if (blobDue) {
      await ctx.scheduler.runAfter(
        0,
        internal.media_image_submission.drainPrivateBlobCleanup,
        { limit: args.limit },
      );
    }
    if (manifestDue) {
      await ctx.scheduler.runAfter(
        0,
        internal.media_image_submission.drainPrivatePayloadManifests,
        { limit: args.limit },
      );
    }
    if (cancellationDue) {
      await ctx.scheduler.runAfter(
        0,
        internal.media_image_submission.drainProviderCancellations,
        { limit: args.limit },
      );
    }

    return {
      blobCleanupDue: Boolean(blobDue),
      payloadManifestsDue: manifestDue,
      providerCancellationsDue: Boolean(cancellationDue),
    };
  },
});

export const completeProviderCancellation = internalMutation({
  args: { jobId: v.string(), attemptId: v.string() },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const row = await ctx.db
      .query("media_provider_cancellations")
      .withIndex("by_jobId", (q) => q.eq("jobId", args.jobId))
      .unique();
    if (!row || row.activeAttemptId !== args.attemptId) return false;
    await ctx.db.delete(row._id);
    return true;
  },
});

export const failProviderCancellation = internalMutation({
  args: {
    jobId: v.string(),
    attemptId: v.string(),
    error: v.string(),
    failedAt: v.number(),
  },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const row = await ctx.db
      .query("media_provider_cancellations")
      .withIndex("by_jobId", (q) => q.eq("jobId", args.jobId))
      .unique();
    if (!row || row.activeAttemptId !== args.attemptId) return false;
    const attempts = row.attempts + 1;
    await ctx.db.patch(row._id, {
      attempts,
      lastError: args.error.slice(0, 1_000),
      nextAttemptAt: Math.max(
        row.attemptQuiescentAfterAt ?? args.failedAt,
        args.failedAt +
          Math.min(60 * 60_000, 2 ** Math.min(attempts, 10) * 1_000),
      ),
      activeAttemptId: undefined,
      attemptStartedAt: undefined,
      attemptDeadlineAt: undefined,
      attemptQuiescentAfterAt: undefined,
      updatedAt: args.failedAt,
    });
    return true;
  },
});

const toSourceSummary = (
  source: MediaSourceReference | undefined,
): MediaRequestSourceSummary | undefined => {
  if (!source) {
    return undefined;
  }
  if (typeof source === "string") {
    if (/^data:/i.test(source.trim())) {
      const mimeType = source.trim().match(/^data:([^;,\s]+);base64,/i)?.[1];
      return {
        kind: "data_uri",
        ...(mimeType ? { mimeType } : {}),
      };
    }
    return { kind: "url", url: source.trim() };
  }
  return {
    kind: "base64_object",
    ...(source.mimeType.trim() ? { mimeType: source.mimeType.trim() } : {}),
  };
};

export const summarizeMediaRequestForStorage = (
  request: MediaGenerateRequest,
): StoredMediaRequestSummary => {
  const source =
    toSourceSummary(request.source) ??
    (request.sourceUrl
      ? { kind: "url" as const, url: request.sourceUrl }
      : undefined);
  const sources = request.sources
    ? Object.fromEntries(
        Object.entries(request.sources)
          .map(([key, value]) => [key, toSourceSummary(value)])
          .filter(
            (entry): entry is [string, MediaRequestSourceSummary] =>
              entry[1] !== undefined,
          ),
      )
    : undefined;

  const sanitizedInput = sanitizeJsonValue(request.input);
  return {
    ...(request.prompt ? { prompt: request.prompt } : {}),
    ...(request.aspectRatio ? { aspectRatio: request.aspectRatio } : {}),
    ...(source ? { source } : {}),
    ...(sources && Object.keys(sources).length > 0 ? { sources } : {}),
    ...(isRecord(sanitizedInput) && Object.keys(sanitizedInput).length > 0
      ? { input: sanitizedInput as Record<string, Value> }
      : {}),
  };
};

/**
 * Hard cap on how many child-table log entries we hydrate per job response.
 * Long-running jobs may accumulate many webhook entries; clients only need
 * the most recent few for display.
 */
const MAX_JOB_LOGS_RETURNED = 100;
const DEFAULT_STALE_MEDIA_JOB_LIMIT = 100;
const STALE_IMAGE_JOB_CAPABILITIES = [
  "text_to_image",
  "image_edit",
  "icon",
] as const;
const TERMINAL_MEDIA_JOB_STATUSES = new Set<MediaJobStatus>([
  "succeeded",
  "failed",
  "canceled",
  "unknown",
]);

const isTerminalMediaJobStatus = (status: MediaJobStatus): boolean =>
  TERMINAL_MEDIA_JOB_STATUSES.has(status);

const idempotentJobLookupValidator = v.object({
  jobId: v.string(),
  ownerGeneration: v.string(),
  capability: v.string(),
  profile: v.string(),
  status: v.union(
    v.literal("queued"),
    v.literal("running"),
    v.literal("succeeded"),
    v.literal("failed"),
    v.literal("canceled"),
    v.literal("unknown"),
  ),
  upstreamStatus: v.string(),
  clientRequestHash: v.optional(v.string()),
});

const toStoredMediaJobResponse = (
  job: {
    jobId: string;
    capability: string;
    profile: string;
    request: StoredMediaRequestSummary;
    status: MediaJobStatus;
    upstreamStatus: string;
    queuePosition: number | null;
    output?: Value;
    error?: { message: string; code?: string; details?: Value };
    createdAt: number;
    updatedAt: number;
    startedAt?: number;
    completedAt?: number;
  },
  childLogs?: Value[],
) => {
  return {
    jobId: job.jobId,
    capability: job.capability,
    profile: job.profile,
    request: job.request,
    status: job.status,
    upstreamStatus: job.upstreamStatus,
    queuePosition: job.queuePosition,
    ...(childLogs && childLogs.length > 0 ? { logs: childLogs } : {}),
    ...(job.output !== undefined ? { output: job.output } : {}),
    ...(job.error ? { error: job.error } : {}),
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    ...(job.startedAt !== undefined ? { startedAt: job.startedAt } : {}),
    ...(job.completedAt !== undefined ? { completedAt: job.completedAt } : {}),
  };
};

/**
 * Load the most recent webhook log entries for a job from the child
 * `media_job_logs` table. Returns chronologically-ordered entries (oldest
 * first) so callers can render them top-to-bottom.
 */
const loadJobLogs = async (
  ctx: Pick<QueryCtx, "db">,
  jobId: string,
): Promise<Value[]> => {
  const rows = await ctx.db
    .query("media_job_logs")
    .withIndex("by_jobId_and_ordinal", (q) => q.eq("jobId", jobId))
    .order("desc")
    .take(MAX_JOB_LOGS_RETURNED);
  return rows.reverse().map((row) => row.entry);
};

const toViewerOwnerId = async (ctx: QueryCtx): Promise<string> => {
  const ownerId = await toViewerOwnerIdOrNull(ctx);
  if (!ownerId) {
    throw new ConvexError({
      code: "UNAUTHENTICATED",
      message: "Authentication required",
    });
  }
  return ownerId;
};

/**
 * Read-side variant: returns null when no identity is attached so subscribed
 * queries can return empty/null instead of throwing into the React error
 * boundary during sign-in / sign-out transitions.
 */
const toViewerOwnerIdOrNull = async (ctx: QueryCtx): Promise<string | null> => {
  const identity = await ctx.auth.getUserIdentity();
  if (identity?.tokenIdentifier) {
    return identity.tokenIdentifier;
  }
  if (isMediaPublicTestModeEnabled()) {
    return PUBLIC_MEDIA_TEST_OWNER_ID;
  }
  return null;
};

const toInitialMediaJobStatus = (upstreamStatus: string): MediaJobStatus => {
  switch (upstreamStatus.trim().toUpperCase()) {
    case "COMPLETED":
    case "OK":
      return "succeeded";
    case "FAILED":
    case "ERROR":
      return "failed";
    case "CANCELLED":
    case "CANCELED":
      return "canceled";
    case "IN_PROGRESS":
    case "RUNNING":
      return "running";
    default:
      return "queued";
  }
};

const toWebhookMediaJobStatus = (upstreamStatus: string): MediaJobStatus => {
  switch (upstreamStatus.trim().toUpperCase()) {
    case "OK":
    case "COMPLETED":
      return "succeeded";
    case "CANCELLED":
    case "CANCELED":
      return "canceled";
    case "FAILED":
    case "ERROR":
    default:
      return "failed";
  }
};

const getJobByJobId = async (ctx: Pick<QueryCtx, "db">, jobId: string) =>
  await ctx.db
    .query("media_jobs")
    .withIndex("by_jobId", (q) => q.eq("jobId", jobId))
    .unique();

const getJobByProviderRequestId = async (
  ctx: Pick<QueryCtx, "db">,
  providerRequestId: string,
) =>
  await ctx.db
    .query("media_jobs")
    .withIndex("by_provider_and_providerRequestId", (q) =>
      q.eq("provider", "fal").eq("providerRequestId", providerRequestId),
    )
    .unique();

const getJobByClientRequestKey = async (
  ctx: Pick<QueryCtx, "db">,
  ownerId: string,
  clientRequestKey: string,
) =>
  await ctx.db
    .query("media_jobs")
    .withIndex("by_ownerId_and_clientRequestKey", (q) =>
      q.eq("ownerId", ownerId).eq("clientRequestKey", clientRequestKey),
    )
    .unique();

export const getByJobId = query({
  args: {
    jobId: v.string(),
  },
  returns: v.union(v.null(), mediaJobResponseValidator),
  handler: async (ctx, args) => {
    const ownerId = await toViewerOwnerIdOrNull(ctx);
    if (!ownerId) {
      return null;
    }
    const job = await ctx.db
      .query("media_jobs")
      .withIndex("by_ownerId_and_jobId", (q) =>
        q.eq("ownerId", ownerId).eq("jobId", args.jobId),
      )
      .unique();

    if (!job) {
      return null;
    }

    const childLogs = await loadJobLogs(ctx, job.jobId);
    return toStoredMediaJobResponse(job, childLogs);
  },
});

export const getByOwnerJobId = internalQuery({
  args: {
    ownerId: v.string(),
    ownerGeneration: v.string(),
    jobId: v.string(),
  },
  returns: v.union(v.null(), mediaJobResponseValidator),
  handler: async (ctx, args) => {
    await assertOwnerMigrationWriteAllowed(
      ctx,
      args.ownerId,
      args.ownerGeneration,
    );
    const job = await ctx.db
      .query("media_jobs")
      .withIndex("by_ownerId_and_jobId", (q) =>
        q.eq("ownerId", args.ownerId).eq("jobId", args.jobId),
      )
      .unique();

    return job && mediaOwnerGeneration(job) === args.ownerGeneration
      ? toStoredMediaJobResponse(job)
      : null;
  },
});

export const getByOwnerClientRequestKey = internalQuery({
  args: {
    ownerId: v.string(),
    ownerGeneration: v.string(),
    clientRequestKey: v.string(),
  },
  returns: v.union(v.null(), idempotentJobLookupValidator),
  handler: async (ctx, args) => {
    await assertOwnerMigrationWriteAllowed(
      ctx,
      args.ownerId,
      args.ownerGeneration,
    );
    const job = await getJobByClientRequestKey(
      ctx,
      args.ownerId,
      args.clientRequestKey,
    );
    return job && mediaOwnerGeneration(job) === args.ownerGeneration
      ? {
          jobId: job.jobId,
          ownerGeneration: args.ownerGeneration,
          capability: job.capability,
          profile: job.profile,
          status: job.status,
          upstreamStatus: job.upstreamStatus,
          ...(job.clientRequestHash
            ? { clientRequestHash: job.clientRequestHash }
            : {}),
        }
      : null;
  },
});

export const getImageSubmissionPayload = internalQuery({
  args: { jobId: v.string(), ownerGeneration: v.string() },
  returns: v.union(
    v.null(),
    v.object({
      storageId: v.optional(v.id("_storage")),
      manifestId: v.optional(v.string()),
      ownerId: v.string(),
      ownerGeneration: v.string(),
    }),
  ),
  handler: async (ctx, args) => {
    const job = await getJobByJobId(ctx, args.jobId);
    if (
      !job ||
      mediaOwnerGeneration(job) !== args.ownerGeneration ||
      job.submissionState !== "pending" ||
      (!job.submissionPayloadStorageId && !job.submissionPayloadManifestId) ||
      isTerminalMediaJobStatus(job.status)
    )
      return null;
    return {
      ownerId: job.ownerId,
      ownerGeneration: args.ownerGeneration,
      ...(job.submissionPayloadStorageId
        ? { storageId: job.submissionPayloadStorageId }
        : {}),
      ...(job.submissionPayloadManifestId
        ? { manifestId: job.submissionPayloadManifestId }
        : {}),
    };
  },
});

/**
 * Reactive feed of every succeeded media job for the current viewer that
 * completed at-or-after `since`. The desktop renderer subscribes to this on
 * boot so the Display sidebar can surface any media output regardless of who
 * started the job (MediaStudio, the agent's `MediaGenerate` tool, a CLI…).
 *
 * `since` is a `completedAt` lower bound (millis). Pass `Date.now()` on first
 * subscribe to get only jobs that finish after the app launches, or pass a
 * smaller value (e.g., last-seen timestamp from local storage) to also
 * back-fill recently missed completions.
 */
export const listSucceededSince = query({
  args: {
    since: v.number(),
    limit: v.optional(v.number()),
    /**
     * When `true`, hydrate the per-job webhook log entries from
     * `media_job_logs`. Defaults to `false` because the desktop materializer
     * (the primary subscriber) only consumes `output`/`status`/`request` and
     * doesn't need the noisy log array.
     */
    includeLogs: v.optional(v.boolean()),
  },
  returns: v.array(mediaJobResponseValidator),
  handler: async (ctx, args) => {
    const ownerId = await toViewerOwnerIdOrNull(ctx);
    if (!ownerId) {
      return [];
    }
    const limit = Math.max(1, Math.min(args.limit ?? 50, 200));
    // Indexed on `(ownerId, status, completedAt)` so we read only succeeded
    // rows in completion order — no JS-side status filter and no over-fetch.
    const succeeded = await ctx.db
      .query("media_jobs")
      .withIndex("by_ownerId_and_status_and_completedAt", (q) =>
        q
          .eq("ownerId", ownerId)
          .eq("status", "succeeded")
          .gte("completedAt", args.since),
      )
      .order("desc")
      .take(limit);

    const wantsLogs = args.includeLogs === true;
    const logs = wantsLogs
      ? await Promise.all(succeeded.map((row) => loadJobLogs(ctx, row.jobId)))
      : succeeded.map(() => undefined);
    return succeeded.map((row, index) =>
      toStoredMediaJobResponse(row, logs[index]),
    );
  },
});

export const listFailedSince = query({
  args: {
    since: v.number(),
    limit: v.optional(v.number()),
    includeLogs: v.optional(v.boolean()),
  },
  returns: v.array(mediaJobResponseValidator),
  handler: async (ctx, args) => {
    const ownerId = await toViewerOwnerIdOrNull(ctx);
    if (!ownerId) {
      return [];
    }
    const limit = Math.max(1, Math.min(args.limit ?? 50, 200));
    const terminalProblems = (
      await Promise.all(
        (["failed", "unknown"] as const).map((status) =>
          ctx.db
            .query("media_jobs")
            .withIndex("by_ownerId_and_status_and_completedAt", (q) =>
              q
                .eq("ownerId", ownerId)
                .eq("status", status)
                .gte("completedAt", args.since),
            )
            .order("desc")
            .take(limit),
        ),
      )
    )
      .flat()
      .sort((a, b) => (b.completedAt ?? 0) - (a.completedAt ?? 0))
      .slice(0, limit);

    const wantsLogs = args.includeLogs === true;
    const logs = wantsLogs
      ? await Promise.all(
          terminalProblems.map((row) => loadJobLogs(ctx, row.jobId)),
        )
      : terminalProblems.map(() => undefined);
    return terminalProblems.map((row, index) =>
      toStoredMediaJobResponse(row, logs[index]),
    );
  },
});

export const getWebhookJob = internalQuery({
  args: {
    jobId: v.optional(v.string()),
    providerRequestId: v.optional(v.string()),
  },
  returns: v.union(
    v.null(),
    v.object({
      jobId: v.string(),
      ownerId: v.string(),
      ownerGeneration: v.string(),
      request: mediaRequestSummaryValidator,
      endpointId: v.string(),
      providerRequestId: v.optional(v.string()),
      providerResponseUrl: v.optional(v.string()),
      providerStatusUrl: v.optional(v.string()),
    }),
  ),
  handler: async (ctx, args) => {
    // Fal webhook URLs normally embed `?jobId=`, but fall back to the
    // provider request id so a webhook that lost the query param still
    // resolves the job (and therefore still meters usage).
    const job =
      (args.jobId ? await getJobByJobId(ctx, args.jobId) : null) ??
      (args.providerRequestId
        ? await getJobByProviderRequestId(ctx, args.providerRequestId)
        : null);
    if (!job) {
      return null;
    }
    return {
      jobId: job.jobId,
      ownerId: job.ownerId,
      ownerGeneration: mediaOwnerGeneration(job),
      request: job.request,
      endpointId: job.endpointId,
      providerRequestId: job.providerRequestId,
      providerResponseUrl: job.providerResponseUrl,
      providerStatusUrl: job.providerStatusUrl,
    };
  },
});

/**
 * Transaction-plane provider gate for media actions. Unlike the lifecycle-only
 * owner guard, this also observes the permanent auth-migration source fence.
 */
export const assertMediaProviderDispatchAllowed = internalMutation({
  args: {
    ownerId: v.string(),
    ownerGeneration: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    await assertOwnerMigrationWriteAllowed(
      ctx,
      args.ownerId,
      args.ownerGeneration,
    );
    return null;
  },
});

export type MediaProviderDispatchKind =
  | "fal_submit"
  | "fal_poll"
  | "fal_download"
  | "google_lyria"
  | "openrouter";

export const falSubmissionDispatchId = (jobId: string): string =>
  `media:fal_submit:${jobId}`;

const MEDIA_QUIESCE_BATCH = 48;
const MEDIA_QUIESCE_MAX_BATCH = 100;
const MEDIA_QUIESCE_PREVIEW = 8;

const mediaProviderDispatchStateValidator = v.union(
  v.literal("active"),
  v.literal("cancel_requested"),
);

const mediaProviderReserveResultValidator = v.object({
  acquired: v.boolean(),
  status: v.union(
    v.literal("reserved"),
    v.literal("busy"),
    v.literal("canceled"),
  ),
  providerDeadlineAt: v.number(),
  leaseExpiresAt: v.number(),
  quiescentAfterAt: v.number(),
});

const mediaProviderQuiesceResultValidator = v.object({
  ready: v.boolean(),
  canceled: v.number(),
  reaped: v.number(),
  pending: v.array(v.string()),
  retryAt: v.union(v.number(), v.null()),
});

const mediaProviderTiming = (kind: MediaProviderDispatchKind, now: number) => {
  const transportMs =
    kind === "fal_submit" || kind === "fal_poll" || kind === "fal_download"
      ? 30_000
      : MEDIA_PROVIDER_TRANSPORT_TIMEOUT_MS;
  const providerDeadlineAt = now + transportMs;
  const leaseExpiresAt =
    providerDeadlineAt + MEDIA_PROVIDER_DISPATCH_LEASE_GRACE_MS;
  const quiescentAfterAt =
    kind === "fal_submit"
      ? now + AMBIGUOUS_FAL_PROVIDER_RECONCILIATION_MS
      : leaseExpiresAt + MEDIA_PROVIDER_DISPATCH_ABORT_GRACE_MS;
  return { providerDeadlineAt, leaseExpiresAt, quiescentAfterAt };
};

const readMediaProviderDispatch = async (
  ctx: Pick<QueryCtx, "db">,
  dispatchId: string,
) =>
  await ctx.db
    .query("media_provider_dispatch_leases")
    .withIndex("by_dispatchId", (q) => q.eq("dispatchId", dispatchId))
    .unique();

const readExactMediaProviderAttempt = async (
  ctx: Pick<QueryCtx, "db">,
  dispatchId: string,
  attemptId: string,
) =>
  await ctx.db
    .query("media_provider_dispatch_leases")
    .withIndex("by_dispatchId_and_attemptId", (q) =>
      q.eq("dispatchId", dispatchId).eq("attemptId", attemptId),
    )
    .unique();

const readExactMediaJobAttempt = async (
  ctx: Pick<QueryCtx, "db">,
  jobId: string,
  attemptId: string,
) =>
  await ctx.db
    .query("media_provider_dispatch_leases")
    .withIndex("by_jobId_and_attemptId", (q) =>
      q.eq("jobId", jobId).eq("attemptId", attemptId),
    )
    .unique();

const validateMediaProviderAttemptIds = (args: {
  dispatchId: string;
  attemptId: string;
}): void => {
  if (
    !args.dispatchId.trim() ||
    args.dispatchId.length > 512 ||
    !args.attemptId.trim() ||
    args.attemptId.length > 256
  ) {
    throw new ConvexError({
      code: "INVALID_ARGUMENT",
      message: "Media dispatch and attempt ids are required.",
    });
  }
};

const deleteMediaProviderAttempt = async (
  ctx: MutationCtx,
  row: NonNullable<Awaited<ReturnType<typeof readMediaProviderDispatch>>>,
): Promise<void> => {
  await ctx.scheduler.cancel(row.cleanupJobId);
  await ctx.db.delete(row._id);
};

const markMediaProviderCancellationDebt = async (
  ctx: MutationCtx,
  row: NonNullable<Awaited<ReturnType<typeof readMediaProviderDispatch>>>,
  args: {
    now: number;
    operationId?: string;
    generation?: string;
    ambiguous?: boolean;
  },
): Promise<void> => {
  await ctx.db.patch(row._id, {
    state: "cancel_requested",
    cancelRequestedAt: row.cancelRequestedAt ?? args.now,
    ...(args.operationId ? { cancelOperationId: args.operationId } : {}),
    ...(args.generation ? { cancelGeneration: args.generation } : {}),
    ...(args.ambiguous ? { ambiguousAt: row.ambiguousAt ?? args.now } : {}),
    updatedAt: args.now,
  });
};

const cancelMediaJobForOwnerFence = async (
  ctx: MutationCtx,
  job: NonNullable<Awaited<ReturnType<typeof getJobByJobId>>>,
  args: { now: number; preserveAmbiguousSubmissionState?: boolean },
): Promise<void> => {
  if (isTerminalMediaJobStatus(job.status)) return;

  if (job.submissionPayloadStorageId) {
    await markPrivateBlobPending(ctx, {
      ownerId: job.ownerId,
      storageId: job.submissionPayloadStorageId,
      jobId: job.jobId,
      now: args.now,
    });
    await ctx.scheduler.runAfter(
      0,
      internal.media_image_submission.deleteSubmissionPayload,
      { storageId: job.submissionPayloadStorageId },
    );
  }
  if (job.submissionPayloadManifestId) {
    await markPrivatePayloadManifestPending(ctx, {
      manifestId: job.submissionPayloadManifestId,
      now: args.now,
    });
    await ctx.scheduler.runAfter(
      0,
      internal.media_image_submission.deletePrivatePayloadManifest,
      { manifestId: job.submissionPayloadManifestId },
    );
  }
  if (job.provider === "fal" && job.providerRequestId) {
    await enqueueProviderCancellation(ctx, {
      ownerId: job.ownerId,
      ownerGeneration: mediaOwnerGeneration(job),
      jobId: job.jobId,
      endpointId: job.endpointId,
      providerRequestId: job.providerRequestId,
      now: args.now,
    });
    await ctx.scheduler.runAfter(
      0,
      internal.media_image_submission.cancelPurgedProviderRequest,
      { jobId: job.jobId },
    );
  }

  await ctx.db.patch(job._id, {
    status: "canceled",
    ...(job.submissionState && !args.preserveAmbiguousSubmissionState
      ? { submissionState: "canceled" as const }
      : {}),
    ...(job.submissionPayloadStorageId
      ? { submissionPayloadStorageId: undefined }
      : {}),
    ...(job.submissionPayloadManifestId
      ? { submissionPayloadManifestId: undefined }
      : {}),
    upstreamStatus: "OWNER_PURGED",
    queuePosition: null,
    error: {
      code: "OWNER_PURGED",
      message: "Media generation was canceled by an owner lifecycle fence.",
    },
    updatedAt: args.now,
    completedAt: args.now,
  });
};

const reserveMediaProviderAttempt = async (
  ctx: MutationCtx,
  args: {
    ownerId: string;
    ownerGeneration: string;
    dispatchId: string;
    attemptId: string;
    kind: MediaProviderDispatchKind;
    jobId?: string;
    now: number;
  },
): Promise<{
  acquired: boolean;
  status: "reserved" | "busy" | "canceled";
  providerDeadlineAt: number;
  leaseExpiresAt: number;
  quiescentAfterAt: number;
}> => {
  validateMediaProviderAttemptIds(args);
  await assertOwnerMigrationWriteAllowed(
    ctx,
    args.ownerId,
    args.ownerGeneration,
  );

  let boundJob: Doc<"media_jobs"> | null = null;
  if (args.jobId) {
    const job = await getJobByJobId(ctx, args.jobId);
    if (
      !job ||
      job.ownerId !== args.ownerId ||
      mediaOwnerGeneration(job) !== args.ownerGeneration ||
      isTerminalMediaJobStatus(job.status)
    ) {
      throw staleMediaGenerationError();
    }
    boundJob = job;
  }

  const existing = await readMediaProviderDispatch(ctx, args.dispatchId);
  if (existing) {
    if (
      existing.ownerId !== args.ownerId ||
      existing.ownerGeneration !== args.ownerGeneration ||
      existing.jobId !== args.jobId ||
      existing.kind !== args.kind
    ) {
      throw new ConvexError({
        code: "MEDIA_DISPATCH_IDEMPOTENCY_CONFLICT",
        message: "The media dispatch id is bound to different provider work.",
      });
    }
    if (
      existing.attemptId === args.attemptId ||
      args.now < existing.quiescentAfterAt
    ) {
      if (
        boundJob &&
        (boundJob.billingDispositionState === undefined ||
          (boundJob.billingDispositionState === "not_chargeable" &&
            boundJob.billingDispositionPolicy !==
              MEDIA_BILLING_POLICY_USER_PROVIDED_KEY))
      ) {
        await ctx.db.patch(boundJob._id, {
          billingDispositionState: "pending",
          billingDispositionPolicy: MEDIA_BILLING_POLICY_PAID_PROVIDER_DISPATCH,
          billingDispositionReason: undefined,
          billingDispositionUpdatedAt: args.now,
          billingDispositionAttemptId: existing.attemptId,
        });
      }
      return {
        acquired: false,
        status: existing.state === "cancel_requested" ? "canceled" : "busy",
        providerDeadlineAt: existing.providerDeadlineAt,
        leaseExpiresAt: existing.leaseExpiresAt,
        quiescentAfterAt: existing.quiescentAfterAt,
      };
    }
    await deleteMediaProviderAttempt(ctx, existing);
  }

  const timing = mediaProviderTiming(args.kind, args.now);
  const cleanupJobId = await ctx.scheduler.runAt(
    timing.quiescentAfterAt,
    internal.media_jobs.expireMediaProviderDispatchInternal,
    {
      dispatchId: args.dispatchId,
      attemptId: args.attemptId,
      quiescentAfterAt: timing.quiescentAfterAt,
    },
  );
  await ctx.db.insert("media_provider_dispatch_leases", {
    ownerId: args.ownerId,
    ownerGeneration: args.ownerGeneration,
    ...(args.jobId ? { jobId: args.jobId } : {}),
    dispatchId: args.dispatchId,
    attemptId: args.attemptId,
    kind: args.kind,
    state: "active",
    ...timing,
    cleanupJobId,
    createdAt: args.now,
    updatedAt: args.now,
  });
  if (
    boundJob &&
    (boundJob.billingDispositionState === undefined ||
      (boundJob.billingDispositionState === "not_chargeable" &&
        boundJob.billingDispositionPolicy !==
          MEDIA_BILLING_POLICY_USER_PROVIDED_KEY))
  ) {
    await ctx.db.patch(boundJob._id, {
      billingDispositionState: "pending",
      billingDispositionPolicy: MEDIA_BILLING_POLICY_PAID_PROVIDER_DISPATCH,
      billingDispositionReason: undefined,
      billingDispositionUpdatedAt: args.now,
      billingDispositionAttemptId: args.attemptId,
    });
  }
  return { acquired: true, status: "reserved", ...timing };
};

/**
 * Serializable admission for synchronous/job-backed media provider calls.
 * Durable Fal image outbox claims use claimImageSubmission below so the job
 * transition and this exact authority row commit atomically.
 */
export const reserveMediaProviderDispatchInternal = internalMutation({
  args: {
    ownerId: v.string(),
    ownerGeneration: v.string(),
    dispatchId: v.string(),
    attemptId: v.string(),
    kind: mediaProviderDispatchKindValidator,
    jobId: v.optional(v.string()),
    now: v.number(),
  },
  returns: mediaProviderReserveResultValidator,
  handler: async (ctx, args) => {
    const result = await reserveMediaProviderAttempt(ctx, args);
    if (result.acquired && args.kind === "fal_submit" && args.jobId) {
      const job = await getJobByJobId(ctx, args.jobId);
      if (!job) throw staleMediaGenerationError();
      if (
        job.submissionState !== undefined &&
        job.submissionState !== "pending"
      ) {
        const exact = await readExactMediaProviderAttempt(
          ctx,
          args.dispatchId,
          args.attemptId,
        );
        if (exact) await deleteMediaProviderAttempt(ctx, exact);
        if (
          job.billingDispositionState === "pending" &&
          job.billingDispositionAttemptId === args.attemptId
        ) {
          await ctx.db.patch(job._id, {
            billingDispositionState: "not_chargeable",
            billingDispositionPolicy: MEDIA_BILLING_POLICY_PROVIDER_NOT_STARTED,
            billingDispositionReason: undefined,
            billingDispositionUpdatedAt: args.now,
            billingDispositionAttemptId: undefined,
          });
        }
        return { ...result, acquired: false, status: "busy" as const };
      }
      await ctx.db.patch(job._id, {
        submissionState: "dispatching",
        submissionAttemptId: args.attemptId,
        submissionClaimedAt: args.now,
        updatedAt: args.now,
      });
    }
    return result;
  },
});

/** Exact lifecycle/migration/attempt check immediately before provider I/O. */
export const heartbeatMediaProviderDispatchInternal = internalMutation({
  args: {
    ownerId: v.string(),
    ownerGeneration: v.string(),
    dispatchId: v.string(),
    attemptId: v.string(),
    now: v.number(),
  },
  returns: v.object({
    found: v.boolean(),
    allowed: v.boolean(),
    state: v.union(mediaProviderDispatchStateValidator, v.null()),
    providerDeadlineAt: v.union(v.number(), v.null()),
    leaseExpiresAt: v.union(v.number(), v.null()),
    quiescentAfterAt: v.union(v.number(), v.null()),
  }),
  handler: async (ctx, args) => {
    const row = await readExactMediaProviderAttempt(
      ctx,
      args.dispatchId,
      args.attemptId,
    );
    const denied = (
      exact: typeof row,
      state: "active" | "cancel_requested" | null = exact?.state ?? null,
    ) => ({
      found: exact !== null,
      allowed: false,
      state,
      providerDeadlineAt: exact?.providerDeadlineAt ?? null,
      leaseExpiresAt: exact?.leaseExpiresAt ?? null,
      quiescentAfterAt: exact?.quiescentAfterAt ?? null,
    });
    if (
      !row ||
      row.ownerId !== args.ownerId ||
      row.ownerGeneration !== args.ownerGeneration
    ) {
      return denied(null);
    }
    let allowed =
      row.state === "active" &&
      args.now < row.providerDeadlineAt &&
      args.now < row.leaseExpiresAt;
    if (allowed) {
      try {
        await assertOwnerMigrationWriteAllowed(
          ctx,
          args.ownerId,
          args.ownerGeneration,
        );
      } catch (error) {
        if (!isOwnerFenceError(error)) throw error;
        allowed = false;
      }
    }
    if (!allowed) {
      if (row.state === "active") {
        await markMediaProviderCancellationDebt(ctx, row, {
          now: args.now,
          ambiguous: true,
        });
      }
      return denied(row, "cancel_requested");
    }
    await ctx.db.patch(row._id, { updatedAt: args.now });
    return {
      found: true,
      allowed: true,
      state: "active" as const,
      providerDeadlineAt: row.providerDeadlineAt,
      leaseExpiresAt: row.leaseExpiresAt,
      quiescentAfterAt: row.quiescentAfterAt,
    };
  },
});

/** A consumed response plus durable downstream write settles this exact call. */
export const settleMediaProviderDispatchInternal = internalMutation({
  args: {
    ownerId: v.string(),
    ownerGeneration: v.string(),
    dispatchId: v.string(),
    attemptId: v.string(),
    providerStarted: v.optional(v.boolean()),
  },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const row = await readExactMediaProviderAttempt(
      ctx,
      args.dispatchId,
      args.attemptId,
    );
    if (
      !row ||
      row.ownerId !== args.ownerId ||
      row.ownerGeneration !== args.ownerGeneration
    ) {
      return false;
    }
    if (args.providerStarted === false && row.jobId) {
      const job = await getJobByJobId(ctx, row.jobId);
      if (
        job &&
        job.ownerId === row.ownerId &&
        mediaOwnerGeneration(job) === row.ownerGeneration &&
        job.billingDispositionState === "pending" &&
        job.billingDispositionAttemptId === row.attemptId
      ) {
        await ctx.db.patch(job._id, {
          billingDispositionState: "not_chargeable",
          billingDispositionPolicy: MEDIA_BILLING_POLICY_PROVIDER_NOT_STARTED,
          billingDispositionReason: undefined,
          billingDispositionUpdatedAt: Date.now(),
          billingDispositionAttemptId: undefined,
        });
      }
    }
    await deleteMediaProviderAttempt(ctx, row);
    return true;
  },
});

/**
 * Atomically transfers a known Fal locator from live generation authority to
 * the lifecycle-independent cancellation outbox. There is never a gap where
 * reset/delete could observe neither the physical attempt nor cleanup debt.
 */
export const handoffMediaProviderCancellationInternal = internalMutation({
  args: {
    ownerId: v.string(),
    ownerGeneration: v.string(),
    dispatchId: v.string(),
    attemptId: v.string(),
    cancellationId: v.string(),
    endpointId: v.string(),
    providerRequestId: v.string(),
    now: v.number(),
  },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const row = await readExactMediaProviderAttempt(
      ctx,
      args.dispatchId,
      args.attemptId,
    );
    if (
      !row ||
      row.ownerId !== args.ownerId ||
      row.ownerGeneration !== args.ownerGeneration
    ) {
      return false;
    }
    await enqueueProviderCancellation(ctx, {
      ownerId: args.ownerId,
      ownerGeneration: args.ownerGeneration,
      jobId: args.cancellationId,
      endpointId: args.endpointId,
      providerRequestId: args.providerRequestId,
      now: args.now,
    });
    await ctx.scheduler.runAfter(
      0,
      internal.media_image_submission.cancelPurgedProviderRequest,
      { jobId: args.cancellationId },
    );
    await deleteMediaProviderAttempt(ctx, row);
    return true;
  },
});

/** Ambiguous transport outcome remains debt through its provider hard bound. */
export const abandonMediaProviderDispatchInternal = internalMutation({
  args: {
    ownerId: v.string(),
    ownerGeneration: v.string(),
    dispatchId: v.string(),
    attemptId: v.string(),
    now: v.number(),
  },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const row = await readExactMediaProviderAttempt(
      ctx,
      args.dispatchId,
      args.attemptId,
    );
    if (
      !row ||
      row.ownerId !== args.ownerId ||
      row.ownerGeneration !== args.ownerGeneration
    ) {
      return false;
    }
    await markMediaProviderCancellationDebt(ctx, row, {
      now: args.now,
      ambiguous: true,
    });
    return true;
  },
});

/** Exact scheduled reaper; never shortens the provider-specific bound. */
export const expireMediaProviderDispatchInternal = internalMutation({
  args: {
    dispatchId: v.string(),
    attemptId: v.string(),
    quiescentAfterAt: v.number(),
  },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const row = await readExactMediaProviderAttempt(
      ctx,
      args.dispatchId,
      args.attemptId,
    );
    if (
      !row ||
      row.quiescentAfterAt !== args.quiescentAfterAt ||
      Date.now() < row.quiescentAfterAt
    ) {
      return false;
    }
    await ctx.db.delete(row._id);
    return true;
  },
});

const settleMediaProviderAttemptForJob = async (
  ctx: MutationCtx,
  jobId: string,
  attemptId: string | undefined,
): Promise<void> => {
  if (!attemptId) return;
  const row = await readExactMediaJobAttempt(ctx, jobId, attemptId);
  if (row) await deleteMediaProviderAttempt(ctx, row);
};

const quiesceOwnerMediaRows = async (
  ctx: MutationCtx,
  args: {
    ownerId: string;
    now: number;
    limit?: number;
    operationId?: string;
    generation?: string;
  },
): Promise<{
  ready: boolean;
  canceled: number;
  reaped: number;
  pending: string[];
  retryAt: number | null;
}> => {
  const limit = Math.max(
    1,
    Math.min(MEDIA_QUIESCE_MAX_BATCH, args.limit ?? MEDIA_QUIESCE_BATCH),
  );
  let budget = limit;
  let reaped = 0;
  let canceled = 0;

  for (const state of ["cancel_requested", "active"] as const) {
    if (budget <= 0) break;
    const expired = await ctx.db
      .query("media_provider_dispatch_leases")
      .withIndex("by_ownerId_and_state_and_quiescentAfterAt", (q) =>
        q
          .eq("ownerId", args.ownerId)
          .eq("state", state)
          .lte("quiescentAfterAt", args.now),
      )
      .take(budget);
    for (const row of expired) await deleteMediaProviderAttempt(ctx, row);
    reaped += expired.length;
    budget -= expired.length;
  }

  if (budget > 0) {
    const active = await ctx.db
      .query("media_provider_dispatch_leases")
      .withIndex("by_ownerId_and_state", (q) =>
        q.eq("ownerId", args.ownerId).eq("state", "active"),
      )
      .take(budget);
    for (const row of active) {
      await markMediaProviderCancellationDebt(ctx, row, {
        now: args.now,
        operationId: args.operationId,
        generation: args.generation,
        ambiguous: true,
      });
      if (row.jobId) {
        const job = await getJobByJobId(ctx, row.jobId);
        if (job) {
          await cancelMediaJobForOwnerFence(ctx, job, { now: args.now });
        }
      }
    }
    canceled += active.length;
    budget -= active.length;
  }

  for (const status of ["queued", "running"] as const) {
    if (budget <= 0) break;
    const jobs = await ctx.db
      .query("media_jobs")
      .withIndex("by_ownerId_and_status_and_completedAt", (q) =>
        q.eq("ownerId", args.ownerId).eq("status", status),
      )
      .take(budget);
    for (const job of jobs) {
      const ambiguousWithoutLocator =
        !job.providerRequestId &&
        (job.submissionState === "dispatching" ||
          job.submissionState === "unknown");
      const exactAttempt =
        ambiguousWithoutLocator && job.submissionAttemptId
          ? await readExactMediaJobAttempt(
              ctx,
              job.jobId,
              job.submissionAttemptId,
            )
          : null;
      await cancelMediaJobForOwnerFence(ctx, job, {
        now: args.now,
        preserveAmbiguousSubmissionState:
          ambiguousWithoutLocator && !exactAttempt,
      });
    }
    canceled += jobs.length;
    budget -= jobs.length;
  }

  // Legacy claimed/unknown Fal rows predate exact attempt leases. Preserve
  // their tombstone until the same 3h15m provider reconciliation envelope.
  if (budget > 0) {
    for (const submissionState of ["dispatching", "unknown"] as const) {
      if (budget <= 0) break;
      const legacy = await ctx.db
        .query("media_jobs")
        .withIndex("by_ownerId_and_submissionState_and_updatedAt", (q) =>
          q.eq("ownerId", args.ownerId).eq("submissionState", submissionState),
        )
        .take(budget);
      for (const job of legacy) {
        if (job.providerRequestId) {
          await ctx.db.patch(job._id, { submissionState: "canceled" });
          continue;
        }
        const exact = job.submissionAttemptId
          ? await readExactMediaJobAttempt(
              ctx,
              job.jobId,
              job.submissionAttemptId,
            )
          : null;
        const ambiguousUntil =
          (job.submissionClaimedAt ?? job.updatedAt) +
          AMBIGUOUS_FAL_PROVIDER_RECONCILIATION_MS;
        if (!exact && args.now >= ambiguousUntil) {
          await ctx.db.patch(job._id, {
            submissionState: "canceled",
            updatedAt: args.now,
          });
          reaped += 1;
        }
      }
      budget -= legacy.length;
    }
  }

  const preview = Math.min(limit, MEDIA_QUIESCE_PREVIEW);
  const [
    active,
    debt,
    queued,
    running,
    cancellations,
    pendingBilling,
    unknownBilling,
  ] = await Promise.all([
    ctx.db
      .query("media_provider_dispatch_leases")
      .withIndex("by_ownerId_and_state", (q) =>
        q.eq("ownerId", args.ownerId).eq("state", "active"),
      )
      .take(preview),
    ctx.db
      .query("media_provider_dispatch_leases")
      .withIndex("by_ownerId_and_state", (q) =>
        q.eq("ownerId", args.ownerId).eq("state", "cancel_requested"),
      )
      .take(preview),
    ctx.db
      .query("media_jobs")
      .withIndex("by_ownerId_and_status_and_completedAt", (q) =>
        q.eq("ownerId", args.ownerId).eq("status", "queued"),
      )
      .take(preview),
    ctx.db
      .query("media_jobs")
      .withIndex("by_ownerId_and_status_and_completedAt", (q) =>
        q.eq("ownerId", args.ownerId).eq("status", "running"),
      )
      .take(preview),
    ctx.db
      .query("media_provider_cancellations")
      .withIndex("by_ownerId", (q) => q.eq("ownerId", args.ownerId))
      .take(preview),
    ctx.db
      .query("media_jobs")
      .withIndex("by_ownerId_and_billingDispositionState_and_updatedAt", (q) =>
        q.eq("ownerId", args.ownerId).eq("billingDispositionState", "pending"),
      )
      .take(preview),
    ctx.db
      .query("media_jobs")
      .withIndex("by_ownerId_and_billingDispositionState_and_updatedAt", (q) =>
        q.eq("ownerId", args.ownerId).eq("billingDispositionState", "unknown"),
      )
      .take(preview),
  ]);

  const legacyPending: Array<{ label: string; retryAt: number }> = [];
  for (const submissionState of ["dispatching", "unknown"] as const) {
    if (legacyPending.length >= preview) break;
    const rows = await ctx.db
      .query("media_jobs")
      .withIndex("by_ownerId_and_submissionState_and_updatedAt", (q) =>
        q.eq("ownerId", args.ownerId).eq("submissionState", submissionState),
      )
      .take(preview - legacyPending.length);
    for (const job of rows) {
      if (job.providerRequestId) continue;
      const exact = job.submissionAttemptId
        ? await readExactMediaJobAttempt(
            ctx,
            job.jobId,
            job.submissionAttemptId,
          )
        : null;
      if (!exact) {
        legacyPending.push({
          label: `media_legacy_${submissionState}:${job.jobId}`,
          retryAt:
            (job.submissionClaimedAt ?? job.updatedAt) +
            AMBIGUOUS_FAL_PROVIDER_RECONCILIATION_MS,
        });
      }
    }
  }

  const pending = [
    ...active.map((row) => ({
      label: `media_provider_active:${row.kind}:${row.dispatchId}`,
      retryAt: row.quiescentAfterAt,
    })),
    ...debt.map((row) => ({
      label: `media_provider_debt:${row.kind}:${row.dispatchId}`,
      retryAt: row.quiescentAfterAt,
    })),
    ...queued.map((job) => ({
      label: `media_job_queued:${job.jobId}`,
      retryAt: args.now,
    })),
    ...running.map((job) => ({
      label: `media_job_running:${job.jobId}`,
      retryAt: args.now,
    })),
    ...cancellations.map((row) => ({
      label: `media_provider_cancel_debt:${row.jobId}`,
      retryAt: row.nextAttemptAt,
    })),
    ...pendingBilling.map((job) => ({
      label: `media_billing_pending:${job.jobId}`,
      retryAt: args.now + MEDIA_BILLING_RECONCILIATION_RETRY_MS,
    })),
    ...unknownBilling.map((job) => ({
      label: `media_billing_unknown:${job.jobId}`,
      retryAt: args.now + MEDIA_BILLING_RECONCILIATION_RETRY_MS,
    })),
    ...legacyPending,
  ].slice(0, MEDIA_QUIESCE_PREVIEW);

  return {
    ready: pending.length === 0,
    canceled,
    reaped,
    pending: pending.map((item) => item.label),
    retryAt:
      pending.length === 0
        ? null
        : Math.min(...pending.map((item) => item.retryAt)),
  };
};

/** Reset/delete pass guarded by the exact core owner-purge lease. */
export const cancelOwnerMediaProviderDispatchesInternal = internalMutation({
  args: {
    ownerId: v.string(),
    operationId: v.string(),
    generation: v.string(),
    leaseId: v.string(),
    mode: ownerPurgeModeValidator,
    now: v.number(),
    limit: v.optional(v.number()),
  },
  returns: mediaProviderQuiesceResultValidator,
  handler: async (ctx, args) => {
    await assertOwnerPurgeLease(ctx, {
      ownerId: args.ownerId,
      operationId: args.operationId,
      generation: args.generation,
      stage: "core",
      leaseId: args.leaseId,
      mode: args.mode,
    });
    return await quiesceOwnerMediaRows(ctx, args);
  },
});

/** Either owner in the exact migration must drain media authority first. */
export const cancelOwnerMediaProviderDispatchesForMigrationInternal =
  internalMutation({
    args: {
      migrationId: v.id("auth_owner_migrations"),
      ownerId: v.string(),
      now: v.number(),
      limit: v.optional(v.number()),
    },
    returns: mediaProviderQuiesceResultValidator,
    handler: async (ctx, args) => {
      const migration = await ctx.db.get(args.migrationId);
      if (
        !migration ||
        (migration.fromOwnerId !== args.ownerId &&
          migration.toOwnerId !== args.ownerId)
      ) {
        throw new ConvexError({
          code: "OWNERSHIP_MIGRATION_SUPERSEDED",
          message: "The owner is not part of this migration.",
        });
      }
      return await quiesceOwnerMediaRows(ctx, args);
    },
  });

/** Strict residue proof shared by reset, deletion, and migration. */
export const remainingOwnerMediaProviderDispatchesInternal = internalQuery({
  args: { ownerId: v.string() },
  returns: v.array(v.string()),
  handler: async (ctx, args) => {
    const [
      active,
      debt,
      queued,
      running,
      cancellations,
      pendingBilling,
      unknownBilling,
    ] = await Promise.all([
      ctx.db
        .query("media_provider_dispatch_leases")
        .withIndex("by_ownerId_and_state", (q) =>
          q.eq("ownerId", args.ownerId).eq("state", "active"),
        )
        .take(1),
      ctx.db
        .query("media_provider_dispatch_leases")
        .withIndex("by_ownerId_and_state", (q) =>
          q.eq("ownerId", args.ownerId).eq("state", "cancel_requested"),
        )
        .take(1),
      ctx.db
        .query("media_jobs")
        .withIndex("by_ownerId_and_status_and_completedAt", (q) =>
          q.eq("ownerId", args.ownerId).eq("status", "queued"),
        )
        .take(1),
      ctx.db
        .query("media_jobs")
        .withIndex("by_ownerId_and_status_and_completedAt", (q) =>
          q.eq("ownerId", args.ownerId).eq("status", "running"),
        )
        .take(1),
      ctx.db
        .query("media_provider_cancellations")
        .withIndex("by_ownerId", (q) => q.eq("ownerId", args.ownerId))
        .take(1),
      ctx.db
        .query("media_jobs")
        .withIndex(
          "by_ownerId_and_billingDispositionState_and_updatedAt",
          (q) =>
            q
              .eq("ownerId", args.ownerId)
              .eq("billingDispositionState", "pending"),
        )
        .take(1),
      ctx.db
        .query("media_jobs")
        .withIndex(
          "by_ownerId_and_billingDispositionState_and_updatedAt",
          (q) =>
            q
              .eq("ownerId", args.ownerId)
              .eq("billingDispositionState", "unknown"),
        )
        .take(1),
    ]);
    let legacyAmbiguous = false;
    for (const state of ["dispatching", "unknown"] as const) {
      const rows = await ctx.db
        .query("media_jobs")
        .withIndex("by_ownerId_and_submissionState_and_updatedAt", (q) =>
          q.eq("ownerId", args.ownerId).eq("submissionState", state),
        )
        .take(MEDIA_QUIESCE_PREVIEW);
      for (const job of rows) {
        if (job.providerRequestId) continue;
        const exact = job.submissionAttemptId
          ? await readExactMediaJobAttempt(
              ctx,
              job.jobId,
              job.submissionAttemptId,
            )
          : null;
        if (!exact) {
          legacyAmbiguous = true;
          break;
        }
      }
      if (legacyAmbiguous) break;
    }
    return [
      ...(active.length ? ["media_provider_dispatch_active"] : []),
      ...(debt.length ? ["media_provider_dispatch_debt"] : []),
      ...(queued.length || running.length ? ["media_job_active"] : []),
      ...(cancellations.length ? ["media_provider_cancel_debt"] : []),
      ...(pendingBilling.length || unknownBilling.length
        ? ["media_billing_disposition_debt"]
        : []),
      ...(legacyAmbiguous ? ["media_legacy_ambiguous_provider"] : []),
    ];
  },
});

/** Atomic authority check for a delayed connector-media delivery attempt. */
export const assertConnectorMediaDispatchAllowed = internalMutation({
  args: {
    ownerId: v.string(),
    ownerGeneration: v.string(),
    jobId: v.string(),
    requestId: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const job = await getJobByJobId(ctx, args.jobId);
    if (
      !job ||
      job.ownerId !== args.ownerId ||
      mediaOwnerGeneration(job) !== args.ownerGeneration
    ) {
      throw staleMediaGenerationError();
    }
    await assertMediaJobWriteAllowed(ctx, job, args.ownerGeneration);
    if (
      job.status !== "succeeded" ||
      job.connectorRequestId !== args.requestId ||
      !job.connectorMediaDeliveryScheduledAt ||
      job.connectorMediaDeliveredAt !== undefined ||
      job.connectorMediaDeliveryAbandonedAt !== undefined ||
      job.output === undefined
    ) {
      throw new ConvexError({
        code: "MEDIA_CONNECTOR_DELIVERY_NOT_ALLOWED",
        message: "This media connector delivery is no longer active.",
      });
    }
    return null;
  },
});

export const createJob = internalMutation({
  args: {
    ownerId: v.string(),
    ownerGeneration: v.string(),
    jobId: v.string(),
    capability: v.string(),
    profile: v.string(),
    provider: v.union(
      v.literal("fal"),
      v.literal("google_lyria"),
      v.literal("openrouter"),
    ),
    endpointId: v.string(),
    request: mediaRequestSummaryValidator,
    connectorRequestId: v.optional(v.string()),
    billing: v.optional(mediaJobBillingValidator),
    notChargeablePolicy: v.optional(
      v.literal(MEDIA_BILLING_POLICY_USER_PROVIDED_KEY),
    ),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    await assertOwnerMigrationWriteAllowed(
      ctx,
      args.ownerId,
      args.ownerGeneration,
    );
    const existing = await getJobByJobId(ctx, args.jobId);
    if (existing) {
      throw new ConvexError({
        code: "CONFLICT",
        message: "Media job already exists.",
      });
    }

    const now = Date.now();
    await ctx.db.insert("media_jobs", {
      ownerId: args.ownerId,
      ownerGeneration: args.ownerGeneration,
      jobId: args.jobId,
      capability: args.capability,
      profile: args.profile,
      provider: args.provider,
      endpointId: args.endpointId,
      request: args.request,
      ...(args.connectorRequestId
        ? { connectorRequestId: args.connectorRequestId }
        : {}),
      ...(args.billing ? { billing: args.billing } : {}),
      billingDispositionState: "not_chargeable",
      billingDispositionPolicy:
        args.notChargeablePolicy ?? MEDIA_BILLING_POLICY_NO_PROVIDER_DISPATCH,
      billingDispositionUpdatedAt: now,
      status: "queued",
      upstreamStatus: "IN_QUEUE",
      queuePosition: null,
      createdAt: now,
      updatedAt: now,
    });
    return null;
  },
});

/**
 * Durably records the BYO-key exemption before the first exact provider
 * attempt. The transition is rejected once any provider authority or locator
 * exists, so paid work can never be relabeled after dispatch.
 */
export const markJobUserProvidedKeyNotChargeableInternal = internalMutation({
  args: {
    jobId: v.string(),
    ownerGeneration: v.string(),
    markedAt: v.number(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const job = await getJobByJobId(ctx, args.jobId);
    if (!job) {
      throw new ConvexError({
        code: "NOT_FOUND",
        message: "Media job not found.",
      });
    }
    await assertMediaJobWriteAllowed(ctx, job, args.ownerGeneration);
    const existingAttempt = await ctx.db
      .query("media_provider_dispatch_leases")
      .withIndex("by_jobId_and_attemptId", (q) => q.eq("jobId", job.jobId))
      .first();
    if (
      existingAttempt ||
      job.providerRequestId ||
      job.billingDispositionState !== "not_chargeable" ||
      (job.billingDispositionPolicy !==
        MEDIA_BILLING_POLICY_NO_PROVIDER_DISPATCH &&
        job.billingDispositionPolicy !== MEDIA_BILLING_POLICY_USER_PROVIDED_KEY)
    ) {
      throw new ConvexError({
        code: "MEDIA_BILLING_POLICY_ALREADY_DISPATCHED",
        message:
          "The media billing policy cannot change after provider admission.",
      });
    }
    await ctx.db.patch(job._id, {
      billingDispositionPolicy: MEDIA_BILLING_POLICY_USER_PROVIDED_KEY,
      billingDispositionReason: undefined,
      billingDispositionUpdatedAt: args.markedAt,
    });
    return null;
  },
});

const reserveIdempotentJobResultValidator = v.union(
  v.object({
    state: v.literal("created"),
    jobId: v.string(),
    status: v.literal("queued"),
    upstreamStatus: v.string(),
  }),
  v.object({
    state: v.literal("existing"),
    jobId: v.string(),
    capability: v.string(),
    profile: v.string(),
    status: v.union(
      v.literal("queued"),
      v.literal("running"),
      v.literal("succeeded"),
      v.literal("failed"),
      v.literal("canceled"),
      v.literal("unknown"),
    ),
    upstreamStatus: v.string(),
  }),
  v.object({
    state: v.literal("conflict"),
    jobId: v.string(),
  }),
  v.object({ state: v.literal("canceled") }),
  v.object({ state: v.literal("owner_purged") }),
);

/**
 * Atomically reserve an owner-scoped media request identity. Retried POSTs
 * attach to the existing row and never repeat provider submission. A
 * cancellation tombstone wins even when DELETE arrives before this mutation.
 */
export const reserveIdempotentJob = internalMutation({
  args: {
    ownerId: v.string(),
    ownerGeneration: v.string(),
    jobId: v.string(),
    clientRequestKey: v.string(),
    clientRequestHash: v.string(),
    capability: v.string(),
    profile: v.string(),
    provider: v.union(
      v.literal("fal"),
      v.literal("google_lyria"),
      v.literal("openrouter"),
    ),
    endpointId: v.string(),
    request: mediaRequestSummaryValidator,
    connectorRequestId: v.optional(v.string()),
    billing: v.optional(mediaJobBillingValidator),
    submissionPayloadStorageId: v.optional(v.id("_storage")),
    submissionPayloadManifestId: v.optional(v.string()),
    encryptedSubmissionPayload: v.optional(v.string()),
  },
  returns: reserveIdempotentJobResultValidator,
  handler: async (ctx, args) => {
    await assertOwnerMigrationWriteAllowed(
      ctx,
      args.ownerId,
      args.ownerGeneration,
    );
    if (args.submissionPayloadStorageId && args.submissionPayloadManifestId) {
      throw new Error(
        "Media reservation accepts only one durable payload source.",
      );
    }
    const releaseIncomingPayload = async (preserve?: {
      storageId?: Id<"_storage">;
      manifestId?: string;
    }) => {
      if (
        args.submissionPayloadStorageId &&
        args.submissionPayloadStorageId !== preserve?.storageId
      ) {
        await markPrivateBlobPending(ctx, {
          ownerId: args.ownerId,
          storageId: args.submissionPayloadStorageId,
          now: Date.now(),
        });
        await ctx.scheduler.runAfter(
          0,
          internal.media_image_submission.deleteSubmissionPayload,
          { storageId: args.submissionPayloadStorageId },
        );
      }
      if (
        args.submissionPayloadManifestId &&
        args.submissionPayloadManifestId !== preserve?.manifestId
      ) {
        await markPrivatePayloadManifestPending(ctx, {
          manifestId: args.submissionPayloadManifestId,
          now: Date.now(),
        });
        await ctx.scheduler.runAfter(
          0,
          internal.media_image_submission.deletePrivatePayloadManifest,
          { manifestId: args.submissionPayloadManifestId },
        );
      }
    };
    if (await ownerMediaPurgeActive(ctx, args.ownerId)) {
      await releaseIncomingPayload();
      return { state: "owner_purged" as const };
    }
    const canceled = await ctx.db
      .query("media_request_cancellations")
      .withIndex("by_ownerId_and_clientRequestKey", (q) =>
        q
          .eq("ownerId", args.ownerId)
          .eq("clientRequestKey", args.clientRequestKey),
      )
      .unique();
    if (canceled) {
      await releaseIncomingPayload();
      return { state: "canceled" as const };
    }

    const existing = await getJobByClientRequestKey(
      ctx,
      args.ownerId,
      args.clientRequestKey,
    );
    if (existing) {
      if (mediaOwnerGeneration(existing) !== args.ownerGeneration) {
        throw staleMediaGenerationError();
      }
      if (existing.clientRequestHash !== args.clientRequestHash) {
        await releaseIncomingPayload();
        return { state: "conflict" as const, jobId: existing.jobId };
      }
      await releaseIncomingPayload({
        ...(existing.submissionPayloadStorageId
          ? { storageId: existing.submissionPayloadStorageId }
          : {}),
        ...(existing.submissionPayloadManifestId
          ? { manifestId: existing.submissionPayloadManifestId }
          : {}),
      });
      return {
        state: "existing" as const,
        jobId: existing.jobId,
        capability: existing.capability,
        profile: existing.profile,
        status: existing.status,
        upstreamStatus: existing.upstreamStatus,
      };
    }

    if (await getJobByJobId(ctx, args.jobId)) {
      throw new ConvexError({
        code: "CONFLICT",
        message: "Media job already exists.",
      });
    }

    if (args.submissionPayloadManifestId) {
      const manifest = await ctx.db
        .query("media_private_payload_manifests")
        .withIndex("by_manifestId", (q) =>
          q.eq("manifestId", args.submissionPayloadManifestId!),
        )
        .unique();
      if (
        !manifest ||
        manifest.ownerId !== args.ownerId ||
        mediaOwnerGeneration(manifest) !== args.ownerGeneration ||
        manifest.jobId !== args.jobId ||
        manifest.clientRequestKey !== args.clientRequestKey ||
        manifest.state !== "held" ||
        manifest.writtenChunks !== manifest.expectedChunks ||
        manifest.writtenChars !== manifest.totalChars
      ) {
        throw new Error("Encrypted media payload manifest is not complete.");
      }
    }

    const now = Date.now();
    await ctx.db.insert("media_jobs", {
      ownerId: args.ownerId,
      ownerGeneration: args.ownerGeneration,
      jobId: args.jobId,
      clientRequestKey: args.clientRequestKey,
      clientRequestHash: args.clientRequestHash,
      capability: args.capability,
      profile: args.profile,
      provider: args.provider,
      endpointId: args.endpointId,
      request: args.request,
      ...(args.connectorRequestId
        ? { connectorRequestId: args.connectorRequestId }
        : {}),
      ...(args.billing ? { billing: args.billing } : {}),
      billingDispositionState: "not_chargeable",
      billingDispositionPolicy: MEDIA_BILLING_POLICY_NO_PROVIDER_DISPATCH,
      billingDispositionUpdatedAt: now,
      ...(args.submissionPayloadStorageId
        ? {
            submissionState: "pending" as const,
            submissionPayloadStorageId: args.submissionPayloadStorageId,
          }
        : {}),
      ...(args.submissionPayloadManifestId
        ? {
            submissionState: "pending" as const,
            submissionPayloadManifestId: args.submissionPayloadManifestId,
          }
        : {}),
      status: "queued",
      upstreamStatus: "IN_QUEUE",
      queuePosition: null,
      createdAt: now,
      updatedAt: now,
    });
    if (args.submissionPayloadStorageId) {
      const cleanup = await ctx.db
        .query("media_private_blob_cleanup")
        .withIndex("by_storageId", (q) =>
          q.eq("storageId", args.submissionPayloadStorageId!),
        )
        .unique();
      if (cleanup && cleanup.ownerId !== args.ownerId) {
        throw new Error("Encrypted media payload belongs to another owner.");
      }
      if (cleanup) {
        await ctx.db.patch(cleanup._id, {
          jobId: args.jobId,
          state: "held",
          updatedAt: now,
        });
      } else {
        // Backward-compatible callers/tests that already hold a storage id
        // still gain the outbox transactionally with reservation. The HTTP
        // path registers before this mutation to close store->reserve errors.
        await ctx.db.insert("media_private_blob_cleanup", {
          ownerId: args.ownerId,
          storageId: args.submissionPayloadStorageId,
          jobId: args.jobId,
          state: "held",
          attempts: 0,
          nextAttemptAt: now,
          createdAt: now,
          updatedAt: now,
        });
      }
      await ctx.scheduler.runAfter(
        0,
        internal.media_image_submission.submitReservedImageJob,
        {
          jobId: args.jobId,
          ownerGeneration: args.ownerGeneration,
          ...(args.encryptedSubmissionPayload
            ? { encryptedPayload: args.encryptedSubmissionPayload }
            : {}),
        },
      );
    }
    if (args.submissionPayloadManifestId) {
      const manifest = await ctx.db
        .query("media_private_payload_manifests")
        .withIndex("by_manifestId", (q) =>
          q.eq("manifestId", args.submissionPayloadManifestId!),
        )
        .unique();
      if (!manifest)
        throw new Error("Encrypted media payload manifest vanished.");
      await ctx.db.patch(manifest._id, {
        state: "held",
        updatedAt: now,
        nextAttemptAt: now + UNATTACHED_PRIVATE_PAYLOAD_RETENTION_MS,
      });
      await ctx.scheduler.runAfter(
        0,
        internal.media_image_submission.submitReservedImageJob,
        { jobId: args.jobId, ownerGeneration: args.ownerGeneration },
      );
    }
    return {
      state: "created" as const,
      jobId: args.jobId,
      status: "queued" as const,
      upstreamStatus: "IN_QUEUE",
    };
  },
});

export const beginSubmission = internalMutation({
  args: {
    ownerId: v.string(),
    ownerGeneration: v.string(),
    jobId: v.string(),
  },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const job = await getJobByJobId(ctx, args.jobId);
    if (!job || job.ownerId !== args.ownerId || job.status === "canceled") {
      return false;
    }
    await assertMediaJobWriteAllowed(ctx, job, args.ownerGeneration);
    return !job.providerRequestId;
  },
});

const submissionClaimResultValidator = v.union(
  v.object({
    state: v.literal("claimed"),
    ownerId: v.string(),
    ownerGeneration: v.string(),
    storageId: v.optional(v.id("_storage")),
    manifestId: v.optional(v.string()),
    endpointId: v.string(),
  }),
  v.object({ state: v.literal("skip") }),
);

/**
 * The only durable Stella-controlled gate before a Fal POST. Convex
 * serializes concurrent claims; only the transaction that moves pending to
 * dispatching may touch the provider. We intentionally do not reclaim a
 * dispatching row because Fal has no supported client idempotency key.
 */
export const claimImageSubmission = internalMutation({
  args: {
    jobId: v.string(),
    ownerGeneration: v.string(),
    attemptId: v.string(),
    claimedAt: v.number(),
  },
  returns: submissionClaimResultValidator,
  handler: async (ctx, args) => {
    const job = await getJobByJobId(ctx, args.jobId);
    if (
      !job ||
      job.submissionState !== "pending" ||
      (!job.submissionPayloadStorageId && !job.submissionPayloadManifestId) ||
      isTerminalMediaJobStatus(job.status)
    ) {
      return { state: "skip" as const };
    }
    await assertMediaJobWriteAllowed(ctx, job, args.ownerGeneration);
    if (await ownerMediaPurgeActive(ctx, job.ownerId)) {
      await ctx.db.patch(job._id, {
        status: "canceled",
        submissionState: "canceled",
        upstreamStatus: "OWNER_PURGED",
        queuePosition: null,
        error: {
          code: "OWNER_PURGED",
          message: "Media submission canceled during account deletion.",
        },
        updatedAt: args.claimedAt,
        completedAt: args.claimedAt,
      });
      if (job.submissionPayloadStorageId) {
        await markPrivateBlobPending(ctx, {
          ownerId: job.ownerId,
          storageId: job.submissionPayloadStorageId,
          jobId: job.jobId,
          now: args.claimedAt,
        });
      }
      if (job.submissionPayloadManifestId) {
        await markPrivatePayloadManifestPending(ctx, {
          manifestId: job.submissionPayloadManifestId,
          now: args.claimedAt,
        });
      }
      return { state: "skip" as const };
    }
    const dispatch = await reserveMediaProviderAttempt(ctx, {
      ownerId: job.ownerId,
      ownerGeneration: args.ownerGeneration,
      jobId: job.jobId,
      dispatchId: falSubmissionDispatchId(job.jobId),
      attemptId: args.attemptId,
      kind: "fal_submit",
      now: args.claimedAt,
    });
    if (!dispatch.acquired) return { state: "skip" as const };
    await ctx.db.patch(job._id, {
      submissionState: "dispatching",
      submissionAttemptId: args.attemptId,
      submissionClaimedAt: args.claimedAt,
      updatedAt: args.claimedAt,
    });
    return {
      state: "claimed" as const,
      ownerId: job.ownerId,
      ownerGeneration: args.ownerGeneration,
      ...(job.submissionPayloadStorageId
        ? { storageId: job.submissionPayloadStorageId }
        : {}),
      ...(job.submissionPayloadManifestId
        ? { manifestId: job.submissionPayloadManifestId }
        : {}),
      endpointId: job.endpointId,
    };
  },
});

export const markImageSubmissionUnknown = internalMutation({
  args: {
    jobId: v.string(),
    ownerGeneration: v.string(),
    attemptId: v.string(),
    error: mediaJobErrorValidator,
    observedAt: v.number(),
  },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const job = await getJobByJobId(ctx, args.jobId);
    if (
      !job ||
      job.submissionState !== "dispatching" ||
      job.submissionAttemptId !== args.attemptId ||
      isTerminalMediaJobStatus(job.status)
    ) {
      return false;
    }
    await assertMediaJobWriteAllowed(ctx, job, args.ownerGeneration);
    await ctx.db.patch(job._id, {
      submissionState: "unknown",
      upstreamStatus: "SUBMISSION_OUTCOME_UNKNOWN",
      error: args.error,
      updatedAt: args.observedAt,
    });
    return true;
  },
});

/** Reschedule only rows that provably never crossed the provider boundary. */
export const reconcilePendingImageSubmissions = internalMutation({
  args: {
    pendingBefore: v.optional(v.number()),
    dispatchBefore: v.optional(v.number()),
    unknownBefore: v.optional(v.number()),
    pendingStaleMs: v.optional(v.number()),
    dispatchStaleMs: v.optional(v.number()),
    unknownStaleMs: v.optional(v.number()),
    pendingRetentionMs: v.optional(v.number()),
    limit: v.optional(v.number()),
  },
  returns: v.object({
    rescheduled: v.number(),
    terminalUnknown: v.number(),
    abandoned: v.number(),
  }),
  handler: async (ctx, args) => {
    const limit = Math.max(1, Math.min(args.limit ?? 100, 500));
    const startedAt = Date.now();
    const pendingBefore =
      args.pendingBefore ?? startedAt - (args.pendingStaleMs ?? 2 * 60_000);
    const dispatchBefore =
      args.dispatchBefore ?? startedAt - (args.dispatchStaleMs ?? 2 * 60_000);
    const unknownBefore =
      args.unknownBefore ??
      startedAt - (args.unknownStaleMs ?? 3 * 60 * 60_000 + 15 * 60_000);
    const pending = await ctx.db
      .query("media_jobs")
      .withIndex("by_submissionState_and_updatedAt", (q) =>
        q.eq("submissionState", "pending").lt("updatedAt", pendingBefore),
      )
      .take(limit);
    let rescheduled = 0;
    let abandoned = 0;
    for (const job of pending) {
      if (isTerminalMediaJobStatus(job.status)) continue;
      if (!(await mediaJobWriteAllowedForWatchdog(ctx, job))) continue;
      if (
        startedAt - job.createdAt >
        (args.pendingRetentionMs ?? 24 * 60 * 60_000)
      ) {
        await ctx.db.patch(job._id, {
          status: "failed",
          submissionState: "failed",
          submissionPayloadStorageId: undefined,
          submissionPayloadManifestId: undefined,
          upstreamStatus: "SUBMISSION_ABANDONED",
          queuePosition: null,
          error: {
            code: "SUBMISSION_ABANDONED",
            message:
              "The durable image submission could not be dispatched within the retention window.",
          },
          updatedAt: startedAt,
          completedAt: startedAt,
        });
        if (job.submissionPayloadStorageId) {
          await ctx.scheduler.runAfter(
            0,
            internal.media_image_submission.deleteSubmissionPayload,
            { storageId: job.submissionPayloadStorageId },
          );
        }
        if (job.submissionPayloadManifestId) {
          await markPrivatePayloadManifestPending(ctx, {
            manifestId: job.submissionPayloadManifestId,
            now: startedAt,
          });
          await ctx.scheduler.runAfter(
            0,
            internal.media_image_submission.deletePrivatePayloadManifest,
            { manifestId: job.submissionPayloadManifestId },
          );
        }
        abandoned += 1;
        continue;
      }
      await ctx.scheduler.runAfter(
        0,
        internal.media_image_submission.submitReservedImageJob,
        {
          jobId: job.jobId,
          ownerGeneration: mediaOwnerGeneration(job),
        },
      );
      await ctx.db.patch(job._id, { updatedAt: Date.now() });
      rescheduled += 1;
    }

    let remaining = Math.max(0, limit - rescheduled);
    const abandonedClaims =
      remaining > 0
        ? await ctx.db
            .query("media_jobs")
            .withIndex("by_submissionState_and_updatedAt", (q) =>
              q
                .eq("submissionState", "dispatching")
                .lt("updatedAt", dispatchBefore),
            )
            .take(remaining)
        : [];
    const now = Date.now();
    for (const job of abandonedClaims) {
      if (isTerminalMediaJobStatus(job.status)) continue;
      if (!(await mediaJobWriteAllowedForWatchdog(ctx, job))) continue;
      await ctx.db.patch(job._id, {
        submissionState: "unknown",
        submissionPayloadStorageId: undefined,
        submissionPayloadManifestId: undefined,
        upstreamStatus: "SUBMISSION_OUTCOME_UNKNOWN",
        error: {
          code: "SUBMISSION_OUTCOME_UNKNOWN",
          message:
            "Stella lost the provider submission outcome and will not retry an ambiguous Fal POST.",
        },
        updatedAt: now,
      });
      if (job.submissionPayloadStorageId) {
        await ctx.scheduler.runAfter(
          0,
          internal.media_image_submission.deleteSubmissionPayload,
          { storageId: job.submissionPayloadStorageId },
        );
      }
      if (job.submissionPayloadManifestId) {
        await markPrivatePayloadManifestPending(ctx, {
          manifestId: job.submissionPayloadManifestId,
          now,
        });
        await ctx.scheduler.runAfter(
          0,
          internal.media_image_submission.deletePrivatePayloadManifest,
          { manifestId: job.submissionPayloadManifestId },
        );
      }
      remaining -= 1;
    }

    const ambiguous =
      remaining > 0
        ? await ctx.db
            .query("media_jobs")
            .withIndex("by_submissionState_and_updatedAt", (q) =>
              q.eq("submissionState", "unknown").lt("updatedAt", unknownBefore),
            )
            .take(remaining)
        : [];
    let terminalUnknown = 0;
    for (const job of ambiguous) {
      if (isTerminalMediaJobStatus(job.status)) continue;
      if (!(await mediaJobWriteAllowedForWatchdog(ctx, job))) continue;
      await ctx.db.patch(job._id, {
        status: "unknown",
        submissionState: "unknown",
        upstreamStatus: "SUBMISSION_OUTCOME_UNKNOWN",
        queuePosition: null,
        error: {
          code: "SUBMISSION_OUTCOME_UNKNOWN",
          message:
            "Fal may have accepted this image, but Stella could not reconcile the submission response.",
        },
        updatedAt: now,
        completedAt: now,
      });
      terminalUnknown += 1;
    }
    return { rescheduled, terminalUnknown, abandoned };
  },
});

const cancelIdempotentRequestResultValidator = v.object({
  state: v.union(
    v.literal("canceled"),
    v.literal("succeeded"),
    v.literal("failed"),
    v.literal("unknown"),
  ),
  jobId: v.optional(v.string()),
  endpointId: v.optional(v.string()),
  providerRequestId: v.optional(v.string()),
  submissionPayloadStorageId: v.optional(v.id("_storage")),
  submissionPayloadManifestId: v.optional(v.string()),
});

/** Persist cancellation before attempting provider cancellation. */
export const cancelIdempotentRequest = internalMutation({
  args: {
    ownerId: v.string(),
    ownerGeneration: v.string(),
    clientRequestKey: v.string(),
    canceledAt: v.number(),
  },
  returns: cancelIdempotentRequestResultValidator,
  handler: async (ctx, args) => {
    await assertOwnerMigrationWriteAllowed(
      ctx,
      args.ownerId,
      args.ownerGeneration,
    );
    const existingTombstone = await ctx.db
      .query("media_request_cancellations")
      .withIndex("by_ownerId_and_clientRequestKey", (q) =>
        q
          .eq("ownerId", args.ownerId)
          .eq("clientRequestKey", args.clientRequestKey),
      )
      .unique();
    if (
      existingTombstone &&
      mediaOwnerGeneration(existingTombstone) !== args.ownerGeneration
    ) {
      throw staleMediaGenerationError();
    }
    if (!existingTombstone) {
      await ctx.db.insert("media_request_cancellations", {
        ownerId: args.ownerId,
        ownerGeneration: args.ownerGeneration,
        clientRequestKey: args.clientRequestKey,
        createdAt: args.canceledAt,
      });
    }

    const job = await getJobByClientRequestKey(
      ctx,
      args.ownerId,
      args.clientRequestKey,
    );
    if (!job) return { state: "canceled" as const };
    await assertMediaJobWriteAllowed(ctx, job, args.ownerGeneration);
    if (
      job.status === "succeeded" ||
      job.status === "failed" ||
      job.status === "unknown"
    ) {
      return {
        state: job.status,
        jobId: job.jobId,
        endpointId: job.endpointId,
        ...(job.providerRequestId
          ? { providerRequestId: job.providerRequestId }
          : {}),
      };
    }
    if (job.status !== "canceled") {
      await ctx.db.patch(job._id, {
        status: "canceled",
        ...(job.submissionState
          ? { submissionState: "canceled" as const }
          : {}),
        ...(job.submissionPayloadStorageId
          ? { submissionPayloadStorageId: undefined }
          : {}),
        ...(job.submissionPayloadManifestId
          ? { submissionPayloadManifestId: undefined }
          : {}),
        upstreamStatus: "CANCELED",
        queuePosition: null,
        error: { message: "Image generation was canceled.", code: "CANCELED" },
        updatedAt: args.canceledAt,
        completedAt: args.canceledAt,
      });
    }
    if (job.submissionPayloadManifestId) {
      await markPrivatePayloadManifestPending(ctx, {
        manifestId: job.submissionPayloadManifestId,
        now: args.canceledAt,
      });
      await ctx.scheduler.runAfter(
        0,
        internal.media_image_submission.deletePrivatePayloadManifest,
        { manifestId: job.submissionPayloadManifestId },
      );
    }
    if (job.provider === "fal" && job.providerRequestId) {
      await enqueueProviderCancellation(ctx, {
        ownerId: job.ownerId,
        ownerGeneration: args.ownerGeneration,
        jobId: job.jobId,
        endpointId: job.endpointId,
        providerRequestId: job.providerRequestId,
        now: args.canceledAt,
      });
      await ctx.scheduler.runAfter(
        0,
        internal.media_image_submission.cancelPurgedProviderRequest,
        { jobId: job.jobId },
      );
    }
    return {
      state: "canceled" as const,
      jobId: job.jobId,
      endpointId: job.endpointId,
      ...(job.providerRequestId
        ? { providerRequestId: job.providerRequestId }
        : {}),
      ...(job.submissionPayloadStorageId
        ? { submissionPayloadStorageId: job.submissionPayloadStorageId }
        : {}),
      ...(job.submissionPayloadManifestId
        ? { submissionPayloadManifestId: job.submissionPayloadManifestId }
        : {}),
    };
  },
});

export const releaseImageSubmissionPayload = internalMutation({
  args: {
    jobId: v.string(),
    ownerGeneration: v.string(),
    storageId: v.id("_storage"),
  },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const job = await getJobByJobId(ctx, args.jobId);
    if (!job || job.submissionPayloadStorageId !== args.storageId) return false;
    if (mediaOwnerGeneration(job) !== args.ownerGeneration) {
      throw staleMediaGenerationError();
    }
    if (!(job.status === "canceled" && job.error?.code === "OWNER_PURGED")) {
      await assertMediaJobWriteAllowed(ctx, job, args.ownerGeneration);
    }
    if (job.submissionState === "pending") return false;
    await markPrivateBlobPending(ctx, {
      ownerId: job.ownerId,
      storageId: args.storageId,
      jobId: job.jobId,
      now: Date.now(),
    });
    await ctx.db.patch(job._id, { submissionPayloadStorageId: undefined });
    await ctx.scheduler.runAfter(
      0,
      internal.media_image_submission.deleteSubmissionPayload,
      { storageId: args.storageId },
    );
    return true;
  },
});

export const releaseImageSubmissionManifest = internalMutation({
  args: {
    jobId: v.string(),
    ownerGeneration: v.string(),
    manifestId: v.string(),
  },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const job = await getJobByJobId(ctx, args.jobId);
    if (!job || job.submissionPayloadManifestId !== args.manifestId)
      return false;
    if (mediaOwnerGeneration(job) !== args.ownerGeneration) {
      throw staleMediaGenerationError();
    }
    if (!(job.status === "canceled" && job.error?.code === "OWNER_PURGED")) {
      await assertMediaJobWriteAllowed(ctx, job, args.ownerGeneration);
    }
    if (job.submissionState === "pending") return false;
    await markPrivatePayloadManifestPending(ctx, {
      manifestId: args.manifestId,
      now: Date.now(),
    });
    await ctx.db.patch(job._id, { submissionPayloadManifestId: undefined });
    await ctx.scheduler.runAfter(
      0,
      internal.media_image_submission.deletePrivatePayloadManifest,
      { manifestId: args.manifestId },
    );
    return true;
  },
});

export const markSubmitted = internalMutation({
  args: {
    jobId: v.string(),
    ownerGeneration: v.string(),
    submissionAttemptId: v.optional(v.string()),
    providerRequestId: v.string(),
    providerGatewayRequestId: v.optional(v.string()),
    providerResponseUrl: v.optional(v.string()),
    providerStatusUrl: v.optional(v.string()),
    upstreamStatus: v.string(),
    queuePosition: v.optional(v.number()),
  },
  returns: v.object({ cancelRequested: v.boolean(), applied: v.boolean() }),
  handler: async (ctx, args) => {
    const job = await getJobByJobId(ctx, args.jobId);
    if (!job) {
      throw new ConvexError({
        code: "NOT_FOUND",
        message: "Media job not found.",
      });
    }
    if (mediaOwnerGeneration(job) !== args.ownerGeneration) {
      throw staleMediaGenerationError();
    }

    if (
      args.submissionAttemptId &&
      ((job.submissionState !== "dispatching" &&
        job.submissionState !== "canceled") ||
        job.submissionAttemptId !== args.submissionAttemptId)
    ) {
      return { cancelRequested: job.status === "canceled", applied: false };
    }
    if (isTerminalMediaJobStatus(job.status)) {
      if (
        job.status === "canceled" &&
        (job.submissionState === "dispatching" ||
          job.submissionState === "canceled") &&
        (!args.submissionAttemptId ||
          job.submissionAttemptId === args.submissionAttemptId)
      ) {
        // Account deletion can win immediately after the durable dispatch
        // claim. Retain the accepted provider identity without reversing the
        // canceled terminal state so the action can issue Fal cancellation.
        const now = Date.now();
        const billingResolution = await resolveAcceptedRequestBilling(ctx, {
          job,
          ownerGeneration: args.ownerGeneration,
          providerRequestId: args.providerRequestId,
        });
        await ctx.db.patch(job._id, {
          providerRequestId: args.providerRequestId,
          ...(args.providerGatewayRequestId
            ? { providerGatewayRequestId: args.providerGatewayRequestId }
            : {}),
          ...(args.providerResponseUrl
            ? { providerResponseUrl: args.providerResponseUrl }
            : {}),
          ...(args.providerStatusUrl
            ? { providerStatusUrl: args.providerStatusUrl }
            : {}),
          submissionState: "canceled",
          ...mediaBillingResolutionPatch(billingResolution, now),
          updatedAt: now,
        });
        await enqueueProviderCancellation(ctx, {
          ownerId: job.ownerId,
          ownerGeneration: args.ownerGeneration,
          jobId: job.jobId,
          endpointId: job.endpointId,
          providerRequestId: args.providerRequestId,
          now,
        });
        await ctx.scheduler.runAfter(
          0,
          internal.media_image_submission.cancelPurgedProviderRequest,
          { jobId: job.jobId },
        );
        await settleMediaProviderAttemptForJob(
          ctx,
          job.jobId,
          args.submissionAttemptId,
        );
        return { cancelRequested: true, applied: true };
      }
      return { cancelRequested: job.status === "canceled", applied: false };
    }

    try {
      await assertOwnerMigrationWriteAllowed(
        ctx,
        job.ownerId,
        args.ownerGeneration,
      );
    } catch (error) {
      if (!isOwnerFenceError(error)) throw error;
      const now = Date.now();
      await cancelMediaJobForOwnerFence(ctx, job, { now });
      const billingResolution = await resolveAcceptedRequestBilling(ctx, {
        job,
        ownerGeneration: args.ownerGeneration,
        providerRequestId: args.providerRequestId,
      });
      await ctx.db.patch(job._id, {
        providerRequestId: args.providerRequestId,
        ...(args.providerGatewayRequestId
          ? { providerGatewayRequestId: args.providerGatewayRequestId }
          : {}),
        ...(args.providerResponseUrl
          ? { providerResponseUrl: args.providerResponseUrl }
          : {}),
        ...(args.providerStatusUrl
          ? { providerStatusUrl: args.providerStatusUrl }
          : {}),
        ...(job.submissionState
          ? { submissionState: "canceled" as const }
          : {}),
        ...mediaBillingResolutionPatch(billingResolution, now),
        updatedAt: now,
      });
      await enqueueProviderCancellation(ctx, {
        ownerId: job.ownerId,
        ownerGeneration: args.ownerGeneration,
        jobId: job.jobId,
        endpointId: job.endpointId,
        providerRequestId: args.providerRequestId,
        now,
      });
      await ctx.scheduler.runAfter(
        0,
        internal.media_image_submission.cancelPurgedProviderRequest,
        { jobId: job.jobId },
      );
      await settleMediaProviderAttemptForJob(
        ctx,
        job.jobId,
        args.submissionAttemptId,
      );
      return { cancelRequested: true, applied: true };
    }

    const now = Date.now();
    const cancelRequested = job.status === "canceled";
    const billingResolution = await resolveAcceptedRequestBilling(ctx, {
      job,
      ownerGeneration: args.ownerGeneration,
      providerRequestId: args.providerRequestId,
    });
    const providerStatus = cancelRequested
      ? "canceled"
      : toInitialMediaJobStatus(args.upstreamStatus);
    const billingUnknownSuccess =
      providerStatus === "succeeded" &&
      (billingResolution.state === "pending" ||
        billingResolution.state === "unknown");
    const status = billingUnknownSuccess ? "unknown" : providerStatus;
    await ctx.db.patch(job._id, {
      providerRequestId: args.providerRequestId,
      ...(args.submissionAttemptId
        ? { submissionState: "submitted" as const }
        : {}),
      ...(args.providerGatewayRequestId
        ? { providerGatewayRequestId: args.providerGatewayRequestId }
        : {}),
      ...(args.providerResponseUrl
        ? { providerResponseUrl: args.providerResponseUrl }
        : {}),
      ...(args.providerStatusUrl
        ? { providerStatusUrl: args.providerStatusUrl }
        : {}),
      upstreamStatus: cancelRequested
        ? "CANCELED"
        : billingUnknownSuccess
          ? "BILLING_DISPOSITION_UNKNOWN"
          : args.upstreamStatus,
      status,
      queuePosition: cancelRequested
        ? null
        : args.queuePosition !== undefined
          ? args.queuePosition
          : job.queuePosition,
      ...mediaBillingResolutionPatch(
        billingUnknownSuccess
          ? {
              state: "unknown" as const,
              reason:
                billingResolution.state === "pending" ||
                billingResolution.state === "unknown"
                  ? billingResolution.reason
                  : "A successful paid request has unresolved billing metadata.",
            }
          : billingResolution,
        now,
      ),
      ...(billingUnknownSuccess
        ? {
            error: {
              code: "BILLING_DISPOSITION_UNKNOWN",
              message:
                "Provider success was retained but cannot be published until billing is reconciled.",
            },
          }
        : {}),
      updatedAt: now,
      ...(status === "running" && job.startedAt === undefined
        ? { startedAt: now }
        : {}),
      ...(status === "succeeded" || status === "failed" || status === "canceled"
        ? { completedAt: now }
        : {}),
    });
    await settleMediaProviderAttemptForJob(
      ctx,
      job.jobId,
      args.submissionAttemptId,
    );
    return { cancelRequested, applied: true };
  },
});

export const markSubmissionFailed = internalMutation({
  args: {
    jobId: v.string(),
    ownerGeneration: v.string(),
    submissionAttemptId: v.optional(v.string()),
    notChargeablePolicy: v.optional(
      v.literal(MEDIA_BILLING_POLICY_DEFINITIVE_REJECTION),
    ),
    upstreamStatus: v.string(),
    error: mediaJobErrorValidator,
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const job = await getJobByJobId(ctx, args.jobId);
    if (!job) {
      return null;
    }
    if (mediaOwnerGeneration(job) !== args.ownerGeneration) {
      throw staleMediaGenerationError();
    }
    if (isTerminalMediaJobStatus(job.status)) {
      await settleMediaProviderAttemptForJob(
        ctx,
        job.jobId,
        args.submissionAttemptId,
      );
      return null;
    }
    await assertMediaJobWriteAllowed(ctx, job, args.ownerGeneration);
    if (
      args.notChargeablePolicy &&
      job.billingDispositionState === "pending" &&
      (!args.submissionAttemptId ||
        job.billingDispositionAttemptId !== args.submissionAttemptId)
    ) {
      throw new ConvexError({
        code: "MEDIA_BILLING_AUTHORITY_MISMATCH",
        message:
          "A definitive no-charge disposition requires its exact provider attempt.",
      });
    }
    const now = Date.now();
    await ctx.db.patch(job._id, {
      status: "failed",
      ...(job.submissionState ? { submissionState: "failed" as const } : {}),
      ...(job.submissionPayloadStorageId
        ? { submissionPayloadStorageId: undefined }
        : {}),
      ...(job.submissionPayloadManifestId
        ? { submissionPayloadManifestId: undefined }
        : {}),
      upstreamStatus: args.upstreamStatus,
      error: args.error,
      ...(args.notChargeablePolicy && job.billingDispositionState === "pending"
        ? {
            billingDispositionState: "not_chargeable" as const,
            billingDispositionPolicy: args.notChargeablePolicy,
            billingDispositionReason: undefined,
            billingDispositionUpdatedAt: now,
            billingDispositionAttemptId: undefined,
          }
        : {}),
      updatedAt: now,
      completedAt: now,
    });
    if (job.submissionPayloadStorageId) {
      await ctx.scheduler.runAfter(
        0,
        internal.media_image_submission.deleteSubmissionPayload,
        { storageId: job.submissionPayloadStorageId },
      );
    }
    if (job.submissionPayloadManifestId) {
      await markPrivatePayloadManifestPending(ctx, {
        manifestId: job.submissionPayloadManifestId,
        now,
      });
      await ctx.scheduler.runAfter(
        0,
        internal.media_image_submission.deletePrivatePayloadManifest,
        { manifestId: job.submissionPayloadManifestId },
      );
    }
    await settleMediaProviderAttemptForJob(
      ctx,
      job.jobId,
      args.submissionAttemptId,
    );
    return null;
  },
});

export const markStaleJobsFailed = internalMutation({
  args: {
    cutoffMs: v.optional(v.number()),
    staleMs: v.optional(v.number()),
    limit: v.optional(v.number()),
  },
  returns: v.object({ updated: v.number() }),
  handler: async (ctx, args) => {
    const limit = Math.max(
      1,
      Math.min(args.limit ?? DEFAULT_STALE_MEDIA_JOB_LIMIT, 500),
    );
    const cutoffMs =
      args.cutoffMs ??
      Date.now() - (args.staleMs ?? 3 * 60 * 60_000 + 15 * 60_000);
    const terminalError = {
      message:
        "Image generation exceeded the provider and webhook reconciliation envelope; its final outcome is unknown.",
      code: "TERMINAL_OUTCOME_UNKNOWN",
    };
    let updated = 0;

    for (const status of ["queued", "running"] as const) {
      for (const capability of STALE_IMAGE_JOB_CAPABILITIES) {
        const jobs = await ctx.db
          .query("media_jobs")
          .withIndex("by_status_and_capability_and_updatedAt", (q) =>
            q
              .eq("status", status)
              .eq("capability", capability)
              .lt("updatedAt", cutoffMs),
          )
          .take(limit - updated);

        const now = Date.now();
        for (const job of jobs) {
          if (isTerminalMediaJobStatus(job.status)) continue;
          if (job.submissionState && job.submissionState !== "submitted") {
            continue;
          }
          if (!(await mediaJobWriteAllowedForWatchdog(ctx, job))) continue;
          await ctx.db.patch(job._id, {
            status: "unknown",
            ...(job.submissionState
              ? { submissionState: "unknown" as const }
              : {}),
            ...(job.submissionPayloadStorageId
              ? { submissionPayloadStorageId: undefined }
              : {}),
            ...(job.submissionPayloadManifestId
              ? { submissionPayloadManifestId: undefined }
              : {}),
            upstreamStatus: "TERMINAL_OUTCOME_UNKNOWN",
            queuePosition: null,
            error: terminalError,
            updatedAt: now,
            completedAt: now,
          });
          if (job.submissionPayloadStorageId) {
            await ctx.scheduler.runAfter(
              0,
              internal.media_image_submission.deleteSubmissionPayload,
              { storageId: job.submissionPayloadStorageId },
            );
          }
          if (job.submissionPayloadManifestId) {
            await markPrivatePayloadManifestPending(ctx, {
              manifestId: job.submissionPayloadManifestId,
              now,
            });
            await ctx.scheduler.runAfter(
              0,
              internal.media_image_submission.deletePrivatePayloadManifest,
              { manifestId: job.submissionPayloadManifestId },
            );
          }
          updated += 1;
        }

        if (updated >= limit) {
          break;
        }
      }
      if (updated >= limit) break;
    }

    return { updated };
  },
});

export const markGenerated = internalMutation({
  args: {
    jobId: v.string(),
    ownerGeneration: v.string(),
    upstreamStatus: v.string(),
    output: jsonValueValidator,
    billing: v.optional(mediaJobBillingValidator),
  },
  returns: v.object({
    applied: v.boolean(),
    billingDisposition: v.union(
      mediaBillingDispositionStateValidator,
      v.null(),
    ),
  }),
  handler: async (ctx, args) => {
    const job = await getJobByJobId(ctx, args.jobId);
    if (!job) {
      return { applied: false as const, billingDisposition: null };
    }
    if (mediaOwnerGeneration(job) !== args.ownerGeneration) {
      throw staleMediaGenerationError();
    }
    if (isTerminalMediaJobStatus(job.status)) {
      return {
        applied: false as const,
        billingDisposition: job.billingDispositionState ?? null,
      };
    }
    await assertOwnerMigrationWriteAllowed(
      ctx,
      job.ownerId,
      args.ownerGeneration,
    );
    const now = Date.now();
    const output = sanitizeJsonValue(args.output);
    const billingResolution = await resolveSuccessfulMediaBilling(ctx, {
      job,
      ownerGeneration: args.ownerGeneration,
      ...(job.providerRequestId
        ? { providerRequestId: job.providerRequestId }
        : {}),
      ...(args.billing ? { billing: args.billing } : {}),
    });
    if (
      billingResolution.state === "pending" ||
      billingResolution.state === "unknown"
    ) {
      const unknownResolution = {
        state: "unknown" as const,
        reason: billingResolution.reason,
      };
      await ctx.db.patch(job._id, {
        status: "unknown",
        upstreamStatus: "BILLING_DISPOSITION_UNKNOWN",
        queuePosition: null,
        output,
        error: {
          code: "BILLING_DISPOSITION_UNKNOWN",
          message:
            "Provider success was retained but cannot be published until billing is reconciled.",
          details: sanitizeJsonValue({ reason: billingResolution.reason }),
        },
        ...mediaBillingResolutionPatch(unknownResolution, now),
        updatedAt: now,
        startedAt: job.startedAt ?? now,
        completedAt: now,
      });
      return {
        applied: true as const,
        billingDisposition: "unknown" as const,
      };
    }
    // `connectorMediaDeliveryScheduledAt` is the dedup gate: we set it in
    // the same patch that schedules `deliverMediaJobToConnector`, so a
    // duplicate `markGenerated` / `applyFalWebhook` for the same job won't
    // re-schedule. `connectorMediaDeliveredAt` is set by the delivery
    // action itself on success — keeping the two flags separate means a
    // transient delivery failure leaves a clear `scheduledAt && !deliveredAt`
    // state for the watchdog (or manual recovery) to retry.
    const shouldScheduleConnectorDelivery =
      Boolean(job.connectorRequestId) &&
      !job.connectorMediaDeliveredAt &&
      !job.connectorMediaDeliveryScheduledAt &&
      extractDeliveryMediaFromOutput(output).length > 0;
    await ctx.db.patch(job._id, {
      status: "succeeded",
      upstreamStatus: args.upstreamStatus,
      queuePosition: null,
      output,
      ...mediaBillingResolutionPatch(billingResolution, now),
      updatedAt: now,
      startedAt: job.startedAt ?? now,
      completedAt: now,
      ...(shouldScheduleConnectorDelivery
        ? {
            connectorMediaDeliveryScheduledAt: now,
            connectorMediaDeliveryAttempts: 1,
          }
        : {}),
    });
    if (shouldScheduleConnectorDelivery) {
      await ctx.scheduler.runAfter(
        0,
        internal.channels.connector_delivery.deliverMediaJobToConnector,
        {
          ownerId: job.ownerId,
          ownerGeneration: args.ownerGeneration,
          requestId: job.connectorRequestId!,
          jobId: job.jobId,
          output,
        },
      );
    }
    return {
      applied: true as const,
      billingDisposition: billingResolution.state,
    };
  },
});

/**
 * Receipt-authorized reconciliation for a retained pending/unknown billing
 * disposition. This intentionally does not reopen the owner lifecycle or
 * publish media: it only commits the exact old-generation receipt and clears
 * the billing debt so reset/delete/migration can later prove quiescence.
 */
export const finalizeMediaBillingDispositionInternal = internalMutation({
  args: {
    jobId: v.string(),
    ownerGeneration: v.string(),
    providerRequestId: v.optional(v.string()),
    billing: mediaJobBillingValidator,
    finalizedAt: v.number(),
  },
  returns: v.object({ finalized: v.boolean(), duplicate: v.boolean() }),
  handler: async (ctx, args) => {
    const job = await getJobByJobId(ctx, args.jobId);
    if (!job || mediaOwnerGeneration(job) !== args.ownerGeneration) {
      throw staleMediaGenerationError();
    }
    if (
      job.billingDispositionState !== "pending" &&
      job.billingDispositionState !== "unknown" &&
      job.billingDispositionState !== "billed"
    ) {
      throw new ConvexError({
        code: "MEDIA_BILLING_DISPOSITION_NOT_RECONCILABLE",
        message: "This media job has no paid billing disposition to reconcile.",
      });
    }
    const invalid = validateMediaBillingEnvelope(job, args.billing);
    if (invalid) {
      throw new ConvexError({
        code: "MEDIA_BILLING_METADATA_INVALID",
        message: invalid,
      });
    }
    const receipt = await recordMediaCompletedUsageAuthorized(ctx, {
      ownerId: job.ownerId,
      ownerGeneration: args.ownerGeneration,
      jobId: job.jobId,
      ...((args.providerRequestId ?? job.providerRequestId)
        ? {
            providerRequestId: args.providerRequestId ?? job.providerRequestId,
          }
        : {}),
      endpointId: args.billing.endpointId,
      billingUnit: String(args.billing.billingUnit),
      quantity: args.billing.quantity,
      costMicroCents: args.billing.costMicroCents,
    });
    await ctx.db.patch(job._id, {
      billing: args.billing,
      billingDispositionState: "billed",
      billingDispositionPolicy: MEDIA_BILLING_POLICY_PAID_PROVIDER_DISPATCH,
      billingDispositionReason: undefined,
      billingDispositionUpdatedAt: args.finalizedAt,
      billingDispositionAttemptId: undefined,
      updatedAt: Math.max(job.updatedAt, args.finalizedAt),
    });
    return {
      finalized: true,
      duplicate: receipt.duplicate,
    };
  },
});

export const applyFalWebhook = internalMutation({
  args: {
    ownerGeneration: v.string(),
    dedupKey: v.optional(v.string()),
    jobId: v.optional(v.string()),
    providerRequestId: v.optional(v.string()),
    providerGatewayRequestId: v.optional(v.string()),
    upstreamStatus: v.string(),
    output: optionalJsonValueValidator,
    billing: v.optional(mediaJobBillingValidator),
    error: v.optional(mediaJobErrorValidator),
    logs: v.optional(v.array(jsonValueValidator)),
    receivedAt: v.number(),
    testCrashAfterDedup: v.optional(v.boolean()),
  },
  returns: v.object({
    updated: v.boolean(),
    notFound: v.optional(v.boolean()),
    staleGeneration: v.optional(v.boolean()),
    duplicate: v.optional(v.boolean()),
    jobId: v.optional(v.string()),
    billingDisposition: v.optional(mediaBillingDispositionStateValidator),
  }),
  handler: async (ctx, args) => {
    const job =
      (args.jobId ? await getJobByJobId(ctx, args.jobId) : null) ??
      (args.providerRequestId
        ? await getJobByProviderRequestId(ctx, args.providerRequestId)
        : null);

    if (!job) {
      return { updated: false, notFound: true };
    }

    if (mediaOwnerGeneration(job) !== args.ownerGeneration) {
      return { updated: false, staleGeneration: true, jobId: job.jobId };
    }

    if (
      isTerminalMediaJobStatus(job.status) &&
      job.status === "canceled" &&
      job.error?.code === "OWNER_PURGED"
    ) {
      const effectiveProviderRequestId =
        args.providerRequestId ?? job.providerRequestId;
      const billingResolution = args.billing
        ? await resolveSuccessfulMediaBilling(ctx, {
            job,
            ownerGeneration: args.ownerGeneration,
            ...(effectiveProviderRequestId
              ? { providerRequestId: effectiveProviderRequestId }
              : {}),
            billing: args.billing,
          })
        : effectiveProviderRequestId
          ? await resolveAcceptedRequestBilling(ctx, {
              job,
              ownerGeneration: args.ownerGeneration,
              providerRequestId: effectiveProviderRequestId,
            })
          : null;
      if (args.providerRequestId && !job.providerRequestId) {
        // Cleanup reconciliation is deliberately allowed after the lifecycle
        // fence closes. It can only attach the exact provider locator to the
        // already-canceled generation and enqueue provider cancellation.
        await ctx.db.patch(job._id, {
          providerRequestId: args.providerRequestId,
          ...(billingResolution
            ? mediaBillingResolutionPatch(billingResolution, args.receivedAt)
            : {}),
          updatedAt: args.receivedAt,
        });
        await enqueueProviderCancellation(ctx, {
          ownerId: job.ownerId,
          ownerGeneration: args.ownerGeneration,
          jobId: job.jobId,
          endpointId: job.endpointId,
          providerRequestId: args.providerRequestId,
          now: args.receivedAt,
        });
        await ctx.scheduler.runAfter(
          0,
          internal.media_image_submission.cancelPurgedProviderRequest,
          { jobId: job.jobId },
        );
      } else if (billingResolution) {
        await ctx.db.patch(
          job._id,
          mediaBillingResolutionPatch(billingResolution, args.receivedAt),
        );
      }
      await settleMediaProviderAttemptForJob(
        ctx,
        job.jobId,
        job.submissionAttemptId,
      );
      return {
        updated: false,
        jobId: job.jobId,
        ...(billingResolution
          ? { billingDisposition: billingResolution.state }
          : {}),
      };
    }

    if (
      isTerminalMediaJobStatus(job.status) &&
      (job.billingDispositionState === "pending" ||
        job.billingDispositionState === "unknown") &&
      toWebhookMediaJobStatus(args.upstreamStatus) === "succeeded"
    ) {
      const effectiveProviderRequestId =
        args.providerRequestId ?? job.providerRequestId;
      const billingResolution = args.billing
        ? await resolveSuccessfulMediaBilling(ctx, {
            job,
            ownerGeneration: args.ownerGeneration,
            ...(effectiveProviderRequestId
              ? { providerRequestId: effectiveProviderRequestId }
              : {}),
            billing: args.billing,
          })
        : effectiveProviderRequestId
          ? await resolveAcceptedRequestBilling(ctx, {
              job,
              ownerGeneration: args.ownerGeneration,
              providerRequestId: effectiveProviderRequestId,
            })
          : {
              state: "unknown" as const,
              reason:
                "A late provider success had no billing metadata or provider locator.",
            };
      await ctx.db.patch(job._id, {
        ...mediaBillingResolutionPatch(
          billingResolution.state === "pending"
            ? {
                state: "unknown" as const,
                reason: billingResolution.reason,
              }
            : billingResolution,
          args.receivedAt,
        ),
        lastWebhookAt: args.receivedAt,
        updatedAt: Math.max(job.updatedAt, args.receivedAt),
      });
      await ctx.db.insert("media_job_logs", {
        ownerId: job.ownerId,
        ownerGeneration: args.ownerGeneration,
        jobId: job.jobId,
        ordinal: Number.MAX_SAFE_INTEGER - args.receivedAt,
        receivedAt: args.receivedAt,
        entry: sanitizeJsonValue({
          kind: "late_terminal_billing_reconciled",
          existingStatus: job.status,
          incomingStatus: args.upstreamStatus,
          billingDisposition:
            billingResolution.state === "pending"
              ? "unknown"
              : billingResolution.state,
        }),
      });
      await settleMediaProviderAttemptForJob(
        ctx,
        job.jobId,
        job.submissionAttemptId,
      );
      return {
        updated: false,
        jobId: job.jobId,
        billingDisposition:
          billingResolution.state === "pending"
            ? ("unknown" as const)
            : billingResolution.state,
      };
    }

    await assertOwnerMigrationWriteAllowed(
      ctx,
      job.ownerId,
      args.ownerGeneration,
    );

    if (args.dedupKey) {
      const duplicate = await ctx.db
        .query("media_webhook_events")
        .withIndex("by_scope_and_dedupKey", (q) =>
          q.eq("scope", "media_fal_webhook").eq("dedupKey", args.dedupKey!),
        )
        .unique();
      if (duplicate) {
        return { updated: false, duplicate: true, jobId: job.jobId };
      }
      await ctx.db.insert("media_webhook_events", {
        ownerId: job.ownerId,
        ownerGeneration: args.ownerGeneration,
        scope: "media_fal_webhook",
        dedupKey: args.dedupKey,
        jobId: job.jobId,
        receivedAt: args.receivedAt,
        applied: !isTerminalMediaJobStatus(job.status),
      });
      if (args.testCrashAfterDedup) {
        throw new Error("Injected crash after webhook dedup reservation");
      }
    }

    // All terminal states are immutable. Duplicate/opposite/late provider
    // events are retained as audit logs but can never reverse the result.
    if (isTerminalMediaJobStatus(job.status)) {
      await ctx.db.insert("media_job_logs", {
        ownerId: job.ownerId,
        ownerGeneration: args.ownerGeneration,
        jobId: job.jobId,
        ordinal: Number.MAX_SAFE_INTEGER - args.receivedAt,
        receivedAt: args.receivedAt,
        entry: sanitizeJsonValue({
          kind: "late_terminal_event_ignored",
          existingStatus: job.status,
          incomingStatus: args.upstreamStatus,
        }),
      });
      await settleMediaProviderAttemptForJob(
        ctx,
        job.jobId,
        job.submissionAttemptId,
      );
      return { updated: false, jobId: job.jobId };
    }

    // Append log entries to the child `media_job_logs` table instead of
    // mutating an inline array on the job document. This keeps the job doc
    // small (and within the 1MB limit) regardless of how many webhook
    // deliveries arrive over the lifetime of a long-running generation.
    if (args.logs && args.logs.length > 0) {
      const existingLogCount = await ctx.db
        .query("media_job_logs")
        .withIndex("by_jobId_and_ordinal", (q) => q.eq("jobId", job.jobId))
        .order("desc")
        .take(1);
      let nextOrdinal = (existingLogCount[0]?.ordinal ?? -1) + 1;
      for (const entry of args.logs) {
        await ctx.db.insert("media_job_logs", {
          ownerId: job.ownerId,
          ownerGeneration: args.ownerGeneration,
          jobId: job.jobId,
          ordinal: nextOrdinal,
          receivedAt: args.receivedAt,
          entry: sanitizeJsonValue(entry),
        });
        nextOrdinal += 1;
      }
    }

    const providerStatus = toWebhookMediaJobStatus(args.upstreamStatus);
    const output =
      args.output !== undefined ? sanitizeJsonValue(args.output) : undefined;
    const billingResolution =
      providerStatus === "succeeded"
        ? await resolveSuccessfulMediaBilling(ctx, {
            job,
            ownerGeneration: args.ownerGeneration,
            ...((args.providerRequestId ?? job.providerRequestId)
              ? {
                  providerRequestId:
                    args.providerRequestId ?? job.providerRequestId,
                }
              : {}),
            ...(args.billing ? { billing: args.billing } : {}),
          })
        : null;
    const billingUnknownSuccess =
      billingResolution?.state === "pending" ||
      billingResolution?.state === "unknown";
    const status = billingUnknownSuccess ? "unknown" : providerStatus;
    const shouldDeliverConnectorMedia =
      status === "succeeded" &&
      job.connectorRequestId &&
      !job.connectorMediaDeliveredAt &&
      !job.connectorMediaDeliveryScheduledAt &&
      output !== undefined &&
      extractDeliveryMediaFromOutput(output).length > 0;
    await ctx.db.patch(job._id, {
      status,
      ...(job.submissionState ? { submissionState: "submitted" as const } : {}),
      ...(job.submissionPayloadStorageId
        ? { submissionPayloadStorageId: undefined }
        : {}),
      ...(job.submissionPayloadManifestId
        ? { submissionPayloadManifestId: undefined }
        : {}),
      upstreamStatus: billingUnknownSuccess
        ? "BILLING_DISPOSITION_UNKNOWN"
        : args.upstreamStatus,
      queuePosition: null,
      ...(args.providerRequestId
        ? { providerRequestId: args.providerRequestId }
        : {}),
      ...(args.providerGatewayRequestId
        ? { providerGatewayRequestId: args.providerGatewayRequestId }
        : {}),
      ...(output !== undefined ? { output } : {}),
      ...(billingResolution
        ? mediaBillingResolutionPatch(
            billingUnknownSuccess
              ? {
                  state: "unknown" as const,
                  reason: billingResolution.reason,
                }
              : billingResolution,
            args.receivedAt,
          )
        : {}),
      ...(billingUnknownSuccess
        ? {
            error: {
              code: "BILLING_DISPOSITION_UNKNOWN",
              message:
                "Provider success was retained but cannot be published until billing is reconciled.",
              details: sanitizeJsonValue({ reason: billingResolution.reason }),
            },
          }
        : args.error
          ? {
              error: {
                message: args.error.message,
                ...(args.error.code ? { code: args.error.code } : {}),
                ...(args.error.details
                  ? {
                      details: sanitizeJsonValue(args.error.details),
                    }
                  : {}),
              },
            }
          : {}),
      updatedAt: args.receivedAt,
      completedAt: args.receivedAt,
      lastWebhookAt: args.receivedAt,
      ...(shouldDeliverConnectorMedia
        ? {
            connectorMediaDeliveryScheduledAt: args.receivedAt,
            connectorMediaDeliveryAttempts: 1,
          }
        : {}),
    });

    if (job.submissionPayloadStorageId) {
      await ctx.scheduler.runAfter(
        0,
        internal.media_image_submission.deleteSubmissionPayload,
        { storageId: job.submissionPayloadStorageId },
      );
    }
    if (job.submissionPayloadManifestId) {
      await markPrivatePayloadManifestPending(ctx, {
        manifestId: job.submissionPayloadManifestId,
        now: args.receivedAt,
      });
      await ctx.scheduler.runAfter(
        0,
        internal.media_image_submission.deletePrivatePayloadManifest,
        { manifestId: job.submissionPayloadManifestId },
      );
    }

    if (shouldDeliverConnectorMedia) {
      await ctx.scheduler.runAfter(
        0,
        internal.channels.connector_delivery.deliverMediaJobToConnector,
        {
          ownerId: job.ownerId,
          ownerGeneration: args.ownerGeneration,
          requestId: job.connectorRequestId!,
          jobId: job.jobId,
          output: output!,
        },
      );
    }

    await settleMediaProviderAttemptForJob(
      ctx,
      job.jobId,
      job.submissionAttemptId,
    );

    return {
      updated: true,
      jobId: job.jobId,
      ...(billingResolution
        ? {
            billingDisposition: billingUnknownSuccess
              ? ("unknown" as const)
              : billingResolution.state,
          }
        : {}),
    };
  },
});

/**
 * Patch a media job to record a successful connector media delivery.
 * Called from `deliverMediaJobToConnector` after the connector POST
 * succeeded, separately from the `markGenerated` / `applyFalWebhook`
 * mutations so a transient delivery failure doesn't leave the row
 * marked "delivered" forever.
 */
export const markConnectorMediaDelivered = internalMutation({
  args: {
    jobId: v.string(),
    ownerGeneration: v.string(),
    deliveredAt: v.number(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const job = await getJobByJobId(ctx, args.jobId);
    if (!job) return null;
    await assertMediaJobWriteAllowed(ctx, job, args.ownerGeneration);
    if (job.connectorMediaDeliveredAt) return null;
    await ctx.db.patch(job._id, {
      connectorMediaDeliveredAt: args.deliveredAt,
      ...(job.connectorMediaDeliveryError
        ? { connectorMediaDeliveryError: undefined }
        : {}),
    });
    return null;
  },
});

/**
 * Record the most recent connector media delivery failure on the job.
 * Leaves `connectorMediaDeliveryScheduledAt` set so the dedup gate keeps
 * holding — recovery is via manual re-trigger or a future watchdog rather
 * than spontaneous re-fire on the next mutation.
 */
export const markConnectorMediaDeliveryFailed = internalMutation({
  args: {
    jobId: v.string(),
    ownerGeneration: v.string(),
    error: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const job = await getJobByJobId(ctx, args.jobId);
    if (!job) return null;
    await assertMediaJobWriteAllowed(ctx, job, args.ownerGeneration);
    if (job.connectorMediaDeliveredAt) return null;
    await ctx.db.patch(job._id, {
      connectorMediaDeliveryError: args.error.slice(0, 1000),
    });
    return null;
  },
});

/** Restart-durable watchdog for terminal image connector delivery. */
export const retryStuckImageConnectorDeliveries = internalMutation({
  args: {
    staleMs: v.optional(v.number()),
    limit: v.optional(v.number()),
    maxAttempts: v.optional(v.number()),
  },
  returns: v.object({ retried: v.number(), abandoned: v.number() }),
  handler: async (ctx, args) => {
    const limit = Math.max(1, Math.min(args.limit ?? 100, 500));
    const maxAttempts = Math.max(1, Math.min(args.maxAttempts ?? 5, 20));
    const cutoff = Date.now() - (args.staleMs ?? 5 * 60_000);
    let retried = 0;
    let abandoned = 0;
    const rows = await ctx.db
      .query("media_jobs")
      .withIndex("by_status_and_connectorMediaDeliveryScheduledAt", (q) =>
        q
          .eq("status", "succeeded")
          .gt("connectorMediaDeliveryScheduledAt", 0)
          .lt("connectorMediaDeliveryScheduledAt", cutoff),
      )
      .order("asc")
      .take(limit);
    for (const job of rows) {
      if (
        !(STALE_IMAGE_JOB_CAPABILITIES as readonly string[]).includes(
          job.capability,
        )
      ) {
        continue;
      }
      if (
        !job.connectorRequestId ||
        !job.connectorMediaDeliveryScheduledAt ||
        job.connectorMediaDeliveredAt ||
        job.connectorMediaDeliveryAbandonedAt ||
        job.connectorMediaDeliveryScheduledAt > cutoff ||
        job.output === undefined
      ) {
        continue;
      }
      if (!(await mediaJobWriteAllowedForWatchdog(ctx, job))) continue;
      const attempts = job.connectorMediaDeliveryAttempts ?? 1;
      if (attempts >= maxAttempts) {
        await ctx.db.patch(job._id, {
          connectorMediaDeliveryAbandonedAt: Date.now(),
          connectorMediaDeliveryError:
            job.connectorMediaDeliveryError ??
            "Connector image delivery exhausted its retry budget.",
        });
        abandoned += 1;
        continue;
      }
      const scheduledAt = Date.now();
      await ctx.db.patch(job._id, {
        connectorMediaDeliveryScheduledAt: scheduledAt,
        connectorMediaDeliveryAttempts: attempts + 1,
      });
      await ctx.scheduler.runAfter(
        0,
        internal.channels.connector_delivery.deliverMediaJobToConnector,
        {
          ownerId: job.ownerId,
          ownerGeneration: mediaOwnerGeneration(job),
          requestId: job.connectorRequestId,
          jobId: job.jobId,
          output: job.output,
        },
      );
      retried += 1;
      if (retried + abandoned >= limit) break;
    }
    return { retried, abandoned };
  },
});
