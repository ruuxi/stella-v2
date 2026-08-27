import * as Crypto from "expo-crypto";

const toBase64Url = (bytes: Uint8Array): string => {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return globalThis
    .btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
};

export const generateClaimSecret = (): string =>
  toBase64Url(Crypto.getRandomBytes(32));

export const hashClaimSecret = async (secret: string): Promise<string> => {
  const hex = await Crypto.digestStringAsync(
    Crypto.CryptoDigestAlgorithm.SHA256,
    secret,
  );
  const bytes = new Uint8Array(hex.length / 2);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  }
  return toBase64Url(bytes);
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
