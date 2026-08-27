import { AGENT_IDS } from "../lib/agent_constants";
import {
  getManagedGatewayConfig,
  type ManagedGatewayProvider,
} from "../lib/managed_gateway";
import type { ManagedProtocol } from "../runtime_ai/managed";
export { getManagedGatewayConfig } from "../lib/managed_gateway";
export type { ManagedGatewayProvider } from "../lib/managed_gateway";

export const MANAGED_GATEWAY = getManagedGatewayConfig("openrouter");

type JSONValue =
  | string
  | number
  | boolean
  | null
  | JSONValue[]
  | { [key: string]: JSONValue };

export type ModelConfig = {
  model: string;
  fallback?: string;
  managedGatewayProvider?: ManagedGatewayProvider;
  fallbackManagedGatewayProvider?: ManagedGatewayProvider;

  api?: ManagedProtocol;
  temperature?: number;
  maxOutputTokens?: number;
  serviceTier?: string;
  fallbackServiceTier?: string;
  providerOptions?: Record<string, Record<string, JSONValue>>;
  fallbackProviderOptions?: Record<string, Record<string, JSONValue>>;
};

export const MANAGED_MODEL_AUDIENCES = [
  "anonymous",
  "free",
  "go",
  "pro",
  "go_fallback",
  "pro_fallback",
] as const;

export type ManagedModelAudience = (typeof MANAGED_MODEL_AUDIENCES)[number];

export const MODEL_MODES = [
  "standard",
  "priority",
  "light",
  "builder",
  "designer",
  "vision",
  "max",
] as const;

export type ModelMode = (typeof MODEL_MODES)[number];

type ModeConfig = Omit<
  ModelConfig,
  "fallback" | "fallbackManagedGatewayProvider" | "fallbackProviderOptions"
> & {
  fallbackMode?: ModelMode;
};

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const clone = <T>(value: T): T => structuredClone(value);

const deepMerge = <T>(base: T, patch?: Partial<T>): T => {
  if (!patch) return clone(base);

  if (!isPlainObject(base) || !isPlainObject(patch)) {
    return clone((patch as T | undefined) ?? base);
  }

  const output = clone(base) as Record<string, unknown>;
  for (const [key, patchValue] of Object.entries(patch)) {
    if (patchValue === undefined) continue;

    const baseValue = output[key];
    output[key] =
      isPlainObject(baseValue) && isPlainObject(patchValue)
        ? deepMerge(baseValue, patchValue)
        : clone(patchValue);
  }

  return output as T;
};

const gatewayOptions = (
  provider: ManagedGatewayProvider,
): Record<string, Record<string, JSONValue>> => ({
  gateway: {
    order: [provider],
  },
});

type DeepSeekV4FlashRoute = "crof" | "deepseek" | "fireworks";
const DEEPSEEK_V4_FLASH_ROUTE: DeepSeekV4FlashRoute = "crof";

export const DEEPSEEK_V4_FLASH_FIREWORKS_MODEL =
  "accounts/fireworks/models/deepseek-v4-flash-0731";

export const DEEPSEEK_V4_FLASH_DIRECT_MODEL = "deepseek/deepseek-v4-flash";

export const DEEPSEEK_V4_FLASH_CROF_MODEL = "crof/deepseek-v4-flash-0731";

export const DEEPSEEK_V4_FLASH_WAFER_FAST_MODEL =
  "wafer/deepseek-v4-flash-0731-fast";

const DEEPSEEK_V4_FLASH_CROF_CONFIG: ModeConfig = {
  model: DEEPSEEK_V4_FLASH_CROF_MODEL,
  managedGatewayProvider: "crof",
  temperature: 1.0,
  providerOptions: {
    openai: {
      reasoningEffort: "xhigh",
    },
  },
};

const DEEPSEEK_V4_FLASH_FIREWORKS_CONFIG: ModeConfig = {
  model: DEEPSEEK_V4_FLASH_FIREWORKS_MODEL,
  managedGatewayProvider: "fireworks",
  temperature: 1.0,
  providerOptions: {
    openai: {
      reasoningEffort: "medium",
    },
    ...gatewayOptions("fireworks"),
  },
};

