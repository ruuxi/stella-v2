import { describe, expect, test } from "bun:test";
import type { CloudExecutionSelection } from "@stella/contracts/agent-engine";
import type { Api, Model } from "@stella/runtime/ai/types.js";
import { CLOUD_MODEL_DIAGNOSTIC_SENTINELS } from "@stella/contracts/cloud-model-diagnostic";
import type { GatewayModelResolution } from "@stella/contracts/gateway/api";
import {
  CLOUD_LLM_CREDENTIAL_HEADER,
  createCloudRelayModel,
  createResolvedManagedRelayModel,
  parseGatewayModelResolution,
  resolveCloudThinkingLevel,
  validateCloudExecutionSelection,
} from "./relay-model.js";

const GATEWAY = "https://gateway.example.test";
const CAPABILITY = "eyJ.turn-capability.sig";

const managed = (
  model = "stella/default",
  reasoningEffort: CloudExecutionSelection["reasoningEffort"] = "default",
) =>
  ({
    engine: "stella",
    provider: "stella",
    model,
    reasoningEffort,
  }) satisfies CloudExecutionSelection;

const resolution = (
  overrides: Partial<GatewayModelResolution> = {},
): GatewayModelResolution => ({
  requestedModel: "stella/default",
  resolvedModel: "meta/muse-spark-1.2-contributor",
  provider: "openrouter",
  protocol: "openai-responses",
  reasoning: true,
  supportsImages: true,
  ...overrides,
});

type FakeGateway = {
  fetch: typeof fetch;
  calls: Array<{ url: string; init: RequestInit | undefined }>;
};

/** A fake `POST /v1/models/resolve` endpoint, injected as the model fetch. */
const fakeGateway = (
  respond: (body: unknown) => Response | Promise<Response>,
): FakeGateway => {
  const calls: FakeGateway["calls"] = [];
  const fetchImpl = (async (input, init) => {
    calls.push({ url: String(input), init });
    return await respond(init?.body ? JSON.parse(String(init.body)) : null);
  }) as typeof fetch;
  return { fetch: fetchImpl, calls };
};

const create = (
  execution: CloudExecutionSelection,
  gateway?: FakeGateway,
  extra: { signal?: AbortSignal } = {},
) =>
  createCloudRelayModel({
    gatewayOrigin: GATEWAY,
    capability: CAPABILITY,
    agentType: "general",
    execution,
    ...(gateway ? { fetch: gateway.fetch } : {}),
    ...extra,
  });

