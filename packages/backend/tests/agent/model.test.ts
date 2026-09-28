import { describe, expect, it } from "bun:test";

import {
  GEMINI_3_7_FLASH_OFFLINE_RESPONDER_MODEL,
  MANAGED_MODEL_AUDIENCES,
} from "../../convex/agent/model";
import {
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
/** Default OpenRouter-hosted Muse Spark 1.3 Contributor. */
const MUSE_MODEL = "meta/muse-spark-1.3-contributor";
const MUSE_SELECTION = `stella/${MUSE_MODEL}`;

describe("managed model config", () => {
  it("publishes the Muse default and its selectable DeepSeek fallback", () => {
    for (const audience of MANAGED_MODEL_AUDIENCES) {
      const selectable = audience === "pro";
      expect(listStellaCatalogModels(audience)).toEqual([
        {
          id: FLASH_SELECTION,
          name: "DeepSeek V4 Flash 0731",
          provider: "stella",
          upstreamModel: FLASH_MODEL,
          api: "openai-completions",
          type: "language",
          allowedForAudience: selectable,
        },
        {
          id: WAFER_FAST_SELECTION,
          name: "DeepSeek V4 Flash 0731 Fast",
          provider: "stella",
          upstreamModel: WAFER_FAST_MODEL,
          api: "openai-completions",
          type: "language",
          allowedForAudience: selectable,
        },
        {
          id: MUSE_SELECTION,
          name: "Muse Spark 1.3 Contributor",
          provider: "stella",
          upstreamModel: MUSE_MODEL,
          api: "openai-responses",
          type: "language",
          allowedForAudience: selectable,
        },
      ]);
    }
  });

  it("keeps Light compatible, limits model selection to Pro, and rejects retired aliases", () => {
    expect(parseStellaModelSelection("stella/light")).toEqual({
      kind: "mode",
      mode: "light",
    });
    expect(resolveStellaModelSelection("stella/light", "pro")).toBe(MUSE_MODEL);
    // DeepSeek remains explicitly selectable and routable for Pro.
    expect(resolveStellaModelSelection(FLASH_SELECTION, "pro")).toBe(
      FLASH_MODEL,
    );
    expect(() => resolveStellaModelSelection(FLASH_SELECTION, "free")).toThrow(
      `Unsupported Stella model selection: ${FLASH_SELECTION}`,
    );
    // A preference saved while V4 Flash was on Fireworks stays valid, but
    // resolves onto the active CrofAI route rather than reviving Fireworks.
    expect(resolveStellaModelSelection(LEGACY_FIREWORKS_SELECTION, "pro")).toBe(
      FLASH_MODEL,
    );
    expect(() =>
      resolveStellaModelSelection(LEGACY_FIREWORKS_SELECTION, "free"),
    ).toThrow(
      `Unsupported Stella model selection: ${LEGACY_FIREWORKS_SELECTION}`,
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

  it("keeps the Muse Responses transport override pinned to the Muse id only", () => {
    // A pin of any other selectable model must not inherit Muse's transport.
    expect(
      resolveStellaModelConfigForSelection(FLASH_SELECTION, "general", "pro")
        .config.api,
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

});
