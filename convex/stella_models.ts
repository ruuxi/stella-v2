import {
  AGENT_MODELS,
  canOverrideStellaModel,
  getModelConfig,
  listManagedModelIds,
  type ManagedModelAudience,
  type ModelConfig,
} from "./agent/model";
import { query } from "./_generated/server";
import { v } from "convex/values";

export const STELLA_PROVIDER = "stella";
// Opaque "let the backend pick" sentinel. The concrete model is chosen per
// agent type + audience on the backend; the client never names a tier.
export const STELLA_DEFAULT_MODEL = `${STELLA_PROVIDER}/default`;
// Bump this whenever Stella default/model mappings change. Desktop subscribes
// to it and passes it to runtime as the model-catalog cache key.
export const STELLA_MODEL_CATALOG_UPDATED_AT = Date.UTC(2026, 5, 23, 9, 30);

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
  "anthropic/claude-opus-4.8": "Claude Opus 4.8",
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

const catalogRoutingModel = (config: ModelConfig): string =>
  config.managedGatewayProvider === "openrouter" &&
  /^(?:anthropic|google|openai)\//u.test(config.model)
    ? `openrouter/${config.model}`
    : config.model;

const listUpstreamManagedModels = (): string[] => {
  return listManagedModelIds().sort((a, b) => deriveDisplayName(a).localeCompare(deriveDisplayName(b)));
};

export const toStellaModelId = (upstreamModel: string): string =>
  `${STELLA_PROVIDER}/${upstreamModel.trim()}`;

export const isStellaModel = (model: string | null | undefined): boolean => {
  const trimmed = model?.trim();
  return Boolean(trimmed) && trimmed!.startsWith(`${STELLA_PROVIDER}/`);
};

/**
 * A Stella selection is either:
 * - `default`: empty / `stella` / `stella/default` ⇒ the backend picks the
 *   model for the requesting agent + audience.
 * - `upstream`: `stella/<provider>/<model>` ⇒ an explicit managed-model
 *   override (e.g. `stella/openai/gpt-5.5`).
 * Returns null for non-Stella strings.
 */
export const parseStellaModelSelection = (
  selection: string | null | undefined,
): { kind: "default" } | { kind: "upstream"; model: string } | null => {
  const trimmed = selection?.trim();
  if (!trimmed) {
    return { kind: "default" };
  }
  if (!trimmed.startsWith(`${STELLA_PROVIDER}/`)) {
    return null;
  }

  const upstreamModel = trimmed.slice(`${STELLA_PROVIDER}/`.length).trim();
  if (!upstreamModel || upstreamModel === "default") {
    return { kind: "default" };
  }
  return { kind: "upstream", model: upstreamModel };
};

/**
 * Resolve an explicit Stella override to its upstream model id. The opaque
 * `default` selection has no concrete model without an agent + audience, so
 * it's rejected here — callers resolve defaults via `getModelConfig` instead.
 */
export const resolveStellaModelSelection = (
  selection?: string | null,
): string => {
  const parsed = parseStellaModelSelection(selection);
  if (parsed?.kind === "upstream") {
    return parsed.model;
  }
  const trimmed = selection?.trim();
  if (trimmed && !trimmed.startsWith(`${STELLA_PROVIDER}/`)) {
    return trimmed;
  }
  throw new Error(`Unsupported Stella model selection: ${trimmed ?? ""}`);
};

export const listStellaCatalogModels = (
  audience: ManagedModelAudience = "free",
): StellaCatalogModel[] =>
  listUpstreamManagedModels().map<StellaCatalogModel>((upstreamModel) => ({
    id: toStellaModelId(upstreamModel),
    name: deriveDisplayName(upstreamModel),
    provider: STELLA_PROVIDER,
    upstreamModel,
    type: "language",
    // Restricted tiers (anonymous / free / go) can't override the
    // backend-chosen default at all, so every pinnable model is disabled
    // for them; pro+ may pin any managed model.
    allowedForAudience: canOverrideStellaModel(audience),
  }));

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
