import { describe, expect, it } from "bun:test";

import {
  requestedModelFromGooglePath,
  resolveRequestedStellaModel,
} from "../../convex/stella_provider/request";
import { toProviderNativeModel } from "../../convex/stella_provider/authorization";
import { getModeConfig } from "../../convex/agent/model";

describe("toProviderNativeModel", () => {
  it("strips provider prefix for matching upstream", () => {
    // Anthropic ids use dashes, not dots — converted at the wire boundary.
    expect(toProviderNativeModel("anthropic/claude-opus-4.7", "anthropic")).toBe(
      "claude-opus-4-7",
    );
    expect(toProviderNativeModel("openai/gpt-5.5", "openai")).toBe("gpt-5.5");
    expect(toProviderNativeModel("google/gemini-3-flash-preview", "google")).toBe(
      "gemini-3-flash-preview",
    );
  });

  it("passes through ids that do not match the relay provider", () => {
    expect(toProviderNativeModel("openai/gpt-5.5", "openrouter")).toBe(
      "openai/gpt-5.5",
    );
    expect(
      toProviderNativeModel("accounts/fireworks/models/kimi-k2p6", "fireworks"),
    ).toBe("accounts/fireworks/models/kimi-k2p6");
  });
});

describe("requestedModelFromGooglePath", () => {
  it("extracts a single-segment model + verb", () => {
    expect(
      requestedModelFromGooglePath(
        "/api/stella/google/v1beta/models/gemini-3-flash-preview:streamGenerateContent",
      ),
    ).toBe("gemini-3-flash-preview");
  });

  it("extracts model ids containing slashes (stella/google/...)", () => {
    expect(
      requestedModelFromGooglePath(
        "/api/stella/google/v1beta/models/stella/google/gemini-3-flash-preview:streamGenerateContent",
      ),
    ).toBe("stella/google/gemini-3-flash-preview");
  });

  it("works for non-stream verbs", () => {
    expect(
      requestedModelFromGooglePath(
        "/api/stella/google/v1beta/models/gemini-3-flash-preview:generateContent",
      ),
    ).toBe("gemini-3-flash-preview");
    expect(
      requestedModelFromGooglePath(
        "/api/stella/google/v1beta/models/gemini-3-flash-preview:countTokens",
      ),
    ).toBe("gemini-3-flash-preview");
    expect(
      requestedModelFromGooglePath(
        "/api/stella/google/v1beta/models/text-embedding-001:embedContent",
      ),
    ).toBe("text-embedding-001");
  });

  it("decodes percent-encoded path segments", () => {
    expect(
      requestedModelFromGooglePath(
        "/api/stella/google/v1beta/models/stella%2Fgoogle%2Fgemini-3-flash-preview:streamGenerateContent",
      ),
    ).toBe("stella/google/gemini-3-flash-preview");
  });

  it("returns null on paths without a verb suffix", () => {
    expect(
      requestedModelFromGooglePath(
        "/api/stella/google/v1beta/models/gemini-3-flash-preview",
      ),
    ).toBeNull();
  });
});

describe("resolveRequestedStellaModel", () => {
  it("resolves a missing chat model through the standard mode", () => {
    const resolved = resolveRequestedStellaModel("orchestrator", {}, "pro");
    expect(resolved.requestedModel).toBe("stella/standard");
    expect(resolved.resolvedModel).toBe(getModeConfig("standard", "pro").model);
    expect(resolved.config.managedGatewayProvider).toBe("openai");
    expect(resolved.config.fallback).toBeUndefined();
  });

  it("preserves Light for agent defaults that are configured as Light", () => {
    const resolved = resolveRequestedStellaModel("chronicle", {}, "pro");
    expect(resolved.requestedModel).toBe("stella/light");
    expect(resolved.resolvedModel).toBe(getModeConfig("light", "pro").model);
    expect(resolved.config.managedGatewayProvider).toBe("openrouter");
    expect(resolved.config.fallback).toBeUndefined();
  });

  it("treats the default alias like a missing model", () => {
    const legacyDefaultAlias = ["stella", "default"].join("/");
    const pro = resolveRequestedStellaModel(
      "orchestrator",
      { model: legacyDefaultAlias },
      "pro",
    );
    expect(pro.requestedModel).toBe("stella/standard");
    expect(pro.resolvedModel).toBe(getModeConfig("standard", "pro").model);

    const free = resolveRequestedStellaModel(
      "orchestrator",
      { model: legacyDefaultAlias },
      "free",
    );
    expect(free.requestedModel).toBe("stella/standard");
    expect(free.resolvedModel).toBe(getModeConfig("standard", "free").model);

    const chronicle = resolveRequestedStellaModel(
      "chronicle",
      { model: legacyDefaultAlias },
      "pro",
    );
    expect(chronicle.requestedModel).toBe("stella/light");
    expect(chronicle.resolvedModel).toBe(getModeConfig("light", "pro").model);
  });

  it("resolves an explicit upstream pick to its native model id and clears fallback", () => {
    const resolved = resolveRequestedStellaModel(
      "orchestrator",
      { model: "stella/anthropic/claude-opus-4.7" },
      "pro",
    );
    expect(resolved.requestedModel).toBe("stella/anthropic/claude-opus-4.7");
    expect(resolved.resolvedModel).toBe("anthropic/claude-opus-4.7");
    expect(resolved.config.managedGatewayProvider).toBe("anthropic");
    expect(resolved.config.fallback).toBeUndefined();
  });

  it("infers the gateway from the model prefix for an upstream pick", () => {
    expect(
      resolveRequestedStellaModel(
        "orchestrator",
        { model: "stella/openai/gpt-5.5" },
        "pro",
      ).config.managedGatewayProvider,
    ).toBe("openai");
    expect(
      resolveRequestedStellaModel(
        "orchestrator",
        { model: "stella/google/gemini-3-flash-preview" },
        "pro",
      ).config.managedGatewayProvider,
    ).toBe("google");
  });

  it("coerces a disallowed model to standard mode for restricted audiences", () => {
    const resolved = resolveRequestedStellaModel(
      "orchestrator",
      { model: "stella/anthropic/claude-opus-4.7" },
      "free",
    );
    expect(resolved.requestedModel).toBe("stella/standard");
  });

  it("coerces locked Light agents back to Light instead of Standard", () => {
    const resolved = resolveRequestedStellaModel(
      "chronicle",
      { model: "stella/designer" },
      "pro",
    );
    expect(resolved.requestedModel).toBe("stella/light");
    expect(resolved.resolvedModel).toBe(getModeConfig("light", "pro").model);
  });
});
