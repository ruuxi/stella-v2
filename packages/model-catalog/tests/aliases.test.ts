import { describe, expect, it } from "bun:test";

import {
  listStellaCatalogModels,
  parseStellaModelSelection,
  resolveStellaModelConfigForSelection,
  resolveStellaModelSelection,
  STELLA_DEFAULT_MODEL,
} from "@stella/model-catalog/aliases";
import {
  canOverrideStellaModel,
  DEEPSEEK_V4_FLASH_DIRECT_MODEL,
  DEEPSEEK_V4_FLASH_FIREWORKS_MODEL,
  DEEPSEEK_V4_1_FLASH_MODEL,
  GEMINI_3_7_FLASH_OFFLINE_RESPONDER_MODEL,
  isPaidManagedAudience,
  isStellaModelAllowedForAudience,
  MANAGED_MODEL_AUDIENCES,
  resolveManagedModelRouteAlias,
} from "@stella/model-catalog/model";

const FLASH_SELECTION = `stella/${DEEPSEEK_V4_1_FLASH_MODEL}`;
/** Pre-DeepSeek-direct spellings; still accepted, always coerced to DeepSeek. */
const LEGACY_FIREWORKS_SELECTION = `stella/${DEEPSEEK_V4_FLASH_FIREWORKS_MODEL}`;
const LEGACY_DIRECT_SELECTION = `stella/${DEEPSEEK_V4_FLASH_DIRECT_MODEL}`;
const RETIRED_MUSE_SELECTION = "stella/meta/muse-spark-1.3-contributor";

const RETIRED_SELECTIONS = [
  RETIRED_MUSE_SELECTION,
  "stella/standard",
  "stella/designer",
  "stella/openai/gpt-5.6-luna",
  "stella/x-ai/grok-4.5",
  "stella/accounts/fireworks/models/deepseek-v4-pro",
  "stella/meta/muse-spark-1.2",
];

describe("parseStellaModelSelection", () => {
  it("treats empty and sentinel selections as the backend default", () => {
    expect(parseStellaModelSelection(undefined)).toEqual({ kind: "default" });
    expect(parseStellaModelSelection(null)).toEqual({ kind: "default" });
    expect(parseStellaModelSelection("   ")).toEqual({ kind: "default" });
    expect(parseStellaModelSelection(STELLA_DEFAULT_MODEL)).toEqual({
      kind: "default",
    });
    expect(parseStellaModelSelection("stella/")).toEqual({ kind: "default" });
  });

  it("parses branded mode aliases", () => {
    expect(parseStellaModelSelection("stella/light")).toEqual({
      kind: "mode",
      mode: "light",
    });
    expect(parseStellaModelSelection(" stella/standard ")).toEqual({
      kind: "mode",
      mode: "standard",
    });
  });

  it("parses explicit upstream pins", () => {
    expect(parseStellaModelSelection(FLASH_SELECTION)).toEqual({
      kind: "upstream",
      model: DEEPSEEK_V4_1_FLASH_MODEL,
    });
    expect(parseStellaModelSelection("stella/openai/gpt-5.5")).toEqual({
      kind: "upstream",
      model: "openai/gpt-5.5",
    });
  });

  it("returns null for non-Stella model ids", () => {
    expect(parseStellaModelSelection("openai/gpt-5.5")).toBeNull();
    expect(parseStellaModelSelection("stella")).toBeNull();
  });
});

describe("resolveStellaModelSelection", () => {
  it("keeps DeepSeek V4 Flash routable and collapses legacy spellings onto the active route", () => {
    for (const selection of [
      FLASH_SELECTION,
      LEGACY_FIREWORKS_SELECTION,
      LEGACY_DIRECT_SELECTION,
    ]) {
      expect(resolveStellaModelSelection(selection, "pro")).toBe(
        DEEPSEEK_V4_1_FLASH_MODEL,
      );
    }
    expect(
      resolveManagedModelRouteAlias(DEEPSEEK_V4_FLASH_FIREWORKS_MODEL),
    ).toBe(DEEPSEEK_V4_1_FLASH_MODEL);

  });

  it("rejects retired aliases and the default sentinel", () => {
    for (const retired of RETIRED_SELECTIONS) {
      expect(() => resolveStellaModelSelection(retired, "pro")).toThrow(
        `Unsupported Stella model selection: ${retired}`,
      );
    }
    expect(() => resolveStellaModelSelection(STELLA_DEFAULT_MODEL)).toThrow(
      "Unsupported Stella model selection: stella/default",
    );
  });

  it("passes non-Stella ids through unchanged", () => {
    expect(resolveStellaModelSelection("openai/gpt-5.5", "pro")).toBe(
      "openai/gpt-5.5",
    );
  });
});

