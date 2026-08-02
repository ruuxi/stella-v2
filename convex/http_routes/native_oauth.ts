import type { HttpRouter } from "convex/server";
import AjvModule from "ajv";
import { httpAction, type ActionCtx } from "../_generated/server";
import { internal } from "../_generated/api";
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
};

type PublishedIntegrationAction = {
  name: string;
  title?: string;
  description?: string;
  inputSchemaJson: string;
};

const SAFE_ACTION_NAME = /^[A-Z][A-Z0-9_]{1,127}$/u;
const MAX_ADMIN_INTEGRATION_BODY_BYTES = 4 * 1024 * 1024;
const MAX_NATIVE_INTEGRATION_REQUEST_BODY_BYTES = 1024 * 1024;
const MAX_COMPOSIO_RESPONSE_BYTES = 2 * 1024 * 1024;
const COMPOSIO_REQUEST_TIMEOUT_MS = 30_000;
const Ajv =
  (AjvModule as unknown as { default?: typeof AjvModule }).default ?? AjvModule;
const actionInputValidator = new Ajv({
  allErrors: true,
  strict: false,
  coerceTypes: false,
});

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
  value: unknown,
): { ok: true; actions: PublishedIntegrationAction[] } | { ok: false; error: string } => {
  if (!Array.isArray(value) || value.length === 0) {
    return { ok: false, error: "At least one schema-bearing action is required." };
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
      return { ok: false, error: "Every integration action must be an object." };
    }
    const name = readString(raw.name);
    if (!name || !SAFE_ACTION_NAME.test(name) || names.has(name)) {
      return {
        ok: false,
        error: `Integration action name is invalid or duplicated: ${name ?? "<missing>"}.`,
      };
    }
    const title = optionalTrimmedString(raw.title, 512);
    const description = optionalTrimmedString(raw.description, 16_384);
    if (title === null || description === null) {
      return { ok: false, error: `Integration action text is invalid: ${name}.` };
    }
    if (!isJsonObject(raw.inputSchema)) {
      return {
        ok: false,
        error: `Integration action is missing an object input schema: ${name}.`,
      };
    }
    try {
      actionInputValidator.compile(raw.inputSchema);
    } catch {
      return {
        ok: false,
        error: `Integration action has an invalid input schema: ${name}.`,
      };
    }
    const inputSchemaJson = JSON.stringify(raw.inputSchema);
    if (
      new TextEncoder().encode(inputSchemaJson).byteLength >
      MAX_INTEGRATION_ACTION_SCHEMA_BYTES
    ) {
      return { ok: false, error: `Integration action schema is too large: ${name}.` };
    }
    names.add(name);
    actions.push({
      name,
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

const validateActionInput = (
  schema: Record<string, unknown>,
  input: Record<string, unknown>,
): "valid" | "invalid" | "invalid_schema" => {
  try {
    return actionInputValidator.compile(schema)(input) ? "valid" : "invalid";
  } catch {
    return "invalid_schema";
  }
};

const readResponseTextBounded = async (
  response: Response,
  maxBytes: number,
): Promise<string> => {
  const contentLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    await response.body?.cancel("response byte limit exceeded").catch(() => undefined);
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
        await reader.cancel("response byte limit exceeded").catch(() => undefined);
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

const readComposioApiKey = () =>
  process.env.COMPOSIO_API_KEY?.trim() || null;

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

export const composioSessionIdFromPayload = (payload: Record<string, unknown>) =>
  readString((payload as ComposioSessionResponse).id) ??
  readString((payload as ComposioSessionResponse).sessionId) ??
  readString((payload as ComposioSessionResponse).session_id) ??
  readString(
    payload.session && typeof payload.session === "object"
      ? (payload.session as Record<string, unknown>).id ??
          (payload.session as Record<string, unknown>).sessionId ??
          (payload.session as Record<string, unknown>).session_id
      : null,
  );

/**
 * Whether a tool-router `GET /session/{id}/toolkits` payload shows the
 * given toolkit with a connected account. Tolerant of the shape
 * variants the tool-router API returns (items/data arrays, nested
 * toolkit slugs, connection objects or bare booleans).
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
    const connection =
      item.connection && typeof item.connection === "object"
        ? (item.connection as Record<string, unknown>)
        : null;
    if (!connection) return false;
    const connectedAccount =
      connection.connectedAccount && typeof connection.connectedAccount === "object"
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
      ? (payload.data as Record<string, unknown>).link ??
          (payload.data as Record<string, unknown>).url ??
          (payload.data as Record<string, unknown>).redirectUrl ??
          (payload.data as Record<string, unknown>).redirect_url
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
      ? readString(existing.externalId) ??
        readString(existing.config?.sessionId)
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

export const registerNativeOAuthRoutes = (http: HttpRouter) => {
  registerCorsOptions(http, [
    "/api/native-integrations/catalog",
    "/api/native-integrations/actions",
    "/api/native-integrations/connect-link",
    "/api/native-integrations/status",
    "/api/native-integrations/run",
  ]);

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
      const normalizedActions = normalizePublishedIntegrationActions(body.actions);
      if (!normalizedActions.ok) {
        return jsonResponse({ error: normalizedActions.error }, 400);
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
        const id = readString(searchParams.get("id"))?.toLowerCase();
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
            const inputSchema = JSON.parse(resolved.action.inputSchemaJson) as unknown;
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
          const actions = publication.actions.map((action: {
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
              ...(action.description ? { description: action.description } : {}),
              inputSchema,
            };
          });
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
          return jsonResponse({ url }, 200, origin);
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
    path: "/api/native-integrations/status",
    method: "GET",
    handler: httpAction(async (ctx, request) =>
      handleCorsRequest(request, async (origin) => {
        const identity = await ctx.auth.getUserIdentity();
        if (!identity) return errorResponse(401, "Unauthorized", origin);
        const id = readString(
          new URL(request.url).searchParams.get("id"),
        )?.toLowerCase();
        if (!id) return errorResponse(400, "Missing integration id.", origin);
        const integration = await loadPublicIntegration(ctx, id);
        const connector = integration ? readComposioConnector(integration) : null;
        if (!connector) {
          return errorResponse(400, "Integration is not Composio-backed.", origin);
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
            return jsonResponse({ connected: false }, 200, origin);
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
            },
            200,
            origin,
          );
        } catch (error) {
          console.error("[native-integrations] composio status failed", {
            id,
            message: error instanceof Error ? error.message : String(error),
          });
          return errorResponse(502, "Could not check the connection status.", origin);
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
        const body = (await parseUnknownBody(request)) as
          | NativeIntegrationRequestBody
          | null;
        const id = readString(body?.id)?.toLowerCase();
        const action = readString(body?.action);
        if (!id || !action) {
          return errorResponse(400, "Missing integration action.", origin);
        }
        if (!SAFE_ACTION_NAME.test(action) || !isJsonObject(body?.input)) {
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
          return errorResponse(400, "Integration action is not allowed.", origin);
        }
        let schema: Record<string, unknown>;
        try {
          const parsed = JSON.parse(resolved.action.inputSchemaJson) as unknown;
          if (!isJsonObject(parsed)) throw new Error("invalid schema");
          schema = parsed;
        } catch {
          return errorResponse(
            503,
            "Executable integration action schema is unavailable.",
            origin,
          );
        }
        const inputValidation = validateActionInput(schema, body.input);
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
        const sessionId = await loadComposioSessionId(
          ctx,
          identity.tokenIdentifier,
          connector.id,
        );
        if (!sessionId) {
          return errorResponse(409, "Connect this integration before using it.", origin);
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
                tool_slug: action,
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
          return errorResponse(502, "Could not run the integration action.", origin);
        }
      }),
    ),
  });
};
