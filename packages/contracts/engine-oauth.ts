/**
 * Claude (Pro/Max) sign-in as the owner's own devices run it: provider
 * constants, PKCE, authorization-input parsing, token responses and account
 * identity, defined once for desktop (Electron main and the runtime's
 * loopback flow) and mobile.
 *
 * Pure: nothing here touches the network. The calls to Anthropic live in
 * `engine-oauth-flows.ts`, which only devices import. Stella's server stores
 * the resulting tokens but never contacts Anthropic's auth endpoints.
 *
 * React Native has no `URLSearchParams` worth trusting and no `crypto.subtle`,
 * so query strings are built and read by hand and PKCE takes its primitives.
 */

export const ANTHROPIC_OAUTH = {
  clientId: atob("OWQxYzI1MGEtZTYxYi00NGQ5LTg4ZWQtNTk0NGQxOTYyZjVl"),
  authorizeUrl: "https://claude.ai/oauth/authorize",
  tokenUrl: "https://platform.claude.com/v1/oauth/token",
  profileUrl: "https://api.anthropic.com/api/oauth/profile",
  scopes:
    "org:create_api_key user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload",
  /** claude.ai's code-paste page (`code=true`): it shows the code; nothing listens. */
  pasteRedirectUri: "https://console.anthropic.com/oauth/code/callback",
  loopbackHost: "127.0.0.1",
  loopbackPort: 53692,
  loopbackPath: "/callback",
  loopbackRedirectUri: "http://localhost:53692/callback",
} as const;

// --- PKCE -------------------------------------------------------------------

export const base64UrlEncode = (bytes: Uint8Array): string => {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
};

/** The two primitives PKCE needs; React Native supplies its own. */
export type PkceCrypto = {
  randomBytes(length: number): Uint8Array;
  sha256(data: Uint8Array): Uint8Array | Promise<Uint8Array>;
};

/** Web Crypto, as Node, Electron and browsers have it. */
export const webPkceCrypto: PkceCrypto = {
  randomBytes: (length) => crypto.getRandomValues(new Uint8Array(length)),
  sha256: async (data) =>
    new Uint8Array(await crypto.subtle.digest("SHA-256", data as Uint8Array<ArrayBuffer>)),
};

export const createPkce = async (
  primitives: PkceCrypto = webPkceCrypto,
): Promise<{ verifier: string; challenge: string }> => {
  const verifier = base64UrlEncode(primitives.randomBytes(32));
  const challenge = base64UrlEncode(
    await primitives.sha256(new TextEncoder().encode(verifier)),
  );
  return { verifier, challenge };
};

// --- Query strings ------------------------------------------------------------

export const formEncode = (values: Record<string, string>): string =>
  Object.entries(values)
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
    .join("&");

const formDecode = (query: string): Record<string, string> => {
  const values: Record<string, string> = {};
  for (const pair of query.split("&")) {
    if (!pair) continue;
    const [key = "", value = ""] = pair.split("=", 2);
    try {
      values[decodeURIComponent(key.replaceAll("+", " "))] = decodeURIComponent(
        value.replaceAll("+", " "),
      );
    } catch {
      // A malformed pair is skipped.
    }
  }
  return values;
};

/**
 * The Claude consent page. The user comes back with a code, to the loopback
 * listener or (with `pasteRedirectUri`) shown on a page to paste. The state
 * is the verifier, as Claude Code does it; claude.ai echoes it after the `#`.
 */
export const anthropicAuthorizeUrl = (args: {
  challenge: string;
  state: string;
  redirectUri: string;
}): string =>
  `${ANTHROPIC_OAUTH.authorizeUrl}?${formEncode({
    code: "true",
    client_id: ANTHROPIC_OAUTH.clientId,
    response_type: "code",
    redirect_uri: args.redirectUri,
    scope: ANTHROPIC_OAUTH.scopes,
    code_challenge: args.challenge,
    code_challenge_method: "S256",
    state: args.state,
  })}`;

/** Accepts a raw code, `code#state`, `code=...` params, or a full redirect URL. */
export const parseAuthorizationInput = (input: string): { code?: string; state?: string } => {
  const value = input.trim();
  if (!value) return {};
  const fromParams = (query: string) => {
    const params = formDecode(query.split("#", 1)[0] ?? "");
    return {
      ...(params.code ? { code: params.code } : {}),
      ...(params.state ? { state: params.state } : {}),
    };
  };
  if (/^[a-z][a-z0-9+.-]*:\/\//iu.test(value)) {
    const query = value.indexOf("?");
    return query === -1 ? {} : fromParams(value.slice(query + 1));
  }
  if (value.includes("#")) {
    const [code, state] = value.split("#", 2);
    return { ...(code ? { code } : {}), ...(state ? { state } : {}) };
  }
  if (value.includes("code=")) return fromParams(value);
  return { code: value };
};

// --- Tokens -------------------------------------------------------------------

export type EngineTokens = {
  access: string;
  refresh: string;
  /** Epoch ms on this device's clock when `access` stops working. */
  expiresAt: number;
};

/** The fields of a provider token response this code reads. */
export type EngineTokenResponse = {
  access_token?: unknown;
  refresh_token?: unknown;
  expires_in?: unknown;
  account?: { uuid?: unknown; email_address?: unknown };
};

export const tokensFromResponse = (
  json: EngineTokenResponse,
  now = Date.now(),
): EngineTokens => {
  const expiresIn = Number(json.expires_in);
  if (
    typeof json.access_token !== "string" ||
    !json.access_token ||
    typeof json.refresh_token !== "string" ||
    !json.refresh_token ||
    !Number.isFinite(expiresIn) ||
    expiresIn <= 0
  ) {
    throw new Error("The provider returned an unexpected sign-in response.");
  }
  return {
    access: json.access_token,
    refresh: json.refresh_token,
    expiresAt: now + expiresIn * 1000,
  };
};

// --- Account identity -----------------------------------------------------------

/** Which provider login this is (stable across reconnects), and how to show it. */
export type EngineAccountIdentity = { identity?: string; email?: string; plan?: string };

const text = (value: unknown, max = 320): string | undefined =>
  typeof value === "string" && value.trim() ? value.trim().slice(0, max) : undefined;

/** "claude_max" → "Max". */
export const planLabel = (value: unknown): string | undefined => {
  const raw = text(value);
  if (!raw) return undefined;
  const plan = raw.replace(/^claude_/u, "").replaceAll("_", " ").trim();
  return plan ? plan.replace(/\b\w/gu, (char) => char.toUpperCase()).slice(0, 40) : undefined;
};

/**
 * Claude: the token response names the account; the OAuth profile (when the
 * device could read it) adds the plan.
 */
export const anthropicIdentity = (
  response: EngineTokenResponse,
  profile?: { account?: Record<string, unknown>; organization?: Record<string, unknown> } | null,
): EngineAccountIdentity => {
  const email =
    text(response.account?.email_address) ??
    text(profile?.account?.email) ??
    text(profile?.account?.email_address);
  const identity = text(response.account?.uuid) ?? text(profile?.account?.uuid) ?? email;
  const plan =
    planLabel(profile?.organization?.organization_type) ??
    (profile?.account?.has_claude_max === true
      ? "Max"
      : profile?.account?.has_claude_pro === true
        ? "Pro"
        : undefined);
  return {
    ...(identity ? { identity } : {}),
    ...(email ? { email } : {}),
    ...(plan ? { plan } : {}),
  };
};
