import {
  AGENT_MODELS,
  canOverrideStellaModel,
  getModeConfig,
  getModelConfig,
  isModelMode,
  isPaidManagedAudience,
  isStellaModelAllowedForAudience,
  listManagedModelIds,
  LOCKED_AGENT_TYPES,
  type ManagedModelAudience,
  type ModelConfig,
  type ModelMode,
} from "./agent/model";
import { inferManagedGatewayProviderFromModel } from "./lib/managed_gateway";
import { query } from "./_generated/server";
import { v } from "convex/values";

export const STELLA_PROVIDER = "stella";
// Opaque "let the backend pick" sentinel. The concrete model is chosen per
// agent type + audience on the backend; this stays the per-agent *default*.
export const STELLA_DEFAULT_MODEL = `${STELLA_PROVIDER}/default`;
// Branded tier aliases ("modes"): user-selectable overrides whose concrete
// upstream model is resolved per audience from `BASE_MODE_CONFIGS`. The default
// routing above is unchanged — modes are opt-in picks, not the default.
export const STELLA_STANDARD_MODEL = `${STELLA_PROVIDER}/standard`;
export const STELLA_PRIORITY_MODEL = `${STELLA_PROVIDER}/priority`;
export const STELLA_LIGHT_MODEL = `${STELLA_PROVIDER}/light`;
export const STELLA_BUILDER_MODEL = `${STELLA_PROVIDER}/builder`;
export const STELLA_DESIGNER_MODEL = `${STELLA_PROVIDER}/designer`;
export const STELLA_VISION_MODEL = `${STELLA_PROVIDER}/vision`;
// Stella Max: the premium branded mode (Claude Fable 5). Paid-only; default for
// the Stella Max plan.
export const STELLA_MAX_MODEL = `${STELLA_PROVIDER}/max`;
// Bump this whenever Stella default/model/mode mappings change. Desktop
// subscribes to it and passes it to runtime as the model-catalog cache key.
export const STELLA_MODEL_CATALOG_UPDATED_AT = Date.UTC(2026, 6, 9, 12, 0);

export type StellaCatalogModel = {
  id: string;
  name: string;
  provider: typeof STELLA_PROVIDER;
  upstreamModel: string;
  type: "language" | "multimodal";
  /**
   * Whether the requesting audience may pick this model. The catalog
   * endpoint computes this per request so the desktop picker can
   * disable rows the backend would silently coerce away — keeping the
   * UI in sync with the actual enforcement in
   * `stella_provider/request.ts`.
   */
  allowedForAudience: boolean;
};

export type StellaDefaultEntry = {
  agentType: string;
  model: string;
  resolvedModel: string;
};

const DISPLAY_NAMES: Record<string, string> = {
  "accounts/fireworks/models/deepseek-v4-flash": "DeepSeek V4 Flash",
  "accounts/fireworks/models/kimi-k2p6": "Kimi K2.6",
  "accounts/fireworks/models/kimi-k2p7-code": "Kimi K2.7 Code",
  "anthropic/claude-fable-5": "Claude Fable 5",
  "anthropic/claude-opus-4.8": "Claude Opus 4.8",
  "anthropic/claude-opus-4.5": "Claude Opus 4.5",
  "anthropic/claude-sonnet-4.6": "Claude Sonnet 4.6",
  "google/gemini-3-flash-preview": "Gemini 3 Flash",
  "inception/mercury-2": "Mercury 2",
  "moonshotai/kimi-k2.5": "Kimi K2.5",
  "openai/gpt-5.4": "GPT-5.4",
  "openai/gpt-5.4-mini": "GPT-5.4 Mini",
  "openai/gpt-5.5": "GPT-5.5",
  "x-ai/grok-4.5": "Grok 4.5",
  "meta/muse-spark-1.1": "Muse Spark 1.1",
  "zai/glm-4.7": "GLM 4.7",
};

const titleCase = (value: string): string =>
  value
    .split(/[-_.]/g)
    .filter(Boolean)
    .map((part) => part.slice(0, 1).toUpperCase() + part.slice(1))
    .join(" ");

const deriveDisplayName = (upstreamModel: string): string => {
  const mapped = DISPLAY_NAMES[upstreamModel];
  if (mapped) return mapped;

  const slash = upstreamModel.indexOf("/");
  const rawId = upstreamModel.startsWith("accounts/fireworks/models/")
    ? upstreamModel.slice("accounts/fireworks/models/".length)
    : upstreamModel.startsWith("accounts/fireworks/routers/")
      ? upstreamModel.slice("accounts/fireworks/routers/".length)
      : slash >= 0
        ? upstreamModel.slice(slash + 1)
        : upstreamModel;
  return titleCase(rawId);
};

