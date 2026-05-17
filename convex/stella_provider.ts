import { httpAction } from "./_generated/server";
import { internal } from "./_generated/api";
import { type ManagedModelAudience } from "./agent/model";
import {
  corsPreflightHandler,
  errorResponse,
  handleCorsRequest,
  jsonResponse,
} from "./http_shared/cors";
import { getClientAddressKey } from "./lib/http_utils";
import {
  getManagedGatewayConfig,
  type ManagedGatewayProvider,
} from "./lib/managed_gateway";
import { resolveManagedModelAccess } from "./lib/managed_billing";
import {
  STELLA_MODEL_CATALOG_UPDATED_AT,
  listStellaCatalogModels,
  listStellaDefaultSelections,
} from "./stella_models";
import {
  STELLA_MODELS_RATE_LIMIT,
  STELLA_MODELS_RATE_WINDOW_MS,
  scheduleAnonymousUsageRecord,
} from "./stella_provider/billing";
import {
  authorizeStellaRelayRequest,
  toProviderNativeModel,
} from "./stella_provider/authorization";
import { createRelayUsageParser } from "./stella_provider/relay_usage";
import {
  STELLA_ANTHROPIC_MESSAGES_PATH,
  STELLA_API_BASE_PATH,
  STELLA_FIREWORKS_RESPONSES_PATH,
  STELLA_GOOGLE_MODELS_PATH_PREFIX,
  STELLA_MODELS_PATH,
  STELLA_OPENAI_CHAT_COMPLETIONS_PATH,
  STELLA_OPENAI_RESPONSES_PATH,
  STELLA_OPENROUTER_CHAT_COMPLETIONS_PATH,
  type AuthorizedStellaRequest,
} from "./stella_provider/shared";

export {
  STELLA_ANTHROPIC_MESSAGES_PATH,
  STELLA_API_BASE_PATH,
  STELLA_FIREWORKS_RESPONSES_PATH,
  STELLA_GOOGLE_MODELS_PATH_PREFIX,
  STELLA_MODELS_PATH,
  STELLA_OPENAI_CHAT_COMPLETIONS_PATH,
  STELLA_OPENAI_RESPONSES_PATH,
  STELLA_OPENROUTER_CHAT_COMPLETIONS_PATH,
} from "./stella_provider/shared";

function stellaProviderErrorResponse(
  status: number,
  message: string,
  request: Request,
): Response {
  return errorResponse(status, message, request.headers.get("origin"));
}

export const stellaProviderModels = httpAction(async (ctx, request) =>
  handleCorsRequest(request, async (origin) => {
    const identity = await ctx.auth.getUserIdentity();

    let audience: ManagedModelAudience = identity
      ? (identity as Record<string, unknown>).isAnonymous === true
        ? "anonymous"
        : "free"
      : "anonymous";

    let shouldRateLimitModels = true;
    if (
      identity &&
      (identity as Record<string, unknown>).isAnonymous !== true
    ) {
      const access = await resolveManagedModelAccess(
        ctx,
        identity.tokenIdentifier,
      );
      audience = access.modelAudience;
      shouldRateLimitModels = !access.unlimited;
    }

    if (shouldRateLimitModels) {
      const rateLimit = await ctx.runMutation(
        internal.rate_limits.consumeWebhookRateLimit,
        {
          scope: "stella_models",
          key: identity?.tokenIdentifier ?? getClientAddressKey(request) ?? "anon",
          limit: STELLA_MODELS_RATE_LIMIT,
          windowMs: STELLA_MODELS_RATE_WINDOW_MS,
          blockMs: STELLA_MODELS_RATE_WINDOW_MS,
        },
      );
      if (!rateLimit.allowed) {
        const response = stellaProviderErrorResponse(
          429,
          "Rate limit exceeded",
          request,
        );
        response.headers.set(
          "Retry-After",
          String(Math.ceil(rateLimit.retryAfterMs / 1000)),
        );
        return response;
      }
    }

    return jsonResponse(
      {
        data: listStellaCatalogModels(audience).map((model) => ({
          id: model.id,
          name: model.name,
          provider: model.provider,
          type: model.type,
          upstreamModel: model.upstreamModel,
          allowedForAudience: model.allowedForAudience,
        })),
        defaults: listStellaDefaultSelections(audience),
        updatedAt: STELLA_MODEL_CATALOG_UPDATED_AT,
      },
      200,
      origin,
    );
  }),
);

