import { describe, expect, it } from "bun:test";

import {
  getModelConfig,
  getModeConfig,
  listManagedModelIds,
  MANAGED_MODEL_AUDIENCES,
} from "../../convex/agent/model";
import { AGENT_IDS } from "../../convex/lib/agent_constants";
import {
  listStellaDefaultSelections,
  listStellaCatalogModels,
  parseStellaModelSelection,
  resolveStellaModelSelection,
} from "../../convex/stella_models";

describe("managed model config", () => {
  it("preserves the non-GPT Light matrix and moves synthesis to GPT-5.6 Luna", () => {
    const deepSeekLight =
      "accounts/fireworks/models/deepseek-v4-flash-0731";

    for (const audience of MANAGED_MODEL_AUDIENCES) {
      const light = getModeConfig("light", audience);
      expect(light.model).toBe(deepSeekLight);
      expect(light.managedGatewayProvider).toBe("fireworks");
      expect(light.providerOptions?.gateway?.order).toEqual(["fireworks"]);

      for (const mode of ["standard", "builder", "designer"] as const) {
        const config = getModeConfig(mode, audience);
        expect(config.fallback).toBe(deepSeekLight);
        expect(config.fallbackManagedGatewayProvider).toBe("fireworks");
        expect(config.fallbackProviderOptions?.gateway?.order).toEqual([
          "fireworks",
        ]);
      }

      for (const agentType of ["chronicle", "progress_summary"] as const) {
        expect(getModelConfig(agentType, audience)).toMatchObject({
          model: deepSeekLight,
          managedGatewayProvider: "fireworks",
        });
      }

      expect(getModelConfig("synthesis", audience)).toMatchObject({
        model: "openai/gpt-5.6-luna",
        fallback: deepSeekLight,
        managedGatewayProvider: "openai",
        fallbackManagedGatewayProvider: "fireworks",
      });
      expect(getModelConfig("html_finish", audience)).toMatchObject({
        model: "google/gemini-3.6-flash",
        fallback: deepSeekLight,
      });
      expect(getModelConfig("html_finish", audience).temperature).toBeUndefined();
      expect(getModeConfig("vision", audience)).toMatchObject({
        model: "google/gemini-3.6-flash",
        managedGatewayProvider: "google",
      });
      expect(getModeConfig("vision", audience).temperature).toBeUndefined();
    }
  });

  it("defaults the primary and General agents to DeepSeek V4 Flash", () => {
    const deepSeekLight =
      "accounts/fireworks/models/deepseek-v4-flash-0731";

    for (const audience of MANAGED_MODEL_AUDIENCES) {
      expect(getModelConfig(AGENT_IDS.ORCHESTRATOR, audience).model).toBe(
        deepSeekLight,
      );
      expect(
        getModelConfig(AGENT_IDS.ORCHESTRATOR, audience).managedGatewayProvider,
      ).toBe("fireworks");
      const general = getModelConfig(AGENT_IDS.GENERAL, audience);
      expect(general.model).toBe(deepSeekLight);
      expect(general.managedGatewayProvider).toBe("fireworks");
    }
  });

  it("routes Standard directly through xAI Grok 4.5", () => {
    const standard = getModeConfig("standard");
    expect(standard.model).toBe("x-ai/grok-4.5");
    expect(standard.managedGatewayProvider).toBe("xai");
    expect(standard.providerOptions?.gateway).toBeUndefined();
    expect(standard.providerOptions?.openai?.reasoningEffort).toBe("low");
  });

  it("routes Builder through OpenAI GPT-5.6 Sol", () => {
    const builder = getModeConfig("builder");
    expect(builder.model).toBe("openai/gpt-5.6-sol");
    expect(builder.managedGatewayProvider).toBe("openai");
  });

  it("routes Designer directly through Anthropic Claude Opus 5", () => {
    const designer = getModeConfig("designer");
    expect(designer.model).toBe("anthropic/claude-opus-5");
    expect(designer.managedGatewayProvider).toBe("anthropic");
  });

  it("publishes branded tier modes and real managed models in the catalog", () => {
    const catalog = listStellaCatalogModels("pro");

    // Branded tier aliases ("modes") are surfaced with their per-audience model.
    expect(
      catalog.find((model) => model.id === "stella/designer"),
    ).toMatchObject({
      name: "Stella Designer",
      upstreamModel: getModeConfig("designer", "pro").model,
    });
    expect(catalog.find((model) => model.id === "stella/light")).toMatchObject({
      name: "Stella Light",
      upstreamModel: getModeConfig("light", "pro").model,
    });
    // Real managed models are still listed alongside the modes.
    expect(
      catalog.find((model) => model.id === "stella/openai/gpt-5.6-sol"),
    ).toMatchObject({
      upstreamModel: "openai/gpt-5.6-sol",
    });
    expect(
      catalog.find((model) => model.id === "stella/openai/gpt-5.6-luna"),
    ).toMatchObject({
      name: "GPT-5.6 Luna",
      upstreamModel: "openai/gpt-5.6-luna",
    });
    expect(
      catalog.find((model) => model.id === "stella/openai/gpt-5.4-mini"),
    ).toBeUndefined();
  });

  it("parses and resolves branded mode aliases vs upstream picks", () => {
    expect(parseStellaModelSelection("stella/designer")).toEqual({
      kind: "mode",
      mode: "designer",
    });
    expect(parseStellaModelSelection("stella/openai/gpt-5.6-sol")).toEqual({
      kind: "upstream",
      model: "openai/gpt-5.6-sol",
    });
    expect(parseStellaModelSelection("stella/default")).toEqual({
      kind: "default",
    });
    expect(resolveStellaModelSelection("stella/designer", "pro")).toBe(
      getModeConfig("designer", "pro").model,
    );
  });

  it("rejects the default sentinel from direct override resolution", () => {
    const defaultAlias = ["stella", "default"].join("/");
    expect(() => resolveStellaModelSelection(defaultAlias)).toThrow(
      `Unsupported Stella model selection: ${defaultAlias}`,
    );
  });

  it("restricts catalog picks by audience", () => {
    const allowedFor = (audience: "anonymous" | "free" | "go" | "pro") =>
      new Set(
        listStellaCatalogModels(audience)
          .filter((model) => model.allowedForAudience)
          .map((model) => model.id),
      );

    const freeSelections = new Set([
      "stella/standard",
      "stella/light",
      "stella/openai/gpt-5.6-luna",
      "stella/accounts/fireworks/models/deepseek-v4-pro",
    ]);
    expect(allowedFor("anonymous")).toEqual(freeSelections);
    expect(allowedFor("free")).toEqual(freeSelections);
    // Go is restricted from arbitrary pinning, but it is paid and can pick
    // paid-only branded modes.
    expect(allowedFor("go")).toEqual(
      new Set(["stella/standard", "stella/light", "stella/max"]),
    );
    // Pro+ may pin any catalog model (modes + real managed models).
    expect(
      listStellaCatalogModels("pro").every(
        (model) => model.allowedForAudience === true,
      ),
    ).toBe(true);
  });

  it("publishes the opaque default sentinel for every agent's per-tier default", () => {
    const defaults = listStellaDefaultSelections("free");
    expect(
      defaults.find((entry) => entry.agentType === "orchestrator"),
    ).toMatchObject({
      model: "stella/default",
      resolvedModel: "accounts/fireworks/models/deepseek-v4-flash-0731",
    });
    expect(
      defaults.find((entry) => entry.agentType === "general"),
    ).toMatchObject({
      model: "stella/default",
      resolvedModel: "accounts/fireworks/models/deepseek-v4-flash-0731",
    });
    expect(
      defaults.find((entry) => entry.agentType === "chronicle"),
    ).toMatchObject({
      model: "stella/default",
      resolvedModel: "accounts/fireworks/models/deepseek-v4-flash-0731",
    });
  });

  it("keeps the Light model id in the managed model sync list", () => {
    expect(listManagedModelIds()).toContain(
      "accounts/fireworks/models/deepseek-v4-flash-0731",
    );
    expect(listManagedModelIds()).toContain(
      "accounts/fireworks/models/deepseek-v4-pro",
    );
    expect(listManagedModelIds()).toContain("openai/gpt-5.6-luna");
    expect(listManagedModelIds()).toContain("google/gemini-3.6-flash");
    expect(listManagedModelIds()).toContain("anthropic/claude-opus-5");
    expect(listManagedModelIds()).toContain(
      "accounts/fireworks/models/kimi-k3",
    );
    expect(listManagedModelIds()).not.toContain("anthropic/claude-opus-4.8");
    expect(listManagedModelIds()).not.toContain("google/gemini-3.5-flash");
    expect(listManagedModelIds()).not.toContain("google/gemini-3-flash-preview");
    expect(listManagedModelIds()).not.toContain("openai/gpt-5.4-mini");
  });

  it("publishes Luna and DeepSeek V4 Pro as free-selectable managed models", () => {
    for (const audience of ["anonymous", "free"] as const) {
      const catalog = listStellaCatalogModels(audience);
      expect(
        catalog.find((model) => model.id === "stella/openai/gpt-5.6-luna"),
      ).toMatchObject({
        name: "GPT-5.6 Luna",
        upstreamModel: "openai/gpt-5.6-luna",
        allowedForAudience: true,
      });
      expect(
        catalog.find(
          (model) =>
            model.id ===
            "stella/accounts/fireworks/models/deepseek-v4-pro",
        ),
      ).toMatchObject({
        name: "DeepSeek V4 Pro",
        upstreamModel: "accounts/fireworks/models/deepseek-v4-pro",
        type: "language",
        allowedForAudience: true,
      });
    }
  });

  it("registers Kimi K3 as a pinnable Fireworks model", () => {
    const modelId = "accounts/fireworks/models/kimi-k3";
    const catalog = listStellaCatalogModels("pro");

    expect(listManagedModelIds()).toContain(modelId);
    expect(
      catalog.find((model) => model.id === `stella/${modelId}`),
    ).toMatchObject({
      name: "Kimi K3",
      upstreamModel: modelId,
      type: "multimodal",
      allowedForAudience: true,
    });
    expect(
      listStellaCatalogModels("free").find(
        (model) => model.id === `stella/${modelId}`,
      )?.allowedForAudience,
    ).toBe(false);
  });

  it("registers Muse Spark 1.1 as a pinnable managed model", () => {
    expect(listManagedModelIds()).toContain("meta/muse-spark-1.1");
    const catalog = listStellaCatalogModels("pro");
    expect(
      catalog.find((model) => model.id === "stella/meta/muse-spark-1.1"),
    ).toMatchObject({
      name: "Muse Spark 1.1",
      upstreamModel: "meta/muse-spark-1.1",
      type: "multimodal",
      allowedForAudience: true,
    });
    // Restricted free tier cannot pin arbitrary managed models.
    expect(
      listStellaCatalogModels("free").find(
        (model) => model.id === "stella/meta/muse-spark-1.1",
      )?.allowedForAudience,
    ).toBe(false);
  });
});
