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
  "plus",
  "ultra",
  "go_fallback",
  "pro_fallback",
  "plus_fallback",
  "ultra_fallback",
] as const;

export type ManagedModelAudience = (typeof MANAGED_MODEL_AUDIENCES)[number];

export const MODEL_MODES = [
  "standard",
  "priority",
  "light",
  "builder",
  "designer",
  "vision",
] as const;

export type ModelMode = (typeof MODEL_MODES)[number];

type ModeConfig = Omit<ModelConfig, "fallback" | "fallbackManagedGatewayProvider" | "fallbackProviderOptions"> & {
  fallbackMode?: ModelMode;
};

const isPlainObject = (value: unknown): value is Record<string, unknown> => (
  typeof value === "object" && value !== null && !Array.isArray(value)
);

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
    output[key] = isPlainObject(baseValue) && isPlainObject(patchValue)
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

const GPT_5_4_MINI_MODEL_CONFIG: ModeConfig = {
  model: "openai/gpt-5.4-mini",
  fallbackMode: "light",
  managedGatewayProvider: "openai",
  temperature: 1.0,
  providerOptions: {
    openai: {
      reasoningEffort: "low",
    },
  },
};

// Kimi K2.6 on Fireworks. Used as the per-agent default for the orchestrator
// on every tier except `ultra` (which keeps Standard). The newer
// `kimi-k2p7-code` variant is the `priority` mode and powers the general agent.
const KIMI_K2P6_MODEL_CONFIG: ModeConfig = {
  model: "accounts/fireworks/models/kimi-k2p6",
  fallbackMode: "standard",
  managedGatewayProvider: "fireworks",
  temperature: 1.0,
  providerOptions: {
    openai: {
      reasoningEffort: "medium",
    },
    ...gatewayOptions("fireworks"),
  },
};

const INTERNAL_MODEL_CONFIGS = {
  gpt_5_4_mini: GPT_5_4_MINI_MODEL_CONFIG,
  kimi_k2p6: KIMI_K2P6_MODEL_CONFIG,
} as const satisfies Record<string, ModeConfig>;

type InternalModelConfigKey = keyof typeof INTERNAL_MODEL_CONFIGS;
type TaskModelSelection = ModelMode | InternalModelConfigKey;

const isInternalModelConfigKey = (value: string): value is InternalModelConfigKey =>
  Object.prototype.hasOwnProperty.call(INTERNAL_MODEL_CONFIGS, value);

// Note: `maxOutputTokens` is intentionally omitted from every mode
// except `designer` (Anthropic). Hard caps truncate mid-sentence or
// mid-tool-call when hit, and on reasoning models the cap can be
// exhausted by thinking with zero budget left for the visible
// answer. Trust the model to self-terminate; the desktop runtime's
// degenerate-response retry handles pathological terminations.
// Anthropic's Messages API requires `max_tokens`, so `designer`
// keeps its value as a protocol requirement, not a policy choice.
const BASE_MODE_CONFIGS: Record<ModelMode, ModeConfig> = {
  standard: {
    model: "openai/gpt-5.5",
    fallbackMode: "light",
    managedGatewayProvider: "openai",
    temperature: 1.0,
    providerOptions: {
      openai: {
        reasoningEffort: "low",
      },
    },
  },

  priority: {
    model: "accounts/fireworks/models/kimi-k2p7-code",
    fallbackMode: "standard",
    managedGatewayProvider: "fireworks",
    temperature: 1.0,
    providerOptions: {
      openai: {
        reasoningEffort: "high",
      },
      ...gatewayOptions("fireworks"),
    },
  },

  light: {
    model: "accounts/fireworks/models/deepseek-v4-flash",
    managedGatewayProvider: "fireworks",
    temperature: 1.0,
    providerOptions: {
      openai: {
        reasoningEffort: "medium",
      },
      ...gatewayOptions("fireworks"),
    },
  },

  builder: {
    model: "openai/gpt-5.5",
    fallbackMode: "light",
    managedGatewayProvider: "openai",
    temperature: 1.0,
    providerOptions: {
      openai: {
        reasoningEffort: "low",
      },
    },
  },

  designer: {
    model: "anthropic/claude-opus-4.8",
    fallbackMode: "light",
    managedGatewayProvider: "anthropic",
    temperature: 1.0,
    // Required by Anthropic's Messages API.
    maxOutputTokens: 16192,
    providerOptions: {
      openai: {
        reasoningEffort: "medium",
      },
    },
  },

  vision: {
    model: "google/gemini-3-flash-preview",
    fallbackMode: "designer",
    managedGatewayProvider: "google",
    temperature: 0.4,
    providerOptions: {
      ...gatewayOptions("google"),
    },
  },
};

