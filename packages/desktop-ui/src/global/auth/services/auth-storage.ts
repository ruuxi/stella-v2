/**
 * Where a browser shell keeps its Better Auth credential.
 *
 * Electron is deliberately excluded: the main process is the sole token
 * authority there, so every accessor below is inert when `electronAPI` exists.
 * A renderer copy of the bearer would be a second credential with no
 * revocation path.
 */

/** Opaque signed bearer issued by Better Auth's `bearer` plugin. */
export const BROWSER_SESSION_TOKEN_KEY = "better-auth_session_token";

/**
 * Keys written by the retired cross-domain cookie handoff. They are purged on
 * sight so an old mirrored session token cannot outlive the transport that
 * created it.
 */
const LEGACY_STORAGE_KEYS = [
  "better-auth_cookie",
  "better-auth_session_data",
] as const;

const purgeLegacyStorage = (): void => {
  for (const key of LEGACY_STORAGE_KEYS) {
    try {
      window.localStorage?.removeItem(key);
    } catch {
      // Best effort migration cleanup.
    }
  }
};

export const readBrowserSessionToken = (): string => {
  purgeLegacyStorage();
  if (window.electronAPI) return "";
  try {
    return window.localStorage.getItem(BROWSER_SESSION_TOKEN_KEY)?.trim() ?? "";
  } catch {
    return "";
  }
};

export const writeBrowserSessionToken = (token: string): void => {
  purgeLegacyStorage();
  if (window.electronAPI) {
    throw new Error("Browser auth storage is unavailable in Electron.");
  }
  const normalized = token.trim();
  if (!normalized) {
    throw new Error("The auth service did not return a session token.");
  }
  try {
    window.localStorage.setItem(BROWSER_SESSION_TOKEN_KEY, normalized);
  } catch {
    // Storage denial leaves the browser session non-persistent.
  }
};

export const clearBrowserSessionToken = (): void => {
  purgeLegacyStorage();
  if (window.electronAPI) return;
  try {
    window.localStorage.removeItem(BROWSER_SESSION_TOKEN_KEY);
  } catch {
    // Best effort.
  }
};

/**
 * Adopt a rotated bearer from any Better Auth response. The `bearer` plugin
 * re-signs the session token on refresh, so a browser shell that keeps sending
 * the original value would eventually present a stale credential.
 */
export const captureRotatedSessionToken = (response: Response): void => {
  if (window.electronAPI) return;
  const rotated = response.headers.get("set-auth-token")?.trim();
  if (!rotated) return;
  writeBrowserSessionToken(rotated);
};
