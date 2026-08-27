import { internalMutation } from "./_generated/server";
import { internal } from "./_generated/api";
import { v } from "convex/values";
import { assertOwnerMigrationWriteAllowed } from "./auth";

// Read-aloud stream tickets. Mobile POSTs its (long) reply text once (see
// `tts_hls.startHlsSession`) and gets back a short-lived, owner-bound ticket so
// its native player can fetch the audio without the text ever hitting a URL.
// The HLS transport streams MP3 segments; the buffered range transport
// (`readTicket` + `cacheTicketAudio`) serves a whole `Range`-capable MP3 from
// the same ticket. Both are swept by the cron below.
const TICKET_PURGE_BATCH = 8;
const SEGMENT_PURGE_BATCH = 48;

const clampInt = (value, defaultValue, min, max) => {
  const n =
    typeof value === "number" && Number.isFinite(value)
      ? Math.floor(value)
      : defaultValue;
  return Math.max(min, Math.min(max, n));
};

// Reusable within its short TTL (owner-bound), NOT single-use: native players
// issue several (ranged) requests per playback, so all must resolve. Replay is
// bounded — same owner, same text, ≤2 minutes, prepare is rate-limited, and the
// cron sweeps it. An uncached ticket is claimed transactionally so ranged GETs
// cannot synthesize the same clip concurrently.
export const readTicket = internalMutation({
  args: {
    ticket: v.string(),
    ownerId: v.string(),
    ownerGeneration: v.string(),
    attemptId: v.string(),
    nowMs: v.number(),
  },
  returns: v.union(
    v.null(),
    v.object({
      state: v.string(),
      text: v.string(),
      voice: v.string(),
      model: v.string(),
      speed: v.union(v.number(), v.null()),
      conversationId: v.union(v.id("conversations"), v.null()),
      audio: v.union(v.string(), v.null()),
      ownerGeneration: v.string(),
    }),
  ),
  handler: async (ctx, args) => {
    await assertOwnerMigrationWriteAllowed(
      ctx,
      args.ownerId,
      args.ownerGeneration,
    );
    const row = await ctx.db
      .query("tts_stream_tickets")
      .withIndex("by_ticket", (q) => q.eq("ticket", args.ticket))
      .unique();
    if (!row) return null;
    if (
      row.ownerId !== args.ownerId ||
      (row.ownerGeneration ?? "legacy") !== args.ownerGeneration ||
      row.expiresAt <= args.nowMs
    ) {
      return null;
    }
    let state = "claimed";
    if (typeof row.audio === "string") {
      state = "cached";
    } else if (
      row.synthesisTransport === "hls" ||
      row.bufferTooLarge ||
      row.bufferStatus === "done" ||
      row.bufferStatus === "error"
    ) {
      state = "unavailable";
    } else if (
      row.bufferStatus === "synthesizing" &&
      (row.bufferLeaseExpiresAt ?? 0) > args.nowMs
    ) {
      state = "busy";
    } else {
      await ctx.db.patch(row._id, {
        bufferStatus: "synthesizing",
        bufferAttemptId: args.attemptId,
        bufferLeaseExpiresAt: row.expiresAt,
        synthesisTransport: "buffered",
      });
    }
    return {
      state,
      text: row.text,
      voice: row.voice,
      model: row.model,
      speed: typeof row.speed === "number" ? row.speed : null,
      conversationId: row.conversationId ?? null,
      audio: typeof row.audio === "string" ? row.audio : null,
      ownerGeneration: row.ownerGeneration ?? "legacy",
    };
  },
});

// Finish the exact buffered claim. Oversized clips are marked terminal instead
// of being re-synthesized for every follow-up range request.
export const finishTicketAudio = internalMutation({
  args: {
    ticket: v.string(),
    ownerId: v.string(),
    ownerGeneration: v.string(),
    attemptId: v.string(),
    audio: v.optional(v.string()),
    tooLarge: v.boolean(),
  },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    await assertOwnerMigrationWriteAllowed(
      ctx,
      args.ownerId,
      args.ownerGeneration,
    );
    const row = await ctx.db
      .query("tts_stream_tickets")
      .withIndex("by_ticket", (q) => q.eq("ticket", args.ticket))
      .unique();
    if (
      row &&
      row.ownerId === args.ownerId &&
      (row.ownerGeneration ?? "legacy") === args.ownerGeneration &&
      row.bufferStatus === "synthesizing" &&
      row.bufferAttemptId === args.attemptId
    ) {
      await ctx.db.patch(row._id, {
        ...(args.audio && !args.tooLarge ? { audio: args.audio } : {}),
        bufferStatus: "done",
        bufferTooLarge: args.tooLarge,
        bufferLeaseExpiresAt: undefined,
      });
      return true;
    }
    return false;
  },
});

// A failed provider call is terminal for this exact claim. Marking it avoids
// every ranged retry spending again while still fencing a stale action by its
// generation and attempt id.
export const failTicketAudio = internalMutation({
  args: {
    ticket: v.string(),
    ownerId: v.string(),
    ownerGeneration: v.string(),
    attemptId: v.string(),
  },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    await assertOwnerMigrationWriteAllowed(
      ctx,
      args.ownerId,
      args.ownerGeneration,
    );
    const row = await ctx.db
      .query("tts_stream_tickets")
      .withIndex("by_ticket", (q) => q.eq("ticket", args.ticket))
      .unique();
    if (
      !row ||
      row.ownerId !== args.ownerId ||
      (row.ownerGeneration ?? "legacy") !== args.ownerGeneration ||
      row.bufferStatus !== "synthesizing" ||
      row.bufferAttemptId !== args.attemptId
    ) {
      return false;
    }
    await ctx.db.patch(row._id, {
      bufferStatus: "error",
      bufferLeaseExpiresAt: undefined,
    });
    return true;
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
