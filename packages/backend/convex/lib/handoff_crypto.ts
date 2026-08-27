// Crypto for the browser -> app session handoff (magic link, desktop social).
//
// The handoff row in `auth_link_requests` used to store a raw session cookie
// that /api/auth/link/status returned to anyone holding the `requestId`. Two
// independent controls replace that:
//
//   1. The client generates a `claimSecret`, sends only its SHA-256, and must
//      present the secret to claim. `requestId` alone is useless.
//   2. The token is encrypted at rest under BETTER_AUTH_SECRET, so a database
//      dump does not yield a usable credential either.
import { symmetricDecrypt, symmetricEncrypt } from "better-auth/crypto";

const getKey = () => {
  const secret = process.env.BETTER_AUTH_SECRET?.trim();
  if (!secret) {
    throw new Error("Missing BETTER_AUTH_SECRET");
  }
  return secret;
};

export const encryptHandoffToken = async (token: string): Promise<string> =>
  await symmetricEncrypt({ key: getKey(), data: token });

export const decryptHandoffToken = async (data: string): Promise<string> =>
  await symmetricDecrypt({ key: getKey(), data });

const BASE64URL_ALPHABET =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

const toBase64Url = (bytes: Uint8Array): string => {
  let bits = 0;
  let value = 0;
  let output = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 6) {
      bits -= 6;
      output += BASE64URL_ALPHABET[(value >>> bits) & 63];
    }
  }
  if (bits > 0) {
    output += BASE64URL_ALPHABET[(value << (6 - bits)) & 63];
  }
  return output;
};

/** base64url(SHA-256(value)), unpadded. Matches what clients send. */
export const sha256Base64Url = async (value: string): Promise<string> => {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return toBase64Url(new Uint8Array(digest));
};

/**
 * Length-independent comparison over a fixed window, so neither the length
 * nor a matching prefix of the stored hash leaks through response timing.
 */
export const hashesMatch = (a: string, b: string): boolean => {
  const encoder = new TextEncoder();
  const left = encoder.encode(a);
  const right = encoder.encode(b);
  let diff = left.length ^ right.length;
  for (let index = 0; index < 64; index += 1) {
    diff |= (left[index] ?? 0) ^ (right[index] ?? 0);
  }
  return diff === 0;
};
