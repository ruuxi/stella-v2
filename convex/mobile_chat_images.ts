import type { ResolvedModelConfig } from "./agent/model_resolver";
import type {
  AssistantMessage,
  Context,
  ImageContent,
  Message,
  TextContent,
  Usage,
  UserMessage,
} from "./runtime_ai/types";

export const MAX_OFFLINE_IMAGES = 5;
export const MAX_IMAGE_BASE64_CHARS = 6_000_000;
export const MAX_TOTAL_IMAGE_BASE64_CHARS = 12_000_000;

export const SUPPORTED_OFFLINE_IMAGE_MIME_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
]);

export type OfflineChatImage = { base64: string; mimeType: string };

export type OfflineChatImageParseResult =
  | { ok: true; images: OfflineChatImage[] }
  | { ok: false; error: string };

const BASE64_PATTERN = /^[A-Za-z0-9+/]*={0,2}$/;

export const parseOfflineImages = (
  raw: unknown,
): OfflineChatImageParseResult => {
  if (raw === undefined || raw === null) {
    return { ok: true, images: [] };
  }
  if (!Array.isArray(raw)) {
    return { ok: false, error: "Images must be an array." };
  }
  if (raw.length > MAX_OFFLINE_IMAGES) {
    return {
      ok: false,
      error: `You can attach up to ${MAX_OFFLINE_IMAGES} images at a time.`,
    };
  }

  const images: OfflineChatImage[] = [];
  let totalBase64Chars = 0;
  for (const item of raw) {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      return { ok: false, error: "An attached image is invalid." };
    }
    const record = item as { base64?: unknown; mimeType?: unknown };
    const base64 = typeof record.base64 === "string" ? record.base64 : "";
    if (!base64 || !BASE64_PATTERN.test(base64) || base64.length % 4 !== 0) {
      return { ok: false, error: "An attached image could not be read." };
    }
    if (base64.length > MAX_IMAGE_BASE64_CHARS) {
      return {
        ok: false,
        error: "Each attached image must be smaller than 4.5 MB.",
      };
    }

    const mimeType =
      typeof record.mimeType === "string"
        ? record.mimeType.trim().toLowerCase()
        : "";
    if (!SUPPORTED_OFFLINE_IMAGE_MIME_TYPES.has(mimeType)) {
      return {
        ok: false,
        error: "Attach a JPEG, PNG, GIF, or WebP image.",
      };
    }

    totalBase64Chars += base64.length;
    if (totalBase64Chars > MAX_TOTAL_IMAGE_BASE64_CHARS) {
      return {
        ok: false,
        error: "The attached images are too large. Try fewer or smaller images.",
      };
    }
    images.push({ base64, mimeType });
  }

  return { ok: true, images };
};

export const modelSupportsOfflineImages = (
  config: Pick<ResolvedModelConfig, "modalitiesInput">,
): boolean => config.modalitiesInput?.includes("image") === true;

export const offlineImageCapabilityError = (
  config: Pick<ResolvedModelConfig, "modalitiesInput">,
  images: readonly OfflineChatImage[],
): string | null =>
  images.length > 0 && !modelSupportsOfflineImages(config)
    ? "The current chat model does not support images. Remove the image or use an image-capable model."
    : null;

const EMPTY_USAGE: Usage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

const assistantHistoryMessage = (text: string): AssistantMessage => ({
  role: "assistant",
  content: [{ type: "text", text }],
  api: "openai-completions",
  provider: "managed",
  model: "offline-history",
  usage: EMPTY_USAGE,
  stopReason: "stop",
  timestamp: Date.now(),
});

export const buildOfflineChatContext = (args: {
  systemPrompt: string;
  history: Array<{ role: "user" | "assistant"; text: string }>;
  message: string;
  images: OfflineChatImage[];
}): Context => {
  const messages: Message[] = [];
  for (const turn of args.history) {
    if (turn.role === "user") {
      messages.push({
        role: "user",
        content: turn.text,
        timestamp: Date.now(),
      });
    } else {
      messages.push(assistantHistoryMessage(turn.text));
    }
  }

  const parts: Array<TextContent | ImageContent> = [];
  const message = args.message.trim();
  if (message) {
    parts.push({ type: "text", text: message });
  }
  for (const image of args.images) {
    parts.push({
      type: "image",
      data: image.base64,
      mimeType: image.mimeType,
    });
  }

  let userContent: UserMessage["content"];
  if (parts.length === 1 && parts[0].type === "text") {
    userContent = parts[0].text;
  } else {
    userContent = parts;
  }

  messages.push({
    role: "user",
    content: userContent,
    timestamp: Date.now(),
  });

  return { systemPrompt: args.systemPrompt, messages };
};
