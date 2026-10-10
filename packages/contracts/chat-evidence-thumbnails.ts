import {
  EVIDENCE_RASTER_SCALE,
  EVIDENCE_TILE_HEIGHT,
  EVIDENCE_TILE_WIDTH,
} from "./chat-evidence.js";

export const EVIDENCE_THUMBNAIL_DRIVE_ROOT = ".thumbnails";
export const EVIDENCE_THUMBNAIL_EXTENSION = ".jpg";
export const EVIDENCE_THUMBNAIL_CONTENT_TYPE = "image/jpeg";
export const EVIDENCE_THUMBNAIL_JPEG_QUALITY = 74;
export const EVIDENCE_THUMBNAIL_SOURCE_MAX_BYTES = 40 * 1024 * 1024;
export const EVIDENCE_THUMBNAIL_MAX_BYTES = 256 * 1024;
export const EVIDENCE_THUMBNAIL_BOX = {
  width: EVIDENCE_TILE_WIDTH.image * EVIDENCE_RASTER_SCALE,
  height: EVIDENCE_TILE_HEIGHT * EVIDENCE_RASTER_SCALE,
} as const;
export const EVIDENCE_THUMBNAIL_MAX_EDGE = 1024;
export const EVIDENCE_THUMBNAIL_VARIANT = "thumbnail";

const DRIVE_PATH_MAX = 400;

const THUMBNAILABLE_EXTENSIONS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".webp",
  ".gif",
  ".bmp",
]);

const extensionOf = (filePath: string): string => {
  const name = filePath.split(/[\\/]/).pop() ?? "";
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot).toLowerCase() : "";
};

export const isEvidenceThumbnailSource = (filePath: string): boolean =>
  THUMBNAILABLE_EXTENSIONS.has(extensionOf(filePath));

export const isEvidenceThumbnailDrivePath = (drivePath: string): boolean => {
  const normalized = drivePath.replace(/^\.\//, "").replace(/^\/+/, "");
  return (
    normalized === EVIDENCE_THUMBNAIL_DRIVE_ROOT ||
    normalized.startsWith(`${EVIDENCE_THUMBNAIL_DRIVE_ROOT}/`)
  );
};

export const evidenceThumbnailDrivePath = (drivePath: string): string | null => {
  const normalized = drivePath.trim().replace(/^\.\//, "").replace(/^\/+/, "");
  if (!normalized || isEvidenceThumbnailDrivePath(normalized)) return null;
  if (!isEvidenceThumbnailSource(normalized)) return null;
  const thumbnail = `${EVIDENCE_THUMBNAIL_DRIVE_ROOT}/${normalized}${EVIDENCE_THUMBNAIL_EXTENSION}`;
  return thumbnail.length <= DRIVE_PATH_MAX ? thumbnail : null;
};

export const evidenceThumbnailSize = (
  width: number,
  height: number,
): { width: number; height: number } | null => {
  if (!(width > 0) || !(height > 0)) return null;
  const cover = Math.max(
    EVIDENCE_THUMBNAIL_BOX.width / width,
    EVIDENCE_THUMBNAIL_BOX.height / height,
  );
  const edge = EVIDENCE_THUMBNAIL_MAX_EDGE / Math.max(width, height);
  const scale = Math.min(1, cover, edge);
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
};
