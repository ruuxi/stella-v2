import type { HttpRouter } from "convex/server";
import { httpAction, type ActionCtx } from "../_generated/server";
import { api } from "../_generated/api";
import { internal } from "../_generated/api";
import { requireUserIdentity } from "../auth";
import {
  errorResponse,
  handleCorsRequest,
  jsonResponse,
  registerCorsOptions,
  withCors,
} from "../http_shared/cors";
import { requireAdminRequest } from "../http_shared/admin";

type NativeOAuthExchangeBody = {
  provider?: unknown;
  grant_type?: unknown;
  client_id?: unknown;
  code?: unknown;
  state?: unknown;
  redirect_uri?: unknown;
  code_verifier?: unknown;
  refresh_token?: unknown;
};

type StoreIntegrationRecord = {
  id?: unknown;
  connector?: unknown;
};

type StoreConnectorRecord = {
  type?: unknown;
  toolkit?: unknown;
  provider?: unknown;
  oauth?: unknown;
};

type StoreOAuthRecord = {
  clientId?: unknown;
  tokenEndpoint?: unknown;
  tokenAuth?: unknown;
  tokenExchangeProvider?: unknown;
  tokenRedirectParam?: unknown;
};

type NativeOAuthProvider = {
  clientId: string;
  clientSecret?: string;
  tokenEndpoint: string;
  tokenAuth?: "basic" | "body";
  tokenRedirectParam?: string;
  requiresClientSecret?: boolean;
};

type ComposioSessionResponse = {
  id?: unknown;
  sessionId?: unknown;
};

type ComposioLinkResponse = {
  link?: unknown;
  url?: unknown;
  redirectUrl?: unknown;
};

type NativeIntegrationRequestBody = {
  id?: unknown;
  action?: unknown;
  input?: unknown;
};

const envKey = (id: string, suffix: string) =>
  `STELLA_NATIVE_OAUTH_${id.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}_${suffix}`;

const readString = (value: unknown) =>
  typeof value === "string" && value.trim() ? value.trim() : null;

const parseBody = async (request: Request) => {
  try {
    return (await request.json()) as NativeOAuthExchangeBody;
  } catch {
    return null;
  }
};

const parseUnknownBody = async (request: Request) => {
  try {
    return await request.json();
  } catch {
    return null;
  }
};

