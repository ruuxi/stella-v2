const MICRO_CENTS_PER_CENT = 1_000_000;
const CENTS_PER_DOLLAR = 100;

export type TokenPriceConfig = {
  inputPerMillionUsd: number;
  outputPerMillionUsd: number;
  cacheReadPerMillionUsd?: number;
  cacheWritePerMillionUsd?: number;
  reasoningPerMillionUsd?: number;
};

export type RealtimePriceConfig = {
  textInputPerMillionUsd: number;
  textCachedInputPerMillionUsd: number;
  textOutputPerMillionUsd: number;
  audioInputPerMillionUsd: number;
  audioCachedInputPerMillionUsd: number;
  audioOutputPerMillionUsd: number;
  imageInputPerMillionUsd: number;
  imageCachedInputPerMillionUsd: number;
};

type ServicePriceCatalog = {
  defaultUsd: number;
  services: Record<string, number>;
};

type RealtimeSttPriceConfig = {
  audioPerHourUsd: number;
};

const DEFAULT_REALTIME_PRICE_CATALOG: Record<string, RealtimePriceConfig> = {
  "gpt-realtime-1.5": {
    textInputPerMillionUsd: 4,
    textCachedInputPerMillionUsd: 0.4,
    textOutputPerMillionUsd: 16,
    audioInputPerMillionUsd: 32,
    audioCachedInputPerMillionUsd: 0.4,
    audioOutputPerMillionUsd: 64,
    imageInputPerMillionUsd: 5,
    imageCachedInputPerMillionUsd: 0.5,
  },
  "gpt-realtime-2": {
    textInputPerMillionUsd: 4,
    textCachedInputPerMillionUsd: 0.4,
    textOutputPerMillionUsd: 24,
    audioInputPerMillionUsd: 32,
    audioCachedInputPerMillionUsd: 0.4,
    audioOutputPerMillionUsd: 64,
    imageInputPerMillionUsd: 5,
    imageCachedInputPerMillionUsd: 0.5,
  },
  "gpt-realtime-2.1": {
    textInputPerMillionUsd: 4,
    textCachedInputPerMillionUsd: 0.4,
    textOutputPerMillionUsd: 24,
    audioInputPerMillionUsd: 32,
    audioCachedInputPerMillionUsd: 0.4,
    audioOutputPerMillionUsd: 64,
    imageInputPerMillionUsd: 5,
    imageCachedInputPerMillionUsd: 0.5,
  },
};

const DEFAULT_REALTIME_LLM_PRICE_CATALOG: Record<string, TokenPriceConfig> = {
  "gpt-4o-mini": {
    inputPerMillionUsd: 0.15,
    cacheReadPerMillionUsd: 0.075,
    outputPerMillionUsd: 0.6,
    reasoningPerMillionUsd: 0.6,
  },
  "openai/gpt-4o-mini": {
    inputPerMillionUsd: 0.15,
    cacheReadPerMillionUsd: 0.075,
    outputPerMillionUsd: 0.6,
    reasoningPerMillionUsd: 0.6,
  },
};

const DEFAULT_REALTIME_STT_PRICE_CATALOG: Record<
  string,
  RealtimeSttPriceConfig
> = {
  // Inworld Creator-tier realtime STT price.
  "inworld/inworld-stt-1": {
    audioPerHourUsd: 0.35,
  },
  // Current Stella Inworld realtime STT model. Inworld exposes this as a
  // selectable STT model; we meter it through the Creator STT rate.
  "assemblyai/u3-rt-pro": {
    audioPerHourUsd: 0.35,
  },
};

const DEFAULT_TTS_PRICE_CATALOG: Record<
  string,
  {
    textInputPerMillionUsd: number;
    audioOutputPerMillionUsd: number;
  }
> = {
  "gpt-4o-mini-tts": {
    textInputPerMillionUsd: 0.6,
    audioOutputPerMillionUsd: 12,
  },
};

const lookupRealtimePriceConfig = (
  model: string,
): RealtimePriceConfig | undefined =>
  DEFAULT_REALTIME_PRICE_CATALOG[model] ??
  (model.startsWith("gpt-realtime-2.1-")
    ? DEFAULT_REALTIME_PRICE_CATALOG["gpt-realtime-2.1"]
    : undefined) ??
  (model.startsWith("gpt-realtime-2-")
    ? DEFAULT_REALTIME_PRICE_CATALOG["gpt-realtime-2"]
    : undefined) ??
  (model.startsWith("gpt-realtime-1.5-")
    ? DEFAULT_REALTIME_PRICE_CATALOG["gpt-realtime-1.5"]
    : undefined);

const lookupRealtimeLlmPriceConfig = (
  model: string,
): TokenPriceConfig | undefined =>
  DEFAULT_REALTIME_LLM_PRICE_CATALOG[model] ??
  (model.startsWith("openai/")
    ? DEFAULT_REALTIME_LLM_PRICE_CATALOG[model.slice("openai/".length)]
    : undefined);

const lookupRealtimeSttPriceConfig = (
  model: string | undefined,
): RealtimeSttPriceConfig | undefined =>
  model ? DEFAULT_REALTIME_STT_PRICE_CATALOG[model] : undefined;

