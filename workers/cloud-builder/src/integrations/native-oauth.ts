/**
 * Server-side token exchange for desktop OAuth connectors whose client
 * secret cannot ship in the app (`tokenExchange: { type: "backend" }` in the
 * runtime's provider config). The desktop runs the browser leg and posts the
 * code (or a refresh token) here; this adds the secret and calls the
 * provider's token endpoint.
 *
 * Clients come from `NATIVE_OAUTH_CLIENTS_JSON`, one object keyed by
 * lowercase provider id:
 *   {"google-workspace": {"clientId": "...", "clientSecret": "..."},
 *    "box": {"clientId": "...", "clientSecret": "...",
 *            "tokenEndpoint": "https://api.box.com/oauth2/token"}}
 * `tokenEndpoint` is required for every provider without a built-in one;
 * `tokenAuth` ("body" default, or "basic") and `tokenRedirectParam` are
 * optional. The endpoint is never taken from the request.
 */

type NativeOAuthClient = {
  clientId: string;
  clientSecret: string;
  tokenEndpoint: string;
  tokenAuth: "body" | "basic";
  tokenRedirectParam?: string;
};

const BUILT_IN_TOKEN_ENDPOINTS: Record<string, string> = {
  "google-workspace": "https://oauth2.googleapis.com/token",
};

const readString = (value: unknown): string | null =>
  typeof value === "string" && value.trim() ? value.trim() : null;

export const nativeOAuthClients = (env: Cloudflare.Env): Map<string, NativeOAuthClient> => {
  const clients = new Map<string, NativeOAuthClient>();
  const raw = (env as unknown as Record<string, unknown>).NATIVE_OAUTH_CLIENTS_JSON;
  if (typeof raw !== "string" || !raw.trim()) return clients;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    console.error(JSON.stringify({ event: "native_oauth_clients_invalid" }));
    return clients;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return clients;
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const entry = value as Record<string, unknown>;
    const id = key.trim().toLowerCase();
    const clientId = readString(entry.clientId);
    const clientSecret = readString(entry.clientSecret);
    const tokenEndpoint = readString(entry.tokenEndpoint) ?? BUILT_IN_TOKEN_ENDPOINTS[id] ?? null;
    if (!id || !clientId || !clientSecret || !tokenEndpoint?.startsWith("https://")) continue;
    const tokenRedirectParam = readString(entry.tokenRedirectParam);
    clients.set(id, {
      clientId,
      clientSecret,
      tokenEndpoint,
      tokenAuth: entry.tokenAuth === "basic" ? "basic" : "body",
      ...(tokenRedirectParam ? { tokenRedirectParam } : {}),
    });
  }
  return clients;
};

/** What `GET /api/native-oauth/providers` answers: the configured ids. */
export const listNativeOAuthProviders = (env: Cloudflare.Env) => ({
  providers: [...nativeOAuthClients(env)].map(([id, client]) => ({
    id,
    clientId: client.clientId,
    externalCallbackReady: true,
  })),
});

/** `POST /api/native-oauth/token`: the provider's token response, or an error. */
export const exchangeNativeOAuthToken = async (
  env: Cloudflare.Env,
  body: Record<string, unknown>,
): Promise<{ status: number; body: unknown }> => {
  const providerId = readString(body.provider)?.toLowerCase();
  const client = providerId ? nativeOAuthClients(env).get(providerId) : undefined;
  if (!client) return { status: 503, body: { error: "OAuth provider is not configured." } };
  if (readString(body.client_id) !== client.clientId) {
    return { status: 400, body: { error: "Invalid OAuth client." } };
  }
  const grantType = readString(body.grant_type) ?? "authorization_code";
  const params = new URLSearchParams({ grant_type: grantType });
  if (client.tokenAuth === "body") {
    params.set("client_id", client.clientId);
    params.set("client_secret", client.clientSecret);
  }
  if (grantType === "authorization_code") {
    const code = readString(body.code);
    const redirectUri = readString(body.redirect_uri);
    if (!code || !redirectUri) return { status: 400, body: { error: "Missing OAuth code." } };
    params.set("code", code);
    params.set(client.tokenRedirectParam ?? "redirect_uri", redirectUri);
    const state = readString(body.state);
    if (state) params.set("state", state);
    const codeVerifier = readString(body.code_verifier);
    if (codeVerifier) params.set("code_verifier", codeVerifier);
  } else if (grantType === "refresh_token") {
    const refreshToken = readString(body.refresh_token);
    if (!refreshToken) return { status: 400, body: { error: "Missing OAuth refresh token." } };
    params.set("refresh_token", refreshToken);
  } else {
    return { status: 400, body: { error: "Unsupported OAuth grant type." } };
  }
  const upstream = await fetch(client.tokenEndpoint, {
    method: "POST",
    redirect: "error",
    headers: {
      accept: "application/json",
      "content-type": "application/x-www-form-urlencoded",
      ...(client.tokenAuth === "basic"
        ? { authorization: `Basic ${btoa(`${client.clientId}:${client.clientSecret}`)}` }
        : {}),
    },
    body: params,
    signal: AbortSignal.timeout(30_000),
  });
  const payload = (await upstream.json().catch(() => null)) as Record<string, unknown> | null;
  if (!upstream.ok) {
    return {
      status: upstream.status,
      body: {
        error: "OAuth token exchange failed.",
        ...(typeof payload?.error === "string" ? { provider_error: payload.error } : {}),
      },
    };
  }
  return { status: 200, body: payload ?? {} };
};
