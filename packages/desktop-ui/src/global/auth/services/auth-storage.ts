const LEGACY_STORAGE_KEYS = new Set([
  "better-auth_cookie",
  "better-auth_session_data",
]);

const clearLegacyValue = (key: string) => {
  if (!window.electronAPI) {
    return;
  }
  if (!LEGACY_STORAGE_KEYS.has(key)) {
    return;
  }
  try {
    window.localStorage?.removeItem(key);
  } catch {
    // Best effort migration cleanup.
  }
};

export const desktopAuthStorage = {
  getItem(key: string): string | null {
    clearLegacyValue(key);
    if (window.electronAPI) return null;
    try {
      return window.localStorage.getItem(key);
    } catch {
      return null;
    }
  },

  setItem(key: string, value: string): void {
    clearLegacyValue(key);
    if (window.electronAPI) return;
    try {
      window.localStorage.setItem(key, value);
    } catch {
      // Storage denial leaves the browser session non-persistent.
    }
  },

  removeItem(key: string): void {
    clearLegacyValue(key);
    if (window.electronAPI) return;
    try {
      window.localStorage.removeItem(key);
    } catch {
      // Best effort.
    }
  },
};

export const ensureBrowserAuthBootstrapCookie = (): void => {
  if (window.electronAPI) return;
  const key = "better-auth_cookie";
  let existing: Record<string, unknown> = {};
  try {
    existing = JSON.parse(desktopAuthStorage.getItem(key) ?? "{}") as Record<
      string,
      unknown
    >;
  } catch {
    existing = {};
  }
  // crossDomainClient mirrors HttpOnly Set-Cookie values through
  // Set-Better-Auth-Cookie only when the request contains a
  // Better-Auth-Cookie header. Browsers can omit a zero-length header on the
  // very first request, so seed a harmless marker that makes that header
  // non-empty. The server ignores the marker and the client merges the signed
  // session cookie from the response.
  desktopAuthStorage.setItem(
    key,
    JSON.stringify({
      ...existing,
      stella_auth_bootstrap: { value: "1", expires: null },
    }),
  );
};
