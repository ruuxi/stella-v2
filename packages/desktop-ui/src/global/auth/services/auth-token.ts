/**
 * The short-lived owner JWT every backend request carries as its bearer.
 *
 * Electron main mints it from the Better Auth session it owns
 * (`auth:getToken`); a browser shell mints it from its own session through
 * Better Auth's JWT plugin (`GET /api/auth/token`). The JWT's `sub` is the
 * owner id.
 */

import { configurePiRuntime } from "@/platform/electron/device";
import { getStellaInteriorBridge } from "@/platform/interior/interior-bridge";
import { getJwtExpMs, parseJwtPayload } from "@/shared/lib/jwt";
import { authClient } from "@/global/auth/lib/auth-client";

let cachedToken: string | null = null;
let tokenExpiresAt = 0;
let inflightTokenPromise: Promise<string | null> | null = null;
let tokenRequestVersion = 0;

// JWT lifetime is ~15 minutes (server-minted); refresh 60s before the token's
// own `exp` (read dynamically below) to avoid races. The margin adapts to
// whatever expiry the token actually carries.
const REFRESH_MARGIN_MS = 60_000;

type GetAuthTokenOptions = {
  forceRefresh?: boolean;
};

const invalidateTokenCache = (): void => {
  tokenRequestVersion += 1;
  cachedToken = null;
  tokenExpiresAt = 0;
  inflightTokenPromise = null;
};

/**
 * Get a valid owner JWT for use in backend Authorization headers.
 * Caches the token and refreshes it before expiry.
 */
export async function getAuthToken(
  options: GetAuthTokenOptions = {},
): Promise<string | null> {
  const forceRefresh = options.forceRefresh ?? false;

  if (forceRefresh) {
    invalidateTokenCache();
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
      const interiorBridge = getStellaInteriorBridge();
      const systemApi = window.electronAPI?.system;
      let token: string | null | undefined;
      let scopedTokenExpiresAt: number | null = null;
      if (interiorBridge) {
        const scoped = await interiorBridge.getToken({ forceRefresh });
        token = scoped.token;
        scopedTokenExpiresAt = scoped.expiresAt;
      } else if (systemApi?.getAuthToken) {
        await configurePiRuntime();
        token = await systemApi.getAuthToken();
      } else {
        // Standalone web has no Electron host. Better Auth's JWT plugin mints
        // the same short-lived owner JWT directly from the browser session.
        const result = await authClient.token();
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
      if (scopedTokenExpiresAt !== null) {
        if (scopedTokenExpiresAt <= Date.now()) {
          cachedToken = null;
          tokenExpiresAt = 0;
          return null;
        }
        tokenExpiresAt = Math.max(
          Date.now(),
          scopedTokenExpiresAt - REFRESH_MARGIN_MS,
        );
      } else {
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

/** The owner id (`sub`) a token was minted for. */
const tokenSubject = (token: string): string | null => {
  try {
    const payload = parseJwtPayload<{ sub?: unknown }>(token);
    return typeof payload.sub === "string" && payload.sub ? payload.sub : null;
  } catch {
    return null;
  }
};

/**
 * Returns a bearer token only when its signed subject matches the renderer's
 * immutable cloud owner. One forced refresh closes the common
 * account-switch cache race; a second mismatch fails closed.
 */
export async function getAuthTokenForSubject(
  expectedSubject: string,
): Promise<string | null> {
  const expected = expectedSubject.trim();
  if (!expected || expected !== expectedSubject) return null;
  let token = await getAuthToken();
  if (getStellaInteriorBridge()) return token;
  if (token && tokenSubject(token) === expected) return token;
  token = await getAuthToken({ forceRefresh: true });
  return token && tokenSubject(token) === expected ? token : null;
}

/**
 * Build headers for authenticated HTTP requests to backend endpoints.
 */
export async function getAuthHeaders(
  extra?: Record<string, string>,
): Promise<Record<string, string>> {
  const token = await getAuthToken();
  return {
    ...extra,
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
}

/** Clear cached token (e.g. on sign-out). */
export function clearCachedToken(): void {
  invalidateTokenCache();
}
