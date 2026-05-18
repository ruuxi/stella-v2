import { v } from "convex/values";
import {
  internalMutation,
  internalQuery,
  type MutationCtx,
} from "./_generated/server";
import type { Id } from "./_generated/dataModel";

const REPLY_TTL_MS = 2 * 60_000;
const MAX_PURGE_BATCH = 500;

const getConversationOwnerId = async (
  ctx: MutationCtx,
  conversationId: Id<"conversations">,
) => {
  const conversation = await ctx.db.get(conversationId);
  return conversation?.ownerId ?? null;
};

export const publishDesktopReply = internalMutation({
  args: {
    conversationId: v.id("conversations"),
    requestId: v.string(),
    text: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const ownerId = await getConversationOwnerId(ctx, args.conversationId);
    if (!ownerId) {
      return null;
    }

    const now = Date.now();
    const existing = await ctx.db
      .query("mobile_app_replies")
      .withIndex("by_ownerId_and_requestId", (q) =>
        q.eq("ownerId", ownerId).eq("requestId", args.requestId),
      )
      .first();

    if (existing) {
      await ctx.db.patch(existing._id, {
        text: args.text,
        createdAt: now,
        expiresAt: now + REPLY_TTL_MS,
      });
      return null;
    }

    await ctx.db.insert("mobile_app_replies", {
      ownerId,
      conversationId: args.conversationId,
      requestId: args.requestId,
      text: args.text,
      createdAt: now,
      expiresAt: now + REPLY_TTL_MS,
    });
    return null;
  },
});

export const getDesktopReply = internalQuery({
  args: {
    ownerId: v.string(),
    requestId: v.string(),
    nowMs: v.number(),
  },
  returns: v.union(
    v.null(),
    v.object({
      text: v.string(),
      createdAt: v.number(),
    }),
  ),
  handler: async (ctx, args) => {
    const reply = await ctx.db
      .query("mobile_app_replies")
      .withIndex("by_ownerId_and_requestId", (q) =>
        q.eq("ownerId", args.ownerId).eq("requestId", args.requestId),
      )
      .first();
    if (!reply || reply.expiresAt <= args.nowMs) {
      return null;
    }
    return {
      text: reply.text,
      createdAt: reply.createdAt,
    };
  },
});

export const deleteDesktopReply = internalMutation({
  args: {
    ownerId: v.string(),
    requestId: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const replies = await ctx.db
      .query("mobile_app_replies")
      .withIndex("by_ownerId_and_requestId", (q) =>
        q.eq("ownerId", args.ownerId).eq("requestId", args.requestId),
      )
      .take(10);
    for (const reply of replies) {
      await ctx.db.delete(reply._id);
    }
    return null;
  },
});

export const purgeExpired = internalMutation({
  args: {
    nowMs: v.optional(v.number()),
  },
  returns: v.number(),
  handler: async (ctx, args) => {
    const nowMs = args.nowMs ?? Date.now();
    const expired = await ctx.db
      .query("mobile_app_replies")
      .withIndex("by_expiresAt", (q) => q.lte("expiresAt", nowMs))
      .take(MAX_PURGE_BATCH);
    for (const reply of expired) {
      await ctx.db.delete(reply._id);
    }
    return expired.length;
  },
});
