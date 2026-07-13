import { httpAction, type ActionCtx } from "./_generated/server";
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
  RelayResumeFrameTooLargeError,
  RelayResumeSseParser,
  STELLA_RELAY_CANCEL_RATE_PER_OWNER,
  STELLA_RELAY_REQUEST_ID_HEADER,
  STELLA_RELAY_RESUME_HEADER,
  STELLA_RELAY_RESUME_LEASE_REFRESH_MS,
  STELLA_RELAY_RESUME_POLL_MIN_MS,
  STELLA_RELAY_RESUME_RATE_PER_OWNER,
  STELLA_RELAY_RESUME_RATE_PER_STREAM,
  STELLA_RELAY_RESUME_RATE_WINDOW_MS,
  STELLA_RELAY_RESUME_TTL_MS,
  STELLA_RELAY_RESUME_VERSION,
  relayResumeChunkEvents,
  isValidRelayRequestId,
  relayRequestIdFromIdempotencyKey,
  relayResumeNextPollDelay,
  relayResumeSyntheticErrorFrame,
  relayResumeStreamIsStale,
  relayResumeTerminalSuffix,
  type RelayResumeEvent,
} from "./stella_provider/relay_resume";
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

export {
  STELLA_RELAY_REQUEST_ID_HEADER,
  STELLA_RELAY_RESUME_HEADER,
  STELLA_RELAY_RESUME_TTL_MS,
  STELLA_RELAY_RESUME_VERSION,
} from "./stella_provider/relay_resume";

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
          key:
            identity?.tokenIdentifier ?? getClientAddressKey(request) ?? "anon",
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
      lower.startsWith("x-stella-relay-") ||
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
      const verbMatch = /:([A-Za-z][A-Za-z0-9]*)$/u.exec(requestUrl.pathname);
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
      image_url: typeof imageUrl === "string" ? { url: imageUrl } : imageUrl,
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
  // Accept either incoming representation. The endpoint-specific normalization
  // below keeps only the wire shape that the selected Meta API accepts.
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
    const safe = raw && raw !== "none" && raw !== "off" ? raw : "low";
    // Materialize both forms here so endpoint-specific normalization can retain
    // the one accepted by its upstream API.
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
    // Relay-owned resume buffers response events without changing the
    // provider's zero-retention request contract.
    body.store = false;
  }

  const pathIsChatCompletions = new URL(request.url).pathname.endsWith(
    "/chat/completions",
  );
  const isChatCompletions = provider === "openrouter" || pathIsChatCompletions;
  if (
    provider === "openrouter" ||
    (provider === "meta" && pathIsChatCompletions)
  ) {
    normalizeChatCompletionsBody(body, authorized.resolvedModel);
    if (provider === "meta") {
      // Meta chat completions accepts top-level `reasoning_effort` and rejects
      // the Responses-style nested `reasoning` object.
      delete body.reasoning;
    }
  } else if (provider === "meta" && !pathIsChatCompletions) {
    // Meta Responses has the inverse contract: nested `reasoning` is accepted,
    // while top-level `reasoning_effort` is rejected as an unknown parameter.
    normalizeChatReasoning(body, authorized.resolvedModel);
    delete body.reasoning_effort;
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

type RelayResumePage = {
  ownerId: string;
  status:
    | "streaming"
    | "completed"
    | "incomplete"
    | "failed"
    | "error"
    | "canceled"
    | "upstream_eof"
    | "truncated";
  expiresAt: number;
  hardExpiresAt: number;
  updatedAt: number;
  lastSequence: number;
  responseId?: string;
  upstreamRequestId?: string;
  lastEventType?: string;
  lastResponseStatus?: string;
  events: Array<{ sequence: number; frame: string }>;
  hasMore: boolean;
  chunksRead: number;
  bytesRead: number;
};

const relayResumeIdFromRequest = (request: Request): string | null => {
  const pathname = new URL(request.url).pathname;
  const candidate =
    /\/responses\/([A-Za-z0-9_-]+)$/u.exec(pathname)?.[1] ?? null;
  return isValidRelayRequestId(candidate) ? candidate : null;
};

const relayResumeCursorFromRequest = (request: Request): number | null => {
  const raw = new URL(request.url).searchParams.get("starting_after") ?? "0";
  if (!/^\d+$/u.test(raw)) return null;
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
};

const relayResumeHeaders = (request: Request): Headers => {
  const headers = new Headers({
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-store",
    connection: "keep-alive",
    [STELLA_RELAY_RESUME_HEADER]: STELLA_RELAY_RESUME_VERSION,
  });
  headers.set(
    "Access-Control-Allow-Origin",
    request.headers.get("origin") ?? "*",
  );
  headers.set("Vary", "Origin");
  return headers;
};

const relayResumePage = async (
  ctx: ActionCtx,
  relayRequestId: string,
  startingAfter: number,
): Promise<RelayResumePage | null> =>
  await ctx.runQuery(
    internal.stella_provider.relay_resume_store.getRelayResumePage,
    { relayRequestId, startingAfter },
  );

const rateLimitRelayResume = async (
  ctx: ActionCtx,
  request: Request,
  ownerId: string,
  relayRequestId: string,
): Promise<Response | null> => {
  const [ownerLimit, streamLimit] = await Promise.all([
    ctx.runMutation(internal.rate_limits.consumeWebhookRateLimit, {
      scope: "stella_relay_resume_owner",
      key: ownerId,
      limit: STELLA_RELAY_RESUME_RATE_PER_OWNER,
      windowMs: STELLA_RELAY_RESUME_RATE_WINDOW_MS,
      blockMs: STELLA_RELAY_RESUME_RATE_WINDOW_MS,
    }),
    ctx.runMutation(internal.rate_limits.consumeWebhookRateLimit, {
      scope: "stella_relay_resume_stream",
      key: `${ownerId}:${relayRequestId}`,
      limit: STELLA_RELAY_RESUME_RATE_PER_STREAM,
      windowMs: STELLA_RELAY_RESUME_RATE_WINDOW_MS,
      blockMs: STELLA_RELAY_RESUME_RATE_WINDOW_MS,
    }),
  ]);
  if (ownerLimit.allowed && streamLimit.allowed) return null;
  const retryAfterMs = Math.max(
    ownerLimit.retryAfterMs,
    streamLimit.retryAfterMs,
  );
  const response = stellaProviderErrorResponse(
    429,
    "Relay resume rate limit exceeded",
    request,
  );
  response.headers.set("Retry-After", String(Math.ceil(retryAfterMs / 1000)));
  return response;
};

const relayLeaseErrorResponse = (
  result:
    | "not_found"
    | "expired"
    | "cursor_ahead"
    | "stream_limit"
    | "owner_limit",
  request: Request,
): Response => {
  switch (result) {
    case "not_found":
      return stellaProviderErrorResponse(
        404,
        "Relay response not found",
        request,
      );
    case "expired":
      return stellaProviderErrorResponse(
        410,
        "Relay resume cursor expired",
        request,
      );
    case "cursor_ahead":
      return stellaProviderErrorResponse(
        416,
        "Relay resume cursor is ahead of the stream",
        request,
      );
    case "stream_limit":
    case "owner_limit": {
      const response = stellaProviderErrorResponse(
        429,
        "Too many concurrent relay resume connections",
        request,
      );
      response.headers.set("Retry-After", "2");
      return response;
    }
  }
};

const makeRelayResumeResponse = async (args: {
  ctx: ActionCtx;
  request: Request;
  ownerId: string;
  relayRequestId: string;
  startingAfter: number;
  applyRateLimit: boolean;
}): Promise<Response> => {
  if (args.applyRateLimit) {
    const limited = await rateLimitRelayResume(
      args.ctx,
      args.request,
      args.ownerId,
      args.relayRequestId,
    );
    if (limited) return limited;
  }

  const leaseId = crypto.randomUUID();
  const leaseResult = await args.ctx.runMutation(
    internal.stella_provider.relay_resume_store.acquireRelayResumeLease,
    {
      leaseId,
      relayRequestId: args.relayRequestId,
      ownerId: args.ownerId,
      startingAfter: args.startingAfter,
      nowMs: Date.now(),
    },
  );
  if (leaseResult !== "acquired") {
    return relayLeaseErrorResponse(leaseResult, args.request);
  }

  const initial = await relayResumePage(
    args.ctx,
    args.relayRequestId,
    args.startingAfter,
  );
  if (!initial || initial.ownerId !== args.ownerId) {
    await args.ctx.runMutation(
      internal.stella_provider.relay_resume_store.releaseRelayResumeLease,
      { leaseId, ownerId: args.ownerId },
    );
    return stellaProviderErrorResponse(
      404,
      "Relay response not found",
      args.request,
    );
  }

  const headers = relayResumeHeaders(args.request);
  headers.set(STELLA_RELAY_REQUEST_ID_HEADER, args.relayRequestId);
  if (initial.responseId)
    headers.set("x-stella-response-id", initial.responseId);
  if (initial.upstreamRequestId) {
    headers.set("x-stella-upstream-request-id", initial.upstreamRequestId);
  }

  const encoder = new TextEncoder();
  let cursor = args.startingAfter;
  let pendingFrames: string[] = [];
  let done = false;
  let released = false;
  let leaseInvalid = false;
  let pollDelayMs = STELLA_RELAY_RESUME_POLL_MIN_MS;
  // Delivery gate state: buffered plaintext frames become undeliverable the
  // instant logical access expires, using the same expiry the cleanup sweep
  // uses to make rows deletable. Synthetic terminal frames (which carry no
  // response content) remain deliverable after that point.
  let accessExpiresAt = Math.min(initial.expiresAt, initial.hardExpiresAt);
  let lastKnownSequence = initial.lastSequence;
  const release = async () => {
    if (released) return;
    released = true;
    await args.ctx.runMutation(
      internal.stella_provider.relay_resume_store.releaseRelayResumeLease,
      { leaseId, ownerId: args.ownerId },
    );
  };
  const expireDelivery = () => {
    pendingFrames = [
      relayResumeSyntheticErrorFrame({
        sequence: lastKnownSequence + 1,
        code: "relay_stream_lost",
        message:
          "The Stella relay resume cursor expired. The original request was not replayed.",
      }),
      "data: [DONE]\n\n",
    ];
    done = true;
  };
  const revalidateLease = async (): Promise<boolean> => {
    const nowMs = Date.now();
    const result = await args.ctx.runMutation(
      internal.stella_provider.relay_resume_store.refreshRelayResumeLease,
      { leaseId, ownerId: args.ownerId, nowMs },
    );
    if (result === "not_found" || result === "expired") {
      leaseInvalid = true;
      return false;
    }
    accessExpiresAt = result.accessExpiresAt;
    if (Date.now() >= accessExpiresAt) {
      leaseInvalid = true;
      return false;
    }
    return true;
  };

  // Keep every open HTTP consumer represented by a live lease even when its
  // reader is backpressured and does not pull for a while. Per-pull validation
  // below remains the delivery gate; this heartbeat only preserves the
  // concurrency accounting between pulls.
  const keepLeaseAlive = async () => {
    while (!released && !done) {
      await new Promise((resolve) =>
        setTimeout(resolve, STELLA_RELAY_RESUME_LEASE_REFRESH_MS),
      );
      if (released || done) return;
      try {
        if (!(await revalidateLease())) return;
      } catch {
        leaseInvalid = true;
        return;
      }
    }
  };

  const stream = new ReadableStream<Uint8Array>(
    {
      start() {
        void keepLeaseAlive();
      },
      async cancel() {
        await release();
      },
      async pull(controller) {
        try {
          if (!done) {
            if (leaseInvalid || !(await revalidateLease())) expireDelivery();
          }
          while (pendingFrames.length === 0 && !done) {
            const beforeReadMs = Date.now();
            if (beforeReadMs >= accessExpiresAt) {
              expireDelivery();
              break;
            }
            // Enforce the lease, owner purge gate, and logical expiry before
            // every database page read, not only when the connection starts.
            if (!(await revalidateLease())) {
              expireDelivery();
              break;
            }
            const page = await relayResumePage(
              args.ctx,
              args.relayRequestId,
              cursor,
            );
            if (!page || page.ownerId !== args.ownerId) {
              throw new Error("Relay response disappeared during resume");
            }
            accessExpiresAt = Math.min(page.expiresAt, page.hardExpiresAt);
            lastKnownSequence = page.lastSequence;
            if (Date.now() >= accessExpiresAt) {
              expireDelivery();
              break;
            }

            if (page.events.length > 0) {
              pendingFrames = page.events.map((event) => event.frame);
              cursor = page.events[page.events.length - 1]!.sequence;
              pollDelayMs = relayResumeNextPollDelay(pollDelayMs, true);
              break;
            }

            const terminalSuffix = relayResumeTerminalSuffix(
              page.status,
              page.lastSequence,
            );
            if (terminalSuffix && cursor >= page.lastSequence) {
              pendingFrames = terminalSuffix;
              done = true;
              break;
            }

            if (relayResumeStreamIsStale(page.updatedAt, Date.now())) {
              await args.ctx.runMutation(
                internal.stella_provider.relay_resume_store
                  .finishRelayResumeStream,
                {
                  relayRequestId: args.relayRequestId,
                  ownerId: args.ownerId,
                  status: "upstream_eof",
                  nowMs: Date.now(),
                },
              );
              continue;
            }
            await new Promise((resolve) => setTimeout(resolve, pollDelayMs));
            pollDelayMs = relayResumeNextPollDelay(pollDelayMs, false);
          }

          // Enforce the same gate again immediately before each plaintext frame
          // leaves the action. A page can contain several frames and cleanup or
          // expiry may advance while the consumer applies backpressure.
          if (!done && pendingFrames.length > 0) {
            if (!(await revalidateLease())) expireDelivery();
          }
          const frame = pendingFrames.shift();
          if (frame) controller.enqueue(encoder.encode(frame));
          if (done && pendingFrames.length === 0) {
            await release();
            controller.close();
          }
        } catch (error) {
          await release().catch(() => undefined);
          controller.error(error);
        }
      },
    },
    // Strictly demand-driven: without eager pulls, no plaintext frame can sit
    // in the stream's internal queue past the expiry/lease gate above.
    { highWaterMark: 0 },
  );

  return new Response(stream, { status: 200, headers });
};

export const stellaProviderResume = httpAction(async (ctx, request) => {
  const identity = await ctx.auth.getUserIdentity();
  if (!identity)
    return stellaProviderErrorResponse(401, "Unauthorized", request);
  const relayRequestId = relayResumeIdFromRequest(request);
  const startingAfter = relayResumeCursorFromRequest(request);
  if (!relayRequestId || startingAfter === null) {
    return stellaProviderErrorResponse(
      400,
      "Invalid relay resume cursor",
      request,
    );
  }
  return await makeRelayResumeResponse({
    ctx,
    request,
    ownerId: identity.tokenIdentifier,
    relayRequestId,
    startingAfter,
    applyRateLimit: true,
  });
});

export const stellaProviderCancel = httpAction(async (ctx, request) => {
  const identity = await ctx.auth.getUserIdentity();
  if (!identity) {
    return stellaProviderErrorResponse(401, "Unauthorized", request);
  }
  const relayRequestId = relayResumeIdFromRequest(request);
  if (!relayRequestId) {
    return stellaProviderErrorResponse(
      400,
      "Invalid relay request id",
      request,
    );
  }
  // Cancellations write tombstones, so they are rate limited like resumes.
  const cancelLimit = await ctx.runMutation(
    internal.rate_limits.consumeWebhookRateLimit,
    {
      scope: "stella_relay_cancel_owner",
      key: identity.tokenIdentifier,
      limit: STELLA_RELAY_CANCEL_RATE_PER_OWNER,
      windowMs: STELLA_RELAY_RESUME_RATE_WINDOW_MS,
      blockMs: STELLA_RELAY_RESUME_RATE_WINDOW_MS,
    },
  );
  if (!cancelLimit.allowed) {
    const response = stellaProviderErrorResponse(
      429,
      "Relay cancel rate limit exceeded",
      request,
    );
    response.headers.set(
      "Retry-After",
      String(Math.ceil(cancelLimit.retryAfterMs / 1000)),
    );
    return response;
  }
  const result = await ctx.runMutation(
    internal.stella_provider.relay_resume_store.cancelRelayResumeStream,
    {
      relayRequestId,
      ownerId: identity.tokenIdentifier,
      nowMs: Date.now(),
    },
  );
  if (result === "not_found") {
    return stellaProviderErrorResponse(
      404,
      "Relay response not found",
      request,
    );
  }
  if (result === "expired") {
    return stellaProviderErrorResponse(
      410,
      "Relay resume cursor expired",
      request,
    );
  }
  if (result === "intent_quota") {
    const response = stellaProviderErrorResponse(
      429,
      "Relay cancellation quota exceeded",
      request,
    );
    response.headers.set("Retry-After", "60");
    return response;
  }
  return new Response(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Origin": request.headers.get("origin") ?? "*",
      Vary: "Origin",
    },
  });
});

