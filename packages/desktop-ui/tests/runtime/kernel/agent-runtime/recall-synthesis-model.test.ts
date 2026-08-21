// Recall synthesis resolves the user's active model/provider and forces LOW
// reasoning (off/none when unsupported), while accepting credentialless local
// routes without a key — the regression that surfaced as the tool failing
// everywhere with "No API key for provider: anthropic".

import { describe, expect, it } from "vitest";
import {
  recallSynthesisReasoning,
  resolveRecallSynthesisApiKey,
} from "@stella/runtime/kernel/agent-runtime/context-lookup";
import type { ResolvedLlmRoute } from "@stella/runtime/kernel/model-routing";

const route = (over: {
  routeKind?: "direct-provider" | "stella";
  baseUrl?: string;
  reasoning?: boolean;
  apiKey?: string | undefined;
  credentialless?: boolean;
}): ResolvedLlmRoute =>
  ({
    route: over.routeKind ?? "direct-provider",
    credentialless: over.credentialless,
    model: {
      id: "test-model",
      name: "test-model",
      api: "openai-completions",
      provider: "openrouter",
      baseUrl: over.baseUrl ?? "https://provider.example.test",
      reasoning: over.reasoning ?? true,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 128_000,
      maxTokens: 8_192,
    },
    getApiKey: async () => over.apiKey,
  }) as unknown as ResolvedLlmRoute;

describe("recallSynthesisReasoning", () => {
  it("uses low reasoning for models that support an effort setting", () => {
    expect(recallSynthesisReasoning(route({ reasoning: true }).model)).toBe(
      "low",
    );
  });

  it("uses off/none (omits the param) for models without reasoning support", () => {
    expect(
      recallSynthesisReasoning(route({ reasoning: false }).model),
    ).toBeUndefined();
  });
});

describe("resolveRecallSynthesisApiKey", () => {
  it("returns the provider key when one is available (BYOK / active model)", async () => {
    const key = await resolveRecallSynthesisApiKey(
      route({ apiKey: "sk-live-123" }),
    );
    expect(key).toBe("sk-live-123");
  });

  it("accepts a route that explicitly declares itself credentialless", async () => {
    const key = await resolveRecallSynthesisApiKey(
      route({
        routeKind: "direct-provider",
        baseUrl: "http://127.0.0.1:11434/v1",
        apiKey: undefined,
        credentialless: true,
      }),
    );
    expect(key).toBeUndefined();
  });

  it("regression: a remote baseUrl alone does NOT make a keyless route valid", async () => {
    // The old heuristic treated any direct-provider route with a baseUrl as
    // credentialless, which let a keyless Anthropic request reach the wire
    // and fail with the provider's raw "No API key for provider" error.
    await expect(
      resolveRecallSynthesisApiKey(
        route({
          routeKind: "direct-provider",
          baseUrl: "https://api.anthropic.com",
          apiKey: undefined,
          credentialless: undefined,
        }),
      ),
    ).rejects.toThrow(/no usable credential for model/);
  });

  it("throws the documented error only when a key is required and missing", async () => {
    await expect(
      resolveRecallSynthesisApiKey(
        // A managed route with no baseUrl is not credentialless: it needs a key.
        route({ routeKind: "stella", baseUrl: "", apiKey: undefined }),
      ),
    ).rejects.toThrow(/no usable credential for model/);
  });

  it("trims whitespace-only keys and treats them as missing", async () => {
    await expect(
      resolveRecallSynthesisApiKey(
        route({ routeKind: "stella", baseUrl: "", apiKey: "   " }),
      ),
    ).rejects.toThrow(/no usable credential for model/);
  });
});
