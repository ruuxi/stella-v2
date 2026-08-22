import type { Api, Model } from "@stella/contracts/model-catalog";
import type {
  RuntimeModelCatalogModel,
  RuntimeModelCatalogSnapshot,
} from "@stella/contracts/model-catalog";
import { STELLA_DEFAULT_UPSTREAM_MODEL } from "@/shared/stella-api";
// Provider display names live in a shared, browser-safe runtime module so the
// model picker and the runtime route-error toasts can't drift apart.
import { getProviderDisplayName } from "@stella/contracts/provider-display";
import { LOCAL_MODEL_PROVIDER_KEYS } from "./llm-providers";

export type CatalogModelSource = "stella" | "local";

export type CatalogModel = {
  id: string;
  name: string;
  provider: string;
  providerName: string;
  modelId: string;
  source: CatalogModelSource;
  upstreamModel?: string;
  contextWindow?: number;
  maxTokens?: number;
  input?: Model<Api>["input"];
  reasoning?: boolean;
  /** The model came from models.json or an extension/runtime registration. */
  runtimeManaged?: boolean;
  /** Authentication for this provider is owned by models.json/an extension. */
  runtimeManagedAuth?: boolean;
  /** The runtime explicitly allows this configured custom provider without auth. */
  runtimeCredentialless?: boolean;
  /**
   * Whether the backend will honor this model for the current user's
   * audience. Defaults to true; the Stella `/api/models` endpoint sets
   * it to false on per-tier-restricted models so the picker disables
   * them in sync with the backend's request-time coercion. Models from
   * other providers (BYOK / local) never carry a restriction.
   */
  allowedForAudience?: boolean;
};

export type CatalogDefaultModel = {
  agentType: string;
  model: string;
  resolvedModel: string;
};

export type ProviderGroup = {
  provider: string;
  providerName: string;
  models: CatalogModel[];
  runtimeManaged: boolean;
  runtimeManagedAuth: boolean;
  runtimeCredentialless: boolean;
};

export type ManagedRuntimeCatalogPayload = {
  revision: number;
  directModels: CatalogModel[];
  configError?: string;
  catalogError?: string;
};

export type CatalogApiModel = {
  id: string;
  name?: string;
  provider?: string;
  type?: string;
  upstreamModel?: string;
  allowedForAudience?: boolean;
};

export type CatalogApiResponse = {
  data?: CatalogApiModel[];
  defaults?: CatalogDefaultModel[];
};

export { getProviderDisplayName };

/**
 * Always-present fallback for Stella's single managed model. This keeps the
 * picker usable while `/api/models` is loading or temporarily unavailable;
 * the fetched row replaces it with authoritative metadata.
 */
const STELLA_PRESET_FALLBACK_DEFS: ReadonlyArray<{
  id: string;
  modelId: string;
  name: string;
  upstreamModel: string;
}> = [
  {
    id: `stella/${STELLA_DEFAULT_UPSTREAM_MODEL}`,
    modelId: STELLA_DEFAULT_UPSTREAM_MODEL,
    name: "Muse Spark 1.2 Contributor",
    upstreamModel: STELLA_DEFAULT_UPSTREAM_MODEL,
  },
];

export const STELLA_PRESET_FALLBACK_MODELS: readonly CatalogModel[] =
  STELLA_PRESET_FALLBACK_DEFS.map(({ id, modelId, name, upstreamModel }) => ({
    id,
    modelId,
    name,
    provider: "stella",
    providerName: getProviderDisplayName("stella"),
    source: "stella" as const,
    upstreamModel,
  }));

/**
 * Use the fixed fallback only until the authoritative catalog has loaded.
 * Merging both sources by id leaks a retired fallback whenever the backend
 * switches a model's upstream id, producing two picker rows for one model.
 */
export function withStellaPresetFallbacks(
  stellaModels: readonly CatalogModel[],
): CatalogModel[] {
  return stellaModels.length > 0
    ? [...stellaModels]
    : [...STELLA_PRESET_FALLBACK_MODELS];
}

function compareCatalogModels(a: CatalogModel, b: CatalogModel): number {
  if (a.provider === "stella" && b.provider !== "stella") return -1;
  if (a.provider !== "stella" && b.provider === "stella") return 1;
  const providerSort = a.providerName.localeCompare(b.providerName);
  if (providerSort) return providerSort;
  const aIsStellaPreset =
    a.provider === "stella" &&
    (a.name.startsWith("Stella ") ||
      (a.id.startsWith("stella/") && !a.modelId.includes("/")));
  const bIsStellaPreset =
    b.provider === "stella" &&
    (b.name.startsWith("Stella ") ||
      (b.id.startsWith("stella/") && !b.modelId.includes("/")));
  if (aIsStellaPreset && !bIsStellaPreset) return -1;
  if (!aIsStellaPreset && bIsStellaPreset) return 1;
  if (a.source === "stella" && b.source !== "stella") return -1;
  if (a.source !== "stella" && b.source === "stella") return 1;
  return a.name.localeCompare(b.name);
}

