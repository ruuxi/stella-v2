/**
 * Verifying a user's Convex (Better Auth) JWT inside workerd.
 *
 * This is the only user-authenticated door into this worker, so the rules it
 * enforces are written out rather than implied:
 *
 * - RS256 only, taken from the JWKS at `${issuer}/api/auth/convex/jwks`. That
 *   endpoint serves public keys; the `JWKS` Convex env var is the PRIVATE key
 *   set and must never be read from here or bound into this worker.
 * - The issuer is PINNED by the caller (STELLA_CONVEX_SITE_URL) and compared
 *   against the token's `iss`. The ownerId is then built from the pinned value,
 *   never from the token's self-asserted one — the same rule
 *   `tokenIdentifierForBetterAuthUserId` follows in convex/auth.ts.
 * - `aud` must be "convex" (the applicationID Better Auth's convex plugin
 *   signs with). A token minted for some other audience is not a login here.
 *
 * The cache has an escape hatch the in-repo connector helper lacks: an unknown
 * `kid` triggers at most one refetch per JWKS_MIN_REFETCH_MS, single-flighted.
 * Without it a key rotation produces a full cache lifetime of 401s for every
 * signed-in user at once.
 */

import { CLOCK_SKEW_S, JWKS_MIN_REFETCH_MS, JWKS_TTL_MS } from "./conversation-types.js";

export type VerifiedToken = {
  /** `${issuer}|${sub}` — matches Convex's `identity.tokenIdentifier`. */
  ownerId: string;
  subject: string;
  sessionId: string;
  expiresAtMs: number;
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
       * would make every client give up permanently during a Convex blip.
       */
      retryable: boolean;
    };

const JWKS_PATH = "/api/auth/convex/jwks";

export const jwksUrlFor = (issuer: string): string =>
  `${issuer.replace(/\/+$/, "")}${JWKS_PATH}`;

type JwkEntry = { kid: string; jwk: JsonWebKey };

type JwksCacheEntry = {
  keys: JwkEntry[];
  fetchedAtMs: number;
  /** Imported CryptoKeys, keyed by kid, discarded whenever `keys` is replaced. */
  imported: Map<string, CryptoKey>;
};

// Module-global, so every request in this isolate shares one cache and one
// in-flight fetch. A cold start just refetches.
const jwksCache = new Map<string, JwksCacheEntry>();
const jwksInflight = new Map<string, Promise<JwksCacheEntry>>();

const fetchJwks = async (url: string): Promise<JwksCacheEntry> => {
  const inflight = jwksInflight.get(url);
  if (inflight) return inflight;
  const pending = (async (): Promise<JwksCacheEntry> => {
    const response = await fetch(url, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) {
      throw new Error(`JWKS fetch failed with ${response.status}.`);
    }
    const body = (await response.json()) as { keys?: unknown };
    const keys: JwkEntry[] = [];
    if (Array.isArray(body.keys)) {
      for (const raw of body.keys) {
        if (typeof raw !== "object" || raw === null) continue;
        const jwk = raw as JsonWebKey & { kid?: unknown; kty?: unknown };
        if (typeof jwk.kid !== "string" || jwk.kty !== "RSA") continue;
        keys.push({ kid: jwk.kid, jwk });
      }
    }
    const entry: JwksCacheEntry = {
      keys,
      fetchedAtMs: Date.now(),
      imported: new Map(),
    };
    jwksCache.set(url, entry);
    return entry;
  })().finally(() => {
    jwksInflight.delete(url);
  });
  jwksInflight.set(url, pending);
  return pending;
};

/**
 * Cached keys, refreshed when stale or when `wantedKid` is absent — the second
 * condition is the rotation escape hatch, rate-limited so an unknown kid from
 * a forged token cannot be used to hammer the JWKS endpoint.
 */
const resolveJwks = async (
  url: string,
  wantedKid: string,
): Promise<JwksCacheEntry> => {
  const cached = jwksCache.get(url);
  const now = Date.now();
  if (!cached) return await fetchJwks(url);
  const stale = now - cached.fetchedAtMs >= JWKS_TTL_MS;
  const missing = !cached.keys.some((key) => key.kid === wantedKid);
  const mayRefetch = now - cached.fetchedAtMs >= JWKS_MIN_REFETCH_MS;
  if (stale || (missing && mayRefetch)) {
    try {
      return await fetchJwks(url);
    } catch (error) {
      // A refresh failure must not invalidate keys that still work: an expired
      // cache with a matching kid beats a hard 401 for every user.
      if (!missing) return cached;
      throw error;
    }
  }
  return cached;
};

