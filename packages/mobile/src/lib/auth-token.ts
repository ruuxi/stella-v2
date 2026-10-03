import { authClient } from "./auth-client";
import { assert } from "./assert";
import {
  decodeTokenOwner,
  resolveTokenOwner,
  type AuthenticatedTokenOwner,
} from "./token-owner";

let cachedToken = "";
let cachedTokenExpiresAt = 0;
let inflightTokenPromise: Promise<string> | null = null;
// Bumped by clearCachedToken so a fetch already in flight at sign-out can't
// re-cache the previous account's JWT when it resolves.
let cacheGeneration = 0;

const REFRESH_MARGIN_MS = 60_000;

async function loadAuthToken() {
  const generation = cacheGeneration;
  // Better Auth's jwt plugin mints the backend JWT at GET /api/auth/token.
  const result = await authClient.token();
  const token = result.data?.token;
  assert(token, "You need to sign in again.");
  if (generation === cacheGeneration) {
    const claims = decodeTokenOwner(token);
    cachedToken = token;
    cachedTokenExpiresAt = claims.expiresAtSeconds * 1000 - REFRESH_MARGIN_MS;
  }
  return token;
}

export async function getAuthToken(
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

  const request = loadAuthToken();
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
export async function getAuthTokenForSubject(
  expectedSubject: string,
): Promise<string> {
  return (await getTokenOwnerForSubject(expectedSubject)).token;
}

export type { AuthenticatedTokenOwner } from "./token-owner";

/**
 * Resolves the owner (the JWT `sub`) from the authenticated session JWT.
 * A stale cached A-token gets one forced refresh before the request fails
 * closed. The server remains the authority that verifies the JWT signature.
 */
export async function getTokenOwnerForSubject(
  expectedSubject: string,
): Promise<AuthenticatedTokenOwner> {
  return await resolveTokenOwner({
    expectedSubject,
    getToken: ({ forceRefresh }) => getAuthToken({ forceRefresh }),
  });
}

export function clearCachedToken() {
  cachedToken = "";
  cachedTokenExpiresAt = 0;
  inflightTokenPromise = null;
  cacheGeneration += 1;
}
