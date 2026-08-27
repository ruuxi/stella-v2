import {
  internalAction,
  internalMutation,
  internalQuery,
} from "./_generated/server";
import { internal } from "./_generated/api";
import { v } from "convex/values";

const INWORLD_TTS_STREAM_URL = "https://api.inworld.ai/tts/v1/voice:stream";

const HLS_TTL_MS = 15 * 60 * 1000;
const MAX_TEXT_CHARS = 8000;

const TARGET_SEGMENT_SEC = 2.0;

const MAX_HLS_SEGMENTS = 600;
const MAX_TOTAL_AUDIO_BYTES = 24 * 1024 * 1024;

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

const readFrame = (buf, i) => {
  if (i + 4 > buf.length) return null;
  if (buf[i] !== 0xff || (buf[i + 1] & 0xe0) !== 0xe0) return null;
  const versionBits = (buf[i + 1] >> 3) & 0x03;
  const layerBits = (buf[i + 1] >> 1) & 0x03;
  if (versionBits === 1) return null;
  if (layerBits !== 1) return null;
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

const id3v2Length = (buf) => {
  if (buf.length < 10) return 0;
  if (buf[0] !== 0x49 || buf[1] !== 0x44 || buf[2] !== 0x33) return 0;
  const size =
    ((buf[6] & 0x7f) << 21) |
    ((buf[7] & 0x7f) << 14) |
    ((buf[8] & 0x7f) << 7) |
    (buf[9] & 0x7f);
  const total = 10 + size;
  return total <= buf.length ? total : 0;
};

const HLS_TS_OWNER = "com.apple.streaming.transportStreamTimestamp";

const syncsafe4 = (n) => [
  (n >>> 21) & 0x7f,
  (n >>> 14) & 0x7f,
  (n >>> 7) & 0x7f,
  n & 0x7f,
];

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

  frameHeader.set(syncsafe4(body.length), 4);

  const tagBodyLen = frameHeader.length + body.length;
  const tagHeader = new Uint8Array(10);
  tagHeader.set(new TextEncoder().encode("ID3"), 0);
  tagHeader[3] = 0x04;
  tagHeader.set(syncsafe4(tagBodyLen), 6);

  return concatBytes([tagHeader, frameHeader, body]);
};

export const startHlsSession = internalMutation({
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
      expiresAt: now + HLS_TTL_MS,
      hlsStatus: "pending",
      hlsSegments: [],
      hlsDone: false,
    });
    await ctx.scheduler.runAfter(0, internal.tts_hls.synthesizeHls, {
      ticket: args.ticket,
      ownerId: args.ownerId,
    });
    return null;
  },
});

export const readHlsJob = internalQuery({
  args: { ticket: v.string(), ownerId: v.string() },
  handler: async (ctx, args) => {
    const row = await ctx.db
      .query("tts_stream_tickets")
      .withIndex("by_ticket", (q) => q.eq("ticket", args.ticket))
      .unique();
    if (!row || row.ownerId !== args.ownerId) return null;
    return {
      text: row.text,
      voice: row.voice,
      model: row.model,
      speed: typeof row.speed === "number" ? row.speed : null,
      conversationId: row.conversationId ?? null,
      expiresAt: row.expiresAt,
    };
  },
});

export const markHlsSynthesizing = internalMutation({
  args: { ticket: v.string(), ownerId: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const row = await ctx.db
      .query("tts_stream_tickets")
      .withIndex("by_ticket", (q) => q.eq("ticket", args.ticket))
      .unique();
    if (row && row.ownerId === args.ownerId && !row.hlsDone) {
      await ctx.db.patch(row._id, { hlsStatus: "synthesizing" });
    }
    return null;
  },
});

