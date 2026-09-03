/**
 * Encode a rendered gradient frame as a PNG data URI.
 *
 * React Native has no canvas, so mobile shows the shared pixel buffer through
 * an <Image>. The encoder uses stored (uncompressed) deflate blocks: the frame
 * is small, the pixels are noisy by design (dither), and skipping compression
 * keeps this dependency-free and fast on Hermes.
 */
import {
  planGradientFrame,
  renderGradientPixels,
  type GradientFrameInput,
} from "./gradient";

// ─── Checksums ──────────────────────────────────────────────────────────

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array, start: number, end: number): number {
  let c = 0xffffffff;
  for (let i = start; i < end; i++)
    c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function adler32(bytes: Uint8Array): number {
  let a = 1;
  let b = 0;
  for (let i = 0; i < bytes.length; i++) {
    a = (a + bytes[i]) % 65521;
    b = (b + a) % 65521;
  }
  return ((b << 16) | a) >>> 0;
}

// ─── PNG assembly ───────────────────────────────────────────────────────

function writeU32(out: Uint8Array, offset: number, value: number): void {
  out[offset] = (value >>> 24) & 0xff;
  out[offset + 1] = (value >>> 16) & 0xff;
  out[offset + 2] = (value >>> 8) & 0xff;
  out[offset + 3] = value & 0xff;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  writeU32(out, 0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  writeU32(out, 8 + data.length, crc32(out, 4, 8 + data.length));
  return out;
}

/** zlib stream made of stored deflate blocks (no compression). */
function zlibStored(raw: Uint8Array): Uint8Array {
  const MAX = 65535;
  const blocks = Math.max(1, Math.ceil(raw.length / MAX));
  const out = new Uint8Array(2 + raw.length + blocks * 5 + 4);
  let o = 0;
  out[o++] = 0x78; // CMF: deflate, 32K window
  out[o++] = 0x01; // FLG: no dict, fastest, check bits valid
  for (let i = 0; i < blocks; i++) {
    const start = i * MAX;
    const len = Math.min(MAX, raw.length - start);
    out[o++] = i === blocks - 1 ? 1 : 0; // BFINAL, BTYPE=00
    out[o++] = len & 0xff;
    out[o++] = (len >>> 8) & 0xff;
    out[o++] = ~len & 0xff;
    out[o++] = (~len >>> 8) & 0xff;
    out.set(raw.subarray(start, start + len), o);
    o += len;
  }
  writeU32(out, o, adler32(raw));
  return out;
}

/** Encode an opaque RGBA buffer as an RGB PNG. */
export function encodePng(
  pixels: Uint8ClampedArray,
  w: number,
  h: number,
): Uint8Array {
  const stride = w * 3;
  const raw = new Uint8Array((stride + 1) * h);
  for (let y = 0; y < h; y++) {
    const row = y * (stride + 1);
    raw[row] = 0; // filter: none
    let src = y * w * 4;
    let dst = row + 1;
    for (let x = 0; x < w; x++) {
      raw[dst++] = pixels[src];
      raw[dst++] = pixels[src + 1];
      raw[dst++] = pixels[src + 2];
      src += 4;
    }
  }

  const ihdr = new Uint8Array(13);
  writeU32(ihdr, 0, w);
  writeU32(ihdr, 4, h);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // color type: truecolor
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace

  const signature = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
  const parts = [
    signature,
    chunk("IHDR", ihdr),
    chunk("IDAT", zlibStored(raw)),
    chunk("IEND", new Uint8Array(0)),
  ];
  const total = parts.reduce((n, p) => n + p.length, 0);
  const png = new Uint8Array(total);
  let o = 0;
  for (const p of parts) {
    png.set(p, o);
    o += p.length;
  }
  return png;
}

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

export function bytesToBase64(bytes: Uint8Array): string {
  let out = "";
  let i = 0;
  for (; i + 2 < bytes.length; i += 3) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
    out +=
      B64[(n >>> 18) & 63] +
      B64[(n >>> 12) & 63] +
      B64[(n >>> 6) & 63] +
      B64[n & 63];
  }
  if (i < bytes.length) {
    const n =
      (bytes[i] << 16) | ((i + 1 < bytes.length ? bytes[i + 1] : 0) << 8);
    out += B64[(n >>> 18) & 63] + B64[(n >>> 12) & 63];
    out += i + 1 < bytes.length ? B64[(n >>> 6) & 63] : "=";
    out += "=";
  }
  return out;
}

export interface GradientImage {
  uri: string;
  /** Buffer dimensions the image was rendered at. */
  width: number;
  height: number;
}

/**
 * Render a gradient frame for a `width` × `height` surface into a PNG data
 * URI. `scale` picks the buffer resolution; the blobs are smooth enough that
 * the display's bilinear upscale hides it.
 */
export function renderGradientImage(
  input: GradientFrameInput,
  width: number,
  height: number,
  scale: number,
): GradientImage {
  const w = Math.max(1, Math.round(width * scale));
  const h = Math.max(1, Math.round(height * scale));
  const pixels = new Uint8ClampedArray(w * h * 4);
  const { bg, blobs } = planGradientFrame(input);
  renderGradientPixels(pixels, w, h, bg, blobs);
  const png = encodePng(pixels, w, h);
  return {
    uri: `data:image/png;base64,${bytesToBase64(png)}`,
    width: w,
    height: h,
  };
}
