/**
 * Bot tokens at rest: AES-256-GCM under a key derived (HKDF-SHA-256) from
 * BETTER_AUTH_SECRET with a Slack-specific label, stored as
 * `v1.<iv>.<ciphertext>` in base64url.
 */

const encoder = new TextEncoder();

const b64url = (bytes: Uint8Array): string => {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replace(/\+/gu, "-")
    .replace(/\//gu, "_")
    .replace(/=+$/u, "");
};

const fromB64url = (value: string): Uint8Array => {
  const padded = value.replace(/-/gu, "+").replace(/_/gu, "/");
  const binary = atob(padded + "=".repeat((4 - (padded.length % 4)) % 4));
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
};

const tokenKey = async (env: Cloudflare.Env): Promise<CryptoKey> => {
  const secret = (env as unknown as Record<string, unknown>).BETTER_AUTH_SECRET;
  if (typeof secret !== "string" || !secret)
    throw new Error("BETTER_AUTH_SECRET is not configured.");
  const base = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    "HKDF",
    false,
    ["deriveKey"],
  );
  return await crypto.subtle.deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: encoder.encode("stella-slack"),
      info: encoder.encode("bot-token-v1"),
    },
    base,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
};

export const encryptToken = async (
  env: Cloudflare.Env,
  token: string,
): Promise<string> => {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const sealed = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    await tokenKey(env),
    encoder.encode(token),
  );
  return `v1.${b64url(iv)}.${b64url(new Uint8Array(sealed))}`;
};

export const decryptToken = async (
  env: Cloudflare.Env,
  sealed: string,
): Promise<string> => {
  const [version, iv, body] = sealed.split(".");
  if (version !== "v1" || !iv || !body)
    throw new Error("Unrecognized Slack token format.");
  const plain = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: fromB64url(iv) },
    await tokenKey(env),
    fromB64url(body),
  );
  return new TextDecoder().decode(plain);
};

const hmacHex = async (secret: string, message: string): Promise<string> => {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = new Uint8Array(
    await crypto.subtle.sign("HMAC", key, encoder.encode(message)),
  );
  return Array.from(signature, (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
};

const constantTimeEqual = (a: string, b: string): boolean => {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1)
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
};

/** Slack's `v0` request signature, with a five-minute replay window. */
export const verifySlackSignature = async (
  signingSecret: string,
  rawBody: string,
  timestamp: string | null,
  signature: string | null,
  nowMs = Date.now(),
): Promise<boolean> => {
  if (!timestamp || !signature || !/^\d{1,12}$/u.test(timestamp)) return false;
  if (Math.abs(nowMs / 1000 - Number(timestamp)) > 300) return false;
  const expected = `v0=${await hmacHex(signingSecret, `v0:${timestamp}:${rawBody}`)}`;
  return constantTimeEqual(expected, signature);
};

export const sha256Short = async (
  value: string,
  length = 40,
): Promise<string> => {
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", encoder.encode(value)),
  );
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, length);
};
