/**
 * Client half of the browser -> app session handoff.
 *
 * The client generates a high-entropy `claimSecret`, keeps it in memory, and
 * sends only its SHA-256 when starting the handoff. The completed handoff is
 * then exchanged for a bearer token at /api/auth/link/claim.
 *
 * This is what stops `requestId` alone from being enough to take the session:
 * `/link/status` no longer returns a credential at all.
 */

const toBase64Url = (bytes: Uint8Array): string => {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
};

/** A fresh 32-byte secret. Never persisted — it lives only for this attempt. */
export const generateClaimSecret = (): string =>
  toBase64Url(crypto.getRandomValues(new Uint8Array(32)));

/** base64url(SHA-256(secret)), unpadded — what the server stores. */
export const hashClaimSecret = async (secret: string): Promise<string> => {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(secret),
  );
  return toBase64Url(new Uint8Array(digest));
};

/**
 * Exchange a completed handoff for its bearer token. Single-use server-side,
 * so a failure here is terminal for this attempt.
 */
export const claimSessionToken = async (
  convexSiteUrl: string,
  requestId: string,
  claimSecret: string,
): Promise<string | null> => {
  const response = await fetch(`${convexSiteUrl}/api/auth/link/claim`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ requestId, claimSecret }),
  });
  if (!response.ok) {
    return null;
  }
  const data = (await response.json().catch(() => null)) as {
    token?: string;
  } | null;
  return typeof data?.token === "string" && data.token.trim()
    ? data.token.trim()
    : null;
};
