/**
 * Token pricing for Stella-paid managed completions: the price shape, the
 * micro-cent money helpers, the pure cost calculator, and the static price
 * fill-ins for models not yet on models.dev. No env access here; callers
 * supply their catalog.
 */
export const MICRO_CENTS_PER_CENT = 1_000_000;
export const CENTS_PER_DOLLAR = 100;

export type TokenPriceConfig = {
  inputPerMillionUsd: number;
  outputPerMillionUsd: number;
  cacheReadPerMillionUsd?: number;
  cacheWritePerMillionUsd?: number;
  reasoningPerMillionUsd?: number;
};

export type TokenPriceCatalog = {
  default: TokenPriceConfig;
  models: Record<string, TokenPriceConfig>;
};

export const DEFAULT_TOKEN_PRICE: TokenPriceConfig = {
  // Reference baseline from OpenCode Go docs/token table.
  inputPerMillionUsd: 0.6,
  outputPerMillionUsd: 3.0,
};

export const DEFAULT_TOKEN_PRICE_CATALOG: TokenPriceCatalog = {
  default: DEFAULT_TOKEN_PRICE,
  models: {},
};

export const parsePositiveNumber = (
  value: unknown,
  fallback: number,
): number => {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return fallback;
  }
  return value;
};

export const normalizeTokenPriceConfig = (
  value: unknown,
  fallback: TokenPriceConfig,
): TokenPriceConfig => {
  if (!value || typeof value !== "object") {
    return fallback;
  }

  const record = value as Record<string, unknown>;
  return {
    inputPerMillionUsd: parsePositiveNumber(
      record.inputPerMillionUsd,
      fallback.inputPerMillionUsd,
    ),
    outputPerMillionUsd: parsePositiveNumber(
      record.outputPerMillionUsd,
      fallback.outputPerMillionUsd,
    ),
    cacheReadPerMillionUsd: parsePositiveNumber(
      record.cacheReadPerMillionUsd,
      fallback.cacheReadPerMillionUsd ?? 0,
    ),
    cacheWritePerMillionUsd: parsePositiveNumber(
      record.cacheWritePerMillionUsd,
      fallback.cacheWritePerMillionUsd ?? 0,
    ),
    reasoningPerMillionUsd: parsePositiveNumber(
      record.reasoningPerMillionUsd,
      fallback.reasoningPerMillionUsd ?? fallback.outputPerMillionUsd,
    ),
  };
};

export const centsToMicroCents = (cents: number) =>
  Math.round(cents * MICRO_CENTS_PER_CENT);

export const dollarsToMicroCents = (dollars: number) =>
  centsToMicroCents(dollars * CENTS_PER_DOLLAR);

export const microCentsToDollars = (microCents: number) =>
  microCents / (MICRO_CENTS_PER_CENT * CENTS_PER_DOLLAR);

/**
 * Price one managed completion.
 *
 * Token conventions — every caller must normalize to these before calling,
 * because this function derives the billable buckets by subtraction:
 *
 * - `inputTokens` is GROSS: it includes `cachedInputTokens` and
 *   `cacheWriteInputTokens`. Providers disagree here (OpenAI's
 *   `prompt_tokens` and Google's `promptTokenCount` are gross, Anthropic's
 *   `input_tokens` is already net of both cache buckets), so the parsers
 *   are responsible for adding cache counts back in.
 * - `outputTokens` is GROSS: it includes `reasoningTokens`. Again providers
 *   disagree (OpenAI's `output_tokens` includes reasoning, Google's
 *   `candidatesTokenCount` excludes `thoughtsTokenCount`), so the parsers
 *   normalize to the inclusive form.
 *
 * Passing already-net counts double-discounts them and can silently bill a
 * request at zero.
 */
