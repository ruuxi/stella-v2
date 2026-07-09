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
import { computeUsageCostMicroCents } from "./lib/billing_money";
import {
  STELLA_MODEL_CATALOG_UPDATED_AT,
  listStellaCatalogModels,
  listStellaDefaultSelections,
} from "./stella_models";
import {
  STELLA_MODELS_RATE_LIMIT,
  STELLA_MODELS_RATE_WINDOW_MS,
} from "./stella_provider/billing";
import {
  authorizeStellaRelayRequest,
  toProviderNativeModel,
} from "./stella_provider/authorization";
import { downgradeUnsupportedRequestImages } from "./stella_provider/request";
import { createRelayUsageParser } from "./stella_provider/relay_usage";
import {
  STELLA_ANTHROPIC_MESSAGES_PATH,
  STELLA_API_BASE_PATH,
  STELLA_FIREWORKS_RESPONSES_PATH,
  STELLA_GOOGLE_MODELS_PATH_PREFIX,
  STELLA_MODELS_PATH,
  STELLA_OPENAI_CHAT_COMPLETIONS_PATH,
  STELLA_OPENAI_RESPONSES_PATH,
  STELLA_META_CHAT_COMPLETIONS_PATH,
  STELLA_META_RESPONSES_PATH,
  STELLA_OPENROUTER_CHAT_COMPLETIONS_PATH,
  STELLA_RELAY_PATH_PREFIX,
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
  STELLA_META_CHAT_COMPLETIONS_PATH,
  STELLA_META_RESPONSES_PATH,
  STELLA_OPENROUTER_CHAT_COMPLETIONS_PATH,
  STELLA_RELAY_PATH_PREFIX,
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
  request.headers.forEach((value, key) => {
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
      return;
    }
    headers.set(key, value);
  });
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

export const upstreamUrl = (
  provider: ManagedGatewayProvider,
  request: Request,
  upstreamModel: string,
): string => {
  const base = getManagedGatewayConfig(provider).baseURL.replace(/\/+$/u, "");
  const requestUrl = new URL(request.url);
  switch (provider) {
    case "anthropic":
      return `${base}/messages`;
    case "openai":
      return requestUrl.pathname.endsWith("/chat/completions")
        ? `${base}/chat/completions`
        : `${base}/responses`;
    case "google": {
      // Preserve whatever verb the desktop adapter asked for —
      // `:streamGenerateContent`, `:generateContent`, `:countTokens`,
      // `:embedContent`, etc. Hardcoding stream broke non-streaming
      // utility calls.
      const verbMatch = /:([A-Za-z][A-Za-z0-9]*)$/u.exec(
        requestUrl.pathname,
      );
      const verb = verbMatch?.[1] ?? "streamGenerateContent";
      return `${base}/v1beta/models/${encodeURIComponent(upstreamModel)}:${verb}${requestUrl.search}`;
    }
    case "fireworks":
      return `${base}/responses`;
    case "openrouter":
      return `${base}/chat/completions`;
    case "meta":
      // Meta Model API is OpenAI-compatible. Prefer chat/completions when the
      // client asked for it; otherwise use Responses (Meta's agentic default).
      return requestUrl.pathname.endsWith("/chat/completions")
        ? `${base}/chat/completions`
        : `${base}/responses`;
    default: {
      const _exhaustive: never = provider;
      return _exhaustive;
    }
  }
};

const isResponsesRequest = (
  provider: ManagedGatewayProvider,
  request: Request,
): boolean => {
  if (
    provider !== "openai" &&
    provider !== "fireworks" &&
    provider !== "meta"
  ) {
    return false;
  }
  return !new URL(request.url).pathname.endsWith("/chat/completions");
};

const normalizeResponsesContentPart = (
  part: unknown,
): Record<string, unknown> | unknown => {
  if (!part || typeof part !== "object" || Array.isArray(part)) {
    return part;
  }
  const record = part as Record<string, unknown>;
  if (record.type === "text") {
    return { ...record, type: "input_text" };
  }
  if (record.type === "image_url") {
    const imageUrl = record.image_url;
    const url =
      typeof imageUrl === "string"
        ? imageUrl
        : imageUrl &&
            typeof imageUrl === "object" &&
            typeof (imageUrl as Record<string, unknown>).url === "string"
          ? (imageUrl as Record<string, string>).url
          : undefined;
    return url
      ? { type: "input_image", image_url: url, detail: record.detail ?? "auto" }
      : part;
  }
  return part;
};

const messagesToResponsesInput = (messages: unknown): unknown => {
  if (!Array.isArray(messages)) return messages;
  return messages.map((message) => {
    if (!message || typeof message !== "object" || Array.isArray(message)) {
      return message;
    }
    const record = message as Record<string, unknown>;
    const content = record.content;
    if (Array.isArray(content)) {
      return {
        ...record,
        content: content.map(normalizeResponsesContentPart),
      };
    }
    return record;
  });
};