export function listLocalCatalogModels(): CatalogModel[] {
  return [
    {
      id: "local/llama3.2",
      modelId: "llama3.2",
      name: "llama3.2",
      provider: "local",
      providerName: getProviderDisplayName("local"),
      source: "local",
      input: ["text"],
      reasoning: false,
    },
  ];
}

export function normalizeStellaCatalogModels(
  models: readonly CatalogApiModel[],
): CatalogModel[] {
  return models
    .filter(
      (model) =>
        !model.type || model.type === "language" || model.type === "multimodal",
    )
    .map((model) => {
      const provider = model.provider ?? "stella";
      return {
        id: model.id,
        modelId: model.id.startsWith(`${provider}/`)
          ? model.id.slice(provider.length + 1)
          : model.id,
        name: model.name ?? model.id,
        provider,
        providerName: getProviderDisplayName(provider),
        upstreamModel: model.upstreamModel,
        allowedForAudience: model.allowedForAudience,
        source: "stella" as const,
      };
    });
}

export function normalizeRuntimeCatalogModels(
  models: readonly RuntimeModelCatalogModel[],
  runtimeManagedProviders: RuntimeModelCatalogSnapshot["runtimeManagedProviders"] = [],
): CatalogModel[] {
  const runtimeManagedById = new Map(
    runtimeManagedProviders.map((provider) => [provider.id, provider]),
  );
  const selectableProviders = new Set([
    ...LOCAL_MODEL_PROVIDER_KEYS,
    ...runtimeManagedById.keys(),
  ]);
  return models
    .filter(
      (model) =>
        model.api !== "stella" &&
        model.provider !== "stella" &&
        selectableProviders.has(model.provider),
    )
    .map((model) => ({
      id: `${model.provider}/${model.id}`,
      modelId: model.id,
      name: model.name || model.id,
      provider: model.provider,
      providerName: getProviderDisplayName(model.provider),
      source: "local" as const,
      contextWindow: model.contextWindow,
      maxTokens: model.maxTokens,
      input: model.input,
      reasoning: model.reasoning,
      runtimeManaged: runtimeManagedById.has(model.provider),
      runtimeManagedAuth:
        runtimeManagedById.get(model.provider)?.authManaged ?? false,
      runtimeCredentialless:
        runtimeManagedById.get(model.provider)?.credentialless ?? false,
    }))
    .sort(compareCatalogModels);
}

export function normalizeRuntimeCatalogSnapshot(
  snapshot: RuntimeModelCatalogSnapshot | null | undefined,
): ManagedRuntimeCatalogPayload {
  return {
    revision: snapshot?.revision ?? 0,
    directModels: normalizeRuntimeCatalogModels(
      snapshot?.models ?? [],
      snapshot?.runtimeManagedProviders ?? [],
    ),
    configError: snapshot?.configError,
    catalogError: snapshot?.catalogError,
  };
}

export function mergeCatalogModels(
  stellaModels: readonly CatalogModel[],
  localModels: readonly CatalogModel[],
): CatalogModel[] {
  const byId = new Map<string, CatalogModel>();
  for (const model of localModels) {
    byId.set(model.id, model);
  }
  for (const model of stellaModels) {
    byId.set(model.id, model);
  }
  return Array.from(byId.values()).sort(compareCatalogModels);
}

export function groupCatalogModelsByProvider(
  models: readonly CatalogModel[],
): ProviderGroup[] {
  const map = new Map<string, CatalogModel[]>();
  for (const model of models) {
    const list = map.get(model.provider) ?? [];
    list.push(model);
    map.set(model.provider, list);
  }
  return Array.from(map.entries())
    .map(([provider, models]) => ({
      provider,
      providerName: models[0]?.providerName ?? getProviderDisplayName(provider),
      models: [...models].sort(compareCatalogModels),
      runtimeManaged: models.some((model) => model.runtimeManaged === true),
      runtimeManagedAuth: models.some(
        (model) => model.runtimeManagedAuth === true,
      ),
      runtimeCredentialless: models.some(
        (model) => model.runtimeCredentialless === true,
      ),
    }))
    .sort((a, b) => {
      if (a.provider === "stella" && b.provider !== "stella") return -1;
      if (a.provider !== "stella" && b.provider === "stella") return 1;
      return a.providerName.localeCompare(b.providerName);
    });
}

