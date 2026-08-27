/**
 * Convex data layer for canvas shares (V8 runtime).
 *
 * Public reads plus the internal mutations/queries the `"use node"`
 * publish/revoke/purge actions in `data/canvas_shares_actions.ts` call into.
 * R2 object writes/deletes live in the node action module because they need
 * `node:crypto` for SigV4 signing.
 */

import { ConvexError, v } from "convex/values";
import { internalMutation, internalQuery, query } from "../_generated/server";
import { getConnectedUserIdOrNull } from "../auth";
import { buildCanvasShareUrl } from "../lib/canvas_share_url";
import {
  assertOwnerDataWriteAllowed,
  assertOwnerPurgeLease,
} from "../owner_lifecycle";

/** Shape returned to internal callers that need to touch R2 objects. */
const shareR2RefValidator = v.object({
  id: v.id("canvas_shares"),
  slug: v.string(),
  r2Key: v.string(),
  publicationState: v.optional(
    v.union(v.literal("uploading"), v.literal("published")),
  ),
  publicationLeaseExpiresAt: v.optional(v.number()),
  ownerUserId: v.optional(v.string()),
  publicationGeneration: v.optional(v.string()),
});

const stalePublicationRefValidator = v.object({
  id: v.id("canvas_shares"),
  slug: v.string(),
  r2Key: v.string(),
  ownerUserId: v.string(),
  publicationGeneration: v.string(),
  publicationLeaseExpiresAt: v.number(),
});

const DEFAULT_LIST_MINE_LIMIT = 100;
const MAX_LIST_MINE_LIMIT = 100;

const normalizeListMineLimit = (requested: number | undefined): number => {
  if (requested === undefined) return DEFAULT_LIST_MINE_LIMIT;
  if (!Number.isFinite(requested)) {
    throw new ConvexError({
      code: "INVALID_ARGUMENT",
      message: "limit must be a finite number",
    });
  }
  return Math.min(Math.max(Math.floor(requested), 1), MAX_LIST_MINE_LIMIT);
};

/**
 * The caller's live shares (not revoked, not expired), newest first. Backs a
 * UI subscription, so a signed-out/anonymous render returns [] instead of
 * throwing.
 */
export const listMine = query({
  args: {
    snapshotAt: v.number(),
    limit: v.optional(v.number()),
  },
  returns: v.array(
    v.object({
      slug: v.string(),
      url: v.string(),
      title: v.optional(v.string()),
      createdAt: v.number(),
      expiresAt: v.number(),
    }),
  ),
  handler: async (ctx, args) => {
    const ownerUserId = await getConnectedUserIdOrNull(ctx);
    if (!ownerUserId) return [];
    if (!Number.isFinite(args.snapshotAt)) {
      throw new ConvexError({
        code: "INVALID_ARGUMENT",
        message: "snapshotAt must be a finite number",
      });
    }
    const limit = normalizeListMineLimit(args.limit);
    // Legacy published rows have no publicationState. Query them separately
    // from current published rows so uploading reservations never consume the
    // bounded result budget.
    const [legacyRows, publishedRows] = await Promise.all([
      ctx.db
        .query("canvas_shares")
        .withIndex(
          "by_ownerUserId_and_revoked_and_publicationState_and_expiresAt",
          (q) =>
            q
              .eq("ownerUserId", ownerUserId)
              .eq("revoked", false)
              .eq("publicationState", undefined)
              .gt("expiresAt", args.snapshotAt),
        )
        .order("desc")
        .take(limit),
      ctx.db
        .query("canvas_shares")
        .withIndex(
          "by_ownerUserId_and_revoked_and_publicationState_and_expiresAt",
          (q) =>
            q
              .eq("ownerUserId", ownerUserId)
              .eq("revoked", false)
              .eq("publicationState", "published")
              .gt("expiresAt", args.snapshotAt),
        )
        .order("desc")
        .take(limit),
    ]);
    return [...legacyRows, ...publishedRows]
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, limit)
      .map((row) => ({
        slug: row.slug,
        url: buildCanvasShareUrl(row.slug),
        ...(row.title !== undefined ? { title: row.title } : {}),
        createdAt: row.createdAt,
        expiresAt: row.expiresAt,
      }));
  },
});

