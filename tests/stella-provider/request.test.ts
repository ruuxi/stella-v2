import { describe, expect, it } from "bun:test";

import {
  requestedModelFromGooglePath,
  resolveRequestedStellaModel,
} from "../../convex/stella_provider/request";
import { toProviderNativeModel } from "../../convex/stella_provider/authorization";

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
  it("resolves stella/default to the agent's mapped model", () => {
    const resolved = resolveRequestedStellaModel(
      "orchestrator",
      { model: "stella/default" },
      "pro",
    );
    expect(resolved.requestedModel).toBe("stella/default");
    expect(typeof resolved.resolvedModel).toBe("string");
    expect(resolved.config.fallback).toBeUndefined();
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

  it("coerces a disallowed model to STELLA_DEFAULT_MODEL for restricted audiences", () => {
    const resolved = resolveRequestedStellaModel(
      "orchestrator",
      { model: "stella/anthropic/claude-opus-4.7" },
      "free",
    );
    expect(resolved.requestedModel).toBe("stella/default");
  });
});
