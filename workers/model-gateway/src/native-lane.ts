import {
  GATEWAY_TRACE_HEADER,
  GATEWAY_SUBSCRIPTION_LIMIT_HEADER,
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
  type EngineAccessResponse,
  type GatewayUsageEvent,
  type GatewayUsageTokens,
} from "@stella/contracts/gateway/usage";
import { validateConnectedCloudBinding } from "@stella/model-catalog/cloud-binding";
import {
  isClaudeCloudAlias,
  resolveClaudeCloudModel,
} from "@stella/model-catalog/claude-cloud-model";
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
import { billingControl } from "./billing-control.js";
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
  access: EngineAccessResponse;
  validUntil: number;
};
const engineAccessCache = new Map<string, EngineAccessEntry>();

export const resetEngineAccessCacheForTests = (): void => {
  engineAccessCache.clear();
};

const engineAccessKey = (
  claims: GatewayCapabilityClaims,
  provider: GatewayNativeCredentialProvider,
): string => `${claims.sub}|${claims.gen}|${provider}`;

/** Error bodies read to classify a limit; larger ones are passed through unread. */
const MAX_LIMIT_BODY_BYTES = 64 * 1024;

/**
 * A subscription-limit rejection (Claude's 5-hour/weekly window, ChatGPT's
 * Codex usage limit), as opposed to an ordinary rate limit that clears in
 * seconds. Returns when the provider says it resets, if it said.
 */
export const subscriptionLimitOf = (
  provider: GatewayNativeCredentialProvider,
  status: number,
  headers: Headers,
  bodyText: string,
  now: number,
): { resetsAt?: number } | null => {
  if (status !== 429 && status !== 403) return null;
  let error: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(bodyText) as {
      error?: unknown;
      detail?: unknown;
    };
    const candidate = parsed.error ?? parsed.detail;
    if (candidate && typeof candidate === "object") {
      error = candidate as Record<string, unknown>;
    }
  } catch {
    // Not JSON; headers alone decide.
  }
  const epochSeconds = (value: unknown): number | undefined => {
    const seconds = typeof value === "string" ? Number(value) : value;
    return typeof seconds === "number" &&
      Number.isFinite(seconds) &&
      seconds > 0
      ? seconds * 1000
      : undefined;
  };
  if (provider === "anthropic") {
    const unified = headers.get("anthropic-ratelimit-unified-status");
    const message = typeof error.message === "string" ? error.message : "";
    if (status !== 429) return null;
    if (unified !== "rejected" && !/usage limit/iu.test(message)) return null;
    const resetsAt = epochSeconds(
      headers.get("anthropic-ratelimit-unified-reset"),
    );
    return resetsAt && resetsAt > now ? { resetsAt } : {};
  }
  const code = [error.code, error.type]
    .filter((value): value is string => typeof value === "string")
    .join(" ");
  if (/usage_not_included/u.test(code)) {
    // The plan has no Codex access at all; check again tomorrow.
    return { resetsAt: now + 24 * 60 * 60_000 };
  }
  if (!/usage_limit_reached/u.test(code)) return null;
  const resetsAt =
    epochSeconds(error.resets_at) ??
    (typeof error.resets_in_seconds === "number" && error.resets_in_seconds > 0
      ? now + error.resets_in_seconds * 1000
      : undefined);
  return resetsAt && resetsAt > now ? { resetsAt } : {};
};

const readBoundedText = async (response: Response): Promise<string | null> => {
  const declared = Number(response.headers.get("content-length") ?? "0");
  if (declared > MAX_LIMIT_BODY_BYTES) return null;
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > MAX_LIMIT_BODY_BYTES) return null;
  return new TextDecoder().decode(bytes);
};

