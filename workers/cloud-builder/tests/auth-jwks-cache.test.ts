import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { jwksUrlFor, resetJwksCacheForTests, verifyConvexToken } from "../src/auth-jwt.js";
import { JWKS_TTL_MS } from "../src/conversation-types.js";

const originalFetch = globalThis.fetch;
const originalCaches = Object.getOwnPropertyDescriptor(globalThis, "caches");
const issuer = "https://auth-cache.test";
const pair = await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048,
  publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"]);
const publicKey = await crypto.subtle.exportKey("jwk", pair.publicKey);
const encode = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
const token = async (kid = "one", subject = "test") => {
  const text = (value: unknown) => encode(new TextEncoder().encode(JSON.stringify(value)));
  const body = `${text({ alg: "RS256", kid })}.${text({ iss: issuer, aud: "convex", sub: subject, exp: Math.floor(Date.now() / 1000) + 600 })}`;
  return `${body}.${encode(new Uint8Array(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", pair.privateKey, new TextEncoder().encode(body))))}`;
};
const entries = new Map<string, Response>();
const installCache = () => Object.defineProperty(globalThis, "caches", { configurable: true, value: {
  open: async () => ({ match: async (url: string) => entries.get(url)?.clone(),
    put: async (url: string, response: Response) => { entries.set(url, response.clone()); } }),
} });
const saved = (fetchedAt: number, keys: unknown[] = [{ ...publicKey, kid: "one" }]) =>
  Response.json({ keys }, { headers: { "x-stella-jwks-fetched-at": String(fetchedAt) } });

describe("public signing keys across worker restart", () => {
  beforeEach(() => { entries.clear(); resetJwksCacheForTests(); installCache(); });
  afterEach(() => {
    globalThis.fetch = originalFetch;
    resetJwksCacheForTests();
    if (originalCaches) Object.defineProperty(globalThis, "caches", originalCaches);
    else Reflect.deleteProperty(globalThis, "caches");
  });

  test("a cold isolate verifies the signature from a fresh shared public key without origin I/O", async () => {
    let reads = 0;
    globalThis.fetch = (async () => { reads++; return Response.json({ keys: [{ ...publicKey, kid: "one" }] }); }) as typeof fetch;
    const jwt = await token();
    expect((await verifyConvexToken(jwt, issuer)).ok).toBe(true);
    const age = entries.get(jwksUrlFor(issuer))?.headers.get("x-stella-jwks-fetched-at");
    resetJwksCacheForTests();
    expect((await verifyConvexToken(jwt, issuer)).ok).toBe(true);
    expect(reads).toBe(1);
    expect(entries.get(jwksUrlFor(issuer))?.headers.get("x-stella-jwks-fetched-at")).toBe(age);
    const forged = jwt.split(".");
    forged[1] = encode(new TextEncoder().encode(JSON.stringify({ iss: issuer, aud: "convex", sub: "someone-else", exp: Math.floor(Date.now() / 1000) + 600 })));
    expect(await verifyConvexToken(forged.join("."), issuer)).toMatchObject({ ok: false, reason: "bad_signature" });
  });

  test("a missing key bypasses shared caching after the existing rotation cooldown", async () => {
    entries.set(jwksUrlFor(issuer), saved(Date.now() - 61_000));
    let reads = 0;
    globalThis.fetch = (async () => { reads++; return Response.json({ keys: [{ ...publicKey, kid: "two" }] }); }) as typeof fetch;
    expect((await verifyConvexToken(await token("two"), issuer)).ok).toBe(true);
    expect(reads).toBe(1);
    expect(await verifyConvexToken(await token("unknown"), issuer)).toMatchObject({ ok: false, reason: "unknown_kid" });
    expect(reads).toBe(1);
  });

  test("expired, future and non-signing shared keys cannot authorize while origin is unavailable", async () => {
    globalThis.fetch = (async () => { throw new Error("offline"); }) as typeof fetch;
    const jwt = await token();
    for (const response of [saved(Date.now() - JWKS_TTL_MS), saved(Date.now() + 60_000),
      saved(Date.now(), [{ ...publicKey, kid: "one", use: "enc" }]),
      saved(Date.now(), [{ ...publicKey, kid: "one", alg: "RSA-OAEP" }])]) {
      resetJwksCacheForTests(); entries.set(jwksUrlFor(issuer), response);
      expect(await verifyConvexToken(jwt, issuer)).toMatchObject({ ok: false, retryable: true });
    }
  });

  test("edge cache failure falls back to origin and never persists private key fields", async () => {
    Object.defineProperty(globalThis, "caches", { configurable: true, value: { open: async () => { throw new Error("cache unavailable"); } } });
    globalThis.fetch = (async () => Response.json({ keys: [{ ...publicKey, kid: "one", d: "must-not-be-cached" }] })) as typeof fetch;
    const jwt = await token();
    expect((await verifyConvexToken(jwt, issuer)).ok).toBe(true);
    resetJwksCacheForTests(); installCache();
    expect((await verifyConvexToken(jwt, issuer)).ok).toBe(true);
    expect(await entries.get(jwksUrlFor(issuer))?.text()).not.toContain("must-not-be-cached");
  });
});