const lookupTtsPriceConfig = (
  model: string,
):
  | { textInputPerMillionUsd: number; audioOutputPerMillionUsd: number }
  | undefined =>
  DEFAULT_TTS_PRICE_CATALOG[model] ??
  (model.startsWith("gpt-4o-mini-tts-")
    ? DEFAULT_TTS_PRICE_CATALOG["gpt-4o-mini-tts"]
    : undefined);

const DEFAULT_TOKEN_PRICE: TokenPriceConfig = {
  // Reference baseline from OpenCode Go docs/token table.
  inputPerMillionUsd: 0.6,
  outputPerMillionUsd: 3.0,
};

const DEFAULT_SERVICE_PRICE_CATALOG: ServicePriceCatalog = {
  defaultUsd: 0,
  services: {},
};

type TokenPriceCatalog = {
  default: TokenPriceConfig;
  models: Record<string, TokenPriceConfig>;
};

const parsePositiveNumber = (value: unknown, fallback: number): number => {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return fallback;
  }
  return value;
};

const normalizePriceConfig = (
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

const loadTokenPriceCatalog = (): TokenPriceCatalog => {
  const raw = process.env.STELLA_TOKEN_PRICE_CATALOG_JSON?.trim();
  if (!raw) {
    return {
      default: DEFAULT_TOKEN_PRICE,
      models: {},
    };
  }

  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const defaults = normalizePriceConfig(parsed.default, DEFAULT_TOKEN_PRICE);
    const modelEntries =
      parsed.models && typeof parsed.models === "object"
        ? (parsed.models as Record<string, unknown>)
        : {};

    const models: Record<string, TokenPriceConfig> = {};
    for (const [model, config] of Object.entries(modelEntries)) {
      const normalizedModel = model.trim();
      if (!normalizedModel) {
        continue;
      }
      models[normalizedModel] = normalizePriceConfig(config, defaults);
    }

    return {
      default: defaults,
      models,
    };
  } catch (error) {
    console.warn(
      "[billing] Invalid STELLA_TOKEN_PRICE_CATALOG_JSON. Falling back to defaults.",
      error,
    );
    return {
      default: DEFAULT_TOKEN_PRICE,
      models: {},
    };
  }
};

const TOKEN_PRICE_CATALOG = loadTokenPriceCatalog();

const normalizeServiceKey = (value: string): string =>
  value.trim().toLowerCase();

const loadServicePriceCatalog = (): ServicePriceCatalog => {
  const raw = process.env.STELLA_SERVICE_PRICE_CATALOG_JSON?.trim();
  if (!raw) {
    return DEFAULT_SERVICE_PRICE_CATALOG;
  }

  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const serviceEntries =
      parsed.services && typeof parsed.services === "object"
        ? (parsed.services as Record<string, unknown>)
        : {};

    const services: Record<string, number> = {
      ...DEFAULT_SERVICE_PRICE_CATALOG.services,
    };
    for (const [serviceKey, value] of Object.entries(serviceEntries)) {
      const normalizedKey = normalizeServiceKey(serviceKey);
      if (!normalizedKey) {
        continue;
      }
      services[normalizedKey] = parsePositiveNumber(value, 0);
    }

    return {
      defaultUsd: parsePositiveNumber(
        parsed.defaultUsd,
        DEFAULT_SERVICE_PRICE_CATALOG.defaultUsd,
      ),
      services,
    };
  } catch (error) {
    console.warn(
      "[billing] Invalid STELLA_SERVICE_PRICE_CATALOG_JSON. Falling back to defaults.",
      error,
    );
    return DEFAULT_SERVICE_PRICE_CATALOG;
  }
};

const SERVICE_PRICE_CATALOG = loadServicePriceCatalog();

const XAI_REALTIME_AUDIO_PER_MINUTE_USD = 0.05;

const isXaiRealtimeModel = (model: string): boolean =>
  model === "grok-voice-latest" || model.startsWith("grok-voice-");

export const centsToMicroCents = (cents: number) =>
  Math.round(cents * MICRO_CENTS_PER_CENT);

export const dollarsToMicroCents = (dollars: number) =>
  centsToMicroCents(dollars * CENTS_PER_DOLLAR);

export const microCentsToDollars = (microCents: number) =>
  microCents / (MICRO_CENTS_PER_CENT * CENTS_PER_DOLLAR);

export const computeUsageCostMicroCents = (args: {
  model: string;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens?: number;
  cacheWriteInputTokens?: number;
  reasoningTokens?: number;
  price?: TokenPriceConfig;
}) => {
  const price =
    args.price ??
    TOKEN_PRICE_CATALOG.models[args.model] ??
    TOKEN_PRICE_CATALOG.default;
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
  const reasoningUsd =
    (reasoningTokens / 1_000_000) *
    (price.reasoningPerMillionUsd ?? price.outputPerMillionUsd);

  return dollarsToMicroCents(
    inputUsd + cachedInputUsd + cacheWriteUsd + outputUsd + reasoningUsd,
  );
};

