import { makeFunctionReference, type HttpRouter } from "convex/server";
import { httpAction, type ActionCtx } from "../_generated/server";
import { internal } from "../_generated/api";
import { isAnonymousIdentity, requireUserIdentity } from "../auth";
import { assertOwnerDataAccessActive } from "../owner_lifecycle";
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
import { composioUserIdForOwner } from "../lib/composio_identity";
import {
  buildGoogleAdsMutationProxyRequest,
  effectiveGoogleAdsActionSchema,
  normalizeGoogleAdsProxyResponse,
} from "../lib/google_ads_mutations";
import { enforceActionRateLimit, RATE_STANDARD } from "../lib/rate_limits";

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
  annotations?: {
    readOnlyHint: boolean;
    destructiveHint: boolean;
    idempotentHint: boolean;
    source: "composio_tool_tags";
  };
  codeModePolicy?: {
    effect: "read";
    requiresApproval: false;
    policyVersion: string;
    toolkitVersion: string;
    reviewedInputSchemaJson: string;
    source: "stella_admin";
  };
  inputSchemaJson: string;
};

const SAFE_ACTION_NAME = /^[A-Z][A-Z0-9_]{1,127}$/u;
const SAFE_NATIVE_RUN_REQUEST_ID = /^[A-Za-z0-9._:-]{8,128}$/u;
const SAFE_CODE_POLICY_VERSION = /^[A-Za-z0-9._:-]{1,128}$/u;
const SAFE_COMPOSIO_TOOLKIT_VERSION = /^\d{8}_\d{2}$/u;
const MAX_ADMIN_INTEGRATION_BODY_BYTES = 4 * 1024 * 1024;
const MAX_ADMIN_COMPOSIO_RESOLUTION_BODY_BYTES = 16 * 1024;
const MAX_NATIVE_INTEGRATION_REQUEST_BODY_BYTES = 1024 * 1024;
const MAX_COMPOSIO_RESPONSE_BYTES = 2 * 1024 * 1024;
const COMPOSIO_REQUEST_TIMEOUT_MS = 30_000;

type ComposioProvisioningReservation =
  | {
      acquired: true;
      status: "reserved";
      providerDeadlineAt: number;
      quiescentAfterAt: number;
    }
  | { acquired: false; status: "busy" | "outcome_unknown" }
  | { acquired: false; status: "bound"; sessionId: string };

const reserveComposioSessionRef = makeFunctionReference<
  "mutation",
  {
    ownerId: string;
    ownerGeneration: string;
    integrationId: string;
    toolkit: string;
    composioUserId: string;
    attemptId: string;
    leaseId: string;
    now: number;
  },
  ComposioProvisioningReservation
>("composio_session_dispatch:reserveComposioSessionProvisioningInternal");
const markComposioSessionRef = makeFunctionReference<
  "mutation",
  {
    ownerId: string;
    ownerGeneration: string;
    attemptId: string;
    leaseId: string;
    now: number;
  },
  | { started: false }
  | { started: true; providerDeadlineAt: number; quiescentAfterAt: number }
>(
  "composio_session_dispatch:markComposioSessionProvisioningMayHaveStartedInternal",
);
const recordComposioSessionLocatorRef = makeFunctionReference<
  "mutation",
  {
    ownerId: string;
    ownerGeneration: string;
    attemptId: string;
    leaseId: string;
    sessionId: string;
    now: number;
  },
  boolean
>("composio_session_dispatch:recordComposioSessionProvisioningLocatorInternal");
const bindComposioSessionRef = makeFunctionReference<
  "mutation",
  {
    ownerId: string;
    ownerGeneration: string;
    integrationId: string;
    toolkit: string;
    composioUserId: string;
    attemptId: string;
    leaseId: string;
    sessionId: string;
    now: number;
  },
  boolean
>("composio_session_dispatch:bindComposioSessionProvisioningInternal");
const settleComposioSessionNotCreatedRef = makeFunctionReference<
  "mutation",
  {
    ownerId: string;
    ownerGeneration: string;
    attemptId: string;
    leaseId: string;
  },
  boolean
>(
  "composio_session_dispatch:settleComposioSessionProvisioningNotCreatedInternal",
);
const markComposioSessionUnknownRef = makeFunctionReference<
  "mutation",
  {
    ownerId: string;
    ownerGeneration: string;
    attemptId: string;
    leaseId: string;
    now: number;
    reason: string;
  },
  boolean
>(
  "composio_session_dispatch:markComposioSessionProvisioningOutcomeUnknownInternal",
);
const requestComposioSessionCleanupRef = makeFunctionReference<
  "mutation",
  {
    ownerId: string;
    ownerGeneration: string;
    attemptId: string;
    leaseId: string;
    sessionId: string;
    now: number;
    reason: string;
  },
  boolean
