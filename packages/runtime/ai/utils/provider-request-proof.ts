const SHA256_PATTERN = /^[a-f0-9]{64}$/u;

/** Hash a provider-owned request id before it leaves the adapter boundary. */
export const hashProviderRequestIdentity = async (
  requestId: string,
): Promise<string> => {
  const normalized = requestId.trim();
  if (!normalized) {
    throw new Error("Provider request identity is empty.");
  }
  const subtle = (
    globalThis as unknown as {
      crypto?: {
        subtle?: {
          digest: (algorithm: string, data: Uint8Array) => Promise<ArrayBuffer>;
        };
      };
    }
  ).crypto?.subtle;
  if (!subtle) {
    throw new Error("Web Crypto is unavailable for provider request proof.");
  }
  const digest = await subtle.digest(
    "SHA-256",
    new TextEncoder().encode(normalized),
  );
  const hex = Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  if (!SHA256_PATTERN.test(hex)) {
    throw new Error("Provider request proof digest is malformed.");
  }
  return hex;
};
