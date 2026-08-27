import type { AssistantMessageDiagnostic } from "./utils/diagnostics.js";
import type { AssistantMessageEventStream } from "./utils/event-stream.js";

export type { AssistantMessageEventStream } from "./utils/event-stream.js";

export type KnownApi =
  | "openai-completions"
  | "openai-responses"
  | "azure-openai-responses"
  | "openai-codex-responses"
  | "anthropic-messages"
  | "bedrock-converse-stream"
  | "google-generative-ai"
  | "google-vertex";

export type Api = KnownApi | (string & {});

export type KnownProvider =
  | "amazon-bedrock"
  | "anthropic"
  | "google"
  | "google-vertex"
  | "openai"
  | "azure-openai-responses"
  | "openai-codex"
  | "deepseek"
  | "github-copilot"
  | "xai"
  | "cerebras"
  | "openrouter"
  | "vercel-ai-gateway"
  | "zai"
  | "minimax"
  | "minimax-cn"
  | "moonshotai"
  | "moonshotai-cn"
  | "huggingface"
  | "local"
  | "fireworks"
  | "meta"
  | "opencode"
  | "opencode-go"
  | "kimi-coding"
  | "cloudflare-workers-ai"
  | "cloudflare-ai-gateway"
  | "xiaomi"
  | "xiaomi-token-plan-cn"
  | "xiaomi-token-plan-ams"
  | "xiaomi-token-plan-sgp";
export type Provider = KnownProvider | string;

export type ThinkingLevel = "minimal" | "low" | "medium" | "high" | "xhigh";
export type ModelThinkingLevel = "off" | ThinkingLevel;
export type ThinkingLevelMap = Partial<
  Record<ModelThinkingLevel, string | null>
>;
export type ChatTemplateKwargValue =
  | string
  | number
  | boolean
  | null
  | {
      $var: "thinking.enabled" | "thinking.effort";
      omitWhenOff?: boolean;
    };

export interface ThinkingBudgets {
  minimal?: number;
  low?: number;
  medium?: number;
  high?: number;
}

export type CacheRetention = "none" | "short" | "long";

export type Transport = "sse" | "websocket" | "websocket-cached" | "auto";
export type ServiceTier =
  | "auto"
  | "default"
  | "flex"
  | "scale"
  | "priority"
  | null;

export interface ProviderResponse {
  status: number;
  headers: Record<string, string>;
}

export interface StreamOptions {
  temperature?: number;
  maxTokens?: number;

  omitMaxTokens?: boolean;
  signal?: AbortSignal;
  apiKey?: string;

  refreshApiKey?: () => Promise<string | undefined> | string | undefined;

  extraBody?: Record<string, unknown>;

  transport?: Transport;

  serviceTier?: ServiceTier;

  cacheRetention?: CacheRetention;

  sessionId?: string;

  promptCacheKey?: string;

  onPayload?: (
    payload: unknown,
    model: Model<Api>,
  ) => unknown | undefined | Promise<unknown | undefined>;

  onResponse?: (
    response: ProviderResponse,
    model: Model<Api>,
  ) => void | Promise<void>;

  onProviderRetry?: (info: {
    attempt: number;
    delayMs: number;
    reason?: string;
  }) => void;

  headers?: Record<string, string>;

  timeoutMs?: number;

  maxRetries?: number;

  maxRetryDelayMs?: number;

  metadata?: Record<string, unknown>;
}

export type ProviderStreamOptions = StreamOptions & Record<string, unknown>;

export interface SimpleStreamOptions extends StreamOptions {
  reasoning?: ThinkingLevel;

  disableReasoning?: boolean;

  thinkingBudgets?: ThinkingBudgets;
}

export type StreamFunction<
  TApi extends Api = Api,
  TOptions extends StreamOptions = StreamOptions,
> = (
  model: Model<TApi>,
  context: Context,
  options?: TOptions,
) => AssistantMessageEventStream;

export interface TextSignatureV1 {
  v: 1;
  id: string;
  phase?: "commentary" | "final_answer";
}

export interface TextContent {
  type: "text";
  text: string;
  textSignature?: string;
}

export interface ThinkingContent {
  type: "thinking";
  thinking: string;
  thinkingSignature?: string;

  redacted?: boolean;
}

export interface ImageContent {
  type: "image";
  data: string;
  mimeType: string;

  sourcePath?: string;
}

export interface ToolCall {
  type: "toolCall";
  id: string;
  name: string;
  arguments: Record<string, any>;
  thoughtSignature?: string;
}

export interface Usage {
  input: number;
  output: number;

  reasoning?: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  cost: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    total: number;
  };
}

export type StopReason = "stop" | "length" | "toolUse" | "error" | "aborted";

export interface UserMessage {
  role: "user";
  content: string | (TextContent | ImageContent)[];
  timestamp: number;
}

export interface AssistantMessage {
  role: "assistant";
  content: (TextContent | ThinkingContent | ToolCall)[];
  api: Api;
  provider: Provider;
  model: string;
  responseModel?: string;
  responseId?: string;
  diagnostics?: AssistantMessageDiagnostic[];
  usage: Usage;
  stopReason: StopReason;
  errorMessage?: string;

  retryAfterMs?: number;
  timestamp: number;
}

