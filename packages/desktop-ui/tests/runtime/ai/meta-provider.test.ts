import { afterEach, describe, expect, it, vi } from "vitest";

import { getProviderDisplayName } from "@stella/contracts/provider-display";
import { getEnvApiKey } from "@stella/runtime/ai/env-api-keys";
import { getModels } from "@stella/runtime/ai/models";
import { streamSimpleOpenAIResponses } from "@stella/runtime/ai/providers/openai-responses";
import { LLM_PROVIDERS } from "@/global/settings/lib/llm-providers";

const originalFetch = globalThis.fetch;
const originalMetaApiKey = process.env.META_API_KEY;
const originalModelApiKey = process.env.MODEL_API_KEY;

const restoreEnv = (name: "META_API_KEY" | "MODEL_API_KEY", value?: string) => {
  if (value === undefined) {
    delete process.env[name];
    return;
  }
  process.env[name] = value;
};

afterEach(() => {
  globalThis.fetch = originalFetch;
  restoreEnv("META_API_KEY", originalMetaApiKey);
  restoreEnv("MODEL_API_KEY", originalModelApiKey);
  vi.restoreAllMocks();
});

describe("Meta direct provider", () => {
  it("publishes Meta and all current Muse Spark models in the local catalog", () => {
    expect(getProviderDisplayName("meta")).toBe("Meta");
    expect(LLM_PROVIDERS).toContainEqual({
      key: "meta",
      label: "Meta",
      placeholder: "LLM|...",
    });

    expect(
      getModels("meta").map((model) => ({
        id: model.id,
        api: model.api,
        baseUrl: model.baseUrl,
        contextWindow: model.contextWindow,
        cacheRead: model.cost.cacheRead,
      })),
    ).toEqual([
      {
        id: "muse-spark-1.1",
        api: "openai-responses",
        baseUrl: "https://api.meta.ai/v1",
        contextWindow: 1_048_576,
        cacheRead: 0.15,
      },
      {
        id: "muse-spark-1.2",
        api: "openai-responses",
        baseUrl: "https://api.meta.ai/v1",
        contextWindow: 1_048_576,
        cacheRead: 0.15,
      },
      {
        id: "muse-spark-1.2-contributor",
        api: "openai-responses",
        baseUrl: "https://api.meta.ai/v1",
        contextWindow: 1_048_576,
        cacheRead: 0.002,
      },
    ]);
  });

  it("accepts both Meta-documented environment variable names", () => {
    process.env.MODEL_API_KEY = "model-key";
    delete process.env.META_API_KEY;
    expect(getEnvApiKey("meta")).toBe("model-key");

    process.env.META_API_KEY = "meta-key";
    expect(getEnvApiKey("meta")).toBe("meta-key");
  });

  it("uses Meta's Responses endpoint with persisted reasoning and long cache retention", async () => {
    let requestUrl = "";
    let requestHeaders: Headers | undefined;
    let requestBody: Record<string, unknown> | undefined;
    globalThis.fetch = vi.fn(async (input, init) => {
      const request =
        input instanceof Request ? input : new Request(input, init);
      requestUrl = request.url;
      requestHeaders = request.headers;
      requestBody = (await request.clone().json()) as Record<string, unknown>;
      return new Response(
        JSON.stringify({ error: { message: "intentional test stop" } }),
        {
          status: 401,
          headers: { "content-type": "application/json" },
        },
      );
    }) as typeof fetch;

    const model = getModels("meta").find(
      (candidate) => candidate.id === "muse-spark-1.2",
    );
    expect(model).toBeDefined();

    await streamSimpleOpenAIResponses(
      model!,
      { messages: [{ role: "user", content: "Hello", timestamp: 0 }] },
      {
        apiKey: "meta-test-key",
        reasoning: "xhigh",
        cacheRetention: "long",
        promptCacheKey: "conversation-1",
        sessionId: "agent-1",
      },
    ).result();

    expect(requestUrl).toBe("https://api.meta.ai/v1/responses");
    expect(requestHeaders?.get("authorization")).toBe(
      "Bearer meta-test-key",
    );
    expect(requestHeaders?.has("session_id")).toBe(false);
    expect(requestBody).toMatchObject({
      model: "muse-spark-1.2",
      stream: true,
      store: true,
      prompt_cache_key: "conversation-1",
      prompt_cache_retention: "24h",
      reasoning: { effort: "xhigh", summary: "auto" },
      include: ["reasoning.encrypted_content"],
    });
  });
});