const safeUpstreamRequestId = (headers: Headers): string | undefined => {
  for (const name of [
    "x-request-id",
    "request-id",
    "openai-request-id",
    "x-openai-request-id",
  ]) {
    const value = headers.get(name)?.trim();
    if (value) return value.slice(0, 200);
  }
  return undefined;
};

const relayResumeEligibleRequest = (
  authorized: AuthorizedStellaRequest,
  request: Request,
): boolean =>
  authorized.relayProvider === "openai" &&
  authorized.ownerId !== "probe:stella-relay" &&
  isResponsesRequest(authorized.relayProvider, request) &&
  authorized.requestJson.stream === true &&
  new URL(request.url).pathname.startsWith(STELLA_RELAY_PATH_PREFIX);

const relayResumeCapableResponse = (response: Response): boolean =>
  response.ok &&
  response.headers.get("content-type")?.includes("text/event-stream") === true;

export const stellaProviderRelay = (provider?: ManagedGatewayProvider) =>
  httpAction(async (ctx, request) => {
    const authorized = await authorizeStellaRelayRequest({
      ctx,
      request,
      relayProvider: provider,
    });
    if (authorized instanceof Response) return authorized;

    const startedAt = Date.now();
    const relayProvider = authorized.relayProvider;
    const usageParser = createRelayUsageParser(relayProvider);
    let relayRequestId: string | undefined;
    const requestedRelayId = request.headers.get(
      STELLA_RELAY_REQUEST_ID_HEADER,
    );
    if (requestedRelayId !== null && !isValidRelayRequestId(requestedRelayId)) {
      return stellaProviderErrorResponse(
        400,
        "Invalid relay request id",
        request,
      );
    }
    const resumeEligible = relayResumeEligibleRequest(authorized, request);
    if (resumeEligible) {
      const idempotencyKey = request.headers.get("idempotency-key")?.trim();
      // New clients propose a random relay id directly. Older clients already
      // reuse Idempotency-Key across resilient POST attempts, so derive the
      // same opaque relay id on every attempt. Either direction therefore
      // reaches one reservation and at most one upstream execution.
      let candidate = requestedRelayId;
      if (!candidate) {
        if (!idempotencyKey || idempotencyKey.length > 200) {
          return stellaProviderErrorResponse(
            400,
            "A stable Idempotency-Key is required for streaming Stella relay requests",
            request,
          );
        }
        candidate = await relayRequestIdFromIdempotencyKey(
          authorized.ownerId,
          idempotencyKey,
        );
      }
      const reservation = await ctx.runMutation(
        internal.stella_provider.relay_resume_store.reserveRelayResumeStream,
        {
          relayRequestId: candidate,
          ownerId: authorized.ownerId,
          provider: relayProvider,
          model: authorized.resolvedModel,
          nowMs: Date.now(),
        },
      );
      if (reservation === "existing") {
        return await makeRelayResumeResponse({
          ctx,
          request,
          ownerId: authorized.ownerId,
          relayRequestId: candidate,
          startingAfter: 0,
          applyRateLimit: true,
        });
      }
      if (reservation === "canceled") {
        return stellaProviderErrorResponse(
          499,
          "Relay response canceled",
          request,
        );
      }
      if (reservation === "conflict") {
        return stellaProviderErrorResponse(
          409,
          "Relay request id conflict",
          request,
        );
      }
      if (reservation === "owner_purged") {
        return stellaProviderErrorResponse(
          403,
          "Relay resume is unavailable while this account's data is being deleted",
          request,
        );
      }
      if (reservation === "owner_quota" || reservation === "global_quota") {
        const response = stellaProviderErrorResponse(
          429,
          "Transient relay buffer quota exceeded",
          request,
        );
        response.headers.set("Retry-After", "5");
        return response;
      }
      relayRequestId = candidate;
    }

    let upstreamResponse: Response;
    const upstreamController = relayRequestId
      ? new AbortController()
      : undefined;
    let stopCancellationMonitor = false;
    let lastPreHeaderTouchAt = Date.now();
    const cancellationMonitor = relayRequestId
      ? (async () => {
          try {
            while (!stopCancellationMonitor) {
              const status = await ctx.runQuery(
                internal.stella_provider.relay_resume_store
                  .getRelayResumeStatus,
                { relayRequestId, ownerId: authorized.ownerId },
              );
              if (status === "canceled") {
                upstreamController?.abort(new Error("Relay response canceled"));
                return;
              }
              const nowMs = Date.now();
              if (nowMs - lastPreHeaderTouchAt >= 10_000) {
                await ctx.runMutation(
                  internal.stella_provider.relay_resume_store
                    .touchRelayResumeStream,
                  {
                    relayRequestId,
                    ownerId: authorized.ownerId,
                    nowMs,
                  },
                );
                lastPreHeaderTouchAt = nowMs;
              }
              await new Promise((resolve) => setTimeout(resolve, 200));
            }
          } catch (error) {
            console.error(
              "[stella-provider] Relay cancellation monitor failed",
              {
                relayRequestId,
                error: error instanceof Error ? error.name : "unknown",
              },
            );
            upstreamController?.abort(
              new Error("Relay cancellation state became unavailable"),
            );
          }
        })()
      : undefined;
    try {
      upstreamResponse = await fetch(
        upstreamUrl(relayProvider, request, authorized.upstreamModel),
        {
          method: "POST",
          headers: cloneForwardHeaders(
            request,
            relayProvider,
            authorized.apiKey,
          ),
          body: bodyForUpstream(authorized, relayProvider, request),
          ...(upstreamController ? { signal: upstreamController.signal } : {}),
        },
      );
    } catch (error) {
      const relayStatus = relayRequestId
        ? await ctx.runQuery(
            internal.stella_provider.relay_resume_store.getRelayResumeStatus,
            { relayRequestId, ownerId: authorized.ownerId },
          )
        : "not_found";
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
      if (relayStatus === "canceled") {
        return stellaProviderErrorResponse(
          499,
          "Relay response canceled",
          request,
        );
      }
      if (relayRequestId) {
        await ctx.runMutation(
          internal.stella_provider.relay_resume_store.finishRelayResumeStream,
          {
            relayRequestId,
            ownerId: authorized.ownerId,
            status: "error",
            nowMs: Date.now(),
          },
        );
      }
      return stellaProviderErrorResponse(
        502,
        "Failed to reach Stella upstream gateway",
        request,
      );
    } finally {
      stopCancellationMonitor = true;
      await cancellationMonitor;
    }

    const responseHeaders = new Headers(upstreamResponse.headers);
    responseHeaders.set(
      "Access-Control-Allow-Origin",
      request.headers.get("origin") ?? "*",
    );
    responseHeaders.set("Vary", "Origin");
    responseHeaders.delete("content-length");

    if (!upstreamResponse.ok) {
      console.error("[stella-provider] Upstream request failed", {
        relayRequestId,
        upstreamRequestId: safeUpstreamRequestId(upstreamResponse.headers),
        provider: relayProvider,
        status: upstreamResponse.status,
      });
    }

    const upstreamBody = upstreamResponse.body;
    if (!upstreamBody) {
      if (relayRequestId) {
        await ctx.runMutation(
          internal.stella_provider.relay_resume_store.finishRelayResumeStream,
          {
            relayRequestId,
            ownerId: authorized.ownerId,
            status: "error",
            nowMs: Date.now(),
          },
        );
      }
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

    if (relayRequestId && relayResumeCapableResponse(upstreamResponse)) {
      const activation = await ctx.runMutation(
        internal.stella_provider.relay_resume_store.activateRelayResumeStream,
        {
          relayRequestId,
          ownerId: authorized.ownerId,
          upstreamStatus: upstreamResponse.status,
          upstreamRequestId: safeUpstreamRequestId(upstreamResponse.headers),
          nowMs: Date.now(),
        },
      );
      if (activation === "canceled") {
        await upstreamBody.cancel().catch(() => undefined);
        return stellaProviderErrorResponse(
          499,
          "Relay response canceled",
          request,
        );
      }
      if (activation !== "streaming") {
        await upstreamBody.cancel().catch(() => undefined);
        return stellaProviderErrorResponse(
          409,
          "Relay response is not active",
          request,
        );
      }
      responseHeaders.set(
        STELLA_RELAY_RESUME_HEADER,
        STELLA_RELAY_RESUME_VERSION,
      );
      responseHeaders.set(STELLA_RELAY_REQUEST_ID_HEADER, relayRequestId);
      responseHeaders.set(
        "Access-Control-Expose-Headers",
        `${STELLA_RELAY_RESUME_HEADER}, ${STELLA_RELAY_REQUEST_ID_HEADER}`,
      );
    } else if (relayRequestId) {
      await ctx.runMutation(
        internal.stella_provider.relay_resume_store.finishRelayResumeStream,
        {
          relayRequestId,
          ownerId: authorized.ownerId,
          status: "error",
          nowMs: Date.now(),
        },
      );
      relayRequestId = undefined;
    }

    let downstreamOpen = true;
    const stream = new ReadableStream<Uint8Array>({
      cancel() {
        downstreamOpen = false;
      },
      start(controller) {
        const reader = upstreamBody.getReader();
        const usageDecoder = new TextDecoder();
        const resumeDecoder = relayRequestId ? new TextDecoder() : undefined;
        const resumeParser = relayRequestId
          ? new RelayResumeSseParser()
          : undefined;
        const encoder = new TextEncoder();
        void (async () => {
          let relayStatus:
            | "streaming"
            | "completed"
            | "incomplete"
            | "failed"
            | "error"
            | "canceled"
            | "upstream_eof"
            | "truncated" = "streaming";
          let pendingRead = reader.read();
          let lastHeartbeatAt = Date.now();

          const enqueue = (value: Uint8Array) => {
            if (!downstreamOpen) return;
            try {
              controller.enqueue(value);
            } catch {
              downstreamOpen = false;
            }
          };
          const markUnrecoverable = async (
            status: "upstream_eof" | "truncated",
          ) => {
            if (!relayRequestId || relayStatus !== "streaming") return;
            relayStatus = status;
            await ctx.runMutation(
              internal.stella_provider.relay_resume_store
                .finishRelayResumeStream,
              {
                relayRequestId,
                ownerId: authorized.ownerId,
                status,
                nowMs: Date.now(),
              },
            );
          };
          const persistAndForward = async (events: RelayResumeEvent[]) => {
            if (!relayRequestId || events.length === 0) return true;
            for (const batch of relayResumeChunkEvents(events)) {
              const result: {
                accepted: boolean;
                status: typeof relayStatus;
              } = await ctx.runMutation(
                internal.stella_provider.relay_resume_store
                  .appendRelayResumeEvents,
                { relayRequestId, events: batch, nowMs: Date.now() },
              );
              relayStatus = result.status;
              if (result.accepted) {
                for (const event of batch) enqueue(encoder.encode(event.frame));
              }
              if (!result.accepted) return false;
            }
            return true;
          };

          try {
            while (true) {
              const heartbeatDueIn = Math.max(
                0,
                10_000 - (Date.now() - lastHeartbeatAt),
              );
              const outcome = await new Promise<
                | { kind: "read"; read: ReadableStreamReadResult<Uint8Array> }
                | { kind: "heartbeat" }
              >((resolve, reject) => {
                const timer = setTimeout(
                  () => resolve({ kind: "heartbeat" }),
                  heartbeatDueIn,
                );
                void pendingRead.then(
                  (read) => {
                    clearTimeout(timer);
                    resolve({ kind: "read", read });
                  },
                  (error) => {
                    clearTimeout(timer);
                    reject(error);
                  },
                );
              });
              if (outcome.kind === "heartbeat") {
                lastHeartbeatAt = Date.now();
                if (relayRequestId && relayStatus === "streaming") {
                  const touchedStatus = await ctx.runMutation(
                    internal.stella_provider.relay_resume_store
                      .touchRelayResumeStream,
                    {
                      relayRequestId,
                      ownerId: authorized.ownerId,
                      nowMs: lastHeartbeatAt,
                    },
                  );
                  if (touchedStatus === "not_found") {
                    relayStatus = "upstream_eof";
                    await reader.cancel();
                    break;
                  }
                  relayStatus = touchedStatus;
                  if (relayStatus === "canceled") {
                    await reader.cancel();
                    break;
                  }
                }
                continue;
              }

              const { done, value } = outcome.read;
              if (done) break;
              pendingRead = reader.read();
              if (!value) continue;
              usageParser.pushText(
                usageDecoder.decode(value, { stream: true }),
              );
              if (!relayRequestId || !resumeDecoder || !resumeParser) {
                enqueue(value);
                continue;
              }

              const frames = resumeParser.push(
                resumeDecoder.decode(value, { stream: true }),
              );
              let events: RelayResumeEvent[] = [];
              let unsafeFrame = false;
              for (const frame of frames) {
                if (frame.kind === "event") {
                  events.push(frame.event);
                  continue;
                }
                await persistAndForward(events);
                events = [];
                if (frame.kind === "passthrough" && !frame.replaySafe) {
                  await markUnrecoverable("truncated");
                  unsafeFrame = true;
                  break;
                }
                enqueue(encoder.encode(frame.frame));
              }
              if (unsafeFrame) {
                await reader.cancel();
                break;
              }
              const accepted = await persistAndForward(events);
              if (!accepted) {
                await reader.cancel();
                break;
              }
            }

            usageParser.pushText(usageDecoder.decode());
            if (resumeDecoder && resumeParser) {
              const decodedFinal = resumeParser.push(resumeDecoder.decode());
              const finished = resumeParser.finish();
              const finalFrames = [...decodedFinal, ...finished.frames];
              let finalEvents: RelayResumeEvent[] = [];
              let unsafeFinalFrame = false;
              for (const frame of finalFrames) {
                if (frame.kind === "event") {
                  finalEvents.push(frame.event);
                  continue;
                }
                await persistAndForward(finalEvents);
                finalEvents = [];
                if (frame.kind === "passthrough" && !frame.replaySafe) {
                  await markUnrecoverable("truncated");
                  unsafeFinalFrame = true;
                  break;
                }
                enqueue(encoder.encode(frame.frame));
              }
              if (!unsafeFinalFrame) await persistAndForward(finalEvents);
              if (relayStatus === "streaming" && !unsafeFinalFrame) {
                await markUnrecoverable("upstream_eof");
              }
            }

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
            const finalRelayStatus: string = relayStatus;
            await ctx.scheduler.runAfter(0, internal.billing.logManagedUsage, {
              ownerId: authorized.ownerId,
              agentType: authorized.agentType,
              model,
              durationMs: Date.now() - startedAt,
              success:
                upstreamResponse.ok &&
                (!relayRequestId ||
                  !["upstream_eof", "truncated", "canceled"].includes(
                    finalRelayStatus,
                  )),
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
            console.error("[stella-provider] Relay stream failed:", {
              relayRequestId,
              upstreamRequestId: safeUpstreamRequestId(
                upstreamResponse.headers,
              ),
              lastStatus: relayStatus,
              error: error instanceof Error ? error.message : String(error),
            });
            await markUnrecoverable(
              error instanceof RelayResumeFrameTooLargeError
                ? "truncated"
                : "upstream_eof",
            ).catch(() => undefined);
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