>(
  "composio_session_dispatch:requestComposioSessionProvisioningCleanupInternal",
);
const resolveComposioSessionOutcomeRef = makeFunctionReference<
  "mutation",
  {
    ownerId: string;
    ownerGeneration: string;
    integrationId: string;
    toolkit: string;
    composioUserId: string;
    attemptId: string;
    leaseId: string;
    resolution:
      | { kind: "recovered_session"; sessionId: string }
      | { kind: "provider_confirmed_not_created" };
    resolvedBy: string;
    evidence: string;
    now: number;
  },
  {
    resolution: "recovered_session" | "provider_confirmed_not_created";
    replayed: boolean;
  }
>(
  "composio_session_dispatch:resolveComposioSessionProvisioningOutcomeInternal",
);
const resolveComposioPrincipalRef = makeFunctionReference<
  "mutation",
  {
    ownerId: string;
    provider: string;
    sessionId: string;
    composioUserId: string;
    resolutionId: string;
    resolvedBy: string;
    evidence: string;
    now: number;
  },
  { replayed: boolean }
>("composio_purge_store:resolveOwnerComposioPrincipalInternal");

const beginComposioNativeRunRef = makeFunctionReference<
  "mutation",
  {
    ownerId: string;
    ownerGeneration: string;
    integrationId: string;
    toolkit: string;
    action: string;
    revision: string;
    expectedSessionId: string;
    requestId: string;
    fingerprint: string;
    leaseId: string;
    now: number;
  },
  { sessionId: string; providerDeadlineAt: number; leaseExpiresAt: number }
>("composio_native_dispatch:beginComposioNativeRunInternal");

const claimComposioNativeRunExecuteRef = makeFunctionReference<
  "mutation",
  {
    ownerId: string;
    ownerGeneration: string;
    integrationId: string;
    toolkit: string;
    action: string;
    revision: string;
    expectedSessionId: string;
    requestId: string;
    fingerprint: string;
    leaseId: string;
    now: number;
  },
  { providerDeadlineAt: number; leaseExpiresAt: number }
>("composio_native_dispatch:claimComposioNativeRunExecuteInternal");

const settleComposioNativeRunRef = makeFunctionReference<
  "mutation",
  {
    ownerId: string;
    ownerGeneration: string;
    requestId: string;
    fingerprint: string;
    leaseId: string;
    outcome: "succeeded" | "failed" | "unknown";
    now: number;
  },
  boolean
>("composio_native_dispatch:settleComposioNativeRunInternal");

export class ComposioUpstreamHttpError extends Error {
  readonly status: number;

  constructor(status: number) {
    super(`Composio request failed (${status}).`);
    this.name = "ComposioUpstreamHttpError";
    this.status = status;
  }
}

class ComposioDispatchDeadlineExpiredError extends Error {}

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

