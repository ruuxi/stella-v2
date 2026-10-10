import fs from "node:fs/promises";
import { nativeImage, type NativeImage } from "electron";
import {
  EVIDENCE_THUMBNAIL_JPEG_QUALITY,
  EVIDENCE_THUMBNAIL_MAX_BYTES,
  evidenceThumbnailSize,
} from "@stella/contracts/chat-evidence-thumbnails";

const DECODE_MAX_BYTES = 16 * 1024 * 1024;

const decodedImage = async (filePath: string): Promise<NativeImage | null> => {
  const stats = await fs.stat(filePath).catch(() => null);
  if (!stats?.isFile() || stats.size === 0 || stats.size > DECODE_MAX_BYTES) {
    return null;
  }
  const image = nativeImage.createFromPath(filePath);
  return image.isEmpty() ? null : image;
};

const flattenOntoWhite = (image: NativeImage): NativeImage => {
  const size = image.getSize();
  const bitmap = image.toBitmap();
  let transparent = false;
  for (let index = 3; index < bitmap.length; index += 4) {
    const alpha = bitmap[index]!;
    if (alpha === 255) continue;
    transparent = true;
    const fill = 255 - alpha;
    bitmap[index - 3] = Math.min(255, bitmap[index - 3]! + fill);
    bitmap[index - 2] = Math.min(255, bitmap[index - 2]! + fill);
    bitmap[index - 1] = Math.min(255, bitmap[index - 1]! + fill);
    bitmap[index] = 255;
  }
  return transparent
    ? nativeImage.createFromBitmap(bitmap, { width: size.width, height: size.height })
    : image;
};

export const renderDesktopEvidenceThumbnail = async (
  filePath: string,
): Promise<Buffer | null> => {
  try {
    const image = await decodedImage(filePath);
    if (!image) return null;
    const size = image.getSize();
    const target = evidenceThumbnailSize(size.width, size.height);
    if (!target) return null;
    const scaled =
      target.width < size.width
        ? image.resize({ width: target.width, height: target.height, quality: "good" })
        : image;
    const jpeg = flattenOntoWhite(scaled).toJPEG(EVIDENCE_THUMBNAIL_JPEG_QUALITY);
    return jpeg.byteLength > 0 && jpeg.byteLength <= EVIDENCE_THUMBNAIL_MAX_BYTES
      ? jpeg
      : null;
  } catch {
    return null;
  }
};
