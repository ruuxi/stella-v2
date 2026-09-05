import { registerCloudApiProviders } from "@stella/runtime/ai/providers/register-cloud.js";
registerCloudApiProviders();
import { GATEWAY_MODEL_REVISION_HEADER, GATEWAY_MODEL_RESOLUTION_HEADER } from "@stella/contracts/gateway/api";
import { describe, expect, test } from "bun:test";
import type { CloudExecutionSelection } from "@stella/contracts/agent-engine";
import type { Api, Model } from "@stella/runtime/ai/types.js";
import { CLOUD_MODEL_DIAGNOSTIC_SENTINELS } from "@stella/contracts/cloud-model-diagnostic";
import type { GatewayModelResolution } from "@stella/contracts/gateway/api";
import {
  STELLA_DEFAULT_UPSTREAM_MODEL,
  STELLA_DEEPSEEK_V4_FLASH_UPSTREAM_MODEL,
  STELLA_WAFER_V4_FLASH_FAST_UPSTREAM_MODEL,
} from "@stella/contracts/stella-api";
import { loadModelRegistry } from "@stella/contracts/model-registry";
import { findRegistryModel } from "@stella/runtime/kernel/model-routing-matching.js";
import {
  CLOUD_LLM_CREDENTIAL_HEADER,
  createCloudRelayModel,
  createCloudRelaySession,
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
  resolvedModel: "meta/muse-spark-1.3-contributor",
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
    ).toBe("meta/muse-spark-1.3-contributor");
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

  test("registry-independent managed descriptors have no generated registry row", async () => {
    await loadModelRegistry();
    for (const descriptor of [
      {
        provider: "openrouter",
        requestedModel: "stella/default",
        resolvedModel: STELLA_DEFAULT_UPSTREAM_MODEL,
        protocol: "openai-responses",
        expectedInput: ["text"],
        expectedThinkingLevelMap: { xhigh: "xhigh" },
      },
      {
        provider: "crof",
        requestedModel: "stella/crof/deepseek-v4-flash-0731",
        resolvedModel: STELLA_DEEPSEEK_V4_FLASH_UPSTREAM_MODEL,
        protocol: "openai-completions",
        expectedInput: ["text"],
        expectedThinkingLevelMap: {
          minimal: "low",
          medium: "medium",
          xhigh: "high",
          off: "none",
        },
      },
      {
        provider: "wafer",
        requestedModel: "stella/wafer/deepseek-v4-flash-0731-fast",
        resolvedModel: STELLA_WAFER_V4_FLASH_FAST_UPSTREAM_MODEL,
        protocol: "openai-completions",
        expectedInput: ["text"],
        expectedThinkingLevelMap: {
          minimal: "low",
          medium: "medium",
          xhigh: "high",
          off: "none",
        },
      },
    ] as const) {
      const nativeModelId =
        descriptor.provider === "openrouter"
          ? descriptor.resolvedModel
          : descriptor.resolvedModel.slice(descriptor.provider.length + 1);
      expect(
        findRegistryModel(descriptor.provider, [
          descriptor.resolvedModel,
          nativeModelId,
          nativeModelId.replace(/\./g, "-"),
        ]),
      ).toBeNull();

      const model = createResolvedManagedRelayModel({
        execution: managed(descriptor.requestedModel),
        resolution: resolution({
          requestedModel: descriptor.requestedModel,
          resolvedModel: descriptor.resolvedModel,
          provider: descriptor.provider,
          protocol: descriptor.protocol,
          supportsImages: false,
        }),
        gatewayOrigin: GATEWAY,
        capability: CAPABILITY,
        agentType: "general",
      });
      expect([...model.input]).toEqual([...descriptor.expectedInput]);
      expect(model.reasoning).toBe(true);
      expect(model.thinkingLevelMap).toMatchObject(
        descriptor.expectedThinkingLevelMap,
      );
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

describe("turn-local validated relay sessions", () => {
  test("skips resolution and sends the predicted descriptor revision on inference", async () => {
    const calls: Request[] = [];
    const session = await createCloudRelaySession({ gatewayOrigin: GATEWAY,
      capability: CAPABILITY, agentType: "orchestrator", execution: managed(), audience: "pro",
      fetch: Object.assign(async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
        calls.push((input instanceof Request ? new Request(input, init) : new Request(input.toString(), init)));
        return Response.json({ id: "resp_1", object: "response", status: "completed", model: "meta/muse-spark-1.3-contributor",
          output: [{ type: "message", id: "msg_1", role: "assistant", status: "completed", content: [{ type: "output_text", text: "hello", annotations: [] }] }],
          usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } });
      }, fetch),
    });
    expect(calls).toHaveLength(0);
    const stream = await session.createStreamFn({ reasoningEffort: "none" })(session.model,
      { messages: [{ role: "user", content: "hello", timestamp: 1 }] }, { apiKey: CAPABILITY });
    const result = await stream.result();
    expect(result.errorMessage).toBeUndefined();
    expect(result.stopReason).toBe("stop");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.headers.get(GATEWAY_MODEL_REVISION_HEADER)).toMatch(/^v1:[a-f0-9]{64}$/);
    expect(calls[0]!.url).not.toContain("/resolve");
  });

  test("rebuilds protocol and context once from raw messages after a pre-provider mismatch", async () => {
    const alias = "stella/crof/deepseek-v4-flash-0731";
    const current = resolution({ requestedModel: alias, resolvedModel: "anthropic/claude-sonnet-4-6",
      provider: "anthropic", protocol: "anthropic-messages", contextWindow: 123456, maxOutputTokens: 8192 });
    const requests: Request[] = [];
    const bodies: unknown[] = [];
    const raw = { messages: [{ role: "user" as const, content: [
      { type: "text" as const, text: "keep this original text" },
      { type: "image" as const, data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aC3sAAAAASUVORK5CYII=", mimeType: "image/png" },
    ], timestamp: 1 }] };
    const transformed: Array<{ contextWindow: number; input: string[] }> = [];
    const session = await createCloudRelaySession({ gatewayOrigin: GATEWAY, capability: CAPABILITY,
      agentType: "orchestrator", execution: managed(alias, "high"), audience: "pro",
      fetch: Object.assign(async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
        const request = (input instanceof Request ? new Request(input, init) : new Request(input.toString(), init));
        requests.push(request);
        bodies.push(await request.json());
        if (requests.length === 1) return Response.json({ error: { code: "model_revision_mismatch", message: "changed" } },
          { status: 409, headers: { "x-should-retry": "false", [GATEWAY_MODEL_RESOLUTION_HEADER]: encodeURIComponent(JSON.stringify(current)) } });
        return Response.json({ id: "msg_2", type: "message", role: "assistant", model: "claude-sonnet-4-6",
          content: [{ type: "text", text: "hello" }], stop_reason: "end_turn", stop_sequence: null,
          usage: { input_tokens: 1, output_tokens: 1 } });
      }, fetch),
    });
    const stream = await session.createStreamFn({ reasoningEffort: "high", transformContext: async (model, context) => {
      expect(context).toBe(raw);
      transformed.push({ contextWindow: model.contextWindow, input: [...model.input] });
      return model.api === "anthropic-messages" ? context
        : { ...context, messages: [{ role: "user", content: "pruned first attempt", timestamp: 1 }] };
    } })(session.model, raw, { apiKey: CAPABILITY });
    const events = [];
    for await (const event of stream) events.push(event);
    const completed = await stream.result();
    expect(completed.errorMessage).toBeUndefined();
    expect(completed.stopReason).toBe("stop");
    expect(requests).toHaveLength(2);
    expect(requests[0]!.url).toContain("/chat/completions");
    expect(requests[1]!.url).toContain("/messages");
    expect(JSON.stringify(bodies[1])).toContain("keep this original text");
    expect(JSON.stringify(bodies[1])).toContain("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aC3sAAAAASUVORK5CYII=");
    expect(JSON.stringify(bodies[1])).toContain('"thinking"');
    expect(transformed[1]).toEqual({ contextWindow: 123456, input: ["text", "image"] });
    expect(events.some(event => event.type === "error")).toBe(false);
    expect(session.model.api).toBe("anthropic-messages");
  });

  test("limits repeated descriptor mismatches and does not retry cancellation", async () => {
    for (const cancel of [false, true]) {
      const controller = new AbortController();
      let calls = 0;
      const session = await createCloudRelaySession({ gatewayOrigin: GATEWAY, capability: CAPABILITY,
        agentType: "orchestrator", execution: managed(), audience: "pro", signal: controller.signal,
        fetch: Object.assign(async () => {
          calls += 1;
          if (cancel) controller.abort();
          return Response.json({ error: { code: "model_revision_mismatch", message: "changed" } }, { status: 409,
            headers: { "x-should-retry": "false", [GATEWAY_MODEL_RESOLUTION_HEADER]: encodeURIComponent(JSON.stringify(resolution())) } });
        }, fetch),
      });
      const stream = await session.createStreamFn({ reasoningEffort: "none" })(session.model,
        { messages: [{ role: "user", content: "hello", timestamp: 1 }] }, { apiKey: CAPABILITY });
      expect((await stream.result()).stopReason).toBe(cancel ? "aborted" : "error");
      expect(calls).toBe(cancel ? 1 : 2);
    }
  });
});

