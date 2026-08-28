import { describe, expect, test } from "bun:test";
import type { CloudExecutionSelection } from "@stella/contracts/agent-engine";
import type { Api, Model } from "@stella/runtime/ai/types.js";
import {
  CLOUD_MODEL_DIAGNOSTIC_SENTINELS,
  CLOUD_MODEL_PROXY_DIAGNOSTIC_HEADER,
} from "@stella/contracts/cloud-model-diagnostic";
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
        api: "openai-responses",
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

  test("classifies loopback, proxy, HTTP, and response failures without hostile detail", async () => {
    const originalFetch = globalThis.fetch;
    const secret = "credential-canary-never-surface";
    const managedExecution = {
      engine: "stella",
      provider: "stella",
      model: "stella/default",
      reasoningEffort: "default",
    } satisfies CloudExecutionSelection;
    const expectFailure = async (
      fetchImpl: typeof fetch,
      sentinel: string,
    ): Promise<void> => {
      globalThis.fetch = fetchImpl;
      const failure = await create(managedExecution).then(
        () => undefined,
        (error: unknown) => error,
      );
      expect(failure).toBeInstanceOf(Error);
      expect((failure as Error).message).toBe(sentinel);
      expect((failure as Error).message).not.toContain(secret);
    };

    try {
      await expectFailure(
        (async () => {
          throw new Error(secret);
        }) as unknown as typeof fetch,
        CLOUD_MODEL_DIAGNOSTIC_SENTINELS.model_loopback_connect,
      );
      await expectFailure(
        (async () => {
          const error = new Error(secret) as Error & { code: string };
          error.code = "ConnectionRefused";
          throw error;
        }) as unknown as typeof fetch,
        CLOUD_MODEL_DIAGNOSTIC_SENTINELS.model_loopback_refused,
      );
      await expectFailure(
        (async () => {
          throw new Error(secret, { cause: { code: "ETIMEDOUT" } });
        }) as unknown as typeof fetch,
        CLOUD_MODEL_DIAGNOSTIC_SENTINELS.model_loopback_timeout,
      );
      await expectFailure(
        (async () => {
          const error = new Error(secret) as Error & { code: string };
          error.code = "ENETUNREACH";
          throw error;
        }) as unknown as typeof fetch,
        CLOUD_MODEL_DIAGNOSTIC_SENTINELS.model_loopback_unreachable,
      );
      for (const [stage, sentinel] of [
        ["entered", CLOUD_MODEL_DIAGNOSTIC_SENTINELS.model_loopback_handler],
        [
          "broker_started",
          CLOUD_MODEL_DIAGNOSTIC_SENTINELS.model_loopback_broker,
        ],
        [
          "broker_responded",
          CLOUD_MODEL_DIAGNOSTIC_SENTINELS.model_loopback_response,
        ],
      ] as const) {
        globalThis.fetch = (async () => {
          throw new Error(secret);
        }) as unknown as typeof fetch;
        const failure = await createCloudRelayModel({
          siteUrl: "https://example.convex.site",
          turnToken: "opaque-turn-token",
          agentType: "general",
          execution: managedExecution,
          loopbackStage: () => stage,
        }).then(
          () => undefined,
          (error: unknown) => error,
        );
        expect((failure as Error).message).toBe(sentinel);
        expect((failure as Error).message).not.toContain(secret);
      }
      await expectFailure(
        (async () =>
          Response.json(
            { error: secret },
            {
              status: 502,
              headers: {
                [CLOUD_MODEL_PROXY_DIAGNOSTIC_HEADER]:
                  "model_broker_transport",
              },
            },
          )) as unknown as typeof fetch,
        CLOUD_MODEL_DIAGNOSTIC_SENTINELS.model_broker_transport,
      );
      await expectFailure(
        (async () =>
          Response.json({ error: secret }, { status: 502 })) as unknown as typeof fetch,
        CLOUD_MODEL_DIAGNOSTIC_SENTINELS.model_http_failure,
      );
      await expectFailure(
        (async () =>
          new Response(secret, { status: 200 })) as unknown as typeof fetch,
        CLOUD_MODEL_DIAGNOSTIC_SENTINELS.model_response_invalid,
      );
      await expectFailure(
        (async () =>
          Response.json({
            resolvedModel: secret,
            relayProvider: "hostile-provider",
          })) as unknown as typeof fetch,
        CLOUD_MODEL_DIAGNOSTIC_SENTINELS.model_response_invalid,
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("preserves an explicit caller abort", async () => {
    const originalFetch = globalThis.fetch;
    const controller = new AbortController();
    const reason = new Error("explicit turn cancellation");
    globalThis.fetch = (async (
      _input: string | URL | Request,
      init?: RequestInit,
    ) => {
      controller.abort(reason);
      throw init?.signal?.reason;
    }) as unknown as typeof fetch;
    try {
      const failure = await createCloudRelayModel({
        siteUrl: "https://example.convex.site",
        turnToken: "opaque-turn-token",
        agentType: "general",
        execution: {
          engine: "stella",
          provider: "stella",
          model: "stella/default",
          reasoningEffort: "default",
        },
        signal: controller.signal,
      }).then(
        () => undefined,
        (error: unknown) => error,
      );
      expect(failure).toBe(reason);
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

  test("accepts Crof and Wafer chat-completions routes returned by Stella", () => {
    for (const [relayProvider, resolvedModelId, requestedModel] of [
      [
        "crof",
        "crof/deepseek-v4-flash-0731",
        "stella/crof/deepseek-v4-flash-0731",
      ],
      [
        "wafer",
        "wafer/deepseek-v4-flash-0731-fast",
        "stella/wafer/deepseek-v4-flash-0731-fast",
      ],
    ] as const) {
      const model = createResolvedManagedRelayModel({
        execution: {
          engine: "stella",
          provider: "stella",
          model: requestedModel,
          reasoningEffort: "default",
        },
        siteUrl: "https://example.convex.site",
        turnToken: "opaque-turn-token",
        agentType: "general",
        resolvedModelId,
        relayProvider,
        api: "openai-completions",
      });

      expect(model.api).toBe("openai-completions");
      expect(model.id).toBe(requestedModel);
      expect(
        (model as Model<Api> & { upstreamModelId?: string }).upstreamModelId,
      ).toBe(resolvedModelId.slice(relayProvider.length + 1));
      expect(model.thinkingLevelMap).toMatchObject({
        minimal: "low",
        medium: "medium",
        xhigh: "high",
        off: "none",
      });
    }
  });

  test("maps Stella's xAI gateway prefix to the exact registry model", () => {
    const model = createResolvedManagedRelayModel({
      execution: {
        engine: "stella",
        provider: "stella",
        model: "stella/x-ai/grok-4.5",
        reasoningEffort: "minimal",
      },
      siteUrl: "https://example.convex.site",
      turnToken: "opaque-turn-token",
      agentType: "general",
      resolvedModelId: "x-ai/grok-4.5",
      relayProvider: "xai",
      api: "openai-responses",
    });

    expect(model.api).toBe("openai-responses");
    expect(model.contextWindow).toBe(500_000);
    expect(model.maxTokens).toBe(500_000);
    expect(model.thinkingLevelMap).toMatchObject({
      off: null,
      minimal: null,
    });
    expect(
      (model as Model<Api> & { upstreamModelId?: string }).upstreamModelId,
    ).toBe("grok-4.5");
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
