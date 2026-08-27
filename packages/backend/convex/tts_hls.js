import {
  internalAction,
  internalMutation,
  internalQuery,
} from "./_generated/server";
import { internal } from "./_generated/api";
import { v } from "convex/values";
import {
  assertOwnerMigrationWriteAllowed,
  hasOwnerMigrationWriteFence,
} from "./auth";
import { acquireTtsProviderDispatchGuard } from "./lib/tts_dispatch_guard";

// ---------------------------------------------------------------------------
// Mobile HLS progressive read-aloud transport.
//
// Native players (AVPlayer/ExoPlayer) cannot progressively consume a chunked,
// length-less `audio/mpeg` stream — they need either a seekable resource or an
// HLS playlist. The buffered GET path solved the "seekable" case but only by
// synthesizing the WHOLE clip before serving any bytes, so audio never began
// until Inworld had finished generating.
//
// This module makes mobile genuinely progressive: `prepare` schedules ONE
// background synthesis (`synthesizeHls`) that streams Inworld once, cuts the
// CBR MP3 into short HLS "packed audio" segments as bytes arrive, and appends
// them to `tts_hls_segments`. The client plays a live `#EXT-X-PLAYLIST-TYPE:
// EVENT` playlist that grows as segments land, so the first segment is audible
// within a second — while Inworld is still generating the rest. The org key
// never leaves this action; provider spend is metered once to the internal
// ledger; a cooperative cancel beacon ends spend early on stop.
// ---------------------------------------------------------------------------

const INWORLD_TTS_STREAM_URL = "https://api.inworld.ai/tts/v1/voice:stream";

// HLS sessions live longer than the 2-minute buffered ticket because a long
// clip is played back in real time (a ~3-minute clip must still resolve its
// tail segments near the end of playback). Bounded and swept by the cron.
const HLS_TTL_MS = 15 * 60 * 1000;
// The upstream fetch is capped below this lease. A scheduled recovery may
// take over only after the old request has been forcibly aborted, so two
// attempts cannot cross the provider boundary concurrently.
const HLS_ACTION_LEASE_MS = 9 * 60 * 1000;
const MAX_TEXT_CHARS = 8000;

// Target segment length. Short enough that the first segment is audible almost
// immediately; long enough to keep per-segment overhead and playlist churn low.
const TARGET_SEGMENT_SEC = 2.0;
// Defensive ceilings so a runaway stream can't fill the table. ~600 segments of
// ~2 s ≈ 20 minutes of audio; the input cap makes this unreachable in practice.
const MAX_HLS_SEGMENTS = 600;
const MAX_TOTAL_AUDIO_BYTES = 24 * 1024 * 1024;
const MIGRATION_SEGMENT_DELETE_BATCH = 48;
const MIGRATION_TICKET_DELETE_BATCH = 8;

// ---------------------------------------------------------------------------
// Encoding helpers
// ---------------------------------------------------------------------------

const bytesToBase64 = (bytes) => {
  let binary = "";
  const step = 0x8000;
  for (let i = 0; i < bytes.length; i += step) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + step));
  }
  return btoa(binary);
};

const decodeBase64ToBytes = (b64) => {
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
  return out;
};

const concatBytes = (chunks) => {
  let total = 0;
  for (const c of chunks) total += c.length;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  return out;
};

// Pull the decoded MP3 bytes out of one Inworld NDJSON line.
const extractInworldAudioChunk = (line) => {
  let obj;
  try {
    obj = JSON.parse(line);
  } catch {
    return null;
  }
  const b64 =
    obj && obj.result && typeof obj.result.audioContent === "string"
      ? obj.result.audioContent
      : obj && typeof obj.audioContent === "string"
        ? obj.audioContent
        : null;
  if (!b64) return null;
  try {
    return decodeBase64ToBytes(b64);
  } catch {
    return null;
  }
};

// ---------------------------------------------------------------------------
// MP3 (MPEG audio Layer III) frame parsing
// ---------------------------------------------------------------------------

const MPEG1_L3_BITRATES = [
  0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 0,
];
const MPEG2_L3_BITRATES = [
  0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160, 0,
];
const SAMPLE_RATES = {
  1: [44100, 48000, 32000, 0],
  2: [22050, 24000, 16000, 0],
  2.5: [11025, 12000, 8000, 0],
};

