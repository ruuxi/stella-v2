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
  it("routes Light through OpenRouter", () => {
    const light = getModeConfig("light");

    expect(light.model).toBe("deepseek/deepseek-v4-flash");
    expect(light.managedGatewayProvider).toBe("openrouter");
    expect(light.providerOptions?.gateway?.order).toEqual(["openrouter"]);
  });

  it("uses Light as the fallback for Designer", () => {
    const designer = getModeConfig("designer");

    expect(designer.fallback).toBe("deepseek/deepseek-v4-flash");
    expect(designer.fallbackManagedGatewayProvider).toBe("openrouter");
    expect(designer.fallbackProviderOptions?.gateway?.order).toEqual([
      "openrouter",
    ]);
  });

  it("uses Standard for anonymous, free, and paid chat defaults", () => {
    expect(getModelConfig(AGENT_IDS.ORCHESTRATOR, "anonymous").model).toBe(
      "openai/gpt-5.5",
    );
    expect(getModelConfig(AGENT_IDS.GENERAL, "free").model).toBe(
      "openai/gpt-5.5",
    );
    expect(getModelConfig(AGENT_IDS.ORCHESTRATOR, "go").model).toBe(
      "openai/gpt-5.5",
    );
    expect(getModelConfig(AGENT_IDS.GENERAL, "pro").model).toBe(
      "openai/gpt-5.5",
    );
    expect(getModeConfig("standard").managedGatewayProvider).toBe(
      "openai",
    );
    expect(getModeConfig("standard").providerOptions?.openai).toMatchObject({
      reasoningEffort: "low",
    });
  });

  it("publishes Standard's OpenAI routing model in the Stella catalog", () => {
    expect(listStellaCatalogModels("free").find(
      (model) => model.id === "stella/standard",
    )).toMatchObject({
      upstreamModel: "openai/gpt-5.5",
    });
  });

  it("keeps the default sentinel out of direct mode resolution", () => {
    const legacyDefaultAlias = ["stella", "default"].join("/");
    expect(() => resolveStellaModelSelection(legacyDefaultAlias, "pro")).toThrow(
      `Unsupported Stella model selection: ${legacyDefaultAlias}`,
    );
  });

  it("publishes per-agent defaults without converting Light agents to Standard", () => {
    const defaults = listStellaDefaultSelections("free");
    expect(defaults.find((entry) => entry.agentType === "orchestrator")).toMatchObject({
      model: "stella/standard",
      resolvedModel: "openai/gpt-5.5",
    });
    expect(defaults.find((entry) => entry.agentType === "chronicle")).toMatchObject({
      model: "stella/light",
      resolvedModel: "deepseek/deepseek-v4-flash",
    });
  });

  it("exposes Priority only for Pro and higher catalog audiences", () => {
    const isPriority = (model: { id: string }) =>
      model.id === "stella/priority";

    expect(listStellaCatalogModels("free").some(isPriority)).toBe(false);
    expect(listStellaCatalogModels("go").some(isPriority)).toBe(false);
    expect(listStellaCatalogModels("pro").find(isPriority)).toMatchObject({
      name: "Stella Priority",
      upstreamModel: "accounts/fireworks/models/kimi-k2p6",
    });
    expect(getModeConfig("priority").serviceTier).toBe("fast");
  });

  it("keeps the Light model id in the managed model sync list", () => {
    expect(listManagedModelIds()).toContain(
      "deepseek/deepseek-v4-flash",
    );
  });
});
