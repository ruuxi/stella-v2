/**
 * Convex data layer for canvas shares (V8 runtime).
 *
 * Public reads plus the internal mutations/queries the `"use node"`
 * publish/revoke/purge actions in `data/canvas_shares_actions.ts` call into.
 * R2 object writes/deletes live in the node action module because they need
 * `node:crypto` for SigV4 signing.
 */

import { v } from "convex/values";
import {
  internalMutation,
  internalQuery,
  query,
} from "../_generated/server";
import { getConnectedUserIdOrNull } from "../auth";
import { buildCanvasShareUrl } from "../lib/canvas_share_url";

/** Shape returned to internal callers that need to touch R2 objects. */
const shareR2RefValidator = v.object({
  id: v.id("canvas_shares"),
  slug: v.string(),
  r2Key: v.string(),
});

/**
 * The caller's live shares (not revoked, not expired), newest first. Backs a
 * UI subscription, so a signed-out/anonymous render returns [] instead of
 * throwing.
 */
export const listMine = query({
  args: {},
  returns: v.array(
    v.object({
      slug: v.string(),
      url: v.string(),
      title: v.optional(v.string()),
      createdAt: v.number(),
      expiresAt: v.number(),
    }),
  ),
  handler: async (ctx) => {
    const ownerUserId = await getConnectedUserIdOrNull(ctx);
    if (!ownerUserId) return [];
    const now = Date.now();
    const rows = await ctx.db
      .query("canvas_shares")
      .withIndex("by_ownerUserId", (q) => q.eq("ownerUserId", ownerUserId))
      .collect();
    return rows
      .filter((row) => !row.revoked && row.expiresAt > now)
      .sort((a, b) => b.createdAt - a.createdAt)
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

/** Insert a freshly-published share row. */
export const insertShare = internalMutation({
  args: {
    slug: v.string(),
    ownerUserId: v.string(),
    r2Key: v.string(),
    title: v.optional(v.string()),
    createdAt: v.number(),
    expiresAt: v.number(),
  },
  returns: v.id("canvas_shares"),
  handler: async (ctx, args) => {
    return await ctx.db.insert("canvas_shares", {
      slug: args.slug,
      ownerUserId: args.ownerUserId,
      r2Key: args.r2Key,
      ...(args.title !== undefined ? { title: args.title } : {}),
      createdAt: args.createdAt,
      expiresAt: args.expiresAt,
      revoked: false,
    });
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
    }));
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
      .withIndex("by_ownerUserId", (q) =>
        q.eq("ownerUserId", args.ownerUserId),
      )
      .take(batchSize);
    return rows.map((row) => ({
      id: row._id,
      slug: row.slug,
      r2Key: row.r2Key,
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
