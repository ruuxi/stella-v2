/**
 * Convex-hosted Stella endpoints: the model catalog and the prompt bundle.
 * Model traffic itself goes to the model gateway advertised by the catalog
 * (`gateway.origin`, see `@stella/contracts/gateway/api`), never to Convex.
 */
const STELLA_API_BASE_PATH = "/api/stella";
export const STELLA_MODELS_PATH = `${STELLA_API_BASE_PATH}/models`;
export const STELLA_PROMPTS_PATH = `${STELLA_API_BASE_PATH}/prompts`;
export const STELLA_DEFAULT_MODEL = "stella/default";
export const STELLA_STANDARD_MODEL = "stella/standard";
/**
 * Muse Spark 1.3 Contributor on OpenRouter. Released today, so it is not yet in
 * models.dev — the backend carries a static price override until catalogs
 * catch up (see `STATIC_MANAGED_MODEL_PRICE_OVERRIDES`).
 */
export const STELLA_DEFAULT_UPSTREAM_MODEL = "meta/muse-spark-1.3-contributor";
/**
 * Fallback: V4 Flash 0731 on CrofAI. Fully supported and still selectable;
 * the older DeepSeek and Fireworks spellings
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

/** True for the OpenRouter-hosted Muse Spark 1.3 Contributor default. */
export const isMuseSpark13ContributorModel = (
  modelId: string | null | undefined,
): boolean =>
  typeof modelId === "string" &&
  modelId.toLowerCase().includes("muse-spark-1.3-contributor");
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

/**
 * Reduce a configured Stella site URL to its root. Accepts the root itself or
 * one of the Convex-hosted Stella endpoints (`/api/stella`, `/models`,
 * `/prompts`), with or without a trailing slash.
 */
export const normalizeStellaSiteUrl = (value: string): string =>
  value
    .trim()
    .replace(/\/api\/stella\/(?:models|prompts)\/?$/i, "")
    .replace(/\/api\/stella\/?$/i, "")
    .replace(/\/+$/, "");

const stellaUrlFromSiteUrl = (siteUrl: string, path: string): string =>
  `${normalizeStellaSiteUrl(siteUrl)}${path}`;

export const stellaApiBaseUrlFromSiteUrl = (siteUrl: string): string =>
  stellaUrlFromSiteUrl(siteUrl, STELLA_API_BASE_PATH);

export const stellaPromptEndpointFromSiteUrl = (siteUrl: string): string =>
  stellaUrlFromSiteUrl(siteUrl, STELLA_PROMPTS_PATH);

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
