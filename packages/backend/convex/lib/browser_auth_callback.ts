export const BROWSER_AUTH_HANDOFF_TOKEN_PATTERN = /^[A-Za-z0-9._~-]{8,2048}$/;

const isLocalDevelopmentOrigin = (url: URL): boolean =>
  url.protocol === "http:" &&
  (url.hostname === "localhost" || url.hostname === "127.0.0.1");

/**
 * Browser auth may return only to the exact CORS-approved caller origin. The
 * target is stored server-side, so neither the provider callback nor its query
 * string carries an open-redirect destination.
 */
export const normalizeBrowserAuthReturnTarget = ({
  rawReturnTo,
  requestOrigin,
}: {
  rawReturnTo: string;
  requestOrigin: string;
}): string | null => {
  if (!rawReturnTo || !requestOrigin || requestOrigin === "null") return null;
  try {
    const target = new URL(rawReturnTo);
    const origin = new URL(requestOrigin);
    if (origin.pathname !== "/" || origin.search || origin.hash) return null;
    if (target.origin !== origin.origin) return null;
    if (target.username || target.password || target.search || target.hash) {
      return null;
    }
    if (target.protocol !== "https:" && !isLocalDevelopmentOrigin(target)) {
      return null;
    }
    return target.toString();
  } catch {
    return null;
  }
};

export const buildBrowserAuthFragmentRedirect = ({
  returnTo,
  token,
}: {
  returnTo: string;
  token: string;
}): string | null => {
  if (!BROWSER_AUTH_HANDOFF_TOKEN_PATTERN.test(token)) return null;
  try {
    const target = new URL(returnTo);
    if (target.search || target.hash) return null;
    target.hash = new URLSearchParams({ ott: token }).toString();
    return target.toString();
  } catch {
    return null;
  }
};