const DEEPSEEK_V4_FLASH_DIRECT_CONFIG: ModeConfig = {
  model: DEEPSEEK_V4_FLASH_DIRECT_MODEL,
  managedGatewayProvider: "deepseek",

  temperature: 1.0,
  providerOptions: {
    openai: {

      reasoningEffort: "xhigh",
    },
  },
};

const DEEPSEEK_V4_FLASH_CONFIGS = {
  crof: DEEPSEEK_V4_FLASH_CROF_CONFIG,
  fireworks: DEEPSEEK_V4_FLASH_FIREWORKS_CONFIG,
  deepseek: DEEPSEEK_V4_FLASH_DIRECT_CONFIG,
} satisfies Record<DeepSeekV4FlashRoute, ModeConfig>;

const DEEPSEEK_V4_FLASH_MODEL_CONFIG: ModeConfig =
  DEEPSEEK_V4_FLASH_CONFIGS[DEEPSEEK_V4_FLASH_ROUTE];

export const MUSE_SPARK_1_2_CONTRIBUTOR_MODEL =
  "meta/muse-spark-1.2-contributor";

const MUSE_SPARK_1_2_CONTRIBUTOR_CONFIG: ModeConfig = {
  model: MUSE_SPARK_1_2_CONTRIBUTOR_MODEL,
  managedGatewayProvider: "openrouter",

  api: "openai-responses",
  temperature: 1.0,
  providerOptions: {
    openai: {
      reasoningEffort: "xhigh",
    },
  },
};

export const MANAGED_MODEL_GATEWAY_OVERRIDES: Readonly<
  Record<string, ManagedGatewayProvider>
> = {
  [MUSE_SPARK_1_2_CONTRIBUTOR_MODEL]: "openrouter",
};

export const MANAGED_MODEL_API_OVERRIDES: Readonly<
  Record<string, ManagedProtocol>
> = {
  [MUSE_SPARK_1_2_CONTRIBUTOR_MODEL]: "openai-responses",
};

const KIMI_K2_6_SYNTHESIS_CONFIG: ModelConfig = {
  model: "moonshotai/kimi-k2.6",
  managedGatewayProvider: "openrouter",
  maxOutputTokens: 32768,
  providerOptions: {
    openai: {
      reasoningEffort: "low",
    },
    gateway: {
      order: ["coreweave", "baseten", "together", "fireworks"],
      only: ["coreweave", "baseten", "together", "fireworks"],
      allow_fallbacks: true,
    },
  },
};

const GEMINI_3_1_FLASH_LITE_IMAGE_DESCRIPTION_CONFIG: ModelConfig = {
  model: "google/gemini-3.1-flash-lite",
  managedGatewayProvider: "google",
  maxOutputTokens: 4096,
  providerOptions: gatewayOptions("google"),
};

export const GEMINI_3_7_FLASH_OFFLINE_RESPONDER_MODEL =
  "google/gemini-3.7-flash";

const GEMINI_3_7_FLASH_OFFLINE_RESPONDER_CONFIG: ModelConfig = {
  model: GEMINI_3_7_FLASH_OFFLINE_RESPONDER_MODEL,
  managedGatewayProvider: "openrouter",
  maxOutputTokens: 65536,
  providerOptions: {
    openai: {
      reasoningEffort: "low",
    },
  },
};

const INTERNAL_MODEL_CONFIGS = {
  image_description: GEMINI_3_1_FLASH_LITE_IMAGE_DESCRIPTION_CONFIG,
  offline_responder: GEMINI_3_7_FLASH_OFFLINE_RESPONDER_CONFIG,
  synthesis: KIMI_K2_6_SYNTHESIS_CONFIG,
} as const satisfies Record<string, ModelConfig>;

type InternalModelConfigKey = keyof typeof INTERNAL_MODEL_CONFIGS;
type TaskModelSelection = ModelMode | InternalModelConfigKey;

