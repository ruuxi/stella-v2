import { CLOCK_SKEW_S, JWKS_MIN_REFETCH_MS, JWKS_TTL_MS } from "./constants.js";

export type VerifyResult =
  | { ok: true; ownerId: string }
  | { ok: false; reason: string; retryable: boolean };

type Entry = {
  keys: Array<{ kid: string; jwk: JsonWebKey }>;
  imported: Map<string, CryptoKey>;
  fetchedAt: number;
};

const cache = new Map<string, Entry>();
const inflight = new Map<string, Promise<Entry>>();
const fail = (reason: string, retryable = false): VerifyResult => ({ ok: false, reason, retryable });

export const jwksUrlFor = (issuer: string): string =>
  `${issuer.replace(/\/+$/, "")}/api/auth/convex/jwks`;

const fetchKeys = async (url: string): Promise<Entry> => {
  const active = inflight.get(url);
  if (active) return await active;
  const request = (async () => {
    const response = await fetch(url, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error("jwks_http_error");
    const body: unknown = await response.json();
    const rawKeys = typeof body === "object" && body !== null && "keys" in body
      ? body.keys
      : null;
    const keys: Entry["keys"] = [];
    if (Array.isArray(rawKeys)) {
      for (const raw of rawKeys) {
        if (typeof raw !== "object" || raw === null) continue;
        const jwk = raw as JsonWebKey & { kid?: unknown; kty?: unknown; use?: unknown };
        if (typeof jwk.kid === "string" && jwk.kty === "RSA" && (jwk.use === undefined || jwk.use === "sig")) {
          keys.push({ kid: jwk.kid, jwk });
        }
      }
    }
    const entry: Entry = { keys, imported: new Map(), fetchedAt: Date.now() };
    cache.set(url, entry);
    return entry;
  })().finally(() => inflight.delete(url));
  inflight.set(url, request);
  return await request;
};

const resolveKeys = async (url: string, kid: string): Promise<Entry> => {
  const current = cache.get(url);
  if (!current) return await fetchKeys(url);
  const age = Date.now() - current.fetchedAt;
  const missing = !current.keys.some((key) => key.kid === kid);
  if (age >= JWKS_TTL_MS || (missing && age >= JWKS_MIN_REFETCH_MS)) {
    try {
      return await fetchKeys(url);
    } catch {
      if (!missing) return current;
      throw new Error("jwks_unavailable");
    }
  }
  return current;
};

const decode = (value: string): Uint8Array => {
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, "="));
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
};

const objectSegment = (value: string): Record<string, unknown> | null => {
  try {
    const parsed: unknown = JSON.parse(new TextDecoder().decode(decode(value)));
    return typeof parsed === "object" && parsed !== null
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
};

const matchesAudience = (value: unknown): boolean =>
  value === "convex" || (Array.isArray(value) && value.includes("convex"));

export const verifyConvexToken = async (token: string, configuredIssuer: string): Promise<VerifyResult> => {
  const issuer = configuredIssuer.replace(/\/+$/, "");
  if (!issuer) return fail("issuer_not_configured", true);
  const parts = token.split(".");
  if (parts.length !== 3) return fail("malformed");
  const header = objectSegment(parts[0]!);
  const payload = objectSegment(parts[1]!);
  if (!header || !payload || header.alg !== "RS256") return fail("malformed_or_alg");
  const kid = typeof header.kid === "string" ? header.kid : "";
  const subject = typeof payload.sub === "string" ? payload.sub.trim() : "";
  const exp = typeof payload.exp === "number" ? payload.exp : null;
  if (!kid || !subject || exp === null) return fail("missing_claim");
  const now = Math.floor(Date.now() / 1000);
  if (now > exp + CLOCK_SKEW_S) return fail("expired");
  if (typeof payload.nbf === "number" && now < payload.nbf - CLOCK_SKEW_S) return fail("not_yet_valid");
  if (typeof payload.iat === "number" && now < payload.iat - CLOCK_SKEW_S) return fail("issued_in_future");
  if (payload.iss !== issuer) return fail("wrong_issuer");
  if (!matchesAudience(payload.aud)) return fail("wrong_audience");

  let entry: Entry;
  try {
    entry = await resolveKeys(jwksUrlFor(issuer), kid);
  } catch {
    return fail("jwks_unavailable", true);
  }
  let key = entry.imported.get(kid);
  if (!key) {
    const found = entry.keys.find((candidate) => candidate.kid === kid);
    if (!found) return fail("unknown_kid", true);
    try {
      key = await crypto.subtle.importKey(
        "jwk",
        found.jwk,
        { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
        false,
        ["verify"],
      );
    } catch {
      return fail("invalid_jwk", true);
    }
    entry.imported.set(kid, key);
  }
  try {
    const valid = await crypto.subtle.verify(
      "RSASSA-PKCS1-v1_5",
      key,
      decode(parts[2]!),
      new TextEncoder().encode(`${parts[0]}.${parts[1]}`),
    );
    return valid ? { ok: true, ownerId: `${issuer}|${subject}` } : fail("bad_signature");
  } catch {
    return fail("bad_signature");
  }
};

/** Test-only cache reset; harmless in production and avoids exporting cache state. */
export const resetJwksCacheForTest = (): void => {
  cache.clear();
  inflight.clear();
};
