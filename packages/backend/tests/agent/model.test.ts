import { describe, expect, it } from "bun:test";

import {
  getModelConfig,
  getModeConfig,
  GEMINI_3_7_FLASH_OFFLINE_RESPONDER_MODEL,
  listManagedModelIds,
  MANAGED_MODEL_AUDIENCES,
  MODEL_MODES,
} from "../../convex/agent/model";
import {
  listStellaDefaultSelections,
  listStellaCatalogModels,
  parseStellaModelSelection,
  resolveStellaModelConfigForSelection,
  resolveStellaModelSelection,
} from "../../convex/stella_models";

const FLASH_MODEL = "crof/deepseek-v4-flash-0731";
const FLASH_SELECTION = `stella/${FLASH_MODEL}`;
/** Pre-DeepSeek-direct spelling; still accepted, always coerced to the above. */
const LEGACY_FIREWORKS_MODEL =
  "accounts/fireworks/models/deepseek-v4-flash-0731";
const LEGACY_FIREWORKS_SELECTION = `stella/${LEGACY_FIREWORKS_MODEL}`;
const SYNTHESIS_MODEL = "moonshotai/kimi-k2.6";
const SYNTHESIS_SELECTION = `openrouter/${SYNTHESIS_MODEL}`;
const IMAGE_DESCRIPTION_MODEL = "google/gemini-3.1-flash-lite";

describe("managed model config", () => {
  it("routes mobile cloud chat to Gemini 3.7 Flash on OpenRouter", () => {
    for (const audience of MANAGED_MODEL_AUDIENCES) {
      for (const mode of MODEL_MODES) {
        expect(getModeConfig(mode, audience)).toMatchObject({
          model: FLASH_MODEL,
          managedGatewayProvider: "crof",
          providerOptions: {
            openai: { reasoningEffort: "xhigh" },
          },
        });
        // No `gateway.order` — CrofAI is a direct upstream, not a router.
        expect(
          getModeConfig(mode, audience).providerOptions?.gateway,
        ).toBeUndefined();
        expect(getModeConfig(mode, audience).fallback).toBeUndefined();
      }

      for (const entry of listStellaDefaultSelections(audience)) {
        const expectedModel =
          entry.agentType === "synthesis"
            ? SYNTHESIS_MODEL
            : entry.agentType === "offline_responder"
              ? GEMINI_3_7_FLASH_OFFLINE_RESPONDER_MODEL
              : entry.agentType === "image_description"
                ? IMAGE_DESCRIPTION_MODEL
                : FLASH_MODEL;
        expect(getModelConfig(entry.agentType, audience).model).toBe(
          expectedModel,
        );
        expect(entry).toMatchObject({
          model: "stella/default",
          resolvedModel:
            entry.agentType === "synthesis"
              ? SYNTHESIS_SELECTION
              : entry.agentType === "offline_responder"
                ? `openrouter/${GEMINI_3_7_FLASH_OFFLINE_RESPONDER_MODEL}`
                : expectedModel,
        });
      }

      expect(getModelConfig("synthesis", audience)).toMatchObject({
        model: SYNTHESIS_MODEL,
        managedGatewayProvider: "openrouter",
        maxOutputTokens: 32768,
        providerOptions: {
          openai: { reasoningEffort: "low" },
          gateway: {
            order: ["coreweave", "baseten", "together", "fireworks"],
            only: ["coreweave", "baseten", "together", "fireworks"],
            allow_fallbacks: true,
          },
        },
      });
      expect(getModelConfig("synthesis", audience).fallback).toBeUndefined();
      expect(getModelConfig("offline_responder", audience)).toMatchObject({
        model: GEMINI_3_7_FLASH_OFFLINE_RESPONDER_MODEL,
        managedGatewayProvider: "openrouter",
        maxOutputTokens: 65536,
        providerOptions: {
          openai: { reasoningEffort: "low" },
        },
      });
      expect(getModelConfig("image_description", audience)).toMatchObject({
        model: IMAGE_DESCRIPTION_MODEL,
        managedGatewayProvider: "google",
        maxOutputTokens: 4096,
        providerOptions: { gateway: { order: ["google"] } },
      });
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
    // A preference saved while V4 Flash was on Fireworks stays valid, but
    // resolves onto the active CrofAI route rather than reviving Fireworks.
    expect(resolveStellaModelSelection(LEGACY_FIREWORKS_SELECTION, "pro")).toBe(
      FLASH_MODEL,
    );
    expect(
      resolveStellaModelSelection(LEGACY_FIREWORKS_SELECTION, "free"),
    ).toBe(FLASH_MODEL);
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

  it("keeps stale mobile model selections from overriding cloud chat", () => {
    expect(
      resolveStellaModelConfigForSelection(
        FLASH_SELECTION,
        "offline_responder",
        "pro",
      ),
    ).toMatchObject({
      applied: false,
      config: {
        model: GEMINI_3_7_FLASH_OFFLINE_RESPONDER_MODEL,
        managedGatewayProvider: "openrouter",
      },
    });
  });

  it("price-syncs the public and internal utility models", () => {
    expect(listManagedModelIds()).toEqual([
      FLASH_MODEL,
      IMAGE_DESCRIPTION_MODEL,
      GEMINI_3_7_FLASH_OFFLINE_RESPONDER_MODEL,
      SYNTHESIS_MODEL,
    ]);
  });
});
