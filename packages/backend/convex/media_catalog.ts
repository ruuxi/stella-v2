export type MediaProvider = "fal" | "google_lyria" | "openrouter";

export type MediaCapability = {
  id: string;
  name: string;
  description: string;
  category: "audio" | "image" | "video" | "3d" | "analysis";
  provider: MediaProvider;
  endpointId: string;
  docsUrl: string;
  promptKey?: string;
  sourceUrlKey?: string;
  requiresSourceUrl?: boolean;
  supportsAspectRatio?: boolean;
  inputHints: string[];
  outputHints: string[];
};

/** Internal dispatch metadata. `id` only preserves the legacy job-row shape. */
export type MediaEndpoint = Pick<
  MediaCapability,
  "provider" | "endpointId" | "docsUrl"
> & { id: "default" };

const FAL_MODEL_BASE = "https://fal.ai/models";

const falModelUrl = (endpointId: string): string =>
  `${FAL_MODEL_BASE}/${endpointId}/api`;

export const MEDIA_CAPABILITIES: MediaCapability[] = [
  {
    id: "speech_to_text",
    name: "Speech To Text",
    description: "Transcribe spoken audio into text.",
    category: "audio",
    provider: "openrouter",
    endpointId: "nvidia/nemotron-3.5-asr-streaming-multilingual-0.6b",
    docsUrl:
      "https://openrouter.ai/nvidia/nemotron-3.5-asr-streaming-multilingual-0.6b",
    sourceUrlKey: "audio_url",
    inputHints: ["audio_url"],
    outputHints: ["text"],
  },
  {
    id: "audio_generation",
    name: "Audio Generation",
    description:
      "Generate speech, dialogue, sound effects, or ambient audio from text.",
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
    description:
      "Separate or isolate audio using the visual track for guidance.",
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
    description:
      "Generate a video guided by reference images, video clips, and optional audio.",
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
    inputHints: [
      "prompt",
      "generate_type (Normal | Geometry)",
      "face_count (40000-1500000)",
      "enable_pbr",
    ],
    outputHints: ["GLB / OBJ 3D asset URLs"],
  },
];

export type MediaCapabilityId = (typeof MEDIA_CAPABILITIES)[number]["id"];

export const listMediaCapabilities = (): MediaCapability[] =>
  MEDIA_CAPABILITIES.map((capability) => ({ ...capability }));

export const getMediaCapability = (
  capabilityId: string,
): MediaCapability | null =>
  MEDIA_CAPABILITIES.find((capability) => capability.id === capabilityId) ??
  null;

export const resolveMediaCapability = (
  capabilityId: string,
): { capability: MediaCapability; endpoint: MediaEndpoint } | null => {
  const capability = getMediaCapability(capabilityId);
  if (!capability) return null;
  return {
    capability,
    endpoint: {
      id: "default",
      provider: capability.provider,
      endpointId: capability.endpointId,
      docsUrl: capability.docsUrl,
    },
  };
};