// Parse the frame header at `i`. Returns { frameLen, durationSec } for a valid
// Layer III frame, or null when the bytes there are not a valid frame header.
const readFrame = (buf, i) => {
  if (i + 4 > buf.length) return null;
  if (buf[i] !== 0xff || (buf[i + 1] & 0xe0) !== 0xe0) return null;
  const versionBits = (buf[i + 1] >> 3) & 0x03;
  const layerBits = (buf[i + 1] >> 1) & 0x03;
  if (versionBits === 1) return null; // reserved MPEG version
  if (layerBits !== 1) return null; // require Layer III
  const version = versionBits === 3 ? "1" : versionBits === 2 ? "2" : "2.5";
  const bitrateIndex = (buf[i + 2] >> 4) & 0x0f;
  const srIndex = (buf[i + 2] >> 2) & 0x03;
  const padding = (buf[i + 2] >> 1) & 0x01;
  if (bitrateIndex === 0 || bitrateIndex === 15) return null;
  if (srIndex === 3) return null;
  const bitrateKbps =
    version === "1"
      ? MPEG1_L3_BITRATES[bitrateIndex]
      : MPEG2_L3_BITRATES[bitrateIndex];
  const sampleRate = SAMPLE_RATES[version][srIndex];
  if (!bitrateKbps || !sampleRate) return null;
  const samplesPerFrame = version === "1" ? 1152 : 576;
  const frameLen =
    Math.floor(((samplesPerFrame / 8) * bitrateKbps * 1000) / sampleRate) +
    padding;
  if (frameLen < 4) return null;
  return { frameLen, durationSec: samplesPerFrame / sampleRate };
};

// If `buf` begins with an ID3v2 tag, return the offset just past it (so leading
// metadata is skipped before frame alignment). Returns 0 when there is none or
// the tag is not yet fully buffered.
const id3v2Length = (buf) => {
  if (buf.length < 10) return 0;
  if (buf[0] !== 0x49 || buf[1] !== 0x44 || buf[2] !== 0x33) return 0; // "ID3"
  const size =
    ((buf[6] & 0x7f) << 21) |
    ((buf[7] & 0x7f) << 14) |
    ((buf[8] & 0x7f) << 7) |
    (buf[9] & 0x7f);
  const total = 10 + size;
  return total <= buf.length ? total : 0;
};

// ---------------------------------------------------------------------------
// ID3 transport-stream-timestamp tag (required for HLS packed audio)
// ---------------------------------------------------------------------------

const HLS_TS_OWNER = "com.apple.streaming.transportStreamTimestamp";

const syncsafe4 = (n) => [
  (n >>> 21) & 0x7f,
  (n >>> 14) & 0x7f,
  (n >>> 7) & 0x7f,
  n & 0x7f,
];

// An ID3v2.4 tag carrying a single PRIV frame with the 90 kHz MPEG-2 timestamp
// of the segment's first sample. Every HLS packed-audio (elementary MP3)
// segment MUST begin with this so the player can place it on the timeline.
const buildId3Timestamp = (startSec) => {
  const owner = new TextEncoder().encode(HLS_TS_OWNER);
  const body = new Uint8Array(owner.length + 1 + 8);
  body.set(owner, 0);
  body[owner.length] = 0x00;
  const ts = BigInt(Math.max(0, Math.round(startSec * 90000)));
  const dv = new DataView(body.buffer, owner.length + 1, 8);
  dv.setUint32(0, Number((ts >> 32n) & 0xffffffffn));
  dv.setUint32(4, Number(ts & 0xffffffffn));

  const frameHeader = new Uint8Array(10);
  frameHeader.set(new TextEncoder().encode("PRIV"), 0);
  // Frame body length (< 128, so synchsafe == plain here).
  frameHeader.set(syncsafe4(body.length), 4);

  const tagBodyLen = frameHeader.length + body.length;
  const tagHeader = new Uint8Array(10);
  tagHeader.set(new TextEncoder().encode("ID3"), 0);
  tagHeader[3] = 0x04; // ID3v2.4
  tagHeader.set(syncsafe4(tagBodyLen), 6);

  return concatBytes([tagHeader, frameHeader, body]);
};

