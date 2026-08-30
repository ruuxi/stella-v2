/**
 * Image format identification for outbound attachments.
 *
 * iOS photo-library picks (and share-sheet images) frequently arrive as HEIC
 * under a `image/jpeg` label: expo-image-picker's `quality` re-encode is
 * bypassed for HEIC, since its native `readDataAndFileExtension` returns the
 * raw bytes for `UTType.heic`. Model providers only accept jpeg/png/gif/webp,
 * and a mislabeled HEIC lands as "[Image omitted: it could not be decoded as a
 * valid image…]" with nothing to explain why.
 *
 * The bytes themselves no longer leave the phone through a prompt — they go to
 * the drive, and the drive row's content type is what both placements read. So
 * the one thing that matters is that the type recorded on that row comes from
 * the magic numbers rather than from what the picker claimed.
 */

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

/**
 * The content type to record on the drive row for picked bytes. The declared
 * type is only a fallback: a HEIC mislabeled `image/jpeg` would otherwise reach
 * a model as JPEG and fail with nothing to explain it.
 *
 * A non-image keeps its declared type. Sniffing only knows image formats, and
 * a PDF is not improved by being called `application/octet-stream`.
 */
export const attachmentContentType = (
  bytes: Uint8Array,
  declared: string,
): string => sniffImageMimeType(bytes) ?? declared;
