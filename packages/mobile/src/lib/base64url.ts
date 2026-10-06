/** Unpadded base64url, for byte values that travel in URLs and JSON. */

const BASE64_URL_ALPHABET =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
const BASE64_URL_LOOKUP = new Map(
  [...BASE64_URL_ALPHABET].map((char, index) => [char, index]),
);

export const bytesToBase64Url = (bytes: Uint8Array) => {
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i] ?? 0;
    const b = bytes[i + 1] ?? 0;
    const c = bytes[i + 2] ?? 0;
    const n = (a << 16) | (b << 8) | c;
    out += BASE64_URL_ALPHABET[(n >> 18) & 63];
    out += BASE64_URL_ALPHABET[(n >> 12) & 63];
    if (i + 1 < bytes.length) out += BASE64_URL_ALPHABET[(n >> 6) & 63];
    if (i + 2 < bytes.length) out += BASE64_URL_ALPHABET[n & 63];
  }
  return out;
};

export const base64UrlToBytes = (value: string) => {
  let buffer = 0;
  let bits = 0;
  const out: number[] = [];
  for (const char of value) {
    const next = BASE64_URL_LOOKUP.get(char);
    if (next === undefined) {
      throw new Error("Invalid base64url value");
    }
    buffer = (buffer << 6) | next;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out.push((buffer >> bits) & 0xff);
    }
  }
  return new Uint8Array(out);
};
