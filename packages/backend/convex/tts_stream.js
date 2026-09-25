import { internalMutation } from "./_generated/server";
import { internal } from "./_generated/api";
import { v } from "convex/values";

// Read-aloud stream tickets. Mobile POSTs its (long) reply text once (see
// `tts_hls.startHlsSession`) and gets back a short-lived, owner-bound ticket so
// its native player can stream the HLS audio without the text ever hitting a
// URL. Tickets and their segments are swept by the cron below.
const TICKET_PURGE_BATCH = 8;
const SEGMENT_PURGE_BATCH = 48;

const clampInt = (value, defaultValue, min, max) => {
  const n =
    typeof value === "number" && Number.isFinite(value)
      ? Math.floor(value)
      : defaultValue;
  return Math.max(min, Math.min(max, n));
};

export const purgeExpired = internalMutation({
  args: {
    nowMs: v.optional(v.number()),
    limit: v.optional(v.number()),
    maxBatches: v.optional(v.number()),
  },
  returns: v.number(),
  handler: async (ctx, args) => {
    const nowMs = args.nowMs ?? Date.now();
    const segmentLimit = clampInt(
      args.limit,
      SEGMENT_PURGE_BATCH,
      1,
      SEGMENT_PURGE_BATCH,
    );
    const ticketLimit = clampInt(
      args.limit,
      TICKET_PURGE_BATCH,
      1,
      TICKET_PURGE_BATCH,
    );
    const batchesLeft = clampInt(args.maxBatches, 1, 1, 10);

    let deleted = 0;
    // Child payloads always drain before their parent ticket. Segment rows can
    // carry large base64 values, so use a table-specific small read bound.
    const expiredSegments = await ctx.db
      .query("tts_hls_segments")
      .withIndex("by_expiresAt", (q) => q.lte("expiresAt", nowMs))
      .take(segmentLimit);
    for (const row of expiredSegments) {
      await ctx.db.delete(row._id);
      deleted += 1;
    }
    let hasMore = expiredSegments.length === segmentLimit;

    if (!hasMore) {
      const expiredTickets = await ctx.db
        .query("tts_stream_tickets")
        .withIndex("by_expiresAt", (q) => q.lte("expiresAt", nowMs))
        .take(ticketLimit);
      for (const row of expiredTickets) {
        await ctx.db.delete(row._id);
        deleted += 1;
      }
      hasMore = expiredTickets.length === ticketLimit;
    }

    if (hasMore && batchesLeft > 1) {
      await ctx.scheduler.runAfter(0, internal.tts_stream.purgeExpired, {
        nowMs,
        maxBatches: batchesLeft - 1,
      });
    }
    return deleted;
  },
});