export const appendHlsSegment = internalMutation({
  args: {
    ticket: v.string(),
    ownerId: v.string(),
    seq: v.number(),
    audio: v.string(),
    durationSec: v.number(),
    expiresAt: v.number(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const now = Date.now();
    await ctx.db.insert("tts_hls_segments", {
      ticket: args.ticket,
      ownerId: args.ownerId,
      seq: args.seq,
      audio: args.audio,
      durationSec: args.durationSec,
      createdAt: now,
      expiresAt: args.expiresAt,
    });
    const row = await ctx.db
      .query("tts_stream_tickets")
      .withIndex("by_ticket", (q) => q.eq("ticket", args.ticket))
      .unique();
    if (row && row.ownerId === args.ownerId) {
      const segments = Array.isArray(row.hlsSegments) ? row.hlsSegments : [];
      await ctx.db.patch(row._id, {
        hlsSegments: [
          ...segments,
          { seq: args.seq, durationSec: args.durationSec },
        ],
      });
    }
    return null;
  },
});

export const finishHlsSession = internalMutation({
  args: {
    ticket: v.string(),
    ownerId: v.string(),
    status: v.union(v.literal("done"), v.literal("error")),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const row = await ctx.db
      .query("tts_stream_tickets")
      .withIndex("by_ticket", (q) => q.eq("ticket", args.ticket))
      .unique();
    if (row && row.ownerId === args.ownerId) {
      await ctx.db.patch(row._id, { hlsStatus: args.status, hlsDone: true });
    }
    return null;
  },
});

export const cancelHlsSession = internalMutation({
  args: { ticket: v.string(), ownerId: v.string(), nowMs: v.number() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const row = await ctx.db
      .query("tts_stream_tickets")
      .withIndex("by_ticket", (q) => q.eq("ticket", args.ticket))
      .unique();
    if (row && row.ownerId === args.ownerId && row.expiresAt > args.nowMs) {
      await ctx.db.patch(row._id, { hlsCanceledAt: args.nowMs });
    }
    return null;
  },
});

export const readHlsCancelFlag = internalQuery({
  args: { ticket: v.string() },
  handler: async (ctx, args) => {
    const row = await ctx.db
      .query("tts_stream_tickets")
      .withIndex("by_ticket", (q) => q.eq("ticket", args.ticket))
      .unique();
    if (!row) return null;
    return { canceled: !!row.hlsCanceledAt };
  },
});

export const readHlsPlaylist = internalQuery({
  args: { ticket: v.string(), ownerId: v.string(), nowMs: v.number() },
  handler: async (ctx, args) => {
    const row = await ctx.db
      .query("tts_stream_tickets")
      .withIndex("by_ticket", (q) => q.eq("ticket", args.ticket))
      .unique();
    if (!row || row.ownerId !== args.ownerId || row.expiresAt <= args.nowMs) {
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
  args: { ticket: v.string(), ownerId: v.string(), seq: v.number() },
  handler: async (ctx, args) => {
    const seg = await ctx.db
      .query("tts_hls_segments")
      .withIndex("by_ticket_and_seq", (q) =>
        q.eq("ticket", args.ticket).eq("seq", args.seq),
      )
      .unique();
    if (!seg || seg.ownerId !== args.ownerId) return null;
    return { audio: seg.audio };
  },
});

export const synthesizeHls = internalAction({
  args: { ticket: v.string(), ownerId: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const job = await ctx.runQuery(internal.tts_hls.readHlsJob, {
      ticket: args.ticket,
      ownerId: args.ownerId,
    });
    if (!job) return null;

    const inworldApiKey = process.env.INWORLD_API_KEY ?? null;
    const requestChars = job.text.length;
    const startedAt = Date.now();
    const expiresAt = job.expiresAt;

    const usage = await ctx
      .runMutation(internal.billing.recordInternalTtsUsage, {
        ownerId: args.ownerId,
        provider: "inworld",
        model: job.model,
        voice: job.voice,
        ...(job.conversationId ? { conversationId: job.conversationId } : {}),
        streaming: true,
        status: "interrupted",
        requestChars,
        synthesizedChars: requestChars,
        audioBytes: 0,
        durationMs: 0,
      })
      .catch(() => null);
    const usageId = usage && usage.usageId ? usage.usageId : null;

    let audioBytes = 0;
    let recorded = false;
    const finalize = async (status) => {
      if (recorded || !usageId) return;
      recorded = true;
      const synthesizedChars = status === "failed" ? 0 : requestChars;
      await ctx
        .runMutation(internal.billing.finalizeInternalTtsUsage, {
          usageId,
          status,
          synthesizedChars,
          audioBytes,
          durationMs: Date.now() - startedAt,
        })
        .catch(() => undefined);
    };

    if (!inworldApiKey) {
      await finalize("failed");
      await ctx.runMutation(internal.tts_hls.finishHlsSession, {
        ticket: args.ticket,
        ownerId: args.ownerId,
        status: "error",
      });
      return null;
    }

    await ctx.runMutation(internal.tts_hls.markHlsSynthesizing, {
      ticket: args.ticket,
      ownerId: args.ownerId,
    });

    let upstream;
    try {
      upstream = await fetch(INWORLD_TTS_STREAM_URL, {
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
      });
    } catch (error) {
      console.error(
        "[voice/tts/hls] Failed to contact Inworld:",
        error && error.message ? error.message : String(error),
      );
      await finalize("failed");
      await ctx.runMutation(internal.tts_hls.finishHlsSession, {
        ticket: args.ticket,
        ownerId: args.ownerId,
        status: "error",
      });
      return null;
    }

    if (!upstream.ok || !upstream.body) {
      await upstream.text().catch(() => undefined);
      console.error("[voice/tts/hls] Inworld TTS failed:", upstream.status);
      await finalize("failed");
      await ctx.runMutation(internal.tts_hls.finishHlsSession, {
        ticket: args.ticket,
        ownerId: args.ownerId,
        status: "error",
      });
      return null;
    }

    const reader = upstream.body.getReader();
    const decoder = new TextDecoder();
    let textBuffer = "";
    let mp3 = new Uint8Array(0);
    let aligned = false;
    let segFrames = [];
    let segDuration = 0;
    let segStartSec = 0;
    let seq = 0;
    let capped = false;

    const flushSegment = async () => {
      if (segFrames.length === 0) return;
      const segBytes = concatBytes([
        buildId3Timestamp(segStartSec),
        concatBytes(segFrames),
      ]);
      await ctx.runMutation(internal.tts_hls.appendHlsSegment, {
        ticket: args.ticket,
        ownerId: args.ownerId,
        seq,
        audio: bytesToBase64(segBytes),
        durationSec: segDuration,
        expiresAt,
      });
      audioBytes += segBytes.length;
      segStartSec += segDuration;
      seq += 1;
      segFrames = [];
      segDuration = 0;
    };

    const drainFrames = async () => {
      let cursor = 0;
      if (!aligned) {
        const skip = id3v2Length(mp3);
        if (skip > 0) cursor = skip;
      }
      for (;;) {
        if (seq >= MAX_HLS_SEGMENTS || audioBytes >= MAX_TOTAL_AUDIO_BYTES) {
          capped = true;
          break;
        }
        const frame = readFrame(mp3, cursor);
        if (!frame) {
          if (cursor + 4 > mp3.length) break;
          if (aligned) break;
          cursor += 1;
          continue;
        }
        if (cursor + frame.frameLen > mp3.length) break;
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
      if (chunk && chunk.length > 0) await ingest(chunk);
    };

    let canceled = false;
    let errored = false;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) textBuffer += decoder.decode(value, { stream: true });
        let nl;
        while ((nl = textBuffer.indexOf("\n")) >= 0) {
          const line = textBuffer.slice(0, nl).trim();
          textBuffer = textBuffer.slice(nl + 1);
          if (line) await takeLine(line);
        }

        const flag = await ctx.runQuery(internal.tts_hls.readHlsCancelFlag, {
          ticket: args.ticket,
        });
        if (!flag || flag.canceled) {
          canceled = true;
          await reader.cancel().catch(() => undefined);
          break;
        }
        if (capped) {
          await reader.cancel().catch(() => undefined);
          break;
        }
      }
      if (!canceled && !capped) {
        textBuffer += decoder.decode();
        const rest = textBuffer.trim();
        if (rest) await takeLine(rest);
      }
    } catch (error) {
      errored = true;
      console.error(
        "[voice/tts/hls] Segment stream failed:",
        error && error.message ? error.message : String(error),
      );
    }

    await flushSegment().catch(() => undefined);

    const producedAudio = seq > 0;
    let status;
    if (canceled) status = "interrupted";
    else if (errored || capped) status = producedAudio ? "partial" : "failed";
    else status = producedAudio ? "completed" : "failed";

    await finalize(status);
    await ctx.runMutation(internal.tts_hls.finishHlsSession, {
      ticket: args.ticket,
      ownerId: args.ownerId,
      status: errored && !producedAudio ? "error" : "done",
    });
    return null;
  },
});
