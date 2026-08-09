import { describe, expect, it } from "bun:test";

import {
  getManagedGatewayConfig,
  inferManagedGatewayProviderFromModel,
  resolveManagedGatewayApiKey,
  resolveManagedGatewayProvider,
} from "../convex/lib/managed_gateway";
import { buildManagedModel } from "../convex/runtime_ai/managed";
import { buildBaseOptions } from "../convex/runtime_ai/simple_options";

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

  it("infers direct providers from their model prefixes", () => {
    expect(inferManagedGatewayProviderFromModel("meta/muse-spark-1.1")).toBe(
      "meta",
    );
    expect(
      inferManagedGatewayProviderFromModel("wafer/DeepSeek-V4-Flash-0731-Fast"),
    ).toBe("wafer");
    expect(
      resolveManagedGatewayProvider({ model: "meta/muse-spark-1.1" }),
    ).toBe("meta");
    expect(
      resolveManagedGatewayProvider({
        model: "wafer/DeepSeek-V4-Flash-0731-Fast",
      }),
    ).toBe("wafer");
  });

  it("points Wafer at chat completions using WAFER_API_KEY", () => {
    const config = getManagedGatewayConfig("wafer");
    expect(config.baseURL).toBe("https://pass.wafer.ai/v1");
    expect(config.apiKeyEnvVar).toBe("WAFER_API_KEY");
  });

  it("keeps Wafer Fast at a 1M context window without an output cap", () => {
    const model = buildManagedModel(
      {
        model: "wafer/DeepSeek-V4-Flash-0731-Fast",
        managedGatewayProvider: "wafer",
      },
      "openai-completions",
    );

    expect(model.contextWindow).toBe(1_000_000);
    expect(model.maxTokens).toBe(0);
    expect(buildBaseOptions(model).maxTokens).toBeUndefined();
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