describe("resolveStellaModelConfigForSelection", () => {
  it("pins V4.1 Flash to OpenRouter and inference-net only", () => {
    expect(resolveStellaModelConfigForSelection(FLASH_SELECTION, "general", "pro"))
      .toMatchObject({ applied: true, config: {
        model: DEEPSEEK_V4_1_FLASH_MODEL,
        managedGatewayProvider: "openrouter",
        api: "openai-completions",
        providerOptions: { gateway: { only: ["inference-net"], allow_fallbacks: false } },
      } });
  });

  it("ignores the retired Muse selection and uses the Flash default", () => {
    expect(resolveStellaModelConfigForSelection(RETIRED_MUSE_SELECTION, "general", "pro"))
      .toMatchObject({ applied: false, config: { model: DEEPSEEK_V4_1_FLASH_MODEL } });
  });

  it("uses chat completions for Flash overrides", () => {
    expect(resolveStellaModelConfigForSelection(FLASH_SELECTION, "general", "pro").config.api)
      .toBe("openai-completions");
  });

  it("ignores overrides for locked agents", () => {
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

  it("falls back to the agent default for the sentinel and for disallowed pins", () => {
    expect(
      resolveStellaModelConfigForSelection(
        STELLA_DEFAULT_MODEL,
        "general",
        "pro",
      ),
    ).toMatchObject({
      applied: false,
      config: {
        model: DEEPSEEK_V4_1_FLASH_MODEL,
        fallback: undefined,
      },
    });
    // Retired ids are rejected product-wide, even for Pro.
    expect(
      resolveStellaModelConfigForSelection(
        "stella/openai/gpt-5.6-luna",
        "general",
        "pro",
      ),
    ).toMatchObject({
      applied: false,
      config: {
        model: DEEPSEEK_V4_1_FLASH_MODEL,
        fallback: undefined,
      },
    });
    // Restricted audiences ignore raw picker rows and keep their default.
    expect(
      resolveStellaModelConfigForSelection(FLASH_SELECTION, "general", "free"),
    ).toMatchObject({
      applied: false,
      config: { model: DEEPSEEK_V4_1_FLASH_MODEL },
    });
  });
});

describe("audience allowlist", () => {
  it("lets only Pro audiences override the per-agent default", () => {
    expect(canOverrideStellaModel("anonymous")).toBe(false);
    expect(canOverrideStellaModel("free")).toBe(false);
    expect(canOverrideStellaModel("go")).toBe(false);
    expect(canOverrideStellaModel("go_fallback")).toBe(false);
    expect(canOverrideStellaModel("pro")).toBe(true);
    expect(canOverrideStellaModel("pro_fallback")).toBe(false);
  });

  it("marks every subscribed audience as paid", () => {
    expect(isPaidManagedAudience("anonymous")).toBe(false);
    expect(isPaidManagedAudience("free")).toBe(false);
    for (const audience of [
      "go",
      "pro",
      "go_fallback",
      "pro_fallback",
    ] as const) {
      expect(isPaidManagedAudience(audience)).toBe(true);
    }
  });

  it("allows only default/light outside Pro and rejects retired ids product-wide", () => {
    for (const audience of MANAGED_MODEL_AUDIENCES) {
      expect(isStellaModelAllowedForAudience("stella/default", audience)).toBe(
        audience !== "pro",
      );
      expect(isStellaModelAllowedForAudience("stella/light", audience)).toBe(
        true,
      );
      for (const pickerModel of [
        FLASH_SELECTION,
        LEGACY_FIREWORKS_SELECTION,
        LEGACY_DIRECT_SELECTION,
      ]) {
        expect(isStellaModelAllowedForAudience(pickerModel, audience)).toBe(
          audience === "pro",
        );
      }
      for (const retired of [...RETIRED_SELECTIONS, "stella/max"]) {
        expect(isStellaModelAllowedForAudience(retired, audience)).toBe(false);
      }
    }
  });

  it("publishes the same rows but enables them only for Pro", () => {
    for (const audience of MANAGED_MODEL_AUDIENCES) {
      expect(listStellaCatalogModels(audience)).toEqual([
        {
          id: FLASH_SELECTION,
          name: "DeepSeek V4.1 Flash",
          provider: "stella",
          upstreamModel: DEEPSEEK_V4_1_FLASH_MODEL,
          api: "openai-completions",
          type: "language",
          allowedForAudience: audience === "pro",
        },

      ]);
    }
  });
});


it("defaults every audience to Flash with no model or provider fallback", () => {
  for (const audience of MANAGED_MODEL_AUDIENCES) {
    for (const agent of ["orchestrator", "general"]) {
      const { config } = resolveStellaModelConfigForSelection("stella/default", agent, audience);
      expect(config).toMatchObject({
        model: DEEPSEEK_V4_1_FLASH_MODEL,
        managedGatewayProvider: "openrouter",
        api: "openai-completions",
        providerOptions: { gateway: { only: ["inference-net"], allow_fallbacks: false } },
      });
      expect(config.fallback).toBeUndefined();
    }
    expect(listStellaCatalogModels(audience).map(row => row.upstreamModel))
      .toEqual([DEEPSEEK_V4_1_FLASH_MODEL]);
  }
});
