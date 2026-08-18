import { internalMutation } from "./_generated/server";
import { v } from "convex/values";

// Short-lived tickets that let mobile's native audio player GET a read-aloud
// stream whose (long) text was submitted by an earlier POST. Kept deliberately
// small: owner-bound, single-use, ~2 minute TTL, swept by a cron.
const TICKET_TTL_MS = 2 * 60 * 1000;
const MAX_TEXT_CHARS = 8000;
const MAX_PURGE_BATCH_LIMIT = 5000;

const clampInt = (value, defaultValue, min, max) => {
  const n =
    typeof value === "number" && Number.isFinite(value)
      ? Math.floor(value)
      : defaultValue;
  return Math.max(min, Math.min(max, n));
};

export const storeTicket = internalMutation({
  args: {
    ticket: v.string(),
    ownerId: v.string(),
    text: v.string(),
    voice: v.string(),
    model: v.string(),
    speed: v.optional(v.number()),
    conversationId: v.optional(v.id("conversations")),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const now = Date.now();
    await ctx.db.insert("tts_stream_tickets", {
      ticket: args.ticket,
      ownerId: args.ownerId,
      text: args.text.slice(0, MAX_TEXT_CHARS),
      voice: args.voice,
      model: args.model,
      ...(typeof args.speed === "number" && Number.isFinite(args.speed)
        ? { speed: args.speed }
        : {}),
      ...(args.conversationId ? { conversationId: args.conversationId } : {}),
      createdAt: now,
      expiresAt: now + TICKET_TTL_MS,
    });
    return null;
  },
});

// Single-use: the row is always deleted, whether or not it validates, so a
// ticket can never be replayed. Returns the synthesis params only when the
// ticket exists, is owned by the caller, and has not expired.
export const consumeTicket = internalMutation({
  args: {
    ticket: v.string(),
    ownerId: v.string(),
    nowMs: v.number(),
  },
  handler: async (ctx, args) => {
    const row = await ctx.db
      .query("tts_stream_tickets")
      .withIndex("by_ticket", (q) => q.eq("ticket", args.ticket))
      .unique();
    if (!row) return null;
    await ctx.db.delete(row._id);
    if (row.ownerId !== args.ownerId || row.expiresAt <= args.nowMs) {
      return null;
    }
    return {
      text: row.text,
      voice: row.voice,
      model: row.model,
      speed: typeof row.speed === "number" ? row.speed : null,
      conversationId: row.conversationId ?? null,
    };
  },
});

export const purgeExpired = internalMutation({
  args: {
    nowMs: v.optional(v.number()),
    limit: v.optional(v.number()),
    maxBatches: v.optional(v.number()),
  },
  returns: v.number(),
  handler: async (ctx, args) => {
    const nowMs = args.nowMs ?? Date.now();
    const limit = clampInt(args.limit, 500, 1, MAX_PURGE_BATCH_LIMIT);
    const maxBatches = clampInt(args.maxBatches, 10, 1, 50);

    let deleted = 0;
    for (let i = 0; i < maxBatches; i += 1) {
      const expired = await ctx.db
        .query("tts_stream_tickets")
        .withIndex("by_expiresAt", (q) => q.lte("expiresAt", nowMs))
        .take(limit);
      if (expired.length === 0) break;
      for (const row of expired) {
        await ctx.db.delete(row._id);
        deleted += 1;
      }
      if (expired.length < limit) break;
    }
    return deleted;
  },
});
