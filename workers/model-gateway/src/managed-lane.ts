import { GATEWAY_MODEL_REVISION_HEADER, GATEWAY_MODEL_RESOLUTION_HEADER,
  gatewayModelResolutionRevision } from "@stella/contracts/gateway/api";
import { resolutionFor } from "./resolve.js";
import {
  capabilityLedgerClient,
  type CapabilityLedgerClient,
} from "./ledger-client.js";
import { RelayTiming } from "./relay-timing.js";
import {
  GATEWAY_MAX_OUTPUT_TOKENS_BY_AUDIENCE,
  GATEWAY_NETWORK_POLICY,
  GATEWAY_TRACE_HEADER,
  GATEWAY_UPSTREAM_IDLE_TIMEOUT_MS,
  GATEWAY_UPSTREAM_MAX_DURATION_MS,
  limitsAudienceFor,
  type GatewayProtocol,
} from "@stella/contracts/gateway/api";
import {
  GATEWAY_USAGE_EVENT_VERSION,
  type GatewayUsageEvent,
  type GatewayUsageOutcome,
  type GatewayUsageTokens,
} from "@stella/contracts/gateway/usage";
import {
  GATEWAY_BUDGET_UNLIMITED,
  type ManagedModelAudience,
} from "@stella/contracts/gateway/capability";
import {
  validateManagedCloudBinding,
  validateManagedReasoningBinding,
} from "@stella/model-catalog/cloud-binding";
import {
  getManagedGatewayConfig,
  resolveManagedGatewayApiKeyFromEnv,
} from "@stella/model-catalog/managed-gateway";
import { computeUsageCostMicroCents } from "@stella/model-catalog/pricing";
import {
  estimateRequestTokens,
  requestedModelFromGooglePath,
  type TokenEstimate,
} from "@stella/model-catalog/request-estimate";
import {
  bodyForUpstream,
  cloneForwardHeaders,
  upstreamUrl,
} from "@stella/model-catalog/request-shaping";
import {
  createRelayUsageParser,
  type RelayUsage,
} from "@stella/model-catalog/usage";
import { createAnthropicAssembler } from "./assemble/anthropic.js";
import { createGoogleAssembler } from "./assemble/google.js";
import { createOpenAICompletionsAssembler } from "./assemble/openai-completions.js";
import { createOpenAIResponsesAssembler } from "./assemble/openai-responses.js";
import { createSseParser, frameJson, type SseFrame } from "./assemble/sse.js";
import type { Assembler } from "./assemble/types.js";
import {
  verifySessionDpop,
  type AuthenticatedCapability,
} from "./capability.js";
import { getGatewayConfig } from "./config-cache.js";
import type { ConvexClient } from "./convex-client.js";
import {
  GatewayError,
  jsonResponse,
  quotaErrorOptions,
  upstreamErrorBody,
} from "./errors.js";
import type { LedgerSettleArgs } from "./ledger.js";
import { classifyNetwork } from "../../shared/network-class.js";
import { ownerEnforcementAdmission } from "./owner-enforcement.js";
import {
  agentTypeFrom,
  clientIp,
  createUpstreamController,
  ipHashFrom,
  readJsonObject,
  requestIdFrom,
  type GatewayDeps,
} from "./request-util.js";
import {
  assertAgentTypeAllowed,
  PROTOCOLS_BY_PROVIDER,
  resolveManagedRoute,
  type ManagedRoute,
} from "./resolve.js";

/**
 * Managed lane: Stella-billed, request/response.
 *
 * authorize -> price -> reserve on the capability ledger -> stream from the
 * provider -> assemble one provider-native object -> meter -> settle ->
 * enqueue usage -> respond. The client never sees SSE.
 */
export const GATEWAY_REPLAY_HEADER = "x-stella-gateway-replay" as const;

/** Upstream bytes beyond this are a runaway stream, not a completion. */
const MAX_UPSTREAM_STREAM_BYTES = 64 * 1024 * 1024;

const assemblerFor = (protocol: GatewayProtocol): Assembler => {
  switch (protocol) {
    case "anthropic-messages":
      return createAnthropicAssembler();
    case "openai-responses":
      return createOpenAIResponsesAssembler();
    case "openai-completions":
      return createOpenAICompletionsAssembler();
    case "google-generative-ai":
      return createGoogleAssembler();
  }
};

/**
 * The URL `@stella/model-catalog` shapes against. Google's verb and `alt=sse`
 * are forced here because the model catalog preserves whatever verb the
 * caller used; everything else keeps the caller's path suffix.
 */
const shapingUrlFor = (request: Request, protocol: GatewayProtocol): URL => {
  const url = new URL(request.url);
  if (protocol === "google-generative-ai") {
    url.pathname = url.pathname.replace(
      /:[A-Za-z][A-Za-z0-9]*$/u,
      ":streamGenerateContent",
    );
    url.searchParams.set("alt", "sse");
  }
  return url;
};

const streamingRequestJson = (
  requestJson: Record<string, unknown>,
  protocol: GatewayProtocol,
): Record<string, unknown> => {
  const body = { ...requestJson };
  // Google streams by verb, not by body flag, and rejects unknown fields.
  if (protocol === "google-generative-ai") delete body.stream;
  else body.stream = true;
  return body;
};

export type ShapedUpstreamRequest = {
  url: string;
  headers: Headers;
  body: string;
};