const parseJsonObject = (text: string) => {
  if (!text.trim()) return null;
  try {
    const parsed = JSON.parse(text) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
};

const sha256Hex = async (value: string): Promise<string> => {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
};

const readComposioApiKey = () =>
  process.env.COMPOSIO_CONSUMER_API_KEY?.trim() ||
  process.env.COMPOSIO_API_KEY?.trim() ||
  null;

const readComposioBaseUrl = () =>
  (process.env.COMPOSIO_TOOL_ROUTER_URL?.trim() ||
    "https://backend.composio.dev/api/v3.1/tool_router").replace(/\/+$/u, "");

const readComposioConnector = (record: StoreIntegrationRecord) => {
  const connector =
    record.connector && typeof record.connector === "object"
      ? (record.connector as StoreConnectorRecord)
      : null;
  if (connector?.type !== "composio") return null;
  const id = readString(record.id)?.toLowerCase();
  const toolkit = readString(connector.toolkit)?.toLowerCase();
  if (!id || !toolkit) return null;
  return {
    id,
    toolkit,
    provider: readString(connector.provider)?.toLowerCase() || "composio",
  };
};

const requireComposioConfig = () => {
  const apiKey = readComposioApiKey();
  if (!apiKey) {
    return {
      response: errorResponse(503, "Composio is not configured."),
      config: null,
    };
  }
  return {
    response: null,
    config: {
      apiKey,
      baseUrl: readComposioBaseUrl(),
    },
  };
};

const composioFetch = async (
  path: string,
  init: RequestInit,
  config: { apiKey: string; baseUrl: string },
) => {
  const response = await fetch(`${config.baseUrl}${path}`, {
    ...init,
    headers: {
      accept: "application/json",
      "content-type": "application/json",
      "x-api-key": config.apiKey,
      "x-consumer-api-key": config.apiKey,
      ...(init.headers ?? {}),
    },
  });
  const text = await response.text();
  const payload = parseJsonObject(text) ?? (text ? { text } : {});
  if (!response.ok) {
    throw new Error(
      `Composio request failed (${response.status}): ${JSON.stringify(payload).slice(0, 500)}`,
    );
  }
  return payload;
};

const composioSessionIdFromPayload = (payload: Record<string, unknown>) =>
  readString((payload as ComposioSessionResponse).id) ??
  readString((payload as ComposioSessionResponse).sessionId) ??
  readString(
    payload.session && typeof payload.session === "object"
      ? (payload.session as Record<string, unknown>).id
      : null,
  );

const composioLinkFromPayload = (payload: Record<string, unknown>) =>
  readString((payload as ComposioLinkResponse).link) ??
  readString((payload as ComposioLinkResponse).url) ??
  readString((payload as ComposioLinkResponse).redirectUrl) ??
  readString(
    payload.data && typeof payload.data === "object"
      ? (payload.data as Record<string, unknown>).link ??
          (payload.data as Record<string, unknown>).url ??
          (payload.data as Record<string, unknown>).redirectUrl
      : null,
  );

const ensureComposioSession = async (
  ctx: ActionCtx,
  args: {
    ownerId: string;
    integrationId: string;
    toolkit: string;
    config: { apiKey: string; baseUrl: string };
  },
) => {
  const existing = (await ctx.runQuery(
    internal.data.integrations.getUserIntegrationByOwnerAndProvider,
    {
      ownerId: args.ownerId,
      provider: args.integrationId,
    },
  )) as { externalId?: string; config?: Record<string, unknown> } | null;
  const existingSessionId =
    readString(existing?.externalId) ??
    readString(existing?.config?.sessionId);
  if (existingSessionId) return existingSessionId;

  const userId = `stella_${(await sha256Hex(args.ownerId)).slice(0, 32)}`;
  const payload = await composioFetch(
    "/session",
    {
      method: "POST",
      body: JSON.stringify({
        user_id: userId,
        toolkits: { enabled: [args.toolkit] },
      }),
    },
    args.config,
  );
  const sessionId = composioSessionIdFromPayload(payload);
  if (!sessionId) throw new Error("Composio did not return a session id.");
  await ctx.runMutation(
    internal.data.integrations.upsertUserIntegrationForOwner,
    {
      ownerId: args.ownerId,
      provider: args.integrationId,
      mode: "composio",
      externalId: sessionId,
      config: {
        sessionId,
        toolkit: args.toolkit,
        provider: "composio",
      },
    },
  );
  return sessionId;
};

const loadPublicIntegration = async (ctx: ActionCtx, id: string) =>
  (await ctx.runQuery(internal.data.integrations.getPublicIntegrationById, {
    id,
  })) as StoreIntegrationRecord | null;

const readOAuthFromRecord = (
  record: StoreIntegrationRecord,
): StoreOAuthRecord | null => {
  const connector =
    record.connector && typeof record.connector === "object"
      ? (record.connector as StoreConnectorRecord)
      : null;
  return connector?.oauth && typeof connector.oauth === "object"
    ? (connector.oauth as StoreOAuthRecord)
    : null;
};

const providerRequiresClientSecret = (provider: NativeOAuthProvider) =>
  provider.requiresClientSecret === true ||
  (provider.tokenAuth ?? "body") === "basic";

const isNativeOAuthProviderConfigured = (provider: NativeOAuthProvider) =>
  Boolean(
    provider.clientId &&
      provider.tokenEndpoint &&
      (!providerRequiresClientSecret(provider) || provider.clientSecret),
  );

const providerFromRecord = (
  record: StoreIntegrationRecord,
): [string, NativeOAuthProvider] | null => {
  const id = readString(record.id)?.toLowerCase();
  const oauth = readOAuthFromRecord(record);
  const clientId = readString(oauth?.clientId);
  const tokenEndpoint =
    process.env[envKey(id ?? "", "TOKEN_URL")]?.trim() ||
    process.env[envKey(id ?? "", "TOKEN_ENDPOINT")]?.trim() ||
    readString(oauth?.tokenEndpoint);
  if (!id || !oauth || !clientId || !tokenEndpoint) return null;
  const providerId =
    readString(oauth.tokenExchangeProvider)?.toLowerCase() || id;
  return [
    providerId,
    {
      clientId,
      clientSecret: process.env[envKey(providerId, "CLIENT_SECRET")],
      tokenEndpoint,
      tokenAuth: oauth.tokenAuth === "basic" ? "basic" : "body",
      tokenRedirectParam: readString(oauth.tokenRedirectParam) ?? undefined,
    },
  ];
};

const loadProviders = async (ctx: ActionCtx) => {
  const integrations = (await ctx.runQuery(
    api.data.integrations.listStoreIntegrations,
    {},
  )) as StoreIntegrationRecord[];
  const providers = new Map<string, NativeOAuthProvider>();
  providers.set("google-workspace", {
    clientId:
      process.env.WORKSPACE_CLIENT_ID ??
      "398468929332-q768etk5go3lbjbdh9nth3d505pc7aqk.apps.googleusercontent.com",
    clientSecret:
      process.env.STELLA_NATIVE_OAUTH_GOOGLE_WORKSPACE_CLIENT_SECRET,
    tokenEndpoint: "https://oauth2.googleapis.com/token",
    tokenAuth: "body",
    requiresClientSecret: true,
  });
  for (const integration of integrations) {
    const provider = providerFromRecord(integration);
    if (provider) providers.set(provider[0], provider[1]);
  }
  return providers;
};

const exchangeNativeOAuthToken = async (
  provider: NativeOAuthProvider,
  body: NativeOAuthExchangeBody,
) => {
  const grantType = readString(body.grant_type) ?? "authorization_code";
  const clientId = readString(body.client_id);
  if (clientId !== provider.clientId) {
    return { response: errorResponse(400, "Invalid OAuth client.") };
  }
  if (!isNativeOAuthProviderConfigured(provider)) {
    return { response: errorResponse(503, "OAuth provider is not configured.") };
  }

  const params = new URLSearchParams({ grant_type: grantType });
  if ((provider.tokenAuth ?? "body") === "body") {
    params.set("client_id", provider.clientId);
    if (provider.clientSecret) params.set("client_secret", provider.clientSecret);
  }

  if (grantType === "authorization_code") {
    const code = readString(body.code);
    const redirectUri = readString(body.redirect_uri);
    if (!code || !redirectUri) {
      return { response: errorResponse(400, "Missing OAuth code.") };
    }
    params.set("code", code);
    params.set(provider.tokenRedirectParam ?? "redirect_uri", redirectUri);
    const state = readString(body.state);
    if (state) params.set("state", state);
    const codeVerifier = readString(body.code_verifier);
    if (codeVerifier) params.set("code_verifier", codeVerifier);
  } else if (grantType === "refresh_token") {
    const refreshToken = readString(body.refresh_token);
    if (!refreshToken) {
      return { response: errorResponse(400, "Missing OAuth refresh token.") };
    }
    params.set("refresh_token", refreshToken);
  } else {
    return { response: errorResponse(400, "Unsupported OAuth grant type.") };
  }

  const upstream = await fetch(provider.tokenEndpoint, {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/x-www-form-urlencoded",
      ...((provider.tokenAuth ?? "body") === "basic"
        ? {
            authorization: `Basic ${btoa(`${provider.clientId}:${provider.clientSecret ?? ""}`)}`,
          }
        : {}),
    },
    body: params,
  });
  const text = await upstream.text();
  const payload = parseJsonObject(text);
  if (!upstream.ok) {
    return {
      response: jsonResponse(
        {
          error: "OAuth token exchange failed.",
          provider_error:
            typeof payload?.error === "string" ? payload.error : undefined,
        },
        upstream.status,
      ),
    };
  }
  return { response: jsonResponse(payload) };
};