const cloneForwardHeaders = (
  request: Request,
  provider: ManagedGatewayProvider,
  apiKey: string,
): Headers => {
  const headers = new Headers();
  for (const [key, value] of request.headers.entries()) {
    const lower = key.toLowerCase();
    if (
      lower === "authorization" ||
      lower === "x-api-key" ||
      lower === "x-goog-api-key" ||
      lower === "x-stella-relay" ||
      lower === "x-stella-agent-type" ||
      lower === "host" ||
      lower === "content-length"
    ) {
      continue;
    }
    headers.set(key, value);
  }
  headers.set("content-type", "application/json");

  if (provider === "anthropic") {
    headers.set("x-api-key", apiKey);
  } else if (provider === "google") {
    headers.set("x-goog-api-key", apiKey);
  } else {
    headers.set("authorization", `Bearer ${apiKey}`);
  }

  if (provider === "openrouter") {
    headers.set("HTTP-Referer", "https://stella.sh");
    headers.set("X-OpenRouter-Title", "Stella");
  }

  return headers;
};

const upstreamUrl = (
  provider: ManagedGatewayProvider,
  request: Request,
  upstreamModel: string,
): string => {
  const base = getManagedGatewayConfig(provider).baseURL.replace(/\/+$/u, "");
  switch (provider) {
    case "anthropic":
      return `${base}/messages`;
    case "openai":
      return new URL(request.url).pathname.endsWith("/chat/completions")
        ? `${base}/chat/completions`
        : `${base}/responses`;
    case "google": {
      // Preserve whatever verb the desktop adapter asked for —
      // `:streamGenerateContent`, `:generateContent`, `:countTokens`,
      // `:embedContent`, etc. Hardcoding stream broke non-streaming
      // utility calls.
      const verbMatch = /:([A-Za-z][A-Za-z0-9]*)$/u.exec(
        new URL(request.url).pathname,
      );
      const verb = verbMatch?.[1] ?? "streamGenerateContent";
      return `${base}/v1beta/models/${encodeURIComponent(upstreamModel)}:${verb}`;
    }
    case "fireworks":
      return `${base}/responses`;
    case "openrouter":
      return `${base}/chat/completions`;
    default: {
      const _exhaustive: never = provider;
      return _exhaustive;
    }
  }
};

const bodyForUpstream = (
  authorized: AuthorizedStellaRequest,
  provider: ManagedGatewayProvider,
  request: Request,
): string => {
  const body: Record<string, unknown> = {
    ...authorized.requestJson,
    model: toProviderNativeModel(authorized.resolvedModel, provider),
  };
  delete (body as Record<string, unknown>).agentType;
  if (provider === "google") {
    // Google REST puts the model in the URL path, not the body.
    delete body.model;
  }

  const isChatCompletions =
    provider === "openrouter" ||
    new URL(request.url).pathname.endsWith("/chat/completions");
  if (body.stream === true && isChatCompletions) {
    const streamOptions =
      body.stream_options &&
      typeof body.stream_options === "object" &&
      !Array.isArray(body.stream_options)
        ? { ...(body.stream_options as Record<string, unknown>) }
        : {};
    body.stream_options = {
      ...streamOptions,
      include_usage: true,
    };
  }

  return JSON.stringify(body);
};

