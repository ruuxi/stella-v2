import { describe, expect, it } from "bun:test";

import {
  downgradeUnsupportedRequestImages,
  requestedModelFromGooglePath,
  resolveRequestedStellaModel,
} from "../../convex/stella_provider/request";
import { toProviderNativeModel } from "../../convex/stella_provider/authorization";
import { getModeConfig, getModelConfig } from "../../convex/agent/model";

describe("toProviderNativeModel", () => {
  it("strips provider prefix for matching upstream", () => {
    // Anthropic ids use dashes, not dots — converted at the wire boundary.
    expect(
      toProviderNativeModel("anthropic/claude-opus-5", "anthropic"),
    ).toBe("claude-opus-5");
    expect(toProviderNativeModel("openai/gpt-5.6-luna", "openai")).toBe(
      "gpt-5.6-luna",
    );
    expect(
      toProviderNativeModel("google/gemini-3.6-flash", "google"),
    ).toBe("gemini-3.6-flash");
    expect(toProviderNativeModel("meta/muse-spark-1.1", "meta")).toBe(
      "muse-spark-1.1",
    );
    expect(toProviderNativeModel("x-ai/grok-4.5", "xai")).toBe("grok-4.5");
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
        "/api/stella/google/v1beta/models/gemini-3.6-flash:streamGenerateContent",
      ),
    ).toBe("gemini-3.6-flash");
  });

  it("extracts model ids containing slashes (stella/google/...)", () => {
    expect(
      requestedModelFromGooglePath(
        "/api/stella/google/v1beta/models/stella/google/gemini-3.6-flash:streamGenerateContent",
      ),
    ).toBe("stella/google/gemini-3.6-flash");
  });

  it("works for non-stream verbs", () => {
    expect(
      requestedModelFromGooglePath(
        "/api/stella/google/v1beta/models/gemini-3.6-flash:generateContent",
      ),
    ).toBe("gemini-3.6-flash");
    expect(
      requestedModelFromGooglePath(
        "/api/stella/google/v1beta/models/gemini-3.6-flash:countTokens",
      ),
    ).toBe("gemini-3.6-flash");
    expect(
      requestedModelFromGooglePath(
        "/api/stella/google/v1beta/models/text-embedding-001:embedContent",
      ),
    ).toBe("text-embedding-001");
  });

  it("decodes percent-encoded path segments", () => {
    expect(
      requestedModelFromGooglePath(
        "/api/stella/google/v1beta/models/stella%2Fgoogle%2Fgemini-3.6-flash:streamGenerateContent",
      ),
    ).toBe("stella/google/gemini-3.6-flash");
  });

  it("returns null on paths without a verb suffix", () => {
    expect(
      requestedModelFromGooglePath(
        "/api/stella/google/v1beta/models/gemini-3.6-flash",
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
      downgradeUnsupportedRequestImages(body, "deepseek/deepseek-v4-flash")
        .messages,
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
      downgradeUnsupportedRequestImages(body, "deepseek/deepseek-v4-flash")
        .messages,
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

    expect(downgradeUnsupportedRequestImages(body, "openai/gpt-5.5")).toBe(
      body,
    );
    expect(downgradeUnsupportedRequestImages(body, "x-ai/grok-4.5")).toBe(body);
    expect(
      downgradeUnsupportedRequestImages(body, "google/gemini-3.6-flash"),
    ).toBe(body);
    expect(downgradeUnsupportedRequestImages(body, "meta/muse-spark-1.1")).toBe(
      body,
    );
    expect(
      downgradeUnsupportedRequestImages(
        body,
        "accounts/fireworks/models/kimi-k3",
      ),
    ).toBe(body);
  });
});

