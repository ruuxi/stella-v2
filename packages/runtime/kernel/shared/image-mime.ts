import {
  detectImageMediaType,
  type SupportedImageMediaType,
} from "./image-payload.js";

export type SupportedImageMimeType = SupportedImageMediaType;

export const detectImageMimeTypeFromBytes = detectImageMediaType;

export const imageMimeTypeFromPath = (
  filePath: string,
): SupportedImageMimeType | null => {
  const lower = filePath.toLowerCase();
  if (lower.endsWith(".png")) return "image/png";
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
  if (lower.endsWith(".gif")) return "image/gif";
  if (lower.endsWith(".webp")) return "image/webp";
  return null;
};

export const resolveImageMimeType = (
  filePath: string,
  bytes: Uint8Array,
): SupportedImageMimeType | null =>
  detectImageMimeTypeFromBytes(bytes) ?? imageMimeTypeFromPath(filePath);