const outputTokenCap = (args: {
  audience: ManagedModelAudience;
  modelCeiling: number | undefined;
}): number | null => {
  const audienceCeiling =
    GATEWAY_MAX_OUTPUT_TOKENS_BY_AUDIENCE[limitsAudienceFor(args.audience)];
  const ceilings = [audienceCeiling, args.modelCeiling].filter(
    (value): value is number =>
      typeof value === "number" && Number.isFinite(value) && value >= 0,
  );
  return ceilings.length > 0 ? Math.floor(Math.min(...ceilings)) : null;
};

export const clampOutputTokens = (args: {
  requestJson: Record<string, unknown>;
  protocol: GatewayProtocol;
  audience: ManagedModelAudience;
  modelCeiling: number | undefined;
}): Record<string, unknown> => {
  const cap = outputTokenCap(args);
  if (cap === null) return { ...args.requestJson };
  const body = { ...args.requestJson };
  for (const field of [
    "max_tokens",
    "max_output_tokens",
    "max_completion_tokens",
  ] as const) {
    const value = body[field];
    if (typeof value === "number" && Number.isFinite(value)) {
      body[field] = Math.min(cap, Math.max(0, Math.floor(value)));
    }
  }
  if (
    body.generationConfig &&
    typeof body.generationConfig === "object" &&
    !Array.isArray(body.generationConfig)
  ) {
    const generationConfig = {
      ...(body.generationConfig as Record<string, unknown>),
    };
    const requested = generationConfig.maxOutputTokens;
    if (typeof requested === "number" && Number.isFinite(requested)) {
      generationConfig.maxOutputTokens = Math.min(
        cap,
        Math.max(0, Math.floor(requested)),
      );
    }
    body.generationConfig = generationConfig;
  }
  const requestedCeiling = Math.min(
    cap,
    ...[
      body.max_tokens,
      body.max_output_tokens,
      body.max_completion_tokens,
    ].filter(
      (value): value is number =>
        typeof value === "number" && Number.isFinite(value),
    ),
  );
  switch (args.protocol) {
    case "anthropic-messages":
      if (body.max_tokens === undefined) body.max_tokens = requestedCeiling;
      break;
    case "openai-responses":
      if (body.max_output_tokens === undefined) {
        body.max_output_tokens = requestedCeiling;
      }
      break;
    case "openai-completions":
      if (body.max_completion_tokens === undefined) {
        body.max_completion_tokens = requestedCeiling;
      }
      break;
    case "google-generative-ai": {
      const generationConfig =
        body.generationConfig &&
        typeof body.generationConfig === "object" &&
        !Array.isArray(body.generationConfig)
          ? { ...(body.generationConfig as Record<string, unknown>) }
          : {};
      if (generationConfig.maxOutputTokens === undefined) {
        generationConfig.maxOutputTokens = requestedCeiling;
      }
      body.generationConfig = generationConfig;
      break;
    }
  }
  return body;
};

/**
 * The exact upstream call for a managed request: URL, headers, and body as
 * `@stella/model-catalog` shapes them, with streaming forced on (Google via
 * `:streamGenerateContent?alt=sse`, chat completions with
 * `stream_options.include_usage`) and `accept: text/event-stream`.
 */
export const shapeUpstreamRequest = (args: {
  request: Request;
  protocol: GatewayProtocol;
  route: ManagedRoute;
  requestJson: Record<string, unknown>;
  apiKey: string;
  audience: ManagedModelAudience;
}): ShapedUpstreamRequest => {
  const shapingRequest = new Request(
    shapingUrlFor(args.request, args.protocol),
    {
      method: "POST",
      headers: args.request.headers,
    },
  );
  const body = bodyForUpstream(
    {
      requestJson: streamingRequestJson(
        clampOutputTokens({
          requestJson: args.requestJson,
          protocol: args.protocol,
          audience: args.audience,
          modelCeiling: args.route.config.maxOutputTokens,
        }),
        args.protocol,
      ),
      resolvedModel: args.route.resolvedModel,
      upstreamModel: args.route.upstreamModel,
      serviceTier: args.route.config.serviceTier,
    },
    args.route.provider,
    shapingRequest,
  );
  const url = upstreamUrl(
    args.route.provider,
    shapingRequest,
    args.route.upstreamModel,
  );
  const headers = cloneForwardHeaders(
    shapingRequest,
    args.route.provider,
    args.apiKey,
  );
  headers.set("accept", "text/event-stream");
  return { url, headers, body };
};

const usageTokens = (
  usage: RelayUsage | null,
  estimate: TokenEstimate,
): GatewayUsageTokens =>
  usage && (usage.inputTokens !== undefined || usage.outputTokens !== undefined)
    ? {
        inputTokens: usage.inputTokens ?? 0,
        outputTokens: usage.outputTokens ?? 0,
        ...(usage.cachedInputTokens !== undefined
          ? { cachedInputTokens: usage.cachedInputTokens }
          : {}),
        ...(usage.cacheWriteInputTokens !== undefined
          ? { cacheWriteTokens: usage.cacheWriteInputTokens }
          : {}),
        ...(usage.reasoningTokens !== undefined
          ? { reasoningTokens: usage.reasoningTokens }
          : {}),
        ...(usage.costMicroCents !== undefined
          ? { costMicroCents: usage.costMicroCents }
          : {}),
        reported: true,
      }
    : {
        inputTokens: estimate.inputTokens,
        outputTokens: estimate.outputTokens,
        reported: false,
      };

