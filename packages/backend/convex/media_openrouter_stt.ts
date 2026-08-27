import { isRecord } from "./shared_validators";

export const OPENROUTER_PARAKEET_TDT_V3_ENDPOINT_ID =
  "nvidia/parakeet-tdt-0.6b-v3";
export const OPENROUTER_NEMOTRON_ASR_ENDPOINT_ID =
  "nvidia/nemotron-3.5-asr-streaming-multilingual-0.6b";

const OPENROUTER_TRANSCRIPTIONS_URL =
  "https://openrouter.ai/api/v1/audio/transcriptions";
const MAX_AUDIO_BYTES = 25 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 60_000;

const AUDIO_FORMATS = new Set([
  "wav",
  "mp3",
  "flac",
  "m4a",
  "ogg",
  "webm",
  "aac",
  "mp4",
]);

const MIME_TO_FORMAT: Record<string, string> = {
  "audio/wav": "wav",
  "audio/x-wav": "wav",
  "audio/wave": "wav",
  "audio/mpeg": "mp3",
  "audio/mp3": "mp3",
  "audio/flac": "flac",
  "audio/x-flac": "flac",
  "audio/mp4": "m4a",
  "audio/m4a": "m4a",
  "audio/x-m4a": "m4a",
  "audio/ogg": "ogg",
  "audio/opus": "ogg",
  "audio/webm": "webm",
  "audio/aac": "aac",
  "audio/x-aac": "aac",
};

const asTrimmedString = (value: unknown): string | null =>
  typeof value === "string" && value.trim().length > 0 ? value.trim() : null;