const normalizeResponsesBody = (body: Record<string, unknown>): void => {
  if (body.input === undefined && body.messages !== undefined) {
    body.input = messagesToResponsesInput(body.messages);
  }
  if (body.response_format !== undefined) {
    const existingText =
      body.text && typeof body.text === "object" && !Array.isArray(body.text)
        ? (body.text as Record<string, unknown>)
        : {};
    body.text = { ...existingText, format: body.response_format };
  }
  if (body.max_output_tokens === undefined) {
    if (body.max_tokens !== undefined) {
      body.max_output_tokens = body.max_tokens;
    } else if (body.max_completion_tokens !== undefined) {
      body.max_output_tokens = body.max_completion_tokens;
    }
  }
  delete body.messages;
  delete body.max_tokens;
  delete body.max_completion_tokens;
  delete body.response_format;
  delete body.stream_options;
};

const normalizeChatContentPart = (
  part: unknown,
): Record<string, unknown> | unknown => {
  if (!part || typeof part !== "object" || Array.isArray(part)) {
    return part;
  }
  const record = part as Record<string, unknown>;
  if (
    record.type === "input_text" ||
    record.type === "output_text" ||
    record.type === "text"
  ) {
    return { type: "text", text: record.text };
  }
  if (record.type === "input_image" || record.type === "image_url") {
    const imageUrl = record.image_url;
    return {
      type: "image_url",
      image_url:
        typeof imageUrl === "string"
          ? { url: imageUrl }
          : imageUrl,
    };
  }
  return part;
};

const normalizeChatContent = (content: unknown): unknown => {
  if (!Array.isArray(content)) return content;
  return content.map(normalizeChatContentPart);
};

const responsesInputToChatMessages = (input: unknown): unknown => {
  if (!Array.isArray(input)) return input;
  return input.flatMap((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      return [];
    }
    const record = item as Record<string, unknown>;
    if (typeof record.role === "string") {
      return [
        {
          role: record.role,
          content: normalizeChatContent(record.content),
        },
      ];
    }
    if (record.type === "message") {
      return [
        {
          role: typeof record.role === "string" ? record.role : "assistant",
          content: normalizeChatContent(record.content),
        },
      ];
    }
    if (record.type === "function_call") {
      const callId =
        typeof record.call_id === "string"
          ? record.call_id
          : typeof record.id === "string"
            ? record.id
            : "";
      return [
        {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: callId,
              type: "function",
              function: {
                name: record.name,
                arguments:
                  typeof record.arguments === "string"
                    ? record.arguments
                    : JSON.stringify(record.arguments ?? {}),
              },
            },
          ],
        },
      ];
    }
    if (record.type === "function_call_output") {
      return [
        {
          role: "tool",
          tool_call_id: record.call_id,
          content:
            typeof record.output === "string"
              ? record.output
              : JSON.stringify(record.output ?? ""),
        },
      ];
    }
    return [];
  });
};

const normalizeChatTools = (tools: unknown): unknown => {
  if (!Array.isArray(tools)) return tools;
  return tools.map((tool) => {
    if (!tool || typeof tool !== "object" || Array.isArray(tool)) {
      return tool;
    }
    const record = tool as Record<string, unknown>;
    if (
      record.type === "function" &&
      typeof record.name === "string" &&
      record.function === undefined
    ) {
      return {
        type: "function",
        function: {
          name: record.name,
          description: record.description,
          parameters: record.parameters,
        },
      };
    }
    return tool;
  });
};

const normalizeChatReasoning = (
  body: Record<string, unknown>,
  resolvedModel: string,
): void => {
  const reasoning =
    body.reasoning &&
    typeof body.reasoning === "object" &&
    !Array.isArray(body.reasoning)
      ? (body.reasoning as Record<string, unknown>)
      : null;
  const effort = reasoning?.effort;
  // Meta often accepts a top-level reasoning_effort as well as (or instead of)
  // the OpenRouter-style `{ reasoning: { effort } }` object. Prefer the body
  // value when a nested one is absent.
  const topLevelEffort = body.reasoning_effort;

  if (resolvedModel === "x-ai/grok-4.5") {
    body.reasoning =
      typeof effort === "string" && effort !== "none" && effort !== "off"
        ? { effort }
        : { effort: "low" };
    return;
  }

  // Muse Spark always reasons: `reasoning_effort: "none"` 400s. Map Stella's
  // "none"/"off" efforts (and missing effort) to a safe default of "low".
  if (
    resolvedModel.startsWith("meta/muse-spark") ||
    resolvedModel === "muse-spark-1.1"
  ) {
    const raw =
      typeof effort === "string"
        ? effort
        : typeof topLevelEffort === "string"
          ? topLevelEffort
          : undefined;
    const safe =
      raw && raw !== "none" && raw !== "off" ? raw : "low";
    // Chat Completions accepts the OpenAI top-level form; keep reasoning
    // envelope for Responses too. Sending both is fine for Meta.
    body.reasoning_effort = safe;
    body.reasoning = { effort: safe };
    return;
  }

  if (effort !== undefined) {
    body.reasoning = { effort };
  } else {
    delete body.reasoning;
  }
};

