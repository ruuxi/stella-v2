import type {
  GatewayErrorCode,
  GatewaySessionCapabilityResponse,
} from "@stella/contracts/gateway/api";
import {
  CONVEX_GATEWAY_CONFIG_PATH,
  CONVEX_GATEWAY_ENGINE_ACCESS_PATH,
  CONVEX_GATEWAY_SESSION_CAPABILITY_PATH,
  CONVEX_GATEWAY_USAGE_PATH,
  type ConvexEngineAccessRequest,
  type ConvexEngineAccessResponse,
  type ConvexSessionCapabilityRequest,
  type GatewayConfigSnapshot,
  type GatewayUsageBatch,
  type GatewayUsageBatchResult,
} from "@stella/contracts/gateway/usage";

/**
 * The gateway's only client of the control plane. Every call carries the
 * service secret as a bearer, times out after 10 s, and reports failures
 * as data rather than throwing so callers decide between "retry later" and
 * "refuse the request".
 *
 * Convex gateway routes fail with a `GatewayErrorBody`; when the body carries
 * a recognised `error.code` (e.g. `generation_stale` from engine-access) it
 * is surfaced so the lane can echo the exact code to the caller.
 */
export const CONVEX_CALL_TIMEOUT_MS = 10_000;

export type ConvexResult<T> =
  | { ok: true; status: number; body: T }
  | {
      ok: false;
      /** Null when the call never produced a response (timeout, network). */
      status: number | null;
      body: unknown;
      retryable: boolean;
      code: GatewayErrorCode | null;
    };

export type ConvexClient = {
  sessionCapability(
    request: ConvexSessionCapabilityRequest,
  ): Promise<ConvexResult<GatewaySessionCapabilityResponse>>;
  engineAccess(
    request: ConvexEngineAccessRequest,
  ): Promise<ConvexResult<ConvexEngineAccessResponse>>;
  config(): Promise<ConvexResult<GatewayConfigSnapshot>>;
  usage(
    batch: GatewayUsageBatch,
  ): Promise<ConvexResult<GatewayUsageBatchResult>>;
};

const KNOWN_CODES = new Set<GatewayErrorCode>([
  "unauthorized",
  "capability_expired",
  "capability_invalid",
  "generation_stale",
  "agent_type_forbidden",
  "model_forbidden",
  "execution_mismatch",
  "stream_unsupported",
  "budget_exhausted",
  "request_limit",
  "rate_limited",
  "concurrency_limit",
  "sign_in_required",
  "tier_paused",
  "owner_suspended",
  "challenge_required",
  "body_too_large",
  "bad_request",
  "upstream_error",
  "upstream_timeout",
  "canceled",
  "internal",
]);

const errorCodeOf = (body: unknown): GatewayErrorCode | null => {
  if (!body || typeof body !== "object") return null;
  const error = (body as { error?: unknown }).error;
  if (typeof error === "string" && KNOWN_CODES.has(error as GatewayErrorCode)) {
    return error as GatewayErrorCode;
  }
  if (!error || typeof error !== "object") return null;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" && KNOWN_CODES.has(code as GatewayErrorCode)
    ? (code as GatewayErrorCode)
    : null;
};

export const createConvexClient = (
  env: Pick<Env, "STELLA_CONVEX_SITE_URL" | "GATEWAY_SERVICE_SECRET">,
  fetchImpl: typeof fetch = fetch,
): ConvexClient => {
  const origin = env.STELLA_CONVEX_SITE_URL.replace(/\/+$/u, "");

  const call = async <T>(
    path: string,
    method: "GET" | "POST",
    payload?: unknown,
  ): Promise<ConvexResult<T>> => {
    let response: Response;
    try {
      response = await fetchImpl(`${origin}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${env.GATEWAY_SERVICE_SECRET}`,
          accept: "application/json",
          ...(payload !== undefined
            ? { "content-type": "application/json" }
            : {}),
        },
        body: payload !== undefined ? JSON.stringify(payload) : undefined,
        signal: AbortSignal.timeout(CONVEX_CALL_TIMEOUT_MS),
      });
    } catch {
      return {
        ok: false,
        status: null,
        body: null,
        retryable: true,
        code: null,
      };
    }
    let body: unknown = null;
    const text = await response.text();
    if (text) {
      try {
        body = JSON.parse(text) as unknown;
      } catch {
        body = text;
      }
    }
    if (response.ok) {
      return { ok: true, status: response.status, body: body as T };
    }
    return {
      ok: false,
      status: response.status,
      body,
      retryable: response.status >= 500 || response.status === 429,
      code: errorCodeOf(body),
    };
  };

  return {
    sessionCapability: (request) =>
      call<GatewaySessionCapabilityResponse>(
        CONVEX_GATEWAY_SESSION_CAPABILITY_PATH,
        "POST",
        request,
      ),
    engineAccess: (request) =>
      call<ConvexEngineAccessResponse>(
        CONVEX_GATEWAY_ENGINE_ACCESS_PATH,
        "POST",
        request,
      ),
    config: () =>
      call<GatewayConfigSnapshot>(CONVEX_GATEWAY_CONFIG_PATH, "GET"),
    usage: (batch) =>
      call<GatewayUsageBatchResult>(CONVEX_GATEWAY_USAGE_PATH, "POST", batch),
  };
};
