const LIVE_VIEW_ORIGIN = "https://live.browser.run";

/** Strict native-WebView boundary for Cloudflare's bearer Live View URL. */
export function parseCloudBrowserLiveViewUrl(value: string): URL | null {
  try {
    const url = new URL(value);
    if (url.origin !== LIVE_VIEW_ORIGIN) return null;
    if (url.username || url.password || url.port) return null;
    return url;
  } catch {
    return null;
  }
}

export function isCloudBrowserLiveViewNavigationAllowed(
  value: string,
): boolean {
  return (
    value === "about:blank" || parseCloudBrowserLiveViewUrl(value) !== null
  );
}
