import {
  DEFAULT_JPEG_QUALITY,
  SAFE_FALLBACK_MAX_BYTES,
  SAFE_FALLBACK_MAX_EDGE,
} from "../../ai/utils/image-caps.js";
import { applyExifOrientation } from "./exif-orientation.js";
import { loadPhoton } from "./photon.js";

export interface ImageResizeOptions {
  maxWidth?: number;
  maxHeight?: number;
  maxBytes?: number;
  jpegQuality?: number;
}

export interface ResizedImage {
  data: string;
  mimeType: string;
  originalWidth: number;
  originalHeight: number;
  width: number;
  height: number;
  wasResized: boolean;
}

const DEFAULT_OPTIONS: Required<ImageResizeOptions> = {
  maxWidth: SAFE_FALLBACK_MAX_EDGE,
  maxHeight: SAFE_FALLBACK_MAX_EDGE,
  maxBytes: SAFE_FALLBACK_MAX_BYTES,
  jpegQuality: DEFAULT_JPEG_QUALITY,
};

interface EncodedCandidate {
  data: string;
  encodedSize: number;
  mimeType: string;
}

const encodeCandidate = (
  buffer: Uint8Array,
  mimeType: string,
): EncodedCandidate => {
  const data = Buffer.from(buffer).toString("base64");
  return {
    data,
    encodedSize: Buffer.byteLength(data, "utf-8"),
    mimeType,
  };
};

export const resizeImage = async (
  inputBytes: Uint8Array,
  mimeType: string,
  options?: ImageResizeOptions,
): Promise<ResizedImage | null> => {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  const inputBase64Size = Math.ceil(inputBytes.byteLength / 3) * 4;

  const photon = await loadPhoton();
  if (!photon) {
    return null;
  }

  let image:
    | ReturnType<typeof photon.PhotonImage.new_from_byteslice>
    | undefined;
  try {
    const rawImage = photon.PhotonImage.new_from_byteslice(inputBytes);
    image = applyExifOrientation(photon, rawImage, inputBytes);
    if (image !== rawImage) rawImage.free();

    const originalWidth = image.get_width();
    const originalHeight = image.get_height();
    const format = mimeType.split("/")[1] ?? "png";

    if (
      originalWidth <= opts.maxWidth &&
      originalHeight <= opts.maxHeight &&
      inputBase64Size < opts.maxBytes
    ) {
      return {
        data: Buffer.from(inputBytes).toString("base64"),
        mimeType: mimeType || `image/${format}`,
        originalWidth,
        originalHeight,
        width: originalWidth,
        height: originalHeight,
        wasResized: false,
      };
    }

    let targetWidth = originalWidth;
    let targetHeight = originalHeight;

    if (targetWidth > opts.maxWidth) {
      targetHeight = Math.round((targetHeight * opts.maxWidth) / targetWidth);
      targetWidth = opts.maxWidth;
    }
    if (targetHeight > opts.maxHeight) {
      targetWidth = Math.round((targetWidth * opts.maxHeight) / targetHeight);
      targetHeight = opts.maxHeight;
    }

    const tryEncodings = (
      width: number,
      height: number,
      jpegQualities: number[],
    ): EncodedCandidate[] => {
      const resized = photon.resize(
        image!,
        width,
        height,
        photon.SamplingFilter.Lanczos3,
      );

      try {
        const candidates: EncodedCandidate[] = [
          encodeCandidate(resized.get_bytes(), "image/png"),
        ];
        for (const quality of jpegQualities) {
          candidates.push(
            encodeCandidate(resized.get_bytes_jpeg(quality), "image/jpeg"),
          );
        }
        return candidates;
      } finally {
        resized.free();
      }
    };

    const qualitySteps = Array.from(
      new Set([opts.jpegQuality, 90, 80, 70, 55, 40]),
    );
    let currentWidth = targetWidth;
    let currentHeight = targetHeight;

    while (true) {
      const candidates = tryEncodings(currentWidth, currentHeight, qualitySteps);
      for (const candidate of candidates) {
        if (candidate.encodedSize < opts.maxBytes) {
          return {
            data: candidate.data,
            mimeType: candidate.mimeType,
            originalWidth,
            originalHeight,
            width: currentWidth,
            height: currentHeight,
            wasResized: true,
          };
        }
      }

      if (currentWidth === 1 && currentHeight === 1) {
        break;
      }

      const nextWidth =
        currentWidth === 1 ? 1 : Math.max(1, Math.floor(currentWidth * 0.75));
      const nextHeight =
        currentHeight === 1 ? 1 : Math.max(1, Math.floor(currentHeight * 0.75));
      if (nextWidth === currentWidth && nextHeight === currentHeight) {
        break;
      }

      currentWidth = nextWidth;
      currentHeight = nextHeight;
    }

    return null;
  } catch {
    return null;
  } finally {
    if (image) {
      image.free();
    }
  }
};

export const formatDimensionNote = (
  result: ResizedImage,
): string | undefined => {
  if (!result.wasResized) {
    return undefined;
  }

  const scale = result.originalWidth / result.width;
  return `[Image: original ${result.originalWidth}x${result.originalHeight}, displayed at ${result.width}x${result.height}. Multiply coordinates by ${scale.toFixed(2)} to map to original image.]`;
};
