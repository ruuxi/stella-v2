import { STATIC_MANAGED_MODEL_PRICE_OVERRIDES } from "@stella/model-catalog/pricing";

// Static price fill-ins live with the rest of the catalog pricing in
// `@stella/model-catalog/pricing`; re-exported for existing importers.
export { STATIC_MANAGED_MODEL_PRICE_OVERRIDES };

type ModelsDevCost = {
  input?: number;
  output?: number;
  cache_read?: number;
  cache_write?: number;
  reasoning?: number;
};

type ModelsDevModalities = {
  input?: string[];
  output?: string[];
};

type ModelsDevModelEntry = {
  id?: string;
  cost?: ModelsDevCost;
  modalities?: ModelsDevModalities;
  last_updated?: string;
};

type ModelsDevProviderEntry = {
  models?: Record<string, ModelsDevModelEntry>;
};

export type ModelsDevApi = Record<string, ModelsDevProviderEntry>;

export type ManagedModelPriceEntry = {
  model: string;
  source: "models.dev" | "static";
  sourceProvider: string;
  sourceModelId: string;
  inputPerMillionUsd: number;
  outputPerMillionUsd: number;
  cacheReadPerMillionUsd: number;
  cacheWritePerMillionUsd: number;
  reasoningPerMillionUsd: number;
  modalitiesInput: string[];
  modalitiesOutput: string[];
  sourceUpdatedAt: string;
  syncedAt: number;
};

type ResolvedModelsDevModel = {
  sourceProvider: string;
  sourceModelId: string;
  entry: ModelsDevModelEntry;
};

const MODELS_DEV_ALIASES: Record<string, string[]> = {
  "google/gemini-3.6-flash": ["vercel/google/gemini-3.6-flash"],
  "anthropic/claude-sonnet-4.6": [
    "vercel/anthropic/claude-sonnet-4.6",
    "anthropic/claude-sonnet-4-6",
  ],
  "anthropic/claude-opus-5": ["vercel/anthropic/claude-opus-5"],
  "anthropic/claude-opus-4.6": [
    "vercel/anthropic/claude-opus-4.6",
    "anthropic/claude-opus-4-6",
  ],
  "anthropic/claude-opus-4.5": [
    "vercel/anthropic/claude-opus-4.5",
    "anthropic/claude-opus-4-5",
  ],
  // Stella routes xAI as `x-ai`, while models.dev's first-party provider
  // namespace is `xai` (and Vercel nests the same id under its provider).
  "x-ai/grok-4.5": ["xai/grok-4.5", "vercel/xai/grok-4.5"],
};

// Some managed slugs identify the model vendor rather than the serving
// provider. Prefer the serving provider's row so billing matches what Stella
// actually pays instead of the vendor's first-party rate.
const MODELS_DEV_PREFERRED_ALIASES: Record<string, string[]> = {
  "google/gemini-3.7-flash": ["openrouter/google/gemini-3.7-flash"],
  // The Muse Spark contributor tier is served through OpenRouter, so its
  // models.dev row (once published) will live under the openrouter provider
  // namespace keyed by the full vendor/model slug — not Meta's first-party
  // namespace. Prefer it so billing matches what Stella actually pays.
  "meta/muse-spark-1.2-contributor": [
    "openrouter/meta/muse-spark-1.2-contributor",
  ],
};

const stripSnapshotSuffix = (model: string): string | null => {
  const withoutIsoDate = model.replace(/-\d{4}-\d{2}-\d{2}$/u, "");
  if (withoutIsoDate !== model) return withoutIsoDate;

  // Some providers publish MMDD snapshots (for example DeepSeek V4 Flash
  // 0731) while keeping pricing on the undated family id.
  const withoutMonthDay = model.replace(/-\d{4}$/u, "");
  return withoutMonthDay !== model ? withoutMonthDay : null;
};

/**
 * Ordered model ids that may share a billing price. Exact ids always win;
 * dated provider snapshots can fall back to the corresponding family price.
 */
export const listManagedModelPriceLookupCandidates = (
  model: string,
): string[] => {
  const normalized = model.trim();
  if (!normalized) return [];

  const candidates = [normalized];
  const snapshotBase = stripSnapshotSuffix(normalized);
  if (snapshotBase) candidates.push(snapshotBase);
  return Array.from(new Set(candidates));
};

const parseCandidatePath = (value: string) => {
  const slashIndex = value.indexOf("/");
  if (slashIndex < 0) {
    return null;
  }

  return {
    provider: value.slice(0, slashIndex),
    modelId: value.slice(slashIndex + 1),
  };
};

