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
} from "./model";
import { inferManagedGatewayProviderFromModel } from "./managed-gateway";

export const STELLA_PROVIDER = "stella";
// Opaque "let the backend pick" sentinel. The concrete model is chosen per
// agent type + audience on the backend; this stays the per-agent *default*.
export const STELLA_DEFAULT_MODEL = `${STELLA_PROVIDER}/default`;
// Legacy branded aliases remain parseable for old clients. The public
// catalog exposes the current default (Muse Spark 1.2 Contributor) plus the still
// selectable raw DeepSeek V4 Flash model.
export const STELLA_STANDARD_MODEL = `${STELLA_PROVIDER}/standard`;
export const STELLA_PRIORITY_MODEL = `${STELLA_PROVIDER}/priority`;
export const STELLA_LIGHT_MODEL = `${STELLA_PROVIDER}/light`;
// Bump this whenever Stella default/model/mode mappings change. Desktop
// subscribes to it and passes it to runtime as the model-catalog cache key.
export const STELLA_MODEL_CATALOG_UPDATED_AT = Date.UTC(2026, 7, 22, 0, 0);

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

/**
 * A Stella selection is one of:
 * - `default`: empty / `stella` / `stella/default` ⇒ the backend picks the
 *   model for the requesting agent + audience.
 * - `mode`: `stella/<mode>` (e.g. `stella/designer`) ⇒ a branded tier alias
 *   resolved per audience from `BASE_MODE_CONFIGS`.
 * - `upstream`: `stella/<provider>/<model>` ⇒ an explicit managed-model
 *   override (e.g. `stella/openai/gpt-5.6-sol`).
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
    // Aliased first so a pinned legacy spelling lands on the active route's
    // gateway rather than reviving the idle one.
    const model = resolveManagedModelRouteAlias(parsed.model);
    return {
      config: {
        ...getModelConfig(agentType, audience),
        model,
        // Prefix inference alone would send `meta/muse-spark-1.2-contributor`
        // to the Meta first-party gateway; it is an OpenRouter-hosted slug
        // (see MANAGED_MODEL_GATEWAY_OVERRIDES in agent/model.ts).
        managedGatewayProvider:
          MANAGED_MODEL_GATEWAY_OVERRIDES[model] ??
          inferManagedGatewayProviderFromModel(model),
        // Same for the wire protocol: the pinned id must not inherit the
        // agent default's transport. `api: undefined` here intentionally
        // clears a base-config value when the pinned model has no override.
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
  // Compatibility aliases (stella/light etc.) stay resolvable but are
  // intentionally absent here: the picker publishes the raw selectable
  // models only.
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
      // Always the opaque sentinel: the per-agent + per-audience model lives
      // on the backend and is surfaced separately as `resolvedModel` for the
      // runtime's tool-policy + display.
      model: STELLA_DEFAULT_MODEL,
      resolvedModel: catalogRoutingModel(config),
    };
  });
