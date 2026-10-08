/**
 * Backend-hosted Stella endpoints: the model catalog and the prompt bundle.
 * Model traffic itself goes to the model gateway advertised by the catalog
 * (`gateway.origin`, see `@stella/contracts/gateway/api`), never to the backend.
 */
const STELLA_API_BASE_PATH = "/api/stella";
export const STELLA_MODELS_PATH = `${STELLA_API_BASE_PATH}/models`;
export const STELLA_PROMPTS_PATH = `${STELLA_API_BASE_PATH}/prompts`;
export const STELLA_DEFAULT_MODEL = "stella/default";
export const STELLA_STANDARD_MODEL = "stella/standard";
/** OpenAI GPT-6 Luna on OpenRouter. */
export const STELLA_DEFAULT_UPSTREAM_MODEL = "openai/gpt-6-luna";
/** Shared Flash route identity for clients and the gateway. */
export const STELLA_DEEPSEEK_V4_FLASH_UPSTREAM_MODEL =
  "deepseek/deepseek-v4.1-flash";

/** True for every routed spelling of the DeepSeek V4 Flash family. */
export const isDeepSeekV4FlashModel = (
  modelId: string | null | undefined,
): boolean =>
  typeof modelId === "string" &&
  /deepseek-v4(?:\.1)?-flash/i.test(modelId);

export const STELLA_RELAY_PROVIDERS = [
  "anthropic",
  "openai",
  "google",
  "fireworks",
  "deepseek",
  "openrouter",
] as const;
export type StellaRelayProvider = (typeof STELLA_RELAY_PROVIDERS)[number];

/**
 * Reduce a configured Stella site URL to its root. Accepts the root itself or
 * one of the backend-hosted Stella endpoints (`/api/stella`, `/models`,
 * `/prompts`), with or without a trailing slash.
 */
export const normalizeStellaSiteUrl = (value: string): string =>
  value
    .trim()
    .replace(/\/api\/stella\/(?:models|prompts)\/?$/i, "")
    .replace(/\/api\/stella\/?$/i, "")
    .replace(/\/+$/, "");

/** A configured backend origin, normalized, or null when unset or blank. */
export const readConfiguredBackendUrl = (
  value: string | null | undefined,
): string | null => {
  if (typeof value !== "string") return null;
  const normalized = normalizeStellaSiteUrl(value);
  return normalized.length > 0 ? normalized : null;
};

const stellaUrlFromSiteUrl = (siteUrl: string, path: string): string =>
  `${normalizeStellaSiteUrl(siteUrl)}${path}`;

export const stellaApiBaseUrlFromSiteUrl = (siteUrl: string): string =>
  stellaUrlFromSiteUrl(siteUrl, STELLA_API_BASE_PATH);

type ChatContentPart =
  | { type?: string; text?: string }
  | {
      type: "image_url";
      image_url: { url: string; detail?: "auto" | "low" | "high" };
    };

type ChatToolCall = {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
};

export type ChatMessage = {
  role: "system" | "user" | "assistant" | "developer" | "tool";
  content: string | ChatContentPart[] | null;
  reasoning_content?: string;
  reasoning?: string;
  reasoning_text?: string;
  reasoning_signature?: string;
  tool_calls?: ChatToolCall[];
  tool_call_id?: string;
  name?: string;
};

export type ChatCompletionResponse = {
  choices?: Array<{
    message?: {
      role?: "assistant";
      content?: string | Array<{ type?: string; text?: string }> | null;
      reasoning_content?: string;
      reasoning?: string;
      reasoning_text?: string;
      reasoning_signature?: string;
      tool_calls?: ChatToolCall[];
    };
    delta?: {
      content?: string;
      reasoning_content?: string;
      reasoning?: string;
      reasoning_text?: string;
      reasoning_signature?: string;
      tool_calls?: Array<{
        index?: number;
        id?: string;
        type?: "function";
        function?: {
          name?: string;
          arguments?: string;
        };
      }>;
    };
  }>;
  usage?: {
    input_tokens?: number;
    prompt_tokens?: number;
    output_tokens?: number;
    completion_tokens?: number;
    prompt_tokens_details?: {
      cached_tokens?: number;
    };
    completion_tokens_details?: {
      reasoning_tokens?: number;
    };
  };
};

export function extractChatText(response: ChatCompletionResponse): string {
  const content = response.choices?.[0]?.message?.content;
  if (typeof content === "string") {
    return content.trim();
  }
  if (Array.isArray(content)) {
    return content
      .filter((part) => part?.type === "text" && typeof part.text === "string")
      .map((part) => part.text!.trim())
      .filter(Boolean)
      .join("\n")
      .trim();
  }
  return "";
}
