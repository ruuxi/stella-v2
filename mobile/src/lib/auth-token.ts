import { authClient } from "./auth-client";
import { assert, assertObject } from "./assert";

let cachedToken = "";
let cachedTokenExpiresAt = 0;
let inflightTokenPromise: Promise<string> | null = null;
let activeIdentityKey: string | null = null;
// Bumped by clearCachedToken so a fetch already in flight at sign-out can't
// re-cache the previous account's JWT when it resolves.
let cacheGeneration = 0;

const REFRESH_MARGIN_MS = 60_000;

const decodeJwtPayload = (token: string) => {
  const payload = token.split(".")[1];
  assert(payload, "Token payload is unavailable.");
  assert(
    typeof globalThis.atob === "function",
    "Token payload is unavailable.",
  );
  const normalized = payload.replace(/-/g, "+").replace(/_/g, "/");
  const padding = "=".repeat((4 - (normalized.length % 4 || 4)) % 4);
  const parsed = JSON.parse(
    globalThis.atob(`${normalized}${padding}`),
  ) as unknown;
  assertObject(parsed, "Token payload is unavailable.");
  assert(typeof parsed.exp === "number", "Token expiration is unavailable.");
  return parsed.exp;
};

async function loadConvexToken() {
  const generation = cacheGeneration;
  const convex = (
    authClient as unknown as {
      convex: { token(): Promise<{ data?: { token?: string } }> };
    }
  ).convex;
  const result = await convex.token();
  const token = result.data?.token;
  assert(token, "You need to sign in again.");
  if (generation === cacheGeneration) {
    cachedToken = token;
    cachedTokenExpiresAt = decodeJwtPayload(token) * 1000 - REFRESH_MARGIN_MS;
  }
  return token;
}

export async function getConvexToken(options?: {
  forceRefresh?: boolean;
  identityKey?: string;
}): Promise<string> {
  if (
    options?.identityKey !== undefined &&
    options.identityKey !== activeIdentityKey
  ) {
    clearCachedToken();
    activeIdentityKey = options.identityKey;
  }
  if (
    options?.forceRefresh !== true &&
    cachedToken &&
    Date.now() < cachedTokenExpiresAt
  ) {
    return cachedToken;
  }

  if (inflightTokenPromise) {
    if (options?.forceRefresh !== true) return inflightTokenPromise;
    try {
      await inflightTokenPromise;
    } catch {
      // A forced refresh gets one independent attempt after the old one.
    }
  }

  const request = loadConvexToken().finally(() => {
    if (inflightTokenPromise === request) inflightTokenPromise = null;
  });
  inflightTokenPromise = request;

  return request;
}

export function clearCachedToken() {
  cachedToken = "";
  cachedTokenExpiresAt = 0;
  inflightTokenPromise = null;
  activeIdentityKey = null;
  cacheGeneration += 1;
}
