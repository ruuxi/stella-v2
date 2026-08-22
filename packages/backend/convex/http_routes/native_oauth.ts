import type { HttpRouter } from "convex/server";
import { ConvexError } from "convex/values";
import { httpAction, type ActionCtx } from "../_generated/server";
import { api, internal } from "../_generated/api";
import {
  composioPathBlocked,
  DEFAULT_ROLLOUT,
  resolveRoute,
} from "../connectors/routing";
import {
  CONNECTOR_ENV,
  isFirstPartyExecutionEnabled,
  isProviderEnabled,
} from "../connectors/env";
import {
  firstPartyActionOperation,
  firstPartyProviderForConnector,
  firstPartyProviderForConnectorAction,
} from "../connectors/executors/first_party";
import {
  getProviderManifest,
  listProviderManifests,
  type ProviderManifest,
} from "../connectors/oauth/providers";
import {
  parseSnowflakeTenantRegistrations,
  resolveProviderClientCredentials,
} from "../connectors/oauth/client_credentials";
import { normalizeSnowflakeAccountOrigin } from "../connectors/snowflake";
import {
  apiKeyProviderForConnectorAction,
  getApiKeyCredentialProfile,
  getApiKeyCredentialProfiles,
  getApiKeyProviderDescriptor,
  isApiKeyProviderVerified,
} from "../connectors/api_keys/providers";
import {
  getHostedConnectProviderDescriptor,
  hostedConnectProviderForConnectorAction,
  isHostedConnectProviderVerified,
} from "../connectors/hosted_connect/providers";
import { isHostedConnectEgressTransportAvailable } from "../connectors/hosted_connect/transport";
import { ConnectorError, connectorErrorHttpStatus } from "../connectors/errors";
import {
  errorResponse,
  handleCorsRequest,
  jsonResponse,
  registerCorsOptions,
  withCors,
} from "../http_shared/cors";
import { requireAdminRequest } from "../http_shared/admin";
import {
  RequestBodyLimitError,
  readRequestTextBounded,
} from "../http_shared/bounded_request_body";
import {
  DEFAULT_INTEGRATION_ACTIONS_PAGE_SIZE,
  MAX_INTEGRATION_ACTIONS_PAGE_SIZE,
  MAX_INTEGRATION_ACTION_SCHEMA_BYTES,
  MAX_PUBLISHED_INTEGRATION_ACTIONS,
} from "../lib/native_integration_limits";
import {
  canonicalizePublicConnectorId,
  isSafeComposioActionName,
  normalizeComposioConnectorIdentity,
} from "../lib/composio_identifiers.js";

type StoreIntegrationRecord = {
  id?: unknown;
  connector?: unknown;
};

type StoreConnectorRecord = {
  type?: unknown;
  toolkit?: unknown;
  provider?: unknown;
};

type ComposioSessionResponse = {
  id?: unknown;
  sessionId?: unknown;
  session_id?: unknown;
};

type ComposioLinkResponse = {
  link?: unknown;
  url?: unknown;
  redirectUrl?: unknown;
  redirect_url?: unknown;
};

type NativeIntegrationRequestBody = {
  id?: unknown;
  action?: unknown;
  input?: unknown;
  apiKey?: unknown;
  credentialSlot?: unknown;
  origin?: unknown;
  token?: unknown;
  expectedGeneration?: unknown;
  accountOrigin?: unknown;
};

type PublishedIntegrationAction = {
  name: string;
  providerActionName?: string;
  title?: string;
  description?: string;
  inputSchemaJson: string;
};

const SAFE_PROVIDER_ACTION_NAME = /^[A-Z0-9][A-Z0-9_]{1,127}$/u;
const MAX_ADMIN_INTEGRATION_BODY_BYTES = 4 * 1024 * 1024;
const MAX_NATIVE_INTEGRATION_REQUEST_BODY_BYTES = 1024 * 1024;

const isRateLimitError = (error: unknown) =>
  error instanceof ConvexError &&
  typeof error.data === "object" &&
  error.data !== null &&
  "code" in error.data &&
  error.data.code === "RATE_LIMITED";
const MAX_COMPOSIO_RESPONSE_BYTES = 2 * 1024 * 1024;
const COMPOSIO_REQUEST_TIMEOUT_MS = 30_000;

type OAuthProviderReadiness = {
  id: string;
  authType: "oauth";
  accountBound: boolean;
  configured: boolean;
  enabled: boolean;
  verificationStatus: "verified" | "in_review" | "unverified";
  executorRegistered: boolean;
  executionEnabled: boolean;
  connectReady: boolean;
  externalCallbackReady: boolean;
  blockers: string[];
};

const providerHasRegistration = (manifest: ProviderManifest): boolean => {
  try {
    if (manifest.accountBound === "snowflake") {
      return (
        parseSnowflakeTenantRegistrations(
          process.env[CONNECTOR_ENV.SNOWFLAKE_TENANTS_JSON],
        ).size > 0
      );
    }
    resolveProviderClientCredentials(manifest.key);
    return true;
  } catch {
    return false;
  }
};

/** Secret-free deployment readiness. Per-user account/rollout readiness is separate. */
export const buildOAuthProviderReadiness = (): OAuthProviderReadiness[] => {
  const executionEnabled = isFirstPartyExecutionEnabled();
  return listProviderManifests()
    .filter((manifest) => manifest.key !== "mock")
    .map((manifest) => {
      const configured = providerHasRegistration(manifest);
      const enabled = isProviderEnabled(manifest.key);
      const executorRegistered = Object.keys(
        manifest.connectorBindings ?? {},
      ).some(
        (connectorId) =>
          firstPartyProviderForConnector(connectorId) === manifest.key,
      );
      const blockers = [
        ...(!configured ? ["registration_missing"] : []),
        ...(!enabled ? ["provider_disabled"] : []),
        ...(manifest.verificationStatus !== "verified"
          ? ["verification_incomplete"]
          : []),
        ...(!executorRegistered ? ["executor_not_registered"] : []),
        ...(!executionEnabled ? ["execution_disabled"] : []),
      ];
      const connectReady = blockers.length === 0;
      return {
        id: manifest.key,
        authType: "oauth" as const,
        accountBound: Boolean(manifest.accountBound),
        configured,
        enabled,
        verificationStatus: manifest.verificationStatus,
        executorRegistered,
        executionEnabled,
        connectReady,
        externalCallbackReady: connectReady,
        blockers,
      };
    })
    .sort((left, right) => left.id.localeCompare(right.id));
};

const readString = (value: unknown) =>
  typeof value === "string" && value.trim() ? value.trim() : null;

const parseUnknownBody = async (request: Request) => {
  try {
    const text = await readRequestTextBounded(
      request,
      MAX_NATIVE_INTEGRATION_REQUEST_BODY_BYTES,
    );
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
};

const isJsonObject = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

const optionalTrimmedString = (value: unknown, maxLength: number) => {
  if (value === undefined) return undefined;
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > maxLength) return null;
  return trimmed;
};