const normalizeChatCompletionsBody = (
  body: Record<string, unknown>,
  resolvedModel: string,
): void => {
  if (body.messages === undefined && body.input !== undefined) {
    body.messages = responsesInputToChatMessages(body.input);
  }
  if (
    body.max_completion_tokens === undefined &&
    body.max_tokens === undefined &&
    body.max_output_tokens !== undefined
  ) {
    body.max_completion_tokens = body.max_output_tokens;
  }
  if (body.tools !== undefined) {
    body.tools = normalizeChatTools(body.tools);
  }
  if (
    body.response_format === undefined &&
    body.text &&
    typeof body.text === "object" &&
    !Array.isArray(body.text)
  ) {
    const format = (body.text as Record<string, unknown>).format;
    if (format !== undefined) {
      body.response_format = format;
    }
  }
  normalizeChatReasoning(body, resolvedModel);
  delete body.input;
  delete body.max_output_tokens;
  delete body.prompt_cache_key;
  delete body.prompt_cache_retention;
  delete body.store;
  delete body.include;
  delete body.text;
};

export const bodyForUpstream = (
  authorized: AuthorizedStellaRequest,
  provider: ManagedGatewayProvider,
  request: Request,
): string => {
  const requestJson = downgradeUnsupportedRequestImages(
    authorized.requestJson,
    authorized.resolvedModel,
  );
  const body: Record<string, unknown> = {
    ...requestJson,
    model: toProviderNativeModel(authorized.resolvedModel, provider),
  };
  delete (body as Record<string, unknown>).agentType;
  if (provider === "google") {
    // Google REST puts the model in the URL path, not the body.
    delete body.model;
  }
  if (provider === "fireworks" && authorized.serviceTier !== undefined) {
    body.service_tier = authorized.serviceTier;
  }

  if (isResponsesRequest(provider, request)) {
    normalizeResponsesBody(body);
  }

  const pathIsChatCompletions = new URL(request.url).pathname.endsWith(
    "/chat/completions",
  );
  const isChatCompletions =
    provider === "openrouter" || pathIsChatCompletions;
  if (provider === "openrouter" || (provider === "meta" && pathIsChatCompletions)) {
    normalizeChatCompletionsBody(body, authorized.resolvedModel);
  } else if (provider === "meta" && !pathIsChatCompletions) {
    // Responses path: still coerce Muse reasoning so we never send effort=none.
    normalizeChatReasoning(body, authorized.resolvedModel);
  }
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
  provider?: ManagedGatewayProvider,
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
  const relayProvider = authorized.relayProvider;
  const usageParser = createRelayUsageParser(relayProvider);
  let upstreamResponse: Response;

  try {
    upstreamResponse = await fetch(
      upstreamUrl(relayProvider, request, authorized.upstreamModel),
      {
        method: "POST",
        headers: cloneForwardHeaders(request, relayProvider, authorized.apiKey),
        body: bodyForUpstream(authorized, relayProvider, request),
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

  // Visibility: when upstream itself failed (Anthropic 400, OpenAI 401,
  // Google 403, etc.) the body is short JSON we want in convex logs so we
  // can diagnose. Read up to 2 KiB without consuming the stream for the
  // client: tee the body via `tee()` so one branch goes downstream and
  // the other we drain for logging.
  if (!upstreamResponse.ok && upstreamResponse.body) {
    const [forErrLog, forForward] = upstreamResponse.body.tee();
    upstreamResponse = new Response(forForward, {
      status: upstreamResponse.status,
      statusText: upstreamResponse.statusText,
      headers: upstreamResponse.headers,
    });
    void (async () => {
      try {
        const reader = forErrLog.getReader();
        const decoder = new TextDecoder();
        let collected = "";
        while (collected.length < 2048) {
          const { done, value } = await reader.read();
          if (done) break;
          if (value) collected += decoder.decode(value, { stream: true });
        }
        await reader.cancel();
        console.error(
          `[stella-provider] upstream ${relayProvider} returned ${upstreamResponse.status}: ${collected.slice(0, 2048)}`,
        );
      } catch {
        // best-effort logging
      }
    })();
  }

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
          const costMicroCents = usage
            ? computeUsageCostMicroCents({
                model,
                inputTokens:
                  usage.inputTokens ?? authorized.tokenEstimate.inputTokens,
                outputTokens:
                  usage.outputTokens ?? authorized.tokenEstimate.outputTokens,
                cachedInputTokens: usage.cachedInputTokens,
                cacheWriteInputTokens: usage.cacheWriteInputTokens,
                reasoningTokens: usage.reasoningTokens,
              })
            : undefined;
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
            costMicroCents,
          });
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
