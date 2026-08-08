/**
 * Outbound image-attachment normalization.
 *
 * iOS photo-library picks (and share-sheet images) frequently arrive as HEIC:
 * expo-image-picker's `quality` re-encode is bypassed for HEIC — its native
 * `readDataAndFileExtension` returns the raw bytes for `UTType.heic` — so the
 * original HEIC base64 rides the bridge untouched. Desktop model providers
 * only accept jpeg/png/gif/webp, so the turn lands with
 * "[Image omitted: it could not be decoded as a valid image…]".
 *
 * Every attachment lane (computer-chat bridge, cloud chat) must funnel
 * through `toSendableImage` so the payload that leaves the phone is always a
 * provider-decodable format with an honest mime type.
 */
import { standardBase64ToBytes } from "./bridge-envelope";

/** Formats the desktop runtime's model providers accept as vision input. */
export const PROVIDER_SAFE_IMAGE_MIME_TYPES: ReadonlySet<string> = new Set([
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
]);

const ISO_BMFF_HEIC_BRANDS = new Set([
  "heic",
  "heix",
  "heim",
  "heis",
  "hevc",
  "hevx",
  "heif",
  "mif1",
  "msf1",
]);
const ISO_BMFF_AVIF_BRANDS = new Set(["avif", "avis"]);

const ascii = (bytes: Uint8Array, start: number, length: number) => {
  let out = "";
  for (let i = start; i < start + length && i < bytes.length; i++) {
    out += String.fromCharCode(bytes[i]!);
  }
  return out;
};

/**
 * Identify an image format from its magic numbers. Returns null when the
 * bytes don't look like any format we know — callers should then fall back
 * to the declared mime type.
 */
export const sniffImageMimeType = (bytes: Uint8Array): string | null => {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "image/jpeg";
  }
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47
  ) {
    return "image/png";
  }
  if (bytes.length >= 6 && ascii(bytes, 0, 4) === "GIF8") {
    return "image/gif";
  }
  if (bytes.length >= 12 && ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 4) === "WEBP") {
    return "image/webp";
  }
  // ISO BMFF (HEIC/HEIF/AVIF): [4-byte box size]"ftyp"[4-byte major brand].
  if (bytes.length >= 12 && ascii(bytes, 4, 4) === "ftyp") {
    const brand = ascii(bytes, 8, 4).toLowerCase();
    if (ISO_BMFF_AVIF_BRANDS.has(brand)) return "image/avif";
    if (ISO_BMFF_HEIC_BRANDS.has(brand)) return "image/heic";
    return "image/heif";
  }
  if (
    bytes.length >= 4 &&
    ((bytes[0] === 0x49 && bytes[1] === 0x49 && bytes[2] === 0x2a && bytes[3] === 0x00) ||
      (bytes[0] === 0x4d && bytes[1] === 0x4d && bytes[2] === 0x00 && bytes[3] === 0x2a))
  ) {
    return "image/tiff";
  }
  if (bytes.length >= 2 && bytes[0] === 0x42 && bytes[1] === 0x4d) {
    return "image/bmp";
  }
  return null;
};

export type SendableImage = { base64: string; mimeType: string };

export type ImageTranscoder = (input: {
  /** Local file URI of the original asset, when available. */
  uri?: string;
  base64: string;
  mimeType: string;
}) => Promise<SendableImage | null>;

/**
 * JPEG re-encode is intentionally inactive: expo-image-manipulator is a
 * native module, and shipping it in package.json changes the fingerprint
 * runtime, cutting current binaries (build 97, runtime 7fda4711…) off from
 * OTA updates. The picker's Compatible mode already delivers JPEG for photo
 * library picks, so this path is a no-op for now.
 *
 * When the next native build (98) is cut, restore `expo-image-manipulator`
 * in package.json and reinstate the manipulateAsync-based transcode here.
 * Returning null makes callers fall back to the original bytes under their
 * honest mime type.
 */
export const transcodeImageToJpeg: ImageTranscoder = async () => null;

/** Decode just enough of the base64 payload to read the magic numbers. */
const sniffBase64ImageMimeType = (base64: string): string | null => {
  // 24 base64 quads → 72 bytes, comfortably past every magic number we check.
  const head = base64.slice(0, 96);
  try {
    return sniffImageMimeType(standardBase64ToBytes(head));
  } catch {
    return null;
  }
};

/**
 * Normalize a picked/shared image asset into the payload we put on the wire.
 *
 * - Provider-safe bytes pass through untouched (bytes in = bytes out) with a
 *   mime type corrected from the actual magic numbers, so a HEIC mislabeled
 *   as image/jpeg can't sneak past.
 * - Unsupported formats (HEIC/HEIF/TIFF/AVIF/…) are re-encoded to JPEG; when
 *   transcoding isn't available we still send the original bytes under their
 *   honest mime type rather than dropping the attachment.
 *
 * Returns null when the asset has no base64 payload at all.
 */
export const toSendableImage = async (
  asset: { uri?: string; base64?: string | null; mimeType?: string | null },
  transcode: ImageTranscoder = transcodeImageToJpeg,
): Promise<SendableImage | null> => {
  const base64 = asset.base64;
  if (!base64) return null;
  const mimeType = sniffBase64ImageMimeType(base64) ?? asset.mimeType ?? "image/jpeg";
  if (PROVIDER_SAFE_IMAGE_MIME_TYPES.has(mimeType)) {
    return { base64, mimeType };
  }
  const transcoded = await transcode({ uri: asset.uri, base64, mimeType });
  return transcoded ?? { base64, mimeType };
};
