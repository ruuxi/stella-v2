import { toSendableImage } from "./image-attachments";

export const MAX_OFFLINE_CHAT_IMAGES = 5;
export const MAX_OFFLINE_CHAT_IMAGE_BASE64_CHARS = 6_000_000;
export const MAX_OFFLINE_CHAT_TOTAL_IMAGE_BASE64_CHARS = 12_000_000;

const SUPPORTED_IMAGE_MIME_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
]);

const BASE64_PATTERN = /^[A-Za-z0-9+/]*={0,2}$/;

export type OfflineChatImagePayload = { base64: string; mimeType: string };

export type OfflineChatHistoryItem = {
  role: "user" | "assistant";
  text: string;
};

export type OfflineChatRequest = {
  message: string;
  history: OfflineChatHistoryItem[];
  images: OfflineChatImagePayload[];
};

export class InvalidChatImageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidChatImageError";
  }
}

export const appendOfflineChatAttachments = <T>(
  current: readonly T[],
  incoming: readonly T[],
  limit = MAX_OFFLINE_CHAT_IMAGES,
): { attachments: T[]; rejected: number } => {
  const combined = [...current, ...incoming];
  return {
    attachments: combined.slice(0, limit),
    rejected: Math.max(0, combined.length - limit),
  };
};

export const prepareOfflineChatImages = async (
  assets: readonly {
    uri?: string;
    base64?: string | null;
    mimeType?: string | null;
  }[],
): Promise<OfflineChatImagePayload[]> => {
  if (assets.length > MAX_OFFLINE_CHAT_IMAGES) {
    throw new InvalidChatImageError(
      `You can attach up to ${MAX_OFFLINE_CHAT_IMAGES} images at a time.`,
    );
  }

  const images: OfflineChatImagePayload[] = [];
  let totalBase64Chars = 0;
  for (const asset of assets) {
    const image = await toSendableImage(asset);
    if (!image) {
      throw new InvalidChatImageError(
        "An attached image could not be read. Try attaching it again.",
      );
    }
    const mimeType = image.mimeType.trim().toLowerCase();
    if (!SUPPORTED_IMAGE_MIME_TYPES.has(mimeType)) {
      throw new InvalidChatImageError(
        "That image format is not supported. Attach a JPEG, PNG, GIF, or WebP image.",
      );
    }
    if (
      !BASE64_PATTERN.test(image.base64) ||
      image.base64.length % 4 !== 0
    ) {
      throw new InvalidChatImageError(
        "An attached image could not be read. Try attaching it again.",
      );
    }
    if (image.base64.length > MAX_OFFLINE_CHAT_IMAGE_BASE64_CHARS) {
      throw new InvalidChatImageError(
        "Each attached image must be smaller than 4.5 MB.",
      );
    }
    totalBase64Chars += image.base64.length;
    if (totalBase64Chars > MAX_OFFLINE_CHAT_TOTAL_IMAGE_BASE64_CHARS) {
      throw new InvalidChatImageError(
        "The attached images are too large. Try fewer or smaller images.",
      );
    }
    images.push({ base64: image.base64, mimeType });
  }
  return images;
};

export const buildOfflineChatRequest = (args: OfflineChatRequest) => ({
  message: args.message,
  history: args.history,
  images: args.images,
});