const BASE_MODE_CONFIGS: Record<ModelMode, ModeConfig> = {
  standard: MUSE_SPARK_1_2_CONTRIBUTOR_CONFIG,
  priority: MUSE_SPARK_1_2_CONTRIBUTOR_CONFIG,
  light: MUSE_SPARK_1_2_CONTRIBUTOR_CONFIG,
  builder: MUSE_SPARK_1_2_CONTRIBUTOR_CONFIG,
  designer: MUSE_SPARK_1_2_CONTRIBUTOR_CONFIG,
  vision: MUSE_SPARK_1_2_CONTRIBUTOR_CONFIG,
  max: MUSE_SPARK_1_2_CONTRIBUTOR_CONFIG,
};

const AUDIENCE_MODE_OVERRIDES: Record<
  ManagedModelAudience,
  Partial<Record<ModelMode, Partial<ModeConfig>>>
> = {
  anonymous: {},
  free: {},
  go: {},
  pro: {},
  go_fallback: {},
  pro_fallback: {},
};

const DEFAULT_AGENT_OVERRIDES: Partial<Record<string, TaskModelSelection>> = {
  [AGENT_IDS.ORCHESTRATOR]: "light",
  [AGENT_IDS.GENERAL]: "light",
};

const AUDIENCE_AGENT_MODE_OVERRIDES: Partial<
  Record<ManagedModelAudience, Partial<Record<string, TaskModelSelection>>>
> = {
  anonymous: DEFAULT_AGENT_OVERRIDES,
  free: DEFAULT_AGENT_OVERRIDES,
  go: DEFAULT_AGENT_OVERRIDES,
  pro: DEFAULT_AGENT_OVERRIDES,
  go_fallback: DEFAULT_AGENT_OVERRIDES,
  pro_fallback: DEFAULT_AGENT_OVERRIDES,
};

const RESTRICTED_MODEL_OVERRIDE_AUDIENCES = new Set<ManagedModelAudience>([
  "anonymous",
  "free",
  "go",
  "go_fallback",
]);

export const canOverrideStellaModel = (
  audience: ManagedModelAudience,
): boolean => !RESTRICTED_MODEL_OVERRIDE_AUDIENCES.has(audience);

const UNPAID_MODEL_AUDIENCES = new Set<ManagedModelAudience>([
  "anonymous",
  "free",
]);

export const isPaidManagedAudience = (
  audience: ManagedModelAudience,
): boolean => !UNPAID_MODEL_AUDIENCES.has(audience);

const PAID_ONLY_STELLA_MODE_IDS: ReadonlySet<string> = new Set<string>([
  "stella/max",
]);

const RESTRICTED_AUDIENCE_ALLOWED_STELLA_MODEL_IDS: ReadonlySet<string> =
  new Set<string>([
    "stella/light",
    `stella/${MUSE_SPARK_1_2_CONTRIBUTOR_MODEL}`,
    `stella/${DEEPSEEK_V4_FLASH_CROF_MODEL}`,
    `stella/${DEEPSEEK_V4_FLASH_FIREWORKS_MODEL}`,
    `stella/${DEEPSEEK_V4_FLASH_DIRECT_MODEL}`,
    `stella/${DEEPSEEK_V4_FLASH_WAFER_FAST_MODEL}`,
  ]);

export const resolveManagedModelRouteAlias = (model: string): string =>
  model === DEEPSEEK_V4_FLASH_CROF_MODEL ||
  model === DEEPSEEK_V4_FLASH_FIREWORKS_MODEL ||
  model === DEEPSEEK_V4_FLASH_DIRECT_MODEL
    ? DEEPSEEK_V4_FLASH_MODEL_CONFIG.model
    : model;

export const isStellaModelAllowedForAudience = (
  modelId: string,
  audience: ManagedModelAudience,
): boolean => {

  if (!RESTRICTED_AUDIENCE_ALLOWED_STELLA_MODEL_IDS.has(modelId)) {
    return false;
  }
  if (!canOverrideStellaModel(audience)) {
    return RESTRICTED_AUDIENCE_ALLOWED_STELLA_MODEL_IDS.has(modelId);
  }
  if (PAID_ONLY_STELLA_MODE_IDS.has(modelId)) {
    return isPaidManagedAudience(audience);
  }
  return true;
};

