import {
  httpAction,
  internalMutation,
  internalQuery,
  type ActionCtx,
} from "./_generated/server";
import { internal } from "./_generated/api";
import { v } from "convex/values";
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
import { relayResumeStatusValidator } from "./schema/relay_resume";
import {
  RelayResumeSseParser,
  STELLA_RELAY_REQUEST_ID_HEADER,
  STELLA_RELAY_RESUME_HEADER,
  STELLA_RELAY_RESUME_MAX_BYTES,
  STELLA_RELAY_RESUME_MAX_EVENT_BYTES,
  STELLA_RELAY_RESUME_MAX_EVENTS,
  STELLA_RELAY_RESUME_POLL_MS,
  STELLA_RELAY_RESUME_TTL_MS,
  STELLA_RELAY_RESUME_VERSION,
  relayResumeChunkEvents,
  decideRelayResumeAccess,
  relayResumeEventBytes,
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

const relayResumeEventValidator = v.object({
  sequence: v.number(),
  frame: v.string(),
  eventType: v.string(),
  responseId: v.optional(v.string()),
  responseStatus: v.optional(v.string()),
  terminalStatus: v.optional(
    v.union(v.literal("completed"), v.literal("failed"), v.literal("error")),
  ),
});

const relayResumeStoredEventValidator = v.object({
  sequence: v.number(),
  frame: v.string(),
});

export const createRelayResumeStream = internalMutation({
  args: {
    relayRequestId: v.string(),
    ownerId: v.string(),
    provider: v.string(),
    model: v.string(),
    upstreamStatus: v.number(),
    upstreamRequestId: v.optional(v.string()),
    nowMs: v.number(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("stella_relay_response_streams")
      .withIndex("by_relayRequestId", (q) =>
        q.eq("relayRequestId", args.relayRequestId),
      )
      .unique();
    if (existing) return null;
    await ctx.db.insert("stella_relay_response_streams", {
      relayRequestId: args.relayRequestId,
      ownerId: args.ownerId,
      provider: args.provider,
      model: args.model,
      status: "streaming",
      upstreamStatus: args.upstreamStatus,
      upstreamRequestId: args.upstreamRequestId?.slice(0, 200),
      lastSequence: 0,
      eventCount: 0,
      storedBytes: 0,
      nextChunkIndex: 0,
      createdAt: args.nowMs,
      updatedAt: args.nowMs,
      expiresAt: args.nowMs + STELLA_RELAY_RESUME_TTL_MS,
    });
    return null;
  },
});

export const appendRelayResumeEvents = internalMutation({
  args: {
    relayRequestId: v.string(),
    events: v.array(relayResumeEventValidator),
    nowMs: v.number(),
  },
  returns: v.object({
    accepted: v.boolean(),
    status: relayResumeStatusValidator,
  }),
  handler: async (ctx, args) => {
    const stream = await ctx.db
      .query("stella_relay_response_streams")
      .withIndex("by_relayRequestId", (q) =>
        q.eq("relayRequestId", args.relayRequestId),
      )
      .unique();
    if (!stream) return { accepted: false, status: "truncated" as const };
    if (stream.status !== "streaming") {
      return { accepted: false, status: stream.status };
    }
    if (args.events.length === 0) {
      return { accepted: true, status: stream.status };
    }

    let expected = stream.lastSequence + 1;
    let addedBytes = 0;
    for (const event of args.events) {
      if (event.sequence !== expected) {
        throw new Error("Relay resume event sequence is not contiguous");
      }
      expected += 1;
      const eventBytes = relayResumeEventBytes(event);
      if (eventBytes > STELLA_RELAY_RESUME_MAX_EVENT_BYTES) {
        await ctx.db.patch(stream._id, {
          status: "truncated",
          lastEventType: event.eventType,
          updatedAt: args.nowMs,
        });
        return { accepted: false, status: "truncated" as const };
      }
      addedBytes += eventBytes;
    }
    if (
      stream.eventCount + args.events.length > STELLA_RELAY_RESUME_MAX_EVENTS ||
      stream.storedBytes + addedBytes > STELLA_RELAY_RESUME_MAX_BYTES
    ) {
      await ctx.db.patch(stream._id, {
        status: "truncated",
        lastEventType: args.events[args.events.length - 1]?.eventType,
        updatedAt: args.nowMs,
      });
      return { accepted: false, status: "truncated" as const };
    }

    const chunks = relayResumeChunkEvents(args.events);
    let chunkIndex = stream.nextChunkIndex;
    for (const events of chunks) {
      const storedBytes = events.reduce(
        (sum, event) => sum + relayResumeEventBytes(event),
        0,
      );
      await ctx.db.insert("stella_relay_response_chunks", {
        relayRequestId: args.relayRequestId,
        chunkIndex,
        firstSequence: events[0]!.sequence,
        lastSequence: events[events.length - 1]!.sequence,
        events: events.map(({ sequence, frame }) => ({ sequence, frame })),
        storedBytes,
        createdAt: args.nowMs,
        expiresAt: stream.expiresAt,
      });
      chunkIndex += 1;
    }

    const lastEvent = args.events[args.events.length - 1]!;
    const terminal = args.events.find((event) => event.terminalStatus);
    await ctx.db.patch(stream._id, {
      status: terminal?.terminalStatus ?? "streaming",
      responseId:
        [...args.events].reverse().find((event) => event.responseId)
          ?.responseId ?? stream.responseId,
      lastEventType: lastEvent.eventType,
      lastResponseStatus:
        [...args.events].reverse().find((event) => event.responseStatus)
          ?.responseStatus ?? stream.lastResponseStatus,
      lastSequence: lastEvent.sequence,
      eventCount: stream.eventCount + args.events.length,
      storedBytes: stream.storedBytes + addedBytes,
      nextChunkIndex: chunkIndex,
      updatedAt: args.nowMs,
    });
    return {
      accepted: true,
      status: (terminal?.terminalStatus ?? "streaming") as
        | "streaming"
        | "completed"
        | "failed"
        | "error",
    };
  },
});

export const touchRelayResumeStream = internalMutation({
  args: { relayRequestId: v.string(), nowMs: v.number() },
  returns: relayResumeStatusValidator,
  handler: async (ctx, args) => {
    const stream = await ctx.db
      .query("stella_relay_response_streams")
      .withIndex("by_relayRequestId", (q) =>
        q.eq("relayRequestId", args.relayRequestId),
      )
      .unique();
    if (stream?.status === "streaming") {
      await ctx.db.patch(stream._id, { updatedAt: args.nowMs });
    }
    return stream?.status ?? "upstream_eof";
  },
});

export const cancelRelayResumeStream = internalMutation({
  args: {
    relayRequestId: v.string(),
    ownerId: v.string(),
    nowMs: v.number(),
  },
  returns: v.union(
    v.literal("not_found"),
    v.literal("expired"),
    relayResumeStatusValidator,
  ),
  handler: async (ctx, args) => {
    const stream = await ctx.db
      .query("stella_relay_response_streams")
      .withIndex("by_relayRequestId", (q) =>
        q.eq("relayRequestId", args.relayRequestId),
      )
      .unique();
    if (!stream || stream.ownerId !== args.ownerId) return "not_found";
    if (stream.expiresAt <= args.nowMs) return "expired";
    if (stream.status !== "streaming") return stream.status;
    await ctx.db.patch(stream._id, {
      status: "canceled",
      updatedAt: args.nowMs,
    });
    return "canceled";
  },
});

export const finishRelayResumeStream = internalMutation({
  args: {
    relayRequestId: v.string(),
    status: v.union(
      v.literal("upstream_eof"),
      v.literal("error"),
      v.literal("truncated"),
    ),
    nowMs: v.number(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const stream = await ctx.db
      .query("stella_relay_response_streams")
      .withIndex("by_relayRequestId", (q) =>
        q.eq("relayRequestId", args.relayRequestId),
      )
      .unique();
    if (stream?.status === "streaming") {
      await ctx.db.patch(stream._id, {
        status: args.status,
        updatedAt: args.nowMs,
      });
    }
    return null;
  },
});

const relayResumeSnapshotValidator = v.union(
  v.null(),
  v.object({
    ownerId: v.string(),
    status: relayResumeStatusValidator,
    expiresAt: v.number(),
    updatedAt: v.number(),
    lastSequence: v.number(),
    responseId: v.optional(v.string()),
    upstreamRequestId: v.optional(v.string()),
    lastEventType: v.optional(v.string()),
    lastResponseStatus: v.optional(v.string()),
    events: v.array(relayResumeStoredEventValidator),
  }),
);

export const getRelayResumeSnapshot = internalQuery({
  args: {
    relayRequestId: v.string(),
    startingAfter: v.number(),
    nowMs: v.number(),
  },
  returns: relayResumeSnapshotValidator,
  handler: async (ctx, args) => {
    const stream = await ctx.db
      .query("stella_relay_response_streams")
      .withIndex("by_relayRequestId", (q) =>
        q.eq("relayRequestId", args.relayRequestId),
      )
      .unique();
    if (!stream) return null;
    const chunks = await ctx.db
      .query("stella_relay_response_chunks")
      .withIndex("by_relayRequestId_and_chunkIndex", (q) =>
        q.eq("relayRequestId", args.relayRequestId),
      )
      .order("asc")
      .take(64);
    return {
      ownerId: stream.ownerId,
      status: stream.status,
      expiresAt: stream.expiresAt,
      updatedAt: stream.updatedAt,
      lastSequence: stream.lastSequence,
      responseId: stream.responseId,
      upstreamRequestId: stream.upstreamRequestId,
      lastEventType: stream.lastEventType,
      lastResponseStatus: stream.lastResponseStatus,
      events: chunks.flatMap((chunk) =>
        chunk.events.filter((event) => event.sequence > args.startingAfter),
      ),
    };
  },
});

export const purgeExpiredRelayResumeStreams = internalMutation({
  args: {
    nowMs: v.optional(v.number()),
    limit: v.optional(v.number()),
  },
  returns: v.object({ streams: v.number(), chunks: v.number() }),
  handler: async (ctx, args) => {
    const nowMs = args.nowMs ?? Date.now();
    const limit = Math.max(1, Math.min(200, Math.floor(args.limit ?? 100)));
    const expiredStreams = await ctx.db
      .query("stella_relay_response_streams")
      .withIndex("by_expiresAt", (q) => q.lte("expiresAt", nowMs))
      .take(limit);
    let chunksDeleted = 0;
    for (const stream of expiredStreams) {
      const chunks = await ctx.db
        .query("stella_relay_response_chunks")
        .withIndex("by_relayRequestId_and_chunkIndex", (q) =>
          q.eq("relayRequestId", stream.relayRequestId),
        )
        .take(64);
      for (const chunk of chunks) {
        await ctx.db.delete(chunk._id);
        chunksDeleted += 1;
      }
      await ctx.db.delete(stream._id);
    }
    const orphanChunks = await ctx.db
      .query("stella_relay_response_chunks")
      .withIndex("by_expiresAt", (q) => q.lte("expiresAt", nowMs))
      .take(limit);
    for (const chunk of orphanChunks) {
      await ctx.db.delete(chunk._id);
      chunksDeleted += 1;
    }
    return { streams: expiredStreams.length, chunks: chunksDeleted };
  },
});

/**
 * Deletes one owner's short-lived relay stream records and their event chunks.
 * Account deletion and user-requested cloud reset loop this mutation until it
 * returns false so response event data does not wait for the TTL cron.
 */
export const deleteOwnerRelayResumeStream = internalMutation({
  args: { ownerId: v.string() },
  returns: v.object({ hasMore: v.boolean() }),
  handler: async (ctx, args) => {
    const [stream] = await ctx.db
      .query("stella_relay_response_streams")
      .withIndex("by_ownerId_and_createdAt", (q) =>
        q.eq("ownerId", args.ownerId),
      )
      .take(1);
    if (!stream) return { hasMore: false };

    const chunks = await ctx.db
      .query("stella_relay_response_chunks")
      .withIndex("by_relayRequestId_and_chunkIndex", (q) =>
        q.eq("relayRequestId", stream.relayRequestId),
      )
      .take(64);
    await Promise.all(chunks.map((chunk) => ctx.db.delete(chunk._id)));
    await ctx.db.delete(stream._id);
    return { hasMore: true };
  },
});

type RelayResumeSnapshot = {
  ownerId: string;
  status:
    | "streaming"
    | "completed"
    | "failed"
    | "error"
    | "canceled"
    | "upstream_eof"
    | "truncated";
  expiresAt: number;
  updatedAt: number;
  lastSequence: number;
  responseId?: string;
  upstreamRequestId?: string;
  lastEventType?: string;
  lastResponseStatus?: string;
  events: Array<{ sequence: number; frame: string }>;
};

const relayResumeSnapshot = async (
  ctx: ActionCtx,
  relayRequestId: string,
  startingAfter: number,
): Promise<RelayResumeSnapshot | null> =>
  await ctx.runQuery(internal.stella_provider.getRelayResumeSnapshot, {
    relayRequestId,
    startingAfter,
    nowMs: Date.now(),
  });

const relayResumeIdFromRequest = (request: Request): string | null => {
  const pathname = new URL(request.url).pathname;
  const match = /\/responses\/([A-Za-z0-9_-]+)$/u.exec(pathname);
  return match?.[1] ?? null;
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

export const stellaProviderResume = httpAction(async (ctx, request) => {
  const identity = await ctx.auth.getUserIdentity();
  if (!identity) {
    return stellaProviderErrorResponse(401, "Unauthorized", request);
  }
  const relayRequestId = relayResumeIdFromRequest(request);
  const startingAfter = relayResumeCursorFromRequest(request);
  if (!relayRequestId || startingAfter === null) {
    return stellaProviderErrorResponse(
      400,
      "Invalid relay resume cursor",
      request,
    );
  }

  const initial = await relayResumeSnapshot(ctx, relayRequestId, startingAfter);
  const now = Date.now();
  const access = decideRelayResumeAccess({
    ownerId: identity.tokenIdentifier,
    snapshot: initial,
    startingAfter,
    nowMs: now,
  });
  if (!access.ok) {
    return stellaProviderErrorResponse(access.status, access.message, request);
  }
  if (!initial) {
    return stellaProviderErrorResponse(
      404,
      "Relay response not found",
      request,
    );
  }

  const headers = relayResumeHeaders(request);
  headers.set(STELLA_RELAY_REQUEST_ID_HEADER, relayRequestId);
  if (initial.responseId)
    headers.set("x-stella-response-id", initial.responseId);
  if (initial.upstreamRequestId) {
    headers.set("x-stella-upstream-request-id", initial.upstreamRequestId);
  }

  let downstreamOpen = true;
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    cancel() {
      downstreamOpen = false;
    },
    start(controller) {
      void (async () => {
        let cursor = startingAfter;
        try {
          while (downstreamOpen) {
            const snapshot = await relayResumeSnapshot(
              ctx,
              relayRequestId,
              cursor,
            );
            if (!snapshot || snapshot.ownerId !== identity.tokenIdentifier) {
              throw new Error("Relay response disappeared during resume");
            }
            for (const event of snapshot.events) {
              if (event.sequence <= cursor) continue;
              controller.enqueue(encoder.encode(event.frame));
              cursor = event.sequence;
            }

            const terminalSuffix = relayResumeTerminalSuffix(
              snapshot.status,
              snapshot.lastSequence,
            );
            if (terminalSuffix) {
              for (const frame of terminalSuffix) {
                controller.enqueue(encoder.encode(frame));
              }
              break;
            }
            const pollNow = Date.now();
            if (snapshot.expiresAt <= pollNow) {
              controller.enqueue(
                encoder.encode(
                  relayResumeSyntheticErrorFrame({
                    sequence: snapshot.lastSequence + 1,
                    code: "relay_stream_lost",
                    message:
                      "The Stella relay resume cursor expired. The original request was not replayed.",
                  }),
                ),
              );
              break;
            }
            if (relayResumeStreamIsStale(snapshot.updatedAt, pollNow)) {
              await ctx.runMutation(
                internal.stella_provider.finishRelayResumeStream,
                {
                  relayRequestId,
                  status: "upstream_eof",
                  nowMs: pollNow,
                },
              );
              continue;
            }
            await new Promise((resolve) =>
              setTimeout(resolve, STELLA_RELAY_RESUME_POLL_MS),
            );
          }
        } catch (error) {
          if (downstreamOpen) controller.error(error);
          downstreamOpen = false;
          return;
        }
        if (downstreamOpen) controller.close();
      })();
    },
  });

  return new Response(stream, { status: 200, headers });
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
  const result = await ctx.runMutation(
    internal.stella_provider.cancelRelayResumeStream,
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

const relayResumeCapableRequest = (
  authorized: AuthorizedStellaRequest,
  request: Request,
  response: Response,
): boolean =>
  authorized.relayProvider === "openai" &&
  authorized.ownerId !== "probe:stella-relay" &&
  isResponsesRequest(authorized.relayProvider, request) &&
  authorized.requestJson.stream === true &&
  response.ok &&
  response.headers.get("content-type")?.includes("text/event-stream") ===
    true &&
  new URL(request.url).pathname.startsWith(STELLA_RELAY_PATH_PREFIX);

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
    let upstreamResponse: Response;
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
    responseHeaders.set(
      "Access-Control-Allow-Origin",
      request.headers.get("origin") ?? "*",
    );
    responseHeaders.set("Vary", "Origin");
    responseHeaders.delete("content-length");

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
          // Best-effort provider error logging.
        }
      })();
    }

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

    let relayRequestId: string | undefined;
    if (relayResumeCapableRequest(authorized, request, upstreamResponse)) {
      const candidate = crypto.randomUUID();
      try {
        await ctx.runMutation(
          internal.stella_provider.createRelayResumeStream,
          {
            relayRequestId: candidate,
            ownerId: authorized.ownerId,
            provider: relayProvider,
            model: authorized.resolvedModel,
            upstreamStatus: upstreamResponse.status,
            upstreamRequestId: safeUpstreamRequestId(upstreamResponse.headers),
            nowMs: Date.now(),
          },
        );
        relayRequestId = candidate;
        responseHeaders.set(
          STELLA_RELAY_RESUME_HEADER,
          STELLA_RELAY_RESUME_VERSION,
        );
        responseHeaders.set(STELLA_RELAY_REQUEST_ID_HEADER, relayRequestId);
        responseHeaders.set(
          "Access-Control-Expose-Headers",
          `${STELLA_RELAY_RESUME_HEADER}, ${STELLA_RELAY_REQUEST_ID_HEADER}`,
        );
      } catch (error) {
        console.error(
          "[stella-provider] Failed to initialize relay resume:",
          error,
        );
      }
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
              internal.stella_provider.finishRelayResumeStream,
              { relayRequestId, status, nowMs: Date.now() },
            );
          };
          const persistAndForward = async (events: RelayResumeEvent[]) => {
            if (!relayRequestId || events.length === 0) return true;
            for (const batch of relayResumeChunkEvents(events)) {
              const result: {
                accepted: boolean;
                status: typeof relayStatus;
              } = await ctx.runMutation(
                internal.stella_provider.appendRelayResumeEvents,
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
                  relayStatus = await ctx.runMutation(
                    internal.stella_provider.touchRelayResumeStream,
                    { relayRequestId, nowMs: lastHeartbeatAt },
                  );
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
              for (const frame of frames) {
                if (frame.kind === "event") {
                  events.push(frame.event);
                  continue;
                }
                await persistAndForward(events);
                events = [];
                if (frame.kind === "passthrough" && !frame.replaySafe) {
                  await markUnrecoverable("truncated");
                }
                enqueue(encoder.encode(frame.frame));
              }
              const accepted = await persistAndForward(events);
              if (!accepted) {
                await reader.cancel();
                break;
              }
            }

            usageParser.pushText(usageDecoder.decode());
            if (resumeDecoder && resumeParser) {
              const finalFrames = resumeParser.push(resumeDecoder.decode());
              const finalEvents = finalFrames.flatMap((frame) =>
                frame.kind === "event" ? [frame.event] : [],
              );
              await persistAndForward(finalEvents);
              for (const frame of finalFrames) {
                if (frame.kind !== "event")
                  enqueue(encoder.encode(frame.frame));
              }
              const remainder = resumeParser.finish();
              if (remainder) enqueue(encoder.encode(remainder));
              if (relayStatus === "streaming") {
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
            await markUnrecoverable("upstream_eof").catch(() => undefined);
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
