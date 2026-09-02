/**
 * Renderer client for Stella-managed chat completions.
 *
 * Calls go straight to the model gateway
 * (`{gateway.origin}/v1/relay/chat/completions`) with a session capability,
 * never through Convex. The managed lane is request/response only: the
 * gateway streams from the provider internally and returns one complete
 * ChatCompletion object, so `stream` is always `false` here.
 */
import {
  GATEWAY_AGENT_TYPE_HEADER,
  GATEWAY_REQUEST_ID_HEADER,
  gatewayRelayBaseUrl,
  type GatewayErrorBody,
} from "@stella/contracts/gateway/api";
import { cloudApi } from "@/features/cloud/cloud-api";
import { convexClient } from "@/platform/convex/convex-client";
import {
  STELLA_DEFAULT_MODEL,
  extractChatText,
  type ChatCompletionResponse,
  type ChatMessage,
} from "@/shared/stella-api";
import { getGatewaySessionCapability } from "./gateway-session";

export { extractChatText };

const CHAT_COMPLETIONS_PATH = "/chat/completions";
const DEFAULT_AGENT_TYPE = "app";

export type ChatJsonRequest = {
  agentType: string;
  messages: ChatMessage[];
  headers?: Record<string, string>;
  body?: Record<string, unknown>;
};

export type StellaLlmMessageRequest = {
  messages: ChatMessage[];
  prompt?: never;
  systemPrompt?: never;
};

export type StellaLlmPromptRequest = {
  prompt: string;
  systemPrompt?: string;
  messages?: ChatMessage[];
};

export type StellaLlmRequest = (
  | StellaLlmMessageRequest
  | StellaLlmPromptRequest
) & {
  agentType?: string;
  model?: string;
  maxTokens?: number;
  temperature?: number;
  body?: Record<string, unknown>;
};