export const normalizePublishedIntegrationActions = (
  integrationId: unknown,
  value: unknown,
):
  | { ok: true; actions: PublishedIntegrationAction[] }
  | { ok: false; error: string } => {
  if (!Array.isArray(value) || value.length === 0) {
    return {
      ok: false,
      error: "At least one schema-bearing action is required.",
    };
  }
  if (value.length > MAX_PUBLISHED_INTEGRATION_ACTIONS) {
    return {
      ok: false,
      error: `Integration action count exceeds ${MAX_PUBLISHED_INTEGRATION_ACTIONS}.`,
    };
  }

  const names = new Set<string>();
  const actions: PublishedIntegrationAction[] = [];
  for (const raw of value) {
    if (!isJsonObject(raw)) {
      return {
        ok: false,
        error: "Every integration action must be an object.",
      };
    }
    const name = readString(raw.name);
    if (
      !name ||
      !isSafeComposioActionName(integrationId, name) ||
      names.has(name)
    ) {
      return {
        ok: false,
        error: `Integration action name is invalid or duplicated: ${name ?? "<missing>"}.`,
      };
    }
    const title = optionalTrimmedString(raw.title, 512);
    const description = optionalTrimmedString(raw.description, 16_384);
    const providerActionName = optionalTrimmedString(
      raw.providerActionName,
      128,
    );
    if (title === null || description === null) {
      return {
        ok: false,
        error: `Integration action text is invalid: ${name}.`,
      };
    }
    if (
      providerActionName === null ||
      (providerActionName &&
        !SAFE_PROVIDER_ACTION_NAME.test(providerActionName))
    ) {
      return {
        ok: false,
        error: `Integration provider action name is invalid: ${name}.`,
      };
    }
    if (!isJsonObject(raw.inputSchema)) {
      return {
        ok: false,
        error: `Integration action is missing an object input schema: ${name}.`,
      };
    }
    const inputSchemaJson = JSON.stringify(raw.inputSchema);
    if (
      new TextEncoder().encode(inputSchemaJson).byteLength >
      MAX_INTEGRATION_ACTION_SCHEMA_BYTES
    ) {
      return {
        ok: false,
        error: `Integration action schema is too large: ${name}.`,
      };
    }
    names.add(name);
    actions.push({
      name,
      ...(providerActionName ? { providerActionName } : {}),
      ...(title ? { title } : {}),
      ...(description ? { description } : {}),
      inputSchemaJson,
    });
  }
  actions.sort((left, right) => left.name.localeCompare(right.name));
  return { ok: true, actions };
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

const readResponseTextBounded = async (
  response: Response,
  maxBytes: number,
): Promise<string> => {
  const contentLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    await response.body
      ?.cancel("response byte limit exceeded")
      .catch(() => undefined);
    throw new Error("Composio response exceeded the safe size limit.");
  }
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader
          .cancel("response byte limit exceeded")
          .catch(() => undefined);
        throw new Error("Composio response exceeded the safe size limit.");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
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

const readComposioApiKey = () => process.env.COMPOSIO_API_KEY?.trim() || null;

const readComposioBaseUrl = () =>
  (
    process.env.COMPOSIO_TOOL_ROUTER_URL?.trim() ||
    "https://backend.composio.dev/api/v3.1/tool_router"
  ).replace(/\/+$/u, "");

const readComposioConnector = (record: StoreIntegrationRecord) => {
  const connector =
    record.connector && typeof record.connector === "object"
      ? (record.connector as StoreConnectorRecord)
      : null;
  if (connector?.type !== "composio") return null;
  const identity = normalizeComposioConnectorIdentity(
    readString(record.id),
    readString(connector.toolkit),
  );
  if (!identity) return null;
  return {
    id: identity.id,
    toolkit: identity.toolkit,
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
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort("Composio request timed out."),
    COMPOSIO_REQUEST_TIMEOUT_MS,
  );
  try {
    const response = await fetch(`${config.baseUrl}${path}`, {
      ...init,
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        "x-api-key": config.apiKey,
        "x-consumer-api-key": config.apiKey,
        ...(init.headers ?? {}),
      },
      signal: controller.signal,
    });
    const text = await readResponseTextBounded(
      response,
      MAX_COMPOSIO_RESPONSE_BYTES,
    );
    const payload = parseJsonObject(text) ?? (text ? { text } : {});
    if (!response.ok) {
      // Never reflect or log an upstream response body: provider errors can
      // contain request arguments or credentials.
      throw new Error(`Composio request failed (${response.status}).`);
    }
    return payload;
  } finally {
    clearTimeout(timeout);
  }
};

export const buildComposioSessionBody = (args: {
  userId: string;
  toolkit: string;
}) => ({
  user_id: args.userId,
  toolkits: { enable: [args.toolkit] },
});

export const composioSessionIdFromPayload = (
  payload: Record<string, unknown>,
) =>
  readString((payload as ComposioSessionResponse).id) ??
  readString((payload as ComposioSessionResponse).sessionId) ??
  readString((payload as ComposioSessionResponse).session_id) ??
  readString(
    payload.session && typeof payload.session === "object"
      ? ((payload.session as Record<string, unknown>).id ??
          (payload.session as Record<string, unknown>).sessionId ??
          (payload.session as Record<string, unknown>).session_id)
      : null,
  );

/**
 * Whether a tool-router `GET /session/{id}/toolkits` payload shows the
 * given toolkit with a connected account. Tolerant of the shape
 * variants the tool-router API returns (items/data arrays, nested
 * toolkit slugs, item-level connected_account objects, connection
 * objects or bare booleans).
 */
export const composioToolkitConnectedFromPayload = (
  payload: Record<string, unknown>,
  toolkit: string,
): boolean => {
  const wanted = toolkit.trim().toLowerCase();
  const items = Array.isArray(payload.items)
    ? payload.items
    : Array.isArray(payload.data)
      ? payload.data
      : Array.isArray(payload.toolkits)
        ? payload.toolkits
        : [];
  for (const raw of items) {
    if (!raw || typeof raw !== "object") continue;
    const item = raw as Record<string, unknown>;
    const toolkitRecord =
      item.toolkit && typeof item.toolkit === "object"
        ? (item.toolkit as Record<string, unknown>)
        : null;
    const slug = (
      readString(toolkitRecord?.slug) ??
      readString(item.slug) ??
      readString(item.name) ??
      ""
    ).toLowerCase();
    if (slug !== wanted) continue;
    if (item.is_connected === true || item.isConnected === true) return true;
    const itemAccount =
      item.connected_account && typeof item.connected_account === "object"
        ? (item.connected_account as Record<string, unknown>)
        : item.connectedAccount && typeof item.connectedAccount === "object"
          ? (item.connectedAccount as Record<string, unknown>)
          : null;
    const itemAccountStatus = readString(itemAccount?.status)?.toUpperCase();
    if (itemAccountStatus) return itemAccountStatus === "ACTIVE";
    const connection =
      item.connection && typeof item.connection === "object"
        ? (item.connection as Record<string, unknown>)
        : null;
    if (!connection) return false;
    const connectedAccount =
      connection.connectedAccount &&
      typeof connection.connectedAccount === "object"
        ? (connection.connectedAccount as Record<string, unknown>)
        : connection.connected_account &&
            typeof connection.connected_account === "object"
          ? (connection.connected_account as Record<string, unknown>)
          : null;
    const status = readString(connectedAccount?.status)?.toUpperCase();
    if (status) return status === "ACTIVE";
    return connection.isActive === true || connection.is_active === true;
  }
  return false;
};

