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

export type ManagedGatewayConfig = {
  provider: ManagedGatewayProvider;
  baseURL: string;

  apiKeyEnvVar: string;

  apiKeyEnvVarFallbacks?: readonly string[];

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

  deepseek: {
    provider: "deepseek",
    baseURL: "https://api.deepseek.com",
    apiKeyEnvVar: "DEEPSEEK_API_KEY",
  },

  crof: {
    provider: "crof",
    baseURL: "https://crof.ai/v1",
    apiKeyEnvVar: "CROF_API_KEY",
  },

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

  meta: {
    provider: "meta",
    baseURL: "https://api.meta.ai/v1",
    apiKeyEnvVar: "META_MODEL_API_KEY",

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

  ["meta/", "meta"],

  ["openrouter/", "openrouter"],
] as const;

export function getManagedGatewayConfig(
  provider: ManagedGatewayProvider = "openrouter",
): ManagedGatewayConfig {
  return MANAGED_GATEWAY_CONFIGS[provider];
}

export function resolveManagedGatewayApiKey(
  config: ManagedGatewayConfig,
): string | undefined {
  const candidates = [
    config.apiKeyEnvVar,
    ...(config.apiKeyEnvVarFallbacks ?? []),
  ];
  for (const envVar of candidates) {
    const value = process.env[envVar]?.trim();
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