export interface StellaLlmTextOptions {
  agentType?: string;
  model?: string;
  systemPrompt?: string;
  maxTokens?: number;
  temperature?: number;
  body?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Gateway origin
// ---------------------------------------------------------------------------

let gatewayOriginPromise: Promise<string> | null = null;

const normalizeGatewayOrigin = (value: unknown): string => {
  const trimmed =
    typeof value === "string" ? value.trim().replace(/\/+$/, "") : "";
  if (!trimmed) {
    throw new Error(
      "Stella model gateway is not configured (MODEL_GATEWAY_URL on the backend).",
    );
  }
  return trimmed;
};

/**
 * The gateway origin Convex advertises for this deployment. Resolved once per
 * renderer session; a failed lookup is not cached so the next call retries.
 */
const resolveGatewayOrigin = (): Promise<string> => {
  if (!gatewayOriginPromise) {
    const pending = convexClient
      .query(cloudApi.getModelGatewayConfig, {})
      .then((config) => normalizeGatewayOrigin(config.origin));
    pending.catch(() => {
      if (gatewayOriginPromise === pending) gatewayOriginPromise = null;
    });
    gatewayOriginPromise = pending;
  }
  return gatewayOriginPromise;
};

// ---------------------------------------------------------------------------
// Request plumbing
// ---------------------------------------------------------------------------

type GatewayErrorDetail = {
  code: string;
  message: string;
  retryable: boolean;
};

const readGatewayErrorDetail = async (
  response: Response,
): Promise<GatewayErrorDetail> => {
  try {
    const body = (await response.json()) as Partial<GatewayErrorBody>;
    const error = body?.error;
    return {
      code: typeof error?.code === "string" ? error.code : "",
      message: typeof error?.message === "string" ? error.message : "",
      retryable: error?.retryable === true,
    };
  } catch {
    return { code: "", message: "", retryable: false };
  }
};

const shouldRefreshSessionCapability = (
  status: number,
  detail: GatewayErrorDetail,
): boolean =>
  (status === 401 &&
    detail.code !== "sign_in_required" &&
    detail.code !== "owner_suspended" &&
    detail.code !== "tier_paused" &&
    detail.code !== "concurrency_limit" &&
    detail.code !== "rate_limited") ||
  (status === 402 && detail.code === "budget_exhausted") ||
  (status === 429 && detail.code === "request_limit");

const postGatewayChatCompletion = async <TResponse>(args: {
  agentType: string;
  body: Record<string, unknown>;
  headers?: Record<string, string>;
  errorPrefix: string;
}): Promise<TResponse> => {
  const gatewayOrigin = await resolveGatewayOrigin();
  const url = `${gatewayRelayBaseUrl(gatewayOrigin)}${CHAT_COMPLETIONS_PATH}`;
  // Stable per call so a retry after a capability refresh replays the cached
  // result instead of running (and billing) the completion twice.
  const requestId = crypto.randomUUID();
  const payload = JSON.stringify({ ...args.body, stream: false });

  const send = (capability: string): Promise<Response> =>
    fetch(url, {
      method: "POST",
      headers: {
        ...args.headers,
        Authorization: `Bearer ${capability}`,
        "Content-Type": "application/json",
        [GATEWAY_AGENT_TYPE_HEADER]: args.agentType,
        [GATEWAY_REQUEST_ID_HEADER]: requestId,
      },
      body: payload,
    });

  let response = await send(await getGatewaySessionCapability(gatewayOrigin));
  let detail = response.ok
    ? { code: "", message: "", retryable: false }
    : await readGatewayErrorDetail(response.clone());
  if (shouldRefreshSessionCapability(response.status, detail)) {
    // An expired/revoked capability or a spent session ledger gets one fresh
    // capability and one replay of the same request id.
    response = await send(
      await getGatewaySessionCapability(gatewayOrigin, { forceRefresh: true }),
    );
    detail = response.ok
      ? { code: "", message: "", retryable: false }
      : await readGatewayErrorDetail(response.clone());
  }
  if (!response.ok) {
    const readableMessage =
      detail.message ||
      (detail.code === "sign_in_required"
        ? "Sign in to Stella to use Stella models."
        : "");
    const errorDetail = [detail.code, readableMessage]
      .filter(Boolean)
      .join(": ");
    throw new Error(
      `${args.errorPrefix} failed with HTTP ${response.status}${errorDetail ? ` (${errorDetail})` : ""}`,
    );
  }
  return (await response.json()) as TResponse;
};

// ---------------------------------------------------------------------------
// Public helpers
// ---------------------------------------------------------------------------

const messagesFromPrompt = (
  prompt: string,
  systemPrompt?: string,
  messages: ChatMessage[] = [],
): ChatMessage[] => [
  ...(systemPrompt ? [{ role: "system" as const, content: systemPrompt }] : []),
  ...messages,
  { role: "user", content: prompt },
];

const messagesForRequest = (options: StellaLlmRequest): ChatMessage[] =>
  typeof options.prompt === "string"
    ? messagesFromPrompt(options.prompt, options.systemPrompt, options.messages)
    : options.messages !== undefined
      ? options.messages
      : [];

const bodyForStellaLlm = (
  options: StellaLlmRequest,
): Record<string, unknown> => ({
  ...options.body,
  model: options.model ?? STELLA_DEFAULT_MODEL,
  messages: messagesForRequest(options),
  ...(options.maxTokens != null ? { max_tokens: options.maxTokens } : {}),
  ...(options.temperature != null ? { temperature: options.temperature } : {}),
});

/** Raw chat completion: the caller supplies the full body (model included). */
export async function callChatCompletion<TResponse = ChatCompletionResponse>(
  options: ChatJsonRequest,
): Promise<TResponse> {
  return await postGatewayChatCompletion<TResponse>({
    agentType: options.agentType,
    body: { ...options.body, messages: options.messages },
    headers: options.headers,
    errorPrefix: "Chat completion",
  });
}

export async function callStellaLlm<TResponse = ChatCompletionResponse>(
  options: StellaLlmRequest,
): Promise<TResponse> {
  return await postGatewayChatCompletion<TResponse>({
    agentType: options.agentType ?? DEFAULT_AGENT_TYPE,
    body: bodyForStellaLlm(options),
    errorPrefix: "Stella LLM call",
  });
}

export async function callStellaLlmText(
  prompt: string,
  options: StellaLlmTextOptions = {},
): Promise<string> {
  const response = await callStellaLlm({
    agentType: options.agentType,
    model: options.model,
    prompt,
    systemPrompt: options.systemPrompt,
    maxTokens: options.maxTokens,
    temperature: options.temperature,
    body: options.body,
  });
  return extractChatText(response).trim();
}
