import {
  AGENT_MODELS,
  getModeConfig,
  getModelConfig,
  isModelMode,
  isStellaModelAllowedForAudience,
  listManagedModelIds,
  LOCKED_AGENT_TYPES,
  MANAGED_MODEL_API_OVERRIDES,
  MANAGED_MODEL_GATEWAY_OVERRIDES,
  resolveManagedModelRouteAlias,
  type ManagedModelAudience,
  type ModelConfig,
  type ModelMode,
} from "./agent/model";
import { inferManagedGatewayProviderFromModel } from "./lib/managed_gateway";
import { query } from "./_generated/server";
import { v } from "convex/values";

export const STELLA_PROVIDER = "stella";

export const STELLA_DEFAULT_MODEL = `${STELLA_PROVIDER}/default`;

export const STELLA_STANDARD_MODEL = `${STELLA_PROVIDER}/standard`;
export const STELLA_PRIORITY_MODEL = `${STELLA_PROVIDER}/priority`;
export const STELLA_LIGHT_MODEL = `${STELLA_PROVIDER}/light`;

export const STELLA_MODEL_CATALOG_UPDATED_AT = Date.UTC(2026, 7, 22, 0, 0);

export type StellaCatalogModel = {
  id: string;
  name: string;
  provider: typeof STELLA_PROVIDER;
  upstreamModel: string;
  type: "language" | "multimodal";

  allowedForAudience: boolean;
};

export type StellaDefaultEntry = {
  agentType: string;
  model: string;
  resolvedModel: string;
};

const DISPLAY_NAMES: Record<string, string> = {
  "meta/muse-spark-1.2-contributor": "Muse Spark 1.2 Contributor",
  "crof/deepseek-v4-flash-0731": "DeepSeek V4 Flash 0731",
  "wafer/deepseek-v4-flash-0731-fast": "DeepSeek V4 Flash 0731 Fast",
  "accounts/fireworks/models/deepseek-v4-flash-0731": "DeepSeek V4 Flash 0731",
  "deepseek/deepseek-v4-flash": "DeepSeek V4 Flash",
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
  return listManagedModelIds()
    .filter((model) =>
      isStellaModelAllowedForAudience(toStellaModelId(model), "pro"),
    )
    .sort((a, b) => deriveDisplayName(a).localeCompare(deriveDisplayName(b)));
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

export const resolveStellaModelSelection = (
  selection?: string | null,
  audience: ManagedModelAudience = "free",
): string => {
  const trimmed = selection?.trim();
  if (
    trimmed?.startsWith(`${STELLA_PROVIDER}/`) &&
    !isStellaModelAllowedForAudience(trimmed, audience)
  ) {
    throw new Error(`Unsupported Stella model selection: ${trimmed}`);
  }
  const parsed = parseStellaModelSelection(selection);
  if (parsed?.kind === "upstream") {
    return resolveManagedModelRouteAlias(parsed.model);
  }
  if (parsed?.kind === "mode") {
    return getModeConfig(parsed.mode, audience).model;
  }
  if (trimmed && !trimmed.startsWith(`${STELLA_PROVIDER}/`)) {
    return trimmed;
  }
  throw new Error(`Unsupported Stella model selection: ${trimmed ?? ""}`);
};

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

    const model = resolveManagedModelRouteAlias(parsed.model);
    return {
      config: {
        ...getModelConfig(agentType, audience),
        model,

        managedGatewayProvider:
          MANAGED_MODEL_GATEWAY_OVERRIDES[model] ??
          inferManagedGatewayProviderFromModel(model),

        api: MANAGED_MODEL_API_OVERRIDES[model],
      },
      applied: true,
    };
  }
  return { config: getModelConfig(agentType, audience), applied: false };
};

export const listStellaCatalogModels = (
  audience: ManagedModelAudience = "free",
): StellaCatalogModel[] => [

  ...listUpstreamManagedModels().map<StellaCatalogModel>((upstreamModel) => ({
    id: toStellaModelId(upstreamModel),
    name: deriveDisplayName(upstreamModel),
    provider: STELLA_PROVIDER,
    upstreamModel,
    type: "language",
    allowedForAudience: isStellaModelAllowedForAudience(
      toStellaModelId(upstreamModel),
      audience,
    ),
  })),
];

export const listStellaDefaultSelections = (
  audience: ManagedModelAudience = "free",
): StellaDefaultEntry[] =>
  Object.keys(AGENT_MODELS).map((agentType) => {
    const config = getModelConfig(agentType, audience);
    return {
      agentType,

      model: STELLA_DEFAULT_MODEL,
      resolvedModel: catalogRoutingModel(config),
    };
  });

export const getModelCatalogUpdatedAt = query({
  args: {},
  returns: v.number(),
  handler: async () => STELLA_MODEL_CATALOG_UPDATED_AT,
});
