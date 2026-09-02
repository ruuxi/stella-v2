import {
  GATEWAY_HEALTH_PATH,
  GATEWAY_RELAY_PREFIX,
  GATEWAY_RESOLVE_PATH,
  GATEWAY_SESSION_CAPABILITY_PATH,
  type GatewayProtocol,
  type GatewayResolveRequest,
} from "@stella/contracts/gateway/api";
import { verifyConvexToken } from "./auth-jwt.js";
import { authenticateCapability, bearerToken } from "./capability.js";
import { createConvexClient, type ConvexClient } from "./convex-client.js";
import {
  errorResponse,
  GatewayError,
  isGatewayError,
  jsonResponse,
  toGatewayError,
} from "./errors.js";
import { handleManagedRelay } from "./managed-lane.js";
import { handleNativeRelay } from "./native-lane.js";
import {
  defaultDeps,
  readJsonObject,
  type GatewayDeps,
} from "./request-util.js";
import {
  assertAgentTypeAllowed,
  resolutionFor,
  resolveManagedRoute,
} from "./resolve.js";

/**
 * Route table
 *
 *   GET  /healthz                    200 {ok:true}
 *   POST /v1/capabilities/session    Better Auth JWT -> session capability
 *   POST /v1/models/resolve          capability -> GatewayModelResolution
 *   POST /v1/relay/*                 capability -> managed lane or native lane
 *
 * Anything else is 404 `bad_request`; a wrong method is 405 `bad_request`.
 */
const AGENT_TYPE_PATTERN = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,63}$/u;

export const protocolFromRelayPath = (
  pathname: string,
): GatewayProtocol | null => {
  if (/\/messages$/u.test(pathname)) return "anthropic-messages";
  if (/\/responses$/u.test(pathname)) return "openai-responses";
  if (/\/chat\/completions$/u.test(pathname)) return "openai-completions";
  if (
    /\/models\/.+:(?:streamGenerateContent|generateContent)$/u.test(pathname)
  ) {
    return "google-generative-ai";
  }
  return null;
};

const handleSessionCapability = async (
  request: Request,
  env: Env,
  deps: GatewayDeps,
  convex: ConvexClient,
  traceId: string,
): Promise<Response> => {
  const token = bearerToken(request);
  if (!token) {
    throw new GatewayError(
      401,
      "unauthorized",
      "A Better Auth bearer token is required.",
    );
  }
  const verified = await verifyConvexToken(
    token,
    env.STELLA_CONVEX_SITE_URL,
    deps.fetch,
  );
  if (!verified.ok) {
    if (verified.retryable) {
      console.warn(
        `[model-gateway] trace=${traceId} session auth unavailable: ${verified.reason}`,
      );
      throw new GatewayError(
        503,
        "internal",
        "Sign-in verification is temporarily unavailable.",
        {
          retryable: true,
        },
      );
    }
    throw new GatewayError(
      401,
      "unauthorized",
      "The bearer token is not a valid Stella sign-in.",
    );
  }
  const body = await readJsonObject(request, { allowEmpty: true });
  const rawDeviceId =
    typeof body.deviceId === "string" ? body.deviceId.trim() : "";
  const deviceId =
    rawDeviceId && rawDeviceId.length <= 128 ? rawDeviceId : undefined;
  const result = await convex.sessionCapability({
    ownerId: verified.token.ownerId,
    isAnonymous: verified.token.isAnonymous,
    ...(deviceId ? { deviceId } : {}),
  });
  if (!result.ok) {
    if (result.code) {
      throw new GatewayError(
        result.status ?? 503,
        result.code,
        "A session capability could not be issued.",
        {
          retryable: result.retryable,
        },
      );
    }
    if (result.retryable || result.status === null) {
      throw new GatewayError(
        503,
        "internal",
        "Session capabilities are temporarily unavailable.",
        {
          retryable: true,
        },
      );
    }
    throw new GatewayError(
      403,
      "unauthorized",
      "A session capability could not be issued for this account.",
    );
  }
  return jsonResponse(200, result.body, traceId);
};

