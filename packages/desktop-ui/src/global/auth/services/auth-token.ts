import { configurePiRuntime } from "@/platform/electron/device";
import { getJwtExpMs } from "@/shared/lib/jwt";

let cachedToken: string | null = null;
let tokenExpiresAt = 0;
let inflightTokenPromise: Promise<string | null> | null = null;
let tokenRequestVersion = 0;

const REFRESH_MARGIN_MS = 60_000;

type GetConvexTokenOptions = {
  forceRefresh?: boolean;
};

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
      await configurePiRuntime();
      const token = await window.electronAPI?.system.getConvexAuthToken?.();
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

export async function getAuthHeaders(
  extra?: Record<string, string>,
): Promise<Record<string, string>> {
  const token = await getConvexToken();
  return {
    ...extra,
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
}

export function clearCachedToken(): void {
  tokenRequestVersion += 1;
  cachedToken = null;
  tokenExpiresAt = 0;
  inflightTokenPromise = null;
}
