/**
 * Verifying a user's Stella JWT inside workerd.
 *
 * This is the user-authenticated door into this worker, so the rules it
 * enforces are written out rather than implied:
 *
 * - RS256 only, under this worker's own Better Auth keys (src/auth/), read
 *   in process with `auth.api.getJwks()`.
 * - `iss` must equal this worker's public URL (CLOUD_BUILDER_PUBLIC_URL) and
 *   `aud` must be "stella". A token minted for some other audience is not a
 *   login here.
 * - The owner id is `sub`, the Better Auth user id.
 *
 * An unknown `kid` refetches the keys at most once per JWKS_MIN_REFETCH_MS,
 * single-flighted, so a key rotation does not lock out every signed-in user.
 */

import type { IdentityLevel } from "@stella/contracts/gateway/api";
import { CLOCK_SKEW_S, JWKS_MIN_REFETCH_MS } from "./conversation-types.js";

export type VerifiedToken = {
  /** The owner id: `sub`, the Better Auth user id. */
  ownerId: string;
  subject: string;
  sessionId: string;
  expiresAtMs: number;
  isAnonymous: boolean;
  /** 0 anonymous, 1 email, 2 social. */
  identityLevel: IdentityLevel;
  /** `iat` in ms; 0 when absent. */
  issuedAtMs: number;
};

export type VerifyResult =
  | { ok: true; token: VerifiedToken }
  | {
      ok: false;
      /** Log-only. Never a user-facing string and never echoed to a client. */
      reason: string;
      /**
       * True when the failure is ours (JWKS unreachable), not the caller's.
       * A retryable failure must not be reported as "unauthenticated" — that
       * would make every client give up permanently during a blip.
       */
      retryable: boolean;
    };

type JwkEntry = { kid: string; jwk: JsonWebKey };

const parsePublicKeys = (body: unknown): JwkEntry[] => {
  if (
    !body ||
    typeof body !== "object" ||
    !("keys" in body) ||
    !Array.isArray(body.keys)
  )
    return [];
  const keys: JwkEntry[] = [];
  for (const raw of body.keys) {
    if (
      !raw ||
      typeof raw !== "object" ||
      !("kid" in raw) ||
      typeof raw.kid !== "string" ||
      !("kty" in raw) ||
      raw.kty !== "RSA" ||
      !("n" in raw) ||
      typeof raw.n !== "string" ||
      !("e" in raw) ||
      typeof raw.e !== "string"
    )
      continue;
    if (
      ("alg" in raw && raw.alg !== "RS256") ||
      ("use" in raw && raw.use !== "sig") ||
      ("key_ops" in raw &&
        (!Array.isArray(raw.key_ops) || !raw.key_ops.includes("verify")))
    )
      continue;
    // Retain only public RSA verification material, never any private fields.
    keys.push({ kid: raw.kid, jwk: { kty: "RSA", n: raw.n, e: raw.e } });
  }
  return keys;
};

const base64UrlToBytes = (value: string): Uint8Array => {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(padded.padEnd(Math.ceil(padded.length / 4) * 4, "="));
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
};