const handleResolve = async (
  request: Request,
  env: Env,
  deps: GatewayDeps,
  traceId: string,
): Promise<Response> => {
  const auth = await authenticateCapability(request, env, {
    now: deps.now(),
    allowProbe: true,
  });
  const body = (await readJsonObject(
    request,
  )) as Partial<GatewayResolveRequest>;
  const agentType =
    typeof body.agentType === "string" ? body.agentType.trim() : "";
  if (!agentType || !AGENT_TYPE_PATTERN.test(agentType)) {
    throw new GatewayError(400, "bad_request", "agentType is required.");
  }
  assertAgentTypeAllowed(auth.claims, agentType);
  if (auth.claims.credential) {
    throw new GatewayError(
      400,
      "bad_request",
      "Native-lane capabilities pin their model at admission; there is nothing to resolve.",
    );
  }
  const requestedModel =
    typeof body.model === "string" ? body.model.trim() : undefined;
  const route = resolveManagedRoute({
    claims: auth.claims,
    agentType,
    requestedModel,
  });
  return jsonResponse(200, resolutionFor(route), traceId);
};

const handleRelay = async (
  request: Request,
  env: Env,
  deps: GatewayDeps,
  convex: ConvexClient,
  traceId: string,
): Promise<Response> => {
  const auth = await authenticateCapability(request, env, {
    now: deps.now(),
    allowProbe: true,
  });
  if (auth.claims.credential) {
    return handleNativeRelay({ request, env, deps, convex, traceId, auth });
  }
  const protocol = protocolFromRelayPath(new URL(request.url).pathname);
  if (!protocol) {
    throw new GatewayError(404, "bad_request", "Unknown relay path.");
  }
  return handleManagedRelay({
    request,
    env,
    deps,
    convex,
    traceId,
    auth,
    protocol,
  });
};

export const handleRequest = async (
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  deps: GatewayDeps = defaultDeps(ctx),
): Promise<Response> => {
  const traceId = crypto.randomUUID();
  const url = new URL(request.url);
  const convex = createConvexClient(env, deps.fetch);
  try {
    if (url.pathname === GATEWAY_HEALTH_PATH) {
      if (request.method !== "GET" && request.method !== "HEAD") {
        throw new GatewayError(405, "bad_request", "Method not allowed.");
      }
      return jsonResponse(200, { ok: true }, traceId);
    }
    if (url.pathname === GATEWAY_SESSION_CAPABILITY_PATH) {
      if (request.method !== "POST")
        throw new GatewayError(405, "bad_request", "Method not allowed.");
      return await handleSessionCapability(request, env, deps, convex, traceId);
    }
    if (url.pathname === GATEWAY_RESOLVE_PATH) {
      if (request.method !== "POST")
        throw new GatewayError(405, "bad_request", "Method not allowed.");
      return await handleResolve(request, env, deps, traceId);
    }
    if (
      url.pathname === GATEWAY_RELAY_PREFIX ||
      url.pathname.startsWith(`${GATEWAY_RELAY_PREFIX}/`)
    ) {
      if (request.method !== "POST")
        throw new GatewayError(405, "bad_request", "Method not allowed.");
      return await handleRelay(request, env, deps, convex, traceId);
    }
    throw new GatewayError(404, "bad_request", "Not found.");
  } catch (error) {
    if (!isGatewayError(error)) {
      console.error(
        `[model-gateway] trace=${traceId} unhandled: ${error instanceof Error ? `${error.name}: ${error.message}\n${error.stack ?? ""}` : String(error)}`,
      );
    } else if (error.status >= 500) {
      console.error(
        `[model-gateway] trace=${traceId} ${error.code}: ${error.message}`,
      );
    }
    return errorResponse(toGatewayError(error), traceId);
  }
};
