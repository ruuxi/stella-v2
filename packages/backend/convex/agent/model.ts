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
import type { ManagedProtocol } from "../runtime_ai/managed";
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
  /**
   * Wire protocol for the managed gateway request. When omitted, the runtime
   * infers it from the gateway provider (`resolveManagedProtocol` in
   * `runtime_ai/managed.ts`). Set explicitly for models whose gateway hosts a
   * mix of protocols — e.g. OpenRouter serves most models over Chat
   * Completions but Muse Spark 1.2 Contributor over the Responses API.
   */
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

/**
 * Which upstream serves DeepSeek V4 Flash. The model is no longer the
 * default, but it stays fully supported and selectable; every public legacy
 * alias follows this constant, so rolling back to DeepSeek or Fireworks
 * needs no other model-routing edit. Inactive gateways stay registered but
 * idle.
 */
type DeepSeekV4FlashRoute = "crof" | "deepseek" | "fireworks";
const DEEPSEEK_V4_FLASH_ROUTE: DeepSeekV4FlashRoute = "crof";

/** Fireworks-hosted V4 Flash. Retained as the one-constant rollback target. */
export const DEEPSEEK_V4_FLASH_FIREWORKS_MODEL =
  "accounts/fireworks/models/deepseek-v4-flash-0731";
/** DeepSeek first-party V4 Flash. DeepSeek rejects the dated `-0731` suffix. */
export const DEEPSEEK_V4_FLASH_DIRECT_MODEL = "deepseek/deepseek-v4-flash";
/** CrofAI-hosted V4 Flash 0731. */
export const DEEPSEEK_V4_FLASH_CROF_MODEL = "crof/deepseek-v4-flash-0731";
/** Wafer-hosted V4 Flash 0731 Fast variant. A distinct upstream model, not an
 * alias of the CrofAI row — it stays separately selectable and price-synced
 * but is never any audience's default. */
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
  // DeepSeek's own default. Thinking mode ignores sampling params entirely, so
  // this only matters if reasoning is ever turned off.
  temperature: 1.0,
  providerOptions: {
    openai: {
      // Stella's top rung, which maps to DeepSeek's native `max` effort.
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

/** OpenRouter-hosted Muse Spark 1.2 Contributor. The current default. */
export const MUSE_SPARK_1_2_CONTRIBUTOR_MODEL =
  "meta/muse-spark-1.2-contributor";

/**
 * Muse Spark 1.2 Contributor launched today on OpenRouter. Sampling defaults are
 * unannounced, so we carry over the previous default's temperature and keep
 * Stella's top reasoning rung until the model card documents otherwise.
 *
 * The slug is vendor/model form (OpenRouter convention), so the `meta/`
 * prefix in `DIRECT_MODEL_PROVIDER_PREFIXES` must never capture it — that
 * would silently route the default onto Meta's first-party gateway. The
 * explicit `managedGatewayProvider` here wins over prefix inference in
 * `resolveManagedGatewayProvider`; `MANAGED_MODEL_GATEWAY_OVERRIDES` below
 * covers the raw-pin path that has no mode config behind it.
 */
const MUSE_SPARK_1_2_CONTRIBUTOR_CONFIG: ModeConfig = {
  model: MUSE_SPARK_1_2_CONTRIBUTOR_MODEL,
  managedGatewayProvider: "openrouter",
  // OpenRouter serves this model through its Responses API (verified live:
  // /api/v1/responses works streaming and non-streaming; reasoning is
  // mandatory). Every other OpenRouter-hosted model keeps Chat Completions.
  api: "openai-responses",
  temperature: 1.0,
  providerOptions: {
    openai: {
      reasoningEffort: "xhigh",
    },
  },
};

/**
 * Gateway overrides for pinnable upstream ids whose slug does not encode
 * their gateway. A raw `stella/<model>` pin resolves its gateway purely via
 * `inferManagedGatewayProviderFromModel`, which would send the
 * OpenRouter-hosted contributor slug to the Meta first-party gateway.
 * Consulted by `resolveStellaModelConfigForSelection` before inference.
 */
export const MANAGED_MODEL_GATEWAY_OVERRIDES: Readonly<
  Record<string, ManagedGatewayProvider>
> = {
  [MUSE_SPARK_1_2_CONTRIBUTOR_MODEL]: "openrouter",
};

/**
 * Wire-protocol overrides for pinnable upstream ids, mirroring
 * `MANAGED_MODEL_GATEWAY_OVERRIDES`. Consulted by
 * `resolveStellaModelConfigForSelection` when a raw `stella/<model>` pin is
 * resolved, so a pinned id carries the same transport as its mode config
 * regardless of which mode happens to be the agent default.
 */
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

/** OpenRouter-hosted Gemini 3.7 Flash for mobile cloud chat. */
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

// Legacy mode names remain parseable so old clients fail over cleanly. All
// modes resolve to the current default (Muse Spark 1.2 Contributor); DeepSeek V4
// Flash 0731 stays selectable via its explicit raw ids.
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

// Per-audience swaps of an agent's task→model mapping. Lets us point
// orchestrator/general at alternate models per plan without disturbing other
// agents that share the underlying modes.
//
// The primary Stella agent now works directly for the user, with optional
// General agents for delegated background work. Both default to Light
// (Muse Spark 1.2 Contributor) for every audience.
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
 * Stella model ids accepted from clients. The OpenRouter Muse default and
 * every routed DeepSeek V4 Flash spelling are public catalog rows;
 * `stella/light` remains as a compatibility alias for existing preferences
 * and older clients.
 *
 * All V4 Flash spellings stay accepted so a client that saved the Fireworks
 * or DeepSeek-direct id before/after a route switch never 400s. Only one of
 * them is ever *live* — `resolveManagedModelRouteAlias` coerces the inactive
 * spellings onto whichever route `DEEPSEEK_V4_FLASH_ROUTE` selects.
 *
 * Single source of truth for both the request-time coercion in
 * `stella_provider/request.ts` and the `allowedForAudience` flag the
 * `/api/models` endpoint exposes to the desktop picker.
 */
const RESTRICTED_AUDIENCE_ALLOWED_STELLA_MODEL_IDS: ReadonlySet<string> =
  new Set<string>([
    "stella/light",
    `stella/${MUSE_SPARK_1_2_CONTRIBUTOR_MODEL}`,
    `stella/${DEEPSEEK_V4_FLASH_CROF_MODEL}`,
    `stella/${DEEPSEEK_V4_FLASH_FIREWORKS_MODEL}`,
    `stella/${DEEPSEEK_V4_FLASH_DIRECT_MODEL}`,
    `stella/${DEEPSEEK_V4_FLASH_WAFER_FAST_MODEL}`,
  ]);

/**
 * Collapse the two V4 Flash spellings onto the active route. Keeping both ids
 * pinnable would otherwise split traffic across two upstreams — and bill the
 * idle one at a price row nothing keeps warm.
 */
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
  // Mobile cloud chat is a backend service route, not a user-selected Stella
  // mode. Ignore stale mobileModel values when the desktop is disconnected.
  AGENT_IDS.OFFLINE_RESPONDER,
  // Image descriptions must stay on a vision-capable Google route. Treating
  // this utility pass as General lets restricted audiences coerce the model
  // back to DeepSeek while the desktop still serializes a Google request.
  "image_description",
]);