// ---------------------------------------------------------------------------
// Mutations / queries
// ---------------------------------------------------------------------------

/**
 * Discard ephemeral read-aloud state on either side of an ownership migration.
 * These rows must never be transferred: a pending source scheduler callback
 * could regain provider authority when the migration fence is removed. Child
 * segment payloads drain before their parent ticket, in small fixed batches.
 */
export const discardOwnerTtsSessionsForMigrationInternal = internalMutation({
  args: { ownerId: v.string() },
  returns: v.object({
    ready: v.boolean(),
    deleted: v.number(),
    pending: v.union(
      v.literal(""),
      v.literal("segments"),
      v.literal("tickets"),
    ),
  }),
  handler: async (ctx, args) => {
    if (!(await hasOwnerMigrationWriteFence(ctx, args.ownerId))) {
      throw new Error(
        "TTS session discard requires an active owner migration fence.",
      );
    }
    const segments = await ctx.db
      .query("tts_hls_segments")
      .withIndex("by_ownerId_and_createdAt", (q) =>
        q.eq("ownerId", args.ownerId),
      )
      .take(MIGRATION_SEGMENT_DELETE_BATCH);
    if (segments.length > 0) {
      for (const row of segments) await ctx.db.delete(row._id);
      return {
        ready: false,
        deleted: segments.length,
        pending: "segments",
      };
    }
    const tickets = await ctx.db
      .query("tts_stream_tickets")
      .withIndex("by_ownerId_and_createdAt", (q) =>
        q.eq("ownerId", args.ownerId),
      )
      .take(MIGRATION_TICKET_DELETE_BATCH);
    if (tickets.length > 0) {
      for (const row of tickets) await ctx.db.delete(row._id);
      return {
        ready: false,
        deleted: tickets.length,
        pending: "tickets",
      };
    }
    return { ready: true, deleted: 0, pending: "" };
  },
});

// Create the HLS ticket row and schedule the single background synthesis. Used
// by the mobile `prepare` route in place of the buffered `storeTicket`.
export const startHlsSession = internalMutation({
  args: {
    ticket: v.string(),
    ownerId: v.string(),
    ownerGeneration: v.string(),
    providerDispatchId: v.optional(v.string()),
    text: v.string(),
    voice: v.string(),
    model: v.string(),
    speed: v.optional(v.number()),
    conversationId: v.optional(v.id("conversations")),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    await assertOwnerMigrationWriteAllowed(
      ctx,
      args.ownerId,
      args.ownerGeneration,
    );
    const now = Date.now();
    await ctx.db.insert("tts_stream_tickets", {
      ticket: args.ticket,
      ownerId: args.ownerId,
      ownerGeneration: args.ownerGeneration,
      ...(args.providerDispatchId
        ? { providerDispatchId: args.providerDispatchId.slice(0, 256) }
        : {}),
      text: args.text.slice(0, MAX_TEXT_CHARS),
      voice: args.voice,
      model: args.model,
      ...(typeof args.speed === "number" && Number.isFinite(args.speed)
        ? { speed: args.speed }
        : {}),
      ...(args.conversationId ? { conversationId: args.conversationId } : {}),
      createdAt: now,
      expiresAt: now + HLS_TTL_MS,
      hlsStatus: "pending",
      hlsSegments: [],
      hlsDone: false,
      bufferStatus: "pending",
    });
    await ctx.scheduler.runAfter(0, internal.tts_hls.synthesizeHls, {
      ticket: args.ticket,
      ownerId: args.ownerId,
      ownerGeneration: args.ownerGeneration,
    });
    return null;
  },
});

