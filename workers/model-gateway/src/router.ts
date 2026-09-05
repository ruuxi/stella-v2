import {
  GATEWAY_HEALTH_PATH,
  GATEWAY_MODEL_REVISION_HEADER,
  GATEWAY_NETWORK_POLICY,
  GATEWAY_OWNER_ENFORCEMENT_PATH,
  GATEWAY_PREPARE_PATH,
  GATEWAY_RELAY_PREFIX,
  GATEWAY_REQUEST_ID_HEADER,
  GATEWAY_RESOLVE_PATH,
  GATEWAY_SESSION_CAPABILITY_PATH,
  GATEWAY_VALIDATED_RELAY_PREFIX,
  type GatewayProtocol,
  type GatewayResolveRequest,
} from "@stella/contracts/gateway/api";
import {
  isDpopAlgorithm,
  verifyDeviceKeyProof,
  type GatewayDeviceKeyProof,
} from "@stella/contracts/gateway/dpop";
import { managedModelDescriptor } from "@stella/model-catalog/gateway-resolution";
import { verifyConvexToken } from "./auth-jwt.js";
import {
  authenticateCapability,
  bearerToken,
  verifySessionDpop,
} from "./capability.js";
import { getGatewayConfig, type GatewayConfigStorage } from "./config-cache.js";
import { createConvexClient, type ConvexClient } from "./convex-client.js";
import {
  errorResponse,
  GatewayError,
  isGatewayError,
  jsonResponse,
  quotaErrorOptions,
  toGatewayError,
} from "./errors.js";
import type { OwnerRelayAccounting } from "./ledger-client.js";
import {
  managedCancellationIdentity,
  type ManagedCancellationIdentity,
} from "./managed-cancellation.js";
import { handleManagedRelay } from "./managed-lane.js";
import { classifyNetwork } from "../../shared/network-class.js";
import { handleNativeRelay } from "./native-lane.js";
import {
  handleOwnerEnforcement,
  ownerEnforcementAdmission,
  type OwnerEnforcementAdmission,
} from "./owner-enforcement.js";
import { RelayTiming } from "./relay-timing.js";
import {
  defaultDeps,
  ipHashFrom,
  isGatewayRequestId,
  readJsonObject,
  type GatewayDeps,
} from "./request-util.js";
import { assertAgentTypeAllowed, resolveManagedRoute } from "./resolve.js";
import { sharedGatewayConfigStore } from "./shared-config.js";

/** The owner object hosting this request, when it runs inside `OwnerRelayGate`. */
export type LocalOwnerRelay = {
  matchesOwner(ownerId: string): boolean;
  accounting: OwnerRelayAccounting;
  instanceId?: string;
  configStorage?: GatewayConfigStorage;
  ownerEnforcement?: (
    ownerId: string,
    now: number,
  ) => Promise<OwnerEnforcementAdmission>;
  cancellation?: {
    begin(
      identity: ManagedCancellationIdentity,
    ):
      | { canceled: true }
      | { canceled: false; key: string; signal: AbortSignal };
    release(key: string): void;
  };
};

/** Runs `release` once the response body is fully consumed or canceled. */
const releaseAfterBody = (
  response: Response,
  release: () => void,
): Response => {
  if (!response.body) {
    release();
    return response;
  }
  const reader = response.body.getReader();
  let released = false;
  const finish = (): void => {
    if (released) return;
    released = true;
    release();
  };
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const part = await reader.read();
        if (part.done) {
          finish();
          controller.close();
        } else {
          controller.enqueue(part.value);
        }
      } catch (error) {
        finish();
        controller.error(error);
      }
    },
    async cancel(reason) {
      try {
        await reader.cancel(reason);
      } finally {
        finish();
      }
    },
  });
  return new Response(body, response);
};

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
  convex: ConvexClient,
  traceId: string,
  preparationMode: "background" | "await",
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
  // /prepare acknowledges actual completion. /resolve keeps its historical
  // nonblocking behavior, with failures observed instead of silently discarded.
  const ownerScoped =
    auth.claims.ledgerScope === "owner-relay-v2" && !auth.probe;
  const preparation = ownerScoped
    ? env.OWNER_RELAY_GATE.get(
        env.OWNER_RELAY_GATE.idFromName(auth.claims.sub),
      ).prepare(auth.claims.sub, traceId)
    : getGatewayConfig(
        convex,
        deps.waitUntil,
        deps.now,
        undefined,
        sharedGatewayConfigStore(env),
      ).then(() => undefined);
  if (preparationMode === "await") await preparation;
  else deps.waitUntil(preparation.catch(() => undefined));
  return jsonResponse(200, managedModelDescriptor(route), traceId);
};

