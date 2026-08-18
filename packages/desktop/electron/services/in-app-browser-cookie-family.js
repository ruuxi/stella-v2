const GOOGLE_COOKIE_HOST_SUFFIXES = [
  "google.com",
  "youtube.com",
  "doubleclick.net",
  "googleadservices.com",
  "googlesyndication.com",
];

const GOOGLE_LEGACY_TRUST_COOKIE_NAMES = new Set([
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
]);

const SECURITY_PREFIX = /^__(Secure|Host)-/;
const AUDIENCE_PREFIX = /^(1P|3P)(?=[A-Z0-9_])/;

const normalizedHost = (domain) =>
  String(domain || "")
    .trim()
    .replace(/^\./, "")
    .toLowerCase();

const isGoogleHost = (domain) => {
  const host = normalizedHost(domain);
  return GOOGLE_COOKIE_HOST_SUFFIXES.some(
    (suffix) => host === suffix || host.endsWith(`.${suffix}`),
  );
};

const familyName = (name) => {
  const original = String(name || "");
  const withoutSecurityPrefix = original.replace(SECURITY_PREFIX, "");
  const withoutAudience = withoutSecurityPrefix.replace(AUDIENCE_PREFIX, "");
  return withoutAudience || original;
};

const isGoogleTrustFamilyName = (name) => {
  const original = String(name || "");
  if (!original) return false;
  const withoutSecurityPrefix = original.replace(SECURITY_PREFIX, "");
  const withoutAudience = withoutSecurityPrefix.replace(AUDIENCE_PREFIX, "");

  // Security-prefixed and explicit 1P/3P cookies are rotating trust variants.
  // Normalizing the prefixes instead of enumerating current names makes future
  // Google variants join the same coherent source snapshot automatically.
  if (
    withoutSecurityPrefix !== original ||
    withoutAudience !== withoutSecurityPrefix
  ) {
    return true;
  }
  return GOOGLE_LEGACY_TRUST_COOKIE_NAMES.has(original);
};

const partitionScope = (cookie) => {
  const partitionKey = cookie?.partitionKey;
  if (!partitionKey?.topLevelSite) return "unpartitioned";
  return `${String(partitionKey.topLevelSite).toLowerCase()}|${
    partitionKey.hasCrossSiteAncestor === true
  }`;
};

const cookieScope = (cookie) => {
  const rawDomain = String(cookie?.domain || "").trim().toLowerCase();
  const hostOnly =
    typeof cookie?.hostOnly === "boolean"
      ? cookie.hostOnly
      : !rawDomain.startsWith(".");
  const host = normalizedHost(rawDomain);
  const domain = hostOnly ? host : `.${host}`;
  return [domain, cookie?.path || "/", hostOnly, partitionScope(cookie)].join("\0");
};

export const googleCookieFamilyKey = (cookie) => {
  const name = String(cookie?.name || "");
  if (!name || !isGoogleHost(cookie?.domain)) return null;
  if (!isGoogleTrustFamilyName(name)) return null;
  return `${familyName(name)}\0${cookieScope(cookie)}`;
};

export const cookieIdentityKey = (cookie) =>
  `${String(cookie?.name || "")}\0${cookieScope(cookie)}`;

export const isGoogleAuthNavigation = (value) => {
  try {
    return isGoogleHost(new URL(value).hostname);
  } catch {
    return false;
  }
};
