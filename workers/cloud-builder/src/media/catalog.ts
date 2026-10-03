/**
 * The managed media catalog: what each capability runs on, how a request's
 * convenience fields map onto the provider's input, which plan surface it
 * needs, and what a finished job costs. Ported from the Convex modules
 * `media_catalog.ts`, `media_billing.ts`, `media_image_limits.ts` and the
 * request normalization in `http_routes/media.ts`.
 */

import type {
  MediaCapability,
  MediaGenerateRequest,
  MediaSourceReference,
} from "@stella/contracts/backend/media";
import type { Capability } from "@stella/contracts/capabilities";
import { parseMusicRequest } from "./lyria.js";

export const MEDIA_DOCS_URL = "https://stella.sh/docs/media";

const falModelUrl = (endpointId: string): string => `https://fal.ai/models/${endpointId}/api`;

export const MEDIA_CAPABILITIES: MediaCapability[] = [
  {
    id: "speech_to_text",
    name: "Speech To Text",
    description: "Transcribe spoken audio into text.",
    category: "audio",
    provider: "openrouter",
    endpointId: "nvidia/nemotron-3.5-asr-streaming-multilingual-0.6b",
    docsUrl: "https://openrouter.ai/nvidia/nemotron-3.5-asr-streaming-multilingual-0.6b",
    sourceUrlKey: "audio_url",
    inputHints: ["audio_url"],
    outputHints: ["text"],
  },
  {
    id: "audio_generation",
    name: "Audio Generation",
    description: "Generate speech, dialogue, sound effects, or ambient audio from text.",
    category: "audio",
    provider: "fal",
    endpointId: "bytedance/seed-audio-1.0",
    docsUrl: falModelUrl("bytedance/seed-audio-1.0"),
    promptKey: "prompt",
    inputHints: [
      "prompt (reference clips inline as @Audio1, @Audio2, @Audio3)",
      "voice (preset voice id)",
      "audio_urls (up to 3 reference clips for voice cloning)",
      "image_url (single reference image; cannot combine with audio refs)",
      "output_format (wav | mp3 | pcm | ogg_opus)",
      "sample_rate (8000-48000 Hz)",
      "speed | volume | pitch",
    ],
    outputHints: ["audio file URL"],
  },
  {
    id: "text_to_music",
    name: "Text To Music",
    description: "Generate short music clips from weighted text prompts.",
    category: "audio",
    provider: "google_lyria",
    endpointId: "google/lyria-3-pro-preview",
    docsUrl: "https://ai.google.dev/gemini-api/docs/music-generation",
    promptKey: "prompt",
    inputHints: [
      "prompt",
      "weightedPrompts",
      "musicGenerationConfig",
      "promptLabel",
      "musicGenerationMode (VOCALIZATION for sung elements)",
    ],
    outputHints: ["audio file"],
  },
  {
    id: "text_to_image",
    name: "Text To Image",
    description: "Generate still images from text prompts.",
    category: "image",
    provider: "fal",
    endpointId: "openai/gpt-image-2",
    docsUrl: falModelUrl("openai/gpt-image-2"),
    promptKey: "prompt",
    supportsAspectRatio: true,
    inputHints: [
      "prompt",
      "aspectRatio (mapped to image_size)",
      "quality (low | medium | high; defaults to low)",
      "num_images (1-4)",
      "output_format (png | jpeg | webp)",
    ],
    outputHints: ["image URLs"],
  },
  {
    id: "image_edit",
    name: "Image Edit",
    description: "Edit an existing image with text instructions.",
    category: "image",
    provider: "fal",
    endpointId: "openai/gpt-image-2/edit",
    docsUrl: falModelUrl("openai/gpt-image-2/edit"),
    promptKey: "prompt",
    sourceUrlKey: "image_urls",
    requiresSourceUrl: true,
    supportsAspectRatio: true,
    inputHints: [
      "image_urls",
      "prompt",
      "aspectRatio (mapped to image_size; defaults to auto)",
      "quality (low | medium | high; defaults to low)",
      "num_images (1-4)",
      "mask_url (optional)",
    ],
    outputHints: ["edited image URLs"],
  },
  {
    id: "audio_visual_separate",
    name: "Audio Visual Separate",
    description: "Separate or isolate audio using the visual track for guidance.",
    category: "analysis",
    provider: "fal",
    endpointId: "fal-ai/sam-audio/visual-separate",
    docsUrl: falModelUrl("fal-ai/sam-audio/visual-separate"),
    inputHints: ["video_url", "audio_url", "separation controls"],
    outputHints: ["separated stems / tracks"],
  },
  {
    id: "text_to_video",
    name: "Text To Video",
    description: "Generate a video from a text prompt.",
    category: "video",
    provider: "fal",
    endpointId: "minimax/h3-max/text-to-video",
    docsUrl: falModelUrl("minimax/h3-max/text-to-video"),
    promptKey: "prompt",
    supportsAspectRatio: true,
    inputHints: [
      "prompt",
      "aspectRatio",
      "duration (5-15 seconds)",
      "resolution (480P | 768P)",
      "prompt_expansion_mode (balanced | quality)",
    ],
    outputHints: ["video URL"],
  },
  {
    id: "image_to_video",
    name: "Image To Video",
    description: "Animate a still image into a generated video.",
    category: "video",
    provider: "fal",
    endpointId: "minimax/h3-max/image-to-video",
    docsUrl: falModelUrl("minimax/h3-max/image-to-video"),
    promptKey: "prompt",
    sourceUrlKey: "image_url",
    requiresSourceUrl: true,
    supportsAspectRatio: true,
    inputHints: [
      "image_url",
      "end_image_url (optional final-frame reference)",
      "prompt",
      "aspectRatio",
      "duration (5-15 seconds)",
      "resolution (480P | 768P)",
      "prompt_expansion_mode (balanced | quality)",
    ],
    outputHints: ["video URL"],
  },
  {
    id: "reference_to_video",
    name: "Reference To Video",
    description: "Generate a video guided by reference images, video clips, and optional audio.",
    category: "video",
    provider: "fal",
    endpointId: "minimax/h3-max/reference-to-video",
    docsUrl: falModelUrl("minimax/h3-max/reference-to-video"),
    promptKey: "prompt",
    sourceUrlKey: "reference_video_urls",
    supportsAspectRatio: true,
    inputHints: [
      "reference_image_urls",
      "reference_video_urls",
      "reference_audio_urls",
      "prompt",
      "aspectRatio",
      "duration (5-15 seconds)",
      "resolution (480P | 768P)",
      "prompt_expansion_mode (balanced | quality)",
    ],
    outputHints: ["video URL"],
  },
  {
    id: "text_to_3d",
    name: "Text To 3D",
    description: "Generate a production-ready 3D asset from text.",
    category: "3d",
    provider: "fal",
    endpointId: "fal-ai/hunyuan-3d/v3.1/pro/text-to-3d",
    docsUrl: falModelUrl("fal-ai/hunyuan-3d/v3.1/pro/text-to-3d"),
    promptKey: "prompt",
    inputHints: ["prompt", "generate_type (Normal | Geometry)", "face_count (40000-1500000)", "enable_pbr"],
    outputHints: ["GLB / OBJ 3D asset URLs"],
  },
];