const catalogRoutingModel = (config: ModelConfig): string =>
  config.managedGatewayProvider === "openrouter" &&
  !config.model.startsWith("openrouter/")
    ? `openrouter/${config.model}`
    : config.model;

const listUpstreamManagedModels = (): string[] => {
  return listManagedModelIds().sort((a, b) =>
    deriveDisplayName(a).localeCompare(deriveDisplayName(b)),
  );
};

export const toStellaModelId = (upstreamModel: string): string =>
  `${STELLA_PROVIDER}/${upstreamModel.trim()}`;

export const toStellaModeModelId = (mode: ModelMode): string =>
  `${STELLA_PROVIDER}/${mode}`;

type StellaAliasMode = {
  id: string;
  name: string;
  mode: ModelMode;
  type: "language" | "multimodal";
  /**
   * Minimum audience that may see this branded mode in the picker:
   * - `pro`: pro-and-higher tiers only.
   * - `paid`: any paid plan (includes go, which otherwise can't pin models).
   * Undefined means every audience sees it.
   */
  minAudience?: "pro" | "paid";
};

const STELLA_ALIAS_MODES: ReadonlyArray<StellaAliasMode> = [
  {
    id: STELLA_LIGHT_MODEL,
    name: "Stella Light",
    mode: "light",
    type: "language" as const,
  },
  {
    id: STELLA_STANDARD_MODEL,
    name: "Stella Standard",
    mode: "standard",
    type: "language" as const,
  },
  {
    id: STELLA_PRIORITY_MODEL,
    name: "Stella Priority",
    mode: "priority",
    type: "language" as const,
    minAudience: "pro",
  },
  {
    id: STELLA_BUILDER_MODEL,
    name: "Stella Builder",
    mode: "builder",
    type: "language" as const,
  },
  {
    id: STELLA_DESIGNER_MODEL,
    name: "Stella Designer",
    mode: "designer",
    type: "language" as const,
  },
  {
    id: STELLA_VISION_MODEL,
    name: "Stella Vision",
    mode: "vision",
    type: "multimodal" as const,
  },
  {
    id: STELLA_MAX_MODEL,
    name: "Stella Max",
    mode: "max",
    type: "language" as const,
    minAudience: "paid",
  },
];

const isProOrHigherAudience = (audience: ManagedModelAudience): boolean =>
  audience === "pro" ||
  audience === "plus" ||
  audience === "ultra" ||
  audience === "max" ||
  audience === "pro_fallback" ||
  audience === "plus_fallback" ||
  audience === "ultra_fallback" ||
  audience === "max_fallback";

const isAliasVisibleForAudience = (
  alias: StellaAliasMode,
  audience: ManagedModelAudience,
): boolean => {
  if (alias.minAudience === "pro") return isProOrHigherAudience(audience);
  if (alias.minAudience === "paid") return isPaidManagedAudience(audience);
  return true;
};

const getStaticStellaAliases = (audience: ManagedModelAudience = "free") =>
  STELLA_ALIAS_MODES.filter((alias) =>
    isAliasVisibleForAudience(alias, audience),
  ).map((alias) => {
    const config = getModeConfig(alias.mode, audience);
    return {
      ...alias,
      upstreamModel: catalogRoutingModel(config),
    };
  });

export const isStellaModel = (model: string | null | undefined): boolean => {
  const trimmed = model?.trim();
  return Boolean(trimmed) && trimmed!.startsWith(`${STELLA_PROVIDER}/`);
};

/**
 * A Stella selection is one of:
 * - `default`: empty / `stella` / `stella/default` ⇒ the backend picks the
 *   model for the requesting agent + audience.
 * - `mode`: `stella/<mode>` (e.g. `stella/designer`) ⇒ a branded tier alias
 *   resolved per audience from `BASE_MODE_CONFIGS`.
 * - `upstream`: `stella/<provider>/<model>` ⇒ an explicit managed-model
 *   override (e.g. `stella/openai/gpt-5.5`).
 * Returns null for non-Stella strings.
 */
export const parseStellaModelSelection = (
  selection: string | null | undefined,
):
  | { kind: "default" }
  | { kind: "mode"; mode: ModelMode }
  | { kind: "upstream"; model: string }
  | null => {
  const trimmed = selection?.trim();
  if (!trimmed) {
    return { kind: "default" };
  }
  if (!trimmed.startsWith(`${STELLA_PROVIDER}/`)) {
    return null;
  }

  const aliasOrUpstreamModel = trimmed
    .slice(`${STELLA_PROVIDER}/`.length)
    .trim();
  if (!aliasOrUpstreamModel || aliasOrUpstreamModel === "default") {
    return { kind: "default" };
  }
  if (isModelMode(aliasOrUpstreamModel)) {
    return { kind: "mode", mode: aliasOrUpstreamModel };
  }
  return { kind: "upstream", model: aliasOrUpstreamModel };
};

