import { Mp3Encoder } from "@breezystack/lamejs";
import {
  DEFAULT_GEMINI_TTS_MODEL,
  DEFAULT_GEMINI_TTS_VOICE,
  isGeminiTtsVoice,
} from "@stella/contracts/realtime-voice-catalog";
import { Effect, Fiber } from "effect";
import { pickMediaProvider, type MediaProvider } from "../media/providers.js";

// ---------------------------------------------------------------------------
// Read-aloud synthesis with Gemini 3.8 Flash Lite TTS, on OpenRouter or fal.
//
// Both providers yield 16-bit mono PCM at 24 kHz (OpenRouter raw from
// `/audio/speech`, fal as a WAV file). Long text is split into sentence-sized
// chunks synthesized one ahead of playback. Every read-aloud transport (desktop
// progressive `audio/mpeg`, mobile HLS segments) is MP3, so callers re-encode
// the PCM with `createPcmMp3Encoder` as it arrives.
//
// OpenRouter is preferred when both keys are set: it answers in one hop
// (fal hands back a file to download) and bills Gemini's token rates (~$0.50/$6 per million) where fal bills $0.03 per
// thousand characters. `STELLA_MEDIA_PROVIDER` overrides the choice.
// ---------------------------------------------------------------------------

export const TTS_MODEL = `google/${DEFAULT_GEMINI_TTS_MODEL}`;
export const PCM_SAMPLE_RATE = 24_000;
const PCM_BYTES_PER_SECOND = PCM_SAMPLE_RATE * 2;
const MP3_KBPS = 48;
const OPENROUTER_SPEECH_URL = "https://openrouter.ai/api/v1/audio/speech";
const FAL_RUN_URL = `https://fal.run/${TTS_MODEL}`;
/** The first chunk ends at the first sentence past this, so audio starts quickly. */
const FIRST_CHUNK_MIN_CHARS = 40;
const FIRST_CHUNK_CHARS = 240;
const CHUNK_CHARS = 400;
/** Gemini TTS runs at under 2× realtime, so several chunks synthesize at once. */
const CHUNKS_IN_FLIGHT = 4;

// Billed audio tokens per second of speech. Google documents 25/s, but the
// API has been observed to report ~39/s; the estimate stays on the high side
// so internal spend is never underestimated.
const AUDIO_TOKENS_PER_SECOND_ESTIMATE = 40;

export type TtsProvider = MediaProvider;

/** The provider read-aloud uses on this deployment, with its key, or null when it is not set up. */
export const ttsProvider = (env: object) => pickMediaProvider(env, ["openrouter", "fal"]);

export const resolveGeminiTtsVoice = (voice: unknown): string =>
  typeof voice === "string" && isGeminiTtsVoice(voice.trim()) ? voice.trim() : DEFAULT_GEMINI_TTS_VOICE;

export type TtsUsage = {
  provider: TtsProvider;
  textInputTokens: number;
  audioOutputTokens: number;
  estimatedUsd: number;
};

/** What a synthesis cost, estimated from its text and PCM length (neither provider reports it inline). */
export const estimateTtsUsage = (provider: TtsProvider, requestChars: number, pcmBytes: number): TtsUsage => {
  const textInputTokens = Math.ceil(requestChars / 4);
  const audioOutputTokens = Math.ceil((pcmBytes / PCM_BYTES_PER_SECOND) * AUDIO_TOKENS_PER_SECOND_ESTIMATE);
  const estimatedUsd =
    provider === "fal"
      ? (requestChars / 1_000) * 0.03
      : (textInputTokens * 0.5 + audioOutputTokens * 6) / 1_000_000;
  return { provider, textInputTokens, audioOutputTokens, estimatedUsd: Number(estimatedUsd.toFixed(6)) };
};

// ── PCM sources ────────────────────────────────────────────────────────────

