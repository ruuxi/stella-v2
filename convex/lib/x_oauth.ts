export const X_PROVIDER_ID = "x";

export const X_OAUTH_STATE_TTL_MS = 10 * 60 * 1000;

export const X_OAUTH_SCOPES = [
  "tweet.read",
  "tweet.write",
  "users.read",
  "dm.read",
  "dm.write",
  "offline.access",
] as const;

const encoder = new TextEncoder();

const bytesToBase64 = (bytes: Uint8Array) => {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
};

export const base64UrlEncode = (bytes: Uint8Array) =>
  bytesToBase64(bytes)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");

export const randomBase64Url = (bytesLength: number) => {
  const bytes = new Uint8Array(bytesLength);
  crypto.getRandomValues(bytes);
  return base64UrlEncode(bytes);
};

export const generateXOAuthState = () => randomBase64Url(24);

export const generateXCodeVerifier = () => randomBase64Url(32);

export const sha256Hex = async (value: string): Promise<string> => {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(value));
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
};

export const buildXCodeChallenge = async (codeVerifier: string) => {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    encoder.encode(codeVerifier),
  );
  return base64UrlEncode(new Uint8Array(digest));
};

export const xOAuthScopeString = (scopes: readonly string[] = X_OAUTH_SCOPES) =>
  scopes.join(" ");

export const buildXBasicAuthHeader = (clientId: string, clientSecret: string) =>
  `Basic ${bytesToBase64(encoder.encode(`${clientId}:${clientSecret}`))}`;

export const buildXAuthorizationUrl = (args: {
  clientId: string;
  redirectUri: string;
  state: string;
  codeChallenge: string;
  scopes?: readonly string[];
}) => {
  const url = new URL("https://x.com/i/oauth2/authorize");
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", args.clientId);
  url.searchParams.set("redirect_uri", args.redirectUri);
  url.searchParams.set("scope", xOAuthScopeString(args.scopes));
  url.searchParams.set("state", args.state);
  url.searchParams.set("code_challenge", args.codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  return url.toString();
};

export const buildXTokenExchangeRequest = (args: {
  clientId: string;
  clientSecret: string;
  code: string;
  redirectUri: string;
  codeVerifier: string;
}) => ({
  url: "https://api.x.com/2/oauth2/token",
  init: {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: buildXBasicAuthHeader(args.clientId, args.clientSecret),
    },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code: args.code,
      redirect_uri: args.redirectUri,
      code_verifier: args.codeVerifier,
    }).toString(),
  },
});

export const buildXRefreshTokenRequest = (args: {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
}) => ({
  url: "https://api.x.com/2/oauth2/token",
  init: {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: buildXBasicAuthHeader(args.clientId, args.clientSecret),
    },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: args.refreshToken,
    }).toString(),
  },
});

export const parseXScope = (scope: unknown): string[] => {
  if (Array.isArray(scope)) {
    return scope.filter((item): item is string => typeof item === "string");
  }
  if (typeof scope === "string") {
    return scope.split(/\s+/u).filter(Boolean);
  }
  return [];
};

export const buildXOAuthResultPage = (success: boolean, message: string) => {
  const safeMessage = message
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
  const title = success ? "X Connected" : "X Connection Failed";
  const color = success ? "#22c55e" : "#ef4444";
  const icon = success ? "&#10003;" : "&#10007;";
  return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><title>${title}</title>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, sans-serif; display: flex; justify-content: center; align-items: center; min-height: 100vh; margin: 0; background: #0a0a0a; color: #e5e5e5; }
  .card { text-align: center; padding: 3rem; max-width: 420px; }
  .icon { font-size: 4rem; color: ${color}; margin-bottom: 1rem; }
  h1 { font-size: 1.5rem; margin-bottom: 0.5rem; }
  p { color: #a3a3a3; line-height: 1.6; }
</style>
</head>
<body><div class="card"><div class="icon">${icon}</div><h1>${title}</h1><p>${safeMessage}</p></div></body>
</html>`;
};
