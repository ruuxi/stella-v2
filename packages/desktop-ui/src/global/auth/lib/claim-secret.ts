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

export const generateClaimSecret = (): string =>
  toBase64Url(crypto.getRandomValues(new Uint8Array(32)));

export const hashClaimSecret = async (secret: string): Promise<string> => {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(secret),
  );
  return toBase64Url(new Uint8Array(digest));
};

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
