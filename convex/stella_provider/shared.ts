import type { ModelConfig } from "../agent/model";
import type { ManagedGatewayProvider } from "../lib/managed_gateway";

export type StellaRequestBody = Record<string, unknown>;

export type UpstreamHttpError = {
  status: number;
  message: string;
};

export type ResolvedStellaModelSelection = {
  requestedModel: string;
  resolvedModel: string;
  config: ModelConfig;
};

export type ResolvedManagedServerModelConfig = {
  model: string;
  temperature?: number;
  maxOutputTokens?: number;
  providerOptions?: Record<string, Record<string, unknown>>;
};

export type AuthorizedStellaRequest = {
  ownerId: string;
  agentType: string;
  relayProvider: ManagedGatewayProvider;
  requestJson: StellaRequestBody;
  requestedModel: string;
  resolvedModel: string;
  upstreamModel: string;
  serviceTier?: string;
  apiKey: string;
  tokenEstimate: import("./billing").TokenEstimate;
  anonymousUsageRecord?: import("./billing").AnonymousUsageRecord;
};

export const STELLA_API_BASE_PATH = "/api/stella";
export const STELLA_MODELS_PATH = `${STELLA_API_BASE_PATH}/models`;
export const STELLA_RELAY_PATH_PREFIX = `${STELLA_API_BASE_PATH}/relay/`;
export const STELLA_ANTHROPIC_MESSAGES_PATH = `${STELLA_API_BASE_PATH}/anthropic/v1/messages`;
export const STELLA_OPENAI_CHAT_COMPLETIONS_PATH = `${STELLA_API_BASE_PATH}/openai/v1/chat/completions`;
export const STELLA_OPENAI_RESPONSES_PATH = `${STELLA_API_BASE_PATH}/openai/v1/responses`;
export const STELLA_GOOGLE_MODELS_PATH_PREFIX = `${STELLA_API_BASE_PATH}/google/v1beta/models/`;
export const STELLA_FIREWORKS_RESPONSES_PATH = `${STELLA_API_BASE_PATH}/fireworks/v1/responses`;
export const STELLA_OPENROUTER_CHAT_COMPLETIONS_PATH = `${STELLA_API_BASE_PATH}/openrouter/api/v1/chat/completions`;

export const SSE_HEARTBEAT_INTERVAL_MS = 45_000;
export const SSE_STREAM_OPEN_COMMENT = new TextEncoder().encode(
  ": stella-stream-open\n\n",
);
export const SSE_HEARTBEAT_COMMENT = new TextEncoder().encode(
  ": keepalive\n\n",
);

export const STELLA_REQUEST_PASSTHROUGH_EXCLUSIONS = new Set([
  "model",
  "agentType",
  "messages",
  "stream",
  "tools",
  "temperature",
  "reasoning",
  "max_completion_tokens",
  "max_tokens",
  "maxOutputTokens",
  "reasoning_effort",
  "tool_choice",
  "response_format",
]);

export function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export async function parseRequestJson(
  request: Request,
): Promise<StellaRequestBody | null> {
  try {
    return (await request.json()) as StellaRequestBody;
  } catch {
    return null;
  }
}

export function toUpstreamHttpError(
  error: unknown,
): UpstreamHttpError | null {
  if (!error || typeof error !== "object") {
    return null;
  }

  const record = error as {
    status?: unknown;
    message?: unknown;
    error?: { message?: unknown };
  };
  const status = typeof record.status === "number" ? record.status : null;
  if (status === null || status < 400 || status >= 500) {
    return null;
  }

  const directMessage =
    typeof record.error?.message === "string"
      ? record.error.message
      : typeof record.message === "string"
        ? record.message.replace(/^\d+\s+/, "")
        : "Invalid Stella completion request";

  return {
    status,
    message: directMessage,
  };
}
