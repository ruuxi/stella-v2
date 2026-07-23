import type { HttpRouter } from "convex/server";
import { httpAction, type ActionCtx } from "../_generated/server";
import { api, internal } from "../_generated/api";
import { decryptSecret } from "../data/secrets_crypto";
import { requireSignedInAccountAction } from "../http_shared/auth";
import {
  errorResponse,
  handleCorsRequest,
  jsonResponse,
  registerCorsOptions,
  withCors,
} from "../http_shared/cors";
import {
  buildXOAuthResultPage,
  buildXRefreshTokenRequest,
  buildXTokenExchangeRequest,
  parseXScope,
  X_OAUTH_SCOPES,
} from "../lib/x_oauth";

type XTokenResponse = {
  access_token?: unknown;
  refresh_token?: unknown;
  token_type?: unknown;
  expires_in?: unknown;
  scope?: unknown;
  error?: unknown;
  error_description?: unknown;
};

type XMeResponse = {
  data?: {
    id?: unknown;
    username?: unknown;
    name?: unknown;
  };
  errors?: unknown;
};

type StoredXTokenSet = {
  accessToken?: unknown;
  refreshToken?: unknown;
  tokenType?: unknown;
  scope?: unknown;
  expiresIn?: unknown;
  issuedAt?: unknown;
};

type XApiRequestBody = {
  method?: unknown;
  path?: unknown;
  query?: unknown;
  body?: unknown;
};

type JsonObject = Record<string, unknown>;

const X_TOKEN_REFRESH_SKEW_MS = 60_000;
const X_API_BASE_URL = "https://api.x.com";
const X_API_ROUTES = [
  "/api/x/connect-url",
  "/api/x/connections",
  "/api/x/request",
];

const htmlResponse = (success: boolean, message: string, status: number) =>
  new Response(buildXOAuthResultPage(success, message), {
    status,
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });

const readNonEmptyString = (value: unknown): string | null =>
  typeof value === "string" && value.trim().length > 0 ? value.trim() : null;

const isJsonObject = (value: unknown): value is JsonObject =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

const configuredOAuthSiteUrl = () =>
  process.env.STELLA_AUTH_BASE_URL || process.env.CONVEX_SITE_URL;

const buildTokenSet = (tokenData: XTokenResponse, issuedAt: number) => ({
  accessToken: readNonEmptyString(tokenData.access_token) ?? "",
  refreshToken: readNonEmptyString(tokenData.refresh_token),
  tokenType: readNonEmptyString(tokenData.token_type) ?? "bearer",
  scope:
    typeof tokenData.scope === "string"
      ? tokenData.scope
      : Array.isArray(tokenData.scope)
        ? tokenData.scope.filter((item): item is string => typeof item === "string")
        : null,
  expiresIn:
    typeof tokenData.expires_in === "number" && Number.isFinite(tokenData.expires_in)
      ? Math.floor(tokenData.expires_in)
      : null,
  issuedAt,
});

const parseJsonBody = async <T>(request: Request): Promise<T | null> => {
  try {
    return (await request.json()) as T;
  } catch {
    return null;
  }
};

const parseStoredTokenSet = async (encryptedTokenSet: string): Promise<StoredXTokenSet> => {
  const raw = await decryptSecret(encryptedTokenSet);
  const parsed = JSON.parse(raw) as unknown;
  if (!isJsonObject(parsed)) {
    throw new Error("Stored X token payload is invalid.");
  }
  return parsed;
};

const accessTokenNeedsRefresh = (expiresAt: number | undefined) =>
  typeof expiresAt === "number" && expiresAt <= Date.now() + X_TOKEN_REFRESH_SKEW_MS;

const refreshXToken = async (
  ctx: ActionCtx,
  ownerId: string,
  current: StoredXTokenSet,
  currentScopes: string[],
) => {
  const refreshToken = readNonEmptyString(current.refreshToken);
  const clientId = process.env.X_CLIENT_ID;
  const clientSecret = process.env.X_CLIENT_SECRET;
  if (!refreshToken || !clientId || !clientSecret) {
    throw new Error("X connection expired. Reconnect X in Stella.");
  }

  const tokenRequest = buildXRefreshTokenRequest({
    clientId,
    clientSecret,
    refreshToken,
  });
  const tokenRes = await fetch(tokenRequest.url, tokenRequest.init);
  const tokenData = (await tokenRes.json()) as XTokenResponse;
  const accessToken = readNonEmptyString(tokenData.access_token);
  if (!tokenRes.ok || !accessToken) {
    console.error("[x-api] Token refresh failed", {
      status: tokenRes.status,
      error: readNonEmptyString(tokenData.error),
      errorDescription: readNonEmptyString(tokenData.error_description),
    });
    throw new Error("X connection expired. Reconnect X in Stella.");
  }

  const issuedAt = Date.now();
  const expiresIn =
    typeof tokenData.expires_in === "number" && Number.isFinite(tokenData.expires_in)
      ? Math.floor(tokenData.expires_in)
      : null;
  const parsedScopes = parseXScope(tokenData.scope);
  const scopes = parsedScopes.length > 0 ? parsedScopes : currentScopes;
  await ctx.runMutation(internal.data.integrations.updateXOAuthTokenSetForOwner, {
    ownerId,
    tokenSet: {
      ...buildTokenSet(tokenData, issuedAt),
      refreshToken: readNonEmptyString(tokenData.refresh_token) ?? refreshToken,
    },
    scopes,
    tokenType: readNonEmptyString(tokenData.token_type) ?? "bearer",
    ...(expiresIn ? { accessTokenExpiresAt: issuedAt + expiresIn * 1000 } : {}),
  });

  return accessToken;
};

