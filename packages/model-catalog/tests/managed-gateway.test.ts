import { describe, expect, it } from "bun:test";

import {
  getManagedGatewayConfig,
  inferManagedGatewayProviderFromModel,
  listManagedGatewayApiKeyEnvVars,
  resolveManagedGatewayApiKeyFromEnv,
  resolveManagedGatewayConfig,
  resolveManagedGatewayProvider,
} from "@stella/model-catalog/managed-gateway";

describe("managed gateway", () => {
  it("infers the gateway from canonical model prefixes", () => {
    expect(inferManagedGatewayProviderFromModel("x-ai/grok-4.5")).toBe("xai");
    expect(
      inferManagedGatewayProviderFromModel("deepseek/deepseek-v4-flash"),
    ).toBe("deepseek");
    expect(
      inferManagedGatewayProviderFromModel(
        "accounts/fireworks/models/deepseek-v4-flash-0731",
      ),
    ).toBe("fireworks");
    expect(
      inferManagedGatewayProviderFromModel("crof/deepseek-v4-flash-0731"),
    ).toBe("crof");
    expect(
      inferManagedGatewayProviderFromModel("wafer/deepseek-v4-flash-0731-fast"),
    ).toBe("wafer");
    expect(
      inferManagedGatewayProviderFromModel("openrouter/x-ai/grok-4.5"),
    ).toBe("openrouter");
    expect(inferManagedGatewayProviderFromModel("meta/muse-spark-1.1")).toBe(
      "meta",
    );
    expect(
      inferManagedGatewayProviderFromModel("moonshotai/kimi-k2.6"),
    ).toBeUndefined();
    expect(
      resolveManagedGatewayProvider({ model: "moonshotai/kimi-k2.6" }),
    ).toBe("openrouter");
  });

  it("lets an explicit gateway win over prefix inference", () => {
    // `meta/muse-spark-1.3-contributor` is an OpenRouter-hosted slug.
    expect(
      inferManagedGatewayProviderFromModel("meta/muse-spark-1.3-contributor"),
    ).toBe("meta");
    const config = resolveManagedGatewayConfig({
      model: "meta/muse-spark-1.3-contributor",
      configuredProvider: "openrouter",
    });
    expect(config.provider).toBe("openrouter");
    expect(config.baseURL).toBe("https://openrouter.ai/api/v1");
  });

  it("publishes base URLs, key env names, and static headers per gateway", () => {
    expect(getManagedGatewayConfig("deepseek")).toMatchObject({
      baseURL: "https://api.deepseek.com",
      apiKeyEnvVar: "DEEPSEEK_API_KEY",
    });
    expect(getManagedGatewayConfig("xai")).toMatchObject({
      baseURL: "https://api.x.ai/v1",
      apiKeyEnvVar: "XAI_API_KEY",
    });
    expect(getManagedGatewayConfig("wafer")).toMatchObject({
      baseURL: "https://pass.wafer.ai/v1",
      apiKeyEnvVar: "WAFER_API_KEY",
      extraHeaders: { "Wafer-ZDR": "required" },
    });
    expect(getManagedGatewayConfig("meta")).toMatchObject({
      baseURL: "https://api.meta.ai/v1",
      apiKeyEnvVar: "META_MODEL_API_KEY",
      apiKeyEnvVarFallbacks: ["MODEL_API_KEY"],
    });
  });

  it("resolves META_MODEL_API_KEY ahead of MODEL_API_KEY from an explicit env map", () => {
    const config = getManagedGatewayConfig("meta");
    expect(listManagedGatewayApiKeyEnvVars(config)).toEqual([
      "META_MODEL_API_KEY",
      "MODEL_API_KEY",
    ]);
    expect(resolveManagedGatewayApiKeyFromEnv(config, {})).toBeUndefined();
    expect(
      resolveManagedGatewayApiKeyFromEnv(config, {
        MODEL_API_KEY: "from-model-api-key",
      }),
    ).toBe("from-model-api-key");
    expect(
      resolveManagedGatewayApiKeyFromEnv(config, {
        MODEL_API_KEY: "from-model-api-key",
        META_MODEL_API_KEY: " from-meta-model-api-key ",
      }),
    ).toBe("from-meta-model-api-key");
    // Blank values do not shadow a fallback.
    expect(
      resolveManagedGatewayApiKeyFromEnv(config, {
        META_MODEL_API_KEY: "   ",
        MODEL_API_KEY: "fallback",
      }),
    ).toBe("fallback");
  });
});
