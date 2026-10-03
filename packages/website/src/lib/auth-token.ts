"use client";

/**
 * Fetch and cache the short-lived backend JWT (`GET /api/auth/token`) that
 * authorizes the site's backend calls and views.
 */

import { authClient, hasSessionToken } from "./auth-client";

let cachedToken: string | null = null;
let tokenExpiresAt = 0;
let inflightTokenPromise: Promise<string | null> | null = null;

const REFRESH_MARGIN_MS = 60_000;

type GetAuthTokenOptions = {
  forceRefresh?: boolean;
};

export async function getAuthToken(
  options: GetAuthTokenOptions = {},
): Promise<string | null> {
  const forceRefresh = options.forceRefresh ?? false;

  if (!hasSessionToken()) {
    clearCachedToken();
    return null;
  }

  if (!forceRefresh && cachedToken && Date.now() < tokenExpiresAt) {
    return cachedToken;
  }

  if (inflightTokenPromise) {
    return inflightTokenPromise;
  }

  if (forceRefresh) {
    cachedToken = null;
    tokenExpiresAt = 0;
  }

  inflightTokenPromise = (async () => {
    try {
      const result = await authClient.token();
      const token = result.data?.token;
      if (!token) {
        cachedToken = null;
        tokenExpiresAt = 0;
        return null;
      }

      cachedToken = token;
      try {
        const payload = JSON.parse(
          atob((token.split(".")[1] ?? "").replace(/-/g, "+").replace(/_/g, "/")),
        );
        if (typeof payload.exp !== "number") {
          throw new Error("Missing exp claim");
        }
        tokenExpiresAt = payload.exp * 1000 - REFRESH_MARGIN_MS;
      } catch {
        tokenExpiresAt = Date.now() + 4 * 60 * 1000;
      }

      return token;
    } catch {
      cachedToken = null;
      tokenExpiresAt = 0;
      return null;
    } finally {
      inflightTokenPromise = null;
    }
  })();

  return inflightTokenPromise;
}

export function clearCachedToken(): void {
  cachedToken = null;
  tokenExpiresAt = 0;
  inflightTokenPromise = null;
}
