import type { HttpRouter } from "convex/server";
import { ConvexError } from "convex/values";
import { isManagedModelAudience } from "@stella/contracts/gateway/capability";
import type { NetworkClass } from "@stella/contracts/gateway/api";
import { CONVEX_OWNER_SNAPSHOT_PATH } from "@stella/contracts/turn-plane/owner-snapshot";
import {
  CONVEX_GATEWAY_CONFIG_PATH,
  CONVEX_GATEWAY_ENGINE_ACCESS_PATH,
  CONVEX_GATEWAY_OWNER_ENFORCEMENT_PATH,
  CONVEX_GATEWAY_SESSION_CAPABILITY_PATH,
  CONVEX_GATEWAY_USAGE_PATH,
  GATEWAY_USAGE_EVENT_VERSION,
  type ConvexEngineAccessResponse,
  type ConvexSessionCapabilityRequest,
  type GatewayConfigSnapshot,
  type GatewayUsageBatchResult,
  type ConvexOwnerEnforcementState,
} from "@stella/contracts/gateway/usage";
import { httpAction } from "../_generated/server";
import { internal } from "../_generated/api";
import type { FunctionArgs } from "convex/server";
import { resolveOwnerAccountAction } from "../auth";
import {
  resolveEngineAccess,
  type CloudEngineProvider,
} from "../cloud_engines";
import {
  getMaxAnonRequests,
  getMaxAnonRequestsPerIp,
} from "../lib/anonymous_usage";
import { constantTimeEqual } from "../lib/crypto_utils";
import { dollarsToMicroCents } from "../lib/billing_money";
import { assertOwnerDataAccessActive } from "../owner_lifecycle";
import { postAlert } from "../lib/alerts";

/**
 * Service routes for the model gateway worker. Every route requires
 * `Authorization: Bearer ${GATEWAY_SERVICE_SECRET}`; nothing here is reachable
 * by end users. Bodies follow `@stella/contracts/gateway/usage`.
 *
 * The one exception is `GET /api/gateway/owner-snapshot`, read by the
 * cloud-builder's owner gate with that worker's own `BUILDER_SERVICE_SECRET`
 * (`@stella/contracts/turn-plane/owner-snapshot`).
 */

export const GATEWAY_SERVICE_SECRET_ENV = "GATEWAY_SERVICE_SECRET";
export const BUILDER_SERVICE_SECRET_ENV = "BUILDER_SERVICE_SECRET";
/** Events per batch the route accepts; the queue consumer batches well below this. */
export const GATEWAY_USAGE_MAX_BATCH_EVENTS = 500;
/** Events per ledger transaction, so one batch never approaches mutation limits. */
const GATEWAY_USAGE_INGEST_CHUNK = 50;
const MAX_ID_LENGTH = 512;
const MAX_IP_HASH_LENGTH = 64;
const DEVICE_KEY_HASH_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const MAX_TURNSTILE_TOKEN_LENGTH = 4_096;
const MAX_ALERT_TEXT_LENGTH = 8_000;
const GATEWAY_ALERTS_PATH = "/api/gateway/alerts";

type UsageEventInput = FunctionArgs<
  typeof internal.billing.ingestGatewayUsageBatchInternal
>["events"][number];

const json = (body: unknown, status = 200) =>
  Response.json(body, { status, headers: { "cache-control": "no-store" } });

/** Bearer check with a constant-time compare; 503 when the secret is unset. */
export const requireGatewayServiceRequest = (
  request: Request,
): Response | null => {
  const expected = process.env[GATEWAY_SERVICE_SECRET_ENV]?.trim() ?? "";
  if (!expected) {
    return json(
      {
        error: "Gateway service routes are disabled.",
        env: GATEWAY_SERVICE_SECRET_ENV,
      },
      503,
    );
  }
  const provided =
    request.headers
      .get("authorization")
      ?.replace(/^Bearer\s+/i, "")
      .trim() ?? "";
  if (!provided || !constantTimeEqual(provided, expected)) {
    return json({ error: "unauthorized" }, 401);
  }
  return null;
};