export const TASK_MODEL_SELECTIONS: Record<string, TaskModelSelection> = {
  [AGENT_IDS.OFFLINE_RESPONDER]: "offline_responder",
  [AGENT_IDS.ORCHESTRATOR]: "light",
  [AGENT_IDS.GENERAL]: "light",
  [AGENT_IDS.INSTALL_UPDATE]: "light",
  [AGENT_IDS.STORE]: "light",
  [AGENT_IDS.FASHION]: "light",

  schedule: "light",
  synthesis: "synthesis",
  welcome: "light",
  asset_metadata: "light",
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

// Managed model ids that are pinnable / price-synced even when they are not
// currently the default for any mode or agent task. Prefer putting models
// behind a mode/task selection when they are catalog defaults; use this list
// only for extras that have no mode of their own.
//
// DeepSeek V4 Flash 0731 lost the default slot to Muse Spark 1.2 Contributor but
// stays selectable and price-synced via its active CrofAI route id. The
// legacy Fireworks/DeepSeek-direct spellings alias onto that same row at
// request time, so only the canonical id needs tracking here.
export const ADDITIONAL_MANAGED_MODEL_IDS = [
  DEEPSEEK_V4_FLASH_CROF_MODEL,
  // The Wafer-hosted Fast variant is selectable but backs no mode or task.
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
