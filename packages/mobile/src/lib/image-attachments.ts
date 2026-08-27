import { standardBase64ToBytes } from "./bridge-envelope";

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

  uri?: string;
  base64: string;
  mimeType: string;
}) => Promise<SendableImage | null>;

export const transcodeImageToJpeg: ImageTranscoder = async () => null;

const sniffBase64ImageMimeType = (base64: string): string | null => {

  const head = base64.slice(0, 96);
  try {
    return sniffImageMimeType(standardBase64ToBytes(head));
  } catch {
    return null;
  }
};

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