export const getMediaCapability = (id: string): MediaCapability | null =>
  MEDIA_CAPABILITIES.find((capability) => capability.id === id) ?? null;

/** The plan surface a capability needs; analysis and transcription stay open. */
export const planCapabilityFor = (capability: MediaCapability): Capability | null => {
  switch (capability.category) {
    case "image":
      return "image_generation";
    case "video":
      return "video_generation";
    case "3d":
      return "three_d_generation";
    case "audio":
      return capability.id === "speech_to_text" ? null : "audio_generation";
    default:
      return null;
  }
};

// ── Request normalization ────────────────────────────────────────────────

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const nonEmpty = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0;

const isHttpUrl = (value: unknown): value is string => {
  if (!nonEmpty(value)) return false;
  try {
    const url = new URL(value.trim());
    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
};

export const isDataUri = (value: unknown): value is string =>
  nonEmpty(value) && /^data:[^;,\s]+;base64,/i.test(value);

const isSourceReference = (value: unknown): value is string => isHttpUrl(value) || isDataUri(value);

const toDataUri = (source: MediaSourceReference): string =>
  typeof source === "string"
    ? source.trim()
    : `data:${source.mimeType};base64,${source.base64.replace(/^data:[^;,\s]+;base64,/i, "").replace(/\s+/g, "")}`;

const SOURCE_SLOT_ALIASES: Record<string, string> = {
  image: "image_url",
  video: "video_url",
  audio: "audio_url",
  reference_image: "reference_image_urls",
  reference_video: "reference_video_urls",
  reference_audio: "reference_audio_urls",
  mask_image: "mask_image_url",
};

const REFERENCE_VIDEO_SLOT_ALIASES: Record<string, string> = {
  image: "reference_image_urls",
  video: "reference_video_urls",
  audio: "reference_audio_urls",
};

/** GPT Image 2 sizes per aspect ratio (multiples of 16, inside its envelope). */
const GPT_IMAGE_2_ASPECT_PRESETS: Record<string, { width: number; height: number }> = {
  "1:1": { width: 1024, height: 1024 },
  "4:3": { width: 1024, height: 768 },
  "3:4": { width: 768, height: 1024 },
  "3:2": { width: 1152, height: 768 },
  "2:3": { width: 768, height: 1152 },
  "16:9": { width: 1280, height: 720 },
  "9:16": { width: 720, height: 1280 },
  "21:9": { width: 1344, height: 576 },
};

const DEFAULT_MUSIC_CONFIG = { bpm: 95, density: 0.5, brightness: 0.5, guidance: 4, temperature: 1 };

/** The provider input a request asks for, before inline sources are staged. */
export const providerInput = (
  capability: MediaCapability,
  request: MediaGenerateRequest,
): Record<string, unknown> => {
  const input: Record<string, unknown> = { ...(request.input ?? {}) };
  if ((capability.id === "text_to_image" || capability.id === "image_edit") && input.quality === undefined) {
    input.quality = "low";
  }
  if (capability.category === "video") {
    input.duration ??= 5;
    input.resolution ??= "768P";
    input.prompt_expansion_mode ??= "balanced";
  }
  if (request.prompt && capability.promptKey && input[capability.promptKey] === undefined) {
    input[capability.promptKey] = request.prompt;
  }
  if (capability.id === "text_to_music") {
    if (!Array.isArray(input.weightedPrompts) && request.prompt) {
      input.weightedPrompts = [{ text: request.prompt, weight: 1 }];
    }
    if (!isRecord(input.musicGenerationConfig)) input.musicGenerationConfig = { ...DEFAULT_MUSIC_CONFIG };
  }
  if (request.aspectRatio && capability.supportsAspectRatio && input.aspect_ratio === undefined) {
    input.aspect_ratio = request.aspectRatio;
  }
  const source = request.sourceUrl ?? (request.source ? toDataUri(request.source) : undefined);
  if (source && capability.sourceUrlKey && input[capability.sourceUrlKey] === undefined) {
    input[capability.sourceUrlKey] = capability.sourceUrlKey.endsWith("_urls") ? [source] : source;
  }
  for (const [key, value] of Object.entries(request.sources ?? {})) {
    const slot =
      (capability.id === "reference_to_video" ? REFERENCE_VIDEO_SLOT_ALIASES[key] : undefined) ??
      SOURCE_SLOT_ALIASES[key] ??
      key;
    if (input[slot] === undefined) {
      const reference = toDataUri(value);
      input[slot] = slot.endsWith("_urls") ? [reference] : reference;
    }
  }
  // GPT Image 2 takes `image_size`, not `aspect_ratio`.
  if (capability.endpointId.startsWith("openai/gpt-image-2")) {
    if (typeof input.aspect_ratio === "string" && input.image_size === undefined) {
      const preset = GPT_IMAGE_2_ASPECT_PRESETS[input.aspect_ratio.trim()];
      if (preset) input.image_size = preset;
    }
    delete input.aspect_ratio;
    if (capability.id === "text_to_image" && input.image_size === undefined) input.image_size = "auto";
  }
  return input;
};

const MAX_IMAGE_REFERENCES = 4;
const MAX_IMAGE_REFERENCE_BYTES = 1024 * 1024;
const MAX_IMAGE_REFERENCE_TOTAL_BYTES = 2 * 1024 * 1024;
const MAX_REFERENCE_URL_CHARS = 8 * 1024;

const decodedLength = (dataUri: string): number => {
  const body = dataUri.slice(dataUri.indexOf(",") + 1).replace(/\s+/g, "");
  const padding = body.endsWith("==") ? 2 : body.endsWith("=") ? 1 : 0;
  return Math.floor((body.length * 3) / 4) - padding;
};

const validateImageReferences = (input: Record<string, unknown>): string | null => {
  const references = input.image_urls;
  if (references === undefined) return null;
  if (!Array.isArray(references)) return "input.image_urls must be an array";
  if (references.length > MAX_IMAGE_REFERENCES) {
    return `input.image_urls accepts at most ${MAX_IMAGE_REFERENCES} references`;
  }
  let total = 0;
  for (const [index, reference] of references.entries()) {
    if (isHttpUrl(reference)) {
      if (reference.length > MAX_REFERENCE_URL_CHARS) {
        return `input.image_urls[${index}] exceeds the remote URL length limit`;
      }
      continue;
    }
    if (!isDataUri(reference) || !/^data:image\/(png|jpeg|gif|webp);base64,/i.test(reference)) {
      return `input.image_urls[${index}] must be an http(s) or supported image data URL`;
    }
    const bytes = decodedLength(reference);
    if (bytes > MAX_IMAGE_REFERENCE_BYTES) {
      return `input.image_urls[${index}] exceeds the managed per-reference byte limit`;
    }
    total += bytes;
    if (total > MAX_IMAGE_REFERENCE_TOTAL_BYTES) {
      return "input.image_urls exceeds the managed aggregate reference limit";
    }
  }
  return null;
};

/** Why `input` cannot be submitted for `capability`, or null. */
export const validateProviderInput = (
  capability: MediaCapability,
  request: MediaGenerateRequest,
  input: Record<string, unknown>,
): string | null => {
  const sources = [
    ...(request.source !== undefined ? [["source", request.source] as const] : []),
    ...Object.entries(request.sources ?? {}).map(([key, value]) => [`sources.${key}`, value] as const),
  ];
  for (const [label, value] of sources) {
    if (typeof value === "string") {
      if (!isSourceReference(value)) return `${label} must be a valid http(s) URL or data URI`;
    } else {
      if (!/^[\w!#$&^.+-]+\/[\w!#$&^.+-]+$/.test(value.mimeType ?? "")) {
        return `${label}.mimeType must be a valid MIME type`;
      }
      if (!/^[A-Za-z0-9+/]+={0,2}$/.test((value.base64 ?? "").replace(/\s+/g, "").slice(0, 256))) {
        return `${label}.base64 must be valid base64`;
      }
    }
  }
  if (capability.promptKey && !nonEmpty(input[capability.promptKey])) {
    return "prompt is required for this capability";
  }
  if (capability.id === "text_to_image" || capability.id === "image_edit") {
    const error = validateImageReferences(input);
    if (error) return error;
  }
  const slotValue = capability.sourceUrlKey ? input[capability.sourceUrlKey] : undefined;
  const slotRef = Array.isArray(slotValue) ? slotValue[0] : slotValue;
  if (capability.id === "reference_to_video") {
    const list = (key: string): unknown[] => (Array.isArray(input[key]) ? (input[key] as unknown[]) : []);
    const images = list("reference_image_urls");
    const videos = list("reference_video_urls");
    const references = [...images, ...videos, ...list("reference_audio_urls")];
    if (images.length === 0 && videos.length === 0) {
      return "reference_to_video requires at least one reference image or video";
    }
    if (references.length > 12) return "reference_to_video accepts at most 12 reference files";
    if (!references.every(isSourceReference)) {
      return "reference_to_video references must be valid http(s) URLs or data URIs";
    }
  }
  if (capability.requiresSourceUrl && !isSourceReference(slotRef)) {
    return "A valid http(s) sourceUrl or source.base64 input is required for this capability";
  }
  if (capability.sourceUrlKey && slotRef !== undefined && !isSourceReference(slotRef)) {
    return "sourceUrl must be a valid http(s) URL or data URI";
  }
  if (capability.id === "text_to_music" && !parseMusicRequest(input)) {
    return "weightedPrompts and musicGenerationConfig are required for this capability";
  }
  return null;
};

// ── Prices ───────────────────────────────────────────────────────────────

const MICRO_CENTS_PER_USD = 100_000_000;
const usd = (value: number): number => Math.max(0, Math.round(value * MICRO_CENTS_PER_USD));

/** Before admitting a job, the owner must have at least this much left. */
export const MEDIA_ADMISSION_BUFFER_MICRO_CENTS = usd(0.8);

const num = (value: unknown): number | null => {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() && Number.isFinite(Number(value))) return Number(value);
  return null;
};

/** The first `field` found anywhere in `value`, depth-first. */
const findNumber = (value: unknown, field: string, depth = 0): number | null => {
  if (depth > 8 || value === null || typeof value !== "object") return null;
  if (!Array.isArray(value)) {
    const direct = num((value as Record<string, unknown>)[field]);
    if (direct !== null) return direct;
  }
  for (const entry of Object.values(value as Record<string, unknown>)) {
    const found = findNumber(entry, field, depth + 1);
    if (found !== null) return found;
  }
  return null;
};

/** The largest `field` anywhere in `value` (transcript segment ends). */
const maxNumber = (value: unknown, field: string, depth = 0): number | null => {
  if (depth > 8 || value === null || typeof value !== "object") return null;
  let max: number | null = null;
  if (!Array.isArray(value)) max = num((value as Record<string, unknown>)[field]);
  for (const entry of Object.values(value as Record<string, unknown>)) {
    const found = maxNumber(entry, field, depth + 1);
    if (found !== null) max = max === null ? found : Math.max(max, found);
  }
  return max;
};

/**
 * What a finished job costs Stella, in micro-cents, or null when the output
 * lacks what its price depends on (logged; the job still succeeds).
 */
export const mediaCostMicroCents = (
  endpointId: string,
  input: Record<string, unknown>,
  output: unknown,
): number | null => {
  switch (endpointId) {
    case "google/lyria-3-pro-preview":
      return usd(0.08);
    case "openai/gpt-image-2":
    case "openai/gpt-image-2/edit": {
      // fal publishes a band, not a table: quality tier × megapixels, clamped.
      const images = Math.max(1, Math.round(num(input.num_images) ?? 1));
      const quality = String(input.quality ?? "low").toLowerCase();
      const perMp = quality === "low" ? 0.012 : quality === "medium" ? 0.045 : 0.18;
      let megapixels = 0.85;
      if (isRecord(input.image_size)) {
        const width = num(input.image_size.width);
        const height = num(input.image_size.height);
        if (width !== null && height !== null) megapixels = Math.max(0.65, (width * height) / 1_000_000);
      }
      return usd(images * Math.min(0.41, Math.max(0.01, perMp * megapixels)));
    }
    case "minimax/h3-max/text-to-video":
    case "minimax/h3-max/image-to-video":
    case "minimax/h3-max/reference-to-video": {
      const seconds = num(input.duration) ?? 5;
      const resolution = String(input.resolution ?? "768P").toUpperCase();
      const perSecond =
        endpointId === "minimax/h3-max/reference-to-video" ? 0.08 : resolution === "480P" ? 0.05 : 0.08;
      return usd(Math.max(0, seconds) * perSecond);
    }
    case "fal-ai/hunyuan-3d/v3.1/pro/text-to-3d": {
      const geometry = String(input.generate_type ?? "Normal").toLowerCase() === "geometry";
      return usd((geometry ? 0.225 : 0.375) + (input.enable_pbr === true ? 0.15 : 0));
    }
    case "nvidia/nemotron-3.5-asr-streaming-multilingual-0.6b": {
      const usage = isRecord(output) && isRecord(output.usage) ? num(output.usage.seconds) : null;
      const seconds = usage ?? maxNumber(output, "end");
      return seconds === null ? null : usd(seconds * 0.000003);
    }
    case "bytedance/seed-audio-1.0": {
      const seconds = findNumber(output, "duration");
      return seconds === null ? null : usd((seconds / 60) * 0.1875);
    }
    case "fal-ai/sam-audio/visual-separate": {
      const seconds = findNumber(output, "duration");
      if (seconds === null) return null;
      const candidates = Math.max(1, Math.round(num(input.reranking_candidates) ?? 1));
      return usd((seconds / 30) * (1 + (candidates - 1) * 0.5) * 0.05);
    }
    default:
      return null;
  }
};
