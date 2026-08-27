import { authClient } from "./auth-client";
import { assert } from "./assert";
import {
  decodeConvexTokenOwner,
  resolveConvexTokenOwner,
  type AuthenticatedConvexTokenOwner,
} from "./convex-token-owner";

let cachedToken = "";
let cachedTokenExpiresAt = 0;
let inflightTokenPromise: Promise<string> | null = null;
// Bumped by clearCachedToken so a fetch already in flight at sign-out can't
// re-cache the previous account's JWT when it resolves.
let cacheGeneration = 0;

const REFRESH_MARGIN_MS = 60_000;

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
    const claims = decodeConvexTokenOwner(token);
    cachedToken = token;
    cachedTokenExpiresAt = claims.expiresAtSeconds * 1000 - REFRESH_MARGIN_MS;
  }
  return token;
}

export async function getConvexToken(
  options: {
    forceRefresh?: boolean;
  } = {},
): Promise<string> {
  if (options.forceRefresh) {
    // Socket re-authentication must bypass both the settled token and an
    // account-bound fetch that may still be resolving from before a switch.
    clearCachedToken();
  }
  if (cachedToken && Date.now() < cachedTokenExpiresAt) {
    return cachedToken;
  }

  if (inflightTokenPromise) {
    return inflightTokenPromise;
  }

  const request = loadConvexToken();
  const tracked = request.finally(() => {
    // A force refresh may have installed a newer account/session request while
    // this one was resolving. Its finalizer must not clear that newer owner.
    if (inflightTokenPromise === tracked) inflightTokenPromise = null;
  });
  inflightTokenPromise = tracked;
  return tracked;
}

/**
 * Returns a token only when its signed subject matches the current UI owner.
 * One forced refresh closes the common A→B cache transition; a second mismatch
 * fails closed instead of sending B-labelled work with A's bearer token.
 */
export async function getConvexTokenForSubject(
  expectedSubject: string,
): Promise<string> {
  return (await getConvexTokenOwnerForSubject(expectedSubject)).token;
}

export type { AuthenticatedConvexTokenOwner } from "./convex-token-owner";

/**
 * Resolves the exact `${iss}|${sub}` owner from the authenticated session JWT.
 * A stale cached A-token gets one forced refresh before the request fails
 * closed. The server remains the authority that verifies the JWT signature.
 */
export async function getConvexTokenOwnerForSubject(
  expectedSubject: string,
): Promise<AuthenticatedConvexTokenOwner> {
  return await resolveConvexTokenOwner({
    expectedSubject,
    getToken: ({ forceRefresh }) => getConvexToken({ forceRefresh }),
  });
}

/** Returns a token only while both raw subject and exact tokenIdentifier match. */
export async function getConvexTokenForOwner(
  expectedSubject: string,
  expectedTokenIdentifier: string,
): Promise<string> {
  return (
    await resolveConvexTokenOwner({
      expectedSubject,
      expectedTokenIdentifier,
      getToken: ({ forceRefresh }) => getConvexToken({ forceRefresh }),
    })
  ).token;
}

export function clearCachedToken() {
  cachedToken = "";
  cachedTokenExpiresAt = 0;
  inflightTokenPromise = null;
  cacheGeneration += 1;
}
