/**
 * Read-aloud HLS tickets: `<ownerHash>.<id>.<exp>.<sig>`, where `sig` is an
 * HMAC (`MEDIA_SIGNING_SECRET`) over the first three parts. A native player
 * fetches the playlist and its segments with no headers, so the ticket in the
 * path is the whole authorization. `ownerHash` is `sha256(ownerId)`: it keeps
 * the owner out of URLs and logs, binds the ticket to its owner, and makes
 * `tts/<ownerHash>.` the owner's prefix in `MEDIA` for purges.
 */

import { sha256Hex } from "../hash.js";

const TICKET_PATTERN = /^([0-9a-f]{64})\.([0-9a-f]{32})\.([0-9a-z]{1,12})\.([A-Za-z0-9_-]{43})$/u;

export type TtsTicket = { ticket: string; ownerHash: string; id: string; expiresAt: number };

export const mediaSigningSecret = (env: Cloudflare.Env): string | null => {
  const value = (env as unknown as Record<string, unknown>).MEDIA_SIGNING_SECRET;
  return typeof value === "string" && value.trim() ? value.trim() : null;
};

const hmac = async (secret: string, message: string): Promise<string> => {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message)));
  let binary = "";
  for (const byte of signature) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/gu, "-").replace(/\//gu, "_").replace(/=+$/u, "");
};

const constantTimeEqual = (a: string, b: string): boolean => {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
};

/** The owner's prefix for read-aloud objects in `MEDIA`. */
export const ttsOwnerPrefix = async (ownerId: string): Promise<string> => `tts/${await sha256Hex(ownerId)}.`;

export const ttsObjectKey = (ticket: string, file: string): string => `tts/${ticket}/${file}`;

export const signTtsTicket = async (
  secret: string,
  ownerId: string,
  expiresAt: number,
): Promise<TtsTicket> => {
  const ownerHash = await sha256Hex(ownerId);
  const id = crypto.randomUUID().replace(/-/gu, "");
  const body = `${ownerHash}.${id}.${expiresAt.toString(36)}`;
  return { ticket: `${body}.${await hmac(secret, body)}`, ownerHash, id, expiresAt };
};

/** The ticket's parts when its signature holds and it has not expired. */
export const verifyTtsTicket = async (
  secret: string,
  ticket: string,
  now: number,
): Promise<TtsTicket | null> => {
  const match = TICKET_PATTERN.exec(ticket);
  if (!match) return null;
  const [, ownerHash, id, exp, sig] = match;
  const expiresAt = Number.parseInt(exp!, 36);
  if (!Number.isFinite(expiresAt) || expiresAt <= now) return null;
  const expected = await hmac(secret, `${ownerHash}.${id}.${exp}`);
  if (!constantTimeEqual(expected, sig!)) return null;
  return { ticket, ownerHash: ownerHash!, id: id!, expiresAt };
};
