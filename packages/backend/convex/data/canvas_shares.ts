import { v } from "convex/values";
import {
  internalMutation,
  internalQuery,
  query,
} from "../_generated/server";
import { getConnectedUserIdOrNull } from "../auth";
import { buildCanvasShareUrl } from "../lib/canvas_share_url";

const shareR2RefValidator = v.object({
  id: v.id("canvas_shares"),
  slug: v.string(),
  r2Key: v.string(),
});

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

export const deleteShareRows = internalMutation({
  args: { ids: v.array(v.id("canvas_shares")) },
  returns: v.null(),
  handler: async (ctx, { ids }) => {
    await Promise.all(ids.map((id) => ctx.db.delete(id)));
    return null;
  },
});
