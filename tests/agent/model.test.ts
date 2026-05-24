import { describe, expect, it } from "bun:test";

import {
  getModelConfig,
  getModeConfig,
  listManagedModelIds,
} from "../../convex/agent/model";
import { AGENT_IDS } from "../../convex/lib/agent_constants";
import { listStellaCatalogModels } from "../../convex/stella_models";

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
      "google/gemini-3-flash-preview",
    );
    expect(getModelConfig(AGENT_IDS.GENERAL, "free").model).toBe(
      "google/gemini-3-flash-preview",
    );
    expect(getModelConfig(AGENT_IDS.ORCHESTRATOR, "go").model).toBe(
      "google/gemini-3-flash-preview",
    );
    expect(getModelConfig(AGENT_IDS.GENERAL, "pro").model).toBe(
      "google/gemini-3-flash-preview",
    );
    expect(getModeConfig("standard").managedGatewayProvider).toBe(
      "openrouter",
    );
    expect(getModeConfig("standard").providerOptions?.gateway?.order).toEqual([
      "openrouter",
    ]);
  });

  it("publishes Standard's OpenRouter routing model in the Stella catalog", () => {
    expect(listStellaCatalogModels("free").find(
      (model) => model.id === "stella/standard",
    )).toMatchObject({
      upstreamModel: "openrouter/google/gemini-3-flash-preview",
    });
  });

  it("exposes Priority only for Pro and higher catalog audiences", () => {
    const isPriority = (model: { id: string }) =>
      model.id === "stella/priority";

    expect(listStellaCatalogModels("free").some(isPriority)).toBe(false);
    expect(listStellaCatalogModels("go").some(isPriority)).toBe(false);
    expect(listStellaCatalogModels("pro").find(isPriority)).toMatchObject({
      name: "Stella Priority",
      upstreamModel: "accounts/fireworks/routers/kimi-k2p6-turbo",
    });
  });

  it("keeps the Light model id in the managed model sync list", () => {
    expect(listManagedModelIds()).toContain(
      "deepseek/deepseek-v4-flash",
    );
  });
});