describe("resolveRequestedStellaModel", () => {
  it("routes missing free, anonymous, and Go General requests to DeepSeek Light", () => {
    for (const audience of [
      "anonymous",
      "free",
      "go",
      "go_fallback",
    ] as const) {
      const resolved = resolveRequestedStellaModel("general", {}, audience);
      expect(resolved.requestedModel).toBe("stella/default");
      expect(resolved.resolvedModel).toBe(
        "accounts/fireworks/models/deepseek-v4-flash-0731",
      );
      expect(resolved.config.managedGatewayProvider).toBe("fireworks");
    }
  });

  it("resolves a missing chat model through the agent's backend default", () => {
    const resolved = resolveRequestedStellaModel("orchestrator", {}, "pro");
    expect(resolved.requestedModel).toBe("stella/default");
    expect(resolved.resolvedModel).toBe(
      getModelConfig("orchestrator", "pro").model,
    );
    expect(resolved.config.managedGatewayProvider).toBe("xai");
    expect(resolved.config.fallback).toBeUndefined();
  });

  it("resolves to the agent's own default (Light for chronicle)", () => {
    const resolved = resolveRequestedStellaModel("chronicle", {}, "pro");
    expect(resolved.requestedModel).toBe("stella/default");
    expect(resolved.resolvedModel).toBe(
      getModelConfig("chronicle", "pro").model,
    );
    expect(resolved.config.managedGatewayProvider).toBe("fireworks");
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
    expect(free.resolvedModel).toBe(
      getModelConfig("orchestrator", "free").model,
    );

    const chronicle = resolveRequestedStellaModel(
      "chronicle",
      { model: defaultAlias },
      "pro",
    );
    expect(chronicle.requestedModel).toBe("stella/default");
    expect(chronicle.resolvedModel).toBe(
      getModelConfig("chronicle", "pro").model,
    );
  });

  it("resolves an explicit upstream pick to its native model id and clears fallback", () => {
    const resolved = resolveRequestedStellaModel(
      "orchestrator",
      { model: "stella/anthropic/claude-opus-5" },
      "pro",
    );
    expect(resolved.requestedModel).toBe("stella/anthropic/claude-opus-5");
    expect(resolved.resolvedModel).toBe("anthropic/claude-opus-5");
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
        { model: "stella/google/gemini-3.6-flash" },
        "pro",
      ).config.managedGatewayProvider,
    ).toBe("google");
    expect(
      resolveRequestedStellaModel(
        "orchestrator",
        { model: "stella/meta/muse-spark-1.1" },
        "pro",
      ).config.managedGatewayProvider,
    ).toBe("meta");
  });

  it("coerces an override to the backend default for restricted audiences", () => {
    const resolved = resolveRequestedStellaModel(
      "orchestrator",
      { model: "stella/anthropic/claude-opus-5" },
      "free",
    );
    expect(resolved.requestedModel).toBe("stella/default");
    expect(resolved.resolvedModel).toBe(
      getModelConfig("orchestrator", "free").model,
    );
  });

  it("ignores overrides for locked agents and uses their backend default", () => {
    const resolved = resolveRequestedStellaModel(
      "chronicle",
      { model: "stella/anthropic/claude-opus-5" },
      "pro",
    );
    expect(resolved.requestedModel).toBe("stella/default");
    expect(resolved.resolvedModel).toBe(
      getModelConfig("chronicle", "pro").model,
    );
  });

  it("resolves a branded mode override to its per-audience model", () => {
    const resolved = resolveRequestedStellaModel(
      "orchestrator",
      { model: "stella/designer" },
      "pro",
    );
    expect(resolved.requestedModel).toBe("stella/designer");
    expect(resolved.resolvedModel).toBe(getModeConfig("designer", "pro").model);
    expect(resolved.config.fallback).toBeUndefined();
  });

  it("lets restricted audiences pick the Light mode but not other modes", () => {
    const light = resolveRequestedStellaModel(
      "orchestrator",
      { model: "stella/light" },
      "free",
    );
    expect(light.requestedModel).toBe("stella/light");
    expect(light.resolvedModel).toBe(getModeConfig("light", "free").model);

    // Designer is not in the restricted allow-list → coerced to the default.
    const designer = resolveRequestedStellaModel(
      "orchestrator",
      { model: "stella/designer" },
      "free",
    );
    expect(designer.requestedModel).toBe("stella/default");
    expect(designer.resolvedModel).toBe(
      getModelConfig("orchestrator", "free").model,
    );
  });

  it("allows anonymous and signed-in free users to pick Luna and DeepSeek V4 Pro", () => {
    for (const audience of ["anonymous", "free"] as const) {
      const luna = resolveRequestedStellaModel(
        "orchestrator",
        { model: "stella/openai/gpt-5.6-luna" },
        audience,
      );
      expect(luna.requestedModel).toBe("stella/openai/gpt-5.6-luna");
      expect(luna.resolvedModel).toBe("openai/gpt-5.6-luna");
      expect(luna.config.managedGatewayProvider).toBe("openai");

      const deepSeekPro = resolveRequestedStellaModel(
        "orchestrator",
        {
          model: "stella/accounts/fireworks/models/deepseek-v4-pro",
        },
        audience,
      );
      expect(deepSeekPro.requestedModel).toBe(
        "stella/accounts/fireworks/models/deepseek-v4-pro",
      );
      expect(deepSeekPro.resolvedModel).toBe(
        "accounts/fireworks/models/deepseek-v4-pro",
      );
      expect(deepSeekPro.config.managedGatewayProvider).toBe("fireworks");
    }
  });

  it("keeps the new raw free-model exceptions unavailable to Go", () => {
    for (const model of [
      "stella/openai/gpt-5.6-luna",
      "stella/accounts/fireworks/models/deepseek-v4-pro",
    ]) {
      const resolved = resolveRequestedStellaModel(
        "orchestrator",
        { model },
        "go",
      );
      expect(resolved.requestedModel).toBe("stella/default");
      expect(resolved.resolvedModel).toBe(
        getModelConfig("orchestrator", "go").model,
      );
    }
  });
});
