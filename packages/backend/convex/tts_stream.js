import { internalMutation } from "./_generated/server";
import { v } from "convex/values";

const MAX_PURGE_BATCH_LIMIT = 5000;

const clampInt = (value, defaultValue, min, max) => {
  const n =
    typeof value === "number" && Number.isFinite(value)
      ? Math.floor(value)
      : defaultValue;
  return Math.max(min, Math.min(max, n));
};

export const readTicket = internalMutation({
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
    if (row.ownerId !== args.ownerId || row.expiresAt <= args.nowMs) {
      return null;
    }
    return {
      text: row.text,
      voice: row.voice,
      model: row.model,
      speed: typeof row.speed === "number" ? row.speed : null,
      conversationId: row.conversationId ?? null,
      audio: typeof row.audio === "string" ? row.audio : null,
    };
  },
});

export const cacheTicketAudio = internalMutation({
  args: {
    ticket: v.string(),
    ownerId: v.string(),
    audio: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const row = await ctx.db
      .query("tts_stream_tickets")
      .withIndex("by_ticket", (q) => q.eq("ticket", args.ticket))
      .unique();
    if (row && row.ownerId === args.ownerId && !row.audio) {
      await ctx.db.patch(row._id, { audio: args.audio });
    }
    return null;
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

    for (let i = 0; i < maxBatches; i += 1) {
      const expiredSegments = await ctx.db
        .query("tts_hls_segments")
        .withIndex("by_expiresAt", (q) => q.lte("expiresAt", nowMs))
        .take(limit);
      if (expiredSegments.length === 0) break;
      for (const row of expiredSegments) {
        await ctx.db.delete(row._id);
        deleted += 1;
      }
      if (expiredSegments.length < limit) break;
    }
    return deleted;
  },
});