export const LOCKED_AGENT_TYPES: ReadonlySet<string> = new Set<string>([
  "chronicle",

  AGENT_IDS.OFFLINE_RESPONDER,

  "image_description",
]);

export const TASK_MODEL_SELECTIONS: Record<string, TaskModelSelection> = {
  [AGENT_IDS.OFFLINE_RESPONDER]: "offline_responder",
  [AGENT_IDS.ORCHESTRATOR]: "light",
  [AGENT_IDS.GENERAL]: "light",
  [AGENT_IDS.INSTALL_UPDATE]: "light",
  [AGENT_IDS.FASHION]: "light",

  schedule: "light",
  synthesis: "synthesis",
  welcome: "light",
  asset_metadata: "light",
  dream: "light",
  chronicle: "light",
  image_description: "image_description",
  html_finish: "light",
};

const buildResolvedModeConfig = (
  mode: ModelMode,
  rawModeCatalog: Record<ModelMode, ModeConfig>,
): ModelConfig => {
  const config = rawModeCatalog[mode];
  return buildResolvedConfig(config, rawModeCatalog);
};

const buildResolvedConfig = (
  config: ModeConfig,
  rawModeCatalog: Record<ModelMode, ModeConfig>,
): ModelConfig => {
  const fallbackConfig = config.fallbackMode
    ? rawModeCatalog[config.fallbackMode]
    : undefined;

  return {
    model: config.model,
    fallback: fallbackConfig?.model,
    managedGatewayProvider: config.managedGatewayProvider,
    fallbackManagedGatewayProvider: fallbackConfig?.managedGatewayProvider,
    api: config.api,
    temperature: config.temperature,
    maxOutputTokens: config.maxOutputTokens,
    serviceTier: config.serviceTier,
    fallbackServiceTier: fallbackConfig?.serviceTier,
    providerOptions: config.providerOptions
      ? clone(config.providerOptions)
      : undefined,
    fallbackProviderOptions: fallbackConfig?.providerOptions
      ? clone(fallbackConfig.providerOptions)
      : undefined,
  };
};

const buildAudienceRawModeCatalog = (
  audience: ManagedModelAudience,
): Record<ModelMode, ModeConfig> => {
  const rawModeCatalog = {} as Record<ModelMode, ModeConfig>;

  for (const mode of MODEL_MODES) {
    rawModeCatalog[mode] = deepMerge(
      BASE_MODE_CONFIGS[mode],
      AUDIENCE_MODE_OVERRIDES[audience][mode],
    );
  }

  return rawModeCatalog;
};

const buildAudienceModeCatalog = (
  audience: ManagedModelAudience,
): Record<ModelMode, ModelConfig> => {
  const rawModeCatalog = buildAudienceRawModeCatalog(audience);
  const resolvedModeCatalog = {} as Record<ModelMode, ModelConfig>;
  for (const mode of MODEL_MODES) {
    resolvedModeCatalog[mode] = buildResolvedModeConfig(mode, rawModeCatalog);
  }

  return resolvedModeCatalog;
};

const buildAudienceAgentCatalog = (
  audience: ManagedModelAudience,
  modeCatalog: Record<ModelMode, ModelConfig>,
): Record<string, ModelConfig> => {
  const taskCatalog: Record<string, ModelConfig> = {};
  const audienceModeOverrides = AUDIENCE_AGENT_MODE_OVERRIDES[audience] ?? {};

  for (const [agentType, defaultSelection] of Object.entries(
    TASK_MODEL_SELECTIONS,
  )) {
    const selection = audienceModeOverrides[agentType] ?? defaultSelection;
    taskCatalog[agentType] = isModelMode(selection)
      ? clone(modeCatalog[selection])
      : clone(INTERNAL_MODEL_CONFIGS[selection]);
  }

  return taskCatalog;
};

const AUDIENCE_MODE_CONFIGS: Record<
  ManagedModelAudience,
  Record<ModelMode, ModelConfig>
