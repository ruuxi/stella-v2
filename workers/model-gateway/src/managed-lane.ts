import {
  GATEWAY_TRACE_HEADER,
  GATEWAY_UPSTREAM_IDLE_TIMEOUT_MS,
  GATEWAY_UPSTREAM_MAX_DURATION_MS,
  type GatewayProtocol,
} from "@stella/contracts/gateway/api";
import {
  GATEWAY_USAGE_EVENT_VERSION,
  type GatewayUsageEvent,
  type GatewayUsageOutcome,
  type GatewayUsageTokens,
} from "@stella/contracts/gateway/usage";
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
import { createSseParser } from "./assemble/sse.js";
import type { Assembler } from "./assemble/types.js";
import type { AuthenticatedCapability } from "./capability.js";
import { getGatewayConfig } from "./config-cache.js";
import type { ConvexClient } from "./convex-client.js";
import { GatewayError, jsonResponse, upstreamErrorBody } from "./errors.js";
import type { LedgerSettleArgs } from "./ledger.js";
import {
  agentTypeFrom,
  clientIp,
  createUpstreamController,
  readJsonObject,
  requestIdFrom,
  sha256Hex,
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
      requestJson: streamingRequestJson(args.requestJson, args.protocol),
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

export const handleManagedRelay = async (args: {
  request: Request;
  env: Env;
  deps: GatewayDeps;
  convex: ConvexClient;
  traceId: string;
  auth: AuthenticatedCapability;
  protocol: GatewayProtocol;
}): Promise<Response> => {
  const { request, env, deps, convex, traceId, protocol } = args;
  const { claims, probe } = args.auth;
  const startedAt = deps.now();
  const pathname = new URL(request.url).pathname;

  const agentType = agentTypeFrom(request);
  if (!agentType) {
    throw new GatewayError(
      400,
      "bad_request",
      "The x-stella-agent-type header is required.",
    );
  }
  assertAgentTypeAllowed(claims, agentType);

  const requestJson = await readJsonObject(request);
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

  let ipHash: string | undefined;
  if (claims.audience === "anonymous" && !probe) {
    const ip = clientIp(request);
    const outcome = await env.ANON_IP_LIMITER.limit({ key: ip });
    if (!outcome.success) {
      throw new GatewayError(
        429,
        "rate_limited",
        "Too many anonymous requests from this network.",
        {
          retryable: true,
          headers: { "retry-after": "60" },
        },
      );
    }
    ipHash = (await sha256Hex(ip)).slice(0, 32);
  }

  const config = await getGatewayConfig(convex, deps.waitUntil, deps.now);
  const price = config.priceFor(route.resolvedModel);
  if (!price) {
    throw new GatewayError(
      500,
      "internal",
      `Model "${route.resolvedModel}" has no price.`,
    );
  }
  const estimate = estimateRequestTokens(requestJson);
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

  const { requestId } = requestIdFrom(request);
  const ledger = probe
    ? null
    : env.CAPABILITY_LEDGER.get(env.CAPABILITY_LEDGER.idFromName(claims.jti));
  if (ledger) {
    const reservation = await ledger.reserve({
      jti: claims.jti,
      budgetMicroCents: claims.budgetMicroCents,
      maxRequests: claims.maxRequests,
      expiresAt: claims.exp * 1000,
      requestId,
      estimatedMicroCents,
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
        );
      case "request_limit":
        throw new GatewayError(
          429,
          "request_limit",
          `This capability's request limit (${reservation.maxRequests}) has been reached.`,
        );
      case "reserved":
        break;
    }
  }

  const finish = async (
    outcome: GatewayUsageOutcome,
    tokens: GatewayUsageTokens,
    chargedMicroCents: number,
    upstreamStatus: number | undefined,
    result?: LedgerSettleArgs["result"],
  ): Promise<void> => {
    if (ledger) {
      await ledger.settle({ requestId, chargedMicroCents, result });
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
      ...(ipHash ? { anonymous: { ipHash } } : {}),
    };
    deps.waitUntil(
      env.USAGE_QUEUE.send(event).catch((error: unknown) => {
        console.error(
          `[model-gateway] trace=${traceId} usage enqueue failed: ${error instanceof Error ? error.message : "unknown"}`,
        );
      }),
    );
  };

  const gatewayConfig = getManagedGatewayConfig(route.provider);
  const apiKey = resolveManagedGatewayApiKeyFromEnv(
    gatewayConfig,
    env as unknown as Readonly<Record<string, string | undefined>>,
  );
  if (!apiKey) {
    await finish("failed", usageTokens(null, estimate), 0, undefined);
    throw new GatewayError(
      503,
      "internal",
      "The model provider is not configured.",
      {
        retryable: true,
      },
    );
  }

  const {
    url: target,
    headers,
    body: upstreamBody,
  } = shapeUpstreamRequest({ request, protocol, route, requestJson, apiKey });

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
          {
            retryable: true,
          },
        );
      case "duration":
        return new GatewayError(
          504,
          "upstream_timeout",
          "The model completion exceeded the maximum duration.",
          {
            retryable: true,
          },
        );
      default:
        return new GatewayError(
          502,
          "upstream_error",
          "The model provider connection failed.",
          {
            retryable: true,
          },
        );
    }
  };

  let upstream: Response;
  try {
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
    await finish(
      failure.code === "canceled" ? "aborted" : "failed",
      usageTokens(null, estimate),
      failure.code === "canceled" || failure.code === "upstream_timeout"
        ? estimatedMicroCents
        : 0,
      undefined,
    );
    throw failure;
  }
  controller.touch();

  if (!upstream.ok) {
    let text = "";
    try {
      text = await upstream.text();
    } catch {
      text = "";
    }
    controller.dispose();
    const body = upstreamErrorBody(upstream.status, text, [apiKey]);
    console.warn(
      `[model-gateway] trace=${traceId} provider=${route.provider} model=${route.resolvedModel} upstream status=${upstream.status}`,
    );
    await finish("failed", usageTokens(null, estimate), 0, upstream.status);
    // A provider 401/403 is OUR credential problem, never the caller's; on this
    // surface those statuses mean "your capability is bad", so translate.
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

  try {
    if (isJson) {
      const text = await upstream.text();
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
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
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
        for (const frame of sse.push(text)) assembler.push(frame);
      }
      const tail = decoder.decode();
      if (tail) {
        usageParser.pushText(tail);
        for (const frame of sse.push(tail)) assembler.push(frame);
      }
      for (const frame of sse.finish()) assembler.push(frame);
      if (!assemblyFailure) {
        const outcome = assembler.finish();
        if (outcome.ok) assembled = outcome.body;
        else
          assemblyFailure = {
            message: outcome.message,
            detail: outcome.detail,
          };
      }
    }
  } catch (error) {
    controller.dispose();
    const failure = abortedError();
    const usage = usageParser.finish();
    console.warn(
      `[model-gateway] trace=${traceId} provider=${route.provider} stream read failed cause=${controller.cause() ?? (error instanceof Error ? error.message : "unknown")}`,
    );
    const charged =
      failure.code === "canceled" || failure.code === "upstream_timeout"
        ? estimatedMicroCents
        : usage
          ? chargeFor(usage)
          : 0;
    await finish(
      failure.code === "canceled" ? "aborted" : "failed",
      usageTokens(usage, estimate),
      charged,
      upstream.status,
    );
    throw failure;
  }
  controller.dispose();

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
  const chargedMicroCents = chargeFor(usage);
  await finish(
    "succeeded",
    usageTokens(usage, estimate),
    chargedMicroCents,
    upstream.status,
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
};
