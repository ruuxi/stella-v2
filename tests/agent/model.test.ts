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

  it("publishes only real managed models in the Stella catalog (no tier aliases)", () => {
    const catalog = listStellaCatalogModels("pro");

    expect(catalog.find((model) => model.id === "stella/openai/gpt-5.5")).toMatchObject({
      upstreamModel: "openai/gpt-5.5",
    });
    // The branded tier aliases are gone — every catalog id is a concrete
    // managed model (provider/model), never a bare mode like stella/standard.
    for (const model of catalog) {
      expect(model.upstreamModel).toContain("/");
      expect(model.id).toBe(`stella/${model.upstreamModel}`);
    }
  });

  it("rejects the default sentinel from direct override resolution", () => {
    const defaultAlias = ["stella", "default"].join("/");
    expect(() => resolveStellaModelSelection(defaultAlias)).toThrow(
      `Unsupported Stella model selection: ${defaultAlias}`,
    );
  });

  it("only lets pro+ audiences pin a catalog model", () => {
    expect(
      listStellaCatalogModels("free").every(
        (model) => model.allowedForAudience === false,
      ),
    ).toBe(true);
    expect(
      listStellaCatalogModels("go").every(
        (model) => model.allowedForAudience === false,
      ),
    ).toBe(true);
    expect(
      listStellaCatalogModels("pro").every(
        (model) => model.allowedForAudience === true,
      ),
    ).toBe(true);
  });

  it("publishes the opaque default sentinel for every agent's per-tier default", () => {
    const defaults = listStellaDefaultSelections("free");
    expect(defaults.find((entry) => entry.agentType === "orchestrator")).toMatchObject({
      model: "stella/default",
      resolvedModel: "accounts/fireworks/models/kimi-k2p6",
    });
    expect(defaults.find((entry) => entry.agentType === "chronicle")).toMatchObject({
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