const importKey = async (
  entry: JwksCacheEntry,
  kid: string,
): Promise<CryptoKey | null> => {
  const existing = entry.imported.get(kid);
  if (existing) return existing;
  const found = entry.keys.find((key) => key.kid === kid);
  if (!found) return null;
  const key = await crypto.subtle.importKey(
    "jwk",
    found.jwk,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["verify"],
  );
  entry.imported.set(kid, key);
  return key;
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
    const parsed = JSON.parse(new TextDecoder().decode(base64UrlToBytes(segment)));
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
 * @param issuer the PINNED Convex site origin. Never the token's own `iss`.
 */
export const verifyConvexToken = async (
  token: string,
  issuer: string,
): Promise<VerifyResult> => {
  const pinnedIssuer = issuer.replace(/\/+$/, "");
  if (!pinnedIssuer) return fail("no_issuer_configured", true);
  const parts = token.split(".");
  if (parts.length !== 3) return fail("malformed");

  const header = decodeSegment(parts[0]!);
  const payload = decodeSegment(parts[1]!);
  if (!header || !payload) return fail("malformed");

  // Checked before anything else: "alg":"none" and HMAC confusion both die
  // here, before a key is ever selected.
  if (header.alg !== "RS256") return fail("unsupported_alg");
  const kid = typeof header.kid === "string" ? header.kid : "";
  if (!kid) return fail("no_kid");

  const nowSeconds = Math.floor(Date.now() / 1000);
  const exp = typeof payload.exp === "number" ? payload.exp : null;
  if (exp === null) return fail("no_exp");
  if (nowSeconds > exp + CLOCK_SKEW_S) return fail("expired");
  if (typeof payload.nbf === "number" && nowSeconds < payload.nbf - CLOCK_SKEW_S) {
    return fail("not_yet_valid");
  }
  if (typeof payload.iat === "number" && nowSeconds < payload.iat - CLOCK_SKEW_S) {
    return fail("issued_in_future");
  }
  if (payload.iss !== pinnedIssuer) return fail("wrong_issuer");
  if (!audienceMatches(payload.aud, "convex")) return fail("wrong_audience");
  const subject = typeof payload.sub === "string" ? payload.sub.trim() : "";
  if (!subject) return fail("no_subject");

  let key: CryptoKey | null;
  try {
    const jwks = await resolveJwks(jwksUrlFor(pinnedIssuer), kid);
    key = await importKey(jwks, kid);
  } catch (error) {
    return fail(
      `jwks_unavailable:${error instanceof Error ? error.message : "unknown"}`,
      true,
    );
  }
  // Retryable, deliberately. An unknown kid is far more often "our cache is
  // one refetch behind a rotation" than "forged token", and JWKS_MIN_REFETCH_MS
  // means that state can persist for a minute per isolate. Reporting it as
  // unauthenticated would be terminal for the client, so a routine key roll
  // would lock every signed-in user out until they reloaded. A forged kid pays
  // only a backoff loop, and never triggers a JWKS fetch while throttled.
  if (!key) return fail("unknown_kid", true);

  const signature = base64UrlToBytes(parts[2]!);
  const signed = new TextEncoder().encode(`${parts[0]}.${parts[1]}`);
  let valid = false;
  try {
    valid = await crypto.subtle.verify(
      "RSASSA-PKCS1-v1_5",
      key,
      signature.buffer as ArrayBuffer,
      signed.buffer as ArrayBuffer,
    );
  } catch {
    return fail("verify_threw");
  }
  if (!valid) return fail("bad_signature");

  return {
    ok: true,
    token: {
      ownerId: `${pinnedIssuer}|${subject}`,
      subject,
      sessionId:
        typeof payload.sessionId === "string" ? payload.sessionId : "",
      expiresAtMs: exp * 1000,
    },
  };
};