export type UsageCostArgs = {
  model: string;
  /** Gross prompt tokens, including cached reads and cache writes. */
  inputTokens: number;
  /** Gross completion tokens, including reasoning tokens. */
  outputTokens: number;
  cachedInputTokens?: number;
  cacheWriteInputTokens?: number;
  reasoningTokens?: number;
  /** Explicit price; wins over any catalog lookup. */
  price?: TokenPriceConfig;
};

export const computeUsageCostMicroCents = (
  args: UsageCostArgs & {
    /** Price table consulted when `price` is absent. Defaults to the
     * package baseline; Convex supplies its env-configured catalog. */
    catalog?: TokenPriceCatalog;
  },
) => {
  const catalog = args.catalog ?? DEFAULT_TOKEN_PRICE_CATALOG;
  const price = args.price ?? catalog.models[args.model] ?? catalog.default;
  const cachedInputTokens = Math.max(0, args.cachedInputTokens ?? 0);
  const cacheWriteInputTokens = Math.max(0, args.cacheWriteInputTokens ?? 0);
  const billableInputTokens = Math.max(
    0,
    args.inputTokens - cachedInputTokens - cacheWriteInputTokens,
  );
  const reasoningTokens = Math.max(0, args.reasoningTokens ?? 0);
  const textOutputTokens = Math.max(0, args.outputTokens - reasoningTokens);

  const inputUsd = (billableInputTokens / 1_000_000) * price.inputPerMillionUsd;
  const cachedInputUsd =
    (cachedInputTokens / 1_000_000) * (price.cacheReadPerMillionUsd ?? 0);
  const cacheWriteUsd =
    (cacheWriteInputTokens / 1_000_000) * (price.cacheWritePerMillionUsd ?? 0);
  const outputUsd = (textOutputTokens / 1_000_000) * price.outputPerMillionUsd;
  // A zero reasoning rate means "not published", not "free" — models.dev
  // omits `cost.reasoning` for most models and the sync stores 0. No provider
  // bills reasoning below its output rate, so fall back to it rather than
  // handing out reasoning-heavy completions for nothing.
  const reasoningUsd =
    (reasoningTokens / 1_000_000) *
    (price.reasoningPerMillionUsd || price.outputPerMillionUsd);

  return dollarsToMicroCents(
    inputUsd + cachedInputUsd + cacheWriteUsd + outputUsd + reasoningUsd,
  );
};

export type StaticManagedModelPrice = {
  sourceProvider: string;
  sourceModelId: string;
  inputPerMillionUsd: number;
  outputPerMillionUsd: number;
  cacheReadPerMillionUsd?: number;
  cacheWritePerMillionUsd?: number;
  reasoningPerMillionUsd?: number;
  modalitiesInput?: string[];
  modalitiesOutput?: string[];
};

/**
 * Static prices for managed models not yet (or never) present on models.dev.
 * Used as a fill-in when the models.dev sync would otherwise fail the whole
 * catalog, and as the authoritative price for Muse Spark until Meta lands on
 * models.dev with matching rates.
 *
 * Prices are USD per 1M tokens. Muse Spark 1.2: $1.25 input / $4.25 output
 * (Meta Model API customer pricing carried forward from the Muse Spark 1.1
 * public preview announcement).
 */
export const STATIC_MANAGED_MODEL_PRICE_OVERRIDES: Record<
  string,
  StaticManagedModelPrice