const requireActiveIntegrationIdentity = async (ctx: ActionCtx) => {
  try {
    const identity = await requireUserIdentity(ctx);
    if (isAnonymousIdentity(identity)) return "sign_in_required" as const;
    const { generation } = await assertOwnerDataAccessActive(
      ctx,
      identity.tokenIdentifier,
    );
    return { identity, ownerGeneration: generation };
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
  toolkit = "",
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
    if (!name || !SAFE_ACTION_NAME.test(name) || names.has(name)) {
      return {
        ok: false,
        error: `Integration action name is invalid or duplicated: ${name ?? "<missing>"}.`,
      };
    }
    const title = optionalTrimmedString(raw.title, 512);
    const description = optionalTrimmedString(raw.description, 16_384);
    if (title === null || description === null) {
      return {
        ok: false,
        error: `Integration action text is invalid: ${name}.`,
      };
    }
    if (!isJsonObject(raw.inputSchema)) {
      return {
        ok: false,
        error: `Integration action is missing an object input schema: ${name}.`,
      };
    }
    let annotations: PublishedIntegrationAction["annotations"];
    if (raw.annotations !== undefined) {
      if (
        !isJsonObject(raw.annotations) ||
        raw.annotations.source !== "composio_tool_tags" ||
        typeof raw.annotations.readOnlyHint !== "boolean" ||
        typeof raw.annotations.destructiveHint !== "boolean" ||
        typeof raw.annotations.idempotentHint !== "boolean"
      ) {
        return {
          ok: false,
          error: `Integration action annotations are invalid: ${name}.`,
        };
      }
      annotations = {
        readOnlyHint: raw.annotations.readOnlyHint,
        destructiveHint: raw.annotations.destructiveHint,
        idempotentHint: raw.annotations.idempotentHint,
        source: "composio_tool_tags",
      };
    }
    let codeModePolicy: PublishedIntegrationAction["codeModePolicy"];
    if (raw.codeModePolicy !== undefined) {
      if (
        !isJsonObject(raw.codeModePolicy) ||
        raw.codeModePolicy.effect !== "read" ||
        raw.codeModePolicy.requiresApproval !== false ||
        raw.codeModePolicy.source !== "stella_admin" ||
        typeof raw.codeModePolicy.policyVersion !== "string" ||
        !SAFE_CODE_POLICY_VERSION.test(raw.codeModePolicy.policyVersion) ||
        typeof raw.codeModePolicy.toolkitVersion !== "string" ||
        !SAFE_COMPOSIO_TOOLKIT_VERSION.test(
          raw.codeModePolicy.toolkitVersion,
        ) ||
        !isJsonObject(raw.codeModePolicy.reviewedInputSchema) ||
        annotations?.readOnlyHint !== true ||
        annotations.destructiveHint !== false
      ) {
        return {
          ok: false,
          error: `Integration Code policy is invalid: ${name}.`,
        };
      }
      const reviewedInputSchemaJson = JSON.stringify(
        raw.codeModePolicy.reviewedInputSchema,
      );
      if (
        new TextEncoder().encode(reviewedInputSchemaJson).byteLength >
        MAX_INTEGRATION_ACTION_SCHEMA_BYTES
      ) {
        return {
          ok: false,
          error: `Reviewed Integration Code schema is too large: ${name}.`,
        };
      }
      codeModePolicy = {
        effect: "read",
        requiresApproval: false,
        policyVersion: raw.codeModePolicy.policyVersion,
        toolkitVersion: raw.codeModePolicy.toolkitVersion,
        reviewedInputSchemaJson,
        source: "stella_admin",
      };
    }
    const inputSchemaJson = JSON.stringify(
      effectiveGoogleAdsActionSchema(toolkit, name, raw.inputSchema),
    );
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
      ...(title ? { title } : {}),
      ...(description ? { description } : {}),
      ...(annotations ? { annotations } : {}),
      ...(codeModePolicy ? { codeModePolicy } : {}),
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
  const id = readString(record.id)?.toLowerCase();
  const toolkit = readString(connector.toolkit)?.toLowerCase();
  if (!id || !toolkit) return null;
  return {
    id,
    toolkit,
    provider: readString(connector.provider)?.toLowerCase() || "composio",
  };
};

export const requireComposioConfig = () => {
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

export const composioFetch = async (
  path: string,
  init: RequestInit,
  config: { apiKey: string; baseUrl: string },
  options?: { maxResponseBytes?: number; signal?: AbortSignal },
) => {
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort("Composio request timed out."),
    COMPOSIO_REQUEST_TIMEOUT_MS,
  );
  try {
    const signal = options?.signal
      ? AbortSignal.any([controller.signal, options.signal])
      : controller.signal;
    const response = await fetch(`${config.baseUrl}${path}`, {
      ...init,
      redirect: "error",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        "x-api-key": config.apiKey,
        "x-consumer-api-key": config.apiKey,
        ...(init.headers ?? {}),
      },
      signal,
    });
    const text = await readResponseTextBounded(
      response,
      Math.min(
        Math.max(options?.maxResponseBytes ?? MAX_COMPOSIO_RESPONSE_BYTES, 1),
        MAX_COMPOSIO_RESPONSE_BYTES,
      ),
    );
    const payload = parseJsonObject(text) ?? (text ? { text } : {});
    if (!response.ok) {
      // Never reflect or log an upstream response body: provider errors can
      // contain request arguments or credentials.
      throw new ComposioUpstreamHttpError(response.status);
    }
    return payload;
  } finally {
    clearTimeout(timeout);
  }
};

