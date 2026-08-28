const LIVE_VIEW_ORIGIN = "https://live.browser.run";

/**
 * Accept only Cloudflare's dedicated Live View origin. A capability is a bearer
 * URL, so callers must reject credentials, alternate ports, and lookalike hosts
 * before assigning it to an iframe.
 */
export const parseCloudBrowserLiveViewUrl = (value: string): URL | null => {
  try {
    const url = new URL(value);
    if (url.origin !== LIVE_VIEW_ORIGIN) return null;
    if (url.username || url.password || url.port) return null;
    return url;
  } catch {
    return null;
  }
};

export const isCloudBrowserLiveViewNavigationAllowed = (
  value: string,
): boolean =>
  value === "about:blank" || parseCloudBrowserLiveViewUrl(value) !== null;