export const composioLinkFromPayload = (payload: Record<string, unknown>) =>
  readString((payload as ComposioLinkResponse).link) ??
  readString((payload as ComposioLinkResponse).url) ??
  readString((payload as ComposioLinkResponse).redirectUrl) ??
  readString((payload as ComposioLinkResponse).redirect_url) ??
  readString(
    payload.data && typeof payload.data === "object"
      ? ((payload.data as Record<string, unknown>).link ??
          (payload.data as Record<string, unknown>).url ??
          (payload.data as Record<string, unknown>).redirectUrl ??
          (payload.data as Record<string, unknown>).redirect_url)
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
  )) as {
    mode?: string;
    externalId?: string;
    config?: Record<string, unknown>;
  } | null;
  const existingSessionId =
    existing?.mode === "composio"
      ? (readString(existing.externalId) ??
        readString(existing.config?.sessionId))
      : null;
  if (existingSessionId) return existingSessionId;

  const userId = `stella_${(await sha256Hex(args.ownerId)).slice(0, 32)}`;
  const payload = await composioFetch(
    "/session",
    {
      method: "POST",
      body: JSON.stringify(
        buildComposioSessionBody({ userId, toolkit: args.toolkit }),
      ),
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
      config: {},
    },
  );
  return sessionId;
};

const loadComposioSessionId = async (
  ctx: ActionCtx,
  ownerId: string,
  integrationId: string,
) => {
  const existing = (await ctx.runQuery(
    internal.data.integrations.getUserIntegrationByOwnerAndProvider,
    { ownerId, provider: integrationId },
  )) as {
    mode?: string;
    externalId?: string;
    config?: Record<string, unknown>;
  } | null;
  if (existing?.mode !== "composio") return null;
  return (
    readString(existing?.externalId) ?? readString(existing?.config?.sessionId)
  );
};

const loadPublicIntegration = async (ctx: ActionCtx, id: string) =>
  (await ctx.runQuery(internal.data.integrations.getPublicIntegrationById, {
    id,
  })) as StoreIntegrationRecord | null;

/**
 * Once a connector's rollout reaches `first_party_only` (or `disabled`), the
 * Composio connect/run path must refuse it so the two executors never run the
 * same connector. Absence of a rollout row means the default `composio_only`
 * mode, so unmigrated connectors are entirely unaffected.
 */
const isComposioPathBlocked = async (
  ctx: ActionCtx,
  connectorId: string,
): Promise<boolean> => {
  const rollout = await ctx.runQuery(
    internal.connectors.rollouts.getConnectorRollout,
    { connectorId },
  );
  return rollout ? composioPathBlocked(rollout.mode) : false;
};

const resolveNativeExecutionRoute = async (
  ctx: ActionCtx,
  ownerId: string,
  connectorId: string,
  action: string,
) => {
  const provider = firstPartyProviderForConnectorAction(connectorId, action);
  if (!provider) return null;
  const operation = firstPartyActionOperation(provider, action);
  if (!operation) return null;
  const apiKeyDescriptor = apiKeyProviderForConnectorAction(
    connectorId,
    action,
  );
  const hostedConnectDescriptor = hostedConnectProviderForConnectorAction(
    connectorId,
    action,
  );
  const [readiness, storedRollout] = await Promise.all([
    hostedConnectDescriptor
      ? ctx.runQuery(
          internal.connectors.hosted_connect.vault.getHostedConnectReadiness,
          { ownerId, connectorId },
        )
      : apiKeyDescriptor
        ? ctx.runQuery(internal.connectors.api_keys.vault.getApiKeyReadiness, {
            ownerId,
            connectorId,
            action,
          })
        : ctx.runQuery(
            internal.connectors.oauth.accounts.getConnectorReadiness,
            { ownerId, connectorId },
          ),
    ctx.runQuery(internal.connectors.rollouts.getConnectorRollout, {
      connectorId,
    }),
  ]);
  const rollout = storedRollout ?? { ...DEFAULT_ROLLOUT, connectorId };
  return resolveRoute({
    rollout,
    ownerId,
    operation,
    killSwitchEnabled: isFirstPartyExecutionEnabled(),
    hasFirstPartyReady:
      Boolean(readiness?.ready) && readiness?.provider === provider,
  });
};

const firstPartyConnectTarget = async (
  ctx: ActionCtx,
  ownerId: string,
  connectorId: string,
): Promise<{
  provider: string;
  firstPartyOnly: boolean;
  authType: "oauth" | "api_key" | "hosted_connect";
} | null> => {
  const provider = firstPartyProviderForConnector(connectorId);
  if (!provider || !isFirstPartyExecutionEnabled()) return null;
  const apiKeyDescriptor = getApiKeyProviderDescriptor(connectorId);
  const hostedConnectDescriptor =
    getHostedConnectProviderDescriptor(connectorId);
  // A hosted-connect provider is only offered for first-party connection when
  // the enforced egress transport exists; otherwise it fails closed to the
  // Composio default rather than prompting for a token that cannot be stored.
  if (hostedConnectDescriptor && !isHostedConnectEgressTransportAvailable()) {
    return null;
  }
  const oauthManifest =
    apiKeyDescriptor || hostedConnectDescriptor
      ? null
      : getProviderManifest(provider);
  if (
    oauthManifest?.accountBound &&
    oauthManifest.verificationStatus !== "verified"
  ) {
    return null;
  }
  const storedRollout = await ctx.runQuery(
    internal.connectors.rollouts.getConnectorRollout,
    { connectorId },
  );
  const rollout = storedRollout ?? { ...DEFAULT_ROLLOUT, connectorId };
  const firstPartySelected =
    rollout.mode === "first_party_preferred" ||
    rollout.mode === "first_party_only" ||
    resolveRoute({
      rollout,
      ownerId,
      operation: "read",
      killSwitchEnabled: true,
      hasFirstPartyReady: true,
    }).executor === "first_party";
  return firstPartySelected
    ? {
        provider,
        firstPartyOnly: rollout.mode === "first_party_only",
        authType: hostedConnectDescriptor
          ? "hosted_connect"
          : apiKeyDescriptor
            ? "api_key"
            : "oauth",
      }
    : null;
};

