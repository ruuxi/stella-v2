import { describe, expect, it } from "bun:test";

import {
  getModelConfig,
  getModeConfig,
  listManagedModelIds,
} from "../../convex/agent/model";
import { AGENT_IDS } from "../../convex/lib/agent_constants";
import {
  listStellaDefaultSelections,
  listStellaCatalogModels,
  parseStellaModelSelection,
  resolveStellaModelSelection,
} from "../../convex/stella_models";

describe("managed model config", () => {
  it("routes Light through Fireworks", () => {
    const light = getModeConfig("light");

    expect(light.model).toBe("accounts/fireworks/models/deepseek-v4-flash");
    expect(light.managedGatewayProvider).toBe("fireworks");
    expect(light.providerOptions?.gateway?.order).toEqual(["fireworks"]);
  });

  it("uses Light as the fallback for Designer", () => {
    const designer = getModeConfig("designer");

    expect(designer.fallback).toBe(
      "accounts/fireworks/models/deepseek-v4-flash",
    );
    expect(designer.fallbackManagedGatewayProvider).toBe("fireworks");
    expect(designer.fallbackProviderOptions?.gateway?.order).toEqual([
      "fireworks",
    ]);
  });

  it("routes orchestrator and general to Grok 4.5 on fallback/default audiences", () => {
    for (const audience of [
      "anonymous",
      "free",
      "go",
      "pro",
      "plus",
      "ultra_fallback",
      "max_fallback",
    ] as const) {
      expect(getModelConfig(AGENT_IDS.ORCHESTRATOR, audience).model).toBe(
        "x-ai/grok-4.5",
      );
      expect(
        getModelConfig(AGENT_IDS.ORCHESTRATOR, audience)
          .managedGatewayProvider,
      ).toBe("openrouter");
      expect(getModelConfig(AGENT_IDS.GENERAL, audience).model).toBe(
        "x-ai/grok-4.5",
      );
      expect(
        getModelConfig(AGENT_IDS.GENERAL, audience).managedGatewayProvider,
      ).toBe("openrouter");
    }
  });

  it("keeps the Max baseline on the Max mode", () => {
    expect(getModelConfig(AGENT_IDS.ORCHESTRATOR, "max").model).toBe(
      "anthropic/claude-fable-5",
    );
    expect(getModelConfig(AGENT_IDS.GENERAL, "max").model).toBe(
      "anthropic/claude-fable-5",
    );
  });

  it("routes Standard through OpenRouter Grok 4.5", () => {
    const standard = getModeConfig("standard");
    expect(standard.model).toBe("x-ai/grok-4.5");
    expect(standard.managedGatewayProvider).toBe("openrouter");
    expect(standard.providerOptions?.gateway?.order).toEqual(["openrouter"]);
  });

  it("runs Ultra orchestrator and general on the Designer model (Opus)", () => {
    expect(getModelConfig(AGENT_IDS.ORCHESTRATOR, "ultra").model).toBe(
      "anthropic/claude-opus-4.8",
    );
    expect(getModelConfig(AGENT_IDS.GENERAL, "ultra").model).toBe(
      "anthropic/claude-opus-4.8",
    );
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
      catalog.find((model) => model.id === "stella/openai/gpt-5.5"),
    ).toMatchObject({
      upstreamModel: "openai/gpt-5.5",
    });
  });

  it("parses and resolves branded mode aliases vs upstream picks", () => {
    expect(parseStellaModelSelection("stella/designer")).toEqual({
      kind: "mode",
      mode: "designer",
    });
    expect(parseStellaModelSelection("stella/openai/gpt-5.5")).toEqual({
      kind: "upstream",
      model: "openai/gpt-5.5",
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
    const allowedFor = (audience: "free" | "go" | "pro") =>
      new Set(
        listStellaCatalogModels(audience)
          .filter((model) => model.allowedForAudience)
          .map((model) => model.id),
      );

    // Free users may only pick the Standard and Light modes.
    expect(allowedFor("free")).toEqual(
      new Set(["stella/standard", "stella/light"]),
    );
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
      resolvedModel: "openrouter/x-ai/grok-4.5",
    });
    expect(
      defaults.find((entry) => entry.agentType === "chronicle"),
    ).toMatchObject({
      model: "stella/default",
      resolvedModel: "accounts/fireworks/models/deepseek-v4-flash",
    });
  });

  it("keeps the Light model id in the managed model sync list", () => {
    expect(listManagedModelIds()).toContain(
      "accounts/fireworks/models/deepseek-v4-flash",
    );
  });
});
