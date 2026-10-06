/**
 * OpenRouter's media APIs. Requests arrive in the catalog's fal-shaped input
 * (inline sources already staged as signed URLs) and are translated here:
 *
 * - images: `POST /images`, synchronous, base64 bytes back
 * - video:  `POST /videos`, then `GET /videos/<id>` until done; content is
 *           downloaded with the key (its URLs are not presigned)
 * - Seed audio: `POST /audio/speech`, raw MP3 bytes back
 * - Lyria music: `POST /chat/completions` streaming base64 audio deltas
 *
 * `usage.cost` (USD) is returned where OpenRouter reports it.
 */

import { GPT_IMAGE_2_ASPECT_PRESETS } from "./catalog.js";

const BASE = "https://openrouter.ai/api/v1";
const SUBMIT_TIMEOUT_MS = 30_000;
const IMAGE_TIMEOUT_MS = 5 * 60_000;
const SPEECH_TIMEOUT_MS = 3 * 60_000;
const MUSIC_TIMEOUT_MS = 5 * 60_000;

export class OpenRouterMediaError extends Error {
  /** OpenRouter refused the request outright; nothing ran or billed. */
  readonly definitive: boolean;
  constructor(message: string, definitive: boolean) {
    super(message);
    this.name = "OpenRouterMediaError";
    this.definitive = definitive;
  }
}

const headers = (apiKey: string): Record<string, string> => ({
  authorization: `Bearer ${apiKey}`,
  "content-type": "application/json",
  "HTTP-Referer": "https://stella.sh",
  "X-OpenRouter-Title": "Stella",
});

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const num = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;

const str = (value: unknown): string | null => (typeof value === "string" && value.trim() ? value.trim() : null);

const errorText = (status: number, body: string): string => {
  try {
    const parsed = JSON.parse(body) as { error?: { message?: unknown } | string; message?: unknown };
    const message =
      typeof parsed.error === "string"
        ? parsed.error
        : isRecord(parsed.error) && typeof parsed.error.message === "string"
          ? parsed.error.message
          : typeof parsed.message === "string"
            ? parsed.message
            : null;
    if (message) return `OpenRouter ${status}: ${message.slice(0, 400)}`;
  } catch {
    // Not JSON.
  }
  return `OpenRouter ${status}: ${body.slice(0, 400)}`;
};

const failure = async (response: Response): Promise<OpenRouterMediaError> =>
  new OpenRouterMediaError(
    errorText(response.status, await response.text().catch(() => "")),
    response.status >= 400 && response.status < 500 && response.status !== 408 && response.status !== 429,
  );

const base64ToBytes = (value: string): Uint8Array => {
  const binary = atob(value.replace(/\s+/g, ""));
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
};

const usageCost = (value: unknown): number | null => (isRecord(value) ? num(value.cost) : null);

const urls = (value: unknown): string[] =>
  (Array.isArray(value) ? value : value === undefined ? [] : [value]).filter(
    (entry): entry is string => typeof entry === "string" && entry.trim().length > 0,
  );

// ── Images ─────────────────────────────────────────────────────────────────

/** OpenRouter's GPT Image 2 takes an aspect ratio, not pixel sizes: the nearest preset. */
const aspectFor = (size: unknown): { aspect_ratio?: string } => {
  if (!isRecord(size)) return {};
  const width = num(size.width);
  const height = num(size.height);
  if (width === null || height === null || width <= 0 || height <= 0) return {};
  const ratio = Math.log(width / height);
  const [nearest] = Object.entries(GPT_IMAGE_2_ASPECT_PRESETS)
    .map(([name, dims]) => [name, Math.abs(Math.log(dims.width / dims.height) - ratio)] as const)
    .sort((a, b) => a[1] - b[1]);
  return nearest ? { aspect_ratio: nearest[0] } : {};
};

export type OpenRouterImage = { bytes: Uint8Array; contentType: string };

