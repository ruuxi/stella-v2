import { describe, expect, it } from "bun:test";

import {
  centsToMicroCents,
  computeUsageCostMicroCents,
  DEFAULT_TOKEN_PRICE,
  dollarsToMicroCents,
  microCentsToDollars,
  normalizeTokenPriceConfig,
  STATIC_MANAGED_MODEL_PRICE_OVERRIDES,
  type TokenPriceCatalog,
} from "@stella/model-catalog/pricing";

describe("computeUsageCostMicroCents", () => {
  const price = {
    inputPerMillionUsd: 1,
    outputPerMillionUsd: 10,
    cacheReadPerMillionUsd: 0.1,
    cacheWritePerMillionUsd: 1.25,
  };

  it("bills reasoning at the output rate when no reasoning rate is published", () => {
    // models.dev omits `cost.reasoning` for most models, so a stored 0 means
    // "unpublished" and must not zero out a reasoning-heavy completion.
    const cost = computeUsageCostMicroCents({
      model: "test",
      inputTokens: 0,
      outputTokens: 1_000_000,
      reasoningTokens: 900_000,
      price: { ...price, reasoningPerMillionUsd: 0 },
    });

    // 100k visible + 900k reasoning, all at $10/M => $10.
    expect(cost).toBe(1_000_000_000);
  });

  it("honors an explicit reasoning rate above the output rate", () => {
    const cost = computeUsageCostMicroCents({
      model: "test",
      inputTokens: 0,
      outputTokens: 1_000_000,
      reasoningTokens: 500_000,
      price: { ...price, reasoningPerMillionUsd: 20 },
    });

    // 500k output at $10/M + 500k reasoning at $20/M => $15.
    expect(cost).toBe(1_500_000_000);
  });

  it("bills uncached input once when cache buckets are present", () => {
    // Callers pass gross input; the uncached remainder is 500k.
    const cost = computeUsageCostMicroCents({
      model: "test",
      inputTokens: 1_000_000,
      outputTokens: 0,
      cachedInputTokens: 400_000,
      cacheWriteInputTokens: 100_000,
      price,
    });

    // 500k @ $1/M + 400k @ $0.10/M + 100k @ $1.25/M => $0.665.
    expect(cost).toBe(66_500_000);
  });

  it("prices from the supplied catalog by exact model id, then its default", () => {
    const catalog: TokenPriceCatalog = {
      default: { inputPerMillionUsd: 2, outputPerMillionUsd: 4 },
      models: {
        "openai/gpt-5.5": { inputPerMillionUsd: 1, outputPerMillionUsd: 10 },
      },
    };
    expect(
      computeUsageCostMicroCents({
        model: "openai/gpt-5.5",
        inputTokens: 1_000_000,
        outputTokens: 1_000_000,
        catalog,
      }),
    ).toBe(1_100_000_000);
    expect(
      computeUsageCostMicroCents({
        model: "unknown/model",
        inputTokens: 1_000_000,
        outputTokens: 1_000_000,
        catalog,
      }),
    ).toBe(600_000_000);
    // An explicit price wins over the catalog.
    expect(
      computeUsageCostMicroCents({
        model: "openai/gpt-5.5",
        inputTokens: 1_000_000,
        outputTokens: 0,
        price: { inputPerMillionUsd: 3, outputPerMillionUsd: 0 },
        catalog,
      }),
    ).toBe(300_000_000);
  });

  it("falls back to the package baseline price without a catalog", () => {
    expect(DEFAULT_TOKEN_PRICE).toEqual({
      inputPerMillionUsd: 0.6,
      outputPerMillionUsd: 3.0,
    });
    expect(
      computeUsageCostMicroCents({
        model: "anything",
        inputTokens: 1_000_000,
        outputTokens: 1_000_000,
      }),
    ).toBe(360_000_000);
  });
});

describe("money helpers", () => {
  it("converts between dollars, cents, and micro-cents", () => {
    expect(centsToMicroCents(1)).toBe(1_000_000);
    expect(dollarsToMicroCents(1)).toBe(100_000_000);
    expect(microCentsToDollars(100_000_000)).toBe(1);
  });

  it("normalizes a price config with fallbacks for missing or invalid fields", () => {
    expect(
      normalizeTokenPriceConfig(
        {
          inputPerMillionUsd: 2,
          outputPerMillionUsd: -1,
          cacheReadPerMillionUsd: "x",
        },
        DEFAULT_TOKEN_PRICE,
      ),
    ).toEqual({
      inputPerMillionUsd: 2,
      outputPerMillionUsd: 3.0,
      cacheReadPerMillionUsd: 0,
      cacheWritePerMillionUsd: 0,
      reasoningPerMillionUsd: 3.0,
    });
    expect(normalizeTokenPriceConfig(null, DEFAULT_TOKEN_PRICE)).toBe(
      DEFAULT_TOKEN_PRICE,
    );
  });
});

describe("static price overrides", () => {
  it("carries the Muse contributor and Crof V4 Flash rates", () => {
    expect(
      STATIC_MANAGED_MODEL_PRICE_OVERRIDES["meta/muse-spark-1.2-contributor"],
    ).toMatchObject({
      sourceProvider: "openrouter",
      inputPerMillionUsd: 0.1,
      outputPerMillionUsd: 0.2,
      reasoningPerMillionUsd: 0.2,
    });
    expect(
      STATIC_MANAGED_MODEL_PRICE_OVERRIDES["crof/deepseek-v4-flash-0731"],
    ).toMatchObject({
      sourceProvider: "crof",
      inputPerMillionUsd: 0.12,
      outputPerMillionUsd: 0.21,
    });
  });
});
