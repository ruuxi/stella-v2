import {
  GATEWAY_TRACE_HEADER,
  GATEWAY_UPSTREAM_MAX_DURATION_MS,
  type GatewayProtocol,
  type GatewayProvider,
} from "@stella/contracts/gateway/api";
import type {
  GatewayCapabilityClaims,
  GatewayNativeCredentialProvider,
} from "@stella/contracts/gateway/capability";
import {
  GATEWAY_USAGE_EVENT_VERSION,
  type ConvexEngineAccessResponse,
  type GatewayUsageEvent,
  type GatewayUsageTokens,
} from "@stella/contracts/gateway/usage";
import { validateConnectedCloudBinding } from "@stella/model-catalog/cloud-binding";
import { getManagedGatewayConfig } from "@stella/model-catalog/managed-gateway";
import {
  connectedCredentialForwardHeaders,
  connectedCredentialUpstreamUrl,
  nativeCredentialBody,
  type NativeRelayCredential,
} from "@stella/model-catalog/native-relay";
import { createRelayUsageParser } from "@stella/model-catalog/usage";
import {
  verifySessionDpop,
  type AuthenticatedCapability,
} from "./capability.js";
import type { ConvexClient } from "./convex-client.js";
import { GatewayError } from "./errors.js";
import {
  agentTypeFrom,
  createUpstreamController,
  readJsonObject,
  requestIdFrom,
  type GatewayDeps,
} from "./request-util.js";
import { assertAgentTypeAllowed } from "./resolve.js";

/**
 * Native lane: the owner's connected subscription (Claude Code / Codex CLI).
 *
 * A byte pipe. The request goes upstream untouched apart from credentials and
 * the model pin the turn was admitted with; the response comes back untouched
 * (SSE or JSON) with the upstream status. Nothing here is billed to Stella —
 * the usage event is `billable: false` and usage is parsed only when the
 * response was JSON, best-effort, off the response path.
 */
export const ENGINE_ACCESS_MAX_CACHE_MS = 5 * 60_000;
export const ENGINE_ACCESS_EXPIRY_MARGIN_MS = 60_000;
/** JSON responses larger than this are not parsed for usage. */
const MAX_USAGE_PARSE_BYTES = 4 * 1024 * 1024;

type EngineAccessEntry = {
  access: ConvexEngineAccessResponse;
  validUntil: number;
};
const engineAccessCache = new Map<string, EngineAccessEntry>();

export const resetEngineAccessCacheForTests = (): void => {
  engineAccessCache.clear();
};

const engineAccessFor = async (
  convex: ConvexClient,
  claims: GatewayCapabilityClaims,
  provider: GatewayNativeCredentialProvider,
  now: number,
): Promise<ConvexEngineAccessResponse> => {
  const key = `${claims.sub}|${claims.gen}|${provider}`;
  const hit = engineAccessCache.get(key);
  if (hit && hit.validUntil > now) return hit.access;
  const result = await convex.engineAccess({
    ownerId: claims.sub,
    ownerGeneration: claims.gen,
    provider,
  });
  if (!result.ok) {
    if (result.code) {
      throw new GatewayError(
        result.code === "generation_stale" ? 403 : (result.status ?? 503),
        result.code,
        result.code === "generation_stale"
          ? "This capability belongs to a superseded account generation."
          : "Connected engine access was refused.",
        { retryable: result.retryable },
      );
    }
    if (result.retryable || result.status === null) {
      throw new GatewayError(
        503,
        "internal",
        "Connected engine access is temporarily unavailable.",
        {
          retryable: true,
        },
      );
    }
    throw new GatewayError(
      403,
      "unauthorized",
      "Connected engine access is unavailable for this account.",
    );
  }
  const access = result.body;
  if (
    !access ||
    typeof access.accessToken !== "string" ||
    !access.accessToken ||
    typeof access.expiresAt !== "number"
  ) {
    throw new GatewayError(
      503,
      "internal",
      "Connected engine access is temporarily unavailable.",
      {
        retryable: true,
      },
    );
  }
  const validUntil = Math.min(
    access.expiresAt - ENGINE_ACCESS_EXPIRY_MARGIN_MS,
    now + ENGINE_ACCESS_MAX_CACHE_MS,
  );
  if (validUntil > now) engineAccessCache.set(key, { access, validUntil });
  return access;
};