/**
 * Resolve an explicit Stella override (mode or upstream) to its upstream model
 * id. The opaque `default` selection has no concrete model without an agent +
 * audience, so it's rejected here — callers resolve defaults via
 * `getModelConfig` instead.
 */
export const resolveStellaModelSelection = (
  selection?: string | null,
  audience: ManagedModelAudience = "free",
): string => {
  const parsed = parseStellaModelSelection(selection);
  if (parsed?.kind === "upstream") {
    return parsed.model;
  }
  if (parsed?.kind === "mode") {
    return getModeConfig(parsed.mode, audience).model;
  }
  const trimmed = selection?.trim();
  if (trimmed && !trimmed.startsWith(`${STELLA_PROVIDER}/`)) {
    return trimmed;
  }
  throw new Error(`Unsupported Stella model selection: ${trimmed ?? ""}`);
};

/**
 * Resolve a requested model `selection` for an `agentType` + `audience` to its
 * effective managed `ModelConfig`. This is the single source of truth shared by
 * the relay request path (`resolveRequestedStellaModel` in `stella_provider`)
 * and the runtime config path (`resolveModelConfig` in `agent/model_resolver`),
 * so the two can't drift on how an override resolves (provider, options, etc.).
 *
 * An override is honored only when allowed: a `stella/<mode>` resolves per
 * audience via `getModeConfig`; a `stella/<provider>/<model>` pins that model
 * and infers its gateway provider. Everything else — the default sentinel, a
 * locked agent, or an override this audience may not pick — returns the agent's
 * backend default. `applied` is true only when an override was honored.
 */
export const resolveStellaModelConfigForSelection = (
  selection: string | null | undefined,
  agentType: string,
  audience: ManagedModelAudience = "free",
): { config: ModelConfig; applied: boolean } => {
  const trimmed = selection?.trim();
  const parsed =
    trimmed && trimmed !== STELLA_DEFAULT_MODEL
      ? parseStellaModelSelection(trimmed)
      : null;
  const allowed =
    !!trimmed &&
    parsed !== null &&
    parsed.kind !== "default" &&
    !LOCKED_AGENT_TYPES.has(agentType) &&
    isStellaModelAllowedForAudience(trimmed, audience);

  if (allowed && parsed?.kind === "mode") {
    return { config: getModeConfig(parsed.mode, audience), applied: true };
  }
  if (allowed && parsed?.kind === "upstream") {
    return {
      config: {
        ...getModelConfig(agentType, audience),
        model: parsed.model,
        managedGatewayProvider: inferManagedGatewayProviderFromModel(
          parsed.model,
        ),
      },
      applied: true,
    };
  }
  return { config: getModelConfig(agentType, audience), applied: false };
};

export const listStellaCatalogModels = (
  audience: ManagedModelAudience = "free",
): StellaCatalogModel[] => [
  // Branded tier modes first (the curated picker presets), then every
  // pinnable managed model.
  ...getStaticStellaAliases(audience).map<StellaCatalogModel>((alias) => ({
    id: alias.id,
    name: alias.name,
    provider: STELLA_PROVIDER,
    upstreamModel: alias.upstreamModel,
    type: alias.type,
    allowedForAudience: isStellaModelAllowedForAudience(alias.id, audience),
  })),
  ...listUpstreamManagedModels().map<StellaCatalogModel>((upstreamModel) => ({
    id: toStellaModelId(upstreamModel),
    name: deriveDisplayName(upstreamModel),
    provider: STELLA_PROVIDER,
    upstreamModel,
    // Muse Spark is natively multimodal (images / video / PDFs); everything
    // else remains language-only in the static catalog until models.dev rows
    // or an explicit override say otherwise.
    type: upstreamModel.startsWith("meta/muse-spark")
      ? "multimodal"
      : "language",
    // Restricted tiers (anonymous / free / go) can't override the
    // backend-chosen default at all, so every pinnable model is disabled
    // for them; pro+ may pin any managed model.
    allowedForAudience: canOverrideStellaModel(audience),
  })),
];

export const listStellaDefaultSelections = (
  audience: ManagedModelAudience = "free",
): StellaDefaultEntry[] =>
  Object.keys(AGENT_MODELS).map((agentType) => {
    const config = getModelConfig(agentType, audience);
    return {
      agentType,
      // Always the opaque sentinel: the per-agent + per-audience model lives
      // on the backend and is surfaced separately as `resolvedModel` for the
      // runtime's tool-policy + display.
      model: STELLA_DEFAULT_MODEL,
      resolvedModel: catalogRoutingModel(config),
    };
  });

export const getModelCatalogUpdatedAt = query({
  args: {},
  returns: v.number(),
  handler: async () => STELLA_MODEL_CATALOG_UPDATED_AT,
});