export const registerNativeOAuthRoutes = (http: HttpRouter) => {
  registerCorsOptions(http, [
    "/api/native-integrations/catalog",
    "/api/native-integrations/connect-link",
    "/api/native-integrations/run",
    "/api/native-oauth/providers",
    "/api/native-oauth/token",
  ]);

  http.route({
    path: "/api/admin/native-integrations/upsert",
    method: "POST",
    handler: httpAction(async (ctx, request) => {
      const admin = requireAdminRequest(request);
      if (!admin.ok) return admin.response;
      const body = await parseUnknownBody(request);
      if (!body || typeof body !== "object" || Array.isArray(body)) {
        return jsonResponse({ error: "Invalid integration payload." }, 400);
      }
      await ctx.runMutation(
        internal.data.integrations.upsertPublicIntegration,
        body as never,
      );
      return jsonResponse({ ok: true });
    }),
  });

  http.route({
    path: "/api/native-integrations/catalog",
    method: "GET",
    handler: httpAction(async (ctx, request) =>
      handleCorsRequest(request, async (origin) => {
        const integrations = await ctx.runQuery(
          api.data.integrations.listStoreIntegrations,
          {},
        );
        return jsonResponse({ integrations }, 200, origin);
      }),
    ),
  });

  http.route({
    path: "/api/native-integrations/connect-link",
    method: "POST",
    handler: httpAction(async (ctx, request) =>
      handleCorsRequest(request, async (origin) => {
        const identity = await requireUserIdentity(ctx);
        const body = (await parseUnknownBody(request)) as
          | NativeIntegrationRequestBody
          | null;
        const id = readString(body?.id)?.toLowerCase();
        if (!id) return errorResponse(400, "Missing integration id.", origin);
        const integration = await loadPublicIntegration(ctx, id);
        const connector = integration ? readComposioConnector(integration) : null;
        if (!connector) {
          return errorResponse(400, "Integration is not Composio-backed.", origin);
        }
        const composio = requireComposioConfig();
        if (!composio.config) return withCors(composio.response, origin);
        try {
          const sessionId = await ensureComposioSession(ctx, {
            ownerId: identity.tokenIdentifier,
            integrationId: connector.id,
            toolkit: connector.toolkit,
            config: composio.config,
          });
          const payload = await composioFetch(
            `/session/${encodeURIComponent(sessionId)}/link`,
            {
              method: "POST",
              body: JSON.stringify({ toolkit: connector.toolkit }),
            },
            composio.config,
          );
          const url = composioLinkFromPayload(payload);
          if (!url) {
            return errorResponse(502, "Composio did not return a connect link.", origin);
          }
          return jsonResponse({ url, sessionId }, 200, origin);
        } catch (error) {
          console.error("[native-integrations] composio connect-link failed", {
            id,
            message: error instanceof Error ? error.message : String(error),
          });
          return errorResponse(502, "Could not create the connection link.", origin);
        }
      }),
    ),
  });

  http.route({
    path: "/api/native-integrations/run",
    method: "POST",
    handler: httpAction(async (ctx, request) =>
      handleCorsRequest(request, async (origin) => {
        const identity = await requireUserIdentity(ctx);
        const body = (await parseUnknownBody(request)) as
          | NativeIntegrationRequestBody
          | null;
        const id = readString(body?.id)?.toLowerCase();
        const action = readString(body?.action);
        if (!id || !action) {
          return errorResponse(400, "Missing integration action.", origin);
        }
        const integration = await loadPublicIntegration(ctx, id);
        const connector = integration ? readComposioConnector(integration) : null;
        if (!connector) {
          return errorResponse(400, "Integration is not Composio-backed.", origin);
        }
        const composio = requireComposioConfig();
        if (!composio.config) return withCors(composio.response, origin);
        try {
          const sessionId = await ensureComposioSession(ctx, {
            ownerId: identity.tokenIdentifier,
            integrationId: connector.id,
            toolkit: connector.toolkit,
            config: composio.config,
          });
          const payload = await composioFetch(
            `/session/${encodeURIComponent(sessionId)}/execute`,
            {
              method: "POST",
              body: JSON.stringify({
                tool_slug: action,
                arguments:
                  body?.input && typeof body.input === "object" && !Array.isArray(body.input)
                    ? body.input
                    : {},
              }),
            },
            composio.config,
          );
          return jsonResponse(payload, 200, origin);
        } catch (error) {
          console.error("[native-integrations] composio run failed", {
            id,
            action,
            message: error instanceof Error ? error.message : String(error),
          });
          return errorResponse(502, "Could not run the integration action.", origin);
        }
      }),
    ),
  });

  http.route({
    path: "/api/native-oauth/providers",
    method: "GET",
    handler: httpAction(async (ctx, request) =>
      handleCorsRequest(request, async (origin) => {
        const identity = await ctx.auth.getUserIdentity();
        if (!identity) return errorResponse(401, "Unauthorized", origin);
        const providers = await loadProviders(ctx);
        return jsonResponse(
          {
            providers: Array.from(providers.entries())
              .filter(([, provider]) => isNativeOAuthProviderConfigured(provider))
              .map(([id, provider]) => ({
                id,
                clientId: provider.clientId,
                externalCallbackReady: true,
              })),
          },
          200,
          origin,
        );
      }),
    ),
  });

  http.route({
    path: "/api/native-oauth/token",
    method: "POST",
    handler: httpAction(async (ctx, request) =>
      handleCorsRequest(request, async (origin) => {
        const identity = await ctx.auth.getUserIdentity();
        if (!identity) return errorResponse(401, "Unauthorized", origin);
        const body = await parseBody(request);
        const providerId = readString(body?.provider)?.toLowerCase();
        const providers = await loadProviders(ctx);
        const provider = providerId ? providers.get(providerId) : null;
        if (!body || !provider) {
          return errorResponse(400, "Unknown OAuth provider.", origin);
        }
        try {
          const { response } = await exchangeNativeOAuthToken(provider, body);
          return withCors(response, origin);
        } catch (error) {
          console.error("[native-oauth] token exchange failed", {
            provider: providerId,
            message: error instanceof Error ? error.message : String(error),
          });
          return errorResponse(500, "OAuth token exchange failed.", origin);
        }
      }),
    ),
  });
};