/** Same shape as the gateway check, against the cloud-builder's secret. */
const requireBuilderServiceRequest = (request: Request): Response | null => {
  const expected = process.env[BUILDER_SERVICE_SECRET_ENV]?.trim() ?? "";
  if (!expected) {
    return json(
      {
        error: "Cloud builder routes are disabled.",
        env: BUILDER_SERVICE_SECRET_ENV,
      },
      503,
    );
  }
  const provided =
    request.headers
      .get("authorization")
      ?.replace(/^Bearer\s+/i, "")
      .trim() ?? "";
  if (!provided || !constantTimeEqual(provided, expected)) {
    return json({ error: "unauthorized" }, 401);
  }
  return null;
};

const readJsonObject = async (
  request: Request,
): Promise<Record<string, unknown> | null> => {
  try {
    const body = (await request.json()) as unknown;
    return body && typeof body === "object" && !Array.isArray(body)
      ? (body as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
};

const isId = (value: unknown): value is string =>
  typeof value === "string" &&
  value.trim().length > 0 &&
  value.length <= MAX_ID_LENGTH;

const isFiniteNumber = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);

const optionalNumber = (value: unknown): number | undefined =>
  isFiniteNumber(value) ? value : undefined;

const isNetworkClass = (value: unknown): value is NetworkClass =>
  value === "hosting" ||
  value === "vpn" ||
  value === "residential" ||
  value === "mobile" ||
  value === "edu" ||
  value === "unknown";

const convexErrorCode = (error: unknown): string | null => {
  if (!(error instanceof ConvexError)) return null;
  const data = error.data as { code?: unknown } | string | undefined;
  return typeof data === "object" && data && typeof data.code === "string"
    ? data.code
    : null;
};

// ---------------------------------------------------------------------------
// POST /api/gateway/session-capability
// ---------------------------------------------------------------------------

const sessionCapability = httpAction(async (ctx, request) => {
  const denied = requireGatewayServiceRequest(request);
  if (denied) return denied;
  const body = await readJsonObject(request);
  if (
    !body ||
    !isId(body.ownerId) ||
    typeof body.isAnonymous !== "boolean" ||
    typeof body.deviceKeyHash !== "string" ||
    !DEVICE_KEY_HASH_PATTERN.test(body.deviceKeyHash) ||
    (body.ipHash !== undefined &&
      (typeof body.ipHash !== "string" ||
        body.ipHash.length > MAX_IP_HASH_LENGTH)) ||
    (body.networkClass !== undefined && !isNetworkClass(body.networkClass)) ||
    (body.turnstileToken !== undefined &&
      (typeof body.turnstileToken !== "string" ||
        body.turnstileToken.length > MAX_TURNSTILE_TOKEN_LENGTH))
  ) {
    return json({ error: "bad_request" }, 400);
  }
  const ownerId = body.ownerId;
  const deviceKeyHash = body.deviceKeyHash;
  const account = await resolveOwnerAccountAction(ctx, ownerId);
  if (!account) return json({ error: "owner_unknown" }, 404);
  // The account record is authoritative. The gateway's flag is checked by
  // contract above but cannot change the owner's tier.
  const isAnonymous = account.isAnonymous;
  const ipHash =
    typeof body.ipHash === "string" && body.ipHash.trim()
      ? body.ipHash.trim()
      : undefined;
  const networkClass = isNetworkClass(body.networkClass)
    ? body.networkClass
    : undefined;
  const turnstileToken =
    typeof body.turnstileToken === "string" && body.turnstileToken.trim()
      ? body.turnstileToken.trim()
      : undefined;
  const capabilityRequest: ConvexSessionCapabilityRequest = {
    ownerId,
    isAnonymous,
    deviceKeyHash,
    ...(ipHash ? { ipHash } : {}),
    ...(networkClass ? { networkClass } : {}),
    ...(turnstileToken ? { turnstileToken } : {}),
  };
  try {
    const result = await ctx.runAction(
      internal.gateway_capabilities.signSessionCapabilityInternal,
      capabilityRequest,
    );
    return json(result);
  } catch (error) {
    switch (convexErrorCode(error)) {
      case "OWNER_DATA_PURGE_ACTIVE":
      case "OWNERSHIP_MIGRATED":
        return json({ error: "owner_unavailable" }, 404);
      case "SERVICE_UNAVAILABLE":
        return json({ error: "capability_signing_unavailable" }, 503);
      case "OWNER_SUSPENDED":
        return json({ error: "owner_suspended" }, 403);
      case "CHALLENGE_REQUIRED":
        return json({ error: "challenge_required" }, 403);
      case "SIGN_IN_REQUIRED":
        return json({ error: "sign_in_required" }, 403);
      default:
        throw error;
    }
  }
});

const alerts = httpAction(async (_ctx, request) => {
  const denied = requireGatewayServiceRequest(request);
  if (denied) return denied;
  const body = await readJsonObject(request);
  const alertText = typeof body?.text === "string" ? body.text.trim() : "";
  if (!alertText || alertText.length > MAX_ALERT_TEXT_LENGTH) {
    return json({ error: "bad_request" }, 400);
  }
  await postAlert(alertText);
  return json({ ok: true });
});

// ---------------------------------------------------------------------------
// POST /api/gateway/usage
// ---------------------------------------------------------------------------

type ParsedUsageEvent =
  | { ok: true; event: UsageEventInput }
  | { ok: false; requestId: string; reason: string };

/** Project a wire event onto the ledger's validator; unknown fields are dropped. */
const parseUsageEvent = (raw: unknown): ParsedUsageEvent => {
  const record =
    raw && typeof raw === "object" && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : null;
  const requestId = record && isId(record.requestId) ? record.requestId : "";
  const reject = (reason: string): ParsedUsageEvent => ({
    ok: false,
    requestId,
    reason,
  });
  if (!record || !requestId) return reject("malformed_request_id");
  if (record.v !== GATEWAY_USAGE_EVENT_VERSION)
    return reject("unsupported_version");
  if (!isId(record.capabilityId)) return reject("malformed_capability_id");
  if (!isId(record.ownerId) || !isId(record.ownerGeneration)) {
    return reject("malformed_owner");
  }
  if (!isManagedModelAudience(record.audience))
    return reject("malformed_audience");
  if (!isId(record.agentType) || !isId(record.resolvedModel)) {
    return reject("malformed_model");
  }
  if (
    record.outcome !== "succeeded" &&
    record.outcome !== "failed" &&
    record.outcome !== "aborted"
  ) {
    return reject("malformed_outcome");
  }
  const usage =
    record.usage && typeof record.usage === "object"
      ? (record.usage as Record<string, unknown>)
      : null;
  if (
    !usage ||
    !isFiniteNumber(usage.inputTokens) ||
    !isFiniteNumber(usage.outputTokens) ||
    typeof usage.reported !== "boolean"
  ) {
    return reject("malformed_usage");
  }
  if (
    !isFiniteNumber(record.chargedMicroCents) ||
    !isFiniteNumber(record.startedAt) ||
    !isFiniteNumber(record.finishedAt) ||
    typeof record.billable !== "boolean"
  ) {
    return reject("malformed_billing");
  }
  const anonymous =
    record.anonymous && typeof record.anonymous === "object"
      ? (record.anonymous as Record<string, unknown>)
      : null;
  if (
    record.networkClass !== undefined &&
    !isNetworkClass(record.networkClass)
  ) {
    return reject("malformed_network_class");
  }
  if (
    record.deviceKeyHash !== undefined &&
    (typeof record.deviceKeyHash !== "string" ||
      !DEVICE_KEY_HASH_PATTERN.test(record.deviceKeyHash))
  ) {
    return reject("malformed_device_key_hash");
  }
  return {
    ok: true,
    event: {
      requestId,
      capabilityId: record.capabilityId,
      ownerId: record.ownerId,
      ownerGeneration: record.ownerGeneration,
      audience: record.audience,
      agentType: record.agentType,
      ...(isId(record.conversationId)
        ? { conversationId: record.conversationId }
        : {}),
      resolvedModel: record.resolvedModel,
      usage: {
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        ...(optionalNumber(usage.cachedInputTokens) !== undefined
          ? { cachedInputTokens: usage.cachedInputTokens as number }
          : {}),
        ...(optionalNumber(usage.cacheWriteTokens) !== undefined
          ? { cacheWriteTokens: usage.cacheWriteTokens as number }
          : {}),
        ...(optionalNumber(usage.reasoningTokens) !== undefined
          ? { reasoningTokens: usage.reasoningTokens as number }
          : {}),
        ...(optionalNumber(usage.costMicroCents) !== undefined
          ? { costMicroCents: usage.costMicroCents as number }
          : {}),
        reported: usage.reported,
      },
      chargedMicroCents: record.chargedMicroCents,
      outcome: record.outcome,
      startedAt: record.startedAt,
      finishedAt: record.finishedAt,
      billable: record.billable,
      ...(isNetworkClass(record.networkClass)
        ? { networkClass: record.networkClass }
        : {}),
      ...(typeof record.deviceKeyHash === "string"
        ? { deviceKeyHash: record.deviceKeyHash }
        : {}),
      ...(anonymous
        ? {
            anonymous: {
              ...(typeof anonymous.ipHash === "string" &&
              anonymous.ipHash.trim().length > 0 &&
              anonymous.ipHash.length <= MAX_IP_HASH_LENGTH
                ? { ipHash: anonymous.ipHash.trim() }
                : {}),
            },
          }
        : {}),
    },
  };
};

const usage = httpAction(async (ctx, request) => {
  const denied = requireGatewayServiceRequest(request);
  if (denied) return denied;
  const body = await readJsonObject(request);
  if (
    !body ||
    body.v !== GATEWAY_USAGE_EVENT_VERSION ||
    !Array.isArray(body.events)
  ) {
    return json({ error: "bad_request" }, 400);
  }
  if (body.events.length > GATEWAY_USAGE_MAX_BATCH_EVENTS) {
    return json(
      { error: "batch_too_large", max: GATEWAY_USAGE_MAX_BATCH_EVENTS },
      413,
    );
  }

  const result: GatewayUsageBatchResult = {
    accepted: [],
    duplicate: [],
    rejected: [],
  };
  const events: UsageEventInput[] = [];
  for (const raw of body.events) {
    const parsed = parseUsageEvent(raw);
    if (parsed.ok) events.push(parsed.event);
    else
      result.rejected.push({
        requestId: parsed.requestId,
        reason: parsed.reason,
      });
  }
  for (
    let index = 0;
    index < events.length;
    index += GATEWAY_USAGE_INGEST_CHUNK
  ) {
    const chunk = await ctx.runMutation(
      internal.billing.ingestGatewayUsageBatchInternal,
      {
        events: events.slice(index, index + GATEWAY_USAGE_INGEST_CHUNK),
        now: Date.now(),
      },
    );
    result.accepted.push(...chunk.accepted);
    result.duplicate.push(...chunk.duplicate);
    result.rejected.push(...chunk.rejected);
  }
  return json(result);
});

// ---------------------------------------------------------------------------
// GET /api/gateway/config
// ---------------------------------------------------------------------------

const tierCeilingMicroCents = (envName: string, defaultUsd: number): number => {
  const raw = process.env[envName]?.trim();
  const value = raw ? Number(raw) : defaultUsd;
  if (!Number.isFinite(value) || (value < 0 && value !== -1)) {
    throw new Error(`${envName} must be -1 or a non-negative USD amount.`);
  }
  return value === -1 ? -1 : dollarsToMicroCents(value);
};

const config = httpAction(async (ctx, request) => {
  const denied = requireGatewayServiceRequest(request);
  if (denied) return denied;
  const { prices, updatedAt } = await ctx.runQuery(
    internal.billing.listGatewayModelPricesInternal,
    {},
  );
  const snapshot: GatewayConfigSnapshot = {
    v: 1,
    prices,
    anonymous: {
      maxRequestsPerOwner: getMaxAnonRequests(),
      maxRequestsPerIp: getMaxAnonRequestsPerIp(),
    },
    tierCeilings: [
      {
        audience: "anonymous",
        hourlyMicroCents: tierCeilingMicroCents(
          "STELLA_TIER_CEILING_ANON_HOURLY_USD",
          20,
        ),
        dailyMicroCents: tierCeilingMicroCents(
          "STELLA_TIER_CEILING_ANON_DAILY_USD",
          200,
        ),
      },
      {
        audience: "free",
        hourlyMicroCents: tierCeilingMicroCents(
          "STELLA_TIER_CEILING_FREE_HOURLY_USD",
          100,
        ),
        dailyMicroCents: tierCeilingMicroCents(
          "STELLA_TIER_CEILING_FREE_DAILY_USD",
          1_000,
        ),
      },
    ],
    updatedAt: updatedAt || Date.now(),
  };
  return json(snapshot);
});

// ---------------------------------------------------------------------------
// GET /api/gateway/owner-enforcement?ownerId=
// ---------------------------------------------------------------------------

const ownerEnforcement = httpAction(async (ctx, request) => {
  const denied = requireGatewayServiceRequest(request);
  if (denied) return denied;
  const ownerId = new URL(request.url).searchParams.get("ownerId")?.trim() ?? "";
  if (!isId(ownerId)) return json({ error: "bad_request" }, 400);
  const result: ConvexOwnerEnforcementState = await ctx.runQuery(
    internal.owner_enforcement.getOwnerEnforcementStateInternal,
    { ownerId },
  );
  return json(result);
});

// ---------------------------------------------------------------------------
// POST /api/gateway/engine-access
// ---------------------------------------------------------------------------

const isEngineProvider = (value: unknown): value is CloudEngineProvider =>
  value === "anthropic" || value === "openai-codex";

const engineAccess = httpAction(async (ctx, request) => {
  const denied = requireGatewayServiceRequest(request);
  if (denied) return denied;
  const body = await readJsonObject(request);
  if (
    !body ||
    !isId(body.ownerId) ||
    !isId(body.ownerGeneration) ||
    !isEngineProvider(body.provider)
  ) {
    return json({ error: "bad_request" }, 400);
  }
  let generation: string;
  try {
    ({ generation } = await assertOwnerDataAccessActive(ctx, body.ownerId));
  } catch (error) {
    if (convexErrorCode(error) === "OWNER_DATA_PURGE_ACTIVE") {
      return json({ error: "owner_unavailable" }, 404);
    }
    throw error;
  }
  if (generation !== body.ownerGeneration) {
    return json({ error: "generation_stale" }, 409);
  }
  const access = await resolveEngineAccess(ctx, body.ownerId, body.provider);
  if (!access) return json({ error: "credential_missing" }, 404);
  const response: ConvexEngineAccessResponse = {
    accessToken: access.accessToken,
    ...(access.accountId ? { accountId: access.accountId } : {}),
    expiresAt: access.expiresAt,
  };
  return json(response);
});

// ---------------------------------------------------------------------------
// GET /api/gateway/owner-snapshot?ownerId=
// ---------------------------------------------------------------------------

const ownerSnapshot = httpAction(async (ctx, request) => {
  const denied = requireBuilderServiceRequest(request);
  if (denied) return denied;
  const url = new URL(request.url);
  const ownerId = url.searchParams.get("ownerId")?.trim() ?? "";
  if (!isId(ownerId)) return json({ error: "bad_request" }, 400);
  const account = await resolveOwnerAccountAction(ctx, ownerId);
  if (!account) return json({ error: "owner_unknown" }, 404);
  try {
    const snapshot = await ctx.runAction(
      internal.owner_snapshot.getOwnerSnapshotInternal,
      { ownerId },
    );
    return json(snapshot);
  } catch (error) {
    switch (convexErrorCode(error)) {
      case "OWNER_DATA_PURGE_ACTIVE":
      case "OWNERSHIP_MIGRATED":
        return json({ error: "owner_unavailable" }, 404);
      default:
        throw error;
    }
  }
});

export const registerGatewayRoutes = (http: HttpRouter) => {
  http.route({
    path: CONVEX_OWNER_SNAPSHOT_PATH,
    method: "GET",
    handler: ownerSnapshot,
  });
  http.route({
    path: CONVEX_GATEWAY_SESSION_CAPABILITY_PATH,
    method: "POST",
    handler: sessionCapability,
  });
  http.route({
    path: CONVEX_GATEWAY_USAGE_PATH,
    method: "POST",
    handler: usage,
  });
  http.route({
    path: GATEWAY_ALERTS_PATH,
    method: "POST",
    handler: alerts,
  });
  http.route({
    path: CONVEX_GATEWAY_CONFIG_PATH,
    method: "GET",
    handler: config,
  });
  http.route({
    path: CONVEX_GATEWAY_OWNER_ENFORCEMENT_PATH,
    method: "GET",
    handler: ownerEnforcement,
  });
  http.route({
    path: CONVEX_GATEWAY_ENGINE_ACCESS_PATH,
    method: "POST",
    handler: engineAccess,
  });
};