const loadXAccessToken = async (
  ctx: ActionCtx,
  ownerId: string,
) => {
  const row = await ctx.runQuery(internal.data.integrations.getXOAuthTokenForOwner, {
    ownerId,
  });
  if (!row) {
    throw new Error("X is not connected. Run `stella-x-api connect` first.");
  }
  const tokenSet = await parseStoredTokenSet(row.encryptedTokenSet);
  const accessToken = readNonEmptyString(tokenSet.accessToken);
  if (!accessToken) {
    throw new Error("X connection is missing an access token. Reconnect X in Stella.");
  }
  if (accessTokenNeedsRefresh(row.accessTokenExpiresAt)) {
    return await refreshXToken(ctx, ownerId, tokenSet, row.scopes);
  }
  return accessToken;
};

const normalizedXApiPath = (value: unknown): string | null => {
  const raw = readNonEmptyString(value);
  if (!raw) return null;
  if (raw.startsWith("/2/")) return raw;
  if (raw.startsWith(`${X_API_BASE_URL}/2/`)) {
    return raw.slice(X_API_BASE_URL.length);
  }
  return null;
};

const normalizedMethod = (value: unknown): string | null => {
  const method = (readNonEmptyString(value) ?? "GET").toUpperCase();
  return ["GET", "POST", "PUT", "PATCH", "DELETE"].includes(method)
    ? method
    : null;
};

const applyQuery = (url: URL, query: unknown) => {
  if (!isJsonObject(query)) return;
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null) continue;
    if (Array.isArray(value)) {
      for (const item of value) {
        url.searchParams.append(key, String(item));
      }
      continue;
    }
    url.searchParams.set(key, String(value));
  }
};

