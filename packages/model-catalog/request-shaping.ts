/**
 * Provider-native request shaping for Stella's managed model relay: upstream
 * URL selection, header forwarding, and body normalization across the Chat
 * Completions / Responses / Anthropic Messages / Google wire shapes.
 */
import {
  getManagedGatewayConfig,
  type ManagedGatewayProvider,
  type ManagedProtocol,
} from "./managed-gateway";
import { downgradeUnsupportedRequestImages } from "./request-estimate";
import {
  isInternalRelayRequestHeader,
  nativeCredentialBody,
  type NativeRelayRequest,
} from "./native-relay";

export { isInternalRelayRequestHeader } from "./native-relay";

/** The fields of an authorized relay request that body shaping reads. */
export type RelayRequestShape = NativeRelayRequest & {
  resolvedModel: string;
  serviceTier?: string;
};

const providerModelPrefix: Partial<Record<ManagedGatewayProvider, string>> = {
  deepseek: "deepseek/",
  crof: "crof/",
  wafer: "wafer/",
  xai: "x-ai/",
  anthropic: "anthropic/",
  google: "google/",
  openai: "openai/",
  meta: "meta/",
};

/**
 * Wafer lists its models with capitalized slugs (e.g.
 * `DeepSeek-V4-Flash-0731-Fast`) while Stella's managed ids are lowercase.
 * Send the exact upstream casing wafer's catalog advertises.
 */
const WAFER_NATIVE_MODEL_IDS: Record<string, string> = {
  "deepseek-v4-flash-0731-fast": "DeepSeek-V4-Flash-0731-Fast",
};

export function toProviderNativeModel(
  model: string,
  provider: ManagedGatewayProvider,
): string {
  const prefix = providerModelPrefix[provider];
  const stripped =
    prefix && model.startsWith(prefix) ? model.slice(prefix.length) : model;
  if (provider === "anthropic") return stripped.replace(/\./g, "-");
  if (provider === "wafer") return WAFER_NATIVE_MODEL_IDS[stripped] ?? stripped;
  return stripped;
}

/** Match the backend runtime's managed-protocol selection exactly. */
export const resolveCloudManagedProtocol = (args: {
  relayProvider: ManagedGatewayProvider;
  configuredApi?: ManagedProtocol;
}): ManagedProtocol => {
  if (args.configuredApi) return args.configuredApi;
  switch (args.relayProvider) {
    case "fireworks":
    case "deepseek":
    case "xai":
    case "openai":
      return "openai-responses";
    case "anthropic":
      return "anthropic-messages";
    case "google":
      return "google-generative-ai";
    case "crof":
    case "wafer":
    case "openrouter":
    case "meta":
      return "openai-completions";
  }
};

