import { describe, expect, it } from "bun:test";

import {
  downgradeUnsupportedRequestImages,
  requestedModelFromGooglePath,
  resolveRequestedStellaModel,
} from "../../convex/stella_provider/request";
import { toProviderNativeModel } from "../../convex/stella_provider/authorization";
import { getModelConfig } from "../../convex/agent/model";

describe("toProviderNativeModel", () => {
  it("strips provider prefix for matching upstream", () => {
    // Anthropic ids use dashes, not dots — converted at the wire boundary.
    expect(toProviderNativeModel("anthropic/claude-opus-4.8", "anthropic")).toBe(
      "claude-opus-4-8",
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

describe("downgradeUnsupportedRequestImages", () => {
  it("replaces chat image parts for text-only relay models", () => {
    const body = {
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "what is this?" },
            {
              type: "image_url",
              image_url: { url: "data:image/png;base64,abc" },
            },
          ],
        },
      ],
    };

    expect(
      downgradeUnsupportedRequestImages(
        body,
        "deepseek/deepseek-v4-flash",
      ).messages,
    ).toEqual([
      {
        role: "user",
        content: [
          { type: "text", text: "what is this?" },
          {
            type: "text",
            text: "(image omitted: model does not support images)",
          },
        ],
      },
    ]);
  });

  it("uses the tool placeholder for tool message images", () => {
    const body = {
      messages: [
        {
          role: "tool",
          content: [
            {
              type: "image_url",
              image_url: { url: "data:image/png;base64,tool" },
            },
          ],
        },
      ],
    };

    expect(
      downgradeUnsupportedRequestImages(
        body,
        "deepseek/deepseek-v4-flash",
      ).messages,
    ).toEqual([
      {
        role: "tool",
        content: [
          {
            type: "text",
            text: "(tool image omitted: model does not support images)",
          },
        ],
      },
    ]);
  });

  it("replaces responses input images for text-only relay models", () => {
    const body = {
      input: [
        {
          role: "user",
          content: [
            { type: "input_text", text: "describe this" },
            { type: "input_image", image_url: "data:image/png;base64,abc" },
          ],
        },
      ],
    };

    expect(
      downgradeUnsupportedRequestImages(
        body,
        "accounts/fireworks/models/kimi-k2p6",
      ).input,
    ).toEqual([
      {
        role: "user",
        content: [
          { type: "input_text", text: "describe this" },
          {
            type: "input_text",
            text: "(image omitted: model does not support images)",
          },
        ],
      },
    ]);
  });

  it("leaves image-capable relay models unchanged", () => {
    const body = {
      messages: [
        {
          role: "user",
          content: [
            {
              type: "image_url",
              image_url: { url: "data:image/png;base64,abc" },
            },
          ],
        },
      ],
    };

    expect(downgradeUnsupportedRequestImages(body, "openai/gpt-5.5")).toBe(body);
    expect(
      downgradeUnsupportedRequestImages(
        body,
        "google/gemini-3-flash-preview",
      ),
    ).toBe(body);
  });
});

describe("resolveRequestedStellaModel", () => {
  it("resolves a missing chat model through the agent's backend default", () => {
    const resolved = resolveRequestedStellaModel("orchestrator", {}, "pro");
    expect(resolved.requestedModel).toBe("stella/default");
    expect(resolved.resolvedModel).toBe(getModelConfig("orchestrator", "pro").model);
    expect(resolved.config.managedGatewayProvider).toBe("openai");
    expect(resolved.config.fallback).toBeUndefined();
  });

  it("resolves to the agent's own default (Light for chronicle)", () => {
    const resolved = resolveRequestedStellaModel("chronicle", {}, "pro");
    expect(resolved.requestedModel).toBe("stella/default");
    expect(resolved.resolvedModel).toBe(getModelConfig("chronicle", "pro").model);
    expect(resolved.config.managedGatewayProvider).toBe("openrouter");
    expect(resolved.config.fallback).toBeUndefined();
  });

  it("treats the explicit default sentinel like a missing model", () => {
    const defaultAlias = ["stella", "default"].join("/");
    const pro = resolveRequestedStellaModel(
      "orchestrator",
      { model: defaultAlias },
      "pro",
    );
    expect(pro.requestedModel).toBe("stella/default");
    expect(pro.resolvedModel).toBe(getModelConfig("orchestrator", "pro").model);

    const free = resolveRequestedStellaModel(
      "orchestrator",
      { model: defaultAlias },
      "free",
    );
    expect(free.requestedModel).toBe("stella/default");
    expect(free.resolvedModel).toBe(getModelConfig("orchestrator", "free").model);

    const chronicle = resolveRequestedStellaModel(
      "chronicle",
      { model: defaultAlias },
      "pro",
    );
    expect(chronicle.requestedModel).toBe("stella/default");
    expect(chronicle.resolvedModel).toBe(getModelConfig("chronicle", "pro").model);
  });

  it("resolves an explicit upstream pick to its native model id and clears fallback", () => {
    const resolved = resolveRequestedStellaModel(
      "orchestrator",
      { model: "stella/anthropic/claude-opus-4.8" },
      "pro",
    );
    expect(resolved.requestedModel).toBe("stella/anthropic/claude-opus-4.8");
    expect(resolved.resolvedModel).toBe("anthropic/claude-opus-4.8");
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

  it("coerces an override to the backend default for restricted audiences", () => {
    const resolved = resolveRequestedStellaModel(
      "orchestrator",
      { model: "stella/anthropic/claude-opus-4.8" },
      "free",
    );
    expect(resolved.requestedModel).toBe("stella/default");
    expect(resolved.resolvedModel).toBe(getModelConfig("orchestrator", "free").model);
  });

  it("ignores overrides for locked agents and uses their backend default", () => {
    const resolved = resolveRequestedStellaModel(
      "chronicle",
      { model: "stella/anthropic/claude-opus-4.8" },
      "pro",
    );
    expect(resolved.requestedModel).toBe("stella/default");
    expect(resolved.resolvedModel).toBe(getModelConfig("chronicle", "pro").model);
  });
});
