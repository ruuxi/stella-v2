import OpenAI from "openai";
import type {
  ChatCompletionAssistantMessageParam,
  ChatCompletionChunk,
  ChatCompletionContentPart,
  ChatCompletionContentPartImage,
  ChatCompletionContentPartText,
  ChatCompletionMessageParam,
  ChatCompletionToolMessageParam,
} from "openai/resources/chat/completions.js";
import { AssistantMessageEventStream } from "./event_stream";
import { headersToRecord } from "./headers";
import { parseStreamingJson } from "./json_parse";
import { shortHash } from "./openai_responses_shared";
import { isRetryableProviderError } from "./retry";
import { supportsXhigh } from "./model_utils";
import { sanitizeSurrogates } from "./sanitize_unicode";
import { buildBaseOptions, clampReasoning } from "./simple_options";
import { transformMessages } from "./transform_messages";
import { normalizeProviderToolInputSchema } from "./tool_schema";
import { parseOpenAIChatUsage, type OpenAIChatUsagePayload } from "./usage";
import type {
  Api,
  AssistantMessage,
  Context,
  Message,
  Model,
  OpenAICompletionsCompat,
  SimpleStreamOptions,
  StopReason,
  StreamFunction,
  StreamOptions,
  TextContent,
  ThinkingContent,
  Tool,
  ToolCall,
  ToolResultMessage,
  Usage,
} from "./types";

function normalizeMistralToolId(id: string): string {
  let normalized = id.replace(/[^a-zA-Z0-9]/g, "");
  if (normalized.length < 9) {
    normalized = normalized + "ABCDEFGHI".slice(0, 9 - normalized.length);
  } else if (normalized.length > 9) {
    normalized = normalized.slice(0, 9);
  }
  return normalized;
}

export function hasToolHistory(messages: Message[]): boolean {
  for (const message of messages) {
    if (message.role === "toolResult") {
      return true;
    }
    if (
      message.role === "assistant" &&
      message.content.some((block) => block.type === "toolCall")
    ) {
      return true;
    }
  }
  return false;
}

export interface OpenAICompletionsOptions extends StreamOptions {
  toolChoice?:
    | "auto"
    | "none"
    | "required"
    | { type: "function"; function: { name: string } }
    | { type: "function"; name: string };
  reasoningEffort?: "minimal" | "low" | "medium" | "high" | "xhigh";
  responseFormat?: unknown;
}

function normalizeChatToolChoice(
  toolChoice: OpenAICompletionsOptions["toolChoice"],
):
  | "auto"
  | "none"
  | "required"
  | { type: "function"; function: { name: string } }
  | undefined {
  if (!toolChoice || typeof toolChoice === "string") {
    return toolChoice;
  }
  const record = toolChoice as Record<string, unknown>;
  const nested = record.function as Record<string, unknown> | undefined;
  const nestedName =
    nested && typeof nested.name === "string" ? nested.name : "";
  if (nestedName.length > 0) {
    return { type: "function", function: { name: nestedName } };
  }
  const directName = typeof record.name === "string" ? record.name : "";
  if (directName.length > 0) {
    return { type: "function", function: { name: directName } };
  }
  return undefined;
}

type ReasoningField = "reasoning_content" | "reasoning" | "reasoning_text";
/**
 * OpenRouter `reasoning_details` entries, replayed verbatim and in their
 * original order on later same-model turns.
 */
type ReasoningDetail = Record<string, unknown> & {
  type: "reasoning.summary" | "reasoning.encrypted" | "reasoning.text";
  id?: string | null;
  format?: string;
  index?: number;
  summary?: string;
  data?: string;
  text?: string;
  signature?: string | null;
};

const REASONING_FIELDS: readonly string[] = [
  "reasoning_content",
  "reasoning",
  "reasoning_text",
];

function isReasoningDetail(detail: unknown): detail is ReasoningDetail {
  if (typeof detail !== "object" || detail === null || Array.isArray(detail)) {
    return false;
  }
  const candidate = detail as Record<string, unknown>;
  if (
    !(candidate.id === undefined || candidate.id === null || typeof candidate.id === "string") ||
    !(candidate.format === undefined || typeof candidate.format === "string") ||
    !(candidate.index === undefined || typeof candidate.index === "number")
  ) {
    return false;
  }
  switch (candidate.type) {
    case "reasoning.summary":
      return typeof candidate.summary === "string";
    case "reasoning.encrypted":
      return typeof candidate.data === "string";
    case "reasoning.text":
      return (
        typeof candidate.text === "string" &&
        (candidate.signature === undefined ||
          candidate.signature === null ||
          typeof candidate.signature === "string")
      );
    default:
      return false;
  }
}