// Transactional single-winner claim. A duplicated scheduler delivery, an
// expired/canceled ticket, or an old owner generation never crosses the
// provider boundary.
export const claimHlsSynthesis = internalMutation({
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
      text: v.string(),
      voice: v.string(),
      model: v.string(),
      speed: v.union(v.number(), v.null()),
      conversationId: v.union(v.id("conversations"), v.null()),
      providerDispatchId: v.union(v.string(), v.null()),
      expiresAt: v.number(),
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
    const status = row?.hlsStatus ?? "pending";
    const recoverableClaim =
      status === "pending" ||
      (status === "synthesizing" &&
        (row?.hlsLeaseExpiresAt ?? 0) <= args.nowMs);
    if (
      !row ||
      row.ownerId !== args.ownerId ||
      (row.ownerGeneration ?? "legacy") !== args.ownerGeneration ||
      row.expiresAt <= args.nowMs ||
      row.hlsCanceledAt ||
      row.hlsDone ||
      row.synthesisTransport === "buffered" ||
      !recoverableClaim
    ) {
      return null;
    }
    await ctx.db.patch(row._id, {
      hlsStatus: "synthesizing",
      hlsAttemptId: args.attemptId,
      hlsLeaseExpiresAt: Math.min(
        row.expiresAt,
        args.nowMs + HLS_ACTION_LEASE_MS,
      ),
      synthesisTransport: "hls",
    });
    await ctx.scheduler.runAfter(
      HLS_ACTION_LEASE_MS,
      internal.tts_hls.synthesizeHls,
      {
        ticket: args.ticket,
        ownerId: args.ownerId,
        ownerGeneration: args.ownerGeneration,
      },
    );
    return {
      text: row.text,
      voice: row.voice,
      model: row.model,
      speed: typeof row.speed === "number" ? row.speed : null,
      conversationId: row.conversationId ?? null,
      providerDispatchId: row.providerDispatchId ?? null,
      expiresAt: row.expiresAt,
    };
  },
});

// Append one finished segment: store its audio in the side table and push its
// {seq,durationSec} onto the ticket's live manifest.
export const appendHlsSegment = internalMutation({
  args: {
    ticket: v.string(),
    ownerId: v.string(),
    ownerGeneration: v.string(),
    attemptId: v.string(),
    seq: v.number(),
    audio: v.string(),
    durationSec: v.number(),
  },
  returns: v.object({ accepted: v.boolean(), appended: v.boolean() }),
  handler: async (ctx, args) => {
    await assertOwnerMigrationWriteAllowed(
      ctx,
      args.ownerId,
      args.ownerGeneration,
    );
    const now = Date.now();
    const row = await ctx.db
      .query("tts_stream_tickets")
      .withIndex("by_ticket", (q) => q.eq("ticket", args.ticket))
      .unique();
    if (
      !row ||
      row.ownerId !== args.ownerId ||
      (row.ownerGeneration ?? "legacy") !== args.ownerGeneration ||
      row.hlsAttemptId !== args.attemptId ||
      row.hlsStatus !== "synthesizing" ||
      (row.hlsLeaseExpiresAt ?? 0) <= now ||
      row.hlsCanceledAt ||
      row.expiresAt <= now ||
      row.hlsDone
    ) {
      return { accepted: false, appended: false };
    }
    const existing = await ctx.db
      .query("tts_hls_segments")
      .withIndex("by_ticket_and_seq", (q) =>
        q.eq("ticket", args.ticket).eq("seq", args.seq),
      )
      .unique();
    if (existing) {
      const replayed =
        existing.ownerId === args.ownerId &&
        (existing.ownerGeneration ?? "legacy") === args.ownerGeneration &&
        existing.audio === args.audio &&
        existing.durationSec === args.durationSec;
      return { accepted: replayed, appended: false };
    }
    const segments = Array.isArray(row.hlsSegments) ? row.hlsSegments : [];
    if (segments.length >= MAX_HLS_SEGMENTS || args.seq >= MAX_HLS_SEGMENTS) {
      return { accepted: false, appended: false };
    }
    await ctx.db.insert("tts_hls_segments", {
      ticket: args.ticket,
      ownerId: args.ownerId,
      ownerGeneration: args.ownerGeneration,
      seq: args.seq,
      audio: args.audio,
      durationSec: args.durationSec,
      createdAt: now,
      expiresAt: row.expiresAt,
    });
    await ctx.db.patch(row._id, {
      hlsSegments: [
        ...segments,
        { seq: args.seq, durationSec: args.durationSec },
      ],
      hlsLeaseExpiresAt: Math.min(row.expiresAt, now + HLS_ACTION_LEASE_MS),
    });
    return { accepted: true, appended: true };
  },
});