const handleRelay = async (
  request: Request,
  env: Env,
  deps: GatewayDeps,
  convex: ConvexClient,
  traceId: string,
  localOwner?: LocalOwnerRelay,
): Promise<Response> => {
  const timing = new RelayTiming();
  let status: number | undefined;
  let lane = "unknown";
  let forwarded = false;
  let ledgerScope: "owner-relay-v2" | "capability" | undefined;
  let turn: { turnId: string; conversationId: string } | undefined;
  let cancellationKey: string | undefined;
  try {
    const auth = await authenticateCapability(request, env, {
      now: deps.now(),
      allowProbe: true,
    });
    timing.mark("authenticated");
    ledgerScope = auth.claims.ledgerScope ?? "capability";
    if (auth.claims.turn) {
      turn = {
        turnId: auth.claims.turn.turnId,
        conversationId: auth.claims.turn.conversationId,
      };
    }
    lane = auth.claims.credential ? "native" : "managed";
    if (
      new URL(request.url).pathname.startsWith(
        GATEWAY_VALIDATED_RELAY_PREFIX + "/",
      ) &&
      (auth.claims.credential ||
        !request.headers.has(GATEWAY_MODEL_REVISION_HEADER))
    ) {
      throw new GatewayError(
        400,
        "bad_request",
        "This route requires a managed model descriptor revision.",
      );
    }
    if (
      localOwner &&
      (!localOwner.matchesOwner(auth.claims.sub) ||
        auth.probe ||
        auth.claims.credential ||
        auth.claims.ledgerScope !== "owner-relay-v2")
    ) {
      throw new GatewayError(
        403,
        "capability_invalid",
        "This request does not belong to this owner executor.",
      );
    }
    if (localOwner?.cancellation) {
      const presentedRequestId = request.headers
        .get(GATEWAY_REQUEST_ID_HEADER)
        ?.trim();
      if (isGatewayRequestId(presentedRequestId)) {
        const identity = managedCancellationIdentity({
          claims: auth.claims,
          requestId: presentedRequestId,
        });
        if (identity) {
          const cancellation = localOwner.cancellation.begin(identity);
          if (cancellation.canceled) {
            throw new GatewayError(
              499,
              "canceled",
              "The model request was canceled.",
            );
          }
          cancellationKey = cancellation.key;
          request = new Request(request, {
            signal: AbortSignal.any([request.signal, cancellation.signal]),
          });
        }
      }
    }
    if (
      !localOwner &&
      !auth.probe &&
      !auth.claims.credential &&
      auth.claims.ledgerScope === "owner-relay-v2"
    ) {
      await verifySessionDpop({ request, auth, now: deps.now() });
      forwarded = true;
      // Inference and its exact accounting live in the same owner object.
      // The original request is reauthenticated there; no header bypass exists.
      const response = await env.OWNER_RELAY_GATE.get(
        env.OWNER_RELAY_GATE.idFromName(auth.claims.sub),
      ).fetch(request);
      status = response.status;
      return response;
    }
    if (auth.claims.credential) {
      const response = await handleNativeRelay({
        request,
        env,
        deps,
        convex,
        traceId,
        auth,
      });
      status = response.status;
      return response;
    }
    const protocol = protocolFromRelayPath(new URL(request.url).pathname);
    if (!protocol) {
      throw new GatewayError(404, "bad_request", "Unknown relay path.");
    }
    const response = await handleManagedRelay({
      request,
      env,
      deps,
      convex,
      traceId,
      auth,
      protocol,
      timing,
      ownerAccounting: localOwner?.accounting,
      configStorage: localOwner?.configStorage,
      sharedConfig: sharedGatewayConfigStore(env),
      ownerEnforcement: localOwner?.ownerEnforcement,
    });
    status = response.status;
    if (cancellationKey && localOwner?.cancellation) {
      const key = cancellationKey;
      cancellationKey = undefined;
      return releaseAfterBody(response, () =>
        localOwner.cancellation?.release(key),
      );
    }
    return response;
  } catch (error) {
    status = toGatewayError(error).status;
    throw error;
  } finally {
    if (cancellationKey) localOwner?.cancellation?.release(cancellationKey);
    console.info(
      JSON.stringify({
        event: forwarded
          ? "gateway_relay_route_timing"
          : "gateway_relay_timing",
        execution: localOwner ? "owner" : "worker",
        executorInstanceId: localOwner?.instanceId,
        traceId,
        lane,
        ledgerScope,
        status,
        ...turn,
        ...timing.snapshot(),
      }),
    );
  }
};

export const handleRequest = async (
  request: Request,
  env: Env,
  ctx: Pick<ExecutionContext, "waitUntil">,
  deps: GatewayDeps = defaultDeps(ctx),
  localOwner?: LocalOwnerRelay,
): Promise<Response> => {
  const traceId = crypto.randomUUID();
  const url = new URL(request.url);
  const convex = createConvexClient(env, deps.fetch);
  try {
    if (
      localOwner &&
      !url.pathname.startsWith(GATEWAY_RELAY_PREFIX + "/") &&
      !url.pathname.startsWith(GATEWAY_VALIDATED_RELAY_PREFIX + "/")
    ) {
      throw new GatewayError(
        404,
        "bad_request",
        "Owner executors accept model requests only.",
      );
    }
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
    if (
      url.pathname === GATEWAY_RESOLVE_PATH ||
      url.pathname === GATEWAY_PREPARE_PATH
    ) {
      if (request.method !== "POST")
        throw new GatewayError(405, "bad_request", "Method not allowed.");
      return await handleResolve(
        request,
        env,
        deps,
        convex,
        traceId,
        url.pathname === GATEWAY_PREPARE_PATH ? "await" : "background",
      );
    }
    if (
      url.pathname === GATEWAY_VALIDATED_RELAY_PREFIX ||
      url.pathname.startsWith(`${GATEWAY_VALIDATED_RELAY_PREFIX}/`) ||
      url.pathname === GATEWAY_RELAY_PREFIX ||
      url.pathname.startsWith(`${GATEWAY_RELAY_PREFIX}/`)
    ) {
      if (request.method !== "POST")
        throw new GatewayError(405, "bad_request", "Method not allowed.");
      return await handleRelay(request, env, deps, convex, traceId, localOwner);
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
