import {
  GATEWAY_NETWORK_POLICY,
  GATEWAY_HEALTH_PATH,
  GATEWAY_OWNER_ENFORCEMENT_PATH,
  GATEWAY_RELAY_PREFIX,
  GATEWAY_RESOLVE_PATH,
  GATEWAY_SESSION_CAPABILITY_PATH,
  type GatewayProtocol,
  type GatewayResolveRequest,
} from "@stella/contracts/gateway/api";
import {
  isDpopAlgorithm,
  verifyDeviceKeyProof,
  type GatewayDeviceKeyProof,
} from "@stella/contracts/gateway/dpop";
import { verifyConvexToken } from "./auth-jwt.js";
import {
  authenticateCapability,
  bearerToken,
  verifySessionDpop,
} from "./capability.js";
import { createConvexClient, type ConvexClient } from "./convex-client.js";
import {
  errorResponse,
  GatewayError,
  isGatewayError,
  jsonResponse,
  quotaErrorOptions,
  toGatewayError,
} from "./errors.js";
import { handleManagedRelay } from "./managed-lane.js";
import { classifyNetwork } from "../../shared/network-class.js";
import { handleNativeRelay } from "./native-lane.js";
import {
  handleOwnerEnforcement,
  ownerEnforcementAdmission,
} from "./owner-enforcement.js";
import {
  defaultDeps,
  ipHashFrom,
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
 *   POST /internal/owners/enforcement service bearer -> owner status KV
 *
 * Anything else is 404 `bad_request`; a wrong method is 405 `bad_request`.
 */
const AGENT_TYPE_PATTERN = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,63}$/u;
const MAX_DEVICE_PUBLIC_KEY_CHARS = 128;
const MAX_DEVICE_SIGNATURE_CHARS = 256;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const parseDeviceKeyProof = (value: unknown): GatewayDeviceKeyProof | null => {
  if (!isRecord(value)) return null;
  const proof = value;
  if (
    !isDpopAlgorithm(proof.alg) ||
    typeof proof.publicKey !== "string" ||
    proof.publicKey.length > MAX_DEVICE_PUBLIC_KEY_CHARS ||
    typeof proof.signature !== "string" ||
    proof.signature.length > MAX_DEVICE_SIGNATURE_CHARS ||
    typeof proof.timestamp !== "number" ||
    !Number.isFinite(proof.timestamp)
  ) {
    return null;
  }
  return {
    alg: proof.alg,
    publicKey: proof.publicKey,
    signature: proof.signature,
    timestamp: proof.timestamp,
  };
};

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
  const networkClass = await classifyNetwork(request, env.ASN_POLICY);
  if (
    verified.token.isAnonymous &&
    GATEWAY_NETWORK_POLICY.anonymousRefused.some(
      (refused) => refused === networkClass,
    )
  ) {
    throw new GatewayError(
      403,
      "sign_in_required",
      "Sign in to Stella to continue from this network.",
    );
  }
  const body = await readJsonObject(request, { allowEmpty: true });
  const deviceKey = parseDeviceKeyProof(body.deviceKey);
  if (!deviceKey) {
    throw new GatewayError(
      400,
      "dpop_invalid",
      "The device key proof is invalid: malformed.",
    );
  }
  const rawTurnstileToken = body.turnstileToken;
  if (
    rawTurnstileToken !== undefined &&
    (typeof rawTurnstileToken !== "string" || rawTurnstileToken.length > 4_096)
  ) {
    throw new GatewayError(
      400,
      "bad_request",
      "turnstileToken must be a string of at most 4096 characters.",
    );
  }
  const ownerId = verified.token.ownerId;
  const deviceProof = await verifyDeviceKeyProof({
    proof: deviceKey,
    ownerId,
    // This is the public origin in the URL the client called. Clients must
    // sign that exact origin, without the capability-exchange path.
    gatewayOrigin: new URL(request.url).origin,
    now: deps.now(),
  });
  if (!deviceProof.ok) {
    throw new GatewayError(
      400,
      "dpop_invalid",
      `The device key proof is invalid: ${deviceProof.reason}.`,
    );
  }
  const enforcement = await ownerEnforcementAdmission(env, ownerId, deps.now());
  if (enforcement.suspended) {
    throw new GatewayError(
      403,
      "owner_suspended",
      "This account is suspended from model access.",
    );
  }
  const audience = verified.token.isAnonymous ? "anonymous" : "free";
  const ownerGate = env.OWNER_RELAY_GATE.get(
    env.OWNER_RELAY_GATE.idFromName(ownerId),
  );
  const ownerAdmission = await ownerGate.admitMint({
    audience,
    throttled: enforcement.throttled,
  });
  if (!ownerAdmission.ok) {
    throw new GatewayError(
      429,
      "rate_limited",
      "Too many capability exchanges for this account.",
      quotaErrorOptions({
        scope: "owner",
        now: deps.now(),
        resetAt: ownerAdmission.resetAt,
      }),
    );
  }
  const ipHash = await ipHashFrom(request);
  if (verified.token.isAnonymous) {
    const networkGate = env.NETWORK_GATE.get(
      env.NETWORK_GATE.idFromName(ipHash),
    );
    const networkAdmission = await networkGate.admitMint();
    if (!networkAdmission.ok) {
      throw new GatewayError(
        429,
        "rate_limited",
        "Too many capability exchanges from this network.",
        quotaErrorOptions({
          scope: "network",
          now: deps.now(),
          resetAt: networkAdmission.resetAt,
        }),
      );
    }
  }
  const result = await convex.sessionCapability({
    ownerId,
    isAnonymous: verified.token.isAnonymous,
    ipHash,
    networkClass,
    deviceKeyHash: deviceProof.deviceKeyHash,
    ...(rawTurnstileToken !== undefined
      ? { turnstileToken: rawTurnstileToken }
      : {}),
  });
  if (!result.ok) {
    if (result.status === 403 && result.code === "challenge_required") {
      throw new GatewayError(
        403,
        "challenge_required",
        "Complete the verification challenge and try again.",
      );
    }
    if (result.status === 403 && result.code === "sign_in_required") {
      throw new GatewayError(
        403,
        "sign_in_required",
        "Sign in to Stella to continue.",
      );
    }
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
  await verifySessionDpop({ request, auth, now: deps.now() });
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
    if (url.pathname === GATEWAY_OWNER_ENFORCEMENT_PATH) {
      if (request.method !== "POST")
        throw new GatewayError(405, "bad_request", "Method not allowed.");
      return await handleOwnerEnforcement({ request, env, deps, traceId });
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
