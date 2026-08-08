import { describe, expect, test } from "bun:test";
import {
  PROVIDER_SAFE_IMAGE_MIME_TYPES,
  sniffImageMimeType,
  toSendableImage,
  type ImageTranscoder,
} from "../image-attachments";
import { standardBase64ToBytes } from "../bridge-envelope";

const toBase64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64");

// Minimal-but-real headers followed by arbitrary payload bytes, mirroring the
// production repro: a full-resolution iPhone HEIC whose stored bytes began
// `00 00 00 28 66 74 79 70 68 65 69 63` ("....ftypheic").
const makeBytes = (header: number[], length = 256) => {
  const bytes = new Uint8Array(length);
  bytes.set(header);
  for (let i = header.length; i < length; i++) bytes[i] = (i * 31) % 256;
  return bytes;
};

const JPEG = makeBytes([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]);
const PNG = makeBytes([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const WEBP = makeBytes([
  ...[0x52, 0x49, 0x46, 0x46], // RIFF
  ...[0x00, 0x01, 0x00, 0x00],
  ...[0x57, 0x45, 0x42, 0x50], // WEBP
]);
const GIF = makeBytes([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]);
const HEIC = makeBytes([
  ...[0x00, 0x00, 0x00, 0x28],
  ...[0x66, 0x74, 0x79, 0x70], // ftyp
  ...[0x68, 0x65, 0x69, 0x63], // heic
]);
const AVIF = makeBytes([
  ...[0x00, 0x00, 0x00, 0x1c],
  ...[0x66, 0x74, 0x79, 0x70],
  ...[0x61, 0x76, 0x69, 0x66], // avif
]);

describe("sniffImageMimeType", () => {
  test("identifies formats from magic numbers", () => {
    expect(sniffImageMimeType(JPEG)).toBe("image/jpeg");
    expect(sniffImageMimeType(PNG)).toBe("image/png");
    expect(sniffImageMimeType(WEBP)).toBe("image/webp");
    expect(sniffImageMimeType(GIF)).toBe("image/gif");
    expect(sniffImageMimeType(HEIC)).toBe("image/heic");
    expect(sniffImageMimeType(AVIF)).toBe("image/avif");
  });

  test("returns null for unknown or truncated bytes", () => {
    expect(sniffImageMimeType(new Uint8Array([0x00, 0x01]))).toBeNull();
    expect(sniffImageMimeType(new Uint8Array(0))).toBeNull();
  });
});

describe("toSendableImage round-trip", () => {
  const failIfTranscoded: ImageTranscoder = async () => {
    throw new Error("provider-safe bytes must not be re-encoded");
  };

  test("provider-safe bytes pass through untouched (bytes in = bytes out)", async () => {
    for (const bytes of [JPEG, PNG, WEBP, GIF]) {
      const base64 = toBase64(bytes);
      const sent = await toSendableImage(
        { uri: "file:///tmp/a.img", base64, mimeType: undefined },
        failIfTranscoded,
      );
      expect(sent === null).toBe(false);
      // Exact same base64 — no double-encode, no truncation.
      expect(sent!.base64).toBe(base64);
      expect(standardBase64ToBytes(sent!.base64)).toEqual(bytes);
      expect(PROVIDER_SAFE_IMAGE_MIME_TYPES.has(sent!.mimeType)).toBe(true);
      expect(sniffImageMimeType(standardBase64ToBytes(sent!.base64))).toBe(sent!.mimeType);
    }
  });

  test("HEIC library pick is re-encoded to a decodable format", async () => {
    const heicBase64 = toBase64(HEIC);
    const jpegBase64 = toBase64(JPEG);
    const transcode: ImageTranscoder = async ({ uri, base64, mimeType }) => {
      expect(uri).toBe("file:///photo.heic");
      expect(base64).toBe(heicBase64);
      expect(mimeType).toBe("image/heic");
      return { base64: jpegBase64, mimeType: "image/jpeg" };
    };
    const sent = await toSendableImage(
      { uri: "file:///photo.heic", base64: heicBase64, mimeType: "image/heic" },
      transcode,
    );
    expect(sent).toEqual({ base64: jpegBase64, mimeType: "image/jpeg" });
    expect(sniffImageMimeType(standardBase64ToBytes(sent!.base64))).toBe("image/jpeg");
  });

  test("HEIC mislabeled as image/jpeg is caught by magic-number sniffing", async () => {
    let sawTranscode = false;
    const transcode: ImageTranscoder = async ({ mimeType }) => {
      sawTranscode = true;
      expect(mimeType).toBe("image/heic");
      return { base64: toBase64(JPEG), mimeType: "image/jpeg" };
    };
    const sent = await toSendableImage(
      { uri: "file:///photo.jpg", base64: toBase64(HEIC), mimeType: "image/jpeg" },
      transcode,
    );
    expect(sawTranscode).toBe(true);
    expect(sent!.mimeType).toBe("image/jpeg");
  });

  test("falls back to original bytes with honest mime type when transcoding is unavailable", async () => {
    const heicBase64 = toBase64(HEIC);
    const unavailable: ImageTranscoder = async () => null;
    const sent = await toSendableImage(
      { uri: "file:///photo.heic", base64: heicBase64, mimeType: "image/jpeg" },
      unavailable,
    );
    // Never lie about the format even if we couldn't convert.
    expect(sent).toEqual({ base64: heicBase64, mimeType: "image/heic" });
  });

  test("returns null when the asset carries no base64 payload", async () => {
    expect(await toSendableImage({ uri: "file:///a.jpg", base64: null })).toBeNull();
    expect(await toSendableImage({ base64: "" })).toBeNull();
  });
});
