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
  "google/gemini-3-flash-preview": [
    "google/gemini-3-flash",
    "vercel/google/gemini-3-flash",
    "vercel/google/gemini-3-flash-preview",
  ],
  "anthropic/claude-sonnet-4.6": [
    "vercel/anthropic/claude-sonnet-4.6",
    "anthropic/claude-sonnet-4-6",
  ],
  "anthropic/claude-opus-4.8": [
    "vercel/anthropic/claude-opus-4.8",
    "anthropic/claude-opus-4-8",
  ],
  "anthropic/claude-opus-4.6": [
    "vercel/anthropic/claude-opus-4.6",
    "anthropic/claude-opus-4-6",
  ],
  "anthropic/claude-opus-4.5": [
    "vercel/anthropic/claude-opus-4.5",
    "anthropic/claude-opus-4-5",
  ],
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
  const direct = parseCandidatePath(model);
  const candidates = [
    `vercel/${model}`,
    model,
    ...(MODELS_DEV_ALIASES[model] ?? []),
  ];

  // models.dev uses provider "fireworks-ai" with full IDs (e.g. accounts/fireworks/routers/…)
  // as keys; a naive split on the first "/" looks under data.accounts instead.
  if (model.startsWith("accounts/fireworks/")) {
    candidates.push(`fireworks-ai/${model}`);
  }

  if (direct) {
    candidates.push(`${direct.provider}/${direct.modelId.replace(/\./g, "-")}`);
    if (direct.provider === "accounts" && direct.modelId.startsWith("fireworks/models/")) {
      candidates.push(`fireworks/${direct.modelId.slice("fireworks/models/".length)}`);
    }
  }

  for (const candidate of candidates) {
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

/**
 * Static prices for managed models not yet (or never) present on models.dev.
 * Used as a fill-in when the models.dev sync would otherwise fail the whole
 * catalog, and as the authoritative price for Muse Spark until Meta lands on
 * models.dev with matching rates.
 *
 * Prices are USD per 1M tokens. Muse Spark 1.1: $1.25 input / $4.25 output
 * (Axios-reported Meta Model API customer pricing as of the Muse Spark 1.1
 * public preview announcement).
 */
export const STATIC_MANAGED_MODEL_PRICE_OVERRIDES: Record<
  string,
  {
    sourceProvider: string;
    sourceModelId: string;
    inputPerMillionUsd: number;
    outputPerMillionUsd: number;
    cacheReadPerMillionUsd?: number;
    cacheWritePerMillionUsd?: number;
    reasoningPerMillionUsd?: number;
    modalitiesInput?: string[];
    modalitiesOutput?: string[];
  }
> = {
  "meta/muse-spark-1.1": {
    sourceProvider: "meta",
    sourceModelId: "muse-spark-1.1",
    inputPerMillionUsd: 1.25,
    outputPerMillionUsd: 4.25,
    // Reasoning is billed at the output rate when usage separates it.
    reasoningPerMillionUsd: 4.25,
    modalitiesInput: ["text", "image", "video", "pdf"],
    modalitiesOutput: ["text"],
  },
  // OpenAI GPT-5.6 Sol (limited preview). OpenAI rates: $5 / $30 per 1M.
  // Prefer models.dev once listed; static prevents incomplete sync + $0 billing.
  "openai/gpt-5.6-sol": {
    sourceProvider: "openai",
    sourceModelId: "gpt-5.6-sol",
    inputPerMillionUsd: 5,
    outputPerMillionUsd: 30,
    cacheReadPerMillionUsd: 0.5,
    cacheWritePerMillionUsd: 6.25,
    reasoningPerMillionUsd: 30,
    modalitiesInput: ["text", "image"],
    modalitiesOutput: ["text"],
  },
  // OpenAI GPT-5.6 Luna launch rates: $1 / $6 per 1M tokens. GPT-5.6
  // cached reads are 90% off and cache writes cost 1.25x uncached input.
  "openai/gpt-5.6-luna": {
    sourceProvider: "openai",
    sourceModelId: "gpt-5.6-luna",
    inputPerMillionUsd: 1,
    outputPerMillionUsd: 6,
    cacheReadPerMillionUsd: 0.1,
    cacheWritePerMillionUsd: 1.25,
    reasoningPerMillionUsd: 6,
    modalitiesInput: ["text", "image"],
    modalitiesOutput: ["text"],
  },
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
      reasoningPerMillionUsd: toNumber(cost?.reasoning),
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
