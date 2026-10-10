import {
  EVIDENCE_THUMBNAIL_JPEG_QUALITY,
  EVIDENCE_THUMBNAIL_MAX_BYTES,
  EVIDENCE_THUMBNAIL_SOURCE_MAX_BYTES,
  evidenceThumbnailSize,
} from "@stella/contracts/chat-evidence-thumbnails";
import { applyExifOrientation } from "./exif-orientation.js";
import { loadPhoton } from "./photon.js";

const flattenOntoWhite = (pixels: Uint8Array): boolean => {
  let transparent = false;
  for (let index = 3; index < pixels.length; index += 4) {
    const alpha = pixels[index]!;
    if (alpha === 255) continue;
    transparent = true;
    const keep = alpha / 255;
    const fill = 255 * (1 - keep);
    pixels[index - 3] = Math.round(pixels[index - 3]! * keep + fill);
    pixels[index - 2] = Math.round(pixels[index - 2]! * keep + fill);
    pixels[index - 1] = Math.round(pixels[index - 1]! * keep + fill);
    pixels[index] = 255;
  }
  return transparent;
};

export const renderEvidenceThumbnail = async (
  bytes: Uint8Array,
): Promise<Uint8Array | null> => {
  if (bytes.byteLength === 0 || bytes.byteLength > EVIDENCE_THUMBNAIL_SOURCE_MAX_BYTES) {
    return null;
  }
  const photon = await loadPhoton();
  if (!photon) return null;
  let decoded: InstanceType<typeof photon.PhotonImage> | undefined;
  let oriented: InstanceType<typeof photon.PhotonImage> | undefined;
  let resized: InstanceType<typeof photon.PhotonImage> | undefined;
  let flattened: InstanceType<typeof photon.PhotonImage> | undefined;
  try {
    decoded = photon.PhotonImage.new_from_byteslice(bytes);
    oriented = applyExifOrientation(photon, decoded, bytes);
    const size = evidenceThumbnailSize(oriented.get_width(), oriented.get_height());
    if (!size) return null;
    resized =
      size.width === oriented.get_width() && size.height === oriented.get_height()
        ? undefined
        : photon.resize(oriented, size.width, size.height, photon.SamplingFilter.Lanczos3);
    const target = resized ?? oriented;
    const pixels = target.get_raw_pixels();
    if (flattenOntoWhite(pixels)) {
      flattened = new photon.PhotonImage(pixels, target.get_width(), target.get_height());
    }
    const jpeg = (flattened ?? target).get_bytes_jpeg(EVIDENCE_THUMBNAIL_JPEG_QUALITY);
    return jpeg.byteLength > 0 && jpeg.byteLength <= EVIDENCE_THUMBNAIL_MAX_BYTES
      ? jpeg
      : null;
  } catch {
    return null;
  } finally {
    flattened?.free();
    resized?.free();
    if (oriented && oriented !== decoded) oriented.free();
    decoded?.free();
  }
};