const extensionFromPath = (value: string): string | null => {
  try {
    const pathname = new URL(value).pathname.toLowerCase();
    const match = pathname.match(/\.([a-z0-9]+)$/);
    return match?.[1] ?? null;
  } catch {
    const match = value.toLowerCase().match(/\.([a-z0-9]+)(?:\?|#|$)/);
    return match?.[1] ?? null;
  }
};

const normalizeAudioFormat = (value: string | null | undefined): string | null => {
  if (!value) return null;
  const normalized = value.trim().toLowerCase().replace(/^\./, "");
  if (normalized === "mpeg") return "mp3";
  if (normalized === "wave") return "wav";
  if (AUDIO_FORMATS.has(normalized)) {
    return normalized === "mp4" ? "m4a" : normalized;
  }
  return MIME_TO_FORMAT[normalized] ?? null;
};

const formatFromMime = (value: string | null | undefined): string | null => {
  if (!value) return null;
  const mime = value.split(";")[0]?.trim().toLowerCase() ?? "";
  return MIME_TO_FORMAT[mime] ?? null;
};

const formatFromMagicBytes = (bytes: Uint8Array): string | null => {
  if (bytes.length >= 12) {
    const header = String.fromCharCode(...bytes.slice(0, 4));
    if (header === "RIFF") return "wav";
    if (header === "fLaC") return "flac";
    if (header === "OggS") return "ogg";
    if (
      header === "\x1aE\xdf\xa3" ||
      (bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf)
    ) {
      return "webm";
    }
    if (
      bytes[4] === 0x66 &&
      bytes[5] === 0x74 &&
      bytes[6] === 0x79 &&
      bytes[7] === 0x70
    ) {
      return "m4a";
    }
  }
  if (bytes.length >= 3 && bytes[0] === 0x49 && bytes[1] === 0x44 && bytes[2] === 0x33) {
    return "mp3";
  }
  if (bytes.length >= 2 && bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0) {
    return "mp3";
  }
  return null;
};

const parseDataUriAudio = (
  value: string,
): { data: string; format: string } => {
  const match = value.match(/^data:([^;,\s]+);base64,([A-Za-z0-9+/=\s]+)$/i);
  if (!match) {
    throw new Error("Audio data URI must be a base64 payload.");
  }
  const format =
    formatFromMime(match[1]) ??
    formatFromMagicBytes(
      Uint8Array.from(atob(match[2]!.replace(/\s+/g, "").slice(0, 24)), (char) =>
        char.charCodeAt(0),
      ),
    );
  if (!format) {
    throw new Error("Could not determine the audio format of the data URI.");
  }
  return { data: match[2]!.replace(/\s+/g, ""), format };
};

const bytesToBase64 = (bytes: Uint8Array): string => {
  const chunkSize = 0x2000;
  let binary = "";
  for (let index = 0; index < bytes.length; index += chunkSize) {
    const chunk = bytes.subarray(index, index + chunkSize);
    for (let offset = 0; offset < chunk.length; offset += 1) {
      binary += String.fromCharCode(chunk[offset]!);
    }
  }
  return btoa(binary);
};

const fetchAudioAsBase64 = async (
  url: string,
  signal?: AbortSignal,
): Promise<{ data: string; format: string }> => {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      signal: signal
        ? AbortSignal.any([controller.signal, signal])
        : controller.signal,
    });
    if (!response.ok) {
      throw new Error(`Failed to download audio (${response.status}).`);
    }
    const buffer = new Uint8Array(await response.arrayBuffer());
    if (buffer.byteLength === 0) {
      throw new Error("Downloaded audio was empty.");
    }
    if (buffer.byteLength > MAX_AUDIO_BYTES) {
      throw new Error("Audio file exceeds the 25 MB transcription limit.");
    }
    const format =
      formatFromMime(response.headers.get("content-type")) ??
      normalizeAudioFormat(extensionFromPath(url)) ??
      formatFromMagicBytes(buffer);
    if (!format) {
      throw new Error("Could not determine the audio format of the source URL.");
    }
    return { data: bytesToBase64(buffer), format };
  } catch (error) {
    if (controller.signal.aborted) {
      throw new Error("Timed out downloading audio for transcription.");
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
};

export const resolveOpenRouterAudioInput = async (
  audioUrl: string,
  signal?: AbortSignal,
): Promise<{ data: string; format: string }> => {
  const trimmed = audioUrl.trim();
  if (/^data:[^;,\s]+;base64,/i.test(trimmed)) {
    return parseDataUriAudio(trimmed);
  }
  return fetchAudioAsBase64(trimmed, signal);
};

export type OpenRouterSpeechToTextResult = {
  text: string;
  usage?: {
    seconds?: number;
    cost?: number;
    input_tokens?: number;
    output_tokens?: number;
    total_tokens?: number;
  };
};

export const transcribeOpenRouterSpeechToText = async (args: {
  apiKey: string;
  endpointId: string;
  input: Record<string, unknown>;
  signal?: AbortSignal;
}): Promise<OpenRouterSpeechToTextResult> => {
  const audioUrl = asTrimmedString(args.input.audio_url);
  if (!audioUrl) {
    throw new Error("audio_url is required.");
  }
  const audio = await resolveOpenRouterAudioInput(audioUrl, args.signal);
  const language =
    asTrimmedString(args.input.language) ??
    asTrimmedString(args.input.language_code);

  const upstream = await fetch(OPENROUTER_TRANSCRIPTIONS_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${args.apiKey}`,
      "Content-Type": "application/json",
      "HTTP-Referer": "https://stella.sh",
      "X-OpenRouter-Title": "Stella",
    },
    body: JSON.stringify({
      model: args.endpointId,
      input_audio: audio,
      ...(language ? { language } : {}),
    }),
    ...(args.signal ? { signal: args.signal } : {}),
  });
  const text = await upstream.text();
  if (!upstream.ok) {
    throw new Error(
      `OpenRouter transcription failed (${upstream.status}): ${text.slice(0, 400)}`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("OpenRouter returned a non-JSON transcription response.");
  }
  if (!isRecord(parsed) || typeof parsed.text !== "string") {
    throw new Error("OpenRouter transcription response was missing text.");
  }
  const usage = isRecord(parsed.usage) ? parsed.usage : undefined;
  const asFiniteNumber = (value: unknown): number | undefined =>
    typeof value === "number" && Number.isFinite(value) ? value : undefined;
  return {
    text: parsed.text,
    ...(usage
      ? {
          usage: {
            ...(asFiniteNumber(usage.seconds) !== undefined
              ? { seconds: asFiniteNumber(usage.seconds) }
              : {}),
            ...(asFiniteNumber(usage.cost) !== undefined
              ? { cost: asFiniteNumber(usage.cost) }
              : {}),
            ...(asFiniteNumber(usage.input_tokens) !== undefined
              ? { input_tokens: asFiniteNumber(usage.input_tokens) }
              : {}),
            ...(asFiniteNumber(usage.output_tokens) !== undefined
              ? { output_tokens: asFiniteNumber(usage.output_tokens) }
              : {}),
            ...(asFiniteNumber(usage.total_tokens) !== undefined
              ? { total_tokens: asFiniteNumber(usage.total_tokens) }
              : {}),
          },
        }
      : {}),
  };
};