const decodeSegment = (segment: string): Record<string, unknown> | null => {
  try {
    const parsed = JSON.parse(
      new TextDecoder().decode(base64UrlToBytes(segment)),
    );
    return typeof parsed === "object" && parsed !== null
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
};

const audienceMatches = (audience: unknown, expected: string): boolean => {
  if (typeof audience === "string") return audience === expected;
  if (Array.isArray(audience)) {
    return audience.some((entry) => entry === expected);
  }
  return false;
};

const fail = (reason: string, retryable = false): VerifyResult => ({
  ok: false,
  reason,
  retryable,
});

/**
 * @param issuer the PINNED backend origin. Never the token's own `iss`.
 */

type UserKeys = { keys: Map<string, CryptoKey>; fetchedAtMs: number };

let userKeys: UserKeys | null = null;
let userKeysInflight: Promise<UserKeys> | null = null;

const importUserKeys = async (jwks: unknown): Promise<UserKeys> => {
  const keys = new Map<string, CryptoKey>();
  for (const { kid, jwk } of parsePublicKeys(jwks)) {
    keys.set(
      kid,
      await crypto.subtle.importKey("jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]),
    );
  }
  return { keys, fetchedAtMs: Date.now() };
};

/** Test seam: verify against these public keys instead of the worker's own. */
export const setUserJwksForTests = async (jwks: unknown | null): Promise<void> => {
  userKeys = jwks === null ? null : await importUserKeys(jwks);
};

const loadUserKeys = (env: Cloudflare.Env): Promise<UserKeys> =>
  (userKeysInflight ??= (async () => {
    const { createAuth } = await import("./auth/auth.js");
    return (userKeys = await importUserKeys(await createAuth(env).api.getJwks()));
  })().finally(() => {
    userKeysInflight = null;
  }));

/** The key for `kid`, refetching once per JWKS_MIN_REFETCH_MS when it is unknown (a rotation). */
const userKey = async (env: Cloudflare.Env, kid: string): Promise<CryptoKey | null> => {
  const cached = userKeys;
  const found = cached?.keys.get(kid);
  if (found) return found;
  if (cached && Date.now() - cached.fetchedAtMs < JWKS_MIN_REFETCH_MS) return null;
  return (await loadUserKeys(env)).keys.get(kid) ?? null;
};

/**
 * Verify a Stella JWT (`GET /api/auth/token`): RS256 under this worker's own
 * keys, `iss` equal to this worker's public URL, `aud` "stella". The owner id
 * is `sub`, the Better Auth user id.
 */
export const verifyUserToken = async (token: string, env: Cloudflare.Env): Promise<VerifyResult> => {
  const issuer = (env.CLOUD_BUILDER_PUBLIC_URL ?? "").trim().replace(/\/+$/, "");
  if (!issuer) return fail("no_issuer_configured", true);
  const parts = token.split(".");
  if (parts.length !== 3) return fail("malformed");
  const header = decodeSegment(parts[0]!);
  const payload = decodeSegment(parts[1]!);
  if (!header || !payload) return fail("malformed");
  if (header.alg !== "RS256") return fail("unsupported_alg");
  const kid = typeof header.kid === "string" ? header.kid : "";
  if (!kid) return fail("no_kid");
  const nowSeconds = Math.floor(Date.now() / 1000);
  const exp = typeof payload.exp === "number" ? payload.exp : null;
  if (exp === null) return fail("no_exp");
  if (nowSeconds > exp + CLOCK_SKEW_S) return fail("expired");
  if (typeof payload.nbf === "number" && nowSeconds < payload.nbf - CLOCK_SKEW_S) return fail("not_yet_valid");
  const iat = typeof payload.iat === "number" ? payload.iat : 0;
  if (nowSeconds < iat - CLOCK_SKEW_S) return fail("issued_in_future");
  if (payload.iss !== issuer) return fail("wrong_issuer");
  if (!audienceMatches(payload.aud, "stella")) return fail("wrong_audience");
  const subject = typeof payload.sub === "string" ? payload.sub.trim() : "";
  if (!subject) return fail("no_subject");

  let key: CryptoKey | null;
  try {
    key = await userKey(env, kid);
  } catch (error) {
    return fail(`jwks_unavailable:${error instanceof Error ? error.message : "unknown"}`, true);
  }
  // Retryable, deliberately: an unknown kid is far more often "our keys are
  // one refetch behind a rotation" than a forged token, and reporting it as
  // unauthenticated would be terminal for the client.
  if (!key) return fail("unknown_kid", true);
  let valid = false;
  try {
    valid = await crypto.subtle.verify(
      "RSASSA-PKCS1-v1_5",
      key,
      base64UrlToBytes(parts[2]!).buffer as ArrayBuffer,
      new TextEncoder().encode(`${parts[0]}.${parts[1]}`).buffer as ArrayBuffer,
    );
  } catch {
    return fail("verify_threw");
  }
  if (!valid) return fail("bad_signature");
  const anonymous = payload.anon === true;
  const idl = payload.idl;
  return {
    ok: true,
    token: {
      ownerId: subject,
      subject,
      sessionId: typeof payload.sid === "string" ? payload.sid : "",
      expiresAtMs: exp * 1000,
      isAnonymous: anonymous,
      identityLevel: anonymous ? 0 : idl === 1 || idl === 2 || idl === 3 ? idl : 1,
      issuedAtMs: iat * 1000,
    },
  };
};
