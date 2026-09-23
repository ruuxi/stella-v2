import { Mp3Encoder } from "@breezystack/lamejs";
import {
  DEFAULT_GEMINI_TTS_MODEL,
  DEFAULT_GEMINI_TTS_VOICE,
  isGeminiTtsVoice,
} from "@stella/contracts/realtime-voice-catalog";

// ---------------------------------------------------------------------------
// Gemini TTS (Interactions API) for read-aloud.
//
// Streaming returns SSE events whose `step.delta` payloads carry headerless
// 16-bit little-endian mono PCM at 24 kHz. Every read-aloud transport
// (desktop progressive `audio/mpeg`, mobile HLS packed-audio segments) is
// MP3, so the stream pipeline re-encodes PCM to CBR MP3 as it arrives.
// Unary requests return a complete WAV.
// ---------------------------------------------------------------------------

export const GEMINI_TTS_MODEL = DEFAULT_GEMINI_TTS_MODEL;

const GEMINI_INTERACTIONS_URL =
  "https://generativelanguage.googleapis.com/v1beta/interactions";
const PCM_SAMPLE_RATE = 24_000;
const PCM_BYTES_PER_SECOND = PCM_SAMPLE_RATE * 2;
const MP3_KBPS = 48;

// Billed audio tokens per second of speech. Google documents 25/s, but the
// API has been observed to report ~39/s; the fallback estimate stays on the
// high side so internal spend is never underestimated.
const AUDIO_TOKENS_PER_SECOND_ESTIMATE = 40;
// Conservative speaking rate used to bound a request before any audio exists.
const ESTIMATED_CHARS_PER_SECOND = 12;

export const resolveGeminiTtsVoice = (voice: unknown): string =>
  typeof voice === "string" && isGeminiTtsVoice(voice.trim())
    ? voice.trim()
    : DEFAULT_GEMINI_TTS_VOICE;

export const buildGeminiTtsRequest = (args: {
  apiKey: string;
  text: string;
  voice: string;
  stream: boolean;
  signal?: AbortSignal;
}): [string, RequestInit] => [
  args.stream ? `${GEMINI_INTERACTIONS_URL}?alt=sse` : GEMINI_INTERACTIONS_URL,
  {
    method: "POST",
    headers: {
      "x-goog-api-key": args.apiKey,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: GEMINI_TTS_MODEL,
      input: [
        { type: "user_input", content: [{ type: "text", text: args.text }] },
      ],
      response_format: args.stream
        ? { type: "audio", mime_type: "audio/l16", sample_rate: PCM_SAMPLE_RATE }
        : { type: "audio", mime_type: "audio/wav" },
      generation_config: { speech_config: [{ voice: args.voice }] },
      ...(args.stream ? { stream: true } : {}),
    }),
    ...(args.signal ? { signal: args.signal } : {}),
  },
];

export type GeminiTtsUsage = {
  textInputTokens: number;
  audioOutputTokens: number;
};

const readUsage = (value: unknown): GeminiTtsUsage | null => {
  if (!value || typeof value !== "object") return null;
  const usage = value as {
    total_input_tokens?: unknown;
    total_output_tokens?: unknown;
    output_tokens_by_modality?: unknown;
  };
  const audio = Array.isArray(usage.output_tokens_by_modality)
    ? (usage.output_tokens_by_modality as Array<{
        modality?: unknown;
        tokens?: unknown;
      }>).find((entry) => entry?.modality === "audio")?.tokens
    : undefined;
  const audioOutputTokens =
    typeof audio === "number" ? audio : usage.total_output_tokens;
  if (typeof audioOutputTokens !== "number") return null;
  return {
    textInputTokens:
      typeof usage.total_input_tokens === "number"
        ? usage.total_input_tokens
        : 0,
    audioOutputTokens,
  };
};

/** Upper-bound token estimate recorded before a request is dispatched. */
export const estimateGeminiTtsUsage = (chars: number): GeminiTtsUsage => ({
  textInputTokens: Math.ceil(chars / 4),
  audioOutputTokens: Math.ceil(
    (chars / ESTIMATED_CHARS_PER_SECOND) * AUDIO_TOKENS_PER_SECOND_ESTIMATE,
  ),
});

/** Provider-reported usage when present, else an estimate from PCM length. */
export const resolveGeminiTtsUsage = (args: {
  reported: GeminiTtsUsage | null;
  requestChars: number;
  pcmBytes: number;
}): GeminiTtsUsage =>
  args.reported ?? {
    textInputTokens: Math.ceil(args.requestChars / 4),
    audioOutputTokens: Math.ceil(
      (args.pcmBytes / PCM_BYTES_PER_SECOND) * AUDIO_TOKENS_PER_SECOND_ESTIMATE,
    ),
  };

const decodeBase64 = (b64: string): Uint8Array => {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
};

