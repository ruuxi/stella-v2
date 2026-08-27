/**
 * Auth token helper for custom HTTP endpoints (e.g. /api/chat,
 * /api/speech-to-text/session).
 *
 * BetterAuth crossDomain stores session cookies in localStorage, NOT as browser
 * cookies. So `credentials: "include"` sends nothing to the Convex site domain.
 * Instead, we must fetch a Convex JWT via the BetterAuth token endpoint and
 * include it as an Authorization header.
 */

import { configurePiRuntime } from "@/platform/electron/device";
import { getJwtExpMs, parseJwtPayload } from "@/shared/lib/jwt";
import { authClient } from "@/global/auth/lib/auth-client";

let cachedToken: string | null = null;
let tokenExpiresAt = 0;
let inflightTokenPromise: Promise<string | null> | null = null;
let tokenRequestVersion = 0;

// JWT lifetime is ~30 minutes (server-minted); refresh 60s before the token's
// own `exp` (read dynamically below) to avoid races. The margin adapts to
// whatever expiry the token actually carries.
const REFRESH_MARGIN_MS = 60_000;

type GetConvexTokenOptions = {
  forceRefresh?: boolean;
};

/**
 * Get a valid Convex JWT for use in HTTP endpoint Authorization headers.
 * Caches the token and refreshes it before expiry.
 */
export async function getConvexToken(
  options: GetConvexTokenOptions = {},
): Promise<string | null> {
  const forceRefresh = options.forceRefresh ?? false;

  if (forceRefresh) {
    tokenRequestVersion += 1;
    cachedToken = null;
    tokenExpiresAt = 0;
    inflightTokenPromise = null;
  }

  if (!forceRefresh && cachedToken && Date.now() < tokenExpiresAt) {
    return cachedToken;
  }

  if (inflightTokenPromise) {
    return inflightTokenPromise;
  }

  const requestVersion = tokenRequestVersion;
  inflightTokenPromise = (async () => {
    try {
      if (typeof window === "undefined") return null;
      const systemApi = window.electronAPI?.system;
      let token: string | null | undefined;
      if (systemApi?.getConvexAuthToken) {
        await configurePiRuntime();
        token = await systemApi.getConvexAuthToken();
      } else {
        // Standalone web has no Electron host. Better Auth's Convex plugin
        // mints the same short-lived owner JWT directly from the browser
        // session, which is what the journal WebSocket authenticates with.
        const result = await authClient.convex.token();
        token = result.data?.token ?? null;
      }
      if (!token) {
        if (requestVersion === tokenRequestVersion) {
          cachedToken = null;
          tokenExpiresAt = 0;
        }
        return null;
      }

      if (requestVersion !== tokenRequestVersion) {
        return token;
      }

      cachedToken = token;
      // Parse JWT exp claim for precise refresh timing
      try {
        tokenExpiresAt = getJwtExpMs(token) - REFRESH_MARGIN_MS;
      } catch (err) {
        console.debug(
          "[auth-token] JWT parse failed, using 4-minute cache:",
          (err as Error).message,
        );
        tokenExpiresAt = Date.now() + 4 * 60 * 1000;
      }

      return token;
    } catch (err) {
      console.debug("[auth-token] token fetch failed:", (err as Error).message);
      if (requestVersion === tokenRequestVersion) {
        cachedToken = null;
        tokenExpiresAt = 0;
      }
      return null;
    } finally {
      if (requestVersion === tokenRequestVersion) {
        inflightTokenPromise = null;
      }
    }
  })();

  return inflightTokenPromise;
}

const tokenIdentifier = (token: string): string | null => {
  try {
    const payload = parseJwtPayload<{ iss?: unknown; sub?: unknown }>(token);
    if (
      typeof payload.iss !== "string" ||
      !payload.iss ||
      typeof payload.sub !== "string" ||
      !payload.sub
    ) {
      return null;
    }
    return `${payload.iss.replace(/\/+$/, "")}|${payload.sub}`;
  } catch {
    return null;
  }
};

/**
 * Returns a bearer token only when its signed issuer+subject matches the
 * renderer's immutable cloud owner. One forced refresh closes the common
 * account-switch cache race; a second mismatch fails closed.
 */
export async function getConvexTokenForSubject(
  expectedSubject: string,
): Promise<string | null> {
  const expected = expectedSubject.trim();
  if (!expected || expected !== expectedSubject) return null;
  let token = await getConvexToken();
  if (token && tokenIdentifier(token) === expected) return token;
  token = await getConvexToken({ forceRefresh: true });
  return token && tokenIdentifier(token) === expected ? token : null;
}

/**
 * Build headers for authenticated HTTP requests to Convex HTTP endpoints.
 */
export async function getAuthHeaders(
  extra?: Record<string, string>,
): Promise<Record<string, string>> {
  const token = await getConvexToken();
  return {
    ...extra,
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
}

/** Clear cached token (e.g. on sign-out). */
export function clearCachedToken(): void {
  tokenRequestVersion += 1;
  cachedToken = null;
  tokenExpiresAt = 0;
  inflightTokenPromise = null;
}