export const generateOpenRouterImages = async (
  apiKey: string,
  model: string,
  input: Record<string, unknown>,
): Promise<{ images: OpenRouterImage[]; cost: number | null }> => {
  if (input.mask_url !== undefined || input.mask_image_url !== undefined) {
    throw new OpenRouterMediaError("Masked image edits are only available on fal.", true);
  }
  const references = urls(input.image_urls);
  const quality = str(input.quality);
  const background = str(input.background);
  const count = num(input.num_images);
  const body = {
    model,
    prompt: input.prompt,
    ...(quality ? { quality } : {}),
    ...(count !== null && count > 1 ? { n: Math.min(10, Math.round(count)) } : {}),
    ...(background ? { background } : {}),
    ...aspectFor(input.image_size),
    ...(references.length > 0
      ? { input_references: references.map((url) => ({ type: "image_url", image_url: { url } })) }
      : {}),
  };
  const response = await fetch(`${BASE}/images`, {
    method: "POST",
    headers: headers(apiKey),
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(IMAGE_TIMEOUT_MS),
  });
  if (!response.ok) throw await failure(response);
  const data = (await response.json()) as {
    data?: Array<{ b64_json?: unknown; media_type?: unknown }>;
    usage?: unknown;
  };
  const images = (data.data ?? []).flatMap((entry) =>
    typeof entry.b64_json === "string" && entry.b64_json
      ? [
          {
            bytes: base64ToBytes(entry.b64_json),
            contentType: str(entry.media_type) ?? "image/png",
          },
        ]
      : [],
  );
  if (images.length === 0) throw new OpenRouterMediaError("OpenRouter returned no image.", false);
  return { images, cost: usageCost(data.usage) };
};

// ── Video ──────────────────────────────────────────────────────────────────

const VIDEO_RESOLUTIONS = new Set(["480p", "768p"]);

export const submitOpenRouterVideo = async (
  apiKey: string,
  model: string,
  input: Record<string, unknown>,
): Promise<{ id: string }> => {
  if (
    urls(input.reference_image_urls).length > 0 ||
    urls(input.reference_video_urls).length > 0 ||
    urls(input.reference_audio_urls).length > 0
  ) {
    throw new OpenRouterMediaError("Reference-guided video is only available on fal.", true);
  }
  const resolution = String(input.resolution ?? "768P").toLowerCase();
  if (!VIDEO_RESOLUTIONS.has(resolution)) {
    throw new OpenRouterMediaError(`Resolution ${String(input.resolution)} is only available on fal.`, true);
  }
  const first = str(input.image_url);
  const last = str(input.end_image_url);
  const duration = num(input.duration);
  const aspect = str(input.aspect_ratio);
  const body = {
    model,
    prompt: input.prompt,
    resolution,
    ...(duration !== null ? { duration: Math.round(duration) } : {}),
    ...(aspect ? { aspect_ratio: aspect } : {}),
    ...(first || last
      ? {
          frame_images: [
            ...(first ? [{ type: "image_url", image_url: { url: first }, frame_type: "first_frame" }] : []),
            ...(last ? [{ type: "image_url", image_url: { url: last }, frame_type: "last_frame" }] : []),
          ],
        }
      : {}),
  };
  const response = await fetch(`${BASE}/videos`, {
    method: "POST",
    headers: headers(apiKey),
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(SUBMIT_TIMEOUT_MS),
  });
  if (!response.ok) throw await failure(response);
  const data = (await response.json()) as { id?: unknown };
  const id = str(data.id);
  if (!id) throw new OpenRouterMediaError("OpenRouter accepted the video without an id.", false);
  return { id };
};

export type OpenRouterVideoOutcome =
  | { state: "pending"; running: boolean }
  | { state: "succeeded"; urls: string[]; cost: number | null }
  | { state: "failed"; message: string };

export const pollOpenRouterVideo = async (apiKey: string, id: string): Promise<OpenRouterVideoOutcome> => {
  const response = await fetch(`${BASE}/videos/${encodeURIComponent(id)}`, {
    headers: headers(apiKey),
    signal: AbortSignal.timeout(SUBMIT_TIMEOUT_MS),
  });
  if (!response.ok) {
    const error = await failure(response);
    if (response.status === 404) return { state: "failed", message: error.message };
    throw error;
  }
  const data = (await response.json()) as Record<string, unknown>;
  const status = String(data.status ?? "").toLowerCase();
  if (status === "completed") {
    const found = urls(data.unsigned_urls);
    return found.length > 0
      ? { state: "succeeded", urls: found, cost: usageCost(data.usage) }
      : { state: "failed", message: "OpenRouter finished the video without a file." };
  }
  if (status === "failed" || status === "cancelled" || status === "canceled" || status === "expired") {
    const error = data.error;
    return {
      state: "failed",
      message:
        str(error) ?? (isRecord(error) ? str(error.message) : null) ?? `OpenRouter video ${status || "failed"}.`,
    };
  }
  return { state: "pending", running: status === "in_progress" };
};

/** A file OpenRouter produced; its URLs need the key. */
export const downloadOpenRouterFile = async (apiKey: string, url: string): Promise<Response> => {
  const response = await fetch(url, {
    headers: { authorization: `Bearer ${apiKey}` },
    signal: AbortSignal.timeout(10 * 60_000),
  });
  if (!response.ok || !response.body) throw await failure(response);
  return response;
};

