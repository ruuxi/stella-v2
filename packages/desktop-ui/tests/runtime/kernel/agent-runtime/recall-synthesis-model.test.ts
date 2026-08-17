// Recall synthesis resolves the user's active model/provider and forces LOW
// reasoning (off/none when unsupported), while accepting credentialless local
// routes without a key — the regression that surfaced as the tool failing
// everywhere with "No Recall model credential is configured".

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
}): ResolvedLlmRoute =>
  ({
    route: over.routeKind ?? "direct-provider",
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

  it("accepts a credentialless local/direct-provider route with no key", async () => {
    const key = await resolveRecallSynthesisApiKey(
      route({
        routeKind: "direct-provider",
        baseUrl: "http://127.0.0.1:11434/v1",
        apiKey: undefined,
      }),
    );
    expect(key).toBeUndefined();
  });

  it("throws the documented error only when a key is required and missing", async () => {
    await expect(
      resolveRecallSynthesisApiKey(
        // A managed route with no baseUrl is not credentialless: it needs a key.
        route({ routeKind: "stella", baseUrl: "", apiKey: undefined }),
      ),
    ).rejects.toThrow(/No Recall model credential is configured/);
  });

  it("trims whitespace-only keys and treats them as missing", async () => {
    await expect(
      resolveRecallSynthesisApiKey(
        route({ routeKind: "stella", baseUrl: "", apiKey: "   " }),
      ),
    ).rejects.toThrow(/No Recall model credential is configured/);
  });
});