export const resolveServicePriceUsd = (serviceKey: string): number => {
  let currentKey = normalizeServiceKey(serviceKey);
  while (currentKey) {
    const configured = SERVICE_PRICE_CATALOG.services[currentKey];
    if (typeof configured === "number") {
      return configured;
    }

    const separatorIndex = currentKey.lastIndexOf(":");
    if (separatorIndex < 0) {
      break;
    }
    currentKey = currentKey.slice(0, separatorIndex);
  }

  return SERVICE_PRICE_CATALOG.defaultUsd;
};

export const computeServiceCostMicroCents = (serviceKey: string): number =>
  dollarsToMicroCents(resolveServicePriceUsd(serviceKey));

export const computeRealtimeUsageCostMicroCents = (args: {
  model: string;
  exactCostMicroCents?: number;
  textInputTokens?: number;
  textCachedInputTokens?: number;
  textOutputTokens?: number;
  audioInputTokens?: number;
  audioCachedInputTokens?: number;
  audioOutputTokens?: number;
  imageInputTokens?: number;
  imageCachedInputTokens?: number;
  realtimeAudioSeconds?: number;
  realtimeTextInputMessages?: number;
  sttModel?: string;
  sttAudioSeconds?: number;
}) => {
  if (
    typeof args.exactCostMicroCents === "number" &&
    Number.isFinite(args.exactCostMicroCents)
  ) {
    return Math.max(0, Math.floor(args.exactCostMicroCents));
  }

  const price = lookupRealtimePriceConfig(args.model);
  let totalUsd = 0;

  if (price) {
    const textInputUsd =
      (Math.max(0, args.textInputTokens ?? 0) / 1_000_000) *
      price.textInputPerMillionUsd;
    const textCachedInputUsd =
      (Math.max(0, args.textCachedInputTokens ?? 0) / 1_000_000) *
      price.textCachedInputPerMillionUsd;
    const textOutputUsd =
      (Math.max(0, args.textOutputTokens ?? 0) / 1_000_000) *
      price.textOutputPerMillionUsd;
    const audioInputUsd =
      (Math.max(0, args.audioInputTokens ?? 0) / 1_000_000) *
      price.audioInputPerMillionUsd;
    const audioCachedInputUsd =
      (Math.max(0, args.audioCachedInputTokens ?? 0) / 1_000_000) *
      price.audioCachedInputPerMillionUsd;
    const audioOutputUsd =
      (Math.max(0, args.audioOutputTokens ?? 0) / 1_000_000) *
      price.audioOutputPerMillionUsd;
    const imageInputUsd =
      (Math.max(0, args.imageInputTokens ?? 0) / 1_000_000) *
      price.imageInputPerMillionUsd;
    const imageCachedInputUsd =
      (Math.max(0, args.imageCachedInputTokens ?? 0) / 1_000_000) *
      price.imageCachedInputPerMillionUsd;

    totalUsd +=
      textInputUsd +
      textCachedInputUsd +
      textOutputUsd +
      audioInputUsd +
      audioCachedInputUsd +
      audioOutputUsd +
      imageInputUsd +
      imageCachedInputUsd;
  }

  const llmPrice = lookupRealtimeLlmPriceConfig(args.model);
  if (llmPrice) {
    const textInputTokens = Math.max(0, args.textInputTokens ?? 0);
    const textCachedInputTokens = Math.max(0, args.textCachedInputTokens ?? 0);
    const billableInputTokens = Math.max(
      0,
      textInputTokens - textCachedInputTokens,
    );
    totalUsd +=
      (billableInputTokens / 1_000_000) * llmPrice.inputPerMillionUsd +
      (textCachedInputTokens / 1_000_000) *
        (llmPrice.cacheReadPerMillionUsd ?? 0) +
      (Math.max(0, args.textOutputTokens ?? 0) / 1_000_000) *
        llmPrice.outputPerMillionUsd;
  }

  if (isXaiRealtimeModel(args.model)) {
    totalUsd +=
      (Math.max(0, args.realtimeAudioSeconds ?? 0) / 60) *
      XAI_REALTIME_AUDIO_PER_MINUTE_USD;
  }

  const sttPrice = lookupRealtimeSttPriceConfig(args.sttModel);
  if (sttPrice) {
    totalUsd +=
      (Math.max(0, args.sttAudioSeconds ?? 0) / 3600) *
      sttPrice.audioPerHourUsd;
  }

  return dollarsToMicroCents(totalUsd);
};

export const computeTtsUsageCostMicroCents = (args: {
  model: string;
  textInputTokens: number;
  audioOutputTokens: number;
}) => {
  const price = lookupTtsPriceConfig(args.model);
  if (!price) {
    return 0;
  }

  const textInputUsd =
    (Math.max(0, args.textInputTokens) / 1_000_000) *
    price.textInputPerMillionUsd;
  const audioOutputUsd =
    (Math.max(0, args.audioOutputTokens) / 1_000_000) *
    price.audioOutputPerMillionUsd;

  return dollarsToMicroCents(textInputUsd + audioOutputUsd);
};
