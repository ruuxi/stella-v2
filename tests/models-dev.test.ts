import { describe, expect, it } from "bun:test";

import {
  buildManagedModelPriceEntries,
  listManagedModelPriceLookupCandidates,
} from "../convex/lib/models_dev";

describe("managed model price entries", () => {
  it("fills Muse Spark from static overrides when models.dev is empty", () => {
    const { entries, missingModels } = buildManagedModelPriceEntries({
      data: {},
      modelIds: ["meta/muse-spark-1.1"],
      syncedAt: 1,
    });

    expect(missingModels).toEqual([]);
    expect(entries).toEqual([
      {
        model: "meta/muse-spark-1.1",
        source: "static",
        sourceProvider: "meta",
        sourceModelId: "muse-spark-1.1",
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