const recordOf = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

const outputTextLengthInFrame = (
  protocol: GatewayProtocol,
  frame: SseFrame,
): number => {
  const event = frameJson(frame);
  if (!event) return 0;
  if (protocol === "anthropic-messages") {
    const delta = recordOf(event.delta);
    return [delta?.text, delta?.thinking, delta?.partial_json].reduce<number>(
      (total, value) => total + (typeof value === "string" ? value.length : 0),
      0,
    );
  }
  if (protocol === "openai-responses") {
    const type = typeof event.type === "string" ? event.type : frame.event;
    if (!type?.endsWith(".delta")) return 0;
    const delta = event.delta;
    if (typeof delta === "string") return delta.length;
    const record = recordOf(delta);
    return [
      record?.text,
      record?.arguments,
      record?.partial_json,
    ].reduce<number>(
      (total, value) => total + (typeof value === "string" ? value.length : 0),
      0,
    );
  }
  if (protocol === "openai-completions") {
    const choices = Array.isArray(event.choices) ? event.choices : [];
    let length = 0;
    for (const rawChoice of choices) {
      const delta = recordOf(recordOf(rawChoice)?.delta);
      if (!delta) continue;
      for (const field of [
        "content",
        "reasoning_content",
        "reasoning",
        "reasoning_text",
        "refusal",
      ] as const) {
        const value = delta[field];
        if (typeof value === "string") length += value.length;
      }
      const toolCalls = Array.isArray(delta.tool_calls) ? delta.tool_calls : [];
      for (const rawCall of toolCalls) {
        const fn = recordOf(recordOf(rawCall)?.function);
        if (typeof fn?.arguments === "string") length += fn.arguments.length;
      }
    }
    return length;
  }

  const candidates = Array.isArray(event.candidates) ? event.candidates : [];
  let length = 0;
  for (const rawCandidate of candidates) {
    const content = recordOf(recordOf(rawCandidate)?.content);
    const parts = Array.isArray(content?.parts) ? content.parts : [];
    for (const rawPart of parts) {
      const text = recordOf(rawPart)?.text;
      if (typeof text === "string") length += text.length;
    }
  }
  return length;
};

