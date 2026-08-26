const STELLA_API_BASE_PATH = "/api/stella";
export const STELLA_MODELS_PATH = `${STELLA_API_BASE_PATH}/models`;
export const STELLA_CLOUD_MODEL_PATH = `${STELLA_API_BASE_PATH}/cloud-model`;
export const STELLA_PROMPTS_PATH = `${STELLA_API_BASE_PATH}/prompts`;
export const STELLA_RELAY_PATH_PREFIX = `${STELLA_API_BASE_PATH}/relay`;
export const STELLA_CHAT_COMPLETIONS_PATH = `${STELLA_RELAY_PATH_PREFIX}/chat/completions`;
export const STELLA_OPENROUTER_CHAT_COMPLETIONS_PATH = `${STELLA_API_BASE_PATH}/openrouter/api/v1/chat/completions`;
export const STELLA_OPENROUTER_RESPONSES_PATH = `${STELLA_API_BASE_PATH}/openrouter/api/v1/responses`;
export const STELLA_DEFAULT_MODEL = "stella/default";
export const STELLA_STANDARD_MODEL = "stella/standard";
/**
 * Muse Spark 1.2 Contributor on OpenRouter. Released today, so it is not yet in
 * models.dev — the backend carries a static price override until catalogs
 * catch up (see `STATIC_MANAGED_MODEL_PRICE_OVERRIDES`).
 */
export const STELLA_DEFAULT_UPSTREAM_MODEL = "meta/muse-spark-1.2-contributor";
/**
 * Former default: V4 Flash 0731 on CrofAI. Fully supported and still
 * selectable; the older DeepSeek and Fireworks spellings
 * (`accounts/fireworks/models/deepseek-v4-flash-0731`) stay routable through
 * the verbatim `stella/<provider>/<model>` path — see
 * `DEEPSEEK_V4_FLASH_ROUTE` in `convex/agent/model.ts`.
 */
export const STELLA_DEEPSEEK_V4_FLASH_UPSTREAM_MODEL =
  "crof/deepseek-v4-flash-0731";
/**
 * Wafer-hosted Fast variant of V4 Flash 0731. A separate selectable option
 * (never a default); ZDR is enforced per request at the relay.
 */
export const STELLA_WAFER_V4_FLASH_FAST_UPSTREAM_MODEL =
  "wafer/deepseek-v4-flash-0731-fast";

/** True for every routed spelling of the DeepSeek V4 Flash family. */
export const isDeepSeekV4FlashModel = (
  modelId: string | null | undefined,
): boolean =>
  typeof modelId === "string" &&
  modelId.toLowerCase().includes("deepseek-v4-flash");

/** True for the OpenRouter-hosted Muse Spark 1.2 Contributor default. */
export const isMuseSpark12ContributorModel = (
  modelId: string | null | undefined,
): boolean =>
  typeof modelId === "string" &&
  modelId.toLowerCase().includes("muse-spark-1.2-contributor");
export const STELLA_RELAY_PROVIDERS = [
  "anthropic",
  "openai",
  "google",
  "fireworks",
  "deepseek",
  "crof",
  "wafer",
  "openrouter",
] as const;
export type StellaRelayProvider = (typeof STELLA_RELAY_PROVIDERS)[number];

export const normalizeStellaSiteUrl = (value: string): string =>
  value
    .trim()
    .replace(/\/chat\/completions\/?$/i, "")
    .replace(/\/responses\/?$/i, "")
    .replace(/\/runtime\/?$/i, "")
    .replace(/\/models\/?$/i, "")
    .replace(/\/api\/stella\/v1\/?$/i, "")
    .replace(/\/api\/stella\/relay(?:\/.*)?$/i, "")
    .replace(
      /\/api\/stella\/(?:anthropic|openai|fireworks|deepseek|crof|wafer)(?:\/v1)?\/?$/i,
      "",
    )
    .replace(/\/api\/stella\/google\/v1beta\/?$/i, "")
    .replace(/\/api\/stella\/openrouter\/api\/v1\/?$/i, "")
    .replace(/\/api\/stella\/?$/i, "")
    .replace(/\/+$/, "");

const stellaUrlFromSiteUrl = (siteUrl: string, path: string): string =>
  `${normalizeStellaSiteUrl(siteUrl)}${path}`;

export const stellaApiBaseUrlFromSiteUrl = (siteUrl: string): string =>
  stellaUrlFromSiteUrl(siteUrl, STELLA_API_BASE_PATH);

export const stellaPromptEndpointFromSiteUrl = (siteUrl: string): string =>
  stellaUrlFromSiteUrl(siteUrl, STELLA_PROMPTS_PATH);

export const stellaCloudModelEndpointFromSiteUrl = (siteUrl: string): string =>
  stellaUrlFromSiteUrl(siteUrl, STELLA_CLOUD_MODEL_PATH);

export const stellaManagedRelayBaseUrlFromSiteUrl = (siteUrl: string): string =>
  stellaUrlFromSiteUrl(siteUrl, STELLA_RELAY_PATH_PREFIX);

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