test("older gateways refuse the versioned route before resolution and legacy inference fallback", async () => {
  const urls: string[] = [];
  const session = await createCloudRelaySession({ gatewayOrigin: GATEWAY, capability: CAPABILITY,
    agentType: "orchestrator", execution: managed(), audience: "pro",
    fetch: Object.assign(async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      const request = (input instanceof Request ? new Request(input, init) : new Request(input.toString(), init));
      urls.push(request.url);
      if (request.url.includes("/v2/relay/")) return Response.json({ error: { code: "bad_request", message: "Not found." } }, { status: 404 });
      if (request.url.endsWith("/resolve")) return Response.json(resolution());
      expect(request.headers.has(GATEWAY_MODEL_REVISION_HEADER)).toBe(false);
      return Response.json({ id: "resp_1", object: "response", status: "completed", model: "meta/muse-spark-1.3-contributor",
        output: [{ type: "message", id: "msg_1", role: "assistant", status: "completed", content: [{ type: "output_text", text: "hello", annotations: [] }] }],
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } });
    }, fetch),
  });
  const stream = await session.createStreamFn({ reasoningEffort: "none" })(session.model,
    { messages: [{ role: "user", content: "hello", timestamp: 1 }] }, { apiKey: CAPABILITY });
  expect((await stream.result()).stopReason).toBe("stop");
  expect(urls).toEqual([`${GATEWAY}/v2/relay/responses`, `${GATEWAY}/v1/models/resolve`, `${GATEWAY}/v1/relay/responses`]);
});

