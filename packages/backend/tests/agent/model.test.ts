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
/** Wafer-hosted Fast variant: selectable, never a default. */
const WAFER_FAST_MODEL = "wafer/deepseek-v4-flash-0731-fast";
const WAFER_FAST_SELECTION = `stella/${WAFER_FAST_MODEL}`;
/** Pre-DeepSeek-direct spelling; still accepted, always coerced to the above. */
const LEGACY_FIREWORKS_MODEL =
  "accounts/fireworks/models/deepseek-v4-flash-0731";
const LEGACY_FIREWORKS_SELECTION = `stella/${LEGACY_FIREWORKS_MODEL}`;
/** Current default: OpenRouter-hosted Muse Spark 1.2 Contributor. */
const MUSE_MODEL = "meta/muse-spark-1.2-contributor";
const MUSE_SELECTION = `stella/${MUSE_MODEL}`;
/** Catalog routing spelling: OpenRouter gateway ids are namespace-prefixed. */
const MUSE_ROUTING_MODEL = `openrouter/${MUSE_MODEL}`;
const SYNTHESIS_MODEL = "moonshotai/kimi-k2.6";
const SYNTHESIS_SELECTION = `openrouter/${SYNTHESIS_MODEL}`;
const IMAGE_DESCRIPTION_MODEL = "google/gemini-3.1-flash-lite";

describe("managed model config", () => {
  it("routes every mode and agent default to Muse Spark 1.2 Contributor on OpenRouter", () => {
    for (const audience of MANAGED_MODEL_AUDIENCES) {
      for (const mode of MODEL_MODES) {
        expect(getModeConfig(mode, audience)).toMatchObject({
          model: MUSE_MODEL,
          managedGatewayProvider: "openrouter",
          api: "openai-responses",
          providerOptions: {
            openai: { reasoningEffort: "xhigh" },
          },
        });
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
                : MUSE_MODEL;
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
                : expectedModel === MUSE_MODEL
                  ? MUSE_ROUTING_MODEL
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

  it("publishes the Muse default and the selectable DeepSeek V4 Flash row", () => {
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
        {
          id: WAFER_FAST_SELECTION,
          name: "DeepSeek V4 Flash 0731 Fast",
          provider: "stella",
          upstreamModel: WAFER_FAST_MODEL,
          type: "language",
          allowedForAudience: true,
        },
        {
          id: MUSE_SELECTION,
          name: "Muse Spark 1.2 Contributor",
          provider: "stella",
          upstreamModel: MUSE_MODEL,
          type: "language",
          allowedForAudience: true,
        },
      ]);
    }
  });

  it("keeps the Light alias compatible and DeepSeek routable but rejects retired aliases", () => {
    expect(parseStellaModelSelection("stella/light")).toEqual({
      kind: "mode",
      mode: "light",
    });
    // The Light alias now resolves to the current default (Muse).
    expect(resolveStellaModelSelection("stella/light", "pro")).toBe(MUSE_MODEL);
    // The previous default stays explicitly selectable and routable.
    expect(resolveStellaModelSelection(FLASH_SELECTION, "pro")).toBe(
      FLASH_MODEL,
    );
    expect(resolveStellaModelSelection(FLASH_SELECTION, "free")).toBe(
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

  it("resolves the Wafer Fast pin onto the wafer gateway", () => {
    expect(resolveStellaModelSelection(WAFER_FAST_SELECTION, "pro")).toBe(
      WAFER_FAST_MODEL,
    );
    expect(
      resolveStellaModelConfigForSelection(
        WAFER_FAST_SELECTION,
        "general",
        "pro",
      ),
    ).toMatchObject({
      applied: true,
      config: {
        model: WAFER_FAST_MODEL,
        managedGatewayProvider: "wafer",
      },
    });
  });

  it("pins the Muse Spark contributor slug onto the OpenRouter gateway", () => {
    // The slug starts with `meta/`, so naive prefix inference would land this
    // OpenRouter-hosted default on Meta's first-party gateway. The explicit
    // override must win for both the mode-config path and a raw
    // `stella/<model>` pin (which infers its gateway from the id alone).
    expect(getModeConfig("light", "pro")).toMatchObject({
      model: MUSE_MODEL,
      managedGatewayProvider: "openrouter",
      api: "openai-responses",
    });
    expect(
      resolveStellaModelConfigForSelection(MUSE_SELECTION, "general", "pro"),
    ).toMatchObject({
      applied: true,
      config: {
        model: MUSE_MODEL,
        managedGatewayProvider: "openrouter",
        api: "openai-responses",
      },
    });
  });

  it("keeps the Responses transport pinned to the Muse id only", () => {
    // A pin of any other selectable model must not inherit the Muse
    // default's Responses transport.
    expect(
      resolveStellaModelConfigForSelection(
        FLASH_SELECTION,
        "general",
        "pro",
      ).config.api,
    ).toBeUndefined();
    expect(
      resolveStellaModelConfigForSelection(
        WAFER_FAST_SELECTION,
        "general",
        "pro",
      ).config.api,
    ).toBeUndefined();
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
      MUSE_MODEL,
      SYNTHESIS_MODEL,
      WAFER_FAST_MODEL,
    ]);
  });
});
