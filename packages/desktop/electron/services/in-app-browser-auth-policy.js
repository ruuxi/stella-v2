const fallbackPlatformToken = (platform) => {
  switch (platform) {
    case "win32":
      return "Windows NT 10.0; Win64; x64";
    case "linux":
      return "X11; Linux x86_64";
    default:

      return "Macintosh; Intel Mac OS X 10_15_7";
  }
};

export const buildInAppBrowserUserAgent = (
  runtimeUserAgent,
  chromiumVersion = process.versions.chrome,
  platform = process.platform,
) => {
  const sanitized = String(runtimeUserAgent || "")
    .replace(/(?:^|\s)(?:Electron|Stella)\/[^\s]+/gi, "")
    .replace(/\s{2,}/g, " ")
    .trim();
  if (/\b(?:Chrome|Chromium)\/\d+/i.test(sanitized)) {

    return sanitized.replace(
      /\b(Chrome|Chromium)\/(\d+)(?:\.\d+){0,3}/i,
      "$1/$2.0.0.0",
    );
  }

  const major = String(chromiumVersion || "").match(/^\d+/)?.[0] || "0";
  return (
    `Mozilla/5.0 (${fallbackPlatformToken(platform)}) ` +
    "AppleWebKit/537.36 (KHTML, like Gecko) " +
    `Chrome/${major}.0.0.0 Safari/537.36`
  );
};

export const AUTH_ORIGIN_HOST_SUFFIXES = [

  "accounts.google.com",
  "accounts.youtube.com",
  "gds.google.com",

  "login.microsoftonline.com",
  "login.live.com",
  "login.microsoft.com",
  "appleid.apple.com",
];

export const AUTH_DEVICE_PERMISSIONS = new Set(["hid", "usb", "serial"]);

export const TRUST_COOKIE_NAME_PREFIXES = ["__Secure-", "__Host-"];
export const TRUST_COOKIE_NAMES = new Set([

  "SID",
  "HSID",
  "SSID",
  "APISID",
  "SAPISID",
  "SIDCC",
  "LSID",
  "OSID",
  "ACCOUNT_CHOOSER",
  "SMSV",
  "__Secure-ENID",
]);

const urlHost = (value) => {
  try {
    return new URL(value).hostname.toLowerCase();
  } catch {
    return null;
  }
};

const hostMatchesSuffix = (host, suffix) =>
  host === suffix || host.endsWith(`.${suffix}`);

export const isAuthOrigin = (value) => {
  const host = value ? urlHost(String(value)) : null;
  if (!host) return false;
  return AUTH_ORIGIN_HOST_SUFFIXES.some((suffix) =>
    hostMatchesSuffix(host, suffix),
  );
};

export const isAuthPopupUrl = (value) => {
  if (!value) return false;
  const raw = String(value);
  let protocol;
  try {
    protocol = new URL(raw).protocol;
  } catch {
    return false;
  }
  if (protocol !== "http:" && protocol !== "https:") return false;
  return isAuthOrigin(raw);
};

export const isAuthPermission = (permission) =>
  AUTH_DEVICE_PERMISSIONS.has(String(permission || ""));

export const shouldAllowAuthDevice = (details) => {
  if (!details) return false;
  if (!AUTH_DEVICE_PERMISSIONS.has(String(details.deviceType || ""))) {
    return false;
  }
  return isAuthOrigin(details.origin);
};

export const isTrustCriticalCookieName = (name) => {
  if (!name) return false;
  if (TRUST_COOKIE_NAMES.has(name)) return true;
  return TRUST_COOKIE_NAME_PREFIXES.some((prefix) => name.startsWith(prefix));
};

const isLiveCookie = (cookie, nowSeconds) => {
  if (!cookie) return false;
  if (typeof cookie.expirationDate !== "number") return true;
  return cookie.expirationDate > nowSeconds;
};

export const shouldPreserveExistingCookie = (
  existing,
  incoming,
  nowSeconds = Date.now() / 1000,
) => {
  if (!existing) return false;
  const name = incoming?.name ?? existing.name;
  if (!isTrustCriticalCookieName(name)) return false;
  return isLiveCookie(existing, nowSeconds);
};