// ── Seed audio ─────────────────────────────────────────────────────────────

export const generateOpenRouterSpeech = async (
  apiKey: string,
  model: string,
  input: Record<string, unknown>,
): Promise<{ bytes: Uint8Array; contentType: string }> => {
  const audio = urls(input.audio_urls);
  const image = str(input.image_url);
  const voice = str(input.voice);
  const speed = num(input.speed);
  const body = {
    model,
    input: input.prompt,
    response_format: "mp3",
    ...(voice && audio.length === 0 && !image ? { voice } : {}),
    ...(speed !== null ? { speed } : {}),
    ...(audio.length > 0
      ? { input_references: audio.slice(0, 3).map((url) => ({ type: "input_audio", input_audio: { url } })) }
      : image
        ? { input_references: [{ type: "image_url", image_url: { url: image } }] }
        : {}),
  };
  const response = await fetch(`${BASE}/audio/speech`, {
    method: "POST",
    headers: headers(apiKey),
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(SPEECH_TIMEOUT_MS),
  });
  if (!response.ok) throw await failure(response);
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength === 0) throw new OpenRouterMediaError("OpenRouter returned empty audio.", false);
  return { bytes, contentType: response.headers.get("content-type")?.split(";")[0]?.trim() || "audio/mpeg" };
};

// ── Lyria music ────────────────────────────────────────────────────────────

const sniffAudio = (bytes: Uint8Array): string => {
  const head = String.fromCharCode(...bytes.slice(0, 4));
  if (head === "RIFF") return "audio/wav";
  if (head === "OggS") return "audio/ogg";
  if (head === "fLaC") return "audio/flac";
  if (bytes[4] === 0x66 && bytes[5] === 0x74 && bytes[6] === 0x79 && bytes[7] === 0x70) return "audio/mp4";
  return "audio/mpeg";
};

export const generateOpenRouterMusic = async (
  apiKey: string,
  model: string,
  prompt: string,
): Promise<{ bytes: Uint8Array; mimeType: string; textParts: string[]; cost: number | null }> => {
  const response = await fetch(`${BASE}/chat/completions`, {
    method: "POST",
    headers: headers(apiKey),
    body: JSON.stringify({
      model,
      messages: [{ role: "user", content: prompt }],
      modalities: ["text", "audio"],
      stream: true,
      usage: { include: true },
    }),
    signal: AbortSignal.timeout(MUSIC_TIMEOUT_MS),
  });
  if (!response.ok || !response.body) throw await failure(response);
  const decoder = new TextDecoder();
  const reader = response.body.getReader();
  const audio: string[] = [];
  const text: string[] = [];
  let cost: number | null = null;
  let streamError: string | null = null;
  let buffer = "";
  const handle = (line: string) => {
    if (!line.startsWith("data:")) return;
    const data = line.slice(5).trim();
    if (!data || data === "[DONE]") return;
    let chunk: Record<string, unknown>;
    try {
      chunk = JSON.parse(data) as Record<string, unknown>;
    } catch {
      return;
    }
    if (chunk.error) {
      streamError =
        str(chunk.error) ?? (isRecord(chunk.error) ? str(chunk.error.message) : null) ?? "OpenRouter music failed.";
    }
    cost = usageCost(chunk.usage) ?? cost;
    const choice = Array.isArray(chunk.choices) ? (chunk.choices[0] as Record<string, unknown> | undefined) : undefined;
    const delta = isRecord(choice?.delta) ? choice.delta : {};
    if (isRecord(delta.audio)) {
      if (typeof delta.audio.data === "string") audio.push(delta.audio.data);
      if (typeof delta.audio.transcript === "string") text.push(delta.audio.transcript);
    }
    if (typeof delta.content === "string") text.push(delta.content);
  };
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) handle(line.trim());
  }
  handle((buffer + decoder.decode()).trim());
  if (audio.length === 0) throw new OpenRouterMediaError(streamError ?? "OpenRouter returned no music audio.", false);
  const bytes = base64ToBytes(audio.join(""));
  const joined = text
    .join("")
    .split("\n")
    .filter((line) => !/^\s*\[\[[^\]]*\]\]\s*$/u.test(line))
    .join("\n")
    .trim();
  return {
    bytes,
    mimeType: sniffAudio(bytes),
    textParts: joined ? [joined.slice(0, 2_048)] : [],
    cost,
  };
};
