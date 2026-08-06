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

const GPT_5_6_LUNA_MODEL_CONFIG: ModeConfig = {
  model: "openai/gpt-5.6-luna",
  fallbackMode: "light",
  managedGatewayProvider: "openai",
  temperature: 1.0,
  providerOptions: {
    openai: {
      reasoningEffort: "low",
    },
  },
};

// Kimi K2.6 on Fireworks. Kept as an internal config for compatibility with
// existing tests/fixtures and any explicit backend use, but no longer used as
// the orchestrator default.
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

// Gemini 3.6 Flash via OpenRouter. Powers the general agent's
// post-completion "finishing up" HTML pass (agent type `html_finish`): a
// fast, cheap render of a finished report into a self-contained HTML
// canvas. Routed through OpenRouter (not the Google gateway) per product
// intent, so the model id stays `google/…` while the relay forwards it to
// OpenRouter. This is the single source of truth for the model — the
// desktop never hardcodes it; it requests the opaque default for the
// `html_finish` agent type and the backend resolves it here.
const HTML_MODEL_CONFIG: ModeConfig = {
  model: "google/gemini-3.6-flash",
  fallbackMode: "light",
  managedGatewayProvider: "openrouter",
  providerOptions: {
    ...gatewayOptions("openrouter"),
  },
};

const INTERNAL_MODEL_CONFIGS = {
  gpt_5_6_luna: GPT_5_6_LUNA_MODEL_CONFIG,
  kimi_k2p6: KIMI_K2P6_MODEL_CONFIG,
  html: HTML_MODEL_CONFIG,
} as const satisfies Record<string, ModeConfig>;

type InternalModelConfigKey = keyof typeof INTERNAL_MODEL_CONFIGS;
type TaskModelSelection = ModelMode | InternalModelConfigKey;

const isInternalModelConfigKey = (
  value: string,
): value is InternalModelConfigKey =>
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
  // Stella Standard: Grok 4.5 directly via xAI. Default for orchestrator +
  // general across every audience. Missing or disabled reasoning is normalized
  // to low at the relay boundary.
  standard: {
    model: "x-ai/grok-4.5",
    fallbackMode: "light",
    managedGatewayProvider: "xai",
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
    model: "accounts/fireworks/models/deepseek-v4-flash-0731",
    managedGatewayProvider: "fireworks",
    temperature: 1.0,
    providerOptions: {
      openai: {
        reasoningEffort: "medium",
      },
      ...gatewayOptions("fireworks"),
    },
  },

  // Stella Builder: OpenAI GPT-5.6 Sol (preview API id `gpt-5.6-sol`).
  builder: {
    model: "openai/gpt-5.6-sol",
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
    model: "anthropic/claude-opus-5",
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
    model: "google/gemini-3.6-flash",
    fallbackMode: "designer",
    managedGatewayProvider: "google",
    providerOptions: {
      ...gatewayOptions("google"),
    },
  },

  // Stella Max: the premium branded mode powered by Anthropic's Claude
  // Fable 5. Selectable by any paid-plan user and the backend default for
  // the Stella Max mode. Falls back to the Designer mode (Opus) if the
  // upstream Fable 5 model is unavailable.
  max: {
    model: "anthropic/claude-fable-5",
    fallbackMode: "designer",
    managedGatewayProvider: "anthropic",
    temperature: 1.0,
    // Required by Anthropic's Messages API.
    maxOutputTokens: 64000,
    providerOptions: {
      openai: {
        reasoningEffort: "high",
      },
    },
  },
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
// agents that share the underlying modes. Values are a mode or an internal
// model config key.
//
// The primary Stella agent now works directly for the user, with optional
// General agents for delegated background work. Both default to Light
// (DeepSeek V4 Flash 0731) for every audience; Standard remains an explicit
// selectable mode rather than the implicit default.
const DEFAULT_AGENT_OVERRIDES: Partial<
  Record<string, TaskModelSelection>
