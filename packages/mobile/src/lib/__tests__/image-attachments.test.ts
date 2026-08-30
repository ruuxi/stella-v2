import { describe, expect, test } from "bun:test";
import {
  attachmentContentType,
  sniffImageMimeType,
} from "../image-attachments";

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

describe("attachmentContentType", () => {
  test("the sniffed type wins over a picker's declared one", () => {
    expect(attachmentContentType(HEIC, "image/jpeg")).toBe("image/heic");
    expect(attachmentContentType(PNG, "image/jpeg")).toBe("image/png");
    expect(attachmentContentType(AVIF, "application/octet-stream")).toBe(
      "image/avif",
    );
  });

  test("a non-image keeps the type the picker declared", () => {
    const pdf = makeBytes([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37]);
    expect(attachmentContentType(pdf, "application/pdf")).toBe(
      "application/pdf",
    );
  });

  test("truncated bytes fall back rather than guess", () => {
    expect(attachmentContentType(new Uint8Array(0), "image/png")).toBe(
      "image/png",
    );
  });
});