const resolveModelsDevModel = (
  data: ModelsDevApi,
  model: string,
): ResolvedModelsDevModel | null => {
  const candidates: string[] = [];
  for (const lookupModel of listManagedModelPriceLookupCandidates(model)) {
    const direct = parseCandidatePath(lookupModel);
    candidates.push(
      ...(MODELS_DEV_PREFERRED_ALIASES[lookupModel] ?? []),
      `vercel/${lookupModel}`,
      lookupModel,
      ...(MODELS_DEV_ALIASES[lookupModel] ?? []),
    );

    // models.dev uses provider "fireworks-ai" with full IDs (e.g.
    // accounts/fireworks/routers/…) as keys; a naive split on the first "/"
    // looks under data.accounts instead.
    if (lookupModel.startsWith("accounts/fireworks/")) {
      candidates.push(`fireworks-ai/${lookupModel}`);
    }

    if (direct) {
      candidates.push(
        `${direct.provider}/${direct.modelId.replace(/\./g, "-")}`,
      );
      if (
        direct.provider === "accounts" &&
        direct.modelId.startsWith("fireworks/models/")
      ) {
        candidates.push(
          `fireworks/${direct.modelId.slice("fireworks/models/".length)}`,
        );
      }
    }
  }

  for (const candidate of new Set(candidates)) {
    const parsed = parseCandidatePath(candidate);
    if (!parsed) {
      continue;
    }

    const entry = data[parsed.provider]?.models?.[parsed.modelId];
    if (!entry) {
      continue;
    }

    return {
      sourceProvider: parsed.provider,
      sourceModelId: parsed.modelId,
      entry,
    };
  }

  return null;
};

const resolveWithFallback = (
  data: ModelsDevApi,
  model: string,
): ResolvedModelsDevModel | null => {
  return resolveModelsDevModel(data, model);
};

const toNumber = (value: unknown) =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;

const sanitizeModalityList = (modalities?: string[]): string[] => {
  if (!Array.isArray(modalities)) return ["text"];
  const sanitized = modalities.filter(
    (item): item is string =>
      typeof item === "string" && item.length > 0 && item.length < 32,
  );
  return sanitized.length > 0 ? sanitized : ["text"];
};

export const buildManagedModelPriceEntries = (args: {
  data: ModelsDevApi;
  modelIds: string[];
  syncedAt: number;
}) => {
  const entries: ManagedModelPriceEntry[] = [];
  const missingModels: string[] = [];

  for (const model of args.modelIds) {
    const resolved = resolveWithFallback(args.data, model);
    if (!resolved) {
      const staticPrice = STATIC_MANAGED_MODEL_PRICE_OVERRIDES[model];
      if (!staticPrice) {
        missingModels.push(model);
        continue;
      }

      entries.push({
        model,
        source: "static",
        sourceProvider: staticPrice.sourceProvider,
        sourceModelId: staticPrice.sourceModelId,
        inputPerMillionUsd: staticPrice.inputPerMillionUsd,
        outputPerMillionUsd: staticPrice.outputPerMillionUsd,
        cacheReadPerMillionUsd: staticPrice.cacheReadPerMillionUsd ?? 0,
        cacheWritePerMillionUsd: staticPrice.cacheWritePerMillionUsd ?? 0,
        reasoningPerMillionUsd:
          staticPrice.reasoningPerMillionUsd ?? staticPrice.outputPerMillionUsd,
        modalitiesInput: sanitizeModalityList(staticPrice.modalitiesInput),
        modalitiesOutput: sanitizeModalityList(staticPrice.modalitiesOutput),
        sourceUpdatedAt: "",
        syncedAt: args.syncedAt,
      });
      continue;
    }

    const cost = resolved.entry.cost;

    entries.push({
      model,
      source: "models.dev",
      sourceProvider: resolved.sourceProvider,
      sourceModelId: resolved.sourceModelId,
      inputPerMillionUsd: toNumber(cost?.input),
      outputPerMillionUsd: toNumber(cost?.output),
      cacheReadPerMillionUsd: toNumber(cost?.cache_read),
      cacheWritePerMillionUsd: toNumber(cost?.cache_write),
      // models.dev publishes `cost.reasoning` for only a handful of models.
      // Storing the 0 that `toNumber` yields for the rest would bill every
      // reasoning token at zero, so mirror the static-override branch above
      // and fall back to the output rate.
      reasoningPerMillionUsd:
        toNumber(cost?.reasoning) || toNumber(cost?.output),
      modalitiesInput: sanitizeModalityList(resolved.entry.modalities?.input),
      modalitiesOutput: sanitizeModalityList(resolved.entry.modalities?.output),
      sourceUpdatedAt: resolved.entry.last_updated?.trim() ?? "",
      syncedAt: args.syncedAt,
    });
  }

  return {
    entries,
    missingModels,
  };
};