export const registerXRoutes = (http: HttpRouter) => {
  registerCorsOptions(http, X_API_ROUTES);

  http.route({
    path: "/api/x/connect-url",
    method: "GET",
    handler: httpAction(async (ctx, request) =>
      handleCorsRequest(request, async (origin) => {
        const auth = await requireSignedInAccountAction(ctx, origin, {
          message: "Sign in to Stella to connect X.",
        });
        if (!auth.ok) return auth.response;
        const result = await ctx.runMutation(api.data.integrations.createXConnectUrl, {});
        return jsonResponse(result, 200, origin);
      }),
    ),
  });

  http.route({
    path: "/api/x/connections",
    method: "GET",
    handler: httpAction(async (ctx, request) =>
      handleCorsRequest(request, async (origin) => {
        const auth = await requireSignedInAccountAction(ctx, origin, {
          message: "Sign in to Stella to view X connections.",
        });
        if (!auth.ok) return auth.response;
        const row = await ctx.runQuery(internal.data.integrations.getXOAuthTokenForOwner, {
          ownerId: auth.ownerId,
        });
        return jsonResponse(
          {
            connections: row
              ? [
                  {
                    xUserId: row.xUserId,
                    username: row.username,
                    name: row.name,
                    scopes: row.scopes,
                    updatedAt: row.updatedAt,
                    accessTokenExpiresAt: row.accessTokenExpiresAt,
                  },
                ]
              : [],
          },
          200,
          origin,
        );
      }),
    ),
  });

  http.route({
    path: "/api/x/request",
    method: "POST",
    handler: httpAction(async (ctx, request) =>
      handleCorsRequest(request, async (origin) => {
        const auth = await requireSignedInAccountAction(ctx, origin, {
          message: "Sign in to Stella to use X.",
        });
        if (!auth.ok) return auth.response;
        const body = await parseJsonBody<XApiRequestBody>(request);
        const method = normalizedMethod(body?.method);
        const path = normalizedXApiPath(body?.path);
        if (!body || !method || !path) {
          return errorResponse(
            400,
            "Provide method and an X API v2 path such as /2/users/me.",
            origin,
          );
        }

        let accessToken: string;
        try {
          accessToken = await loadXAccessToken(ctx, auth.ownerId);
        } catch (error) {
          return errorResponse(
            401,
            error instanceof Error ? error.message : "X is not connected.",
            origin,
          );
        }

        const upstreamUrl = new URL(path, X_API_BASE_URL);
        applyQuery(upstreamUrl, body.query);
        const upstream = await fetch(upstreamUrl, {
          method,
          headers: {
            Authorization: `Bearer ${accessToken}`,
            ...(method === "GET" ? {} : { "Content-Type": "application/json" }),
          },
          ...(method === "GET" || body.body === undefined
            ? {}
            : { body: JSON.stringify(body.body) }),
        });
        const contentType = upstream.headers.get("content-type") ?? "";
        const payload = contentType.includes("application/json")
          ? await upstream.json().catch(() => null)
          : { text: await upstream.text().catch(() => "") };
        return withCors(
          new Response(JSON.stringify(payload), {
            status: upstream.status,
            headers: { "Content-Type": "application/json" },
          }),
          origin,
        );
      }),
    ),
  });

  http.route({
    path: "/api/x/oauth_callback",
    method: "GET",
    handler: httpAction(async (ctx, request) => {
      const url = new URL(request.url);
      const code = url.searchParams.get("code");
      const error = url.searchParams.get("error");
      const state = url.searchParams.get("state");

      if (!state) {
        return htmlResponse(false, "Missing OAuth state.", 400);
      }

      const consumedState = await ctx.runMutation(
        internal.data.integrations.consumeXOAuthState,
        { state },
      );
      if (!consumedState) {
        return htmlResponse(
          false,
          "Invalid or expired OAuth state. Please start the X connection again.",
          400,
        );
      }

      if (error) {
        return htmlResponse(false, "X authorization was cancelled.", 200);
      }

      if (!code) {
        return htmlResponse(false, "Missing authorization code.", 400);
      }

      const clientId = process.env.X_CLIENT_ID;
      const clientSecret = process.env.X_CLIENT_SECRET;
      const convexSiteUrl = configuredOAuthSiteUrl();
      if (!clientId || !clientSecret || !convexSiteUrl) {
        console.error("[x-oauth] Missing X_CLIENT_ID, X_CLIENT_SECRET, or OAuth site URL");
        return htmlResponse(false, "Server configuration error.", 500);
      }

      try {
        const redirectUri = `${convexSiteUrl}/api/x/oauth_callback`;
        const tokenRequest = buildXTokenExchangeRequest({
          clientId,
          clientSecret,
          code,
          redirectUri,
          codeVerifier: consumedState.codeVerifier,
        });
        const tokenRes = await fetch(tokenRequest.url, tokenRequest.init);
        const tokenData = (await tokenRes.json()) as XTokenResponse;
        const accessToken = readNonEmptyString(tokenData.access_token);

        if (!tokenRes.ok || !accessToken) {
          console.error("[x-oauth] Token exchange failed", {
            status: tokenRes.status,
            error: readNonEmptyString(tokenData.error),
            errorDescription: readNonEmptyString(tokenData.error_description),
          });
          return htmlResponse(false, "X token exchange failed. Please retry connection.", 400);
        }

        const meRes = await fetch("https://api.x.com/2/users/me", {
          headers: { Authorization: `Bearer ${accessToken}` },
        });
        const meData = (await meRes.json()) as XMeResponse;
        const xUserId = readNonEmptyString(meData.data?.id);
        const username = readNonEmptyString(meData.data?.username);
        const name = readNonEmptyString(meData.data?.name) ?? undefined;

        if (!meRes.ok || !xUserId || !username) {
          console.error("[x-oauth] User profile lookup failed", {
            status: meRes.status,
            hasData: Boolean(meData.data),
            hasErrors: Boolean(meData.errors),
          });
          return htmlResponse(false, "Could not read the connected X account.", 400);
        }

        const issuedAt = Date.now();
        const expiresIn =
          typeof tokenData.expires_in === "number" && Number.isFinite(tokenData.expires_in)
            ? Math.floor(tokenData.expires_in)
            : null;
        const parsedScopes = parseXScope(tokenData.scope);
        const scopes = parsedScopes.length > 0 ? parsedScopes : Array.from(X_OAUTH_SCOPES);

        await ctx.runMutation(internal.data.integrations.upsertXOAuthTokensForOwner, {
          ownerId: consumedState.ownerId,
          xUserId,
          username,
          ...(name ? { name } : {}),
          tokenSet: buildTokenSet(tokenData, issuedAt),
          scopes,
          tokenType: readNonEmptyString(tokenData.token_type) ?? "bearer",
          ...(expiresIn ? { accessTokenExpiresAt: issuedAt + expiresIn * 1000 } : {}),
        });

        return htmlResponse(true, `Connected @${username} to Stella. You can close this tab.`, 200);
      } catch (err) {
        console.error("[x-oauth] Callback failed", {
          message: err instanceof Error ? err.message : String(err),
        });
        return htmlResponse(false, "X connection failed. Please retry connection.", 500);
      }
    }),
  });
};