export const finishHlsSession = internalMutation({
  args: {
    ticket: v.string(),
    ownerId: v.string(),
    ownerGeneration: v.string(),
    attemptId: v.string(),
    status: v.union(v.literal("done"), v.literal("error")),
  },
  returns: v.null(),
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
      row.hlsAttemptId === args.attemptId
    ) {
      await ctx.db.patch(row._id, {
        hlsStatus: args.status,
        hlsDone: true,
        hlsLeaseExpiresAt: undefined,
      });
    }
    return null;
  },
});

// Cooperative stop beacon: the client posts this on "stop"; the synthesis loop
// polls it and ends provider spend early (metered as interrupted).
export const cancelHlsSession = internalMutation({
  args: {
    ticket: v.string(),
    ownerId: v.string(),
    ownerGeneration: v.string(),
    nowMs: v.number(),
  },
  returns: v.null(),
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
      row.expiresAt > args.nowMs &&
      !row.hlsDone
    ) {
      await ctx.db.patch(row._id, { hlsCanceledAt: args.nowMs });
    }
    return null;
  },
});

export const readHlsCancelFlag = internalQuery({
  args: {
    ticket: v.string(),
    ownerId: v.string(),
    ownerGeneration: v.string(),
    attemptId: v.string(),
    nowMs: v.number(),
  },
  returns: v.union(v.null(), v.object({ canceled: v.boolean() })),
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
      row.hlsAttemptId !== args.attemptId ||
      row.hlsStatus !== "synthesizing" ||
      (row.hlsLeaseExpiresAt ?? 0) <= args.nowMs ||
      row.expiresAt <= args.nowMs
    ) {
      return null;
    }
    return { canceled: !!row.hlsCanceledAt };
  },
});