/** Look up a share by slug (ownership check for revoke). */
export const getBySlug = internalQuery({
  args: { slug: v.string() },
  returns: v.union(
    v.object({
      id: v.id("canvas_shares"),
      ownerUserId: v.string(),
      r2Key: v.string(),
      revoked: v.boolean(),
    }),
    v.null(),
  ),
  handler: async (ctx, { slug }) => {
    const row = await ctx.db
      .query("canvas_shares")
      .withIndex("by_slug", (q) => q.eq("slug", slug))
      .unique();
    if (!row) return null;
    return {
      id: row._id,
      ownerUserId: row.ownerUserId,
      r2Key: row.r2Key,
      revoked: row.revoked,
    };
  },
});

/** Reserve the locator before R2 upload so an in-flight PUT cannot be orphaned. */
export const reserveSharePublication = internalMutation({
  args: {
    slug: v.string(),
    ownerUserId: v.string(),
    ownerGeneration: v.string(),
    r2Key: v.string(),
    title: v.optional(v.string()),
    createdAt: v.number(),
    publicationLeaseExpiresAt: v.number(),
  },
  returns: v.id("canvas_shares"),
  handler: async (ctx, args) => {
    await assertOwnerDataWriteAllowed(
      ctx,
      args.ownerUserId,
      args.ownerGeneration,
    );
    return await ctx.db.insert("canvas_shares", {
      slug: args.slug,
      ownerUserId: args.ownerUserId,
      r2Key: args.r2Key,
      ...(args.title !== undefined ? { title: args.title } : {}),
      createdAt: args.createdAt,
      // Stale/ambiguous publications become eligible for the best-effort
      // cleanup cron when their upload lease ends. Successful publication
      // replaces this with the requested long-lived expiry below.
      expiresAt: args.publicationLeaseExpiresAt,
      revoked: false,
      publicationState: "uploading",
      publicationGeneration: args.ownerGeneration,
      publicationLeaseExpiresAt: args.publicationLeaseExpiresAt,
    });
  },
});

/** Publish only the exact reservation and only in the admitted generation. */
export const finishSharePublication = internalMutation({
  args: {
    id: v.id("canvas_shares"),
    ownerUserId: v.string(),
    ownerGeneration: v.string(),
    slug: v.string(),
    r2Key: v.string(),
    expiresAt: v.number(),
  },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    await assertOwnerDataWriteAllowed(
      ctx,
      args.ownerUserId,
      args.ownerGeneration,
    );
    const row = await ctx.db.get(args.id);
    if (
      !row ||
      row.ownerUserId !== args.ownerUserId ||
      row.slug !== args.slug ||
      row.r2Key !== args.r2Key ||
      row.publicationState !== "uploading" ||
      row.publicationGeneration !== args.ownerGeneration
    ) {
      return false;
    }
    await ctx.db.patch(row._id, {
      publicationState: "published",
      publicationGeneration: undefined,
      publicationLeaseExpiresAt: undefined,
      expiresAt: args.expiresAt,
    });
    return true;
  },
});

/**
 * Removes an exact failed reservation only after the action confirmed the R2
 * object absent. This cleanup acknowledgement is intentionally allowed while
 * the lifecycle is closed; it can only reduce owner state.
 */
export const deleteConfirmedSharePublication = internalMutation({
  args: {
    id: v.id("canvas_shares"),
    ownerUserId: v.string(),
    ownerGeneration: v.string(),
    slug: v.string(),
    r2Key: v.string(),
  },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.id);
    if (
      !row ||
      row.ownerUserId !== args.ownerUserId ||
      row.slug !== args.slug ||
      row.r2Key !== args.r2Key ||
      row.publicationState !== "uploading" ||
      row.publicationGeneration !== args.ownerGeneration
    ) {
      return false;
    }
    await ctx.db.delete(row._id);
    return true;
  },
});

/** Mark a share revoked after its R2 object has been deleted. */
export const markRevoked = internalMutation({
  args: { id: v.id("canvas_shares") },
  returns: v.null(),
  handler: async (ctx, { id }) => {
    const row = await ctx.db.get(id);
    if (row && !row.revoked) {
      await ctx.db.patch(id, { revoked: true });
    }
    return null;
  },
});