> = {
  // OpenRouter's Muse Spark 1.2 Contributor (not yet on models.dev). Rates
  // verified against OpenRouter's live /api/v1/models catalog: the
  // contributor tier is far cheaper than the first-party muse-spark-1.2
  // family row below — $0.10 input / $0.20 output / $0.002 cache-read per 1M
  // tokens, reasoning billed at the output rate. OpenRouter also documents
  // full multimodal input (text, image, video, file, audio). models.dev wins
  // once it lists the model.
  "meta/muse-spark-1.2-contributor": {
    sourceProvider: "openrouter",
    sourceModelId: "muse-spark-1.2-contributor",
    inputPerMillionUsd: 0.1,
    outputPerMillionUsd: 0.2,
    cacheReadPerMillionUsd: 0.002,
    reasoningPerMillionUsd: 0.2,
    modalitiesInput: ["text", "image", "video", "file", "audio"],
    modalitiesOutput: ["text"],
  },
  // CrofAI's /v1/models rates for DeepSeek V4 Flash 0731. The relay prefers
  // Crof's exact per-request `usage.cost`; these cover preflight reservations
  // and responses that omit exact cost.
  "crof/deepseek-v4-flash-0731": {
    sourceProvider: "crof",
    sourceModelId: "deepseek-v4-flash-0731",
    inputPerMillionUsd: 0.12,
    outputPerMillionUsd: 0.21,
    cacheReadPerMillionUsd: 0.003,
    cacheWritePerMillionUsd: 0,
    reasoningPerMillionUsd: 0.21,
    modalitiesInput: ["text"],
    modalitiesOutput: ["text"],
  },
  // Wafer's own /v1/models lists live rates for the Fast variant; this static
  // entry mirrors them ($0.28 in / $0.56 out / $0.07 cache-read per 1M,
  // reasoning billed within completion tokens at the output rate). Wafer
  // publishes no separate cache-write price. Text-only upstream.
  "wafer/deepseek-v4-flash-0731-fast": {
    sourceProvider: "wafer",
    sourceModelId: "deepseek-v4-flash-0731-fast",
    inputPerMillionUsd: 0.28,
    outputPerMillionUsd: 0.56,
    cacheReadPerMillionUsd: 0.07,
    reasoningPerMillionUsd: 0.56,
    modalitiesInput: ["text"],
    modalitiesOutput: ["text"],
  },
  "meta/muse-spark-1.2": {
    sourceProvider: "meta",
    sourceModelId: "muse-spark-1.2",
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
  // DeepSeek V4 Flash first-party rates: $0.14 cache-miss input / $0.28
  // output, cached reads at $0.0028. models.dev already publishes these under
  // `deepseek/deepseek-v4-flash`; this is only a fill-in so a models.dev
  // outage can't fail the sync and drop the catalog to DEFAULT_TOKEN_PRICE.
  // DeepSeek charges nothing to write the cache.
  "deepseek/deepseek-v4-flash": {
    sourceProvider: "deepseek",
    sourceModelId: "deepseek-v4-flash",
    inputPerMillionUsd: 0.14,
    outputPerMillionUsd: 0.28,
    cacheReadPerMillionUsd: 0.0028,
    cacheWritePerMillionUsd: 0,
    reasoningPerMillionUsd: 0.28,
    modalitiesInput: ["text"],
    modalitiesOutput: ["text"],
  },
  // OpenRouter's Gemini 3.7 Flash rates. The preferred models.dev alias above
  // normally supplies these; this keeps reservations and billing correct if
  // the remote catalog is unavailable.
  "google/gemini-3.7-flash": {
    sourceProvider: "openrouter",
    sourceModelId: "google/gemini-3.7-flash",
    inputPerMillionUsd: 0.375,
    outputPerMillionUsd: 1.875,
    cacheReadPerMillionUsd: 0.0375,
    cacheWritePerMillionUsd: 0.020833,
    reasoningPerMillionUsd: 1.875,
    modalitiesInput: ["text", "image", "audio", "video", "pdf"],
    modalitiesOutput: ["text"],
  },
  // Gemini 3.6 Flash GA rates: $1.50 / $7.50 per 1M tokens, with cached
  // input at $0.15. Keep a static fill-in while models.dev catches up.
  "google/gemini-3.6-flash": {
    sourceProvider: "google",
    sourceModelId: "gemini-3.6-flash",
    inputPerMillionUsd: 1.5,
    outputPerMillionUsd: 7.5,
    cacheReadPerMillionUsd: 0.15,
    reasoningPerMillionUsd: 7.5,
    modalitiesInput: ["text", "image", "audio", "video", "pdf"],
    modalitiesOutput: ["text"],
  },
};