/** The full detail sequence persisted on a thinking block's signature. */
function parseReasoningDetails(
  signature: string | undefined,
): ReasoningDetail[] | undefined {
  if (!signature?.startsWith("[")) return undefined;
  try {
    const parsed = JSON.parse(signature) as unknown;
    return Array.isArray(parsed) && parsed.length > 0 && parsed.every(isReasoningDetail)
      ? parsed
      : undefined;
  } catch {
    return undefined;
  }
}

/** Older messages stored single encrypted details on tool calls. */
function parseLegacyEncryptedReasoningDetail(
  signature: string | undefined,
): ReasoningDetail | undefined {
  if (!signature?.startsWith("{")) return undefined;
  try {
    const parsed = JSON.parse(signature) as unknown;
    return isReasoningDetail(parsed) &&
      parsed.type === "reasoning.encrypted" &&
      typeof parsed.id === "string" &&
      parsed.id.length > 0 &&
      !!parsed.data
      ? parsed
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * OpenRouter streams reasoning_details as deltas: consecutive text/summary
 * deltas merge into one logical entry, encrypted entries stay discrete.
 */
function appendReasoningDetail(
  details: ReasoningDetail[],
  detail: ReasoningDetail,
): void {
  const last = details[details.length - 1];
  const mergeable =
    last?.type === detail.type &&
    (detail.type === "reasoning.text" || detail.type === "reasoning.summary");
  if (!last || !mergeable) {
    details.push({ ...detail });
    return;
  }
  if (detail.type === "reasoning.text") {
    last.text = (last.text ?? "") + (detail.text ?? "");
    last.signature ||= detail.signature;
  } else {
    last.summary = (last.summary ?? "") + (detail.summary ?? "");
  }
  last.id ??= detail.id;
  last.format ||= detail.format;
  last.index ??= detail.index;
}
type CompletionDeltaWithReasoning = NonNullable<
  ChatCompletionChunk.Choice["delta"]
> &
  Partial<Record<ReasoningField, string | null>> & {
    reasoning_details?: unknown[];
  };
type AssistantMessageWithExtras = ChatCompletionAssistantMessageParam &
  Partial<Record<ReasoningField, string>> & {
    reasoning_details?: ReasoningDetail[];
  };
type ToolResultMessageWithName = ChatCompletionToolMessageParam & {
  name?: string;
};
type OpenAIErrorWithMetadata = { error?: { metadata?: { raw?: string } } };

function toChatCompletionImagePart(item: {
  type: "image";
  url?: string;
  mimeType?: string;
  data?: string;
  detail?: "auto" | "low" | "high";
}): ChatCompletionContentPartImage | null {
  const url =
    item.url ||
    (item.mimeType && item.data
      ? `data:${item.mimeType};base64,${item.data}`
      : null);
  if (!url) {
    return null;
  }
  return {
    type: "image_url",
    image_url: {
      url,
      ...(item.detail ? { detail: item.detail } : {}),
    },
  } satisfies ChatCompletionContentPartImage;
}

export const streamOpenAICompletions: StreamFunction<
  "openai-completions",
  OpenAICompletionsOptions
> = (model, context, options) => {
  const stream = new AssistantMessageEventStream();

  void (async () => {
    const output: AssistantMessage = {
      role: "assistant",
      content: [],
      api: model.api,
      provider: model.provider,
      model: model.id,
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
      timestamp: Date.now(),
    };

    // OpenRouter requires the complete reasoning_details sequence replayed
    // unmodified and in order. They can arrive at any point (encrypted
    // entries often before their tool call), so collect them and persist the
    // sequence once at the end as the first thinking block's signature,
    // adding an empty block when no visible reasoning streamed.
    let streamedReasoningDetails: ReasoningDetail[] | undefined;
    const applyStreamedReasoningDetails = (emitEvents: boolean) => {
      if (!streamedReasoningDetails) return;
      const thinkingSignature = JSON.stringify(streamedReasoningDetails);
      streamedReasoningDetails = undefined;
      const existing = output.content.find(
        (block): block is ThinkingContent => block.type === "thinking",
      );
      if (existing) {
        existing.thinkingSignature = thinkingSignature;
        return;
      }
      output.content.push({ type: "thinking", thinking: "", thinkingSignature });
      if (emitEvents) {
        const contentIndex = output.content.length - 1;
        stream.push({ type: "thinking_start", contentIndex, partial: output });
        stream.push({ type: "thinking_end", contentIndex, content: "", partial: output });
      }
    };

    try {
      const compat = getCompat(model);
      const cacheSessionId =
        options?.cacheRetention === "none" ? undefined : options?.sessionId;
      const client = createClient(
        model,
        options?.apiKey,
        options?.headers,
        cacheSessionId,
        compat,
      );
      let params = buildOpenAICompletionsParams(model, context, options, true);
      const nextParams = await options?.onPayload?.(params, model);
      if (nextParams !== undefined) {
        params = nextParams as typeof params;
      }

      const requestOptions = {
        ...(options?.signal ? { signal: options.signal } : {}),
        ...(options?.timeoutMs !== undefined
          ? { timeout: options.timeoutMs }
          : {}),
        ...(options?.maxRetries !== undefined
          ? { maxRetries: options.maxRetries }
          : {}),
      };
      const { data: openaiStream, response } = await client.chat.completions
        .create(
          params as unknown as OpenAI.Chat.Completions.ChatCompletionCreateParamsStreaming,
          requestOptions,
        )
        .withResponse();
      await options?.onResponse?.(
        { status: response.status, headers: headersToRecord(response.headers) },
        model,
      );
      stream.push({ type: "start", partial: output });

      type StreamingToolCallBlock = ToolCall & {
        partialArgs?: string;
        streamIndex?: number;
      };

      let currentBlock:
        | TextContent
        | ThinkingContent
        | StreamingToolCallBlock
        | null = null;

      const finishCurrentBlock = (block: typeof currentBlock) => {
        if (!block) {
          return;
        }
        const contentIndex = output.content.indexOf(block);
        if (contentIndex === -1) {
          return;
        }
        if (block.type === "text") {
          stream.push({
            type: "text_end",
            contentIndex,
            content: block.text,
            partial: output,
          });
          return;
        }
        if (block.type === "thinking") {
          stream.push({
            type: "thinking_end",
            contentIndex,
            content: block.thinking,
            partial: output,
          });
          return;
        }
        block.arguments = parseStreamingJson(block.partialArgs);
        delete block.partialArgs;
        stream.push({
          type: "toolcall_end",
          contentIndex,
          toolCall: block,
          partial: output,
        });
      };

      for await (const chunk of openaiStream) {
        if (!chunk || typeof chunk !== "object") continue;

        // OpenAI documents ChatCompletionChunk.id as the unique chat completion identifier,
        // and each chunk in a streamed completion carries the same id.
        output.responseId ||= chunk.id;
        if (
          typeof chunk.model === "string" &&
          chunk.model.length > 0 &&
          chunk.model !== model.id
        ) {
          output.responseModel ||= chunk.model;
        }

        if (chunk.usage) {
          output.usage = parseOpenAIChatUsage(chunk.usage, model);
        }

        const choice = chunk.choices?.[0];
        if (!choice) {
          continue;
        }

        // Fallback: some providers (e.g., Moonshot) return usage in choice.usage
        if (!chunk.usage && "usage" in choice && choice.usage) {
          output.usage = parseOpenAIChatUsage(
            choice.usage as OpenAIChatUsagePayload,
            model,
          );
        }

        if (choice.finish_reason) {
          const finishReasonResult = mapStopReasonDetailed(
            choice.finish_reason,
          );
          output.stopReason = finishReasonResult.stopReason;
          if (finishReasonResult.errorMessage) {
            output.errorMessage = finishReasonResult.errorMessage;
          }
        }
        if (!choice.delta) {
          continue;
        }

        const deltaWithReasoning = choice.delta as CompletionDeltaWithReasoning;
        if (
          typeof choice.delta.content === "string" &&
          choice.delta.content.length > 0
        ) {
          if (!currentBlock || currentBlock.type !== "text") {
            finishCurrentBlock(currentBlock);
            currentBlock = { type: "text", text: "" };
            output.content.push(currentBlock);
            stream.push({
              type: "text_start",
              contentIndex: output.content.length - 1,
              partial: output,
            });
          }

          currentBlock.text += choice.delta.content;
          stream.push({
            type: "text_delta",
            contentIndex: output.content.length - 1,
            delta: choice.delta.content,
            partial: output,
          });
        }

        const reasoningFields: ReasoningField[] = [
          "reasoning_content",
          "reasoning",
          "reasoning_text",
        ];
        let reasoningField: ReasoningField | undefined;
        for (const field of reasoningFields) {
          const value = deltaWithReasoning[field];
          if (typeof value === "string" && value.length > 0) {
            reasoningField = field;
            break;
          }
        }

        if (reasoningField) {
          const delta = deltaWithReasoning[reasoningField] || "";
          if (!currentBlock || currentBlock.type !== "thinking") {
            finishCurrentBlock(currentBlock);
            currentBlock = {
              type: "thinking",
              thinking: "",
              thinkingSignature: reasoningField,
            };
            output.content.push(currentBlock);
            stream.push({
              type: "thinking_start",
              contentIndex: output.content.length - 1,
              partial: output,
            });
          }

          currentBlock.thinking += delta;
          stream.push({
            type: "thinking_delta",
            contentIndex: output.content.length - 1,
            delta,
            partial: output,
          });
        }

        if (choice.delta.tool_calls) {
          for (const toolCall of choice.delta.tool_calls) {
            const streamIndex =
              typeof toolCall.index === "number" ? toolCall.index : undefined;
            if (
              !currentBlock ||
              currentBlock.type !== "toolCall" ||
              (streamIndex !== undefined &&
                currentBlock.streamIndex !== streamIndex) ||
              (streamIndex === undefined &&
                toolCall.id &&
                currentBlock.id !== toolCall.id)
            ) {
              finishCurrentBlock(currentBlock);
              currentBlock = {
                type: "toolCall",
                id: toolCall.id || "",
                name: toolCall.function?.name || "",
                arguments: {},
                partialArgs: "",
                streamIndex,
              };
              output.content.push(currentBlock);
              stream.push({
                type: "toolcall_start",
                contentIndex: output.content.length - 1,
                partial: output,
              });
            }

            if (toolCall.id) {
              currentBlock.id = toolCall.id;
            }
            if (toolCall.function?.name) {
              currentBlock.name = toolCall.function.name;
            }

            const delta = toolCall.function?.arguments || "";
            if (delta) {
              currentBlock.partialArgs =
                (currentBlock.partialArgs || "") + delta;
              currentBlock.arguments = parseStreamingJson(
                currentBlock.partialArgs,
              );
            }
            stream.push({
              type: "toolcall_delta",
              contentIndex: output.content.length - 1,
              delta,
              partial: output,
            });
          }
        }

        if (Array.isArray(deltaWithReasoning.reasoning_details)) {
          for (const detail of deltaWithReasoning.reasoning_details) {
            if (!isReasoningDetail(detail)) continue;
            streamedReasoningDetails ??= [];
            appendReasoningDetail(streamedReasoningDetails, detail);
          }
        }
      }

      finishCurrentBlock(currentBlock);
      applyStreamedReasoningDetails(true);

      if (options?.signal?.aborted) {
        throw new Error("Request was aborted");
      }
      if (output.stopReason === "aborted") {
        throw new Error("Request was aborted");
      }
      if (output.stopReason === "error") {
        throw new Error(
          output.errorMessage || "Provider returned an error stop reason",
        );
      }

      stream.push({ type: "done", reason: output.stopReason, message: output });
      stream.end();
    } catch (error) {
      applyStreamedReasoningDetails(false);
      output.stopReason = options?.signal?.aborted ? "aborted" : "error";
      output.errorMessage =
        error instanceof Error ? error.message : JSON.stringify(error);
      if (!options?.signal?.aborted && isRetryableProviderError(error)) {
        output.providerOutcomeUnknown = true;
      }
      const rawMetadata = (error as OpenAIErrorWithMetadata | null)?.error
        ?.metadata?.raw;
      if (rawMetadata) {
        output.errorMessage += `\n${rawMetadata}`;
      }
      stream.push({ type: "error", reason: output.stopReason, error: output });
      stream.end();
    }
  })();

  return stream;
};

export const streamSimpleOpenAICompletions: StreamFunction<
  "openai-completions",
  SimpleStreamOptions
> = (model, context, options) => {
  const base = buildBaseOptions(model, options, options?.apiKey);
  const reasoningEffort = supportsXhigh(model)
    ? options?.reasoning
    : clampReasoning(options?.reasoning);
  const toolChoice = (options as OpenAICompletionsOptions | undefined)
    ?.toolChoice;
  const responseFormat = (options as OpenAICompletionsOptions | undefined)
    ?.responseFormat;

  return streamOpenAICompletions(model, context, {
    ...base,
    reasoningEffort,
    toolChoice,
    responseFormat,
  });
};

function createClient(
  model: Model<"openai-completions">,
  apiKey?: string,
  optionsHeaders?: Record<string, string>,
  sessionId?: string,
  compat: Required<OpenAICompletionsCompat> = getCompat(model),
) {
  if (!apiKey) {
    throw new Error(`No API key for provider: ${model.provider}`);
  }

  const defaultHeaders: Record<string, string> = {
    ...model.headers,
  };
  if (model.provider === "openrouter" || model.baseUrl.includes("openrouter.ai")) {
    defaultHeaders["HTTP-Referer"] ??= "https://stella.sh";
    defaultHeaders["X-OpenRouter-Title"] ??= "Stella";
  }
  Object.assign(defaultHeaders, optionsHeaders);
  const isOpenRouter =
    model.provider === "openrouter" || model.baseUrl.includes("openrouter.ai");
  if (sessionId && isOpenRouter && model.compat?.sendSessionAffinityHeaders !== false) {
    // OpenRouter pins a session to one upstream provider via `x-session-id`,
    // keeping that provider's prompt cache warm across turns.
    defaultHeaders["x-session-id"] = sessionId;
  } else if (sessionId && compat.sendSessionAffinityHeaders) {
    defaultHeaders.session_id = sessionId;
    defaultHeaders["x-client-request-id"] = sessionId;
    defaultHeaders["x-session-affinity"] = sessionId;
  }

  return new OpenAI({
    apiKey,
    baseURL: model.baseUrl,
    maxRetries: 0,
    defaultHeaders,
  });
}

export function buildOpenAICompletionsParams(
  model: Model<"openai-completions">,
  context: Context,
  options?: OpenAICompletionsOptions,
  stream = true,
) {
  const compat = getCompat(model);
  const messages = convertMessages(model, context, compat);
  maybeAddOpenRouterAnthropicCacheControl(model, messages);

  const params: Record<string, unknown> = {
    model: model.id,
    messages,
    stream,
    ...(options?.extraBody ?? {}),
  };

  // Help upstream providers route requests to the same cache shard.
  // OpenAI Chat Completions, Fireworks, OpenRouter (where the underlying
  // provider supports it) all honor `prompt_cache_key`. Harmless to send
  // when ignored. Skip when caller explicitly opts out via cacheRetention.
  if (
    options?.sessionId &&
    options.sessionId.length > 0 &&
    (options as { cacheRetention?: string }).cacheRetention !== "none" &&
    params.prompt_cache_key === undefined
  ) {
    params.prompt_cache_key = options.sessionId;
  }
  if (
    options?.cacheRetention === "long" &&
    compat.supportsLongCacheRetention &&
    params.prompt_cache_retention === undefined
  ) {
    params.prompt_cache_retention = "24h";
  }

  if (stream && compat.supportsUsageInStreaming !== false) {
    params.stream_options = { include_usage: true };
  }
  if (compat.supportsStore) {
    params.store = false;
  }
  if (options?.maxTokens) {
    params[compat.maxTokensField] = options.maxTokens;
  }
  if (options?.temperature !== undefined) {
    params.temperature = options.temperature;
  }
  if (options?.serviceTier !== undefined) {
    params.service_tier = options.serviceTier;
  }
  if (context.tools) {
    params.tools = convertTools(context.tools, compat);
    if (compat.zaiToolStream) {
      params.tool_stream = true;
    }
  } else if (hasToolHistory(context.messages)) {
    params.tools = [];
  }
  const toolChoice = normalizeChatToolChoice(options?.toolChoice);
  if (toolChoice) {
    params.tool_choice = toolChoice;
  }
  if (options?.responseFormat !== undefined) {
    params.response_format = options.responseFormat;
  }

  if (compat.thinkingFormat === "zai" && model.reasoning) {
    params.enable_thinking = !!options?.reasoningEffort;
  } else if (compat.thinkingFormat === "qwen" && model.reasoning) {
    params.enable_thinking = !!options?.reasoningEffort;
  } else if (
    compat.thinkingFormat === "qwen-chat-template" &&
    model.reasoning
  ) {
    params.chat_template_kwargs = {
      enable_thinking: !!options?.reasoningEffort,
    };
  } else if (compat.thinkingFormat === "deepseek" && model.reasoning) {
    params.thinking = {
      type: options?.reasoningEffort ? "enabled" : "disabled",
    };
    if (options?.reasoningEffort) {
      params.reasoning_effort = mapReasoningEffort(
        options.reasoningEffort,
        compat.reasoningEffortMap,
      );
    }
  } else if (compat.thinkingFormat === "openrouter" && model.reasoning) {
    // OpenRouter normalizes reasoning across providers via a nested reasoning object.
    if (options?.reasoningEffort) {
      params.reasoning = {
        effort: mapReasoningEffort(
          options.reasoningEffort,
          compat.reasoningEffortMap,
        ),
      };
    } else {
      params.reasoning = { effort: "none" };
    }
  } else if (
    options?.reasoningEffort &&
    model.reasoning &&
    compat.supportsReasoningEffort
  ) {
    params.reasoning_effort = mapReasoningEffort(
      options.reasoningEffort,
      compat.reasoningEffortMap,
    );
  }

  if (
    model.baseUrl.includes("openrouter.ai") &&
    model.compat?.openRouterRouting
  ) {
    params.provider = model.compat.openRouterRouting;
  }

  if (
    model.baseUrl.includes("ai-gateway.vercel.sh") &&
    model.compat?.vercelGatewayRouting
  ) {
    const gatewayOptions: Record<string, string[]> = {};
    if (model.compat.vercelGatewayRouting.only) {
      gatewayOptions.only = model.compat.vercelGatewayRouting.only;
    }
    if (model.compat.vercelGatewayRouting.order) {
      gatewayOptions.order = model.compat.vercelGatewayRouting.order;
    }
    if (Object.keys(gatewayOptions).length > 0) {
      params.providerOptions = { gateway: gatewayOptions };
    }
  }

  return params;
}

function mapReasoningEffort(
  effort: NonNullable<OpenAICompletionsOptions["reasoningEffort"]>,
  reasoningEffortMap: Partial<
    Record<NonNullable<OpenAICompletionsOptions["reasoningEffort"]>, string>
  >,
): string {
  return reasoningEffortMap[effort] ?? effort;
}

function maybeAddOpenRouterAnthropicCacheControl(
  model: Model<"openai-completions">,
  messages: ChatCompletionMessageParam[],
) {
  // `~anthropic/*-latest` aliases route to Anthropic too.
  if (model.provider !== "openrouter" || !/^~?anthropic\//.test(model.id)) {
    return;
  }

  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    // A trailing tool result is the last turn in an agent loop.
    if (
      message.role !== "user" &&
      message.role !== "assistant" &&
      message.role !== "tool"
    ) {
      continue;
    }

    if (typeof message.content === "string") {
      message.content = [
        Object.assign(
          { type: "text" as const, text: message.content },
          { cache_control: { type: "ephemeral" } },
        ),
      ];
      return;
    }
    if (!Array.isArray(message.content)) {
      continue;
    }
    for (
      let partIndex = message.content.length - 1;
      partIndex >= 0;
      partIndex -= 1
    ) {
      const part = message.content[partIndex];
      if (part?.type === "text") {
        Object.assign(part, { cache_control: { type: "ephemeral" } });
        return;
      }
    }
  }
}

export function convertMessages<TApi extends Api>(
  model: Model<TApi>,
  context: Context,
  compat: Required<OpenAICompletionsCompat>,
): ChatCompletionMessageParam[] {
  const params: ChatCompletionMessageParam[] = [];

  const normalizeToolCallId = (id: string): string => {
    if (compat.requiresMistralToolIds) {
      return normalizeMistralToolId(id);
    }
    // Parallel Responses calls can share a call_id and differ only by item
    // id; Chat Completions requires distinct tool call ids.
    if (id.includes("|")) {
      const separatorIndex = id.indexOf("|");
      const callId = id.slice(0, separatorIndex).replace(/[^a-zA-Z0-9_-]/g, "_");
      const itemId = id.slice(separatorIndex + 1).replace(/[^a-zA-Z0-9_-]/g, "_");
      const combinedId = itemId.length > 0 ? `${callId}_${itemId}` : callId;
      if (combinedId.length <= 40) return combinedId;
      const hash = shortHash(id).slice(0, 8);
      return `${callId.slice(0, Math.max(1, 40 - hash.length - 1))}_${hash}`;
    }
    return model.provider === "openai" && id.length > 40 ? id.slice(0, 40) : id;
  };

  const transformedMessages = transformMessages(
    context.messages,
    model,
    normalizeToolCallId,
  );

  if (context.systemPrompt) {
    params.push({
      role:
        model.reasoning && compat.supportsDeveloperRole
          ? "developer"
          : "system",
      content: sanitizeSurrogates(context.systemPrompt),
    });
  }

  let lastRole: string | null = null;
  for (let index = 0; index < transformedMessages.length; index += 1) {
    const message = transformedMessages[index];

    if (
      compat.requiresAssistantAfterToolResult &&
      lastRole === "toolResult" &&
      message.role === "user"
    ) {
      params.push({
        role: "assistant",
        content: "I have processed the tool results.",
      });
    }

    if (message.role === "user") {
      if (typeof message.content === "string") {
        params.push({
          role: "user",
          content: sanitizeSurrogates(message.content),
        });
      } else {
        const content: ChatCompletionContentPart[] = message.content
          .map((item): ChatCompletionContentPart => {
            if (item.type === "text") {
              return {
                type: "text",
                text: sanitizeSurrogates(item.text),
              } satisfies ChatCompletionContentPartText;
            }
            return toChatCompletionImagePart(
              item,
            ) as ChatCompletionContentPartImage;
          })
          .filter(Boolean);
        const filtered = model.input.includes("image")
          ? content
          : content.filter((part) => part.type !== "image_url");
        if (filtered.length === 0) {
          continue;
        }
        params.push({
          role: "user",
          content: filtered,
        });
      }
      lastRole = message.role;
      continue;
    }

    if (message.role === "system" || message.role === "developer") {
      params.push({
        role:
          message.role === "developer" &&
          !(model.reasoning && compat.supportsDeveloperRole)
            ? "system"
            : message.role,
        content: sanitizeSurrogates(message.content),
      });
      lastRole = message.role;
      continue;
    }

    if (message.role === "assistant") {
      const assistantMessage: AssistantMessageWithExtras = {
        role: "assistant",
        content: compat.requiresAssistantAfterToolResult ? "" : null,
      };

      const textBlocks = message.content.filter(
        (block): block is TextContent =>
          block.type === "text" && block.text.trim().length > 0,
      );
      if (textBlocks.length > 0) {
        assistantMessage.content = textBlocks
          .map((block) => sanitizeSurrogates(block.text))
          .join("");
      }

      const toolCalls = message.content.filter(
        (block): block is ToolCall => block.type === "toolCall",
      );
      // Same-model reasoning_details replay verbatim; they replace the raw
      // reasoning field. Older messages carried encrypted details on tool calls.
      const signedReasoningDetails = message.content
        .filter((block): block is ThinkingContent => block.type === "thinking")
        .map((block) => parseReasoningDetails(block.thinkingSignature))
        .find((details) => details !== undefined);
      const legacyReasoningDetails = toolCalls
        .map((toolCall) => parseLegacyEncryptedReasoningDetail(toolCall.thoughtSignature))
        .filter((detail): detail is ReasoningDetail => detail !== undefined);
      const preservedReasoningDetails =
        signedReasoningDetails ??
        (legacyReasoningDetails.length > 0 ? legacyReasoningDetails : undefined);

      const thinkingBlocks = message.content.filter(
        (block): block is ThinkingContent =>
          block.type === "thinking" && block.thinking.trim().length > 0,
      );
      if (
        thinkingBlocks.length > 0 &&
        !compat.requiresThinkingAsText &&
        !preservedReasoningDetails
      ) {
        const signature = thinkingBlocks[0].thinkingSignature;
        if (signature && REASONING_FIELDS.includes(signature)) {
          assistantMessage[signature as ReasoningField] = thinkingBlocks
            .map((block) => block.thinking)
            .join("\n");
        }
      }

      if (toolCalls.length > 0) {
        assistantMessage.tool_calls = toolCalls.map((toolCall) => ({
          id: toolCall.id,
          type: "function",
          function: {
            name: toolCall.name,
            arguments: JSON.stringify(toolCall.arguments),
          },
        }));
      }
      if (preservedReasoningDetails) {
        assistantMessage.reasoning_details = preservedReasoningDetails;
      }

      const hasContent =
        assistantMessage.content !== null &&
        assistantMessage.content !== undefined &&
        (typeof assistantMessage.content === "string"
          ? assistantMessage.content.length > 0
          : assistantMessage.content.length > 0);
      if (!hasContent && !assistantMessage.tool_calls) {
        continue;
      }

      params.push(assistantMessage);
      lastRole = message.role;
      continue;
    }

    const imageBlocks: Array<{
      type: "image_url";
      image_url: { url: string };
    }> = [];
    let nextIndex = index;
    for (
      ;
      nextIndex < transformedMessages.length &&
      transformedMessages[nextIndex].role === "toolResult";
      nextIndex += 1
    ) {
      const toolMessage = transformedMessages[nextIndex] as ToolResultMessage;
      const textResult = toolMessage.content
        .filter((block): block is TextContent => block.type === "text")
        .map((block) => block.text)
        .join("\n");
      const hasImages = toolMessage.content.some(
        (block) => block.type === "image",
      );
      const toolResult: ToolResultMessageWithName = {
        role: "tool",
        content: sanitizeSurrogates(
          textResult ||
            (hasImages ? "(see attached image)" : "(no tool output)"),
        ),
        tool_call_id: toolMessage.toolCallId,
      };
      if (compat.requiresToolResultName && toolMessage.toolName) {
        toolResult.name = toolMessage.toolName;
      }
      params.push(toolResult);

      if (model.input.includes("image")) {
        for (const block of toolMessage.content) {
          if (block.type === "image") {
            imageBlocks.push({
              type: "image_url",
              image_url: { url: `data:${block.mimeType};base64,${block.data}` },
            });
          }
        }
      }
    }

    index = nextIndex - 1;
    if (imageBlocks.length > 0) {
      if (compat.requiresAssistantAfterToolResult) {
        params.push({
          role: "assistant",
          content: "I have processed the tool results.",
        });
      }
      params.push({
        role: "user",
        content: [
          { type: "text", text: "Attached image(s) from tool result:" },
          ...imageBlocks,
        ],
      });
      lastRole = "user";
      continue;
    }

    lastRole = "toolResult";
  }

  return params;
}

export function convertTools(
  tools: Tool[],
  compat: Required<OpenAICompletionsCompat>,
) {
  return tools.map((tool) => ({
    type: "function" as const,
    function: {
      name: tool.name,
      description: tool.description,
      parameters: normalizeProviderToolInputSchema(tool.parameters),
      ...(compat.supportsStrictMode !== false && tool.strict !== undefined
        ? { strict: tool.strict }
        : {}),
    },
  }));
}

export function mapStopReason(
  reason: ChatCompletionChunk.Choice["finish_reason"] | string,
): StopReason {
  return mapStopReasonDetailed(reason).stopReason;
}

function mapStopReasonDetailed(
  reason: ChatCompletionChunk.Choice["finish_reason"] | string,
): { stopReason: StopReason; errorMessage?: string } {
  if (reason === null) return { stopReason: "stop" };
  switch (reason) {
    case "stop":
    case "end":
      return { stopReason: "stop" };
    case "length":
      return { stopReason: "length" };
    case "function_call":
    case "tool_calls":
      return { stopReason: "toolUse" };
    case "content_filter":
      return {
        stopReason: "error",
        errorMessage: "Provider finish_reason: content_filter",
      };
    case "network_error":
      return {
        stopReason: "error",
        errorMessage: "Provider finish_reason: network_error",
      };
    default:
      return {
        stopReason: "error",
        errorMessage: `Provider finish_reason: ${reason}`,
      };
  }
}

function detectCompat(
  model: Model<"openai-completions">,
): Required<OpenAICompletionsCompat> {
  const provider = model.provider;
  const baseUrl = model.baseUrl;
  const isZai = provider === "zai" || baseUrl.includes("api.z.ai");
  const isMistral = provider === "mistral" || baseUrl.includes("mistral.ai");
  const isNonStandard =
    provider === "cerebras" ||
    baseUrl.includes("cerebras.ai") ||
    provider === "xai" ||
    baseUrl.includes("api.x.ai") ||
    isMistral ||
    baseUrl.includes("chutes.ai") ||
    baseUrl.includes("deepseek.com") ||
    isZai ||
    provider === "opencode" ||
    baseUrl.includes("opencode.ai");

  const isGroq = provider === "groq" || baseUrl.includes("groq.com");
  const reasoningEffortMap =
    isGroq && model.id === "qwen/qwen3-32b"
      ? {
          minimal: "default",
          low: "default",
          medium: "default",
          high: "default",
          xhigh: "default",
        }
      : {};

  return {
    supportsStore: !isNonStandard,
    supportsDeveloperRole: !isNonStandard,
    supportsReasoningEffort: provider !== "xai" && !isZai,
    reasoningEffortMap,
    supportsUsageInStreaming: true,
    maxTokensField:
      isMistral || baseUrl.includes("chutes.ai")
        ? "max_tokens"
        : "max_completion_tokens",
    requiresToolResultName: isMistral,
    requiresAssistantAfterToolResult: false,
    requiresThinkingAsText: isMistral,
    requiresMistralToolIds: isMistral,
    thinkingFormat: isZai
      ? "zai"
      : provider === "deepseek" || baseUrl.includes("deepseek.com")
        ? "deepseek"
        : provider === "openrouter" || baseUrl.includes("openrouter.ai")
          ? "openrouter"
          : "openai",
    openRouterRouting: {},
    vercelGatewayRouting: {},
    zaiToolStream: false,
    supportsStrictMode: true,
    sendSessionAffinityHeaders: false,
    supportsLongCacheRetention: false,
  };
}

function getCompat(
  model: Model<"openai-completions">,
): Required<OpenAICompletionsCompat> {
  const detected = detectCompat(model);
  if (!model.compat) {
    return detected;
  }
  return {
    supportsStore: model.compat.supportsStore ?? detected.supportsStore,
    supportsDeveloperRole:
      model.compat.supportsDeveloperRole ?? detected.supportsDeveloperRole,
    supportsReasoningEffort:
      model.compat.supportsReasoningEffort ?? detected.supportsReasoningEffort,
    reasoningEffortMap:
      model.compat.reasoningEffortMap ?? detected.reasoningEffortMap,
    supportsUsageInStreaming:
      model.compat.supportsUsageInStreaming ??
      detected.supportsUsageInStreaming,
    maxTokensField: model.compat.maxTokensField ?? detected.maxTokensField,
    requiresToolResultName:
      model.compat.requiresToolResultName ?? detected.requiresToolResultName,
    requiresAssistantAfterToolResult:
      model.compat.requiresAssistantAfterToolResult ??
      detected.requiresAssistantAfterToolResult,
    requiresThinkingAsText:
      model.compat.requiresThinkingAsText ?? detected.requiresThinkingAsText,
    requiresMistralToolIds:
      model.compat.requiresMistralToolIds ?? detected.requiresMistralToolIds,
    thinkingFormat: model.compat.thinkingFormat ?? detected.thinkingFormat,
    openRouterRouting:
      model.compat.openRouterRouting ?? detected.openRouterRouting,
    vercelGatewayRouting:
      model.compat.vercelGatewayRouting ?? detected.vercelGatewayRouting,
    zaiToolStream: model.compat.zaiToolStream ?? detected.zaiToolStream,
    supportsStrictMode:
      model.compat.supportsStrictMode ?? detected.supportsStrictMode,
    sendSessionAffinityHeaders:
      model.compat.sendSessionAffinityHeaders ??
      detected.sendSessionAffinityHeaders,
    supportsLongCacheRetention:
      model.compat.supportsLongCacheRetention ??
      detected.supportsLongCacheRetention,
  };
}
