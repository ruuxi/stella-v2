import { v } from "convex/values";
import {
  internalMutation,
  internalQuery,
  mutation,
  query,
  type MutationCtx,
} from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import { getConnectedUserIdOrNull, requireConnectedUserId } from "./auth";
import {
  enforceMutationRateLimit,
  RATE_HOT_PATH,
} from "./lib/rate_limits";

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

// ─── Public reactive surface (mobile React subscription) ─────────────────
// The mobile app subscribes to `watchDesktopReply` for the active
// `requestId` it just submitted. The desktop publishes its reply into
// `mobile_app_replies` via `publishDesktopReply` (called from the
// connector_delivery dispatcher), the subscription notifies the phone,
// the phone renders the text and calls `acknowledgeDesktopReply` to
// delete the row immediately. Rows that are never acked still age out
// via `REPLY_TTL_MS` + the `purgeExpired` cron, so message bodies live
// in Convex for seconds in the happy path and at most ~2 minutes in
// the worst case.

export const watchDesktopReply = query({
  args: { requestId: v.string() },
  returns: v.union(
    v.null(),
    v.object({
      text: v.string(),
      createdAt: v.number(),
    }),
  ),
  handler: async (ctx, args) => {
    const ownerId = await getConnectedUserIdOrNull(ctx);
    if (!ownerId) return null;
    // `expiresAt` is not consulted here — the cron purges expired rows
    // and the query stays deterministic per the no-Date.now-in-queries
    // rule. The mobile client's acknowledge mutation removes the row
    // immediately after render.
    const reply = await ctx.db
      .query("mobile_app_replies")
      .withIndex("by_ownerId_and_requestId", (q) =>
        q.eq("ownerId", ownerId).eq("requestId", args.requestId),
      )
      .first();
    if (!reply) return null;
    return { text: reply.text, createdAt: reply.createdAt };
  },
});

export const acknowledgeDesktopReply = mutation({
  args: { requestId: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const ownerId = await requireConnectedUserId(ctx);
    await enforceMutationRateLimit(
      ctx,
      "mobile_replies_acknowledge",
      ownerId,
      RATE_HOT_PATH,
    );
    const replies = await ctx.db
      .query("mobile_app_replies")
      .withIndex("by_ownerId_and_requestId", (q) =>
        q.eq("ownerId", ownerId).eq("requestId", args.requestId),
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
