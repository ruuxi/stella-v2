export const MANAGED_GATEWAY_PROVIDERS = [
  "openrouter",
  "fireworks",
  "deepseek",
  "crof",
  "wafer",
  "xai",
  "openai",
  "anthropic",
  "google",
  "meta",
] as const;

export type ManagedGatewayProvider = (typeof MANAGED_GATEWAY_PROVIDERS)[number];

/**
 * Wire protocol a managed gateway speaks. Mirrors the union the Convex
 * runtime declares in `runtime_ai/managed.ts`; the two must stay identical.
 */
export type ManagedProtocol =
  | "openai-completions"
  | "openai-responses"
  | "anthropic-messages"
  | "google-generative-ai";

export type ManagedGatewayConfig = {
  provider: ManagedGatewayProvider;
  baseURL: string;
  /**
   * Primary Convex env var name for the managed upstream key. Some providers
   * accept additional documented aliases via `apiKeyEnvVarFallbacks`.
   */
  apiKeyEnvVar: string;
  /**
   * Optional secondary env var names tried when `apiKeyEnvVar` is unset.
   * Used for Meta's documented `MODEL_API_KEY` alias alongside Stella's
   * namespaced `META_MODEL_API_KEY`.
   */
  apiKeyEnvVarFallbacks?: readonly string[];
  /**
   * Static headers sent on every request to this gateway. Used for
   * provider-specific requirements like Wafer's per-request zero-data-
   * retention opt-in, which has no request-body equivalent.
   */
  extraHeaders?: Record<string, string>;
};

const MANAGED_GATEWAY_CONFIGS: Record<
  ManagedGatewayProvider,
  ManagedGatewayConfig
> = {
  openrouter: {
    provider: "openrouter",
    baseURL: "https://openrouter.ai/api/v1",
    apiKeyEnvVar: "OPENROUTER_API_KEY",
  },
  fireworks: {
    provider: "fireworks",
    baseURL: "https://api.fireworks.ai/inference/v1",
    apiKeyEnvVar: "FIREWORKS_API_KEY",
  },
  // DeepSeek first-party API. Both `/responses` and `/chat/completions` hang
  // off the root — there is no `/v1` segment for the Responses endpoint.
  deepseek: {
    provider: "deepseek",
    baseURL: "https://api.deepseek.com",
    apiKeyEnvVar: "DEEPSEEK_API_KEY",
  },
  // CrofAI (nahcrof) exposes an OpenAI-compatible Chat Completions API.
  crof: {
    provider: "crof",
    baseURL: "https://crof.ai/v1",
    apiKeyEnvVar: "CROF_API_KEY",
  },
  // Wafer exposes an OpenAI-compatible Chat Completions API. ZDR is opted
  // into per request — every call must carry the header below.
  wafer: {
    provider: "wafer",
    baseURL: "https://pass.wafer.ai/v1",
    apiKeyEnvVar: "WAFER_API_KEY",
    extraHeaders: { "Wafer-ZDR": "required" },
  },
  xai: {
    provider: "xai",
    baseURL: "https://api.x.ai/v1",
    apiKeyEnvVar: "XAI_API_KEY",
  },
  openai: {
    provider: "openai",
    baseURL: "https://api.openai.com/v1",
    apiKeyEnvVar: "OPENAI_API_KEY",
  },
  anthropic: {
    provider: "anthropic",
    baseURL: "https://api.anthropic.com/v1",
    apiKeyEnvVar: "ANTHROPIC_API_KEY",
  },
  google: {
    provider: "google",
    baseURL: "https://generativelanguage.googleapis.com",
    apiKeyEnvVar: "GOOGLE_AI_API_KEY",
  },
  // Meta Model API (Muse Spark). OpenAI-compatible chat completions / responses
  // at api.meta.ai. Stella hosts the key — no end-user BYOK for Meta.
  meta: {
    provider: "meta",
    baseURL: "https://api.meta.ai/v1",
    apiKeyEnvVar: "META_MODEL_API_KEY",
    // Meta's own docs export the key as MODEL_API_KEY; accept either name.
    apiKeyEnvVarFallbacks: ["MODEL_API_KEY"],
  },
};

const FIREWORKS_MODEL_PREFIXES = [
  "accounts/fireworks/models/",
  "accounts/fireworks/routers/",
] as const;

const DIRECT_MODEL_PROVIDER_PREFIXES = [
  ["deepseek/", "deepseek"],
  ["crof/", "crof"],
  ["wafer/", "wafer"],
  ["x-ai/", "xai"],
  ["xai/", "xai"],
  ["openai/", "openai"],
  ["anthropic/", "anthropic"],
  ["google/", "google"],
  // `meta/muse-spark-1.2` (first-party Meta Model API) belongs here, but the
  // OpenRouter-hosted `-contributor` variant must NOT match this prefix — its
  // mode config pins `managedGatewayProvider: "openrouter"`, which
  // `resolveManagedGatewayProvider` honors over prefix inference.
  ["meta/", "meta"],
  // OpenRouter-namespaced slugs (e.g. `openrouter/<vendor>/<model>`)
  // pass through the OpenRouter gateway verbatim.
  ["openrouter/", "openrouter"],
] as const;

export function getManagedGatewayConfig(
  provider: ManagedGatewayProvider = "openrouter",
): ManagedGatewayConfig {
  return MANAGED_GATEWAY_CONFIGS[provider];
}

/**
 * Env var names that may hold a gateway's upstream key: the primary name
 * first, then any documented aliases (`apiKeyEnvVarFallbacks`).
 */
export function listManagedGatewayApiKeyEnvVars(
  config: ManagedGatewayConfig,
): readonly string[] {
  return [config.apiKeyEnvVar, ...(config.apiKeyEnvVarFallbacks ?? [])];
}

/**
 * Resolve the managed upstream API key for a gateway from an explicit env
 * map, honoring the documented aliases. Runtime-agnostic: the caller passes
 * `process.env`, a Worker `env` binding, or a test fixture.
 */
export function resolveManagedGatewayApiKeyFromEnv(
  config: ManagedGatewayConfig,
  env: Readonly<Record<string, string | undefined>>,
): string | undefined {
  for (const envVar of listManagedGatewayApiKeyEnvVars(config)) {
    const value = env[envVar]?.trim();
    if (value) return value;
  }
  return undefined;
}

export function inferManagedGatewayProviderFromModel(
  model: string,
): ManagedGatewayProvider | undefined {
  const directProvider = DIRECT_MODEL_PROVIDER_PREFIXES.find(([prefix]) =>
    model.startsWith(prefix),
  )?.[1];
  if (directProvider) {
    return directProvider;
  }
  return FIREWORKS_MODEL_PREFIXES.some((prefix) => model.startsWith(prefix))
    ? "fireworks"
    : undefined;
}

export function resolveManagedGatewayProvider(args: {
  model: string;
  configuredProvider?: ManagedGatewayProvider;
}): ManagedGatewayProvider {
  return (
    args.configuredProvider ??
    inferManagedGatewayProviderFromModel(args.model) ??
    "openrouter"
  );
}

export function resolveManagedGatewayConfig(args: {
  model: string;
  configuredProvider?: ManagedGatewayProvider;
}): ManagedGatewayConfig {
  return getManagedGatewayConfig(resolveManagedGatewayProvider(args));
}