> = {
  anonymous: buildAudienceModeCatalog("anonymous"),
  free: buildAudienceModeCatalog("free"),
  go: buildAudienceModeCatalog("go"),
  pro: buildAudienceModeCatalog("pro"),
  go_fallback: buildAudienceModeCatalog("go_fallback"),
  pro_fallback: buildAudienceModeCatalog("pro_fallback"),
};

export const AUDIENCE_AGENT_MODELS: Record<
  ManagedModelAudience,
  Record<string, ModelConfig>
> = {
  anonymous: buildAudienceAgentCatalog(
    "anonymous",
    AUDIENCE_MODE_CONFIGS.anonymous,
  ),
  free: buildAudienceAgentCatalog("free", AUDIENCE_MODE_CONFIGS.free),
  go: buildAudienceAgentCatalog("go", AUDIENCE_MODE_CONFIGS.go),
  pro: buildAudienceAgentCatalog("pro", AUDIENCE_MODE_CONFIGS.pro),
  go_fallback: buildAudienceAgentCatalog(
    "go_fallback",
    AUDIENCE_MODE_CONFIGS.go_fallback,
  ),
  pro_fallback: buildAudienceAgentCatalog(
    "pro_fallback",
    AUDIENCE_MODE_CONFIGS.pro_fallback,
  ),
};

export const AGENT_MODELS = AUDIENCE_AGENT_MODELS.free;
export const DEFAULT_MODEL = AGENT_MODELS[AGENT_IDS.OFFLINE_RESPONDER];

export const resolveManagedModelAudience = (args: {
  plan: "free" | "go" | "pro";
  isAnonymous?: boolean;
  downgraded?: boolean;
}): ManagedModelAudience => {
  if (args.isAnonymous) {
    return "anonymous";
  }
  if (args.plan === "free") {
    return "free";
  }
  if (args.downgraded) {
    return `${args.plan}_fallback` as ManagedModelAudience;
  }
  return args.plan;
};

export function getModeConfig(
  mode: ModelMode,
  audience: ManagedModelAudience = "free",
): ModelConfig {
  const config = AUDIENCE_MODE_CONFIGS[audience]?.[mode];
  if (!config) throw new Error(`No model mode config for mode: ${mode}`);
  return config;
}

export function getModelConfig(
  agentType: string,
  audience: ManagedModelAudience = "free",
): ModelConfig {
  const config =
    AUDIENCE_AGENT_MODELS[audience]?.[agentType] ?? AGENT_MODELS[agentType];
  if (!config) throw new Error(`No model config for agent type: ${agentType}`);
  return config;
}

export function hasModelConfig(agentType: string): boolean {
  return Object.prototype.hasOwnProperty.call(AGENT_MODELS, agentType);
}

export function isModelMode(value: string): value is ModelMode {
  return Object.prototype.hasOwnProperty.call(BASE_MODE_CONFIGS, value);
}

export const ADDITIONAL_MANAGED_MODEL_IDS = [
  DEEPSEEK_V4_FLASH_CROF_MODEL,

  DEEPSEEK_V4_FLASH_WAFER_FAST_MODEL,
] as const;

export function listManagedModelIds(): string[] {
  const modelIds = new Set<string>();

  const append = (value?: string) => {
    const trimmed = value?.trim();
    if (trimmed) {
      modelIds.add(trimmed);
    }
  };

  append(DEFAULT_MODEL.model);
  append(DEFAULT_MODEL.fallback);

  for (const modeCatalog of Object.values(AUDIENCE_MODE_CONFIGS)) {
    for (const config of Object.values(modeCatalog)) {
      append(config.model);
      append(config.fallback);
    }
  }

  for (const configMap of Object.values(AUDIENCE_AGENT_MODELS)) {
    for (const config of Object.values(configMap)) {
      append(config.model);
      append(config.fallback);
    }
  }

  for (const modelId of ADDITIONAL_MANAGED_MODEL_IDS) {
    append(modelId);
  }

  return Array.from(modelIds).sort();
}