const openRouterSpeechChunk = async (
  apiKey: string,
  text: string,
  voice: string,
  signal: AbortSignal,
): Promise<Uint8Array> => {
  const response = await fetch(OPENROUTER_SPEECH_URL, {
    method: "POST",
    headers: {
      authorization: `Bearer ${apiKey}`,
      "content-type": "application/json",
      "HTTP-Referer": "https://stella.sh",
      "X-OpenRouter-Title": "Stella",
    },
    body: JSON.stringify({ model: TTS_MODEL, input: text, voice, response_format: "pcm" }),
    signal,
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(`OpenRouter TTS returned ${response.status}: ${detail.slice(0, 300)}`);
  }
  return new Uint8Array(await response.arrayBuffer());
};

/** Sentence-aligned chunks, the first one short so playback starts quickly. */
export const splitTtsText = (text: string): string[] => {
  const sentences = text.match(/[^.!?。！？\n]+(?:[.!?。！？]+|\n+|$)/gu) ?? [text];
  const chunks: string[] = [];
  let current = "";
  const flush = () => {
    if (current.trim()) chunks.push(current.trim());
    current = "";
  };
  for (const sentence of sentences) {
    const limit = chunks.length === 0 ? FIRST_CHUNK_CHARS : CHUNK_CHARS;
    if (current && current.length + sentence.length > limit) flush();
    current += sentence;
    while (current.length > CHUNK_CHARS) {
      const cut = current.lastIndexOf(" ", CHUNK_CHARS);
      const at = cut > CHUNK_CHARS / 2 ? cut : CHUNK_CHARS;
      chunks.push(current.slice(0, at).trim());
      current = current.slice(at);
    }
    if (chunks.length === 0 && current.trim().length >= FIRST_CHUNK_MIN_CHARS) flush();
  }
  flush();
  return chunks.filter((chunk) => chunk.length > 0);
};

/** The PCM samples of a WAV file, as 24 kHz mono 16-bit. */
export const wavToPcm24k = (wav: Uint8Array): Uint8Array => {
  const view = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);
  if (wav.byteLength < 12 || String.fromCharCode(...wav.slice(0, 4)) !== "RIFF") return wav;
  let offset = 12;
  let channels = 1;
  let sampleRate = PCM_SAMPLE_RATE;
  let bits = 16;
  while (offset + 8 <= wav.byteLength) {
    const id = String.fromCharCode(...wav.slice(offset, offset + 4));
    const size = view.getUint32(offset + 4, true);
    const body = offset + 8;
    if (id === "fmt ") {
      channels = view.getUint16(body + 2, true);
      sampleRate = view.getUint32(body + 4, true);
      bits = view.getUint16(body + 14, true);
    } else if (id === "data") {
      const end = Math.min(wav.byteLength, body + (size === 0xffffffff || size === 0 ? wav.byteLength : size));
      const data = wav.subarray(body, end);
      if (channels === 1 && sampleRate === PCM_SAMPLE_RATE && bits === 16) return data;
      if (bits !== 16) throw new Error(`Unsupported TTS WAV sample size ${bits}.`);
      const frames = Math.floor(data.byteLength / (2 * channels));
      const source = new DataView(data.buffer, data.byteOffset, data.byteLength);
      const outFrames = Math.floor((frames * PCM_SAMPLE_RATE) / sampleRate);
      const out = new Uint8Array(outFrames * 2);
      const outView = new DataView(out.buffer);
      for (let index = 0; index < outFrames; index += 1) {
        const frame = Math.min(frames - 1, Math.floor((index * sampleRate) / PCM_SAMPLE_RATE));
        let sum = 0;
        for (let channel = 0; channel < channels; channel += 1) sum += source.getInt16((frame * channels + channel) * 2, true);
        outView.setInt16(index * 2, Math.round(sum / channels), true);
      }
      return out;
    }
    offset = body + size + (size % 2);
  }
  throw new Error("TTS WAV had no data chunk.");
};