export const stellaProviderRelay = (
  provider: ManagedGatewayProvider,
) => httpAction(async (ctx, request) => {
  const authorized = await authorizeStellaRelayRequest({
    ctx,
    request,
    relayProvider: provider,
  });
  if (authorized instanceof Response) {
    return authorized;
  }

  const startedAt = Date.now();
  const usageParser = createRelayUsageParser(provider);
  let upstreamResponse: Response;

  try {
    upstreamResponse = await fetch(
      upstreamUrl(provider, request, authorized.upstreamModel),
      {
        method: "POST",
        headers: cloneForwardHeaders(request, provider, authorized.apiKey),
        body: bodyForUpstream(authorized, provider, request),
      },
    );
  } catch (error) {
    console.error("[stella-provider] Relay fetch failed:", error);
    await ctx.scheduler.runAfter(0, internal.billing.logManagedUsage, {
      ownerId: authorized.ownerId,
      agentType: authorized.agentType,
      model: authorized.resolvedModel,
      durationMs: Date.now() - startedAt,
      success: false,
      inputTokens: authorized.tokenEstimate.inputTokens,
      outputTokens: authorized.tokenEstimate.outputTokens,
    });
    return stellaProviderErrorResponse(
      502,
      "Failed to reach Stella upstream gateway",
      request,
    );
  }

  const responseHeaders = new Headers(upstreamResponse.headers);
  responseHeaders.set("Access-Control-Allow-Origin", request.headers.get("origin") ?? "*");
  responseHeaders.set("Vary", "Origin");
  responseHeaders.delete("content-length");

  const decoder = new TextDecoder();
  const upstreamBody = upstreamResponse.body;
  if (!upstreamBody) {
    await ctx.scheduler.runAfter(0, internal.billing.logManagedUsage, {
      ownerId: authorized.ownerId,
      agentType: authorized.agentType,
      model: authorized.resolvedModel,
      durationMs: Date.now() - startedAt,
      success: upstreamResponse.ok,
      inputTokens: authorized.tokenEstimate.inputTokens,
      outputTokens: authorized.tokenEstimate.outputTokens,
    });
    return new Response(null, {
      status: upstreamResponse.status,
      statusText: upstreamResponse.statusText,
      headers: responseHeaders,
    });
  }

  let downstreamOpen = true;
  const stream = new ReadableStream<Uint8Array>({
    cancel() {
      downstreamOpen = false;
    },
    start(controller) {
      const reader = upstreamBody.getReader();
      void (async () => {
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            if (value) {
              usageParser.pushText(decoder.decode(value, { stream: true }));
              if (downstreamOpen) {
                try {
                  controller.enqueue(value);
                } catch {
                  downstreamOpen = false;
                }
              }
            }
          }
          usageParser.pushText(decoder.decode());
          const usage = usageParser.finish();
          const model = usage?.model || authorized.resolvedModel;
          await ctx.scheduler.runAfter(0, internal.billing.logManagedUsage, {
            ownerId: authorized.ownerId,
            agentType: authorized.agentType,
            model,
            durationMs: Date.now() - startedAt,
            success: upstreamResponse.ok,
            inputTokens:
              usage?.inputTokens ?? authorized.tokenEstimate.inputTokens,
            outputTokens:
              usage?.outputTokens ?? authorized.tokenEstimate.outputTokens,
            totalTokens: usage?.totalTokens,
            cachedInputTokens: usage?.cachedInputTokens,
            cacheWriteInputTokens: usage?.cacheWriteInputTokens,
            reasoningTokens: usage?.reasoningTokens,
          });
          await scheduleAnonymousUsageRecord(ctx, authorized.anonymousUsageRecord);
        } catch (error) {
          console.error("[stella-provider] Relay stream failed:", error);
          await ctx.scheduler.runAfter(0, internal.billing.logManagedUsage, {
            ownerId: authorized.ownerId,
            agentType: authorized.agentType,
            model: authorized.resolvedModel,
            durationMs: Date.now() - startedAt,
            success: false,
            inputTokens: authorized.tokenEstimate.inputTokens,
            outputTokens: authorized.tokenEstimate.outputTokens,
          });
        } finally {
          if (downstreamOpen) {
            try {
              controller.close();
            } catch {
              // Ignore downstream close races.
            }
          }
        }
      })();
    },
  });

  return new Response(stream, {
    status: upstreamResponse.status,
    statusText: upstreamResponse.statusText,
    headers: responseHeaders,
  });
});

export const stellaProviderOptions = httpAction(async (_ctx, request) =>
  corsPreflightHandler(request),
);
