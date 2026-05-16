/**
 * Opaque hash for Linq sender phone numbers.
 *
 * Stella does not persist plaintext phone numbers. Wherever a Linq sender
 * phone is used as a lookup key (`channel_connections.externalUserId`,
 * `linq_chats.phoneHash`, the persisted `channelEnvelope.externalUserId`,
 * per-phone rate-limit keys), it is replaced with this opaque hash.
 *
 * HMAC-SHA256 with a server-only pepper (NOT plain SHA-256): the phone-number
 * preimage space is tiny (~10^10) and a leaked plain hash would be brute-
 * forceable in seconds. The pepper must live in Convex env vars only, never
 * the DB, and must never be rotated without re-linking every Linq connection.
 * The `linq_phone:v1:` prefix versions the scheme so we can rotate the pepper
 * by bumping to `v2` and accepting both during a migration window.
 *
 * Lives in its own module to avoid a circular import between `channels/linq.ts`
 * (consumes `processLinkCode` from `link_codes.ts`) and `link_codes.ts`
 * (needs to hash the phone before writing the connection in `verifyLinqLinkCode`).
 */
import { hmacSha256Hex } from "../lib/crypto_utils";

const PHONE_HASH_PEPPER_ENV = "STELLA_PHONE_HASH_PEPPER";

export const hashLinqPhone = async (phone: string): Promise<string> => {
  const pepper = process.env[PHONE_HASH_PEPPER_ENV];
  if (!pepper) {
    throw new Error(
      `Missing ${PHONE_HASH_PEPPER_ENV} env var (required to hash Linq phone numbers).`,
    );
  }
  return await hmacSha256Hex(pepper, `linq_phone:v1:${phone}`);
};
