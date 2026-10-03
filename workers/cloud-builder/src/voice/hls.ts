/**
 * Mobile read-aloud over HLS. Native players (AVPlayer, ExoPlayer) cannot
 * play a length-less `audio/mpeg` stream, so one synthesis streams Gemini,
 * re-encodes its PCM to MP3, cuts it into ~2 s packed-audio segments and
 * writes each to `MEDIA` at `tts/<ticket>/seg-<n>.mp3`, updating
 * `tts/<ticket>/index.json` after every segment. The playlist route reads
 * that manifest, so the first segment plays while Gemini is still speaking.
 * A bucket lifecycle rule deletes `tts/` after a day.
 */

import {
  buildGeminiTtsRequest,
  createGeminiTtsStreamPipeline,
  resolveGeminiTtsUsage,
  type GeminiTtsUsage,
} from "./gemini-tts.js";
import { ttsObjectKey } from "./ticket.js";

/** Short enough that the first segment plays almost at once. */
const TARGET_SEGMENT_SEC = 2.0;
const MAX_SEGMENTS = 600;
const MAX_AUDIO_BYTES = 24 * 1024 * 1024;
/** Bounds the provider stream; well past what 8,000 characters take. */
const SYNTHESIS_TIMEOUT_MS = 9 * 60_000;
export const HLS_TARGET_DURATION = 3;

export type HlsManifest = {
  /** Segment durations in seconds, in order. */
  segments: number[];
  done: boolean;
  error: boolean;
};

export const HLS_MANIFEST_FILE = "index.json";
export const hlsSegmentFile = (n: number): string => `seg-${n}.mp3`;

/** A live EVENT playlist: segments are only appended, ENDLIST once done. */
export const buildHlsPlaylist = (manifest: HlsManifest): string => {
  const lines = [
    "#EXTM3U",
    "#EXT-X-VERSION:3",
    "#EXT-X-PLAYLIST-TYPE:EVENT",
    `#EXT-X-TARGETDURATION:${HLS_TARGET_DURATION}`,
    "#EXT-X-MEDIA-SEQUENCE:0",
  ];
  manifest.segments.forEach((duration, n) => {
    lines.push(`#EXTINF:${(Number.isFinite(duration) ? duration : 0).toFixed(3)},`);
    lines.push(hlsSegmentFile(n));
  });
  if (manifest.done) lines.push("#EXT-X-ENDLIST");
  return `${lines.join("\n")}\n`;
};

// ── MP3 frames ────────────────────────────────────────────────────────────

const MPEG1_L3_BITRATES = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 0];
const MPEG2_L3_BITRATES = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160, 0];
const SAMPLE_RATES: Record<"1" | "2" | "2.5", number[]> = {
  "1": [44100, 48000, 32000, 0],
  "2": [22050, 24000, 16000, 0],
  "2.5": [11025, 12000, 8000, 0],
};

/** The Layer III frame header at `i`, or null when there is none there. */
const readFrame = (buf: Uint8Array, i: number): { frameLen: number; durationSec: number } | null => {
  if (i + 4 > buf.length) return null;
  if (buf[i] !== 0xff || (buf[i + 1]! & 0xe0) !== 0xe0) return null;
  const versionBits = (buf[i + 1]! >> 3) & 0x03;
  const layerBits = (buf[i + 1]! >> 1) & 0x03;
  if (versionBits === 1 || layerBits !== 1) return null;
  const version = versionBits === 3 ? "1" : versionBits === 2 ? "2" : "2.5";
  const bitrateIndex = (buf[i + 2]! >> 4) & 0x0f;
  const srIndex = (buf[i + 2]! >> 2) & 0x03;
  const padding = (buf[i + 2]! >> 1) & 0x01;
  if (bitrateIndex === 0 || bitrateIndex === 15 || srIndex === 3) return null;
  const bitrateKbps = (version === "1" ? MPEG1_L3_BITRATES : MPEG2_L3_BITRATES)[bitrateIndex]!;
  const sampleRate = SAMPLE_RATES[version][srIndex]!;
  if (!bitrateKbps || !sampleRate) return null;
  const samplesPerFrame = version === "1" ? 1152 : 576;
  const frameLen = Math.floor(((samplesPerFrame / 8) * bitrateKbps * 1000) / sampleRate) + padding;
  if (frameLen < 4) return null;
  return { frameLen, durationSec: samplesPerFrame / sampleRate };
};

/** Bytes of a leading ID3v2 tag, once fully buffered; else 0. */
const id3v2Length = (buf: Uint8Array): number => {
  if (buf.length < 10 || buf[0] !== 0x49 || buf[1] !== 0x44 || buf[2] !== 0x33) return 0;
  const size = ((buf[6]! & 0x7f) << 21) | ((buf[7]! & 0x7f) << 14) | ((buf[8]! & 0x7f) << 7) | (buf[9]! & 0x7f);
  const total = 10 + size;
  return total <= buf.length ? total : 0;
};

const concat = (parts: Uint8Array[]): Uint8Array => {
  let total = 0;
  for (const part of parts) total += part.length;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
};

const syncsafe4 = (n: number) => [(n >>> 21) & 0x7f, (n >>> 14) & 0x7f, (n >>> 7) & 0x7f, n & 0x7f];

/**
 * The ID3v2.4 PRIV tag with the 90 kHz timestamp of a segment's first
 * sample. Every HLS packed-audio segment must begin with one.
 */