const AUDIENCE_MODE_OVERRIDES: Record<ManagedModelAudience, Partial<Record<ModelMode, Partial<ModeConfig>>>> = {
  anonymous: {},
  free: {},
  go: {},
  pro: {},
  plus: {},
  ultra: {},
  go_fallback: {},
  pro_fallback: {},
  plus_fallback: {},
  ultra_fallback: {},
};

// Per-audience swaps of an agent's task→model mapping. Lets us point
// orchestrator/general at alternate models per plan without disturbing other
// agents that share the underlying modes. Values are a mode or an internal
// model config key.
//
// Every tier except `ultra` runs the orchestrator on Kimi K2.6 and the
// general agent on Kimi K2.7 Code (the `priority` mode). Ultra keeps the
// Standard model (GPT-5.5) on both. `ultra_fallback` (an over-cap Ultra user)
// is intentionally treated like the other tiers — the fallback exists to
// drop over-cap users onto the cheaper models.
const KIMI_AGENT_OVERRIDES: Partial<Record<string, TaskModelSelection>> = {
  [AGENT_IDS.ORCHESTRATOR]: "kimi_k2p6",
  [AGENT_IDS.GENERAL]: "priority",
};

const ULTRA_AGENT_OVERRIDES: Partial<Record<string, TaskModelSelection>> = {
  [AGENT_IDS.ORCHESTRATOR]: "standard",
  [AGENT_IDS.GENERAL]: "standard",
};

const AUDIENCE_AGENT_MODE_OVERRIDES: Partial<
  Record<ManagedModelAudience, Partial<Record<string, TaskModelSelection>>>
> = {
  anonymous: KIMI_AGENT_OVERRIDES,
  free: KIMI_AGENT_OVERRIDES,
  go: KIMI_AGENT_OVERRIDES,
  pro: KIMI_AGENT_OVERRIDES,
  plus: KIMI_AGENT_OVERRIDES,
  ultra: ULTRA_AGENT_OVERRIDES,
  go_fallback: KIMI_AGENT_OVERRIDES,
  pro_fallback: KIMI_AGENT_OVERRIDES,
  plus_fallback: KIMI_AGENT_OVERRIDES,
  ultra_fallback: KIMI_AGENT_OVERRIDES,
};

// Audiences that may NOT override the per-agent default model from the
// client. Anonymous/free/go (incl. go's downgraded fallback) are pinned to
// the backend-chosen model; pro/plus/ultra users keep the model picker.
const RESTRICTED_MODEL_OVERRIDE_AUDIENCES = new Set<ManagedModelAudience>([
  "anonymous",
  "free",
  "go",
  "go_fallback",
]);

export const canOverrideStellaModel = (audience: ManagedModelAudience): boolean =>
  !RESTRICTED_MODEL_OVERRIDE_AUDIENCES.has(audience);

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
]);

