/**
 * Speech to text through OpenRouter's transcription endpoint. The audio
 * arrives as a URL (inline sources were already staged in the media bucket),
 * is fetched here and sent as base64.
 */

const TRANSCRIPTIONS_URL = "https://openrouter.ai/api/v1/audio/transcriptions";
const MAX_AUDIO_BYTES = 25 * 1024 * 1024;
const TIMEOUT_MS = 60_000;

const FORMATS = new Set(["wav", "mp3", "flac", "m4a", "ogg", "webm", "aac"]);
const MIME_FORMATS: Record<string, string> = {
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

const formatFromMime = (value: string | null): string | null =>
  value ? (MIME_FORMATS[value.split(";")[0]!.trim().toLowerCase()] ?? null) : null;

const formatFromPath = (url: string): string | null => {
  try {
    const extension = new URL(url).pathname.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1];
    if (!extension) return null;
    const normalized = extension === "mpeg" ? "mp3" : extension === "mp4" ? "m4a" : extension;
    return FORMATS.has(normalized) ? normalized : null;
  } catch {
    return null;
  }
};

const formatFromBytes = (bytes: Uint8Array): string | null => {
  const header = String.fromCharCode(...bytes.slice(0, 4));
  if (header === "RIFF") return "wav";
  if (header === "fLaC") return "flac";
  if (header === "OggS") return "ogg";
  if (bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf) return "webm";
  if (bytes[4] === 0x66 && bytes[5] === 0x74 && bytes[6] === 0x79 && bytes[7] === 0x70) return "m4a";
  if (bytes[0] === 0x49 && bytes[1] === 0x44 && bytes[2] === 0x33) return "mp3";
  if (bytes[0] === 0xff && ((bytes[1] ?? 0) & 0xe0) === 0xe0) return "mp3";
  return null;
};

const bytesToBase64 = (bytes: Uint8Array): string => {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
};

export type SpeechToTextResult = { text: string; usage?: { seconds?: number; cost?: number } };

export const transcribe = async (
  apiKey: string,
  endpointId: string,
  input: Record<string, unknown>,
): Promise<SpeechToTextResult> => {
  const audioUrl = typeof input.audio_url === "string" ? input.audio_url.trim() : "";
  if (!audioUrl) throw new Error("audio_url is required.");
  const download = await fetch(audioUrl, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!download.ok) throw new Error(`Failed to download audio (${download.status}).`);
  const bytes = new Uint8Array(await download.arrayBuffer());
  if (bytes.byteLength === 0) throw new Error("Downloaded audio was empty.");
  if (bytes.byteLength > MAX_AUDIO_BYTES) throw new Error("Audio file exceeds the 25 MB transcription limit.");
  const format =
    formatFromMime(download.headers.get("content-type")) ?? formatFromPath(audioUrl) ?? formatFromBytes(bytes);
  if (!format) throw new Error("Could not determine the audio format of the source.");
  const language =
    (typeof input.language === "string" && input.language.trim()) ||
    (typeof input.language_code === "string" && input.language_code.trim()) ||
    undefined;
  const response = await fetch(TRANSCRIPTIONS_URL, {
    method: "POST",
    headers: {
      authorization: `Bearer ${apiKey}`,
      "content-type": "application/json",
      "HTTP-Referer": "https://stella.sh",
      "X-OpenRouter-Title": "Stella",
    },
    body: JSON.stringify({
      model: endpointId,
      input_audio: { data: bytesToBase64(bytes), format },
      ...(language ? { language } : {}),
    }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`OpenRouter transcription failed (${response.status}): ${text.slice(0, 400)}`);
  const body = JSON.parse(text) as { text?: unknown; usage?: { seconds?: unknown; cost?: unknown } };
  if (typeof body.text !== "string") throw new Error("OpenRouter transcription response was missing text.");
  const seconds = typeof body.usage?.seconds === "number" ? body.usage.seconds : undefined;
  const cost = typeof body.usage?.cost === "number" ? body.usage.cost : undefined;
  return {
    text: body.text,
    ...(seconds !== undefined || cost !== undefined
      ? { usage: { ...(seconds !== undefined ? { seconds } : {}), ...(cost !== undefined ? { cost } : {}) } }
      : {}),
  };
};
