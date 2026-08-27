export interface ImageCaps {

  maxWidth: number;

  maxHeight: number;

  maxBytes: number;

  jpegQuality: number;
}

export interface ImageCapTarget {

  provider?: string;

  api?: string;

  modelId?: string;

  imageCount?: number;

  detailOriginal?: boolean;
}

export const ANTHROPIC_DIRECT_MAX_IMAGE_BASE64_BYTES = 10 * 1024 * 1024;

export const ANTHROPIC_BEDROCK_VERTEX_MAX_IMAGE_BASE64_BYTES = 5 * 1024 * 1024;

export const ANTHROPIC_HIGH_RES_MAX_EDGE = 2576;

export const ANTHROPIC_STANDARD_MAX_EDGE = 1568;

export const ANTHROPIC_HARD_MAX_EDGE = 8000;

export const OPENAI_MAX_EDGE = 2048;

export const OPENAI_ORIGINAL_MAX_EDGE = 6000;

export const GOOGLE_MAX_EDGE = 3072;

export const MANY_IMAGE_THRESHOLD = 20;
export const MANY_IMAGE_MAX_EDGE = 2000;

export const SAFE_FALLBACK_MAX_EDGE = 2048;
export const SAFE_FALLBACK_MAX_BYTES = Math.floor(4.5 * 1024 * 1024);

const ANTHROPIC_DIRECT_RESIZE_MAX_BYTES = Math.floor(9.5 * 1024 * 1024);
const GENEROUS_RESIZE_MAX_BYTES = Math.floor(9.5 * 1024 * 1024);
const BEDROCK_VERTEX_RESIZE_MAX_BYTES = Math.floor(4.5 * 1024 * 1024);

export const DEFAULT_JPEG_QUALITY = 90;

const normalize = (value: string | undefined): string =>
  value?.trim().toLowerCase() ?? "";

export const isAnthropicStandardTierModel = (modelId: string): boolean => {
  const id = normalize(modelId);
  if (!id) return false;

  if (/opus-?4|sonnet-?4-5|sonnet-?4\.5|sonnet-?5|fable|mythos/.test(id)) {
    return false;
  }
  return /claude-?2|claude-?3|claude-?instant|-3-5-|-3\.5-|-3-7-|-3\.7-/.test(
    id,
  );
};

const isBedrockOrVertexTarget = (provider: string, api: string): boolean =>
  provider === "amazon-bedrock" ||
  provider === "google-vertex" ||
  api === "bedrock-converse-stream" ||
  api === "google-vertex";

const anthropicByteCap = (
  provider: string,
  api: string,
  detailOriginal: boolean,
): { resize: number; hard: number } => {
  if (isBedrockOrVertexTarget(provider, api)) {
    return {
      resize: BEDROCK_VERTEX_RESIZE_MAX_BYTES,
      hard: ANTHROPIC_BEDROCK_VERTEX_MAX_IMAGE_BASE64_BYTES,
    };
  }
  return {
    resize: detailOriginal
      ? ANTHROPIC_DIRECT_MAX_IMAGE_BASE64_BYTES
      : ANTHROPIC_DIRECT_RESIZE_MAX_BYTES,
    hard: ANTHROPIC_DIRECT_MAX_IMAGE_BASE64_BYTES,
  };
};

const isAnthropicFamily = (provider: string, api: string): boolean =>
  provider === "anthropic" ||
  provider === "amazon-bedrock" ||
  provider === "google-vertex" ||
  api === "anthropic-messages" ||
  api === "bedrock-converse-stream" ||
  api === "google-vertex";

const isOpenAIFamily = (provider: string, api: string): boolean =>
  provider === "openai" ||
  provider === "openai-codex" ||
  provider === "azure-openai-responses" ||
  api.startsWith("openai-") ||
  api === "azure-openai-responses";

const isGoogleFamily = (provider: string, api: string): boolean =>
  provider === "google" ||
  api === "google-generative-ai";

export const resolveImageCaps = (target: ImageCapTarget = {}): ImageCaps => {
  const provider = normalize(target.provider);
  const api = normalize(target.api);
  const detailOriginal = target.detailOriginal ?? false;

  let maxEdge = SAFE_FALLBACK_MAX_EDGE;
  let maxBytes = SAFE_FALLBACK_MAX_BYTES;

  if (isAnthropicFamily(provider, api)) {
    const bytes = anthropicByteCap(provider, api, detailOriginal);
    maxBytes = bytes.resize;
    if (detailOriginal) {
      maxEdge = ANTHROPIC_HARD_MAX_EDGE;
    } else {
      maxEdge = isAnthropicStandardTierModel(target.modelId ?? "")
        ? ANTHROPIC_STANDARD_MAX_EDGE
        : ANTHROPIC_HIGH_RES_MAX_EDGE;
    }
  } else if (isOpenAIFamily(provider, api)) {
    maxEdge = detailOriginal ? OPENAI_ORIGINAL_MAX_EDGE : OPENAI_MAX_EDGE;
    maxBytes = GENEROUS_RESIZE_MAX_BYTES;
  } else if (isGoogleFamily(provider, api)) {
    maxEdge = GOOGLE_MAX_EDGE;
    maxBytes = GENEROUS_RESIZE_MAX_BYTES;
  } else if (detailOriginal) {

    maxBytes = GENEROUS_RESIZE_MAX_BYTES;
  }

  const imageCount = target.imageCount ?? 0;
  if (imageCount > MANY_IMAGE_THRESHOLD) {
    maxEdge = Math.min(maxEdge, MANY_IMAGE_MAX_EDGE);
  }

  return {
    maxWidth: maxEdge,
    maxHeight: maxEdge,
    maxBytes,
    jpegQuality: DEFAULT_JPEG_QUALITY,
  };
};

export const maxInlineImageBase64Bytes = (
  target: ImageCapTarget = {},
): number => {
  const provider = normalize(target.provider);
  const api = normalize(target.api);
  if (isAnthropicFamily(provider, api)) {
    return anthropicByteCap(provider, api, false).hard;
  }
  return ANTHROPIC_DIRECT_MAX_IMAGE_BASE64_BYTES;
};