const id3Timestamp = (startSec: number): Uint8Array => {
  const owner = new TextEncoder().encode("com.apple.streaming.transportStreamTimestamp");
  const body = new Uint8Array(owner.length + 1 + 8);
  body.set(owner, 0);
  const ts = BigInt(Math.max(0, Math.round(startSec * 90000)));
  const view = new DataView(body.buffer, owner.length + 1, 8);
  view.setUint32(0, Number((ts >> 32n) & 0xffffffffn));
  view.setUint32(4, Number(ts & 0xffffffffn));
  const frameHeader = new Uint8Array(10);
  frameHeader.set(new TextEncoder().encode("PRIV"), 0);
  frameHeader.set(syncsafe4(body.length), 4);
  const tagHeader = new Uint8Array(10);
  tagHeader.set(new TextEncoder().encode("ID3"), 0);
  tagHeader[3] = 0x04;
  tagHeader.set(syncsafe4(frameHeader.length + body.length), 6);
  return concat([tagHeader, frameHeader, body]);
};

// ── Synthesis ─────────────────────────────────────────────────────────────

export type HlsSynthesisResult = {
  status: "done" | "error" | "canceled";
  segments: number;
  usage: GeminiTtsUsage;
};

/**
 * Stream one synthesis into `MEDIA`. Never throws: every failure ends with a
 * manifest marked `error` (or `done` with what was published) so the player
 * stops waiting.
 */
export const synthesizeHls = async (input: {
  bucket: R2Bucket;
  apiKey: string;
  ticket: string;
  text: string;
  voice: string;
  /** Polled between provider chunks; true stops synthesis early. */
  canceled: () => boolean;
}): Promise<HlsSynthesisResult> => {
  const manifest: HlsManifest = { segments: [], done: false, error: false };
  const writeManifest = () =>
    input.bucket.put(ttsObjectKey(input.ticket, HLS_MANIFEST_FILE), JSON.stringify(manifest), {
      httpMetadata: { contentType: "application/json" },
    });
  const pipeline = createGeminiTtsStreamPipeline();
  const usage = () =>
    resolveGeminiTtsUsage({ reported: pipeline.usage, requestChars: input.text.length, pcmBytes: pipeline.pcmBytes });
  const finish = async (status: HlsSynthesisResult["status"]): Promise<HlsSynthesisResult> => {
    manifest.done = true;
    manifest.error = status === "error" && manifest.segments.length === 0;
    await writeManifest().catch(() => undefined);
    return { status, segments: manifest.segments.length, usage: usage() };
  };

  const signal = AbortSignal.timeout(SYNTHESIS_TIMEOUT_MS);
  let upstream: Response;
  try {
    upstream = await fetch(
      ...buildGeminiTtsRequest({ apiKey: input.apiKey, text: input.text, voice: input.voice, stream: true, signal }),
    );
  } catch {
    return await finish("error");
  }
  if (!upstream.ok || !upstream.body) {
    await upstream.body?.cancel().catch(() => undefined);
    console.error(JSON.stringify({ event: "tts_hls_provider_failed", status: upstream.status }));
    return await finish("error");
  }

  let mp3: Uint8Array = new Uint8Array(0);
  let aligned = false;
  let frames: Uint8Array[] = [];
  let duration = 0;
  let startSec = 0;
  let audioBytes = 0;
  let capped = false;

  const flush = async () => {
    if (frames.length === 0) return;
    const bytes = concat([id3Timestamp(startSec), ...frames]);
    await input.bucket.put(ttsObjectKey(input.ticket, hlsSegmentFile(manifest.segments.length)), bytes, {
      httpMetadata: { contentType: "audio/mpeg" },
    });
    manifest.segments.push(duration);
    await writeManifest();
    startSec += duration;
    frames = [];
    duration = 0;
  };

  const ingest = async (bytes: Uint8Array) => {
    if (bytes.length === 0) return;
    audioBytes += bytes.length;
    mp3 = mp3.length === 0 ? bytes : concat([mp3, bytes]);
    let cursor = aligned ? 0 : id3v2Length(mp3);
    for (;;) {
      if (manifest.segments.length >= MAX_SEGMENTS || audioBytes >= MAX_AUDIO_BYTES) {
        capped = true;
        break;
      }
      const frame = readFrame(mp3, cursor);
      if (!frame) {
        if (cursor + 4 > mp3.length || aligned) break;
        cursor += 1;
        continue;
      }
      if (cursor + frame.frameLen > mp3.length) break;
      aligned = true;
      frames.push(mp3.slice(cursor, cursor + frame.frameLen));
      duration += frame.durationSec;
      cursor += frame.frameLen;
      if (duration >= TARGET_SEGMENT_SEC) await flush();
    }
    mp3 = cursor > 0 ? mp3.slice(cursor) : mp3;
  };

  const reader = upstream.body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) await ingest(pipeline.push(value));
      if (input.canceled() || capped) {
        await reader.cancel().catch(() => undefined);
        return await finish(capped ? "done" : "canceled");
      }
    }
    await ingest(pipeline.finish());
    if (pipeline.error) {
      console.error(JSON.stringify({ event: "tts_hls_stream_error", message: pipeline.error }));
    }
    if (!capped) await flush();
    return await finish(manifest.segments.length > 0 ? "done" : "error");
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    console.error(JSON.stringify({
      event: "tts_hls_failed",
      message: error instanceof Error ? error.message : String(error),
    }));
    return await finish("error");
  }
};