const falSpeechChunk = async (apiKey: string, text: string, voice: string, signal: AbortSignal): Promise<Uint8Array> => {
  const response = await fetch(FAL_RUN_URL, {
    method: "POST",
    headers: { authorization: `Key ${apiKey}`, "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ prompt: text, voice }),
    signal,
  });
  const raw = await response.text();
  if (!response.ok) throw new Error(`fal TTS returned ${response.status}: ${raw.slice(0, 300)}`);
  const url = (JSON.parse(raw) as { audio?: { url?: unknown } }).audio?.url;
  if (typeof url !== "string" || !url) throw new Error("fal TTS returned no audio.");
  const audio = await fetch(url, { signal });
  if (!audio.ok) throw new Error(`fal TTS audio download returned ${audio.status}.`);
  return wavToPcm24k(new Uint8Array(await audio.arrayBuffer()));
};

/** Each chunk synthesized in order, with the next few already in flight while one plays. */
const chunkedPcm = (
  chunks: string[],
  synthesize: (text: string) => Effect.Effect<Uint8Array, unknown>,
): ReadableStream<Uint8Array> => {
  let next = 0;
  const pending: Promise<Uint8Array>[] = [];
  const running: Fiber.Fiber<Uint8Array, unknown>[] = [];
  const stop = () => {
    next = chunks.length;
    pending.length = 0;
    const live = running.splice(0);
    if (live.length > 0) Effect.runFork(Fiber.interruptAll(live));
  };
  const fill = () => {
    while (pending.length < CHUNKS_IN_FLIGHT && next < chunks.length) {
      const fiber = Effect.runFork(synthesize(chunks[next++]!));
      running.push(fiber);
      const promise = Effect.runPromise(Fiber.join(fiber));
      promise.catch(() => stop());
      pending.push(promise);
    }
  };
  return new ReadableStream<Uint8Array>({
    start() {
      fill();
    },
    async pull(controller) {
      const current = pending.shift();
      if (!current) {
        controller.close();
        return;
      }
      const pcm = await current;
      fill();
      controller.enqueue(pcm);
    },
    cancel() {
      stop();
    },
  });
};

/**
 * 24 kHz mono 16-bit PCM for `text`, a sentence-sized chunk at a time.
 * Neither provider streams one request's audio progressively (OpenRouter
 * answers Gemini TTS whole), so a short first chunk is what gets audio
 * playing quickly. Throws when read-aloud is not set up or the provider
 * refuses the first chunk.
 */
export const openTtsPcm = async (
  env: object,
  args: { text: string; voice: string; signal: AbortSignal },
): Promise<{ provider: TtsProvider; pcm: ReadableStream<Uint8Array> }> => {
  const picked = ttsProvider(env);
  if (!picked) throw new Error("Read-aloud is not configured.");
  args.signal.throwIfAborted();
  const request = picked.provider === "openrouter" ? openRouterSpeechChunk : falSpeechChunk;
  const synthesize = (text: string) =>
    Effect.tryPromise({
      try: (interrupted) => request(picked.apiKey, text, args.voice, AbortSignal.any([args.signal, interrupted])),
      catch: (error) => error,
    });
  const reader = chunkedPcm(splitTtsText(args.text), synthesize).getReader();
  const first = await reader.read().catch(async (error: unknown) => {
    await reader.cancel(error).catch(() => undefined);
    throw error;
  });
  return {
    provider: picked.provider,
    pcm: new ReadableStream<Uint8Array>({
      start(controller) {
        if (first.done) controller.close();
        else controller.enqueue(first.value);
      },
      async pull(controller) {
        const { done, value } = await reader.read();
        if (done) controller.close();
        else controller.enqueue(value);
      },
      async cancel(reason) {
        await reader.cancel(reason).catch(() => undefined);
      },
    }),
  };
};

// ── Encoding ───────────────────────────────────────────────────────────────

const concat = (parts: Uint8Array[]): Uint8Array => {
  if (parts.length === 1) return parts[0]!;
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

const EMPTY = new Uint8Array(0);

/**
 * Incremental PCM → CBR MP3. Feed PCM bytes to `push` and forward whatever
 * MP3 bytes come back (possibly none until a full frame is ready); call
 * `finish` once at the end to flush the tail.
 */
export const createPcmMp3Encoder = () => {
  const encoder = new Mp3Encoder(1, PCM_SAMPLE_RATE, MP3_KBPS);
  let oddByte: number | null = null;
  let pcmBytes = 0;
  return {
    push(bytes: Uint8Array): Uint8Array {
      pcmBytes += bytes.length;
      let input = bytes;
      if (oddByte !== null) {
        input = concat([Uint8Array.of(oddByte), bytes]);
        oddByte = null;
      }
      const sampleCount = input.length >> 1;
      if (input.length % 2 === 1) oddByte = input[input.length - 1]!;
      if (sampleCount === 0) return EMPTY;
      const samples = new Int16Array(sampleCount);
      const view = new DataView(input.buffer, input.byteOffset, sampleCount * 2);
      for (let i = 0; i < sampleCount; i += 1) samples[i] = view.getInt16(i * 2, true);
      return new Uint8Array(encoder.encodeBuffer(samples));
    },
    finish(): Uint8Array {
      return new Uint8Array(encoder.flush());
    },
    get pcmBytes() {
      return pcmBytes;
    },
  };
};

/** A WAV file around 24 kHz mono 16-bit PCM. */
export const pcmToWav = (pcm: Uint8Array): Uint8Array => {
  const out = new Uint8Array(44 + pcm.byteLength);
  const view = new DataView(out.buffer);
  const ascii = (offset: number, value: string) => {
    for (let index = 0; index < value.length; index += 1) out[offset + index] = value.charCodeAt(index);
  };
  ascii(0, "RIFF");
  view.setUint32(4, 36 + pcm.byteLength, true);
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, PCM_SAMPLE_RATE, true);
  view.setUint32(28, PCM_BYTES_PER_SECOND, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  ascii(36, "data");
  view.setUint32(40, pcm.byteLength, true);
  out.set(pcm, 44);
  return out;
};
