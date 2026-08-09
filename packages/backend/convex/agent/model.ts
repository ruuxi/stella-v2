/**
 * Centralized model configuration for all AI requests.
 *
 * Model selection is split into:
 * - modes: reusable full model configs (model, fallback, routing, tokens, etc.)
 * - task mappings: each agent/task chooses a mode or direct internal model config
 * - audience overrides: sparse per-plan patches applied to modes
 */
import { AGENT_IDS } from "../lib/agent_constants";
import {
  getManagedGatewayConfig,
  type ManagedGatewayProvider,
} from "../lib/managed_gateway";
export { getManagedGatewayConfig } from "../lib/managed_gateway";
export type { ManagedGatewayProvider } from "../lib/managed_gateway";

// Legacy default for older call sites that still assume one gateway.
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

const DEEPSEEK_V4_FLASH_MODEL_CONFIG: ModeConfig = {
  model: "accounts/fireworks/models/deepseek-v4-flash-0731",
  managedGatewayProvider: "fireworks",
  temperature: 1.0,
  providerOptions: {
    openai: {
      reasoningEffort: "medium",
    },
    ...gatewayOptions("fireworks"),
  },
};

const GEMINI_3_6_FLASH_SYNTHESIS_CONFIG: ModelConfig = {
  model: "google/gemini-3.6-flash",
  fallback: DEEPSEEK_V4_FLASH_MODEL_CONFIG.model,
  managedGatewayProvider: "google",
  fallbackManagedGatewayProvider:
    DEEPSEEK_V4_FLASH_MODEL_CONFIG.managedGatewayProvider,
  maxOutputTokens: 32768,
  providerOptions: gatewayOptions("google"),
  fallbackProviderOptions: DEEPSEEK_V4_FLASH_MODEL_CONFIG.providerOptions,
};

const INTERNAL_MODEL_CONFIGS = {
  synthesis: GEMINI_3_6_FLASH_SYNTHESIS_CONFIG,
} as const satisfies Record<string, ModelConfig>;

type InternalModelConfigKey = keyof typeof INTERNAL_MODEL_CONFIGS;
type TaskModelSelection = ModelMode | InternalModelConfigKey;

// Legacy mode names remain parseable so old clients fail over cleanly, but
// every mode resolves to the only supported Stella model.
const BASE_MODE_CONFIGS: Record<ModelMode, ModeConfig> = {
  standard: DEEPSEEK_V4_FLASH_MODEL_CONFIG,
  priority: DEEPSEEK_V4_FLASH_MODEL_CONFIG,
  light: DEEPSEEK_V4_FLASH_MODEL_CONFIG,
  builder: DEEPSEEK_V4_FLASH_MODEL_CONFIG,
  designer: DEEPSEEK_V4_FLASH_MODEL_CONFIG,
  vision: DEEPSEEK_V4_FLASH_MODEL_CONFIG,
  max: DEEPSEEK_V4_FLASH_MODEL_CONFIG,
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

// Per-audience swaps of an agent's task→model mapping. Lets us point
// orchestrator/general at alternate models per plan without disturbing other
// agents that share the underlying modes.
//
// The primary Stella agent now works directly for the user, with optional
// General agents for delegated background work. Both default to Light
// (DeepSeek V4 Flash 0731) for every audience.
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

// Audiences that may NOT override the per-agent default model from the
// client. Anonymous/free/go (incl. go's downgraded fallback) are pinned to
// the backend-chosen model; Pro users keep the model picker.
const RESTRICTED_MODEL_OVERRIDE_AUDIENCES = new Set<ManagedModelAudience>([
  "anonymous",
  "free",
  "go",
  "go_fallback",
]);

export const canOverrideStellaModel = (
  audience: ManagedModelAudience,
): boolean => !RESTRICTED_MODEL_OVERRIDE_AUDIENCES.has(audience);

// Audiences without a paid subscription. Used to gate paid-only branded modes
// (e.g. Stella Max) independently of the model-override restriction above:
// `go` may not freely pin arbitrary models but is still a paid plan that can
// select the paid-only modes.
const UNPAID_MODEL_AUDIENCES = new Set<ManagedModelAudience>([
  "anonymous",
  "free",
]);

export const isPaidManagedAudience = (
  audience: ManagedModelAudience,
): boolean => !UNPAID_MODEL_AUDIENCES.has(audience);

// Paid-only branded modes remain unavailable to restricted audiences. The
// legacy set is retained for compatibility even though those modes are no
// longer supported by the public Stella catalog.
const PAID_ONLY_STELLA_MODE_IDS: ReadonlySet<string> = new Set<string>([
  "stella/max",
]);

/**
 * Stella model ids accepted from clients. The raw DeepSeek id is the only
 * public catalog row; `stella/light` remains as a compatibility alias for
 * existing preferences and older clients.
 *
 * Single source of truth for both the request-time coercion in
 * `stella_provider/request.ts` and the `allowedForAudience` flag the
 * `/api/models` endpoint exposes to the desktop picker.
 */
const RESTRICTED_AUDIENCE_ALLOWED_STELLA_MODEL_IDS: ReadonlySet<string> =
  new Set<string>([
    "stella/light",
    "stella/accounts/fireworks/models/deepseek-v4-flash-0731",
  ]);

export const isStellaModelAllowedForAudience = (
  modelId: string,
  audience: ManagedModelAudience,
): boolean => {
  // This is a product-wide allowlist, not merely a plan restriction. Pro and
  // fallback audiences must not be able to revive retired managed models by
  // submitting a stale or hand-written Stella id.
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

/**
 * Agent types whose model selection is locked on the backend regardless of
 * audience tier. The client can request whatever model it likes; we ignore
 * it and use whatever the per-tier `TASK_MODEL_SELECTIONS` mapping resolves to.
 *
 * Chronicle is locked because it ticks every minute against the user's
 * captured screen activity — picking the wrong (expensive) model here can
 * burn through quota with no user-visible benefit. Letting the client
 * override would also create surprising billing behavior for users who
 * idly switched their "assistant" model assuming it only affects chat.
 */
export const LOCKED_AGENT_TYPES: ReadonlySet<string> = new Set<string>([
  "chronicle",
  // Progress summaries tick every ~30s per active sub-agent purely to narrate
  // what's happening. Like chronicle, the wrong (expensive) model here burns
  // quota with no user benefit, so the client can't override it.
  "progress_summary",
]);

export const TASK_MODEL_SELECTIONS: Record<string, TaskModelSelection> = {
  [AGENT_IDS.OFFLINE_RESPONDER]: "light",
  [AGENT_IDS.ORCHESTRATOR]: "light",
  [AGENT_IDS.GENERAL]: "light",
  [AGENT_IDS.INSTALL_UPDATE]: "light",
  [AGENT_IDS.STORE]: "light",
  [AGENT_IDS.FASHION]: "light",

  schedule: "light",
  synthesis: "synthesis",
  welcome: "light",
  store_asset_metadata: "light",
  dream: "light",
  chronicle: "light",
  progress_summary: "light",
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

// Managed model ids that are pinnable / price-synced even when they are not
// currently the default for any mode or agent task. Prefer putting models
// behind a mode/task selection when they are catalog defaults; use this list
// only for extras that have no mode of their own.
export const ADDITIONAL_MANAGED_MODEL_IDS = [] as const;

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