export const registerNativeOAuthRoutes = (http: HttpRouter) => {
  registerCorsOptions(http, [
    "/api/native-oauth/providers",
    "/api/native-integrations/catalog",
    "/api/native-integrations/actions",
    "/api/native-integrations/connect-link",
    "/api/native-integrations/api-key",
    "/api/native-integrations/connect-profile",
    "/api/native-integrations/disconnect",
    "/api/native-integrations/status",
    "/api/native-integrations/run",
  ]);

  http.route({
    path: "/api/native-oauth/providers",
    method: "GET",
    handler: httpAction(async (ctx, request) =>
      handleCorsRequest(request, async (origin) => {
        const identity = await ctx.auth.getUserIdentity();
        if (!identity) return errorResponse(401, "Unauthorized", origin);
        return jsonResponse(
          { providers: buildOAuthProviderReadiness() },
          200,
          origin,
        );
      }),
    ),
  });

  http.route({
    path: "/api/admin/native-integrations/upsert",
    method: "POST",
    handler: httpAction(async (ctx, request) => {
      const admin = requireAdminRequest(request);
      if (!admin.ok) return admin.response;
      let body: unknown;
      try {
        const text = await readRequestTextBounded(
          request,
          MAX_ADMIN_INTEGRATION_BODY_BYTES,
        );
        body = JSON.parse(text) as unknown;
      } catch (error) {
        if (error instanceof RequestBodyLimitError) {
          return jsonResponse({ error: error.message }, error.status);
        }
        return jsonResponse({ error: "Invalid integration payload." }, 400);
      }
      if (!isJsonObject(body)) {
        return jsonResponse({ error: "Invalid integration payload." }, 400);
      }
      const normalizedActions = normalizePublishedIntegrationActions(
        body.id,
        body.actions,
      );
      if (!normalizedActions.ok) {
        return jsonResponse({ error: normalizedActions.error }, 400);
      }
      try {
        const schemaValidation = await ctx.runAction(
          internal.node.native_integration_schemas
            .validatePublishedActionSchemas,
          {
            actions: normalizedActions.actions.map((action) => ({
              name: action.name,
              inputSchemaJson: action.inputSchemaJson,
            })),
          },
        );
        if (!schemaValidation.ok) {
          return jsonResponse(
            {
              error: `Integration action has an invalid input schema: ${schemaValidation.invalidAction ?? "<unknown>"}.`,
            },
            400,
          );
        }
      } catch (error) {
        console.error("[native-integrations] schema validation unavailable", {
          id: readString(body.id),
          message: error instanceof Error ? error.message : String(error),
        });
        return jsonResponse(
          { error: "Integration schema validation is unavailable." },
          503,
        );
      }
      try {
        const result = await ctx.runMutation(
          internal.data.integrations.upsertPublicIntegration,
          {
            id: body.id,
            name: body.name,
            provider: body.provider,
            category: body.category,
            auth: body.auth,
            catalogToolCount: body.catalogToolCount,
            actions: normalizedActions.actions,
            description: body.description,
            sourceUrl: body.sourceUrl,
            iconUrl: body.iconUrl,
            connector: body.connector,
            enabled: body.enabled,
            usagePolicy: body.usagePolicy,
          } as never,
        );
        return jsonResponse({ ok: true, actionCount: result.actionCount });
      } catch (error) {
        console.error("[native-integrations] catalog publication rejected", {
          id: readString(body.id),
          message: error instanceof Error ? error.message : String(error),
        });
        return jsonResponse({ error: "Invalid integration payload." }, 400);
      }
    }),
  });

  http.route({
    path: "/api/native-integrations/catalog",
    method: "GET",
    handler: httpAction(async (ctx, request) =>
      handleCorsRequest(request, async (origin) => {
        const integrations = await ctx.runQuery(
          internal.data.integrations.listStoreIntegrationsWithConnectors,
          {},
        );
        return jsonResponse({ integrations }, 200, origin);
      }),
    ),
  });

  http.route({
    path: "/api/native-integrations/actions",
    method: "GET",
    handler: httpAction(async (ctx, request) =>
      handleCorsRequest(request, async (origin) => {
        const identity = await ctx.auth.getUserIdentity();
        if (!identity) return errorResponse(401, "Unauthorized", origin);
        const searchParams = new URL(request.url).searchParams;
        const id = canonicalizePublicConnectorId(
          readString(searchParams.get("id")),
        );
        if (!id) return errorResponse(400, "Missing integration id.", origin);
        const exactAction = readString(searchParams.get("action"));
        try {
          if (exactAction) {
            const resolved = await ctx.runQuery(
              internal.data.integrations.getPublicIntegrationAction,
              { id, name: exactAction },
            );
            if (!resolved) {
              return errorResponse(
                404,
                "Executable integration action is unavailable.",
                origin,
              );
            }
            const inputSchema = JSON.parse(
              resolved.action.inputSchemaJson,
            ) as unknown;
            if (!isJsonObject(inputSchema)) throw new Error("invalid schema");
            return jsonResponse(
              {
                id,
                actionCount: 1,
                actions: [
                  {
                    name: resolved.action.name,
                    ...(resolved.action.title
                      ? { title: resolved.action.title }
                      : {}),
                    ...(resolved.action.description
                      ? { description: resolved.action.description }
                      : {}),
                    inputSchema,
                  },
                ],
                nextCursor: null,
              },
              200,
              origin,
            );
          }

          const limitRaw = searchParams.get("limit");
          const limit = limitRaw
            ? Number(limitRaw)
            : DEFAULT_INTEGRATION_ACTIONS_PAGE_SIZE;
          if (
            !Number.isSafeInteger(limit) ||
            limit < 1 ||
            limit > MAX_INTEGRATION_ACTIONS_PAGE_SIZE
          ) {
            return errorResponse(
              400,
              `Action page limit must be an integer from 1 to ${MAX_INTEGRATION_ACTIONS_PAGE_SIZE}.`,
              origin,
            );
          }
          const query = readString(searchParams.get("query")) ?? undefined;
          if (query && query.length > 200) {
            return errorResponse(400, "Action query is too long.", origin);
          }
          const publication = await ctx.runQuery(
            internal.data.integrations.listPublicIntegrationActions,
            {
              id,
              limit,
              cursor: readString(searchParams.get("cursor")),
              query,
            },
          );
          if (!publication) {
            return errorResponse(
              404,
              "Executable integration actions are unavailable.",
              origin,
            );
          }
          const actions = publication.actions.map(
            (action: {
              name: string;
              title?: string;
              description?: string;
              inputSchemaJson: string;
            }) => {
              const inputSchema = JSON.parse(action.inputSchemaJson) as unknown;
              if (!isJsonObject(inputSchema)) throw new Error("invalid schema");
              return {
                name: action.name,
                ...(action.title ? { title: action.title } : {}),
                ...(action.description
                  ? { description: action.description }
                  : {}),
                inputSchema,
              };
            },
          );
          return jsonResponse(
            {
              id: publication.id,
              actionCount: publication.actionCount,
              updatedAt: publication.updatedAt,
              actions,
              nextCursor: publication.isDone
                ? null
                : publication.continueCursor,
            },
            200,
            origin,
          );
        } catch {
          return errorResponse(
            503,
            "Executable integration actions are unavailable.",
            origin,
          );
        }
      }),
    ),
  });

  http.route({
    path: "/api/native-integrations/connect-link",
    method: "POST",
    handler: httpAction(async (ctx, request) =>
      handleCorsRequest(request, async (origin) => {
        const identity = await ctx.auth.getUserIdentity();
        if (!identity) return errorResponse(401, "Unauthorized", origin);
        const body = (await parseUnknownBody(
          request,
        )) as NativeIntegrationRequestBody | null;
        const id = canonicalizePublicConnectorId(readString(body?.id));
        if (!id) return errorResponse(400, "Missing integration id.", origin);
        const integration = await loadPublicIntegration(ctx, id);
        const connector = integration
          ? readComposioConnector(integration)
          : null;
        if (!connector) {
          return errorResponse(
            400,
            "Integration is not Composio-backed.",
            origin,
          );
        }
        const firstPartyTarget = await firstPartyConnectTarget(
          ctx,
          identity.tokenIdentifier,
          connector.id,
        );
        if (firstPartyTarget) {
          if (firstPartyTarget.authType === "hosted_connect") {
            const descriptor = getHostedConnectProviderDescriptor(connector.id);
            if (!descriptor) {
              return errorResponse(
                503,
                "The first-party connect connector is unavailable.",
                origin,
              );
            }
            if (
              !isProviderEnabled(descriptor.providerKey) ||
              !isHostedConnectProviderVerified(descriptor.providerKey)
            ) {
              return errorResponse(
                503,
                "The first-party connect connector is not ready.",
                origin,
              );
            }
            const status = await ctx.runQuery(
              internal.connectors.hosted_connect.vault
                .getHostedConnectReadiness,
              {
                ownerId: identity.tokenIdentifier,
                connectorId: connector.id,
              },
            );
            return jsonResponse(
              {
                authType: "hosted_connect",
                credentialLabel: descriptor.credentialLabel,
                originLabel: descriptor.originLabel,
                originPlaceholder: descriptor.originPlaceholder,
                boundOrigin: status?.boundOrigin,
                expectedGeneration: status?.generation,
                connected: status?.connected ?? false,
              },
              200,
              origin,
            );
          }
          if (firstPartyTarget.authType === "api_key") {
            const descriptor = getApiKeyProviderDescriptor(connector.id);
            if (!descriptor) {
              return errorResponse(
                503,
                "The first-party API-key connector is unavailable.",
                origin,
              );
            }
            if (
              !isProviderEnabled(descriptor.providerKey) ||
              !isApiKeyProviderVerified(descriptor.providerKey)
            ) {
              return errorResponse(
                503,
                "The first-party API-key connector is not ready.",
                origin,
              );
            }
            const status = await ctx.runQuery(
              internal.connectors.api_keys.vault.getApiKeyReadiness,
              {
                ownerId: identity.tokenIdentifier,
                connectorId: connector.id,
              },
            );
            return jsonResponse(
              {
                authType: "api_key",
                credentialLabel: descriptor.credentialLabel,
                expectedGeneration: status?.generation,
                connected: status?.connected ?? false,
                credentialProfiles: (status?.credentialProfiles ?? []).map(
                  (profile) => ({
                    credentialSlot: profile.credentialSlot,
                    credentialLabel: profile.credentialLabel,
                    connected: profile.connected,
                    expectedGeneration: profile.generation,
                  }),
                ),
                missingCredentialSlots:
                  status?.missingCredentialSlots ??
                  getApiKeyCredentialProfiles(descriptor).map(
                    (profile) => profile.credentialSlot,
                  ),
              },
              200,
              origin,
            );
          }
          try {
            let accountOrigin: string | undefined;
            if (
              firstPartyTarget.provider === "snowflake" &&
              typeof body?.accountOrigin !== "string"
            ) {
              return jsonResponse(
                {
                  authType: "account_origin",
                  credentialLabel: "Snowflake account URL",
                },
                200,
                origin,
              );
            }
            if (firstPartyTarget.provider === "snowflake") {
              try {
                accountOrigin = normalizeSnowflakeAccountOrigin(
                  body?.accountOrigin,
                );
              } catch {
                return errorResponse(
                  400,
                  "Invalid Snowflake account URL.",
                  origin,
                );
              }
              try {
                resolveProviderClientCredentials(
                  "snowflake",
                  undefined,
                  accountOrigin,
                );
              } catch {
                return errorResponse(
                  503,
                  "This Snowflake account is not registered with Stella.",
                  origin,
                );
              }
            }
            if (
              body?.accountOrigin !== undefined &&
              typeof body.accountOrigin !== "string"
            ) {
              return errorResponse(400, "Invalid account URL.", origin);
            }
            if (
              firstPartyTarget.provider !== "snowflake" &&
              body?.accountOrigin !== undefined
            ) {
              return errorResponse(
                400,
                "Account URL is not supported.",
                origin,
              );
            }
            const attempt = await ctx.runMutation(
              api.connectors.oauth.connect.startConnectAttempt,
              {
                connectorId: connector.id,
                provider: firstPartyTarget.provider,
                returnSurface: "desktop",
                accountOrigin,
              },
            );
            return jsonResponse(
              { url: attempt.authorizationUrl, attemptId: attempt.attemptId },
              200,
              origin,
            );
          } catch (error) {
            console.error(
              "[native-integrations] first-party connect-link failed",
              {
                id,
                message: error instanceof Error ? error.name : "error",
              },
            );
            if (firstPartyTarget.firstPartyOnly) {
              return errorResponse(
                503,
                "Could not create the first-party connection link.",
                origin,
              );
            }
            if (firstPartyTarget.provider === "snowflake") {
              return errorResponse(
                503,
                "Could not create the Snowflake connection link.",
                origin,
              );
            }
          }
        }
        if (await isComposioPathBlocked(ctx, connector.id)) {
          return errorResponse(
            409,
            "This integration now uses Stella's first-party connector.",
            origin,
          );
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
            return errorResponse(
              502,
              "Composio did not return a connect link.",
              origin,
            );
          }
          return jsonResponse({ url }, 200, origin);
        } catch (error) {
          console.error("[native-integrations] composio connect-link failed", {
            id,
            message: error instanceof Error ? error.message : String(error),
          });
          return errorResponse(
            502,
            "Could not create the connection link.",
            origin,
          );
        }
      }),
    ),
  });

  http.route({
    path: "/api/native-integrations/api-key",
    method: "POST",
    handler: httpAction(async (ctx, request) =>
      handleCorsRequest(request, async (origin) => {
        const identity = await ctx.auth.getUserIdentity();
        if (!identity) return errorResponse(401, "Unauthorized", origin);
        const body = (await parseUnknownBody(
          request,
        )) as NativeIntegrationRequestBody | null;
        const id = canonicalizePublicConnectorId(readString(body?.id));
        if (!id || typeof body?.apiKey !== "string") {
          return errorResponse(
            400,
            "Invalid API-key connection request.",
            origin,
          );
        }
        const expectedGeneration = body.expectedGeneration;
        const credentialSlot = readString(body.credentialSlot);
        if (
          expectedGeneration !== undefined &&
          (typeof expectedGeneration !== "number" ||
            !Number.isSafeInteger(expectedGeneration) ||
            expectedGeneration < 1)
        ) {
          return errorResponse(400, "Invalid credential generation.", origin);
        }
        const integration = await loadPublicIntegration(ctx, id);
        const connector = integration
          ? readComposioConnector(integration)
          : null;
        const descriptor = connector
          ? getApiKeyProviderDescriptor(connector.id)
          : null;
        if (!connector || !descriptor) {
          return errorResponse(
            400,
            "Integration does not accept an API key.",
            origin,
          );
        }
        const profiles = getApiKeyCredentialProfiles(descriptor);
        if (
          (credentialSlot &&
            !getApiKeyCredentialProfile(descriptor, credentialSlot)) ||
          (!credentialSlot && profiles.length > 1)
        ) {
          return errorResponse(
            400,
            "Select a valid product credential for this integration.",
            origin,
          );
        }
        if (
          !isProviderEnabled(descriptor.providerKey) ||
          !isApiKeyProviderVerified(descriptor.providerKey)
        ) {
          return errorResponse(
            409,
            "This first-party API-key connector is not ready.",
            origin,
          );
        }
        const firstPartyTarget = await firstPartyConnectTarget(
          ctx,
          identity.tokenIdentifier,
          connector.id,
        );
        if (!firstPartyTarget || firstPartyTarget.authType !== "api_key") {
          return errorResponse(
            409,
            "This integration is not selected for first-party connection.",
            origin,
          );
        }
        try {
          const result = await ctx.runAction(
            api.connectors.api_keys.vault.connectApiKey,
            {
              connectorId: connector.id,
              apiKey: body.apiKey,
              credentialSlot: credentialSlot ?? undefined,
              expectedGeneration:
                typeof expectedGeneration === "number"
                  ? expectedGeneration
                  : undefined,
            },
          );
          return jsonResponse(
            {
              connected: result.connected,
              executor: "first_party",
              provider: result.provider,
              credentialSlot: result.credentialSlot,
              generation: result.generation,
              replaced: result.replaced,
            },
            200,
            origin,
          );
        } catch (error) {
          console.error("[native-integrations] API-key connection rejected", {
            id,
            message: error instanceof Error ? error.name : "error",
          });
          if (isRateLimitError(error)) {
            return errorResponse(
              429,
              "Too many API-key changes. Wait before retrying explicitly.",
              origin,
            );
          }
          const code =
            error instanceof ConnectorError ? error.code : "internal_error";
          return errorResponse(
            connectorErrorHttpStatus(code),
            code === "credential_generation_conflict"
              ? "The stored credential changed. Reopen the connection prompt before retrying."
              : "Could not store this API key.",
            origin,
          );
        }
      }),
    ),
  });

  http.route({
    path: "/api/native-integrations/connect-profile",
    method: "POST",
    handler: httpAction(async (ctx, request) =>
      handleCorsRequest(request, async (origin) => {
        const identity = await ctx.auth.getUserIdentity();
        if (!identity) return errorResponse(401, "Unauthorized", origin);
        const body = (await parseUnknownBody(
          request,
        )) as NativeIntegrationRequestBody | null;
        const id = canonicalizePublicConnectorId(readString(body?.id));
        if (
          !id ||
          typeof body?.origin !== "string" ||
          typeof body?.token !== "string"
        ) {
          return errorResponse(400, "Invalid connect-profile request.", origin);
        }
        const expectedGeneration = body.expectedGeneration;
        if (
          expectedGeneration !== undefined &&
          (typeof expectedGeneration !== "number" ||
            !Number.isSafeInteger(expectedGeneration) ||
            expectedGeneration < 1)
        ) {
          return errorResponse(400, "Invalid credential generation.", origin);
        }
        const integration = await loadPublicIntegration(ctx, id);
        const connector = integration
          ? readComposioConnector(integration)
          : null;
        const descriptor = connector
          ? getHostedConnectProviderDescriptor(connector.id)
          : null;
        if (!connector || !descriptor) {
          return errorResponse(
            400,
            "Integration does not accept a connect profile.",
            origin,
          );
        }
        if (
          !isProviderEnabled(descriptor.providerKey) ||
          !isHostedConnectProviderVerified(descriptor.providerKey)
        ) {
          return errorResponse(
            409,
            "This first-party connect connector is not ready.",
            origin,
          );
        }
        if (!isHostedConnectEgressTransportAvailable()) {
          // Fail closed before any token reaches the vault: no enforced
          // first-party egress transport (DNS-pinning/allowlisting proxy) means
          // a validated origin could still be rebound to a private address.
          return errorResponse(
            503,
            "This connection is unavailable until Stella's secure egress transport is deployed.",
            origin,
          );
        }
        const firstPartyTarget = await firstPartyConnectTarget(
          ctx,
          identity.tokenIdentifier,
          connector.id,
        );
        if (
          !firstPartyTarget ||
          firstPartyTarget.authType !== "hosted_connect"
        ) {
          return errorResponse(
            409,
            "This integration is not selected for first-party connection.",
            origin,
          );
        }
        try {
          const result = await ctx.runAction(
            api.connectors.hosted_connect.vault.connectHostedConnectProfile,
            {
              connectorId: connector.id,
              origin: body.origin,
              token: body.token,
              expectedGeneration:
                typeof expectedGeneration === "number"
                  ? expectedGeneration
                  : undefined,
            },
          );
          return jsonResponse(
            {
              connected: result.connected,
              executor: "first_party",
              provider: result.provider,
              boundOrigin: result.boundOrigin,
              generation: result.generation,
              replaced: result.replaced,
            },
            200,
            origin,
          );
        } catch (error) {
          console.error("[native-integrations] connect-profile rejected", {
            id,
            message: error instanceof Error ? error.name : "error",
          });
          if (isRateLimitError(error)) {
            return errorResponse(
              429,
              "Too many connection changes. Wait before retrying explicitly.",
              origin,
            );
          }
          const code =
            error instanceof ConnectorError ? error.code : "internal_error";
          return errorResponse(
            connectorErrorHttpStatus(code),
            code === "credential_generation_conflict"
              ? "The stored connection changed. Reopen the connection prompt before retrying."
              : code === "invalid_origin"
                ? "That 1Password Connect server URL is not allowed."
                : code === "invalid_credential"
                  ? "That Connect access token was not accepted."
                  : "Could not store this connect profile.",
            origin,
          );
        }
      }),
    ),
  });

  http.route({
    path: "/api/native-integrations/disconnect",
    method: "POST",
    handler: httpAction(async (ctx, request) =>
      handleCorsRequest(request, async (origin) => {
        const identity = await ctx.auth.getUserIdentity();
        if (!identity) return errorResponse(401, "Unauthorized", origin);
        const body = (await parseUnknownBody(
          request,
        )) as NativeIntegrationRequestBody | null;
        const id = canonicalizePublicConnectorId(readString(body?.id));
        if (!id) return errorResponse(400, "Missing integration id.", origin);
        const integration = await loadPublicIntegration(ctx, id);
        const connector = integration
          ? readComposioConnector(integration)
          : null;
        const hostedDescriptor = connector
          ? getHostedConnectProviderDescriptor(connector.id)
          : null;
        const apiKeyDescriptor = connector
          ? getApiKeyProviderDescriptor(connector.id)
          : null;
        if (!connector || (!hostedDescriptor && !apiKeyDescriptor)) {
          return errorResponse(
            400,
            "Integration does not use a server-owned credential.",
            origin,
          );
        }
        try {
          const result = hostedDescriptor
            ? await ctx.runAction(
                api.connectors.hosted_connect.vault
                  .disconnectHostedConnectProfile,
                { connectorId: connector.id },
              )
            : await ctx.runAction(
                api.connectors.api_keys.vault.disconnectApiKey,
                { connectorId: connector.id },
              );
          return jsonResponse(
            { ...result, executor: "first_party" },
            200,
            origin,
          );
        } catch (error) {
          console.error("[native-integrations] first-party disconnect failed", {
            id,
            message: error instanceof Error ? error.name : "error",
          });
          if (isRateLimitError(error)) {
            return errorResponse(
              429,
              "Too many connection changes. Wait before retrying explicitly.",
              origin,
            );
          }
          return errorResponse(
            502,
            "Could not disconnect this integration.",
            origin,
          );
        }
      }),
    ),
  });

  http.route({
    path: "/api/native-integrations/status",
    method: "GET",
    handler: httpAction(async (ctx, request) =>
      handleCorsRequest(request, async (origin) => {
        const identity = await ctx.auth.getUserIdentity();
        if (!identity) return errorResponse(401, "Unauthorized", origin);
        const id = canonicalizePublicConnectorId(
          readString(new URL(request.url).searchParams.get("id")),
        );
        if (!id) return errorResponse(400, "Missing integration id.", origin);
        const integration = await loadPublicIntegration(ctx, id);
        const connector = integration
          ? readComposioConnector(integration)
          : null;
        if (!connector) {
          return errorResponse(
            400,
            "Integration is not Composio-backed.",
            origin,
          );
        }
        const firstPartyTarget = await firstPartyConnectTarget(
          ctx,
          identity.tokenIdentifier,
          connector.id,
        );
        let firstPartyFallbackStatus:
          | {
              provider: string;
              accountStatus: string;
              missingScopeGroups: string[];
              authType?: "api_key" | "hosted_connect";
              providerEnabled?: boolean;
              providerVerified?: boolean;
              credentialProfiles?: Array<{
                credentialSlot: string;
                credentialLabel: string;
                connected: boolean;
                configured: boolean;
                accountStatus: string;
                generation?: number;
                updatedAt?: number;
              }>;
              missingCredentialSlots?: string[];
              boundOrigin?: string;
            }
          | undefined;
        if (firstPartyTarget) {
          const readiness =
            firstPartyTarget.authType === "hosted_connect"
              ? await ctx.runQuery(
                  internal.connectors.hosted_connect.vault
                    .getHostedConnectReadiness,
                  {
                    ownerId: identity.tokenIdentifier,
                    connectorId: connector.id,
                  },
                )
              : firstPartyTarget.authType === "api_key"
                ? await ctx.runQuery(
                    internal.connectors.api_keys.vault.getApiKeyReadiness,
                    {
                      ownerId: identity.tokenIdentifier,
                      connectorId: connector.id,
                    },
                  )
                : await ctx.runQuery(
                    internal.connectors.oauth.accounts.getConnectorReadiness,
                    {
                      ownerId: identity.tokenIdentifier,
                      connectorId: connector.id,
                    },
                  );
          if (!readiness) {
            return errorResponse(
              503,
              "The first-party connection status is unavailable.",
              origin,
            );
          }
          const credentialReadiness =
            "authType" in readiness &&
            (readiness.authType === "api_key" ||
              readiness.authType === "hosted_connect")
              ? readiness
              : null;
          const boundOrigin =
            credentialReadiness && "boundOrigin" in credentialReadiness
              ? credentialReadiness.boundOrigin
              : undefined;
          if (readiness.ready || firstPartyTarget.firstPartyOnly) {
            return jsonResponse(
              {
                connected: readiness.ready,
                executor: "first_party",
                provider: firstPartyTarget.provider,
                accountStatus: readiness.accountStatus,
                missingScopeGroups:
                  "missingScopeGroups" in readiness
                    ? readiness.missingScopeGroups
                    : [],
                ...(credentialReadiness
                  ? {
                      authType: credentialReadiness.authType,
                      configured: credentialReadiness.configured,
                      generation: credentialReadiness.generation,
                      providerEnabled: credentialReadiness.providerEnabled,
                      providerVerified: credentialReadiness.providerVerified,
                      ...(boundOrigin ? { boundOrigin } : {}),
                      ...("credentialProfiles" in credentialReadiness
                        ? {
                            credentialProfiles:
                              credentialReadiness.credentialProfiles,
                            missingCredentialSlots:
                              credentialReadiness.missingCredentialSlots,
                          }
                        : {}),
                    }
                  : {}),
              },
              200,
              origin,
            );
          }
          if (
            ("accountId" in readiness && readiness.accountId) ||
            ("configured" in readiness && readiness.configured)
          ) {
            firstPartyFallbackStatus = {
              provider: firstPartyTarget.provider,
              accountStatus: readiness.accountStatus ?? "unknown",
              missingScopeGroups:
                "missingScopeGroups" in readiness
                  ? readiness.missingScopeGroups
                  : [],
              ...(credentialReadiness
                ? {
                    authType: credentialReadiness.authType,
                    providerEnabled: credentialReadiness.providerEnabled,
                    providerVerified: credentialReadiness.providerVerified,
                    ...(boundOrigin ? { boundOrigin } : {}),
                    ...("credentialProfiles" in credentialReadiness
                      ? {
                          credentialProfiles:
                            credentialReadiness.credentialProfiles,
                          missingCredentialSlots:
                            credentialReadiness.missingCredentialSlots,
                        }
                      : {}),
                  }
                : {}),
            };
          }
        }
        if (!firstPartyTarget) {
          const hostedDescriptor = getHostedConnectProviderDescriptor(
            connector.id,
          );
          const descriptor = getApiKeyProviderDescriptor(connector.id);
          if (hostedDescriptor) {
            const readiness = await ctx.runQuery(
              internal.connectors.hosted_connect.vault
                .getHostedConnectReadiness,
              {
                ownerId: identity.tokenIdentifier,
                connectorId: connector.id,
              },
            );
            if (readiness?.configured) {
              firstPartyFallbackStatus = {
                provider: hostedDescriptor.providerKey,
                accountStatus: readiness.accountStatus,
                missingScopeGroups: [],
                authType: "hosted_connect",
                providerEnabled: readiness.providerEnabled,
                providerVerified: readiness.providerVerified,
                ...(readiness.boundOrigin
                  ? { boundOrigin: readiness.boundOrigin }
                  : {}),
              };
            }
          } else if (descriptor) {
            const readiness = await ctx.runQuery(
              internal.connectors.api_keys.vault.getApiKeyReadiness,
              {
                ownerId: identity.tokenIdentifier,
                connectorId: connector.id,
              },
            );
            if (readiness?.configured) {
              firstPartyFallbackStatus = {
                provider: descriptor.providerKey,
                accountStatus: readiness.accountStatus,
                missingScopeGroups: [],
                authType: "api_key",
                providerEnabled: readiness.providerEnabled,
                providerVerified: readiness.providerVerified,
                credentialProfiles: readiness.credentialProfiles,
                missingCredentialSlots: readiness.missingCredentialSlots,
              };
            }
          }
        }
        const composio = requireComposioConfig();
        if (!composio.config) return withCors(composio.response, origin);
        try {
          // Look up the user's existing session only — a status probe
          // must never create one.
          const sessionId = await loadComposioSessionId(
            ctx,
            identity.tokenIdentifier,
            connector.id,
          );
          if (!sessionId) {
            return jsonResponse(
              {
                connected: false,
                ...(firstPartyFallbackStatus
                  ? {
                      executor: "composio",
                      firstParty: firstPartyFallbackStatus,
                    }
                  : {}),
              },
              200,
              origin,
            );
          }
          const payload = await composioFetch(
            `/session/${encodeURIComponent(sessionId)}/toolkits`,
            { method: "GET" },
            composio.config,
          );
          return jsonResponse(
            {
              connected: composioToolkitConnectedFromPayload(
                payload,
                connector.toolkit,
              ),
              ...(firstPartyFallbackStatus
                ? {
                    executor: "composio",
                    firstParty: firstPartyFallbackStatus,
                  }
                : {}),
            },
            200,
            origin,
          );
        } catch (error) {
          console.error("[native-integrations] composio status failed", {
            id,
            message: error instanceof Error ? error.message : String(error),
          });
          return errorResponse(
            502,
            "Could not check the connection status.",
            origin,
          );
        }
      }),
    ),
  });

  http.route({
    path: "/api/native-integrations/run",
    method: "POST",
    handler: httpAction(async (ctx, request) =>
      handleCorsRequest(request, async (origin) => {
        const identity = await ctx.auth.getUserIdentity();
        if (!identity) return errorResponse(401, "Unauthorized", origin);
        const body = (await parseUnknownBody(
          request,
        )) as NativeIntegrationRequestBody | null;
        const id = canonicalizePublicConnectorId(readString(body?.id));
        const action = readString(body?.action);
        if (!id || !action) {
          return errorResponse(400, "Missing integration action.", origin);
        }
        if (
          !isSafeComposioActionName(id, action) ||
          !isJsonObject(body?.input)
        ) {
          return errorResponse(400, "Invalid integration action.", origin);
        }
        // Resolve the connector and action in one Convex snapshot. This exact
        // child-row lookup is the server-side authorization boundary: clients
        // cannot execute arbitrary or cross-toolkit Composio slugs.
        const resolved = await ctx.runQuery(
          internal.data.integrations.getPublicIntegrationAction,
          { id, name: action },
        );
        const connector = resolved ? readComposioConnector(resolved) : null;
        if (!resolved || !connector) {
          return errorResponse(
            400,
            "Integration action is not allowed.",
            origin,
          );
        }
        let inputValidation: "valid" | "invalid" | "invalid_schema";
        try {
          inputValidation = await ctx.runAction(
            internal.node.native_integration_schemas.validateActionInput,
            {
              inputJson: JSON.stringify(body.input),
              schemaJson: resolved.action.inputSchemaJson,
            },
          );
        } catch (error) {
          console.error("[native-integrations] input validation unavailable", {
            id,
            action,
            message: error instanceof Error ? error.name : "error",
          });
          return errorResponse(
            503,
            "Integration action validation is unavailable.",
            origin,
          );
        }
        if (inputValidation === "invalid") {
          return errorResponse(
            400,
            "Integration action input failed schema validation.",
            origin,
          );
        }
        if (inputValidation === "invalid_schema") {
          return errorResponse(
            503,
            "Executable integration action schema is unavailable.",
            origin,
          );
        }
        const route = await resolveNativeExecutionRoute(
          ctx,
          identity.tokenIdentifier,
          connector.id,
          action,
        );
        if (
          !route &&
          firstPartyProviderForConnector(connector.id) &&
          (await isComposioPathBlocked(ctx, connector.id))
        ) {
          return errorResponse(
            409,
            "This integration now uses Stella's first-party connector.",
            origin,
          );
        }
        if (route?.executor === "refused") {
          return errorResponse(
            403,
            "This integration is currently unavailable.",
            origin,
          );
        }
        if (route?.executor === "first_party") {
          try {
            const result = await ctx.runAction(
              internal.connectors.execute.runFirstPartyConnectorAction,
              {
                ownerId: identity.tokenIdentifier,
                connectorId: connector.id,
                action,
                inputJson: JSON.stringify(body.input),
                requestId:
                  readString(request.headers.get("x-stella-request-id")) ??
                  undefined,
                schemaJson: resolved.action.inputSchemaJson,
              },
            );
            return jsonResponse(
              { data: result.output, error: null, successful: true },
              200,
              origin,
            );
          } catch (error) {
            console.error("[native-integrations] first-party run failed", {
              id,
              action,
              message: error instanceof Error ? error.name : "error",
            });
            const operation = firstPartyActionOperation(
              firstPartyProviderForConnectorAction(connector.id, action) ?? "",
              action,
            );
            return errorResponse(
              502,
              operation === "read"
                ? "The first-party integration call could not be completed."
                : "The provider result is uncertain. Stella did not retry this write; verify its result before trying again.",
              origin,
            );
          }
        }
        const sessionId = await loadComposioSessionId(
          ctx,
          identity.tokenIdentifier,
          connector.id,
        );
        if (!sessionId) {
          return errorResponse(
            409,
            "Connect this integration before using it.",
            origin,
          );
        }
        const composio = requireComposioConfig();
        if (!composio.config) return withCors(composio.response, origin);
        try {
          const statusPayload = await composioFetch(
            `/session/${encodeURIComponent(sessionId)}/toolkits`,
            { method: "GET" },
            composio.config,
          );
          if (
            !composioToolkitConnectedFromPayload(
              statusPayload,
              connector.toolkit,
            )
          ) {
            return errorResponse(
              409,
              "This integration is no longer connected.",
              origin,
            );
          }
          const payload = await composioFetch(
            `/session/${encodeURIComponent(sessionId)}/execute`,
            {
              method: "POST",
              body: JSON.stringify({
                tool_slug: resolved.action.providerActionName ?? action,
                arguments: body.input,
              }),
            },
            composio.config,
          );
          return jsonResponse(payload, 200, origin);
        } catch (error) {
          console.error("[native-integrations] composio run failed", {
            id,
            message: error instanceof Error ? error.message : String(error),
          });
          return errorResponse(
            502,
            "Could not run the integration action.",
            origin,
          );
        }
      }),
    ),
  });
};
