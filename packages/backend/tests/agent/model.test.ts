import { describe, expect, it } from "bun:test";

import {
  getModelConfig,
  getModeConfig,
  listManagedModelIds,
  MANAGED_MODEL_AUDIENCES,
  MODEL_MODES,
} from "../../convex/agent/model";
import {
  listStellaDefaultSelections,
  listStellaCatalogModels,
  parseStellaModelSelection,
  resolveStellaModelSelection,
} from "../../convex/stella_models";

const FLASH_MODEL = "accounts/fireworks/models/deepseek-v4-flash-0731";
const FLASH_SELECTION = `stella/${FLASH_MODEL}`;

describe("managed model config", () => {
  it("routes every Stella mode and agent task to DeepSeek V4 Flash", () => {
    for (const audience of MANAGED_MODEL_AUDIENCES) {
      for (const mode of MODEL_MODES) {
        expect(getModeConfig(mode, audience)).toMatchObject({
          model: FLASH_MODEL,
          managedGatewayProvider: "fireworks",
          providerOptions: {
            openai: { reasoningEffort: "medium" },
            gateway: { order: ["fireworks"] },
          },
        });
        expect(getModeConfig(mode, audience).fallback).toBeUndefined();
      }

      for (const entry of listStellaDefaultSelections(audience)) {
        expect(getModelConfig(entry.agentType, audience).model).toBe(
          FLASH_MODEL,
        );
        expect(entry).toMatchObject({
          model: "stella/default",
          resolvedModel: FLASH_MODEL,
        });
      }
    }
  });

  it("publishes exactly one selectable Stella model for every audience", () => {
    for (const audience of MANAGED_MODEL_AUDIENCES) {
      expect(listStellaCatalogModels(audience)).toEqual([
        {
          id: FLASH_SELECTION,
          name: "DeepSeek V4 Flash 0731",
          provider: "stella",
          upstreamModel: FLASH_MODEL,
          type: "language",
          allowedForAudience: true,
        },
      ]);
    }
  });

  it("keeps the Light alias compatible but rejects retired aliases and models", () => {
    expect(parseStellaModelSelection("stella/light")).toEqual({
      kind: "mode",
      mode: "light",
    });
    expect(resolveStellaModelSelection("stella/light", "pro")).toBe(
      FLASH_MODEL,
    );
    expect(resolveStellaModelSelection(FLASH_SELECTION, "pro")).toBe(
      FLASH_MODEL,
    );

    for (const retiredSelection of [
      "stella/standard",
      "stella/designer",
      "stella/openai/gpt-5.6-luna",
      "stella/x-ai/grok-4.5",
      "stella/accounts/fireworks/models/deepseek-v4-pro",
      "stella/meta/muse-spark-1.2",
    ]) {
      expect(() =>
        resolveStellaModelSelection(retiredSelection, "pro"),
      ).toThrow(`Unsupported Stella model selection: ${retiredSelection}`);
    }
  });

  it("rejects the default sentinel from direct override resolution", () => {
    expect(() => resolveStellaModelSelection("stella/default")).toThrow(
      "Unsupported Stella model selection: stella/default",
    );
  });

  it("price-syncs only DeepSeek V4 Flash", () => {
    expect(listManagedModelIds()).toEqual([FLASH_MODEL]);
  });
});