/** A bounded page of expired shares for the purge cron. */
export const listExpiredBatch = internalQuery({
  args: { batchSize: v.optional(v.number()) },
  returns: v.array(shareR2RefValidator),
  handler: async (ctx, args) => {
    const batchSize = Math.min(
      Math.max(Math.floor(args.batchSize ?? 200), 1),
      1000,
    );
    const now = Date.now();
    const expired = await ctx.db
      .query("canvas_shares")
      .withIndex("by_expiresAt", (q) => q.lt("expiresAt", now))
      .take(batchSize);
    return expired.map((row) => ({
      id: row._id,
      slug: row.slug,
      r2Key: row.r2Key,
      ...(row.publicationState
        ? { publicationState: row.publicationState }
        : {}),
      ...(row.publicationLeaseExpiresAt !== undefined
        ? { publicationLeaseExpiresAt: row.publicationLeaseExpiresAt }
        : {}),
      ownerUserId: row.ownerUserId,
      ...(row.publicationGeneration
        ? { publicationGeneration: row.publicationGeneration }
        : {}),
    }));
  },
});

/** Strict cron acknowledgement for an abandoned/ambiguous upload locator. */
export const deleteConfirmedStaleSharePublications = internalMutation({
  args: { refs: v.array(stalePublicationRefValidator), now: v.number() },
  returns: v.object({ deleted: v.number() }),
  handler: async (ctx, args) => {
    let deleted = 0;
    for (const ref of args.refs) {
      const row = await ctx.db.get(ref.id);
      if (
        row?.ownerUserId === ref.ownerUserId &&
        row.slug === ref.slug &&
        row.r2Key === ref.r2Key &&
        row.publicationState === "uploading" &&
        row.publicationGeneration === ref.publicationGeneration &&
        row.publicationLeaseExpiresAt === ref.publicationLeaseExpiresAt &&
        row.publicationLeaseExpiresAt <= args.now
      ) {
        await ctx.db.delete(row._id);
        deleted += 1;
      }
    }
    return { deleted };
  },
});

/** A bounded page of an owner's shares for account-deletion cleanup. */
export const listOwnerBatch = internalQuery({
  args: { ownerUserId: v.string(), batchSize: v.optional(v.number()) },
  returns: v.array(shareR2RefValidator),
  handler: async (ctx, args) => {
    const batchSize = Math.min(
      Math.max(Math.floor(args.batchSize ?? 200), 1),
      1000,
    );
    const rows = await ctx.db
      .query("canvas_shares")
      .withIndex("by_ownerUserId", (q) => q.eq("ownerUserId", args.ownerUserId))
      .take(batchSize);
    return rows.map((row) => ({
      id: row._id,
      slug: row.slug,
      r2Key: row.r2Key,
      ...(row.publicationState
        ? { publicationState: row.publicationState }
        : {}),
      ...(row.publicationLeaseExpiresAt !== undefined
        ? { publicationLeaseExpiresAt: row.publicationLeaseExpiresAt }
        : {}),
    }));
  },
});

/** Delete share rows by id (used after their R2 objects are removed). */
export const deleteShareRows = internalMutation({
  args: { ids: v.array(v.id("canvas_shares")) },
  returns: v.null(),
  handler: async (ctx, { ids }) => {
    await Promise.all(ids.map((id) => ctx.db.delete(id)));
    return null;
  },
});

/**
 * Account-deletion acknowledgement for canvas R2 objects. Each row is removed
 * only when the action just confirmed deletion of that exact owner/key pair;
 * failed object deletes retain their locator for the durable purge retry.
 */
export const deleteConfirmedOwnerShareRows = internalMutation({
  args: {
    ownerId: v.string(),
    operationId: v.string(),
    generation: v.string(),
    leaseId: v.string(),
    mode: v.union(v.literal("reset"), v.literal("delete")),
    refs: v.array(shareR2RefValidator),
  },
  returns: v.object({ deleted: v.number() }),
  handler: async (ctx, args) => {
    await assertOwnerPurgeLease(ctx, { ...args, stage: "core" });
    let deleted = 0;
    for (const ref of args.refs) {
      const row = await ctx.db.get(ref.id);
      if (
        row?.ownerUserId === args.ownerId &&
        row.slug === ref.slug &&
        row.r2Key === ref.r2Key
      ) {
        await ctx.db.delete(row._id);
        deleted += 1;
      }
    }
    return { deleted };
  },
});
