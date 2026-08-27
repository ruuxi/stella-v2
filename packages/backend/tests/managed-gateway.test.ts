import { describe, expect, it } from "bun:test";

import {
  getManagedGatewayConfig,
  inferManagedGatewayProviderFromModel,
  resolveManagedGatewayApiKey,
  resolveManagedGatewayConfig,
  resolveManagedGatewayProvider,
} from "../convex/lib/managed_gateway";

describe("managed gateway", () => {
  it("infers xAI from the canonical Grok model prefix", () => {
    expect(inferManagedGatewayProviderFromModel("x-ai/grok-4.5")).toBe("xai");
    expect(resolveManagedGatewayProvider({ model: "x-ai/grok-4.5" })).toBe(
      "xai",
    );
  });

  it("points xAI at its direct API using XAI_API_KEY", () => {
    const config = getManagedGatewayConfig("xai");
    expect(config.baseURL).toBe("https://api.x.ai/v1");
    expect(config.apiKeyEnvVar).toBe("XAI_API_KEY");
  });

  it("infers deepseek from the deepseek/ model prefix", () => {
    expect(
      inferManagedGatewayProviderFromModel("deepseek/deepseek-v4-flash"),
    ).toBe("deepseek");
    expect(
      resolveManagedGatewayProvider({ model: "deepseek/deepseek-v4-flash" }),
    ).toBe("deepseek");

    expect(
      inferManagedGatewayProviderFromModel(
        "accounts/fireworks/models/deepseek-v4-flash-0731",
      ),
    ).toBe("fireworks");
  });

  it("points DeepSeek at its root base URL with DEEPSEEK_API_KEY", () => {
    const config = getManagedGatewayConfig("deepseek");

    expect(config.baseURL).toBe("https://api.deepseek.com");
    expect(config.apiKeyEnvVar).toBe("DEEPSEEK_API_KEY");
  });

  it("routes CrofAI models to its OpenAI-compatible API", () => {
    expect(
      inferManagedGatewayProviderFromModel("crof/deepseek-v4-flash-0731"),
    ).toBe("crof");
    const config = getManagedGatewayConfig("crof");
    expect(config.baseURL).toBe("https://crof.ai/v1");
    expect(config.apiKeyEnvVar).toBe("CROF_API_KEY");
  });

  it("routes Wafer models to its OpenAI-compatible API with ZDR headers", () => {
    expect(
      inferManagedGatewayProviderFromModel("wafer/deepseek-v4-flash-0731-fast"),
    ).toBe("wafer");
    const config = getManagedGatewayConfig("wafer");
    expect(config.baseURL).toBe("https://pass.wafer.ai/v1");
    expect(config.apiKeyEnvVar).toBe("WAFER_API_KEY");

    expect(config.extraHeaders).toEqual({ "Wafer-ZDR": "required" });
    expect(
      resolveManagedGatewayProvider({
        model: "wafer/deepseek-v4-flash-0731-fast",
      }),
    ).toBe("wafer");
  });

  it("routes OpenRouter-namespaced slugs through the OpenRouter gateway", () => {
    expect(
      inferManagedGatewayProviderFromModel("openrouter/x-ai/grok-4.5"),
    ).toBe("openrouter");
    const config = getManagedGatewayConfig("openrouter");
    expect(config.baseURL).toBe("https://openrouter.ai/api/v1");
    expect(config.apiKeyEnvVar).toBe("OPENROUTER_API_KEY");
  });

  it("routes the Muse Spark contributor slug through OpenRouter despite the meta/ prefix", () => {

    expect(
      inferManagedGatewayProviderFromModel("meta/muse-spark-1.2-contributor"),
    ).toBe("meta");
    expect(
      resolveManagedGatewayProvider({
        model: "meta/muse-spark-1.2-contributor",
        configuredProvider: "openrouter",
      }),
    ).toBe("openrouter");
    const config = resolveManagedGatewayConfig({
      model: "meta/muse-spark-1.2-contributor",
      configuredProvider: "openrouter",
    });
    expect(config.provider).toBe("openrouter");
    expect(config.baseURL).toBe("https://openrouter.ai/api/v1");
  });

  it("infers meta from the meta/ model prefix", () => {
    expect(inferManagedGatewayProviderFromModel("meta/muse-spark-1.1")).toBe(
      "meta",
    );
    expect(
      resolveManagedGatewayProvider({ model: "meta/muse-spark-1.1" }),
    ).toBe("meta");
  });

  it("points Meta gateway at api.meta.ai with Stella env first", () => {
    const config = getManagedGatewayConfig("meta");
    expect(config.baseURL).toBe("https://api.meta.ai/v1");
    expect(config.apiKeyEnvVar).toBe("META_MODEL_API_KEY");
    expect(config.apiKeyEnvVarFallbacks).toContain("MODEL_API_KEY");
  });

  it("resolves META_MODEL_API_KEY ahead of MODEL_API_KEY", () => {
    const config = getManagedGatewayConfig("meta");
    const prevMeta = process.env.META_MODEL_API_KEY;
    const prevModel = process.env.MODEL_API_KEY;
    const setEnv = (key: string, value: string | undefined) => {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    };
    try {
      setEnv("META_MODEL_API_KEY", undefined);
      setEnv("MODEL_API_KEY", undefined);
      expect(resolveManagedGatewayApiKey(config)).toBeUndefined();

      setEnv("MODEL_API_KEY", "from-model-api-key");
      expect(resolveManagedGatewayApiKey(config)).toBe("from-model-api-key");

      setEnv("META_MODEL_API_KEY", "from-meta-model-api-key");
      expect(resolveManagedGatewayApiKey(config)).toBe(
        "from-meta-model-api-key",
      );
    } finally {
      setEnv("META_MODEL_API_KEY", prevMeta);
      setEnv("MODEL_API_KEY", prevModel);
    }
  });
});