export interface ToolResultMessage<TDetails = any> {
  role: "toolResult";
  toolCallId: string;
  toolName: string;
  content: (TextContent | ImageContent)[];
  details?: TDetails;

  modelOutputTokens?: number;
  isError: boolean;
  timestamp: number;
}

export type Message = UserMessage | AssistantMessage | ToolResultMessage;

import type { TSchema } from "@sinclair/typebox";

export interface Tool<TParameters extends TSchema = TSchema> {
  name: string;
  description: string;
  parameters: TParameters;
}

export interface Context {
  systemPrompt?: string;
  messages: Message[];
  tools?: Tool[];
}

export type AssistantMessageEvent =
  | { type: "start"; partial: AssistantMessage }
  | { type: "text_start"; contentIndex: number; partial: AssistantMessage }
  | {
      type: "text_delta";
      contentIndex: number;
      delta: string;
      partial: AssistantMessage;
    }
  | {
      type: "text_end";
      contentIndex: number;
      content: string;
      partial: AssistantMessage;
    }
  | { type: "thinking_start"; contentIndex: number; partial: AssistantMessage }
  | {
      type: "thinking_delta";
      contentIndex: number;
      delta: string;
      partial: AssistantMessage;
    }
  | {
      type: "thinking_end";
      contentIndex: number;
      content: string;
      partial: AssistantMessage;
    }
  | { type: "toolcall_start"; contentIndex: number; partial: AssistantMessage }
  | {
      type: "toolcall_delta";
      contentIndex: number;
      delta: string;
      partial: AssistantMessage;
    }
  | {
      type: "toolcall_end";
      contentIndex: number;
      toolCall: ToolCall;
      partial: AssistantMessage;
    }
  | {
      type: "done";
      reason: Extract<StopReason, "stop" | "length" | "toolUse">;
      message: AssistantMessage;
    }
  | {
      type: "error";
      reason: Extract<StopReason, "aborted" | "error">;
      error: AssistantMessage;
    };

export interface OpenAICompletionsCompat {

  supportsStore?: boolean;

  supportsDeveloperRole?: boolean;

  supportsReasoningEffort?: boolean;

  supportsUsageInStreaming?: boolean;

  maxTokensField?: "max_completion_tokens" | "max_tokens";

  requiresToolResultName?: boolean;

  requiresAssistantAfterToolResult?: boolean;

  requiresThinkingAsText?: boolean;

  requiresReasoningContentOnAssistantMessages?: boolean;

  replayReasoningContentField?: boolean;

  thinkingFormat?:
    | "openai"
    | "openrouter"
    | "deepseek"
    | "zai"
    | "qwen"
    | "chat-template"
    | "qwen-chat-template";

  chatTemplateKwargs?: Record<string, ChatTemplateKwargValue>;

  openRouterRouting?: OpenRouterRouting;

  vercelGatewayRouting?: VercelGatewayRouting;

  zaiToolStream?: boolean;

  supportsStrictMode?: boolean;

  cacheControlFormat?: "anthropic";

  sendSessionAffinityHeaders?: boolean;

  supportsLongCacheRetention?: boolean;

  deferredToolsMode?: "kimi";
}

export interface OpenAIResponsesCompat {

  sendSessionIdHeader?: boolean;

  supportsLongCacheRetention?: boolean;

  supportsToolSearch?: boolean;
}

export interface AnthropicMessagesCompat {

  supportsEagerToolInputStreaming?: boolean;

  supportsLongCacheRetention?: boolean;

  supportsToolReferences?: boolean;
}

export interface OpenRouterRouting {

  allow_fallbacks?: boolean;

  require_parameters?: boolean;

  data_collection?: "deny" | "allow";

  zdr?: boolean;

  enforce_distillable_text?: boolean;

  order?: string[];

  only?: string[];

  ignore?: string[];

  quantizations?: string[];

  sort?:
    | string
    | {

        by?: string;

        partition?: string | null;
      };

  max_price?: {

    prompt?: number | string;

    completion?: number | string;

    image?: number | string;

    audio?: number | string;

    request?: number | string;
  };

  preferred_min_throughput?:
    | number
    | {

        p50?: number;

        p75?: number;

        p90?: number;

        p99?: number;
      };

  preferred_max_latency?:
    | number
    | {

        p50?: number;

        p75?: number;

        p90?: number;

        p99?: number;
      };
}

export interface VercelGatewayRouting {

  only?: string[];

  order?: string[];
}

export interface Model<TApi extends Api> {
  id: string;
  name: string;
  api: TApi;
  provider: Provider;
  baseUrl: string;
  reasoning: boolean;

  thinkingLevelMap?: ThinkingLevelMap;
  input: ("text" | "image")[];
  cost: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
  };
  contextWindow: number;
  maxTokens: number;

  toolOutputTokenLimit?: number;
  headers?: Record<string, string>;

  compat?: TApi extends "openai-completions"
    ? OpenAICompletionsCompat
    : TApi extends
          | "openai-responses"
          | "openai-codex-responses"
          | "azure-openai-responses"
      ? OpenAIResponsesCompat
      : TApi extends "anthropic-messages"
        ? AnthropicMessagesCompat
        : never;
}
