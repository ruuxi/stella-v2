import { ConvexError, type Value, v } from "convex/values";
import {
  internalMutation,
  internalQuery,
  query,
  type MutationCtx,
  type QueryCtx,
} from "./_generated/server";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
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

export const PUBLIC_MEDIA_TEST_OWNER_ID = "__public_media_test__";
export {
  MAX_PRIVATE_MEDIA_PAYLOAD_CHARS,
  PRIVATE_MEDIA_PAYLOAD_CHUNK_CHARS,
} from "./media_image_limits";
const INCOMPLETE_PRIVATE_PAYLOAD_RETENTION_MS = 60 * 60_000;
const UNATTACHED_PRIVATE_PAYLOAD_RETENTION_MS = 24 * 60 * 60_000;

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
  if (!existing) {
    await ctx.db.insert("media_provider_cancellations", {
      ownerId: args.ownerId,
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
    manifestId: v.string(),
    index: v.number(),
    data: v.string(),
    writtenAt: v.number(),
  },
  returns: v.union(v.literal("appended"), v.literal("owner_purged")),
  handler: async (ctx, args) => {
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
    if (!manifest || manifest.ownerId !== args.ownerId) {
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
      if (existing.ownerId !== args.ownerId || existing.data !== args.data) {
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
    manifestId: v.string(),
    finalizedAt: v.number(),
  },
  returns: v.union(v.literal("held"), v.literal("owner_purged")),
  handler: async (ctx, args) => {
    const manifest = await ctx.db
      .query("media_private_payload_manifests")
      .withIndex("by_manifestId", (q) => q.eq("manifestId", args.manifestId))
      .unique();
    if (!manifest || manifest.ownerId !== args.ownerId) {
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

export const completeProviderCancellation = internalMutation({
  args: { jobId: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const row = await ctx.db
      .query("media_provider_cancellations")
      .withIndex("by_jobId", (q) => q.eq("jobId", args.jobId))
      .unique();
    if (row) await ctx.db.delete(row._id);
    return null;
  },
});

export const failProviderCancellation = internalMutation({
  args: { jobId: v.string(), error: v.string(), failedAt: v.number() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const row = await ctx.db
      .query("media_provider_cancellations")
      .withIndex("by_jobId", (q) => q.eq("jobId", args.jobId))
      .unique();
    if (row) {
      const attempts = row.attempts + 1;
      await ctx.db.patch(row._id, {
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
    jobId: v.string(),
  },
  returns: v.union(v.null(), mediaJobResponseValidator),
  handler: async (ctx, args) => {
    const job = await ctx.db
      .query("media_jobs")
      .withIndex("by_ownerId_and_jobId", (q) =>
        q.eq("ownerId", args.ownerId).eq("jobId", args.jobId),
      )
      .unique();

    return job ? toStoredMediaJobResponse(job) : null;
  },
});

export const getByOwnerClientRequestKey = internalQuery({
  args: {
    ownerId: v.string(),
    clientRequestKey: v.string(),
  },
  returns: v.union(v.null(), idempotentJobLookupValidator),
  handler: async (ctx, args) => {
    const job = await getJobByClientRequestKey(
      ctx,
      args.ownerId,
      args.clientRequestKey,
    );
    return job
      ? {
          jobId: job.jobId,
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
  args: { jobId: v.string() },
  returns: v.union(
    v.null(),
    v.object({
      storageId: v.optional(v.id("_storage")),
      manifestId: v.optional(v.string()),
    }),
  ),
  handler: async (ctx, args) => {
    const job = await getJobByJobId(ctx, args.jobId);
    if (
      !job ||
      job.submissionState !== "pending" ||
      (!job.submissionPayloadStorageId && !job.submissionPayloadManifestId) ||
      isTerminalMediaJobStatus(job.status)
    )
      return null;
    return {
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
      request: job.request,
      endpointId: job.endpointId,
      providerRequestId: job.providerRequestId,
      providerResponseUrl: job.providerResponseUrl,
      providerStatusUrl: job.providerStatusUrl,
    };
  },
});

export const createJob = internalMutation({
  args: {
    ownerId: v.string(),
    jobId: v.string(),
    capability: v.string(),
    profile: v.string(),
    provider: v.union(v.literal("fal"), v.literal("google_lyria")),
    endpointId: v.string(),
    request: mediaRequestSummaryValidator,
    connectorRequestId: v.optional(v.string()),
    billing: v.optional(mediaJobBillingValidator),
  },
  handler: async (ctx, args) => {
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
      status: "queued",
      upstreamStatus: "IN_QUEUE",
      queuePosition: null,
      createdAt: now,
      updatedAt: now,
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
    jobId: v.string(),
    clientRequestKey: v.string(),
    clientRequestHash: v.string(),
    capability: v.string(),
    profile: v.string(),
    provider: v.union(v.literal("fal"), v.literal("google_lyria")),
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
        { jobId: args.jobId },
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
  args: { ownerId: v.string(), jobId: v.string() },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const job = await getJobByJobId(ctx, args.jobId);
    if (!job || job.ownerId !== args.ownerId || job.status === "canceled") {
      return false;
    }
    return !job.providerRequestId;
  },
});

const submissionClaimResultValidator = v.union(
  v.object({
    state: v.literal("claimed"),
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
  args: { jobId: v.string(), attemptId: v.string(), claimedAt: v.number() },
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
    await ctx.db.patch(job._id, {
      submissionState: "dispatching",
      submissionAttemptId: args.attemptId,
      submissionClaimedAt: args.claimedAt,
      updatedAt: args.claimedAt,
    });
    return {
      state: "claimed" as const,
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
        { jobId: job.jobId },
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
    clientRequestKey: v.string(),
    canceledAt: v.number(),
  },
  returns: cancelIdempotentRequestResultValidator,
  handler: async (ctx, args) => {
    const existingTombstone = await ctx.db
      .query("media_request_cancellations")
      .withIndex("by_ownerId_and_clientRequestKey", (q) =>
        q
          .eq("ownerId", args.ownerId)
          .eq("clientRequestKey", args.clientRequestKey),
      )
      .unique();
    if (!existingTombstone) {
      await ctx.db.insert("media_request_cancellations", {
        ownerId: args.ownerId,
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
  args: { jobId: v.string(), storageId: v.id("_storage") },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const job = await getJobByJobId(ctx, args.jobId);
    if (!job || job.submissionPayloadStorageId !== args.storageId) return false;
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
  args: { jobId: v.string(), manifestId: v.string() },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const job = await getJobByJobId(ctx, args.jobId);
    if (!job || job.submissionPayloadManifestId !== args.manifestId)
      return false;
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

    if (
      args.submissionAttemptId &&
      (job.submissionState !== "dispatching" ||
        job.submissionAttemptId !== args.submissionAttemptId)
    ) {
      return { cancelRequested: job.status === "canceled", applied: false };
    }
    if (isTerminalMediaJobStatus(job.status)) {
      if (
        job.status === "canceled" &&
        job.submissionState === "dispatching" &&
        (!args.submissionAttemptId ||
          job.submissionAttemptId === args.submissionAttemptId)
      ) {
        // Account deletion can win immediately after the durable dispatch
        // claim. Retain the accepted provider identity without reversing the
        // canceled terminal state so the action can issue Fal cancellation.
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
          updatedAt: Date.now(),
        });
        await enqueueProviderCancellation(ctx, {
          ownerId: job.ownerId,
          jobId: job.jobId,
          endpointId: job.endpointId,
          providerRequestId: args.providerRequestId,
          now: Date.now(),
        });
        await ctx.scheduler.runAfter(
          0,
          internal.media_image_submission.cancelPurgedProviderRequest,
          { jobId: job.jobId },
        );
        return { cancelRequested: true, applied: true };
      }
      return { cancelRequested: job.status === "canceled", applied: false };
    }

    const now = Date.now();
    const cancelRequested = job.status === "canceled";
    const status = cancelRequested
      ? "canceled"
      : toInitialMediaJobStatus(args.upstreamStatus);
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
      upstreamStatus: cancelRequested ? "CANCELED" : args.upstreamStatus,
      status,
      queuePosition: cancelRequested
        ? null
        : args.queuePosition !== undefined
          ? args.queuePosition
          : job.queuePosition,
      updatedAt: now,
      ...(status === "running" && job.startedAt === undefined
        ? { startedAt: now }
        : {}),
      ...(status === "succeeded" || status === "failed" || status === "canceled"
        ? { completedAt: now }
        : {}),
    });
    return { cancelRequested, applied: true };
  },
});

export const markSubmissionFailed = internalMutation({
  args: {
    jobId: v.string(),
    upstreamStatus: v.string(),
    error: mediaJobErrorValidator,
  },
  handler: async (ctx, args) => {
    const job = await getJobByJobId(ctx, args.jobId);
    if (!job) {
      return null;
    }
    if (isTerminalMediaJobStatus(job.status)) return null;
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
    return null;
  },
});

export const markStaleJobsFailed = internalMutation({
  args: {
    cutoffMs: v.optional(v.number()),
    staleMs: v.optional(v.number()),
    limit: v.optional(v.number()),
  },
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
    upstreamStatus: v.string(),
    output: jsonValueValidator,
    billing: v.optional(mediaJobBillingValidator),
  },
  handler: async (ctx, args) => {
    const job = await getJobByJobId(ctx, args.jobId);
    if (!job) {
      return null;
    }
    if (isTerminalMediaJobStatus(job.status)) return null;
    const now = Date.now();
    const output = sanitizeJsonValue(args.output);
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
      ...(args.billing ? { billing: args.billing } : {}),
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
          requestId: job.connectorRequestId!,
          jobId: job.jobId,
          output,
        },
      );
    }
    // The fal path charges usage from the webhook handler; jobs completed
    // via `markGenerated` (e.g. Lyria) must charge here or the generation
    // never counts against the owner's usage windows. The receipt table in
    // `recordMediaCompletedUsage` makes this idempotent per job.
    if (args.billing) {
      await ctx.scheduler.runAfter(
        0,
        internal.billing.recordMediaCompletedUsage,
        {
          ownerId: job.ownerId,
          jobId: job.jobId,
          ...(job.providerRequestId
            ? { providerRequestId: job.providerRequestId }
            : {}),
          endpointId: args.billing.endpointId,
          billingUnit: String(args.billing.billingUnit),
          quantity: args.billing.quantity,
          costMicroCents: args.billing.costMicroCents,
        },
      );
    }
    return null;
  },
});

export const applyFalWebhook = internalMutation({
  args: {
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
  handler: async (ctx, args) => {
    const job =
      (args.jobId ? await getJobByJobId(ctx, args.jobId) : null) ??
      (args.providerRequestId
        ? await getJobByProviderRequestId(ctx, args.providerRequestId)
        : null);

    if (!job) {
      return { updated: false, notFound: true };
    }

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
      if (
        job.status === "canceled" &&
        job.error?.code === "OWNER_PURGED" &&
        args.providerRequestId &&
        !job.providerRequestId
      ) {
        // A response-lost POST can first reveal its provider identity in the
        // webhook. Persist only reconciliation metadata and a cancellation
        // outbox entry; the terminal cancellation and billing state remain
        // immutable.
        await ctx.db.patch(job._id, {
          providerRequestId: args.providerRequestId,
          updatedAt: args.receivedAt,
        });
        await enqueueProviderCancellation(ctx, {
          ownerId: job.ownerId,
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
      }
      await ctx.db.insert("media_job_logs", {
        ownerId: job.ownerId,
        jobId: job.jobId,
        ordinal: Number.MAX_SAFE_INTEGER - args.receivedAt,
        receivedAt: args.receivedAt,
        entry: sanitizeJsonValue({
          kind: "late_terminal_event_ignored",
          existingStatus: job.status,
          incomingStatus: args.upstreamStatus,
        }),
      });
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
          jobId: job.jobId,
          ordinal: nextOrdinal,
          receivedAt: args.receivedAt,
          entry: sanitizeJsonValue(entry),
        });
        nextOrdinal += 1;
      }
    }

    const status = toWebhookMediaJobStatus(args.upstreamStatus);
    const output =
      args.output !== undefined ? sanitizeJsonValue(args.output) : undefined;
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
      upstreamStatus: args.upstreamStatus,
      queuePosition: null,
      ...(args.providerRequestId
        ? { providerRequestId: args.providerRequestId }
        : {}),
      ...(args.providerGatewayRequestId
        ? { providerGatewayRequestId: args.providerGatewayRequestId }
        : {}),
      ...(output !== undefined ? { output } : {}),
      ...(args.billing ? { billing: args.billing } : {}),
      ...(args.error
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
          requestId: job.connectorRequestId!,
          jobId: job.jobId,
          output: output!,
        },
      );
    }

    // Scheduling is transactional in Convex. This billing receipt work is
    // committed only with the allowed success transition and is absent for
    // duplicate, canceled, unknown, timed-out, or otherwise late events.
    if (status === "succeeded" && args.billing) {
      await ctx.scheduler.runAfter(
        0,
        internal.billing.recordMediaCompletedUsage,
        {
          ownerId: job.ownerId,
          jobId: job.jobId,
          ...(args.providerRequestId
            ? { providerRequestId: args.providerRequestId }
            : {}),
          endpointId: args.billing.endpointId,
          billingUnit: String(args.billing.billingUnit),
          quantity: args.billing.quantity,
          costMicroCents: args.billing.costMicroCents,
        },
      );
    }

    return { updated: true, jobId: job.jobId };
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
  args: { jobId: v.string(), deliveredAt: v.number() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const job = await getJobByJobId(ctx, args.jobId);
    if (!job) return null;
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
  args: { jobId: v.string(), error: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const job = await getJobByJobId(ctx, args.jobId);
    if (!job) return null;
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