const RESPONSE_HEADER_ALLOWLIST = [
  "content-type",
  "retry-after",
  "request-id",
  "x-request-id",
  "anthropic-request-id",
  "openai-processing-ms",
] as const;

export const handleNativeRelay = async (args: {
  request: Request;
  env: Env;
  deps: GatewayDeps;
  convex: ConvexClient;
  traceId: string;
  auth: AuthenticatedCapability;
}): Promise<Response> => {
  const { request, env, deps, convex, traceId } = args;
  const { claims, probe } = args.auth;
  const credential = claims.credential;
  if (!credential)
    throw new GatewayError(
      500,
      "internal",
      "Native lane entered without a credential.",
    );
  const startedAt = deps.now();
  const pathname = new URL(request.url).pathname;
  const deviceKeyHash = await verifySessionDpop({
    request,
    auth: args.auth,
    now: deps.now(),
  });

  const turn = claims.turn;
  if (!turn) {
    throw new GatewayError(
      403,
      "execution_mismatch",
      "The native lane requires a turn-bound capability.",
    );
  }
  if (turn.execution.engine !== credential) {
    throw new GatewayError(
      403,
      "execution_mismatch",
      `This turn was admitted for engine "${turn.execution.engine}", not "${credential}".`,
    );
  }
  const agentType =
    agentTypeFrom(request) ?? claims.agentTypes?.[0] ?? "general";
  assertAgentTypeAllowed(claims, agentType);

  const requestJson = await readJsonObject(request);
  const requestedModel =
    typeof requestJson.model === "string" ? requestJson.model.trim() : "";
  if (!requestedModel) {
    throw new GatewayError(
      400,
      "bad_request",
      "The request body must name a model.",
    );
  }
  const binding = validateConnectedCloudBinding({
    execution: turn.execution,
    credentialProvider: credential,
    requestedModel,
    requestPathname: pathname,
    requestJson,
    anthropicBeta: request.headers.get("anthropic-beta") ?? undefined,
  });
  if (!binding.ok) {
    throw new GatewayError(
      binding.error.status,
      binding.error.status === 403 ? "execution_mismatch" : "bad_request",
      binding.error.message,
    );
  }

  const access = await engineAccessFor(convex, claims, credential, deps.now());
  const userCredential: NativeRelayCredential = {
    provider: credential,
    accessToken: access.accessToken,
    ...(access.accountId ? { accountId: access.accountId } : {}),
    injectClaudeCodeIdentity:
      credential === "anthropic" &&
      requestedModel.startsWith("stella/anthropic/"),
  };
  const target = connectedCredentialUpstreamUrl(
    { userCredential },
    request,
    getManagedGatewayConfig("anthropic").baseURL,
  );
  if (!target) {
    throw new GatewayError(
      400,
      "bad_request",
      "This path is not served on the native lane.",
    );
  }
  let headers: Headers;
  try {
    headers = connectedCredentialForwardHeaders(request, userCredential);
  } catch {
    throw new GatewayError(
      503,
      "internal",
      "Connected engine access is incomplete for this account.",
      {
        retryable: true,
      },
    );
  }
  const body = nativeCredentialBody({
    requestJson,
    upstreamModel: binding.nativeModel,
    userCredential,
  });

  const provider: GatewayProvider =
    credential === "anthropic" ? "anthropic" : "openai";
  const protocol: GatewayProtocol =
    credential === "anthropic" ? "anthropic-messages" : "openai-responses";
  const { requestId } = requestIdFrom(request);

  const enqueue = (
    outcome: GatewayUsageEvent["outcome"],
    usage: GatewayUsageTokens,
    upstreamStatus: number | undefined,
  ): void => {
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
      turnId: turn.turnId,
      conversationId: turn.conversationId,
      provider,
      protocol,
      requestedModel,
      resolvedModel: binding.nativeModel,
      usage,
      chargedMicroCents: 0,
      outcome,
      ...(upstreamStatus !== undefined ? { upstreamStatus } : {}),
      startedAt,
      finishedAt: deps.now(),
      billable: false,
      ...(deviceKeyHash ? { deviceKeyHash } : {}),
    };
    deps.waitUntil(
      env.USAGE_QUEUE.send(event).catch((error: unknown) => {
        console.error(
          `[model-gateway] trace=${traceId} usage enqueue failed: ${error instanceof Error ? error.message : "unknown"}`,
        );
      }),
    );
  };
  const unreported: GatewayUsageTokens = {
    inputTokens: 0,
    outputTokens: 0,
    reported: false,
  };

  const controller = createUpstreamController({
    clientSignal: request.signal,
    idleTimeoutMs: GATEWAY_UPSTREAM_MAX_DURATION_MS,
    maxDurationMs: GATEWAY_UPSTREAM_MAX_DURATION_MS,
  });
  let upstream: Response;
  try {
    upstream = await deps.fetch(target, {
      method: "POST",
      headers,
      body,
      signal: controller.signal,
    });
  } catch (error) {
    controller.dispose();
    const cause = controller.cause();
    enqueue(cause === "client" ? "aborted" : "failed", unreported, undefined);
    if (cause === "client") {
      throw new GatewayError(
        499,
        "canceled",
        "The caller canceled the request.",
      );
    }
    console.warn(
      `[model-gateway] trace=${traceId} native=${credential} upstream fetch failed: ${error instanceof Error ? error.message : "unknown"}`,
    );
    throw new GatewayError(
      cause ? 504 : 502,
      cause ? "upstream_timeout" : "upstream_error",
      "The connected engine could not be reached.",
      { retryable: true },
    );
  }

  const responseHeaders = new Headers({
    "cache-control": "no-store",
    [GATEWAY_TRACE_HEADER]: traceId,
  });
  for (const name of RESPONSE_HEADER_ALLOWLIST) {
    const value = upstream.headers.get(name);
    if (value) responseHeaders.set(name, value);
  }
  const contentType = upstream.headers.get("content-type") ?? "";
  const outcome = upstream.ok ? "succeeded" : "failed";
  const isJson =
    /application\/json/iu.test(contentType) &&
    !/text\/event-stream/iu.test(contentType);

  let responseBody: ReadableStream<Uint8Array> | null = upstream.body;
  if (isJson && upstream.body && upstream.ok) {
    const [toClient, toMeter] = upstream.body.tee();
    responseBody = toClient;
    deps.waitUntil(
      (async () => {
        const parser = createRelayUsageParser(provider);
        const reader = toMeter.getReader();
        const decoder = new TextDecoder();
        let received = 0;
        let overflow = false;
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          received += value.byteLength;
          if (received > MAX_USAGE_PARSE_BYTES) {
            overflow = true;
            await reader.cancel("usage_parse_limit");
            break;
          }
          parser.pushText(decoder.decode(value, { stream: true }));
        }
        parser.pushText(decoder.decode());
        const usage = overflow ? null : parser.finish();
        enqueue(
          outcome,
          usage &&
            (usage.inputTokens !== undefined ||
              usage.outputTokens !== undefined)
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
                reported: true,
              }
            : unreported,
          upstream.status,
        );
        controller.dispose();
      })().catch((error: unknown) => {
        controller.dispose();
        console.warn(
          `[model-gateway] trace=${traceId} native usage parse failed: ${error instanceof Error ? error.message : "unknown"}`,
        );
      }),
    );
  } else {
    enqueue(outcome, unreported, upstream.status);
    // The pipe outlives this handler. The controller stays wired to the
    // client's abort (which cancels the upstream fetch) and releases its
    // timers on its own when the body ends or the ceiling fires.
    if (upstream.body) {
      responseBody = upstream.body.pipeThrough(
        new TransformStream<Uint8Array, Uint8Array>({
          flush() {
            controller.dispose();
          },
        }),
      );
    } else {
      controller.dispose();
    }
  }

  console.log(
    `[model-gateway] trace=${traceId} native=${credential} agent=${agentType} model=${binding.nativeModel} kind=${binding.requestKind} status=${upstream.status} ms=${deps.now() - startedAt}`,
  );
  return new Response(responseBody, {
    status: upstream.status,
    headers: responseHeaders,
  });
};
