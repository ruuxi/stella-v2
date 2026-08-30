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
import { getStellaInteriorBridge } from "@/platform/interior/interior-bridge";
import { getJwtExpMs, parseJwtPayload } from "@/shared/lib/jwt";
import { authClient } from "@/global/auth/lib/auth-client";

let cachedToken: string | null = null;
let tokenExpiresAt = 0;
let inflightTokenPromise: Promise<string | null> | null = null;
let tokenRequestVersion = 0;
let activeValidatedIdentityKey: string | null = null;
let validatedIdentityVersion = 0;
let inflightValidatedRefresh: {
  identityKey: string;
  identityVersion: number;
  promise: Promise<string | null>;
} | null = null;

// JWT lifetime is ~30 minutes (server-minted); refresh 60s before the token's
// own `exp` (read dynamically below) to avoid races. The margin adapts to
// whatever expiry the token actually carries.
const REFRESH_MARGIN_MS = 60_000;

type GetConvexTokenOptions = {
  forceRefresh?: boolean;
};

type GetConvexTokenForIdentityOptions = GetConvexTokenOptions & {
  /**
   * Changes whenever the durable auth-session identity changes, even if a
   * user signs out and later returns as the same Better Auth subject.
   */
  identityRevision?: number;
};

const invalidateTokenCache = (): void => {
  tokenRequestVersion += 1;
  cachedToken = null;
  tokenExpiresAt = 0;
  inflightTokenPromise = null;
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
      } else if (systemApi?.getConvexAuthToken) {
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

type ParsedConvexTokenIdentity = {
  subject: string;
  isAnonymous: boolean;
};

const parseConvexTokenIdentity = (
  token: string,
): ParsedConvexTokenIdentity | null => {
  try {
    const payload = parseJwtPayload<{
      iss?: unknown;
      sub?: unknown;
      isAnonymous?: unknown;
    }>(token);
    if (
      typeof payload.iss !== "string" ||
      !payload.iss ||
      typeof payload.sub !== "string" ||
      !payload.sub ||
      typeof payload.isAnonymous !== "boolean"
    ) {
      return null;
    }
    return {
      subject: `${payload.iss.replace(/\/+$/, "")}|${payload.sub}`,
      isAnonymous: payload.isAnonymous,
    };
  } catch {
    return null;
  }
};

const validatedIdentityKey = (
  expectedSubject: string,
  expectedIsAnonymous: boolean,
  identityRevision: number | undefined,
) =>
  [
    expectedSubject,
    expectedIsAnonymous ? "anonymous" : "connected",
    typeof identityRevision === "number" &&
    Number.isSafeInteger(identityRevision)
      ? String(identityRevision)
      : "",
  ].join("\u0000");

const tokenMatchesIdentity = (
  token: string | null,
  expectedSubject: string,
  expectedIsAnonymous: boolean,
): token is string => {
  if (!token) return false;
  const identity = parseConvexTokenIdentity(token);
  return (
    identity?.subject === expectedSubject &&
    identity.isAnonymous === expectedIsAnonymous
  );
};

/**
 * Returns a bearer token only when issuer, subject, and anonymous-account state
 * all match the current renderer session. Activating a new identity invalidates
 * the untyped cache synchronously before any token is read. A later identity or
 * forced refresh also fences an older in-flight request from returning to its
 * caller.
 */
export async function getConvexTokenForIdentity(
  expectedSubject: string,
  expectedIsAnonymous: boolean,
  options: GetConvexTokenForIdentityOptions = {},
): Promise<string | null> {
  const expected = expectedSubject.trim();
  if (!expected || expected !== expectedSubject) return null;

  const identityKey = validatedIdentityKey(
    expected,
    expectedIsAnonymous,
    options.identityRevision,
  );
  if (activeValidatedIdentityKey !== identityKey) {
    activeValidatedIdentityKey = identityKey;
    validatedIdentityVersion += 1;
    inflightValidatedRefresh = null;
    invalidateTokenCache();
  }
  if (options.forceRefresh) {
    validatedIdentityVersion += 1;
    inflightValidatedRefresh = null;
  }

  const requestIdentityVersion = validatedIdentityVersion;
  const token = await getConvexToken({
    forceRefresh: options.forceRefresh ?? false,
  });
  if (
    activeValidatedIdentityKey !== identityKey ||
    validatedIdentityVersion !== requestIdentityVersion
  ) {
    return null;
  }
  if (getStellaInteriorBridge()) return token;
  if (tokenMatchesIdentity(token, expected, expectedIsAnonymous)) return token;
  if (options.forceRefresh) return null;

  // A same-identity caller may have populated the generic cache before this
  // strict check ran. Same-identity callers share one strict refresh. Only an
  // identity change or an explicit force refresh supersedes this work.
  const existingRefresh = inflightValidatedRefresh;
  if (
    existingRefresh?.identityKey === identityKey &&
    existingRefresh.identityVersion === requestIdentityVersion
  ) {
    return await existingRefresh.promise;
  }

  const refreshPromise = getConvexToken({ forceRefresh: true }).then(
    (refreshedToken) => {
      if (
        activeValidatedIdentityKey !== identityKey ||
        validatedIdentityVersion !== requestIdentityVersion
      ) {
        return null;
      }
      return tokenMatchesIdentity(refreshedToken, expected, expectedIsAnonymous)
        ? refreshedToken
        : null;
    },
  );
  const refresh = {
    identityKey,
    identityVersion: requestIdentityVersion,
    promise: refreshPromise,
  };
  inflightValidatedRefresh = refresh;
  void refreshPromise.finally(() => {
    if (inflightValidatedRefresh === refresh) {
      inflightValidatedRefresh = null;
    }
  });
  return await refreshPromise;
}

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
  if (getStellaInteriorBridge()) return token;
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
  activeValidatedIdentityKey = null;
  validatedIdentityVersion += 1;
  inflightValidatedRefresh = null;
  invalidateTokenCache();
}
