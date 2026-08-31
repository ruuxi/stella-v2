const bytesToHex = (bytes: Uint8Array): string =>
  Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");

/**
 * Canonical privacy boundary shared with Convex telemetry producers.
 *
 * Convex Log Streams cannot carry the raw owner identifier, so backend
 * metrics publish this one-way key. Authenticated HTTP ingestion applies the
 * same transform before the environment-scoped HMAC. That keeps one person's
 * desktop and backend events joinable without exposing their account key.
 */
export const canonicalUserOwnerKey = async (
  ownerId: string,
): Promise<string> => {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`stella:telemetry-owner:v1\0${ownerId}`),
  );
  return bytesToHex(new Uint8Array(digest));
};

export const createPseudonymizer = async (
  secret: string,
  environment: string,
): Promise<(scope: string, value: string) => Promise<string>> => {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return async (scope, value) => {
    const payload = new TextEncoder().encode(`v1\0${environment}\0${scope}\0${value}`);
    const signature = await crypto.subtle.sign("HMAC", key, payload);
    return bytesToHex(new Uint8Array(signature));
  };
};
