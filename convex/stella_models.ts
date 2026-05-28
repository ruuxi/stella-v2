import {
  AGENT_MODELS,
  getAgentModelMode,
  getModeConfig,
  getModelConfig,
  isModelMode,
  isStellaModelAllowedForAudience,
  listManagedModelIds,
  type ManagedModelAudience,
  type ModelConfig,
  type ModelMode,
} from "./agent/model";
import { query } from "./_generated/server";
import { v } from "convex/values";

export const STELLA_PROVIDER = "stella";
export const STELLA_DEFAULT_MODEL = `${STELLA_PROVIDER}/default`;
export const STELLA_STANDARD_MODEL = `${STELLA_PROVIDER}/standard`;
export const STELLA_PRIORITY_MODEL = `${STELLA_PROVIDER}/priority`;
export const STELLA_LIGHT_MODEL = `${STELLA_PROVIDER}/light`;
export const STELLA_BUILDER_MODEL = `${STELLA_PROVIDER}/builder`;
export const STELLA_DESIGNER_MODEL = `${STELLA_PROVIDER}/designer`;
export const STELLA_VISION_MODEL = `${STELLA_PROVIDER}/vision`;
const STELLA_DEFAULT_MODE: ModelMode = "standard";
// Bump this whenever Stella alias/default mappings change. Desktop subscribes
// to it and passes it to runtime as the model-catalog cache key.
export const STELLA_MODEL_CATALOG_UPDATED_AT = Date.UTC(2026, 4, 25, 9, 30);

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
  "anthropic/claude-opus-4.7": "Claude Opus 4.7",
  "anthropic/claude-opus-4.5": "Claude Opus 4.5",
  "anthropic/claude-sonnet-4.6": "Claude Sonnet 4.6",
  "google/gemini-3-flash-preview": "Gemini 3 Flash",
  "inception/mercury-2": "Mercury 2",
  "moonshotai/kimi-k2.5": "Kimi K2.5",
  "openai/gpt-5.4": "GPT-5.4",
  "openai/gpt-5.4-mini": "GPT-5.4 Mini",
  "openai/gpt-5.5": "GPT-5.5",
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

type StellaAliasMode = {
  id: string;
  name: string;
  mode: ModelMode;
  type: "language" | "multimodal";
  minAudience?: "pro";
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
];

const isProOrHigherAudience = (audience: ManagedModelAudience): boolean =>
  audience === "pro" ||
  audience === "plus" ||
  audience === "ultra" ||
  audience === "pro_fallback" ||
  audience === "plus_fallback" ||
  audience === "ultra_fallback";

const catalogRoutingModel = (config: ModelConfig): string =>
  config.managedGatewayProvider === "openrouter" &&
  /^(?:anthropic|google|openai)\//u.test(config.model)
    ? `openrouter/${config.model}`
    : config.model;

const getStaticStellaAliases = (audience: ManagedModelAudience = "free") =>
  STELLA_ALIAS_MODES
    .filter((alias) => alias.minAudience !== "pro" || isProOrHigherAudience(audience))
    .map((alias) => {
      const config = getModeConfig(alias.mode, audience);
      return {
        ...alias,
        upstreamModel: catalogRoutingModel(config),
      };
    });

const listUpstreamManagedModels = (): string[] => {
  return listManagedModelIds().sort((a, b) => deriveDisplayName(a).localeCompare(deriveDisplayName(b)));
};

export const toStellaModelId = (upstreamModel: string): string =>
  `${STELLA_PROVIDER}/${upstreamModel.trim()}`;

export const toStellaModeModelId = (mode: ModelMode): string =>
  `${STELLA_PROVIDER}/${mode}`;

export const isStellaModel = (model: string | null | undefined): boolean => {
  const trimmed = model?.trim();
  return Boolean(trimmed) && trimmed!.startsWith(`${STELLA_PROVIDER}/`);
};

export const parseStellaModelSelection = (
  selection: string | null | undefined,
):
  | { kind: "mode"; mode: ModelMode }
  | { kind: "upstream"; model: string }
  | null => {
  const trimmed = selection?.trim();
  if (!trimmed) {
    return { kind: "mode", mode: STELLA_DEFAULT_MODE };
  }
  if (!trimmed.startsWith(`${STELLA_PROVIDER}/`)) {
    return null;
  }

  const aliasOrUpstreamModel = trimmed.slice(`${STELLA_PROVIDER}/`.length).trim();
  if (!aliasOrUpstreamModel) {
    return { kind: "mode", mode: STELLA_DEFAULT_MODE };
  }
  if (aliasOrUpstreamModel === "default") {
    return null;
  }

  if (isModelMode(aliasOrUpstreamModel)) {
    return { kind: "mode", mode: aliasOrUpstreamModel };
  }

  return { kind: "upstream", model: aliasOrUpstreamModel };
};

export const resolveStellaModelSelection = (
  selection?: string | null,
  audience: ManagedModelAudience = "free",
): string => {
  const parsed = parseStellaModelSelection(selection);
  if (!parsed) {
    const trimmed = selection?.trim();
    if (trimmed && !trimmed.startsWith(`${STELLA_PROVIDER}/`)) {
      return trimmed;
    }
    throw new Error(`Unsupported Stella model selection: ${trimmed ?? ""}`);
  }
  if (parsed.kind === "mode") {
    return getModeConfig(parsed.mode, audience).model;
  }
  return parsed.model;
};

export const listStellaCatalogModels = (
  audience: ManagedModelAudience = "free",
): StellaCatalogModel[] => [
  ...getStaticStellaAliases(audience).map<StellaCatalogModel>((alias) => ({
    id: alias.id,
    name: alias.name,
    provider: STELLA_PROVIDER,
    upstreamModel: alias.upstreamModel,
    type: alias.type,
    allowedForAudience: isStellaModelAllowedForAudience(alias.id, audience),
  })),
  ...listUpstreamManagedModels().map<StellaCatalogModel>((upstreamModel) => {
    const id = toStellaModelId(upstreamModel);
    return {
      id,
      name: deriveDisplayName(upstreamModel),
      provider: STELLA_PROVIDER,
      upstreamModel,
      type: "language",
      allowedForAudience: isStellaModelAllowedForAudience(id, audience),
    };
  }),
];

export const listStellaDefaultSelections = (
  audience: ManagedModelAudience = "free",
): StellaDefaultEntry[] =>
  Object.keys(AGENT_MODELS).map((agentType) => {
    const mode = getAgentModelMode(agentType, audience);
    const config = getModelConfig(agentType, audience);
    return {
      agentType,
      model: mode ? toStellaModeModelId(mode) : toStellaModelId(config.model),
      resolvedModel: catalogRoutingModel(config),
    };
  });

export const getModelCatalogUpdatedAt = query({
  args: {},
  returns: v.number(),
  handler: async () => STELLA_MODEL_CATALOG_UPDATED_AT,
});
