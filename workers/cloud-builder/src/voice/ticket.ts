/**
 * Read-aloud HLS tickets: `<ownerHash>.<id>.<exp>`, where `id` is 256 random
 * bits. A native player fetches the playlist and its segments with no
 * headers, so the ticket in the path is the whole authorization: it names the
 * stream's objects in `MEDIA` (`tts/<ticket>/…`), which exist only for a
 * ticket Stella issued, and an unguessable id is what keeps anyone else from
 * naming them. Changing any part, the expiry included, names objects that do
 * not exist. `ownerHash` is `sha256(ownerId)`: it keeps the owner out of URLs
 * and logs, binds the ticket to its owner, and makes `tts/<ownerHash>.` the
 * owner's prefix in `MEDIA` for purges.
 */

import { sha256Hex } from "../hash.js";

const TICKET_PATTERN = /^([0-9a-f]{64})\.([0-9a-f]{64})\.([0-9a-z]{1,12})$/u;

export type TtsTicket = { ticket: string; ownerHash: string; id: string; expiresAt: number };

/** The owner's prefix for read-aloud objects in `MEDIA`. */
export const ttsOwnerPrefix = async (ownerId: string): Promise<string> => `tts/${await sha256Hex(ownerId)}.`;

export const ttsObjectKey = (ticket: string, file: string): string => `tts/${ticket}/${file}`;

export const mintTtsTicket = async (ownerId: string, expiresAt: number): Promise<TtsTicket> => {
  const ownerHash = await sha256Hex(ownerId);
  const id = `${crypto.randomUUID()}${crypto.randomUUID()}`.replace(/-/gu, "");
  return { ticket: `${ownerHash}.${id}.${expiresAt.toString(36)}`, ownerHash, id, expiresAt };
};

/** The ticket's parts when it is well formed and has not expired. */
export const readTtsTicket = (ticket: string, now: number): TtsTicket | null => {
  const match = TICKET_PATTERN.exec(ticket);
  if (!match) return null;
  const [, ownerHash, id, exp] = match;
  const expiresAt = Number.parseInt(exp!, 36);
  if (!Number.isFinite(expiresAt) || expiresAt <= now) return null;
  return { ticket, ownerHash: ownerHash!, id: id!, expiresAt };
};
