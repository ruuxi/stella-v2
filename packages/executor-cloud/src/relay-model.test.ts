import { describe, expect, test } from "bun:test";
import type { CloudExecutionSelection } from "@stella/contracts/agent-engine";
import type { Api, Model } from "@stella/runtime/ai/types.js";
import {
  CLOUD_LLM_CREDENTIAL_HEADER,
  CLOUD_TURN_TOKEN_HEADER,
  createCloudRelayModel,
  createResolvedManagedRelayModel,
  resolveCloudThinkingLevel,
  validateCloudExecutionSelection,
} from "./relay-model.js";

const create = (execution: CloudExecutionSelection) =>
  createCloudRelayModel({
    siteUrl: "https://example.convex.site",
    turnToken: "opaque-turn-token",
    agentType: "general",
    execution,
  });

describe("cloud relay model selection", () => {
  test("resolves the opaque managed default with the exact turn token", async () => {
    const originalFetch = globalThis.fetch;
    let capturedUrl = "";
    let capturedInit: RequestInit | undefined;
    globalThis.fetch = (async (input, init) => {
      capturedUrl = String(input);
      capturedInit = init;
      return Response.json({
        resolvedModel: "meta/muse-spark-1.2-contributor",
        relayProvider: "openrouter",
      });
    }) as typeof fetch;

    try {
      const model = await create({
        engine: "stella",
        provider: "stella",
        model: "stella/default",
        reasoningEffort: "default",
      });

      expect(capturedUrl).toBe(
        "https://example.convex.site/api/stella/cloud-model",
      );
      expect(
        new Headers(capturedInit?.headers).get(CLOUD_TURN_TOKEN_HEADER),
      ).toBe("opaque-turn-token");
      expect(JSON.parse(String(capturedInit?.body))).toEqual({
        model: "stella/default",
      });
      expect(model.id).toBe("stella/default");
      expect(
        (model as Model<Api> & { upstreamModelId?: string }).upstreamModelId,
      ).toBe("meta/muse-spark-1.2-contributor");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("uses server-resolved provider metadata for arbitrary Stella pins", () => {
    const openaiExecution = {
      engine: "stella",
      provider: "stella",
      model: "stella/openai/gpt-5.6-sol",
      reasoningEffort: "high",
    } satisfies CloudExecutionSelection;
    const openai = createResolvedManagedRelayModel({
      execution: openaiExecution,
      siteUrl: "https://example.convex.site",
      turnToken: "opaque-turn-token",
      agentType: "general",
      resolvedModelId: "openai/gpt-5.6-sol",
      relayProvider: "openai",
    });
    expect(openai.api).toBe("openai-responses");
    expect(openai.id).toBe("stella/openai/gpt-5.6-sol");
    expect(openai.baseUrl).toBe("https://example.convex.site/api/stella/relay");
    expect(openai.headers?.[CLOUD_TURN_TOKEN_HEADER]).toBe("opaque-turn-token");

    const openrouter = createResolvedManagedRelayModel({
      execution: {
        engine: "stella",
        provider: "stella",
        model: "stella/backend-owned-dynamic-alias",
        reasoningEffort: "medium",
      },
      siteUrl: "https://example.convex.site",
      turnToken: "opaque-turn-token",
      agentType: "general",
      resolvedModelId: "openrouter/x-ai/grok-4.5",
      relayProvider: "openrouter",
    });
    expect(openrouter.api).toBe("openai-completions");
    expect(openrouter.id).toBe("stella/backend-owned-dynamic-alias");
  });

  test("keeps connected Anthropic pins on the Anthropic adapter", async () => {
    const model = await create({
      engine: "anthropic",
      provider: "anthropic",
      model: "claude-opus-4-6",
      reasoningEffort: "high",
    });
    expect(model.api).toBe("anthropic-messages");
    expect(model.id).toBe("stella/anthropic/claude-opus-4-6");
    expect(model.headers?.[CLOUD_LLM_CREDENTIAL_HEADER]).toBe("anthropic");
    expect(model.headers?.[CLOUD_TURN_TOKEN_HEADER]).toBe("opaque-turn-token");
    expect(
      validateCloudExecutionSelection({
        engine: "anthropic",
        provider: "anthropic",
        model: "opus[1m]",
        reasoningEffort: "high",
      }).model,
    ).toBe("opus[1m]");
  });

  test("uses the existing Codex Responses adapter without exposing OAuth", async () => {
    const model = await create({
      engine: "openai-codex",
      provider: "openai-codex",
      model: "gpt-5.6-sol",
      reasoningEffort: "xhigh",
    });
    expect(model.api).toBe("openai-codex-responses");
    expect(model.id).toBe("stella/openai-codex/gpt-5.6-sol");
    expect(model.headers?.[CLOUD_LLM_CREDENTIAL_HEADER]).toBe("openai-codex");
    expect(JSON.stringify(model)).not.toContain("accessToken");
  });

  test("rejects mismatched, local-only, and malformed selections", () => {
    expect(() =>
      validateCloudExecutionSelection({
        engine: "stella",
        provider: "anthropic",
        model: "stella/standard",
        reasoningEffort: "default",
      } as unknown as CloudExecutionSelection),
    ).toThrow("engine and provider");
    expect(() =>
      validateCloudExecutionSelection({
        engine: "stella",
        provider: "stella",
        model: "stella/local/llama3",
        reasoningEffort: "default",
      }),
    ).toThrow("not available to cloud execution");
    expect(() =>
      validateCloudExecutionSelection({
        engine: "anthropic",
        provider: "anthropic",
        model: "anthropic/claude-opus",
        reasoningEffort: "medium",
      }),
    ).toThrow("engine-native model id");
    expect(() =>
      validateCloudExecutionSelection({
        engine: "openai-codex",
        provider: "openai-codex",
        model: "gpt-5.6-sol[1m]",
        reasoningEffort: "medium",
      }),
    ).toThrow("valid exact model id");
  });

  test("forwards exact effort when supported and clamps to a supported level", () => {
    const noXhigh = {
      id: "reasoning-model",
      name: "Reasoning model",
      provider: "openai",
      api: "openai-responses",
      baseUrl: "https://example.invalid",
      reasoning: true,
      thinkingLevelMap: { xhigh: null },
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 128_000,
      maxTokens: 8_192,
    } satisfies Model<Api>;
    expect(resolveCloudThinkingLevel(noXhigh, "high")).toBe("high");
    expect(resolveCloudThinkingLevel(noXhigh, "xhigh")).toBe("high");
    expect(resolveCloudThinkingLevel(noXhigh, "none")).toBe("off");

    const noReasoning = { ...noXhigh, reasoning: false };
    expect(resolveCloudThinkingLevel(noReasoning, "default")).toBe("off");
    expect(resolveCloudThinkingLevel(noReasoning, "high")).toBe("off");
  });
});