test("connected subscriptions keep their original adapter and context transformation", async () => {
  let transformations = 0;
  let sends = 0;
  const session = await createCloudRelaySession({ gatewayOrigin: GATEWAY, capability: CAPABILITY,
    agentType: "orchestrator", audience: "pro",
    execution: { engine: "anthropic", provider: "anthropic", model: "claude-sonnet-4-6", reasoningEffort: "none" },
    fetch: Object.assign(async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      sends += 1;
      const request = (input instanceof Request ? new Request(input, init) : new Request(input.toString(), init));
      expect(request.url).toContain("/v1/relay/");
      expect(request.headers.has(GATEWAY_MODEL_REVISION_HEADER)).toBe(false);
      expect(JSON.stringify(await request.json())).toContain("transformed native context");
      return Response.json({ id: "msg_2", type: "message", role: "assistant", model: "claude-sonnet-4-6",
        content: [{ type: "text", text: "hello" }], stop_reason: "end_turn", stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 1 } });
    }, fetch),
  });
  const stream = await session.createStreamFn({ reasoningEffort: "none", transformContext: async (_model, context) => {
    transformations += 1;
    return { ...context, messages: [{ role: "user", content: "transformed native context", timestamp: 1 }] };
  } })(session.model, { messages: [{ role: "user", content: "untransformed", timestamp: 1 }] }, { apiKey: CAPABILITY });
  expect((await stream.result()).stopReason).toBe("stop");
  expect(transformations).toBe(1);
  expect(sends).toBe(1);
});

test("cancellation during a context transform prevents inference", async () => {
  const controller = new AbortController();
  let sends = 0;
  const session = await createCloudRelaySession({ gatewayOrigin: GATEWAY, capability: CAPABILITY,
    agentType: "orchestrator", execution: managed(), audience: "pro", signal: controller.signal,
    fetch: Object.assign(async () => { sends += 1; return new Response(); }, fetch),
  });
  const stream = await session.createStreamFn({ reasoningEffort: "none", transformContext: async (_model, context) => {
    controller.abort(); return context;
  } })(session.model, { messages: [{ role: "user", content: "hello", timestamp: 1 }] }, { apiKey: CAPABILITY });
  expect((await stream.result()).stopReason).toBe("aborted");
  expect(sends).toBe(0);
});