const concat = (parts: Uint8Array[]): Uint8Array => {
  if (parts.length === 1) return parts[0];
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

type SseEvent =
  | { kind: "pcm"; bytes: Uint8Array }
  | { kind: "usage"; usage: GeminiTtsUsage }
  | { kind: "error"; message: string };

export const parseGeminiTtsSseEvent = (block: string): SseEvent | null => {
  const data = block
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trim())
    .join("\n");
  if (!data || data === "[DONE]") return null;
  let event: {
    event_type?: unknown;
    delta?: { data?: unknown } | null;
    interaction?: { status?: unknown; usage?: unknown } | null;
    error?: { message?: unknown } | null;
  };
  try {
    event = JSON.parse(data);
  } catch {
    return null;
  }
  if (event.error) {
    return {
      kind: "error",
      message:
        typeof event.error.message === "string"
          ? event.error.message
          : "Gemini TTS stream error",
    };
  }
  if (event.event_type === "step.delta" && typeof event.delta?.data === "string") {
    try {
      return { kind: "pcm", bytes: decodeBase64(event.delta.data) };
    } catch {
      return null;
    }
  }
  if (event.interaction?.status === "failed") {
    return { kind: "error", message: "Gemini TTS interaction failed" };
  }
  const usage = readUsage(event.interaction?.usage);
  return usage ? { kind: "usage", usage } : null;
};

/**
 * Incremental Gemini SSE → MP3 pipeline. Feed raw response bytes to `push`
 * and forward whatever MP3 bytes come back (possibly none until a full frame
 * is ready); call `finish` once at provider EOF to flush the tail.
 */
export const createGeminiTtsStreamPipeline = () => {
  const decoder = new TextDecoder();
  const encoder = new Mp3Encoder(1, PCM_SAMPLE_RATE, MP3_KBPS);
  let text = "";
  let oddByte: number | null = null;
  let pcmBytes = 0;
  let usage: GeminiTtsUsage | null = null;
  let error: string | null = null;

  const encodePcm = (bytes: Uint8Array): Uint8Array => {
    pcmBytes += bytes.length;
    let input = bytes;
    if (oddByte !== null) {
      input = concat([Uint8Array.of(oddByte), bytes]);
      oddByte = null;
    }
    const sampleCount = input.length >> 1;
    if (input.length % 2 === 1) oddByte = input[input.length - 1];
    if (sampleCount === 0) return EMPTY;
    const samples = new Int16Array(sampleCount);
    const view = new DataView(input.buffer, input.byteOffset, sampleCount * 2);
    for (let i = 0; i < sampleCount; i += 1) {
      samples[i] = view.getInt16(i * 2, true);
    }
    return new Uint8Array(encoder.encodeBuffer(samples));
  };

  const drain = (final: boolean): Uint8Array => {
    const out: Uint8Array[] = [];
    text = text.replace(/\r\n/g, "\n");
    let boundary: number;
    while ((boundary = text.indexOf("\n\n")) >= 0) {
      const block = text.slice(0, boundary);
      text = text.slice(boundary + 2);
      handle(block, out);
    }
    if (final && text.trim()) {
      handle(text, out);
      text = "";
    }
    return out.length === 0 ? EMPTY : concat(out);
  };

  const handle = (block: string, out: Uint8Array[]) => {
    const event = parseGeminiTtsSseEvent(block);
    if (!event) return;
    if (event.kind === "pcm") out.push(encodePcm(event.bytes));
    else if (event.kind === "usage") usage = event.usage;
    else error = event.message;
  };

  return {
    push(chunk: Uint8Array): Uint8Array {
      text += decoder.decode(chunk, { stream: true });
      return drain(false);
    },
    finish(): Uint8Array {
      text += decoder.decode();
      const tail = drain(true);
      return concat([tail, new Uint8Array(encoder.flush())]);
    },
    get pcmBytes() {
      return pcmBytes;
    },
    get usage() {
      return usage;
    },
    get error() {
      return error;
    },
  };
};

export type GeminiTtsStreamPipeline = ReturnType<
  typeof createGeminiTtsStreamPipeline
>;

/** Extract the WAV bytes and usage from a unary Interactions response. */
export const parseGeminiTtsUnaryResponse = (
  raw: string,
): { audio: Uint8Array; usage: GeminiTtsUsage | null } | null => {
  let parsed: {
    steps?: Array<{
      content?: Array<{ type?: unknown; data?: unknown }>;
    }>;
    usage?: unknown;
  };
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  for (const step of parsed.steps ?? []) {
    for (const part of step.content ?? []) {
      if (part.type === "audio" && typeof part.data === "string") {
        try {
          return {
            audio: decodeBase64(part.data),
            usage: readUsage(parsed.usage),
          };
        } catch {
          return null;
        }
      }
    }
  }
  return null;
};