/**
 * Strip provider prefixes from a Stella model identifier so the visible
 * label is just the trailing model slug (e.g. `openai/gpt-5` → `gpt-5`,
 * `accounts/fireworks/models/qwen-coder-32b` → `qwen-coder-32b`). For
 * preset Stella models with no slash in the modelId we keep the
 * pre-formatted display name (e.g. "Stella Designer") because that's already
 * the friendly form. Only applied to Stella models — every other provider
 * keeps its standard label.
 */
export function getStellaDisplayName(model: CatalogModel): string {
  if (model.provider !== "stella") return model.name;
  if (!model.name.includes("/")) return model.name;
  const lastSlash = model.name.lastIndexOf("/");
  const tail = model.name.slice(lastSlash + 1).trim();
  return tail || model.name;
}

/**
 * For Stella preset modes ("Stella Designer", "Stella Builder", …) returns the
 * resolved upstream model id with provider prefixes stripped, so users
 * see *both* the friendly preset label and the actual model it currently
 * maps to. Returns null when there's no useful subtitle (e.g. for non-
 * Stella models, or when the upstream slug equals the display name).
 */
export function getStellaSubtitle(model: CatalogModel): string | null {
  if (model.provider !== "stella") return null;
  const candidate = model.upstreamModel?.trim();
  if (!candidate) return null;
  const trimmed = candidate.startsWith("accounts/fireworks/models/")
    ? candidate.slice("accounts/fireworks/models/".length)
    : candidate.startsWith("accounts/fireworks/routers/")
      ? candidate.slice("accounts/fireworks/routers/".length)
      : candidate;
  const lastSlash = trimmed.lastIndexOf("/");
  const tail = (lastSlash >= 0 ? trimmed.slice(lastSlash + 1) : trimmed).trim();
  if (!tail) return null;
  if (tail.toLowerCase() === model.name.toLowerCase()) return null;
  return tail;
}

const STELLA_UPSTREAM_MODEL_NAMES = new Map<string, string>([
  ["meta/muse-spark-1.2-contributor", "Muse Spark 1.2 Contributor"],
  ["deepseek/deepseek-v4-flash", "DeepSeek V4 Flash"],
  ["crof/deepseek-v4-flash-0731", "DeepSeek V4 Flash 0731"],
  ["wafer/deepseek-v4-flash-0731-fast", "DeepSeek V4 Flash 0731 Fast"],
  [
    "accounts/fireworks/models/deepseek-v4-flash-0731",
    "DeepSeek V4 Flash 0731",
  ],
  ["openrouter/x-ai/grok-4.5", "Grok 4.5"],
  ["accounts/fireworks/models/kimi-k2p7-code", "Kimi K2P7 Code"],
  ["openai/gpt-5.5", "GPT-5.5"],
  ["anthropic/claude-opus-4.8", "Claude Opus 4.8"],
  ["google/gemini-3-flash-preview", "Gemini 3 Flash Preview"],
]);

const humanizeModelSlug = (slug: string): string => {
  const parts = slug.split("-").filter(Boolean);
  if (parts.length === 0) return slug;
  const words = parts.map((part) => {
    const normalized = part.toLowerCase();
    if (normalized === "deepseek") return "DeepSeek";
    if (normalized === "gpt") return "GPT";
    if (normalized === "kimi") return "Kimi";
    if (/^v\d/i.test(part)) return part.toUpperCase();
    if (/^k\d/i.test(part)) return part.toUpperCase();
    if (/^\d/.test(part)) return part;
    return `${part.charAt(0).toUpperCase()}${part.slice(1)}`;
  });
  if (words[0] === "GPT" && /^\d/.test(words[1] ?? "")) {
    return [`GPT-${words[1]}`, ...words.slice(2)].join(" ");
  }
  return words.join(" ");
};

/**
 * Single-line name for a Stella picker row. Curated Stella aliases are routing
 * presets, so their visible name should be the model they currently resolve
 * to rather than the alias ("Stella Light", "Stella Max", and so on).
 */
export function getStellaResolvedModelName(model: CatalogModel): string {
  if (model.provider !== "stella") return model.name;
  const upstreamModel = model.upstreamModel?.trim();
  if (upstreamModel) {
    const curatedName = STELLA_UPSTREAM_MODEL_NAMES.get(upstreamModel);
    if (curatedName) return curatedName;
    const slug = getStellaSubtitle(model);
    if (slug) return humanizeModelSlug(slug);
  }
  return getStellaDisplayName(model);
}

export function searchCatalogModels(
  models: readonly CatalogModel[],
  query: string,
): CatalogModel[] {
  const normalizedQuery = query.trim().toLowerCase();
  if (!normalizedQuery) return [...models];

  return models.filter((model) => {
    const haystack = [
      model.name,
      model.id,
      model.modelId,
      model.provider,
      model.providerName,
      model.upstreamModel,
    ]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();
    return haystack.includes(normalizedQuery);
  });
}