export const cloneForwardHeaders = (
  request: Request,
  provider: ManagedGatewayProvider,
  apiKey: string,
  extraHeaders:
    | Readonly<Record<string, string>>
    | undefined = getManagedGatewayConfig(provider).extraHeaders,
): Headers => {
  const headers = new Headers();
  request.headers.forEach((value, key) => {
    if (isInternalRelayRequestHeader(key)) return;
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

  // Per-gateway requirements (Wafer's per-request ZDR opt-in) default to the
  // gateway config so the relay and runtime_ai share one definition.
  if (extraHeaders) {
    for (const [key, value] of Object.entries(extraHeaders)) {
      headers.set(key, value);
    }
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
    case "deepseek":
      // DeepSeek serves both APIs off the root. Honor whichever the client
      // asked for: desktop builds that predate the `deepseek/` prefix infer
      // `openrouter` and post chat completions, and they must keep working.
      return requestUrl.pathname.endsWith("/chat/completions")
        ? `${base}/chat/completions`
        : `${base}/responses`;
    case "crof":
      return `${base}/chat/completions`;
    case "wafer":
      // Wafer is OpenAI-compatible chat completions only.
      return `${base}/chat/completions`;
    case "xai":
      return requestUrl.pathname.endsWith("/chat/completions")
        ? `${base}/chat/completions`
        : `${base}/responses`;
    case "openrouter":
      // OpenRouter serves both APIs under /api/v1. Muse Spark 1.2
      // Contributor (the Stella default) goes through the Responses API;
      // every other OpenRouter-hosted model stays on chat completions.
      // Honor whichever the client asked for, mirroring the deepseek/xai
      // dual-API handling.
      return requestUrl.pathname.endsWith("/chat/completions")
        ? `${base}/chat/completions`
        : `${base}/responses`;
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

export const isResponsesRequest = (
  provider: ManagedGatewayProvider,
  request: Request,
): boolean => {
  if (
    provider !== "openai" &&
    provider !== "fireworks" &&
    provider !== "deepseek" &&
    provider !== "xai" &&
    provider !== "meta" &&
    // OpenRouter hosts the Responses API for Muse Spark 1.2 Contributor;
    // the request path (not the model) decides, so any OpenRouter client
    // that asks for /responses gets Responses end to end.
    provider !== "openrouter"
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

export const normalizeResponsesBody = (body: Record<string, unknown>): void => {
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

export const normalizeChatReasoning = (
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
    const raw =
      typeof effort === "string"
        ? effort
        : typeof topLevelEffort === "string"
          ? topLevelEffort
          : undefined;
    const safe = raw && raw !== "none" && raw !== "off" ? raw : "low";
    body.reasoning_effort = safe;
    body.reasoning = { effort: safe };
    return;
  }

  // Muse Spark always reasons: `reasoning_effort: "none"` 400s. Map Stella's
  // "none"/"off" efforts (and missing effort) to a safe default of "low".
  if (
    resolvedModel.startsWith("meta/muse-spark") ||
    resolvedModel.startsWith("muse-spark")
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

/**
 * Params DeepSeek documents as silently ignored. They cost nothing upstream,
 * but `store: true` in particular is a lie — the Responses API is stateless,
 * so `previous_response_id` continuations would fail. Dropping them keeps the
 * relayed body an honest description of what DeepSeek will actually do.
 */
export const DEEPSEEK_IGNORED_PARAMS = [
  "store",
  "include",
  "prompt_cache_key",
  "prompt_cache_retention",
  "previous_response_id",
  "conversation",
  "service_tier",
  "background",
  "metadata",
  "parallel_tool_calls",
] as const;

/**
 * DeepSeek V4 Flash's native effort ladder is `low | high | max`, so Stella's
 * wider set has to be clamped. This runs on the relay rather than only in the
 * client's `thinkingLevelMap` because already-shipped desktop builds send
 * efforts (`"medium"`, `"xhigh"`) that are not in DeepSeek's ladder.
 *
 * Stella runs this model at `max` unless the caller asked for something
 * cheaper, so anything unspecified or unrecognized lands there rather than on
 * DeepSeek's own `high` default.
 */
export const deepSeekReasoningEffort = (raw: unknown): string => {
  const value = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  switch (value) {
    case "none":
    case "off":
      return "none";
    case "minimal":
    case "low":
      return "low";
    case "medium":
      return "high";
    default:
      // "high", "xhigh", "max", and anything unrecognized or absent.
      return "max";
  }
};

export const crofReasoningEffort = (raw: unknown): string => {
  const value = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  switch (value) {
    case "none":
    case "off":
      return "none";
    case "minimal":
    case "low":
      return "low";
    case "medium":
      return "medium";
    default:
      return "high";
  }
};

export const normalizeCrofBody = (body: Record<string, unknown>): void => {
  const reasoning =
    body.reasoning &&
    typeof body.reasoning === "object" &&
    !Array.isArray(body.reasoning)
      ? (body.reasoning as Record<string, unknown>)
      : null;
  body.reasoning_effort = crofReasoningEffort(
    reasoning?.effort ?? body.reasoning_effort,
  );
  delete body.reasoning;
  delete body.thinking;
};

export const normalizeDeepSeekBody = (
  body: Record<string, unknown>,
  isResponses: boolean,
): void => {
  for (const key of DEEPSEEK_IGNORED_PARAMS) {
    delete body[key];
  }

  const reasoning =
    body.reasoning &&
    typeof body.reasoning === "object" &&
    !Array.isArray(body.reasoning)
      ? (body.reasoning as Record<string, unknown>)
      : null;
  const effort = deepSeekReasoningEffort(
    reasoning?.effort ?? body.reasoning_effort,
  );

  if (isResponses) {
    // `summary` is accepted but never generated; sending it is noise.
    body.reasoning = { effort };
    delete body.reasoning_effort;
    return;
  }

  // Chat completions use DeepSeek's own `thinking` object plus a top-level
  // `reasoning_effort`; the nested Responses-style object is not understood.
  body.thinking = { type: effort === "none" ? "disabled" : "enabled" };
  delete body.reasoning;
  if (effort === "none") {
    delete body.reasoning_effort;
  } else {
    body.reasoning_effort = effort;
  }
};

export const normalizeChatCompletionsBody = (
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
  authorized: RelayRequestShape,
  provider: ManagedGatewayProvider,
  request: Request,
): string => {
  if (authorized.userCredential) {
    return nativeCredentialBody(authorized);
  }
  const requestJson = downgradeUnsupportedRequestImages(
    authorized.requestJson,
    authorized.resolvedModel,
  );
  const body: Record<string, unknown> = {
    ...requestJson,
    model: toProviderNativeModel(authorized.resolvedModel, provider),
  };
  delete (body as Record<string, unknown>).agentType;
  // Service tier is a backend-owned billing/routing decision. Never forward a
  // caller-supplied tier to OpenAI-compatible gateways; add back only the
  // authorized Fireworks tier below.
  delete body.service_tier;
  if (provider === "google") {
    // Google REST puts the model in the URL path, not the body.
    delete body.model;
  }
  if (provider === "fireworks" && authorized.serviceTier !== undefined) {
    body.service_tier = authorized.serviceTier;
  }
  if (isResponsesRequest(provider, request)) {
    normalizeResponsesBody(body);
    if (provider !== "deepseek" && provider !== "openrouter") {
      // Keep provider-side response state available for Responses
      // continuations. DeepSeek is stateless and ignores `store` entirely;
      // OpenRouter's stateful behavior is unverified for this model, so the
      // relayed body stays limited to the verified request shape.
      body.store = true;
    }
  }

  const pathIsChatCompletions = new URL(request.url).pathname.endsWith(
    "/chat/completions",
  );
  const isChatCompletions = pathIsChatCompletions;
  if (provider === "deepseek") {
    if (pathIsChatCompletions) {
      normalizeChatCompletionsBody(body, authorized.resolvedModel);
    }
    normalizeDeepSeekBody(body, !pathIsChatCompletions);
  } else if (provider === "crof" || provider === "wafer") {
    // Wafer serves the same DeepSeek V4 Flash family over an OpenAI-
    // compatible chat completions API, so it shares Crof's effort ladder
    // and body normalization.
    normalizeChatCompletionsBody(body, authorized.resolvedModel);
    normalizeCrofBody(body);
  } else if (provider === "openrouter" && !pathIsChatCompletions) {
    // OpenRouter Responses (Muse Spark 1.2 Contributor): nested `reasoning`
    // only, same as Meta/xAI Responses. `normalizeChatReasoning` keeps the
    // model's mandatory reasoning present (mapping none/off to a safe low)
    // and materializes both wire forms; drop the chat-only one.
    normalizeChatReasoning(body, authorized.resolvedModel);
    delete body.reasoning_effort;
  } else if (
    provider === "openrouter" ||
    ((provider === "meta" || provider === "xai") && pathIsChatCompletions)
  ) {
    normalizeChatCompletionsBody(body, authorized.resolvedModel);
    if (provider === "meta" || provider === "xai") {
      // Direct Meta/xAI chat completions accept top-level `reasoning_effort`.
      delete body.reasoning;
    } else {
      // OpenRouter uses its normalized nested reasoning object.
      delete body.reasoning_effort;
    }
  } else if (
    (provider === "meta" || provider === "xai") &&
    !pathIsChatCompletions
  ) {
    // Meta/xAI Responses use nested `reasoning`, not top-level
    // `reasoning_effort`.
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