export const TASK_MODEL_SELECTIONS: Record<string, TaskModelSelection> = {
  [AGENT_IDS.OFFLINE_RESPONDER]: "standard",
  // Per-tier orchestrator/general defaults live in
  // `AUDIENCE_AGENT_MODE_OVERRIDES` below; this `standard` entry is the
  // unauthenticated/internal-call fallback when no audience is supplied.
  [AGENT_IDS.ORCHESTRATOR]: "standard",
  [AGENT_IDS.GENERAL]: "standard",
  [AGENT_IDS.INSTALL_UPDATE]: "standard",
  [AGENT_IDS.STORE]: "standard",
  [AGENT_IDS.FASHION]: "standard",

  schedule: "standard",
  synthesis: "gpt_5_4_mini",
  welcome: "standard",
  store_asset_metadata: "vision",

  // Memory pipeline: Chronicle stays cheap (minute ticks). Dream consolidates
  // thread summaries + extensions on the same tier as other standard agent
  // work; stage-1 extraction remains the General rollout summary.
  dream: "standard",
  chronicle: "light",
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
  const fallbackConfig = config.fallbackMode ? rawModeCatalog[config.fallbackMode] : undefined;

  return {
    model: config.model,
    fallback: fallbackConfig?.model,
    managedGatewayProvider: config.managedGatewayProvider,
    fallbackManagedGatewayProvider: fallbackConfig?.managedGatewayProvider,
    temperature: config.temperature,
    maxOutputTokens: config.maxOutputTokens,
    serviceTier: config.serviceTier,
    fallbackServiceTier: fallbackConfig?.serviceTier,
    providerOptions: config.providerOptions ? clone(config.providerOptions) : undefined,
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
  rawModeCatalog: Record<ModelMode, ModeConfig>,
): Record<string, ModelConfig> => {
  const taskCatalog: Record<string, ModelConfig> = {};
  const audienceModeOverrides = AUDIENCE_AGENT_MODE_OVERRIDES[audience] ?? {};

  for (const [agentType, defaultSelection] of Object.entries(TASK_MODEL_SELECTIONS)) {
    const selection = audienceModeOverrides[agentType] ?? defaultSelection;
    taskCatalog[agentType] = isInternalModelConfigKey(selection)
      ? buildResolvedConfig(INTERNAL_MODEL_CONFIGS[selection], rawModeCatalog)
      : clone(modeCatalog[selection]);
  }

  return taskCatalog;
};

const AUDIENCE_MODE_CONFIGS: Record<ManagedModelAudience, Record<ModelMode, ModelConfig>> = {
  anonymous: buildAudienceModeCatalog("anonymous"),
  free: buildAudienceModeCatalog("free"),
  go: buildAudienceModeCatalog("go"),
  pro: buildAudienceModeCatalog("pro"),
  plus: buildAudienceModeCatalog("plus"),
  ultra: buildAudienceModeCatalog("ultra"),
  go_fallback: buildAudienceModeCatalog("go_fallback"),
  pro_fallback: buildAudienceModeCatalog("pro_fallback"),
  plus_fallback: buildAudienceModeCatalog("plus_fallback"),
  ultra_fallback: buildAudienceModeCatalog("ultra_fallback"),
};

export const AUDIENCE_AGENT_MODELS: Record<ManagedModelAudience, Record<string, ModelConfig>> = {
  anonymous: buildAudienceAgentCatalog("anonymous", AUDIENCE_MODE_CONFIGS.anonymous, buildAudienceRawModeCatalog("anonymous")),
  free: buildAudienceAgentCatalog("free", AUDIENCE_MODE_CONFIGS.free, buildAudienceRawModeCatalog("free")),
  go: buildAudienceAgentCatalog("go", AUDIENCE_MODE_CONFIGS.go, buildAudienceRawModeCatalog("go")),
  pro: buildAudienceAgentCatalog("pro", AUDIENCE_MODE_CONFIGS.pro, buildAudienceRawModeCatalog("pro")),
  plus: buildAudienceAgentCatalog("plus", AUDIENCE_MODE_CONFIGS.plus, buildAudienceRawModeCatalog("plus")),
  ultra: buildAudienceAgentCatalog("ultra", AUDIENCE_MODE_CONFIGS.ultra, buildAudienceRawModeCatalog("ultra")),
  go_fallback: buildAudienceAgentCatalog("go_fallback", AUDIENCE_MODE_CONFIGS.go_fallback, buildAudienceRawModeCatalog("go_fallback")),
  pro_fallback: buildAudienceAgentCatalog("pro_fallback", AUDIENCE_MODE_CONFIGS.pro_fallback, buildAudienceRawModeCatalog("pro_fallback")),
  plus_fallback: buildAudienceAgentCatalog("plus_fallback", AUDIENCE_MODE_CONFIGS.plus_fallback, buildAudienceRawModeCatalog("plus_fallback")),
  ultra_fallback: buildAudienceAgentCatalog("ultra_fallback", AUDIENCE_MODE_CONFIGS.ultra_fallback, buildAudienceRawModeCatalog("ultra_fallback")),
};

export const AGENT_MODELS = AUDIENCE_AGENT_MODELS.free;
export const DEFAULT_MODEL = AGENT_MODELS[AGENT_IDS.OFFLINE_RESPONDER];

export const resolveManagedModelAudience = (args: {
  plan: "free" | "go" | "pro" | "plus" | "ultra";
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
  const config = AUDIENCE_AGENT_MODELS[audience]?.[agentType] ?? AGENT_MODELS[agentType];
  if (!config) throw new Error(`No model config for agent type: ${agentType}`);
  return config;
}

export function hasModelConfig(agentType: string): boolean {
  return Object.prototype.hasOwnProperty.call(AGENT_MODELS, agentType);
}

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

  return Array.from(modelIds).sort();
}