export const runComposioProviderCallBeforeDeadline = async <T>(args: {
  providerDeadlineAt: number;
  run: (signal: AbortSignal) => Promise<T>;
  now?: () => number;
}): Promise<{ started: false } | { started: true; value: T }> => {
  const remainingMs = args.providerDeadlineAt - (args.now ?? Date.now)();
  if (remainingMs <= 0) return { started: false };

  // `run` is invoked synchronously after this deadline check, before this
  // function yields. For fetch callers that means the provider request is
  // either started under the persisted receipt deadline or is not started at
  // all; a resumed action never receives a fresh timeout budget.
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort("Composio provider dispatch expired."),
    remainingMs,
  );
  try {
    return { started: true, value: await args.run(controller.signal) };
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

export const composioSessionUserIdFromPayload = (
  payload: Record<string, unknown>,
) => {
  const session = isJsonObject(payload.session) ? payload.session : null;
  const data = isJsonObject(payload.data) ? payload.data : null;
  const config = isJsonObject(payload.config)
    ? payload.config
    : isJsonObject(session?.config)
      ? session.config
      : isJsonObject(data?.config)
        ? data.config
        : null;
  return (
    readString(config?.user_id) ??
    readString(config?.userId) ??
    readString(payload.user_id) ??
    readString(payload.userId) ??
    readString(session?.user_id) ??
    readString(session?.userId) ??
    readString(data?.user_id) ??
    readString(data?.userId)
  );
};

/**
 * Direct action execution is used for Code-safe calls so Stella can bind the
 * reviewed action to an exact dated toolkit version. Derive the sibling v3.1
 * API origin without accepting a model-controlled URL or arbitrary redirect.
 */
export const composioToolsApiBaseUrl = (toolRouterBaseUrl: string): string => {
  const url = new URL(toolRouterBaseUrl);
  if (!url.pathname.endsWith("/tool_router")) {
    throw new Error("Composio Tool Router URL has an unsupported shape.");
  }
  url.pathname = url.pathname.slice(0, -"/tool_router".length);
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/$/u, "");
};

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
    ownerGeneration: string;
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

  const userId = await composioUserIdForOwner(args.ownerId);
  const attemptId = crypto.randomUUID();
  const leaseId = crypto.randomUUID();
  const receipt = await ctx.runMutation(reserveComposioSessionRef, {
    ownerId: args.ownerId,
    ownerGeneration: args.ownerGeneration,
    integrationId: args.integrationId,
    toolkit: args.toolkit,
    composioUserId: userId,
    attemptId,
    leaseId,
    now: Date.now(),
  });
  if (!receipt.acquired) {
    if (receipt.status === "bound") return receipt.sessionId;
    throw new Error(
      receipt.status === "outcome_unknown"
        ? "A prior Composio session create has an unknown outcome."
        : "Composio session provisioning is already in progress.",
    );
  }

  const marked = await ctx.runMutation(markComposioSessionRef, {
    ownerId: args.ownerId,
    ownerGeneration: args.ownerGeneration,
    attemptId,
    leaseId,
    now: Date.now(),
  });
  if (!marked.started) {
    await ctx.runMutation(settleComposioSessionNotCreatedRef, {
      ownerId: args.ownerId,
      ownerGeneration: args.ownerGeneration,
      attemptId,
      leaseId,
    });
    throw new Error("Composio session provisioning admission expired.");
  }

  let payload: Record<string, unknown>;
  try {
    const dispatched = await runComposioProviderCallBeforeDeadline({
      providerDeadlineAt: marked.providerDeadlineAt,
      run: async (signal) =>
        await composioFetch(
          "/session",
          {
            method: "POST",
            body: JSON.stringify(
              buildComposioSessionBody({ userId, toolkit: args.toolkit }),
            ),
          },
          args.config,
          { signal },
        ),
    });
    if (!dispatched.started) {
      // No provider call has started, so this is an authoritative no-create
      // settlement. If a watchdog/operator already terminalized the row, the
      // exact settlement safely returns false and cannot erase its audit.
      await ctx
        .runMutation(settleComposioSessionNotCreatedRef, {
          ownerId: args.ownerId,
          ownerGeneration: args.ownerGeneration,
          attemptId,
          leaseId,
        })
        .catch(() => false);
      throw new ComposioDispatchDeadlineExpiredError();
    }
    payload = dispatched.value;
  } catch (error) {
    if (error instanceof ComposioDispatchDeadlineExpiredError) {
      throw new Error("Composio session provisioning admission expired.");
    }
    // These client responses authoritatively reject session creation. Timeout,
    // conflict, throttling, server, abort, and transport errors remain unknown:
    // Composio currently has no session-list/idempotency API to reconcile them.
    const definitelyNotCreated =
      error instanceof ComposioUpstreamHttpError &&
      [400, 401, 403, 404, 405, 413, 415, 422].includes(error.status);
    if (definitelyNotCreated) {
      await ctx.runMutation(settleComposioSessionNotCreatedRef, {
        ownerId: args.ownerId,
        ownerGeneration: args.ownerGeneration,
        attemptId,
        leaseId,
      });
    } else {
      await ctx.runMutation(markComposioSessionUnknownRef, {
        ownerId: args.ownerId,
        ownerGeneration: args.ownerGeneration,
        attemptId,
        leaseId,
        now: Date.now(),
        reason: "Composio create response was not authoritative.",
      });
    }
    throw error;
  }
  const sessionId = composioSessionIdFromPayload(payload);
  if (!sessionId) {
    await ctx.runMutation(markComposioSessionUnknownRef, {
      ownerId: args.ownerId,
      ownerGeneration: args.ownerGeneration,
      attemptId,
      leaseId,
      now: Date.now(),
      reason: "Composio create response omitted its session locator.",
    });
    throw new Error("Composio did not return a session id.");
  }
  await ctx.runMutation(recordComposioSessionLocatorRef, {
    ownerId: args.ownerId,
    ownerGeneration: args.ownerGeneration,
    attemptId,
    leaseId,
    sessionId,
    now: Date.now(),
  });
  try {
    await ctx.runMutation(bindComposioSessionRef, {
      ownerId: args.ownerId,
      ownerGeneration: args.ownerGeneration,
      integrationId: args.integrationId,
      toolkit: args.toolkit,
      composioUserId: userId,
      attemptId,
      leaseId,
      sessionId,
      now: Date.now(),
    });
  } catch (error) {
    // The exact locator remains durable until the scheduled cleanup worker has
    // received DELETE and confirmed GET 404. Never drop it on a failed delete.
    await ctx
      .runMutation(requestComposioSessionCleanupRef, {
        ownerId: args.ownerId,
        ownerGeneration: args.ownerGeneration,
        attemptId,
        leaseId,
        sessionId,
        now: Date.now(),
        reason: "The owner lifecycle closed before session binding.",
      })
      .catch(() => undefined);
    throw error;
  }
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
    path: "/api/admin/native-integrations/composio-principal/resolve",
    method: "POST",
    handler: httpAction(async (ctx, request) => {
      const admin = requireAdminRequest(request);
      if (!admin.ok) return admin.response;
      let body: unknown;
      try {
        const text = await readRequestTextBounded(
          request,
          MAX_ADMIN_COMPOSIO_RESOLUTION_BODY_BYTES,
        );
        body = JSON.parse(text) as unknown;
      } catch (error) {
        if (error instanceof RequestBodyLimitError) {
          return jsonResponse({ error: error.message }, error.status);
        }
        return jsonResponse({ error: "Invalid resolution payload." }, 400);
      }
      if (!isJsonObject(body)) {
        return jsonResponse({ error: "Invalid resolution payload." }, 400);
      }
      const ownerId = readString(body.ownerId);
      const provider = readString(body.provider);
      const sessionId = readString(body.sessionId);
      const composioUserId = readString(body.composioUserId);
      const resolutionId = readString(body.resolutionId);
      const resolvedBy = readString(body.resolvedBy);
      const evidence = readString(body.evidence);
      if (
        !ownerId ||
        !provider ||
        !sessionId ||
        !composioUserId ||
        !resolutionId ||
        !resolvedBy ||
        !evidence
      ) {
        return jsonResponse({ error: "Invalid resolution payload." }, 400);
      }
      try {
        const result = await ctx.runMutation(resolveComposioPrincipalRef, {
          ownerId,
          provider,
          sessionId,
          composioUserId,
          resolutionId,
          resolvedBy,
          evidence,
          now: Date.now(),
        });
        return jsonResponse({ ok: true, ...result }, 200);
      } catch (error) {
        console.error(
          "[native-integrations] Composio principal resolution rejected",
          {
            ownerId,
            provider,
            message: error instanceof Error ? error.message : String(error),
          },
        );
        return jsonResponse(
          { error: "Composio resolution was rejected." },
          409,
        );
      }
    }),
  });

  http.route({
    path: "/api/admin/native-integrations/composio-provisioning/resolve",
    method: "POST",
    handler: httpAction(async (ctx, request) => {
      const admin = requireAdminRequest(request);
      if (!admin.ok) return admin.response;
      let body: unknown;
      try {
        const text = await readRequestTextBounded(
          request,
          MAX_ADMIN_COMPOSIO_RESOLUTION_BODY_BYTES,
        );
        body = JSON.parse(text) as unknown;
      } catch (error) {
        if (error instanceof RequestBodyLimitError) {
          return jsonResponse({ error: error.message }, error.status);
        }
        return jsonResponse({ error: "Invalid resolution payload." }, 400);
      }
      if (!isJsonObject(body)) {
        return jsonResponse({ error: "Invalid resolution payload." }, 400);
      }
      const ownerId = readString(body.ownerId);
      const ownerGeneration = readString(body.ownerGeneration);
      const integrationId = readString(body.integrationId);
      const toolkit = readString(body.toolkit);
      const composioUserId = readString(body.composioUserId);
      const attemptId = readString(body.attemptId);
      const leaseId = readString(body.leaseId);
      const resolvedBy = readString(body.resolvedBy);
      const evidence = readString(body.evidence);
      const resolutionKind = readString(body.resolution);
      const sessionId = readString(body.sessionId);
      if (
        !ownerId ||
        !ownerGeneration ||
        !integrationId ||
        !toolkit ||
        !composioUserId ||
        !attemptId ||
        !leaseId ||
        !resolvedBy ||
        !evidence ||
        (resolutionKind !== "recovered_session" &&
          resolutionKind !== "provider_confirmed_not_created") ||
        (resolutionKind === "recovered_session" && !sessionId) ||
        (resolutionKind === "provider_confirmed_not_created" && sessionId)
      ) {
        return jsonResponse({ error: "Invalid resolution payload." }, 400);
      }
      try {
        const result = await ctx.runMutation(resolveComposioSessionOutcomeRef, {
          ownerId,
          ownerGeneration,
          integrationId,
          toolkit,
          composioUserId,
          attemptId,
          leaseId,
          resolution:
            resolutionKind === "recovered_session"
              ? { kind: resolutionKind, sessionId: sessionId! }
              : { kind: resolutionKind },
          resolvedBy,
          evidence,
          now: Date.now(),
        });
        return jsonResponse({ ok: true, ...result }, 200);
      } catch (error) {
        console.error("[native-integrations] Composio resolution rejected", {
          attemptId,
          message: error instanceof Error ? error.message : String(error),
        });
        return jsonResponse(
          { error: "Composio resolution was rejected." },
          409,
        );
      }
    }),
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
      const publishedToolkit = isJsonObject(body.connector)
        ? readString(body.connector.toolkit)
        : null;
      const normalizedActions = normalizePublishedIntegrationActions(
        body.actions,
        (publishedToolkit ?? readString(body.id) ?? "").toLowerCase(),
      );
      if (!normalizedActions.ok) {
        return jsonResponse({ error: normalizedActions.error }, 400);
      }
      try {
        const schemaValidation = await ctx.runAction(
          internal.node.native_integration_schemas
            .validatePublishedActionSchemas,
          {
            actions: normalizedActions.actions.flatMap((action) => [
              {
                name: action.name,
                inputSchemaJson: action.inputSchemaJson,
              },
              ...(action.codeModePolicy
                ? [
                    {
                      name: `${action.name}#stella-reviewed`,
                      inputSchemaJson:
                        action.codeModePolicy.reviewedInputSchemaJson,
                    },
                  ]
                : []),
            ]),
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
        const admission = await requireActiveIntegrationIdentity(ctx);
        if (admission === "sign_in_required") {
          return errorResponse(403, "sign_in_required", origin);
        }
        if (!admission) return errorResponse(401, "Unauthorized", origin);
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
            const storedInputSchema = JSON.parse(
              resolved.action.inputSchemaJson,
            ) as unknown;
            const inputSchema = isJsonObject(storedInputSchema)
              ? effectiveGoogleAdsActionSchema(
                  id,
                  resolved.action.name,
                  storedInputSchema,
                )
              : storedInputSchema;
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
              annotations?: {
                readOnlyHint: boolean;
                destructiveHint: boolean;
                idempotentHint: boolean;
                source: "composio_tool_tags";
              };
              codeModePolicy?: {
                effect: "read";
                requiresApproval: false;
                policyVersion: string;
                source: "stella_admin";
              };
              inputSchemaJson: string;
              updatedAt: number;
            }) => {
              const storedInputSchema = JSON.parse(
                action.inputSchemaJson,
              ) as unknown;
              const inputSchema = isJsonObject(storedInputSchema)
                ? effectiveGoogleAdsActionSchema(
                    id,
                    action.name,
                    storedInputSchema,
                  )
                : storedInputSchema;
              if (!isJsonObject(inputSchema)) throw new Error("invalid schema");
              return {
                name: action.name,
                ...(action.title ? { title: action.title } : {}),
                ...(action.description
                  ? { description: action.description }
                  : {}),
                ...(action.annotations
                  ? { annotations: action.annotations }
                  : {}),
                ...(action.codeModePolicy
                  ? { codeModePolicy: action.codeModePolicy }
                  : {}),
                revision: String(action.updatedAt),
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
        const admission = await requireActiveIntegrationIdentity(ctx);
        if (admission === "sign_in_required") {
          return errorResponse(403, "sign_in_required", origin);
        }
        if (!admission) return errorResponse(401, "Unauthorized", origin);
        const { identity, ownerGeneration } = admission;
        const body = (await parseUnknownBody(
          request,
        )) as NativeIntegrationRequestBody | null;
        const id = readString(body?.id)?.toLowerCase();
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
        const composio = requireComposioConfig();
        if (!composio.config) return withCors(composio.response, origin);
        try {
          const sessionId = await ensureComposioSession(ctx, {
            ownerId: identity.tokenIdentifier,
            ownerGeneration,
            integrationId: connector.id,
            toolkit: connector.toolkit,
            config: composio.config,
          });
          await ctx.runMutation(
            internal.data.integrations
              .assertUserIntegrationDispatchAllowedInternal,
            { ownerId: identity.tokenIdentifier, ownerGeneration },
          );
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
    path: "/api/native-integrations/status",
    method: "GET",
    handler: httpAction(async (ctx, request) =>
      handleCorsRequest(request, async (origin) => {
        const admission = await requireActiveIntegrationIdentity(ctx);
        if (admission === "sign_in_required") {
          return errorResponse(403, "sign_in_required", origin);
        }
        if (!admission) return errorResponse(401, "Unauthorized", origin);
        const { identity, ownerGeneration } = admission;
        const id = readString(
          new URL(request.url).searchParams.get("id"),
        )?.toLowerCase();
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
          await ctx.runMutation(
            internal.data.integrations
              .assertUserIntegrationDispatchAllowedInternal,
            { ownerId: identity.tokenIdentifier, ownerGeneration },
          );
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
        const admission = await requireActiveIntegrationIdentity(ctx);
        if (admission === "sign_in_required") {
          return errorResponse(403, "sign_in_required", origin);
        }
        if (!admission) return errorResponse(401, "Unauthorized", origin);
        const { identity, ownerGeneration } = admission;
        try {
          await enforceActionRateLimit(
            ctx,
            "native_integrations_run",
            identity.tokenIdentifier,
            RATE_STANDARD,
            "Too many integration requests. Wait a moment and try again.",
          );
        } catch {
          return errorResponse(429, "rate_limited", origin);
        }
        const body = (await parseUnknownBody(
          request,
        )) as NativeIntegrationRequestBody | null;
        const id = readString(body?.id)?.toLowerCase();
        const action = readString(body?.action);
        const requestId = readString(
          request.headers.get("x-stella-request-id") ??
            request.headers.get("idempotency-key"),
        );
        if (!id || !action) {
          return errorResponse(400, "Missing integration action.", origin);
        }
        if (!requestId || !SAFE_NATIVE_RUN_REQUEST_ID.test(requestId)) {
          return errorResponse(
            400,
            "A stable integration request id is required.",
            origin,
          );
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
          return errorResponse(
            400,
            "Integration action is not allowed.",
            origin,
          );
        }
        let inputValidation: "valid" | "invalid" | "invalid_schema";
        try {
          const storedInputSchema = JSON.parse(
            resolved.action.inputSchemaJson,
          ) as unknown;
          if (!isJsonObject(storedInputSchema))
            throw new Error("invalid schema");
          inputValidation = await ctx.runAction(
            internal.node.native_integration_schemas.validateActionInput,
            {
              inputJson: JSON.stringify(body.input),
              schemaJson: JSON.stringify(
                effectiveGoogleAdsActionSchema(
                  connector.toolkit,
                  action,
                  storedInputSchema,
                ),
              ),
            },
          );
        } catch (error) {
          console.error("[native-integrations] input validation unavailable", {
            id,
            action,
            message: error instanceof Error ? error.message : String(error),
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
        let googleAdsProxyRequest: Record<string, unknown> | null;
        try {
          googleAdsProxyRequest = buildGoogleAdsMutationProxyRequest(
            connector.toolkit,
            action,
            body.input,
          );
        } catch {
          return errorResponse(
            400,
            "Invalid Google Ads mutation input.",
            origin,
          );
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
        const leaseId = crypto.randomUUID();
        const revision = String(resolved.action.updatedAt);
        const fingerprint = await sha256Hex(
          JSON.stringify({
            route: "native_integrations_run",
            integrationId: id,
            toolkit: connector.toolkit,
            action,
            revision,
            sessionId,
            input: body.input,
          }),
        );
        let dispatch: {
          sessionId: string;
          providerDeadlineAt: number;
          leaseExpiresAt: number;
        };
        try {
          // This transaction is the request binding and the owner-generation
          // physical lease. It must win before even the provider status read:
          // purge/migration can otherwise delete the session while the read is
          // live, and an HTTP retry could execute a destructive action twice.
          dispatch = await ctx.runMutation(beginComposioNativeRunRef, {
            ownerId: identity.tokenIdentifier,
            ownerGeneration,
            integrationId: id,
            toolkit: connector.toolkit,
            action,
            revision,
            expectedSessionId: sessionId,
            requestId,
            fingerprint,
            leaseId,
            now: Date.now(),
          });
        } catch (error) {
          console.error(
            "[native-integrations] composio run admission rejected",
            {
              id,
              requestId,
              message: error instanceof Error ? error.message : String(error),
            },
          );
          return errorResponse(
            409,
            "This integration request was already used or is no longer admissible.",
            origin,
          );
        }

        const settle = async (outcome: "succeeded" | "failed" | "unknown") =>
          await ctx.runMutation(settleComposioNativeRunRef, {
            ownerId: identity.tokenIdentifier,
            ownerGeneration,
            requestId,
            fingerprint,
            leaseId,
            outcome,
            now: Date.now(),
          });
        try {
          const statusRemainingMs = dispatch.providerDeadlineAt - Date.now();
          if (statusRemainingMs <= 0) {
            await settle("failed").catch(() => undefined);
            return errorResponse(
              409,
              "This integration request expired before provider dispatch.",
              origin,
            );
          }
          const statusController = new AbortController();
          const statusTimeout = setTimeout(
            () => statusController.abort("Composio native-run status expired."),
            statusRemainingMs,
          );
          let statusPayload: Record<string, unknown>;
          try {
            statusPayload = await composioFetch(
              `/session/${encodeURIComponent(dispatch.sessionId)}/toolkits`,
              { method: "GET" },
              composio.config,
              { signal: statusController.signal },
            );
          } finally {
            clearTimeout(statusTimeout);
          }
          if (
            !composioToolkitConnectedFromPayload(
              statusPayload,
              connector.toolkit,
            )
          ) {
            await settle("failed");
            return errorResponse(
              409,
              "This integration is no longer connected.",
              origin,
            );
          }
          let executeAuthority: {
            providerDeadlineAt: number;
            leaseExpiresAt: number;
          };
          try {
            // Status can suspend for most of the durable lease. Recheck the
            // lifecycle, exact session/catalog revision, and receipt in one
            // final transaction immediately before destructive provider I/O.
            executeAuthority = await ctx.runMutation(
              claimComposioNativeRunExecuteRef,
              {
                ownerId: identity.tokenIdentifier,
                ownerGeneration,
                integrationId: id,
                toolkit: connector.toolkit,
                action,
                revision,
                expectedSessionId: dispatch.sessionId,
                requestId,
                fingerprint,
                leaseId,
                now: Date.now(),
              },
            );
          } catch {
            await settle("failed").catch(() => undefined);
            return errorResponse(
              409,
              "This integration request lost provider authority.",
              origin,
            );
          }
          const executeRemainingMs =
            executeAuthority.providerDeadlineAt - Date.now();
          if (executeRemainingMs <= 0) {
            await settle("failed").catch(() => undefined);
            return errorResponse(
              409,
              "This integration request expired before provider dispatch.",
              origin,
            );
          }
          let payload: Record<string, unknown>;
          const executeController = new AbortController();
          const executeTimeout = setTimeout(
            () =>
              executeController.abort("Composio native-run execute expired."),
            executeRemainingMs,
          );
          try {
            payload = await composioFetch(
              `/session/${encodeURIComponent(dispatch.sessionId)}/${googleAdsProxyRequest ? "proxy_execute" : "execute"}`,
              {
                method: "POST",
                body: JSON.stringify(
                  googleAdsProxyRequest ?? {
                    tool_slug: action,
                    arguments: body.input,
                  },
                ),
              },
              composio.config,
              { signal: executeController.signal },
            );
          } catch (error) {
            // Only explicit provider rejections that prove the action was not
            // accepted can release the physical lease immediately. A timeout,
            // throttle, conflict, oversized success body, or transport loss
            // may follow execution and therefore remains unknown until expiry.
            const outcome =
              error instanceof ComposioUpstreamHttpError &&
              [400, 401, 403, 404, 405, 413, 415, 422].includes(error.status)
                ? ("failed" as const)
                : ("unknown" as const);
            await settle(outcome).catch(() => undefined);
            throw error;
          } finally {
            clearTimeout(executeTimeout);
          }
          await settle("succeeded");
          return jsonResponse(
            googleAdsProxyRequest
              ? normalizeGoogleAdsProxyResponse(payload)
              : payload,
            200,
            origin,
          );
        } catch (error) {
          // A status-read transport failure also keeps its physical session
          // lease through the hard deadline. Exact terminal settlement is
          // idempotent, so this is safe if an inner branch already settled.
          const outcome =
            error instanceof ComposioUpstreamHttpError &&
            error.status >= 400 &&
            error.status < 500
              ? ("failed" as const)
              : ("unknown" as const);
          await settle(outcome).catch(() => undefined);
          console.error("[native-integrations] composio run failed", {
            id,
            requestId,
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
