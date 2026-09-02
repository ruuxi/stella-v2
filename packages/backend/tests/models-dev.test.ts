import { describe, expect, it } from "bun:test";

import {
  buildManagedModelPriceEntries,
  listManagedModelPriceLookupCandidates,
} from "../convex/lib/models_dev";

describe("managed model price entries", () => {
  it("uses OpenRouter pricing for Gemini 3.7 Flash", () => {
    const model = "google/gemini-3.7-flash";
    const { entries, missingModels } = buildManagedModelPriceEntries({
      data: {
        google: {
          models: {
            "gemini-3.7-flash": {
              id: "gemini-3.7-flash",
              cost: { input: 0.75, output: 3.75, cache_read: 0.075 },
            },
          },
        },
        openrouter: {
          models: {
            [model]: {
              id: model,
              cost: {
                input: 0.375,
                output: 1.875,
                reasoning: 1.875,
                cache_read: 0.0375,
                cache_write: 0.020833,
              },
              modalities: {
                input: ["text", "image", "audio", "video", "pdf"],
                output: ["text"],
              },
              last_updated: "2026-08-13",
            },
          },
        },
      },
      modelIds: [model],
      syncedAt: 1,
    });

    expect(missingModels).toEqual([]);
    expect(entries[0]).toMatchObject({
      model,
      source: "models.dev",
      sourceProvider: "openrouter",
      sourceModelId: model,
      inputPerMillionUsd: 0.375,
      outputPerMillionUsd: 1.875,
      cacheReadPerMillionUsd: 0.0375,
      cacheWritePerMillionUsd: 0.020833,
      reasoningPerMillionUsd: 1.875,
      modalitiesInput: ["text", "image", "audio", "video", "pdf"],
    });
  });

  it("uses CrofAI's published V4 Flash 0731 rates", () => {
    const {
      entries: [entry],
    } = buildManagedModelPriceEntries({
      modelIds: ["crof/deepseek-v4-flash-0731"],
      data: {},
      syncedAt: 123,
    });
    expect(entry).toMatchObject({
      source: "static",
      sourceProvider: "crof",
      sourceModelId: "deepseek-v4-flash-0731",
      inputPerMillionUsd: 0.12,
      outputPerMillionUsd: 0.21,
      cacheReadPerMillionUsd: 0.003,
      reasoningPerMillionUsd: 0.21,
    });
  });

  it("uses Wafer's published V4 Flash Fast rates", () => {
    // Mirrors wafer's own /v1/models pricing: $0.28 in / $0.56 out /
    // $0.07 cache-read per 1M, reasoning at the output rate. Text-only.
    const {
      entries: [entry],
      missingModels,
    } = buildManagedModelPriceEntries({
      modelIds: ["wafer/deepseek-v4-flash-0731-fast"],
      data: {},
      syncedAt: 123,
    });
    expect(missingModels).toEqual([]);
    expect(entry).toMatchObject({
      source: "static",
      sourceProvider: "wafer",
      sourceModelId: "deepseek-v4-flash-0731-fast",
      inputPerMillionUsd: 0.28,
      outputPerMillionUsd: 0.56,
      cacheReadPerMillionUsd: 0.07,
      reasoningPerMillionUsd: 0.56,
      modalitiesInput: ["text"],
      modalitiesOutput: ["text"],
    });
  });

  it("fills in Muse Spark 1.3 Contributor statically until catalogs list it", () => {
    // Released today: absent from models.dev entirely.
    const {
      entries: [entry],
      missingModels,
    } = buildManagedModelPriceEntries({
      modelIds: ["meta/muse-spark-1.3-contributor"],
      data: {},
      syncedAt: 123,
    });
    expect(missingModels).toEqual([]);
    expect(entry).toMatchObject({
      model: "meta/muse-spark-1.3-contributor",
      source: "static",
      sourceProvider: "openrouter",
      sourceModelId: "muse-spark-1.3-contributor",
      inputPerMillionUsd: 0.1,
      outputPerMillionUsd: 0.2,
      cacheReadPerMillionUsd: 0.002,
      reasoningPerMillionUsd: 0.2,
      modalitiesInput: ["text", "image", "video", "file", "audio"],
      modalitiesOutput: ["text"],
    });
  });

  it("prefers models.dev pricing for Muse Spark 1.3 Contributor once listed", () => {
    const model = "meta/muse-spark-1.3-contributor";
    const { entries, missingModels } = buildManagedModelPriceEntries({
      data: {
        openrouter: {
          models: {
            // models.dev keys OpenRouter rows by the full vendor/model slug.
            "meta/muse-spark-1.3-contributor": {
              id: "meta/muse-spark-1.3-contributor",
              cost: { input: 2, output: 8, cache_read: 0.2 },
              modalities: { input: ["text", "image"], output: ["text"] },
              last_updated: "2026-08-10",
            },
          },
        },
      },
      modelIds: [model],
      syncedAt: 1,
    });
    expect(missingModels).toEqual([]);
    expect(entries[0]).toMatchObject({
      model,
      source: "models.dev",
      sourceProvider: "openrouter",
      sourceModelId: "meta/muse-spark-1.3-contributor",
      inputPerMillionUsd: 2,
      outputPerMillionUsd: 8,
      cacheReadPerMillionUsd: 0.2,
    });
  });

  it("resolves Gemini 3.1 Flash Lite directly from Google's catalog", () => {
    const model = "google/gemini-3.1-flash-lite";
    const result = buildManagedModelPriceEntries({
      data: {
        google: {
          models: {
            "gemini-3.1-flash-lite": {
              id: "gemini-3.1-flash-lite",
              cost: { input: 0.25, output: 1.5, cache_read: 0.025 },
              modalities: { input: ["text", "image"], output: ["text"] },
              last_updated: "2026-05-07",
            },
          },
        },
      },
      modelIds: [model],
      syncedAt: 123,
    });

    expect(result.missingModels).toEqual([]);
    expect(result.entries).toEqual([
      expect.objectContaining({
        model,
        source: "models.dev",
        sourceProvider: "google",
        sourceModelId: "gemini-3.1-flash-lite",
        inputPerMillionUsd: 0.25,
        outputPerMillionUsd: 1.5,
        cacheReadPerMillionUsd: 0.025,
        modalitiesInput: ["text", "image"],
      }),
    ]);
  });

  it("resolves DeepSeek V4 Flash from DeepSeek's own namespace", () => {
    const model = "deepseek/deepseek-v4-flash";
    const result = buildManagedModelPriceEntries({
      data: {
        deepseek: {
          models: {
            "deepseek-v4-flash": {
              id: "deepseek-v4-flash",
              cost: { input: 0.14, output: 0.28, cache_read: 0.0028 },
              modalities: { input: ["text"], output: ["text"] },
              last_updated: "2026-07-31",
            },
          },
        },
      },
      modelIds: [model],
      syncedAt: 123,
    });

    expect(result.missingModels).toEqual([]);
    expect(result.entries).toEqual([
      expect.objectContaining({
        model,
        source: "models.dev",
        sourceProvider: "deepseek",
        sourceModelId: "deepseek-v4-flash",
        inputPerMillionUsd: 0.14,
        outputPerMillionUsd: 0.28,
        cacheReadPerMillionUsd: 0.0028,
        // DeepSeek never charges to populate the cache.
        cacheWritePerMillionUsd: 0,
      }),
    ]);
  });

  it("fills DeepSeek V4 Flash from static overrides when models.dev is empty", () => {
    const model = "deepseek/deepseek-v4-flash";
    const result = buildManagedModelPriceEntries({
      data: {},
      modelIds: [model],
      syncedAt: 123,
    });

    expect(result.missingModels).toEqual([]);
    expect(result.entries).toEqual([
      expect.objectContaining({
        model,
        source: "static",
        inputPerMillionUsd: 0.14,
        outputPerMillionUsd: 0.28,
        cacheReadPerMillionUsd: 0.0028,
        reasoningPerMillionUsd: 0.28,
      }),
    ]);
  });

  it("falls back to the output rate when models.dev omits cost.reasoning", () => {
    const model = "google/gemini-3.1-flash-lite";
    const { entries } = buildManagedModelPriceEntries({
      data: {
        google: {
          models: {
            "gemini-3.1-flash-lite": {
              id: "gemini-3.1-flash-lite",
              cost: { input: 0.25, output: 1.5 },
            },
          },
        },
      },
      modelIds: [model],
      syncedAt: 1,
    });

    expect(entries[0]?.reasoningPerMillionUsd).toBe(1.5);
  });

  it("keeps an explicitly published reasoning rate", () => {
    const model = "google/gemini-3.1-flash-lite";
    const { entries } = buildManagedModelPriceEntries({
      data: {
        google: {
          models: {
            "gemini-3.1-flash-lite": {
              id: "gemini-3.1-flash-lite",
              cost: { input: 0.25, output: 1.5, reasoning: 3 },
            },
          },
        },
      },
      modelIds: [model],
      syncedAt: 1,
    });

    expect(entries[0]?.reasoningPerMillionUsd).toBe(3);
  });

  it("fills Muse Spark from static overrides when models.dev is empty", () => {
    const { entries, missingModels } = buildManagedModelPriceEntries({
      data: {},
      modelIds: ["meta/muse-spark-1.2"],
      syncedAt: 1,
    });

    expect(missingModels).toEqual([]);
    expect(entries).toEqual([
      {
        model: "meta/muse-spark-1.2",
        source: "static",
        sourceProvider: "meta",
        sourceModelId: "muse-spark-1.2",
        inputPerMillionUsd: 1.25,
        outputPerMillionUsd: 4.25,
        cacheReadPerMillionUsd: 0,
        cacheWritePerMillionUsd: 0,
        reasoningPerMillionUsd: 4.25,
        modalitiesInput: ["text", "image", "video", "pdf"],
        modalitiesOutput: ["text"],
        sourceUpdatedAt: "",
        syncedAt: 1,
      },
    ]);
  });

  it("fills GPT-5.6 Sol from static overrides when models.dev is empty", () => {
    const { entries, missingModels } = buildManagedModelPriceEntries({
      data: {},
      modelIds: ["openai/gpt-5.6-sol"],
      syncedAt: 1,
    });

    expect(missingModels).toEqual([]);
    expect(entries[0]).toMatchObject({
      model: "openai/gpt-5.6-sol",
      source: "static",
      sourceProvider: "openai",
      sourceModelId: "gpt-5.6-sol",
      inputPerMillionUsd: 5,
      outputPerMillionUsd: 30,
      cacheReadPerMillionUsd: 0.5,
      cacheWritePerMillionUsd: 6.25,
      reasoningPerMillionUsd: 30,
    });
  });

  it("fills GPT-5.6 Luna launch pricing including cache rates", () => {
    const { entries, missingModels } = buildManagedModelPriceEntries({
      data: {},
      modelIds: ["openai/gpt-5.6-luna"],
      syncedAt: 1,
    });

    expect(missingModels).toEqual([]);
    expect(entries[0]).toMatchObject({
      model: "openai/gpt-5.6-luna",
      source: "static",
      sourceProvider: "openai",
      sourceModelId: "gpt-5.6-luna",
      inputPerMillionUsd: 1,
      outputPerMillionUsd: 6,
      cacheReadPerMillionUsd: 0.1,
      cacheWritePerMillionUsd: 1.25,
      reasoningPerMillionUsd: 6,
    });
  });

  it("fills Gemini 3.6 Flash pricing and multimodal capabilities", () => {
    const { entries, missingModels } = buildManagedModelPriceEntries({
      data: {},
      modelIds: ["google/gemini-3.6-flash"],
      syncedAt: 1,
    });

    expect(missingModels).toEqual([]);
    expect(entries[0]).toMatchObject({
      model: "google/gemini-3.6-flash",
      source: "static",
      sourceProvider: "google",
      sourceModelId: "gemini-3.6-flash",
      inputPerMillionUsd: 1.5,
      outputPerMillionUsd: 7.5,
      cacheReadPerMillionUsd: 0.15,
      reasoningPerMillionUsd: 7.5,
      modalitiesInput: ["text", "image", "audio", "video", "pdf"],
      modalitiesOutput: ["text"],
    });
  });

  it("resolves Claude Opus 5 and Fireworks Kimi K3 from models.dev", () => {
    const { entries, missingModels } = buildManagedModelPriceEntries({
      data: {
        anthropic: {
          models: {
            "claude-opus-5": {
              id: "claude-opus-5",
              cost: {
                input: 5,
                output: 25,
                cache_read: 0.5,
                cache_write: 6.25,
              },
              modalities: {
                input: ["text", "image", "pdf"],
                output: ["text"],
              },
              last_updated: "2026-07-24",
            },
          },
        },
        "fireworks-ai": {
          models: {
            "accounts/fireworks/models/kimi-k3": {
              id: "accounts/fireworks/models/kimi-k3",
              cost: { input: 3, output: 15, cache_read: 0.3 },
              modalities: {
                input: ["text", "image"],
                output: ["text"],
              },
              last_updated: "2026-07-27",
            },
          },
        },
      },
      modelIds: [
        "anthropic/claude-opus-5",
        "accounts/fireworks/models/kimi-k3",
      ],
      syncedAt: 1,
    });

    expect(missingModels).toEqual([]);
    expect(entries).toEqual([
      expect.objectContaining({
        model: "anthropic/claude-opus-5",
        sourceProvider: "anthropic",
        sourceModelId: "claude-opus-5",
        inputPerMillionUsd: 5,
        outputPerMillionUsd: 25,
        modalitiesInput: ["text", "image", "pdf"],
      }),
      expect.objectContaining({
        model: "accounts/fireworks/models/kimi-k3",
        sourceProvider: "fireworks-ai",
        sourceModelId: "accounts/fireworks/models/kimi-k3",
        inputPerMillionUsd: 3,
        outputPerMillionUsd: 15,
        cacheReadPerMillionUsd: 0.3,
        modalitiesInput: ["text", "image"],
      }),
    ]);
  });

  it("falls a dated Fireworks snapshot back to the undated family price", () => {
    const model = "accounts/fireworks/models/deepseek-v4-flash-0731";
    expect(listManagedModelPriceLookupCandidates(model)).toEqual([
      model,
      "accounts/fireworks/models/deepseek-v4-flash",
    ]);

    const { entries, missingModels } = buildManagedModelPriceEntries({
      data: {
        "fireworks-ai": {
          models: {
            "accounts/fireworks/models/deepseek-v4-flash": {
              id: "accounts/fireworks/models/deepseek-v4-flash",
              cost: { input: 0.14, output: 0.28, cache_read: 0.028 },
              last_updated: "2026-06-16",
            },
          },
        },
      },
      modelIds: [model],
      syncedAt: 1,
    });

    expect(missingModels).toEqual([]);
    expect(entries[0]).toMatchObject({
      model,
      sourceProvider: "fireworks-ai",
      sourceModelId: "accounts/fireworks/models/deepseek-v4-flash",
      inputPerMillionUsd: 0.14,
      outputPerMillionUsd: 0.28,
      cacheReadPerMillionUsd: 0.028,
    });
  });

  it("resolves Stella's x-ai namespace through models.dev's xai provider", () => {
    const { entries, missingModels } = buildManagedModelPriceEntries({
      data: {
        xai: {
          models: {
            "grok-4.5": {
              id: "grok-4.5",
              cost: { input: 2, output: 6, cache_read: 0.2 },
              last_updated: "2026-07-30",
            },
          },
        },
      },
      modelIds: ["x-ai/grok-4.5"],
      syncedAt: 1,
    });

    expect(missingModels).toEqual([]);
    expect(entries[0]).toMatchObject({
      model: "x-ai/grok-4.5",
      sourceProvider: "xai",
      sourceModelId: "grok-4.5",
      inputPerMillionUsd: 2,
      outputPerMillionUsd: 6,
    });
  });

  it("still reports truly unknown models as missing", () => {
    const { entries, missingModels } = buildManagedModelPriceEntries({
      data: {},
      modelIds: ["unknown/not-a-real-model"],
      syncedAt: 1,
    });
    expect(entries).toEqual([]);
    expect(missingModels).toEqual(["unknown/not-a-real-model"]);
  });
});
