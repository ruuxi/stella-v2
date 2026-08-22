import { describe, expect, it } from "bun:test";

import {
  STELLA_PRESET_FALLBACK_MODELS,
  getStellaResolvedModelName,
  groupCatalogModelsByProvider,
  listLocalCatalogModels,
  mergeCatalogModels,
  normalizeRuntimeCatalogModels,
  normalizeStellaCatalogModels,
  searchCatalogModels,
  withStellaPresetFallbacks,
} from "../../../src/global/settings/lib/model-catalog";
import {
  buildModelDefaultsMap,
  getLocalModelDefaults,
  normalizeModelOverrides,
} from "../../../src/global/settings/lib/model-defaults";

describe("settings model catalog", () => {
  it("scaffolds only the Muse default while the backend catalog loads", () => {
    expect(STELLA_PRESET_FALLBACK_MODELS.map((model) => model.id)).toEqual([
      "stella/meta/muse-spark-1.2-contributor",
    ]);
  });

  it("replaces the offline fallback instead of listing it beside the fetched model", () => {
    const fetched = normalizeStellaCatalogModels([
      {
        id: "stella/meta/muse-spark-1.2-contributor",
        name: "Muse Spark 1.2 Contributor",
        provider: "stella",
        upstreamModel: "meta/muse-spark-1.2-contributor",
      },
      {
        id: "stella/crof/deepseek-v4-flash-0731",
        name: "DeepSeek V4 Flash 0731",
        provider: "stella",
        upstreamModel: "crof/deepseek-v4-flash-0731",
      },
    ]);

    expect(withStellaPresetFallbacks([]).map((model) => model.id)).toEqual([
      "stella/meta/muse-spark-1.2-contributor",
    ]);
    const pickerGroups = groupCatalogModelsByProvider(
      mergeCatalogModels(withStellaPresetFallbacks(fetched), []),
    );
    const stellaRows = pickerGroups.find(
      (group) => group.provider === "stella",
    )?.models;

    expect(withStellaPresetFallbacks(fetched)).toEqual(fetched);
    expect(stellaRows?.map((model) => model.id)).toEqual([
      "stella/crof/deepseek-v4-flash-0731",
      "stella/meta/muse-spark-1.2-contributor",
    ]);
    expect(stellaRows?.map(getStellaResolvedModelName)).toEqual([
      "DeepSeek V4 Flash 0731",
      "Muse Spark 1.2 Contributor",
    ]);
  });

  it("curates the Wafer Fast variant's display name", () => {
    expect(
      getStellaResolvedModelName({
        id: "stella/wafer/deepseek-v4-flash-0731-fast",
        name: "DeepSeek V4 Flash 0731 Fast",
        provider: "stella",
        providerName: "Stella",
        source: "stella",
        upstreamModel: "wafer/deepseek-v4-flash-0731-fast",
      }),
    ).toBe("DeepSeek V4 Flash 0731 Fast");
  });

  it("shows resolved model names instead of Stella routing aliases", () => {
    expect(
      getStellaResolvedModelName({
        id: "stella/light",
        modelId: "light",
        name: "Stella Light",
        provider: "stella",
        providerName: "Stella",
        source: "stella",
        upstreamModel: "accounts/fireworks/models/deepseek-v4-flash-0731",
      }),
    ).toBe("DeepSeek V4 Flash 0731");

    expect(
      getStellaResolvedModelName({
        id: "stella/priority",
        modelId: "priority",
        name: "Stella Priority",
        provider: "stella",
        providerName: "Stella",
        source: "stella",
        upstreamModel: "accounts/fireworks/models/kimi-k2p7-code",
      }),
    ).toBe("Kimi K2P7 Code");
  });

  it("keeps the built-in local endpoint separate from worker-owned providers", () => {
    const models = listLocalCatalogModels();

    expect(models.map((model) => model.provider)).toEqual(["local"]);
    expect(models.every((model) => model.source === "local")).toBe(true);
    expect(models[0]?.id).toBe("local/llama3.2");
  });

  it("normalizes Stella backend rows and keeps Stella-specific models first when merging", () => {
    const stellaModels = normalizeStellaCatalogModels([
      {
        id: "stella/standard",
        name: "Stella Standard",
        provider: "stella",
        upstreamModel: "openai/gpt-5.5",
      },
      {
        id: "openrouter/anthropic/claude-opus-4.7",
        name: "Claude Opus 4.7 via Stella",
        provider: "openrouter",
        upstreamModel: "anthropic/claude-opus-4.7",
      },
    ]);
    const localModels = [
      {
        id: "openai/gpt-5.4",
        modelId: "gpt-5.4",
        name: "GPT-5.4",
        provider: "openai",
        providerName: "OpenAI",
        source: "local" as const,
      },
      {
        id: "openrouter/openai/gpt-5.5",
        modelId: "openai/gpt-5.5",
        name: "GPT-5.5",
        provider: "openrouter",
        providerName: "OpenRouter",
        source: "local" as const,
      },
    ];

    const merged = mergeCatalogModels(stellaModels, localModels);

    expect(merged.map((model) => model.id)).toEqual([
      "stella/standard",
      "openai/gpt-5.4",
      "openrouter/anthropic/claude-opus-4.7",
      "openrouter/openai/gpt-5.5",
    ]);
  });

  it("retains multimodal Stella modes (e.g. Stella Vision) in the catalog", () => {
    const models = normalizeStellaCatalogModels([
      {
        id: "stella/vision",
        name: "Stella Vision",
        provider: "stella",
        upstreamModel: "google/gemini-3-flash-preview",
        type: "multimodal",
      },
      {
        id: "stella/designer",
        name: "Stella Designer",
        provider: "stella",
        upstreamModel: "anthropic/claude-opus-4.8",
        type: "language",
      },
    ]);

    // Vision is multimodal — it must NOT be filtered out, or the mode is
    // unpickable in the desktop catalog.
    expect(models.map((model) => model.id)).toEqual([
      "stella/vision",
      "stella/designer",
    ]);
  });

  it("preserves per-agent Stella mode defaults from the backend", () => {
    const defaults = getLocalModelDefaults({ orchestrator: "stella/light" }, [
      {
        agentType: "orchestrator",
        model: "stella/standard",
        resolvedModel: "openai/gpt-5.5",
      },
      {
        agentType: "dream",
        model: "stella/light",
        resolvedModel: "deepseek/deepseek-v4-flash",
      },
    ]);
    const defaultMap = buildModelDefaultsMap(defaults);

    expect(defaultMap.orchestrator).toBe("stella/standard");
    expect(defaultMap.dream).toBe("stella/light");
    expect(
      normalizeModelOverrides({
        dream: "stella/light",
        schedule: "stella/standard",
      }),
    ).toEqual({
      dream: "stella/light",
      schedule: "stella/standard",
    });
  });

  it("groups by provider and supports provider/model search", () => {
    const models = [
      {
        id: "stella/openai/gpt-5.5",
        modelId: "openai/gpt-5.5",
        name: "GPT-5.5",
        provider: "stella",
        providerName: "Stella",
        source: "stella" as const,
      },
      {
        id: "stella/designer",
        modelId: "designer",
        name: "Stella Designer",
        provider: "stella",
        providerName: "Stella",
        source: "stella" as const,
      },
      {
        id: "anthropic/claude-opus-4.7",
        modelId: "claude-opus-4.7",
        name: "Claude Opus 4.7",
        provider: "anthropic",
        providerName: "Anthropic",
        source: "local" as const,
      },
    ];

    expect(
      groupCatalogModelsByProvider(models).map((group) => group.provider),
    ).toEqual(["stella", "anthropic"]);
    expect(
      groupCatalogModelsByProvider(models)[0].models.map((model) => model.id),
    ).toEqual(["stella/designer", "stella/openai/gpt-5.5"]);
    expect(
      searchCatalogModels(models, "opus").map((model) => model.id),
    ).toEqual(["anthropic/claude-opus-4.7"]);
    expect(
      searchCatalogModels(models, "anthropic").map((model) => model.id),
    ).toEqual(["anthropic/claude-opus-4.7"]);
  });

  it("normalizes supported and runtime-managed providers only", () => {
    const base = {
      api: "openai-responses",
      baseUrl: "https://example.test/v1",
      reasoning: true,
      input: ["text", "image"] as Array<"text" | "image">,
      contextWindow: 500_000,
      maxTokens: 128_000,
    };
    const models = normalizeRuntimeCatalogModels(
      [
        { ...base, id: "grok-4.5", name: "Grok 4.5", provider: "xai" },
        {
          ...base,
          id: "private-model",
          name: "Private model",
          provider: "my-extension",
        },
        {
          ...base,
          id: "bedrock-model",
          name: "Bedrock model",
          provider: "amazon-bedrock",
        },
        {
          ...base,
          api: "stella",
          id: "standard",
          name: "Stella Standard",
          provider: "stella",
        },
      ],
      [{ id: "my-extension", authManaged: true, credentialless: false }],
    );

    expect(models.map((model) => model.id)).toEqual([
      "my-extension/private-model",
      "xai/grok-4.5",
    ]);
  });
});
