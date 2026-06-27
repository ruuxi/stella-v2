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

  it("routes orchestrator to Kimi K2.6 and general to Kimi K2.7 Code on every tier but Ultra", () => {
    for (const audience of [
      "anonymous",
      "free",
      "go",
      "pro",
      "plus",
      "ultra_fallback",
    ] as const) {
      expect(getModelConfig(AGENT_IDS.ORCHESTRATOR, audience).model).toBe(
        "accounts/fireworks/models/kimi-k2p6",
      );
      expect(getModelConfig(AGENT_IDS.GENERAL, audience).model).toBe(
        "accounts/fireworks/models/kimi-k2p7-code",
      );
    }
  });

  it("keeps Ultra on the Standard model for orchestrator and general", () => {
    expect(getModelConfig(AGENT_IDS.ORCHESTRATOR, "ultra").model).toBe(
      "openai/gpt-5.5",
    );
    expect(getModelConfig(AGENT_IDS.GENERAL, "ultra").model).toBe(
      "openai/gpt-5.5",
    );
    expect(getModeConfig("standard").managedGatewayProvider).toBe("openai");
    expect(getModeConfig("standard").providerOptions?.openai).toMatchObject({
      reasoningEffort: "low",
    });
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

  it("restricts catalog picks by audience (standard/light only for restricted)", () => {
    const allowedFor = (audience: "free" | "go" | "pro") =>
      new Set(
        listStellaCatalogModels(audience)
          .filter((model) => model.allowedForAudience)
          .map((model) => model.id),
      );

    // Restricted tiers may only pick the Standard and Light modes.
    expect(allowedFor("free")).toEqual(
      new Set(["stella/standard", "stella/light"]),
    );
    expect(allowedFor("go")).toEqual(
      new Set(["stella/standard", "stella/light"]),
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
      resolvedModel: "accounts/fireworks/models/kimi-k2p6",
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