const engineAccessFor = async (
  env: Pick<Env, "BILLING">,
  claims: GatewayCapabilityClaims,
  provider: GatewayNativeCredentialProvider,
  now: number,
): Promise<EngineAccessResponse> => {
  const key = engineAccessKey(claims, provider);
  const hit = engineAccessCache.get(key);
  if (hit && hit.validUntil > now) return hit.access;
  // BillingControl reports refusals as data; a throw is a transport failure.
  const result = await billingControl(env)
    .engineAccess({
      ownerId: claims.sub,
      ownerGeneration: claims.gen,
      provider,
    })
    .catch(() => ({
      ok: false as const,
      status: null,
      code: null,
      retryable: true,
    }));
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
  traceId: string;
  auth: AuthenticatedCapability;
}): Promise<Response> => {
  const { request, env, deps, traceId } = args;
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

  let requestJson = await readJsonObject(request);
  let requestedModel =
    typeof requestJson.model === "string" ? requestJson.model.trim() : "";
  if (!requestedModel) {
    throw new GatewayError(
      400,
      "bad_request",
      "The request body must name a model.",
    );
  }
  // Existing mobile/cloud builds can still send CLI aliases and infer legacy
  // thinking capabilities from them. Resolve before binding validation, using
  // the signed turn's effort so this never grants a more powerful request.
  const nativeSelection = requestedModel.replace(/^stella\/anthropic\//u, "");
  if (credential === "anthropic" && isClaudeCloudAlias(nativeSelection)) {
    requestedModel = resolveClaudeCloudModel(nativeSelection);
    requestJson = { ...requestJson, model: requestedModel };
    if (pathname.endsWith("/messages")) {
      const effort = turn.execution.reasoningEffort;
      const config = requestJson.output_config;
      const outputConfig =
        config && typeof config === "object" && !Array.isArray(config)
          ? { ...(config as Record<string, unknown>) }
          : {};
      delete outputConfig.effort;
      delete requestJson.thinking;
      if (effort === "none") {
        if (!requestedModel.includes("-fable-"))
          requestJson.thinking = { type: "disabled" };
      } else if (effort !== "default") {
        const adaptive = !requestedModel.includes("-haiku-");
        if (adaptive) {
          requestJson.thinking = { type: "adaptive" };
          outputConfig.effort = effort === "minimal" ? "low" : effort;
        } else {
          const budget = {
            minimal: 1024,
            low: 2048,
            medium: 8192,
            high: 16384,
            xhigh: 16384,
          }[effort];
          requestJson.thinking = { type: "enabled", budget_tokens: budget };
          requestJson.max_tokens = Math.max(
            Number(requestJson.max_tokens) || 0,
            budget + 1024,
          );
        }
      }
      if (Object.keys(outputConfig).length)
        requestJson.output_config = outputConfig;
      else delete requestJson.output_config;
      // The latest Opus, Sonnet and Fable models reject temperature.
      if (!requestedModel.includes("-haiku-")) delete requestJson.temperature;
    }
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

  let access = await engineAccessFor(env, claims, credential, deps.now());
  const credentialFor = (
    current: EngineAccessResponse,
  ): NativeRelayCredential => ({
    provider: credential,
    accessToken: current.accessToken,
    ...(current.accountId ? { accountId: current.accountId } : {}),
    // The cloud runtime carries a Stella capability, so its SDK cannot
    // recognize the subscription token and add the required identity itself.
    injectClaudeCodeIdentity: credential === "anthropic",
  });
  let userCredential = credentialFor(access);
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
  const forwardHeaders = (current: NativeRelayCredential): Headers => {
    try {
      return connectedCredentialForwardHeaders(request, current);
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
  };
  let headers = forwardHeaders(userCredential);
  if (credential === "anthropic" && nativeSelection.endsWith("[1m]")) {
    headers.set(
      "anthropic-beta",
      `${headers.get("anthropic-beta")},context-1m-2025-08-07`,
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
  let subscriptionLimitReached = false;
  try {
    upstream = await deps.fetch(target, {
      method: "POST",
      headers,
      body,
      signal: controller.signal,
    });
    // At 100% of a subscription window: cool that account down and, when
    // auto-switch moved the provider to another account, send the same
    // request once more on it. Anything else passes through untouched.
    if (!upstream.ok && !probe && access.engineAccountId) {
      const errorText = await readBoundedText(upstream.clone()).catch(
        () => null,
      );
      const limit =
        errorText === null
          ? null
          : subscriptionLimitOf(
              credential,
              upstream.status,
              upstream.headers,
              errorText,
              deps.now(),
            );
      if (limit) {
        subscriptionLimitReached = true;
        engineAccessCache.delete(engineAccessKey(claims, credential));
        const report = await billingControl(env)
          .engineLimit({
            ownerId: claims.sub,
            ownerGeneration: claims.gen,
            provider: credential,
            engineAccountId: access.engineAccountId,
            ...(limit.resetsAt !== undefined
              ? { resetsAt: limit.resetsAt }
              : {}),
          })
          .catch(() => null);
        console.log(
          `[model-gateway] trace=${traceId} native=${credential} subscription limit reached switched=${report?.ok ? report.body.switched : "unknown"}`,
        );
        if (report?.ok && report.body.switched) {
          const next = await engineAccessFor(
            env,
            claims,
            credential,
            deps.now(),
          ).catch(() => null);
          if (next && next.engineAccountId !== access.engineAccountId) {
            await upstream.body?.cancel().catch(() => undefined);
            access = next;
            userCredential = credentialFor(access);
            headers = forwardHeaders(userCredential);
            upstream = await deps.fetch(target, {
              method: "POST",
              headers,
              body,
              signal: controller.signal,
            });
            const retryError = upstream.ok
              ? null
              : await readBoundedText(upstream.clone()).catch(() => null);
            subscriptionLimitReached =
              retryError !== null &&
              subscriptionLimitOf(
                credential,
                upstream.status,
                upstream.headers,
                retryError,
                deps.now(),
              ) !== null;
          }
        }
      }
    }
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
  if (subscriptionLimitReached) {
    responseHeaders.set(GATEWAY_SUBSCRIPTION_LIMIT_HEADER, credential);
  }
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