export const handleManagedRelay = async (args: {
  request: Request;
  env: Env;
  deps: GatewayDeps;
  convex: ConvexClient;
  traceId: string;
  auth: AuthenticatedCapability;
  protocol: GatewayProtocol;
  timing?: RelayTiming;
  ownerAccounting?: import("./ledger-client.js").OwnerRelayAccounting;
  configStorage?: import("./config-cache.js").GatewayConfigStorage;
  sharedConfig?: import("./shared-config.js").SharedGatewayConfigStore;
  ownerEnforcement?: (
    ownerId: string,
    now: number,
  ) => Promise<import("./owner-enforcement.js").OwnerEnforcementAdmission>;
}): Promise<Response> => {
  const { request, env, deps, convex, traceId, protocol } = args;
  const timing = args.timing ?? new RelayTiming();
  const { claims, probe } = args.auth;
  const startedAt = deps.now();
  const pathname = new URL(request.url).pathname;
  const { requestId } = requestIdFrom(request);
  const deviceKeyHash = await timing.measure("dpopMs", () =>
    verifySessionDpop({
      request,
      auth: args.auth,
      now: deps.now(),
    }),
  );
  // Start cold pricing reads during authorization. Capture rejection even if
  // the request is refused before pricing is needed.
  const configWork = timing.measure("pricingConfigMs", () =>
    getGatewayConfig(convex, deps.waitUntil, deps.now, args.configStorage, args.sharedConfig),
  ).then(value => ({ ok: true as const, value }), error => ({ ok: false as const, error }));
  const enforcementWork = timing.measure("ownerEnforcementMs", () =>
    args.ownerEnforcement
      ? args.ownerEnforcement(claims.sub, deps.now())
      : ownerEnforcementAdmission(env, claims.sub, deps.now()),
  ).then(value => ({ ok: true as const, value }), error => ({ ok: false as const, error }));
  // A speculative client may have an older catalog. Refuse it before any
  // limiter, reservation or provider request, so it can rebuild the adapter
  // and reapply context transforms to the original, unpruned messages.
  let predictedRequestJson: Awaited<ReturnType<typeof readJsonObject>> | undefined;
  const predictedRevision = request.headers.get(GATEWAY_MODEL_REVISION_HEADER);
  if (predictedRevision !== null) {
    predictedRequestJson = await readJsonObject(request);
    const agentType = agentTypeFrom(request);
    if (!agentType) throw new GatewayError(400, "bad_request", "The x-stella-agent-type header is required.");
    assertAgentTypeAllowed(claims, agentType);
    const requestedModel = protocol === "google-generative-ai"
      ? requestedModelFromGooglePath(pathname) ?? undefined
      : typeof predictedRequestJson.model === "string" ? predictedRequestJson.model : undefined;
    const route = resolveManagedRoute({ claims, agentType, requestedModel });
    const resolution = resolutionFor(route);
    if (predictedRevision !== await gatewayModelResolutionRevision(resolution)) {
      throw new GatewayError(409, "model_revision_mismatch", "The model configuration changed. Rebuild the request with the current descriptor.", {
        headers: { "x-should-retry": "false", [GATEWAY_MODEL_RESOLUTION_HEADER]: encodeURIComponent(JSON.stringify(resolution)) },
      });
    }
  }
  const enforcementResult = await enforcementWork;
  if (!enforcementResult.ok) throw enforcementResult.error;
  const enforcement = enforcementResult.value;
  if (enforcement.suspended) {
    throw new GatewayError(
      403,
      "owner_suspended",
      "This account is suspended from model access.",
    );
  }

  const limitsAudience = limitsAudienceFor(claims.audience);
  const networkClass = await classifyNetwork(request, env.ASN_POLICY);
  if (
    limitsAudience === "anonymous" &&
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
  const networkCapShare =
    limitsAudience === "free" &&
    GATEWAY_NETWORK_POLICY.freeChallenged.some(
      (challenged) => challenged === networkClass,
    )
      ? 0.5
      : 1;
  let ipHash: string | undefined;
  if (limitsAudience === "anonymous" || limitsAudience === "free") {
    ipHash = await ipHashFrom(request);
  }
  if (limitsAudience === "anonymous" && !probe) {
    const edgeResetAt = deps.now() + 60_000;
    const outcome = await env.ANON_IP_LIMITER.limit({ key: clientIp(request) });
    if (!outcome.success) {
      throw new GatewayError(
        429,
        "rate_limited",
        "Too many anonymous requests from this network.",
        quotaErrorOptions({
          scope: "network",
          now: deps.now(),
          resetAt: edgeResetAt,
        }),
      );
    }
  }
  if (ipHash && (limitsAudience === "anonymous" || limitsAudience === "free")) {
    const networkGate = env.NETWORK_GATE.get(
      env.NETWORK_GATE.idFromName(ipHash),
    );
    const admission = await networkGate.admitRelay({
      audience: claims.audience,
      capShare: networkCapShare,
    });
    if (!admission.ok) {
      throw new GatewayError(
        429,
        "rate_limited",
        "Too many model requests from this network.",
        quotaErrorOptions({
          scope: "network",
          now: deps.now(),
          resetAt: admission.resetAt,
        }),
      );
    }
  }

  const ownerGate = args.ownerAccounting ?? env.OWNER_RELAY_GATE.get(
    env.OWNER_RELAY_GATE.idFromName(claims.sub),
  );
  const combinedAccounting = !probe && claims.ledgerScope === "owner-relay-v2";
  const ownerAdmission = combinedAccounting ? { ok: true as const, duplicate: true } : await timing.measure("ownerAdmissionMs", () =>
    ownerGate.admitRelay({
      audience: claims.audience,
      requestId,
      throttled: enforcement.throttled,
    }),
  );
  let ownerAdmitted = ownerAdmission.ok && !ownerAdmission.duplicate;
  if (!ownerAdmission.ok) {
    throw new GatewayError(
      429,
      ownerAdmission.refused,
      ownerAdmission.refused === "concurrency_limit"
        ? "This account has too many model requests in flight."
        : "This account is sending model requests too quickly.",
      quotaErrorOptions({
        scope: "owner",
        now: deps.now(),
        resetAt: ownerAdmission.resetAt,
      }),
    );
  }

  let tierGate: ReturnType<Env["TIER_BUDGET"]["get"]> | null = null;
  let tierReservation: {
    estimateMicroCents: number;
    minute: number;
  } | null = null;
  let tierActualMicroCents = 0;
  let ledger: CapabilityLedgerClient | null = null;
  let ledgerReserved = false;
  let ledgerSettled = false;
  let firstUpstreamByte = false;

  try {
    const agentType = agentTypeFrom(request);
    if (!agentType) {
      throw new GatewayError(
        400,
        "bad_request",
        "The x-stella-agent-type header is required.",
      );
    }
    assertAgentTypeAllowed(claims, agentType);

    const requestJson = predictedRequestJson ?? await readJsonObject(request);
    if (requestJson.stream === true) {
      throw new GatewayError(
        400,
        "stream_unsupported",
        "The managed lane is request/response; send stream: false and receive the complete object.",
      );
    }

    let requestedModel =
      typeof requestJson.model === "string" ? requestJson.model : undefined;
    if (protocol === "google-generative-ai") {
      const pathModel = requestedModelFromGooglePath(pathname);
      if (pathModel) requestedModel = pathModel;
    }

    const bindingError = validateManagedCloudBinding({
      execution: claims.turn?.execution,
      viaTurnToken: claims.kind === "turn",
      requestedModel,
    });
    if (bindingError) {
      throw new GatewayError(
        bindingError.status,
        bindingError.status === 403 ? "execution_mismatch" : "bad_request",
        bindingError.message,
      );
    }

    const route = resolveManagedRoute({ claims, agentType, requestedModel });
    if (!PROTOCOLS_BY_PROVIDER[route.provider].includes(protocol)) {
      throw new GatewayError(
        400,
        "bad_request",
        `Model "${route.requestedModel}" speaks ${route.protocol}; this relay path carries ${protocol}.`,
      );
    }
    if (claims.turn && claims.turn.execution.engine === "stella") {
      const reasoningError = validateManagedReasoningBinding({
        execution: claims.turn.execution,
        relayProvider: route.provider,
        resolvedModel: route.resolvedModel,
        reasoningCapable: true,
        requestJson,
      });
      if (reasoningError) {
        throw new GatewayError(
          reasoningError.status,
          reasoningError.status === 403 ? "execution_mismatch" : "bad_request",
          reasoningError.message,
        );
      }
    }

    const configResult = await configWork;
    if (!configResult.ok) throw configResult.error;
    const config = configResult.value;
    const price = config.priceFor(route.resolvedModel);
    if (!price) {
      throw new GatewayError(
        500,
        "internal",
        `Model "${route.resolvedModel}" has no price.`,
      );
    }
    const cappedRequestJson = clampOutputTokens({
      requestJson,
      protocol,
      audience: claims.audience,
      modelCeiling: route.config.maxOutputTokens,
    });
    const estimate = estimateRequestTokens(cappedRequestJson);
    const estimatedMicroCents = computeUsageCostMicroCents({
      model: route.resolvedModel,
      inputTokens: estimate.inputTokens,
      outputTokens: estimate.outputTokens,
      price,
    });
    if (!(estimatedMicroCents > 0)) {
      throw new GatewayError(
        500,
        "internal",
        `Model "${route.resolvedModel}" has a non-positive price.`,
      );
    }

    const gatewayConfig = getManagedGatewayConfig(route.provider);
    const apiKey = resolveManagedGatewayApiKeyFromEnv(
      gatewayConfig,
      env as unknown as Readonly<Record<string, string | undefined>>,
    );
    if (!apiKey) {
      throw new GatewayError(
        503,
        "internal",
        "The model provider is not configured.",
        { retryable: true },
      );
    }
    const {
      url: target,
      headers,
      body: upstreamBody,
    } = shapeUpstreamRequest({
      request,
      protocol,
      route,
      requestJson: cappedRequestJson,
      apiKey,
      audience: claims.audience,
    });

    const tierCeiling = config.tierCeilings.get(limitsAudience);
    if (
      !combinedAccounting && !probe &&
      claims.budgetMicroCents !== GATEWAY_BUDGET_UNLIMITED &&
      tierCeiling &&
      (tierCeiling.hourlyMicroCents >= 0 || tierCeiling.dailyMicroCents >= 0)
    ) {
      tierGate = env.TIER_BUDGET.get(
        env.TIER_BUDGET.idFromName(limitsAudience),
      );
      const gate = tierGate;
      const reservation = await timing.measure("tierReservationMs", () =>
        gate.reserve({
          estimateMicroCents: estimatedMicroCents,
          hourlyCeiling: tierCeiling.hourlyMicroCents,
          dailyCeiling: tierCeiling.dailyMicroCents,
          now: deps.now(),
        }),
      );
      if (!reservation.ok) {
        const anonymous = limitsAudience === "anonymous";
        throw new GatewayError(
          anonymous ? 403 : 429,
          anonymous ? "sign_in_required" : "tier_paused",
          anonymous
            ? "Sign in to continue using managed models."
            : "Managed model access is paused for this plan.",
          quotaErrorOptions({
            scope: "tier",
            now: deps.now(),
            resetAt: reservation.resetAt,
            retryable: !anonymous,
          }),
        );
      }
      tierReservation = {
        estimateMicroCents: estimatedMicroCents,
        minute: reservation.minute,
      };
    }

    ledger = probe ? null : capabilityLedgerClient(env, claims, args.ownerAccounting);
    let capabilityHardLimitMicroCents: number | null = null;
    if (ledger) {
      const capabilityLedger = ledger;
      const reservationArgs = {
        jti: claims.jti, budgetMicroCents: claims.budgetMicroCents,
        maxRequests: claims.maxRequests, expiresAt: claims.exp * 1000,
        requestId, estimatedMicroCents,
      };
      const reservation = await timing.measure(combinedAccounting ? "ownerReservationMs" : "ledgerReservationMs", async () => {
        if (!combinedAccounting) return await capabilityLedger.reserve(reservationArgs);
        const result = await ownerGate.admitAndReserve({
          audience: claims.audience, requestId, throttled: enforcement.throttled,
          generation: claims.gen, reservation: reservationArgs,
        });
        const admission = result.admission;
        if (!admission.ok) throw new GatewayError(429, admission.refused,
          admission.refused === "concurrency_limit"
            ? "This account has too many model requests in flight."
            : "This account is sending model requests too quickly.",
          quotaErrorOptions({ scope: "owner", now: deps.now(), resetAt: admission.resetAt }));
        ownerAdmitted = !admission.duplicate && result.reservation?.kind === "reserved";
        if (!result.reservation) throw new GatewayError(503, "internal", "Model admission did not return a reservation.");
        return result.reservation;
      });
      switch (reservation.kind) {
        case "replay":
          return new Response(reservation.body, {
            status: reservation.status,
            headers: {
              "cache-control": "no-store",
              "content-type": "application/json; charset=utf-8",
              [GATEWAY_TRACE_HEADER]: traceId,
              [GATEWAY_REPLAY_HEADER]: "1",
            },
          });
        case "in_flight":
          throw new GatewayError(
            409,
            "bad_request",
            `Request "${requestId}" is still in flight; retry after it completes.`,
            { retryable: true },
          );
        case "budget_exhausted":
          throw new GatewayError(
            402,
            "budget_exhausted",
            "This capability's spending budget is exhausted.",
            quotaErrorOptions({ scope: "capability", now: deps.now() }),
          );
        case "request_limit":
          throw new GatewayError(
            429,
            "request_limit",
            `This capability's request limit (${reservation.maxRequests}) has been reached.`,
            quotaErrorOptions({ scope: "capability", now: deps.now() }),
          );
        case "reserved":
          ledgerReserved = true;
          capabilityHardLimitMicroCents =
            reservation.remainingMicroCents === null
              ? null
              : estimatedMicroCents + reservation.remainingMicroCents;
          break;
      }
    }

    if (
      combinedAccounting && !probe &&
      claims.budgetMicroCents !== GATEWAY_BUDGET_UNLIMITED &&
      tierCeiling &&
      (tierCeiling.hourlyMicroCents >= 0 || tierCeiling.dailyMicroCents >= 0)
    ) {
      tierGate = env.TIER_BUDGET.get(
        env.TIER_BUDGET.idFromName(limitsAudience),
      );
      const gate = tierGate;
      const reservation = await timing.measure("tierReservationMs", () =>
        gate.reserve({
          estimateMicroCents: estimatedMicroCents,
          hourlyCeiling: tierCeiling.hourlyMicroCents,
          dailyCeiling: tierCeiling.dailyMicroCents,
          now: deps.now(),
        }),
      );
      if (!reservation.ok) {
        const anonymous = limitsAudience === "anonymous";
        throw new GatewayError(
          anonymous ? 403 : 429,
          anonymous ? "sign_in_required" : "tier_paused",
          anonymous
            ? "Sign in to continue using managed models."
            : "Managed model access is paused for this plan.",
          quotaErrorOptions({
            scope: "tier",
            now: deps.now(),
            resetAt: reservation.resetAt,
            retryable: !anonymous,
          }),
        );
      }
      tierReservation = {
        estimateMicroCents: estimatedMicroCents,
        minute: reservation.minute,
      };
    }

    const finish = async (
      outcome: GatewayUsageOutcome,
      tokens: GatewayUsageTokens,
      chargedMicroCents: number,
      upstreamStatus: number | undefined,
      refundRequest: boolean,
      result?: LedgerSettleArgs["result"],
    ): Promise<void> => {
      tierActualMicroCents = chargedMicroCents;
      if (ledger && ledgerReserved) {
        const capabilityLedger = ledger;
        await timing.measure("ledgerSettlementMs", () =>
          capabilityLedger.settle({
            requestId,
            chargedMicroCents,
            refundRequest,
            result,
          }),
        );
        ledgerSettled = true;
        if (result) timing.mark("resultPersisted");
      }
      if (probe) return;
      const event: GatewayUsageEvent = {
        v: GATEWAY_USAGE_EVENT_VERSION,
        requestId,
        capabilityId: claims.jti,
        kind: claims.kind,
        ownerId: claims.sub,
        ownerGeneration: claims.gen,
        audience: claims.audience,
        agentType,
        ...(claims.turn
          ? {
              turnId: claims.turn.turnId,
              conversationId: claims.turn.conversationId,
            }
          : {}),
        provider: route.provider,
        protocol,
        requestedModel: route.requestedModel,
        resolvedModel: route.resolvedModel,
        usage: tokens,
        chargedMicroCents,
        outcome,
        ...(upstreamStatus !== undefined ? { upstreamStatus } : {}),
        startedAt,
        finishedAt: deps.now(),
        billable: true,
        networkClass,
        ...(deviceKeyHash ? { deviceKeyHash } : {}),
        ...(limitsAudience === "anonymous" && ipHash
          ? { anonymous: { ipHash } }
          : {}),
      };
      deps.waitUntil(
        env.USAGE_QUEUE.send(event).catch((error: unknown) => {
          console.error(
            `[model-gateway] trace=${traceId} usage enqueue failed: ${error instanceof Error ? error.message : "unknown"}`,
          );
        }),
      );
    };

    const controller = createUpstreamController({
      clientSignal: request.signal,
      idleTimeoutMs: GATEWAY_UPSTREAM_IDLE_TIMEOUT_MS,
      maxDurationMs: GATEWAY_UPSTREAM_MAX_DURATION_MS,
    });
    const usageParser = createRelayUsageParser(route.provider);
    const chargeFor = (usage: RelayUsage | null): number => {
      if (
        !usage ||
        (usage.inputTokens === undefined && usage.outputTokens === undefined)
      ) {
        return estimatedMicroCents;
      }
      if (usage.costMicroCents !== undefined) return usage.costMicroCents;
      return computeUsageCostMicroCents({
        model: route.resolvedModel,
        inputTokens: usage.inputTokens ?? 0,
        outputTokens: usage.outputTokens ?? 0,
        cachedInputTokens: usage.cachedInputTokens,
        cacheWriteInputTokens: usage.cacheWriteInputTokens,
        reasoningTokens: usage.reasoningTokens,
        price,
      });
    };
    const inputEstimateMicroCents = computeUsageCostMicroCents({
      model: route.resolvedModel,
      inputTokens: estimate.inputTokens,
      outputTokens: 0,
      price,
    });
    const runningCostFor = (outputTokens: number): number =>
      inputEstimateMicroCents +
      computeUsageCostMicroCents({
        model: route.resolvedModel,
        inputTokens: 0,
        outputTokens,
        price,
      });

    const abortedError = (): GatewayError => {
      switch (controller.cause()) {
        case "client":
          return new GatewayError(
            499,
            "canceled",
            "The caller canceled the request.",
          );
        case "idle":
          return new GatewayError(
            504,
            "upstream_timeout",
            "The model provider stopped sending data.",
            { retryable: true },
          );
        case "duration":
          return new GatewayError(
            504,
            "upstream_timeout",
            "The model completion exceeded the maximum duration.",
            { retryable: true },
          );
        case "budget":
          return new GatewayError(
            402,
            "budget_exhausted",
            "This capability's spending budget is exhausted.",
            quotaErrorOptions({ scope: "capability", now: deps.now() }),
          );
        default:
          return new GatewayError(
            502,
            "upstream_error",
            "The model provider connection failed.",
            { retryable: true },
          );
      }
    };

    const readUpstreamText = async (response: Response): Promise<string> => {
      if (!response.body) return "";
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      const chunks: string[] = [];
      let bytes = 0;
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) {
            timing.mark("upstreamBodyComplete");
            break;
          }
          if (value.byteLength) timing.mark("firstUpstreamByte");
          controller.touch();
          bytes += value.byteLength;
          if (bytes > MAX_UPSTREAM_STREAM_BYTES) {
            await reader.cancel("body_too_large");
            throw new GatewayError(
              502,
              "upstream_error",
              "The provider response exceeded the size limit.",
            );
          }
          chunks.push(decoder.decode(value, { stream: true }));
        }
        chunks.push(decoder.decode());
        return chunks.join("");
      } finally {
        reader.releaseLock();
      }
    };
    let upstream: Response;
    try {
      timing.mark("providerDispatch");
      // Outbound fetch already waits for these writes in a Durable Object.
      // Await that same gate explicitly so it is counted as application
      // overhead instead of being hidden inside provider time.
      if (deps.beforeProviderDispatch) {
        await timing.measure("providerOutputGateMs", deps.beforeProviderDispatch);
      }
      controller.signal.throwIfAborted();
      timing.mark("providerDispatchReady");
      upstream = await deps.fetch(target, {
        method: "POST",
        headers,
        body: upstreamBody,
        signal: controller.signal,
      });
    } catch (error) {
      controller.dispose();
      const failure = abortedError();
      console.warn(
        `[model-gateway] trace=${traceId} provider=${route.provider} upstream fetch failed cause=${controller.cause() ?? (error instanceof Error ? error.message : "unknown")}`,
      );
      const charged =
        firstUpstreamByte &&
        (failure.code === "canceled" || failure.code === "upstream_timeout")
          ? estimatedMicroCents
          : 0;
      await finish(
        failure.code === "canceled" ? "aborted" : "failed",
        usageTokens(null, estimate),
        charged,
        undefined,
        !firstUpstreamByte,
      );
      throw failure;
    }
    timing.mark("upstreamHeaders");
    controller.touch();

    if (!upstream.ok) {
      let text = "";
      try {
        text = await readUpstreamText(upstream);
      } catch {
        text = "";
      }
      controller.dispose();
      const body = upstreamErrorBody(upstream.status, text, [apiKey]);
      console.warn(
        `[model-gateway] trace=${traceId} provider=${route.provider} model=${route.resolvedModel} upstream status=${upstream.status}`,
      );
      await finish(
        "failed",
        usageTokens(null, estimate),
        0,
        upstream.status,
        true,
      );
      if (upstream.status === 401 || upstream.status === 403) {
        throw new GatewayError(
          502,
          "upstream_error",
          "The model provider refused the gateway's credentials.",
          {
            retryable: false,
            upstreamStatus: upstream.status,
          },
        );
      }
      return jsonResponse(upstream.status, body, traceId);
    }

    const assembler = assemblerFor(protocol);
    const contentType = upstream.headers.get("content-type") ?? "";
    const isJson =
      /application\/json/iu.test(contentType) &&
      !/text\/event-stream/iu.test(contentType);
    let assembled: Record<string, unknown> | null = null;
    let assemblyFailure: { message: string; detail?: unknown } | null = null;
    let budgetStop: {
      chargedMicroCents: number;
      tokens: GatewayUsageTokens;
    } | null = null;

    try {
      if (isJson) {
        const text = await readUpstreamText(upstream);
        firstUpstreamByte = text.length > 0;
        usageParser.pushText(text);
        const parsed = JSON.parse(text) as unknown;
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          assembled = parsed as Record<string, unknown>;
        } else {
          assemblyFailure = {
            message: "The model provider returned a non-object JSON body.",
          };
        }
      } else if (!upstream.body) {
        assemblyFailure = {
          message: "The model provider returned an empty stream.",
        };
      } else {
        const reader = upstream.body.getReader();
        const decoder = new TextDecoder();
        const sse = createSseParser();
        let received = 0;
        let outputTextLength = 0;
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) {
              timing.mark("upstreamBodyComplete");
              break;
            }
            if (value.byteLength > 0) {
              firstUpstreamByte = true;
              timing.mark("firstUpstreamByte");
            }
            controller.touch();
            received += value.byteLength;
            if (received > MAX_UPSTREAM_STREAM_BYTES) {
              await reader.cancel("stream_too_large");
              assemblyFailure = {
                message: "The model provider stream exceeded the size limit.",
              };
              break;
            }
            const text = decoder.decode(value, { stream: true });
            usageParser.pushText(text);
            for (const frame of sse.push(text)) {
              outputTextLength += outputTextLengthInFrame(protocol, frame);
              assembler.push(frame);
            }
            const partialUsage = usageParser.current();
            const outputTokens =
              partialUsage?.outputTokens ?? Math.ceil(outputTextLength / 4);
            const runningCost = runningCostFor(outputTokens);
            if (
              capabilityHardLimitMicroCents !== null &&
              runningCost > capabilityHardLimitMicroCents
            ) {
              await reader.cancel("budget_exhausted");
              controller.abort("budget");
              budgetStop = {
                chargedMicroCents: runningCost,
                tokens: partialUsage
                  ? usageTokens(
                      {
                        ...partialUsage,
                        inputTokens:
                          partialUsage.inputTokens ?? estimate.inputTokens,
                        outputTokens,
                      },
                      estimate,
                    )
                  : {
                      inputTokens: estimate.inputTokens,
                      outputTokens,
                      reported: false,
                    },
              };
              break;
            }
          }
        } finally {
          reader.releaseLock();
        }
        if (!budgetStop) {
          const tail = decoder.decode();
          if (tail) {
            usageParser.pushText(tail);
            for (const frame of sse.push(tail)) assembler.push(frame);
          }
          for (const frame of sse.finish()) assembler.push(frame);
          if (!assemblyFailure) {
            const outcome = assembler.finish();
            if (outcome.ok) assembled = outcome.body;
            else {
              assemblyFailure = {
                message: outcome.message,
                detail: outcome.detail,
              };
            }
          }
        }
      }
    } catch (error) {
      controller.dispose();
      const failure = abortedError();
      const usage = usageParser.finish();
      console.warn(
        `[model-gateway] trace=${traceId} provider=${route.provider} stream read failed cause=${controller.cause() ?? (error instanceof Error ? error.message : "unknown")}`,
      );
      const charged = !firstUpstreamByte
        ? 0
        : failure.code === "canceled" || failure.code === "upstream_timeout"
          ? usage
            ? chargeFor(usage)
            : estimatedMicroCents
          : usage
            ? chargeFor(usage)
            : 0;
      await finish(
        failure.code === "canceled" ? "aborted" : "failed",
        usageTokens(usage, estimate),
        charged,
        upstream.status,
        !firstUpstreamByte,
      );
      throw failure;
    }
    controller.dispose();

    if (budgetStop) {
      await finish(
        "failed",
        budgetStop.tokens,
        budgetStop.chargedMicroCents,
        upstream.status,
        false,
      );
      throw new GatewayError(
        402,
        "budget_exhausted",
        "This capability's spending budget is exhausted.",
        quotaErrorOptions({ scope: "capability", now: deps.now() }),
      );
    }

    const usage = usageParser.finish();
    if (assemblyFailure || !assembled) {
      console.warn(
        `[model-gateway] trace=${traceId} provider=${route.provider} model=${route.resolvedModel} assembly failed: ${assemblyFailure?.message ?? "unknown"} detail=${JSON.stringify(assemblyFailure?.detail ?? null).slice(0, 2_000)}`,
      );
      await finish(
        "failed",
        usageTokens(usage, estimate),
        usage ? chargeFor(usage) : 0,
        upstream.status,
        !firstUpstreamByte,
      );
      throw new GatewayError(
        502,
        "upstream_error",
        assemblyFailure?.message ??
          "The model provider stream could not be assembled.",
        { retryable: true, upstreamStatus: upstream.status },
      );
    }

    const bodyText = JSON.stringify(assembled);
    timing.mark("assemblyComplete");
    const chargedMicroCents = chargeFor(usage);
    await finish(
      "succeeded",
      usageTokens(usage, estimate),
      chargedMicroCents,
      upstream.status,
      false,
      {
        status: upstream.status,
        body: bodyText,
      },
    );
    console.log(
      `[model-gateway] trace=${traceId} agent=${agentType} requested=${route.requestedModel} resolved=${route.resolvedModel} provider=${route.provider} protocol=${protocol} status=${upstream.status} charged=${chargedMicroCents} reported=${usage ? 1 : 0} ms=${deps.now() - startedAt}`,
    );
    return new Response(bodyText, {
      status: upstream.status,
      headers: {
        "cache-control": "no-store",
        "content-type": "application/json; charset=utf-8",
        [GATEWAY_TRACE_HEADER]: traceId,
      },
    });
  } finally {
    if (ledger && ledgerReserved && !ledgerSettled) {
      const capabilityLedger = ledger;
      try {
        await timing.measure("ledgerSettlementMs", () =>
          capabilityLedger.settle({
            requestId,
            chargedMicroCents: 0,
            refundRequest: !firstUpstreamByte,
          }),
        );
      } catch (error) {
        console.error(
          `[model-gateway] trace=${traceId} ledger release failed: ${error instanceof Error ? error.message : "unknown"}`,
        );
      }
    }
    if (tierGate && tierReservation) {
      const reservation = tierReservation;
      const gate = tierGate;
      try {
        await timing.measure("tierSettlementMs", () =>
          gate.settle({
            estimateMicroCents: reservation.estimateMicroCents,
            actualMicroCents: tierActualMicroCents,
            minute: reservation.minute,
          }),
        );
      } catch (error) {
        console.error(
          `[model-gateway] trace=${traceId} tier settlement failed: ${error instanceof Error ? error.message : "unknown"}`,
        );
      }
    }
    try {
      if (ownerAdmitted)
        await timing.measure("ownerReleaseMs", () =>
          ownerGate.releaseRelay(combinedAccounting ? JSON.stringify([claims.gen, claims.jti, requestId]) : requestId),
        );
    } catch (error) {
      console.error(
        `[model-gateway] trace=${traceId} owner gate release failed: ${error instanceof Error ? error.message : "unknown"}`,
      );
    }
  }
};