> = {
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

// Branded modes any paid plan may select even when the audience can't pin
// arbitrary managed models. Free/anonymous stay blocked.
const PAID_ONLY_STELLA_MODE_IDS: ReadonlySet<string> = new Set<string>([
  "stella/max",
]);

/**
 * Stella catalog model ids that restricted-tier audiences (anonymous /
 * free / go / go_fallback) may still pick even though
 * `canOverrideStellaModel` is false. Standard is the default mode, and
 * Light is the small/cheap fallback users can still opt into without
 * upgrading.
 *
 * Single source of truth for both the request-time coercion in
 * `stella_provider/request.ts` and the `allowedForAudience` flag the
 * `/api/models` endpoint exposes to the desktop picker.
 */
const RESTRICTED_AUDIENCE_ALLOWED_STELLA_MODEL_IDS: ReadonlySet<string> =
  new Set<string>(["stella/standard", "stella/light"]);

const FREE_AUDIENCE_ADDITIONAL_STELLA_MODEL_IDS: ReadonlySet<string> =
  new Set<string>([
    "stella/openai/gpt-5.6-luna",
    "stella/accounts/fireworks/models/deepseek-v4-pro",
  ]);

export const isStellaModelAllowedForAudience = (
  modelId: string,
  audience: ManagedModelAudience,
): boolean => {
  // Paid-only branded modes (Stella Max) are selectable by any paid plan,
  // including plans that otherwise can't pin arbitrary models (go). Free and
  // anonymous audiences stay blocked.
  if (PAID_ONLY_STELLA_MODE_IDS.has(modelId)) {
    return isPaidManagedAudience(audience);
  }
  if (canOverrideStellaModel(audience)) return true;
  if (
    (audience === "anonymous" || audience === "free") &&
    FREE_AUDIENCE_ADDITIONAL_STELLA_MODEL_IDS.has(modelId)
  ) {
    return true;
  }
  return RESTRICTED_AUDIENCE_ALLOWED_STELLA_MODEL_IDS.has(modelId);
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
  synthesis: "gpt_5_6_luna",
  welcome: "standard",
  store_asset_metadata: "vision",

  // Memory pipeline: Chronicle stays cheap (minute ticks). Dream consolidates
  // thread summaries + extensions on the same tier as other standard agent
  // work; stage-1 extraction remains the General rollout summary.
  dream: "standard",
  chronicle: "light",

  // Per-active-agent progress narration. Ticks ~every 30s to produce a 3-7
  // word summary of what a running sub-agent is doing, so it stays on the
  // cheap Light tier (deepseek-v4-flash) and is locked from client override.
  progress_summary: "light",

  // General agent's post-completion HTML "finishing up" pass — a fast, cheap
  // Gemini Flash render routed through OpenRouter. The desktop requests the
  // opaque default for this agent type; the `html` internal config above is
  // the model source of truth.
  html_finish: "html",
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
  rawModeCatalog: Record<ModelMode, ModeConfig>,
): Record<string, ModelConfig> => {
  const taskCatalog: Record<string, ModelConfig> = {};
  const audienceModeOverrides = AUDIENCE_AGENT_MODE_OVERRIDES[audience] ?? {};

  for (const [agentType, defaultSelection] of Object.entries(
    TASK_MODEL_SELECTIONS,
  )) {
    const selection = audienceModeOverrides[agentType] ?? defaultSelection;
    taskCatalog[agentType] = isInternalModelConfigKey(selection)
      ? buildResolvedConfig(INTERNAL_MODEL_CONFIGS[selection], rawModeCatalog)
      : clone(modeCatalog[selection]);
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
    buildAudienceRawModeCatalog("anonymous"),
  ),
  free: buildAudienceAgentCatalog(
    "free",
    AUDIENCE_MODE_CONFIGS.free,
    buildAudienceRawModeCatalog("free"),
  ),
  go: buildAudienceAgentCatalog(
    "go",
    AUDIENCE_MODE_CONFIGS.go,
    buildAudienceRawModeCatalog("go"),
  ),
  pro: buildAudienceAgentCatalog(
    "pro",
    AUDIENCE_MODE_CONFIGS.pro,
    buildAudienceRawModeCatalog("pro"),
  ),
  go_fallback: buildAudienceAgentCatalog(
    "go_fallback",
    AUDIENCE_MODE_CONFIGS.go_fallback,
    buildAudienceRawModeCatalog("go_fallback"),
  ),
  pro_fallback: buildAudienceAgentCatalog(
    "pro_fallback",
    AUDIENCE_MODE_CONFIGS.pro_fallback,
    buildAudienceRawModeCatalog("pro_fallback"),
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
export const ADDITIONAL_MANAGED_MODEL_IDS = [
  "accounts/fireworks/models/deepseek-v4-pro",
  "accounts/fireworks/models/kimi-k3",
  "meta/muse-spark-1.1",
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