describe("cloud relay model selection", () => {
  test("resolves the opaque managed default through the gateway with the turn capability", async () => {
    const gateway = fakeGateway(() => Response.json(resolution()));
    const model = await create(managed(), gateway);

    expect(gateway.calls).toHaveLength(1);
    const call = gateway.calls[0]!;
    expect(call.url).toBe(`${GATEWAY}/v1/models/resolve`);
    expect(call.init?.method).toBe("POST");
    const headers = new Headers(call.init?.headers);
    expect(headers.get("authorization")).toBe(`Bearer ${CAPABILITY}`);
    expect(headers.get("x-stella-agent-type")).toBe("general");
    expect(headers.get("x-stella-turn-token")).toBeNull();
    expect(JSON.parse(String(call.init?.body))).toEqual({
      model: "stella/default",
      agentType: "general",
    });

    expect(model.id).toBe("stella/default");
    expect(model.api).toBe("openai-responses");
    expect(model.baseUrl).toBe(`${GATEWAY}/v1/relay`);
    expect(model.headers?.authorization).toBe(`Bearer ${CAPABILITY}`);
    expect(model.headers?.["x-stella-agent-type"]).toBe("general");
    expect(model.fetch).toBe(gateway.fetch);
    expect(
      (model as Model<Api> & { upstreamModelId?: string }).upstreamModelId,
    ).toBe("meta/muse-spark-1.2-contributor");
    expect(model.thinkingLevelMap).toMatchObject({ xhigh: "xhigh" });
  });

  test("uses the global fetch when no transport is injected", async () => {
    const originalFetch = globalThis.fetch;
    let capturedUrl = "";
    globalThis.fetch = (async (input) => {
      capturedUrl = String(input);
      return Response.json(resolution());
    }) as typeof fetch;
    try {
      const model = await create(managed());
      expect(capturedUrl).toBe(`${GATEWAY}/v1/models/resolve`);
      expect(model.fetch).toBeUndefined();
      expect(model.baseUrl).toBe(`${GATEWAY}/v1/relay`);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("maps every gateway protocol to the runtime adapter id", async () => {
    for (const [protocol, provider, resolvedModel] of [
      ["anthropic-messages", "anthropic", "anthropic/claude-sonnet-4-6"],
      ["openai-responses", "openai", "openai/gpt-5.6-sol"],
      ["openai-completions", "crof", "crof/deepseek-v4-flash-0731"],
      ["google-generative-ai", "google", "google/gemini-3.1-pro"],
    ] as const) {
      const execution = managed(`stella/${resolvedModel}`);
      const gateway = fakeGateway(() =>
        Response.json(
          resolution({
            requestedModel: execution.model,
            resolvedModel,
            provider,
            protocol,
          }),
        ),
      );
      const model = await create(execution, gateway);
      expect(model.api).toBe(protocol);
      expect(model.id).toBe(execution.model);
      expect(model.baseUrl).toBe(`${GATEWAY}/v1/relay`);
    }
  });

  test("classifies transport, HTTP, and response failures without hostile detail", async () => {
    const secret = "credential-canary-never-surface";
    const expectFailure = async (
      fetchImpl: typeof fetch,
      sentinel: string,
    ): Promise<void> => {
      const failure = await create(managed(), { fetch: fetchImpl, calls: [] }).then(
        () => undefined,
        (error: unknown) => error,
      );
      expect(failure).toBeInstanceOf(Error);
      expect((failure as Error).message).toBe(sentinel);
      expect((failure as Error).message).not.toContain(secret);
    };

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
    await expectFailure(
      (async () =>
        Response.json(
          { error: { code: "budget_exhausted", message: secret } },
          { status: 402 },
        )) as unknown as typeof fetch,
      CLOUD_MODEL_DIAGNOSTIC_SENTINELS.model_http_failure,
    );
    await expectFailure(
      (async () =>
        new Response(secret, { status: 200 })) as unknown as typeof fetch,
      CLOUD_MODEL_DIAGNOSTIC_SENTINELS.model_response_invalid,
    );
    await expectFailure(
      (async () =>
        Response.json(
          resolution({
            resolvedModel: secret,
            provider: "hostile-provider" as never,
          }),
        )) as unknown as typeof fetch,
      CLOUD_MODEL_DIAGNOSTIC_SENTINELS.model_response_invalid,
    );
    // The gateway pins turn capabilities to the admitted execution; a
    // resolution for a different alias is never trusted client-side either.
    await expectFailure(
      (async () =>
        Response.json(
          resolution({ requestedModel: "stella/other" }),
        )) as unknown as typeof fetch,
      CLOUD_MODEL_DIAGNOSTIC_SENTINELS.model_response_invalid,
    );
  });

  test("preserves an explicit caller abort", async () => {
    const controller = new AbortController();
    const reason = new Error("explicit turn cancellation");
    const gateway: FakeGateway = {
      calls: [],
      fetch: (async (_input: string | URL | Request, init?: RequestInit) => {
        controller.abort(reason);
        throw init?.signal?.reason;
      }) as unknown as typeof fetch,
    };
    const failure = await create(managed(), gateway, {
      signal: controller.signal,
    }).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(failure).toBe(reason);
  });

  test("rejects a malformed gateway origin or missing capability before any request", async () => {
    await expect(
      createCloudRelayModel({
        gatewayOrigin: "gateway.example.test",
        capability: CAPABILITY,
        agentType: "general",
        execution: managed(),
      }),
    ).rejects.toThrow("HTTP(S) URL");
    await expect(
      createCloudRelayModel({
        gatewayOrigin: GATEWAY,
        capability: "   ",
        agentType: "general",
        execution: managed(),
      }),
    ).rejects.toThrow("capability is required");
  });

  test("validates the resolve response shape strictly", () => {
    expect(parseGatewayModelResolution(resolution())).toEqual(resolution());
    expect(
      parseGatewayModelResolution(
        resolution({ contextWindow: 200_000, maxOutputTokens: 32_000 }),
      ),
    ).toMatchObject({ contextWindow: 200_000, maxOutputTokens: 32_000 });
    for (const broken of [
      null,
      [],
      "resolution",
      resolution({ protocol: "grpc" as never }),
      resolution({ provider: "hostile" as never }),
      resolution({ resolvedModel: "../etc/passwd" }),
      resolution({ contextWindow: -1 }),
      resolution({ reasoning: "yes" as never }),
    ]) {
      expect(parseGatewayModelResolution(broken)).toBeNull();
    }
  });

  test("uses gateway-resolved provider metadata for arbitrary Stella pins", () => {
    const openai = createResolvedManagedRelayModel({
      execution: managed("stella/openai/gpt-5.6-sol", "high"),
      resolution: resolution({
        requestedModel: "stella/openai/gpt-5.6-sol",
        resolvedModel: "openai/gpt-5.6-sol",
        provider: "openai",
        protocol: "openai-responses",
      }),
      gatewayOrigin: GATEWAY,
      capability: CAPABILITY,
      agentType: "general",
    });
    expect(openai.api).toBe("openai-responses");
    expect(openai.id).toBe("stella/openai/gpt-5.6-sol");
    expect(openai.baseUrl).toBe(`${GATEWAY}/v1/relay`);
    expect(openai.headers?.authorization).toBe(`Bearer ${CAPABILITY}`);
    expect(
      (openai as Model<Api> & { upstreamModelId?: string }).upstreamModelId,
    ).toBe("gpt-5.6-sol");

    const openrouter = createResolvedManagedRelayModel({
      execution: managed("stella/backend-owned-dynamic-alias", "medium"),
      resolution: resolution({
        requestedModel: "stella/backend-owned-dynamic-alias",
        resolvedModel: "openrouter/x-ai/grok-4.5",
        provider: "openrouter",
        protocol: "openai-completions",
      }),
      gatewayOrigin: GATEWAY,
      capability: CAPABILITY,
      agentType: "general",
    });
    expect(openrouter.api).toBe("openai-completions");
    expect(openrouter.id).toBe("stella/backend-owned-dynamic-alias");
    expect(
      (openrouter as Model<Api> & { upstreamModelId?: string })
        .upstreamModelId,
    ).toBe("openrouter/x-ai/grok-4.5");
  });

  test("accepts Crof and Wafer chat-completions routes returned by the gateway", () => {
    for (const [provider, resolvedModel, requestedModel] of [
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
        execution: managed(requestedModel),
        resolution: resolution({
          requestedModel,
          resolvedModel,
          provider,
          protocol: "openai-completions",
        }),
        gatewayOrigin: GATEWAY,
        capability: CAPABILITY,
        agentType: "general",
      });

      expect(model.api).toBe("openai-completions");
      expect(model.id).toBe(requestedModel);
      expect(
        (model as Model<Api> & { upstreamModelId?: string }).upstreamModelId,
      ).toBe(resolvedModel.slice(provider.length + 1));
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
      execution: managed("stella/x-ai/grok-4.5", "minimal"),
      resolution: resolution({
        requestedModel: "stella/x-ai/grok-4.5",
        resolvedModel: "x-ai/grok-4.5",
        provider: "xai",
        protocol: "openai-responses",
      }),
      gatewayOrigin: GATEWAY,
      capability: CAPABILITY,
      agentType: "general",
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

  test("prefers the gateway's declared limits over registry defaults", () => {
    const model = createResolvedManagedRelayModel({
      execution: managed("stella/openai/gpt-5.6-sol"),
      resolution: resolution({
        requestedModel: "stella/openai/gpt-5.6-sol",
        resolvedModel: "openai/gpt-5.6-sol",
        provider: "openai",
        protocol: "openai-responses",
        contextWindow: 123_456,
        maxOutputTokens: 4_321,
      }),
      gatewayOrigin: GATEWAY,
      capability: CAPABILITY,
      agentType: "general",
    });
    expect(model.contextWindow).toBe(123_456);
    expect(model.maxTokens).toBe(4_321);
  });

  test("keeps connected Anthropic pins on the Anthropic adapter against the gateway native lane", async () => {
    const gateway = fakeGateway(() => {
      throw new Error("subscriptions never resolve through the gateway");
    });
    const model = await create(
      {
        engine: "anthropic",
        provider: "anthropic",
        model: "claude-opus-4-6",
        reasoningEffort: "high",
      },
      gateway,
    );
    expect(gateway.calls).toHaveLength(0);
    expect(model.api).toBe("anthropic-messages");
    expect(model.id).toBe("stella/anthropic/claude-opus-4-6");
    expect(model.baseUrl).toBe(`${GATEWAY}/v1/relay`);
    expect(model.fetch).toBe(gateway.fetch);
    expect(model.headers?.[CLOUD_LLM_CREDENTIAL_HEADER]).toBe("anthropic");
    expect(model.headers?.authorization).toBe(`Bearer ${CAPABILITY}`);
    expect(model.headers?.["x-stella-agent-type"]).toBe("general");
    expect(model.headers?.["x-stella-turn-token"]).toBeUndefined();
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
    expect(model.baseUrl).toBe(`${GATEWAY}/v1/relay`);
    expect(model.headers?.[CLOUD_LLM_CREDENTIAL_HEADER]).toBe("openai-codex");
    expect(model.headers?.authorization).toBe(`Bearer ${CAPABILITY}`);
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
