export const sha256BytesHex = async (
  value: Uint8Array<ArrayBufferLike>,
): Promise<string> => {
  // Copy into an owned ArrayBuffer so the Web Crypto BufferSource contract
  // never receives a SharedArrayBuffer-backed view.
  const input = new Uint8Array(value.byteLength);
  input.set(value);
  const bytes = await crypto.subtle.digest(
    "SHA-256",
    input,
  );
  return Array.from(new Uint8Array(bytes), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
};

export const sha256Hex = async (value: string): Promise<string> =>
  sha256BytesHex(new TextEncoder().encode(value));

const canonicalize = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== "object") return value;
  const source = value as Record<string, unknown>;
  return Object.fromEntries(
    Object.keys(source)
      .sort()
      .map((key) => [key, canonicalize(source[key])]),
  );
};

/** Key-order-independent digest of a JSON value. */
export const stableValueMarker = async (value: unknown): Promise<string> =>
  `sha256:${await sha256Hex(JSON.stringify(canonicalize(value)))}`;