// Live playlist manifest for a ticket. Returns only {seq,durationSec} metadata,
// never segment audio. Owner-bound + TTL-checked.
export const readHlsPlaylist = internalQuery({
  args: {
    ticket: v.string(),
    ownerId: v.string(),
    ownerGeneration: v.string(),
    nowMs: v.number(),
  },
  returns: v.union(
    v.null(),
    v.object({
      status: v.union(
        v.literal("pending"),
        v.literal("synthesizing"),
        v.literal("done"),
        v.literal("error"),
      ),
      done: v.boolean(),
      segments: v.array(v.object({ seq: v.number(), durationSec: v.number() })),
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
    if (
      !row ||
      row.ownerId !== args.ownerId ||
      (row.ownerGeneration ?? "legacy") !== args.ownerGeneration ||
      row.expiresAt <= args.nowMs
    ) {
      return null;
    }
    return {
      status: row.hlsStatus ?? "pending",
      done: row.hlsDone === true,
      segments: Array.isArray(row.hlsSegments) ? row.hlsSegments : [],
    };
  },
});

export const readHlsSegment = internalQuery({
  args: {
    ticket: v.string(),
    ownerId: v.string(),
    ownerGeneration: v.string(),
    seq: v.number(),
    nowMs: v.number(),
  },
  returns: v.union(v.null(), v.object({ audio: v.string() })),
  handler: async (ctx, args) => {
    await assertOwnerMigrationWriteAllowed(
      ctx,
      args.ownerId,
      args.ownerGeneration,
    );
    const ticket = await ctx.db
      .query("tts_stream_tickets")
      .withIndex("by_ticket", (q) => q.eq("ticket", args.ticket))
      .unique();
    if (
      !ticket ||
      ticket.ownerId !== args.ownerId ||
      (ticket.ownerGeneration ?? "legacy") !== args.ownerGeneration ||
      ticket.expiresAt <= args.nowMs
    ) {
      return null;
    }
    const seg = await ctx.db
      .query("tts_hls_segments")
      .withIndex("by_ticket_and_seq", (q) =>
        q.eq("ticket", args.ticket).eq("seq", args.seq),
      )
      .unique();
    if (
      !seg ||
      seg.ownerId !== args.ownerId ||
      (seg.ownerGeneration ?? "legacy") !== args.ownerGeneration ||
      seg.expiresAt <= args.nowMs
    ) {
      return null;
    }
    return { audio: seg.audio };
  },
});

// ---------------------------------------------------------------------------
// Background synthesis action
// ---------------------------------------------------------------------------

export const synthesizeHls = internalAction({
  args: {
    ticket: v.string(),
    ownerId: v.string(),
    ownerGeneration: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const attemptId = crypto.randomUUID();
    const job = await ctx.runMutation(internal.tts_hls.claimHlsSynthesis, {
      ticket: args.ticket,
      ownerId: args.ownerId,
      ownerGeneration: args.ownerGeneration,
      attemptId,
      nowMs: Date.now(),
    });
    if (!job) return null;

    const inworldApiKey = process.env.INWORLD_API_KEY ?? null;
    const requestChars = job.text.length;
    const startedAt = Date.now();

    const dispatch = await acquireTtsProviderDispatchGuard(ctx, {
      ownerId: args.ownerId,
      ownerGeneration: args.ownerGeneration,
      dispatchId: job.providerDispatchId ?? `hls:${args.ticket}`,
      kind: "hls",
      usage: {
        provider: "inworld",
        model: job.model,
        voice: job.voice,
        ...(job.conversationId ? { conversationId: job.conversationId } : {}),
        streaming: true,
        requestChars,
      },
    });
    if (!dispatch) {
      await ctx.runMutation(internal.tts_hls.finishHlsSession, {
        ticket: args.ticket,
        ownerId: args.ownerId,
        ownerGeneration: args.ownerGeneration,
        attemptId,
        status: "error",
      });
      return null;
    }

    let providerMarked = false;
    let providerReachedEof = false;
    let providerResponseOk = false;
    let providerAudioBytes = 0;
    let providerDisposed = false;
    let hlsFinished = false;

    const usageSettlement = (ambiguous) => {
      const completed =
        !ambiguous && providerResponseOk && providerAudioBytes > 0;
      return {
        status: ambiguous
          ? providerAudioBytes > 0
            ? "partial"
            : "interrupted"
          : completed
            ? "completed"
            : "failed",
        // A clean provider EOF makes transport outcome knowable, but a 4xx or
        // 5xx does not prove the provider waived spend. Keep the full-request
        // estimate unless authoritative billed units say otherwise.
        synthesizedChars: ambiguous || providerReachedEof ? requestChars : 0,
        audioBytes: providerAudioBytes,
        durationMs: Date.now() - startedAt,
      };
    };

    // Provider settlement is deliberately independent from whether segment
    // publication succeeds. Once EOF is observed, provider work is settled;
    // publication failures may still leave the HLS session in an error state.
    const disposeProvider = async () => {
      if (providerDisposed) return;
      if (!providerMarked) {
        await dispatch.release({ outcome: "not_dispatched", abort: true });
      } else if (providerReachedEof) {
        await dispatch.release({
          outcome: "settled",
          settlement: usageSettlement(false),
        });
      } else {
        await dispatch.release({
          outcome: "may_have_dispatched",
          settlement: usageSettlement(true),
          abort: true,
        });
      }
      providerDisposed = true;
    };

    const finishHls = async (status) => {
      if (hlsFinished) return;
      await ctx.runMutation(internal.tts_hls.finishHlsSession, {
        ticket: args.ticket,
        ownerId: args.ownerId,
        ownerGeneration: args.ownerGeneration,
        attemptId,
        status,
      });
      hlsFinished = true;
    };

    try {
      if (!inworldApiKey) {
        await disposeProvider();
        await finishHls("error");
        return null;
      }

      let upstream;
      try {
        // This durable marker is the last awaited operation before fetch. From
        // this point onward, any missing response/body EOF is ambiguous spend.
        await dispatch.markMayHaveDispatched();
        providerMarked = true;
        upstream = await dispatch.race(
          fetch(INWORLD_TTS_STREAM_URL, {
            method: "POST",
            headers: {
              Authorization: `Bearer ${inworldApiKey}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              text: job.text,
              voiceId: job.voice,
              modelId: job.model,
              audioConfig: {
                audioEncoding: "MP3",
                ...(job.speed !== null ? { speakingRate: job.speed } : {}),
              },
            }),
            signal: dispatch.signal,
          }),
        );
        if (dispatch.signal.aborted) {
          throw (
            dispatch.signal.reason ??
            new Error("HLS provider dispatch was canceled.")
          );
        }
        providerResponseOk = upstream.ok;
      } catch (error) {
        console.error(
          "[voice/tts/hls] Failed to contact Inworld:",
          error && error.message ? error.message : String(error),
        );
        await disposeProvider();
        await finishHls("error");
        return null;
      }

      if (!upstream.ok) {
        try {
          if (upstream.body) {
            await dispatch.race(upstream.text(), (reason) =>
              upstream.body.cancel(reason),
            );
          }
          if (dispatch.signal.aborted) {
            throw (
              dispatch.signal.reason ??
              new Error("HLS provider dispatch was canceled.")
            );
          }
          providerReachedEof = true;
        } catch (error) {
          console.error(
            "[voice/tts/hls] Failed while consuming Inworld error response:",
            error && error.message ? error.message : String(error),
          );
        }
        console.error("[voice/tts/hls] Inworld TTS failed:", upstream.status);
        await disposeProvider();
        await finishHls("error");
        return null;
      }

      if (!upstream.body) {
        // A response with no body is already at EOF: provider outcome is known,
        // even though it produced no publishable audio.
        providerReachedEof = true;
        await disposeProvider();
        await finishHls("error");
        return null;
      }

      // The lifecycle can fence between the pre-fetch transaction and the
      // network response. Re-check before consuming or publishing any bytes.
      const dispatchStillLive = await ctx
        .runQuery(internal.tts_hls.readHlsCancelFlag, {
          ticket: args.ticket,
          ownerId: args.ownerId,
          ownerGeneration: args.ownerGeneration,
          attemptId,
          nowMs: Date.now(),
        })
        .catch(() => null);
      if (
        !dispatchStillLive ||
        dispatchStillLive.canceled ||
        !(await dispatch.checkAllowed())
      ) {
        await dispatch
          .race(upstream.body.cancel("HLS synthesis was canceled."), (reason) =>
            upstream.body.cancel(reason),
          )
          .catch(() => undefined);
        await disposeProvider();
        await finishHls("done");
        return null;
      }

      // ---- Streaming segmenter ------------------------------------------------
      const reader = upstream.body.getReader();
      const decoder = new TextDecoder();
      let textBuffer = "";
      let mp3 = new Uint8Array(0); // unparsed MP3 bytes
      let aligned = false;
      let segFrames = [];
      let segDuration = 0;
      let segStartSec = 0;
      let seq = 0;
      let capped = false;
      let publishedAudioBytes = 0;

      const flushSegment = async () => {
        if (segFrames.length === 0) return;
        if (!(await dispatch.checkAllowed())) {
          throw new Error("HLS provider dispatch was canceled.");
        }
        const segBytes = concatBytes([
          buildId3Timestamp(segStartSec),
          concatBytes(segFrames),
        ]);
        const appended = await ctx.runMutation(
          internal.tts_hls.appendHlsSegment,
          {
            ticket: args.ticket,
            ownerId: args.ownerId,
            ownerGeneration: args.ownerGeneration,
            attemptId,
            seq,
            audio: bytesToBase64(segBytes),
            durationSec: segDuration,
          },
        );
        if (!appended.accepted) {
          throw new Error(
            "HLS synthesis generation was canceled or superseded.",
          );
        }
        publishedAudioBytes += segBytes.length;
        segStartSec += segDuration;
        seq += 1;
        segFrames = [];
        segDuration = 0;
      };

      // Consume every whole frame currently buffered, flushing segments when they
      // reach the target duration. Leaves any trailing partial frame in `mp3`.
      const drainFrames = async () => {
        let cursor = 0;
        if (!aligned) {
          const skip = id3v2Length(mp3);
          if (skip > 0) cursor = skip;
        }
        for (;;) {
          if (
            seq >= MAX_HLS_SEGMENTS ||
            providerAudioBytes >= MAX_TOTAL_AUDIO_BYTES ||
            publishedAudioBytes >= MAX_TOTAL_AUDIO_BYTES
          ) {
            capped = true;
            break;
          }
          const frame = readFrame(mp3, cursor);
          if (!frame) {
            if (cursor + 4 > mp3.length) break; // need more bytes to decide
            if (aligned) break; // stay aligned; wait for the rest of this frame
            cursor += 1; // resync past leading junk
            continue;
          }
          if (cursor + frame.frameLen > mp3.length) break; // frame not fully in yet
          aligned = true;
          segFrames.push(mp3.slice(cursor, cursor + frame.frameLen));
          segDuration += frame.durationSec;
          cursor += frame.frameLen;
          if (segDuration >= TARGET_SEGMENT_SEC) await flushSegment();
        }
        mp3 = cursor > 0 ? mp3.slice(cursor) : mp3;
      };

      const ingest = async (bytes) => {
        if (bytes.length === 0) return;
        mp3 = mp3.length === 0 ? bytes : concatBytes([mp3, bytes]);
        await drainFrames();
      };

      const takeLine = async (line) => {
        const chunk = extractInworldAudioChunk(line);
        if (chunk && chunk.length > 0) {
          providerAudioBytes += chunk.length;
          await ingest(chunk);
        }
      };

      let canceled = false;
      let errored = false;
      try {
        for (;;) {
          const { done, value } = await dispatch.race(reader.read(), (reason) =>
            reader.cancel(reason),
          );
          if (done) {
            if (dispatch.signal.aborted) {
              throw (
                dispatch.signal.reason ??
                new Error("HLS provider dispatch was canceled.")
              );
            }
            providerReachedEof = true;
            break;
          }
          if (value) textBuffer += decoder.decode(value, { stream: true });
          let nl;
          while ((nl = textBuffer.indexOf("\n")) >= 0) {
            const line = textBuffer.slice(0, nl).trim();
            textBuffer = textBuffer.slice(nl + 1);
            if (line) await takeLine(line);
          }
          // Poll the cooperative stop beacon between network chunks.
          const flag = await ctx.runQuery(internal.tts_hls.readHlsCancelFlag, {
            ticket: args.ticket,
            ownerId: args.ownerId,
            ownerGeneration: args.ownerGeneration,
            attemptId,
            nowMs: Date.now(),
          });
          if (!flag || flag.canceled) {
            canceled = true;
            await dispatch
              .race(reader.cancel("HLS synthesis was canceled."), (reason) =>
                reader.cancel(reason),
              )
              .catch(() => undefined);
            break;
          }
          if (capped) {
            await dispatch
              .race(
                reader.cancel("HLS synthesis exceeded its safety cap."),
                (reason) => reader.cancel(reason),
              )
              .catch(() => undefined);
            break;
          }
        }
        if (providerReachedEof) {
          textBuffer += decoder.decode();
          const rest = textBuffer.trim();
          if (rest) await takeLine(rest);
        }
      } catch (error) {
        errored = true;
        if (!providerReachedEof) {
          await dispatch
            .race(reader.cancel(error), (reason) => reader.cancel(reason))
            .catch(() => undefined);
        }
        console.error(
          "[voice/tts/hls] Segment stream failed:",
          error && error.message ? error.message : String(error),
        );
      }

      // Never publish a trailing segment after cancellation, lifecycle fencing,
      // attempt supersession, provider failure, or a defensive size cap.
      if (providerReachedEof && !canceled && !capped) {
        try {
          await flushSegment();
        } catch {
          errored = true;
        }
      }

      const producedAudio = seq > 0;
      await disposeProvider();
      await finishHls(errored && !producedAudio ? "error" : "done");
      return null;
    } catch (error) {
      console.error(
        "[voice/tts/hls] Synthesis action failed:",
        error && error.message ? error.message : String(error),
      );
      await disposeProvider();
      await finishHls("error");
      return null;
    } finally {
      // Never let an exception erase the exact provider/billing disposition.
      // Retrying the same release is safe because settlement is receipt-bound.
      if (!providerDisposed) await disposeProvider();
    }
  },
});
