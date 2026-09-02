import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createStellaRoute } from "@stella/runtime/kernel/model-routing-stella";
import {
  rememberStellaGatewayOrigin,
  resetGatewaySessionState,
} from "@stella/runtime/kernel/gateway-session";
import { streamSimple } from "@stella/runtime/ai/stream";
import { transformMessages } from "@stella/runtime/ai/providers/transform-messages";
import type { Context, Message, Model } from "@stella/runtime/ai/types";

/**
 * Wire-shape integration tests for the Stella model-gateway path.
 *
 * For each upstream provider, we:
 *   1. Build a route via `createStellaRoute` and assert the gateway relay
 *      `baseUrl` + provider + api the adapter will dispatch on.
 *   2. (Anthropic, Google, Responses) Stub `fetch`, invoke `streamSimple`,
 *      and assert the adapter targets the relay path with
 *      `Authorization: Bearer <session capability>` (NOT `x-api-key` /
 *      `x-goog-api-key`), `stream: false`, and a per-request
 *      `x-stella-request-id`. That's the load-bearing part of the
 *      baseUrl-based gateway detection; if it ever regresses, every relayed
 *      request 401s at the gateway or is rejected as `stream_unsupported`.
 */

const STELLA_SITE = "https://stella.example.test";
const GATEWAY = "https://gateway.example.test";
const RELAY = `${GATEWAY}/v1/relay`;
const STELLA_TOKEN = "stella-jwt";
const CAPABILITY = "session-capability-jwt";

const site = {
  baseUrl: STELLA_SITE,
  getAuthToken: () => STELLA_TOKEN,
};

const makeRoute = (modelId: string) =>
  createStellaRoute({
    site,
    agentType: "general",
    modelId,
  });

const userContext = (text: string): Context => ({
  messages: [
    {
      role: "user",
      content: text,
      timestamp: 0,
    },
  ],
});

const jsonResponse = (body: unknown) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

// Bun's vitest-compatible runner doesn't implement `vi.stubGlobal`, so we
// install/restore `globalThis.fetch` by hand. Vitest also runs this fine.
type CapturedCall = { url: string; init?: RequestInit; headers: Headers };

const originalFetch: typeof fetch = globalThis.fetch;

/**
 * Stubs fetch for the whole gateway conversation: the session capability
 * exchange answers with a fixed capability, every other call gets the
 * provided provider-native response.
 */
const captureRequest = (response: () => Response): CapturedCall[] => {
  const calls: CapturedCall[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;
    const headers =
      init?.headers instanceof Headers
        ? init.headers
        : new Headers(init?.headers as HeadersInit | undefined);
    calls.push({ url, init, headers });
    if (url === `${GATEWAY}/v1/capabilities/session`) {
      return jsonResponse({
        capability: CAPABILITY,
        expiresAt: Date.now() + 60 * 60 * 1000,
        audience: "pro",
        budgetMicroCents: -1,
      });
    }
    return response();
  }) as typeof fetch;
  return calls;
};

beforeEach(() => {
  rememberStellaGatewayOrigin(STELLA_SITE, GATEWAY);
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  resetGatewaySessionState();
  vi.restoreAllMocks();
});

describe("Stella gateway route shape", () => {
  for (const exhaustion of [
    { status: 402, code: "budget_exhausted" },
    { status: 429, code: "request_limit" },
  ]) {
    it(`re-exchanges and retries once after ${exhaustion.code}`, async () => {
      const calls: Array<{
        url: string;
        authorization: string | null;
        requestId: string | null;
        body: string;
      }> = [];
      let capabilityNumber = 0;
      globalThis.fetch = (async (
        input: RequestInfo | URL,
        init?: RequestInit,
      ) => {
        const request = new Request(input, init);
        const body = await request.clone().text();
        calls.push({
          url: request.url,
          authorization: request.headers.get("authorization"),
          requestId: request.headers.get("x-stella-request-id"),
          body,
        });
        if (request.url.endsWith("/v1/capabilities/session")) {
          capabilityNumber += 1;
          return jsonResponse({
            capability: `capability-${capabilityNumber}`,
            expiresAt: Date.now() + 60 * 60 * 1000,
            audience: "pro",
            budgetMicroCents: 1,
          });
        }
        const relayCalls = calls.filter((call) =>
          call.url.includes("/v1/relay/"),
        );
        return relayCalls.length === 1
          ? new Response(
              JSON.stringify({
                error: {
                  code: exhaustion.code,
                  message: "capability spent",
                  retryable: false,
                },
              }),
              {
                status: exhaustion.status,
                headers: { "content-type": "application/json" },
              },
            )
          : jsonResponse({ ok: true });
      }) as typeof fetch;

      const route = makeRoute("stella/openai/gpt-5.5")!;
      const firstCapability = await route.getApiKey();
      const response = await route.model.fetch!(`${RELAY}/responses`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${firstCapability}`,
          "content-type": "application/json",
          "x-stella-request-id": "request-stable",
        },
        body: JSON.stringify({ model: "stella/openai/gpt-5.5" }),
      });

      expect(response.ok).toBe(true);
      const exchanges = calls.filter((call) =>
        call.url.endsWith("/v1/capabilities/session"),
      );
      const relays = calls.filter((call) => call.url.includes("/v1/relay/"));
      expect(exchanges).toHaveLength(2);
      expect(relays.map((call) => call.authorization)).toEqual([
        "Bearer capability-1",
        "Bearer capability-2",
      ]);
      expect(relays.map((call) => call.requestId)).toEqual([
        "request-stable",
        "request-stable",
      ]);
      expect(relays[1]!.body).toBe(relays[0]!.body);
    });
  }

  it("Anthropic: baseUrl, api, provider, headers", () => {
    const route = makeRoute("stella/anthropic/claude-opus-4.7");
    expect(route).not.toBeNull();
    const model = route!.model;
    expect(model.api).toBe("anthropic-messages");
    expect(model.provider).toBe("anthropic");
    expect(model.id).toBe("stella/anthropic/claude-opus-4.7");
    expect(model.baseUrl).toBe(RELAY);
    expect(model.headers).toMatchObject({ "X-Stella-Agent-Type": "general" });
    expect(model.headers).not.toHaveProperty("X-Stella-Relay");
  });

  it("OpenAI: baseUrl, api, provider", () => {
    const route = makeRoute("stella/openai/gpt-5.5");
    const model = route!.model;
    expect(model.api).toBe("openai-responses");
    expect(model.provider).toBe("openai");
    expect(model.baseUrl).toBe(RELAY);
  });

  it("Google: baseUrl, api, provider", () => {
    const route = makeRoute("stella/google/gemini-3-flash-preview");
    const model = route!.model;
    expect(model.api).toBe("google-generative-ai");
    expect(model.provider).toBe("google");
    expect(model.baseUrl).toBe(RELAY);
  });

  it("Fireworks: baseUrl, api, provider", () => {
    const route = makeRoute("stella/accounts/fireworks/models/kimi-k2p6");
    const model = route!.model;
    expect(model.api).toBe("openai-responses");
    expect(model.provider).toBe("fireworks");
    expect(model.baseUrl).toBe(RELAY);
  });

  it("falls back to an unresolvable relay until the catalog advertises the gateway", () => {
    resetGatewaySessionState();
    const route = makeRoute("stella/openai/gpt-5.5");
    expect(route!.model.baseUrl).toBe(
      "https://model-gateway.unconfigured.invalid/v1/relay",
    );
    // The capability exchange fails closed too: no origin, no credential.
    return expect(route!.getApiKey()).rejects.toThrow(
      /model gateway is not configured/i,
    );
  });

  it("creates a Stella route when auth is refreshable but not loaded yet", async () => {
    const calls = captureRequest(() => jsonResponse({}));
    const route = createStellaRoute({
      site: {
        baseUrl: STELLA_SITE,
        getAuthToken: () => null,
        hasConnectedAccount: () => true,
        refreshAuthToken: () => STELLA_TOKEN,
      },
      agentType: "general",
      modelId: "stella/standard",
    });

    expect(route).not.toBeNull();
    // The Better Auth JWT is exchanged for a session capability; the JWT
    // itself never becomes the model request credential.
    expect(await route!.getApiKey()).toBe(CAPABILITY);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(`${GATEWAY}/v1/capabilities/session`);
    expect(calls[0]!.headers.get("authorization")).toBe(
      `Bearer ${STELLA_TOKEN}`,
    );
  });

  it("does not create a refresh-only route for signed-out users", () => {
    const route = createStellaRoute({
      site: {
        baseUrl: STELLA_SITE,
        getAuthToken: () => null,
        hasConnectedAccount: () => false,
        refreshAuthToken: () => STELLA_TOKEN,
      },
      agentType: "general",
      modelId: "stella/standard",
    });

    expect(route).toBeNull();
  });

  it("does not assume refresh-only auth is available without account state", () => {
    const route = createStellaRoute({
      site: {
        baseUrl: STELLA_SITE,
        getAuthToken: () => null,
        refreshAuthToken: () => STELLA_TOKEN,
      },
      agentType: "general",
      modelId: "stella/standard",
    });

    expect(route).toBeNull();
  });

  it("OpenRouter: baseUrl, api, provider", () => {
    const route = makeRoute("stella/moonshotai/kimi-k2");
    const model = route!.model;
    expect(model.api).toBe("openai-completions");
    expect(model.provider).toBe("openrouter");
    expect(model.baseUrl).toBe(RELAY);
  });

  it("DeepSeek uses the Responses API against the deepseek provider", () => {
    const route = makeRoute("stella/deepseek/deepseek-v4-flash");
    const model = route!.model;
    expect(model.api).toBe("openai-responses");
    expect(model.provider).toBe("deepseek");
    expect(
      (model as typeof model & { upstreamModelId?: string }).upstreamModelId,
    ).toBe("deepseek-v4-flash");
    expect(model.baseUrl).toBe(RELAY);
  });

  it("retired Stella aliases resolve to the Muse route", () => {
    const route = makeRoute("stella/designer");
    const model = route!.model;
    expect(model.api).toBe("openai-responses");
    expect(model.provider).toBe("openrouter");
    expect(
      (model as typeof model & { upstreamModelId?: string }).upstreamModelId,
    ).toBe("meta/muse-spark-1.2-contributor");
    expect(model.baseUrl).toBe(RELAY);
  });

  it("Stella alias (light) resolves to the Muse route", () => {
    const route = makeRoute("stella/light");
    const model = route!.model;
    expect(model.api).toBe("openai-responses");
    expect(model.provider).toBe("openrouter");
    expect(
      (model as typeof model & { upstreamModelId?: string }).upstreamModelId,
    ).toBe("meta/muse-spark-1.2-contributor");
    expect(model.baseUrl).toBe(RELAY);
  });

  it("Stella default resolves to Muse Spark 1.2 Contributor on OpenRouter", () => {
    const route = makeRoute("stella/default");
    const model = route!.model;
    expect(model.provider).toBe("openrouter");
    expect(model.api).toBe("openai-responses");
    expect(
      (model as typeof model & { upstreamModelId?: string }).upstreamModelId,
    ).toBe("meta/muse-spark-1.2-contributor");
    expect(model.baseUrl).toBe(RELAY);
  });

  it("Muse route: Responses transport keeps xhigh effort", () => {
    const route = makeRoute("stella/default");
    const model = route!.model;
    // xhigh is Stella's default rung for Muse; the model's thinkingLevelMap
    // must keep it from being clamped to high by the Responses adapter.
    expect(model.thinkingLevelMap).toMatchObject({ xhigh: "xhigh" });
  });

  it("the explicit DeepSeek V4 Flash pick still routes to the CrofAI provider", () => {
    // The previous default stays fully routable: its canonical CrofAI id
    // keeps the CrofAI completions transport and effort ladder.
    const route = makeRoute("stella/crof/deepseek-v4-flash-0731");
    const model = route!.model;
    expect(model.api).toBe("openai-completions");
    expect(model.provider).toBe("crof");
    expect(
      (model as typeof model & { upstreamModelId?: string }).upstreamModelId,
    ).toBe("deepseek-v4-flash-0731");
    // CrofAI accepts none | low | medium | high.
    expect(model.thinkingLevelMap).toMatchObject({
      minimal: "low",
      low: "low",
      medium: "medium",
      high: "high",
      xhigh: "high",
      off: "none",
    });
  });

  it("the Wafer Fast variant routes to the Wafer provider", () => {
    const route = makeRoute("stella/wafer/deepseek-v4-flash-0731-fast");
    const model = route!.model;
    expect(model.api).toBe("openai-completions");
    expect(model.provider).toBe("wafer");
    expect(
      (model as typeof model & { upstreamModelId?: string }).upstreamModelId,
    ).toBe("deepseek-v4-flash-0731-fast");
    // Wafer shares CrofAI's effort ladder via the gateway's body normalization.
    expect(model.thinkingLevelMap).toMatchObject({
      minimal: "low",
      low: "low",
      medium: "medium",
      high: "high",
      xhigh: "high",
      off: "none",
    });
  });

  it("Stella standard compatibility alias resolves to the Muse route", () => {
    const route = makeRoute("stella/standard");
    const model = route!.model;
    expect(model.api).toBe("openai-responses");
    expect(model.provider).toBe("openrouter");
    expect(
      (model as typeof model & { upstreamModelId?: string }).upstreamModelId,
    ).toBe("meta/muse-spark-1.2-contributor");
    expect(model.baseUrl).toBe(RELAY);
  });

  it("the retained Fireworks spelling still routes to the Fireworks provider", () => {
    // Rollback safety: flipping DEEPSEEK_V4_FLASH_ROUTE back must not need a
    // client change, so the client still knows how to route this id.
    const route = makeRoute(
      "stella/accounts/fireworks/models/deepseek-v4-flash-0731",
    );
    const model = route!.model;
    expect(model.api).toBe("openai-responses");
    expect(model.provider).toBe("fireworks");
  });
});

describe("Stella gateway auth (baseUrl-based detection)", () => {
  it("Anthropic adapter sends Authorization: Bearer <capability> to the gateway (not x-api-key), non-streaming", async () => {
    const calls = captureRequest(() =>
      jsonResponse({
        id: "msg_1",
        type: "message",
        role: "assistant",
        model: "claude-opus-4.7",
        content: [{ type: "text", text: "hi there" }],
        stop_reason: "end_turn",
        stop_sequence: null,
        usage: { input_tokens: 3, output_tokens: 2 },
      }),
    );

    const route = makeRoute("stella/anthropic/claude-opus-4.7")!;
    const apiKey = (await route.getApiKey()) ?? "";
    expect(apiKey).toBe(CAPABILITY);

    const result = await streamSimple(route.model, userContext("hi"), {
      apiKey,
      maxTokens: 8,
    }).result();
    expect(result.stopReason).toBe("stop");
    expect(result.content).toEqual([{ type: "text", text: "hi there" }]);

    const messagesCall = calls.find((c) => c.url.endsWith("/messages"));
    expect(
      messagesCall,
      `expected POST to /messages, got URLs: ${calls.map((c) => c.url).join(", ")}`,
    ).toBeDefined();
    // The Anthropic SDK appends `/v1/messages` to the neutral relay prefix.
    // The gateway resolves the upstream provider from the model.
    expect(messagesCall!.url).toBe(`${RELAY}/v1/messages`);
    expect(messagesCall!.headers.get("authorization")).toBe(
      `Bearer ${CAPABILITY}`,
    );
    expect(messagesCall!.headers.get("x-api-key")).toBeNull();
    expect(messagesCall!.headers.get("x-stella-agent-type")).toBe("general");
    expect(messagesCall!.headers.get("x-stella-request-id")).toMatch(
      /^[0-9a-f-]{36}$/u,
    );
    const body = JSON.parse(String(messagesCall!.init?.body)) as Record<
      string,
      unknown
    >;
    expect(body.stream).toBe(false);
  });

  it("Google adapter forwards Authorization: Bearer <capability> and calls generateContent", async () => {
    const calls = captureRequest(() =>
      jsonResponse({
        responseId: "resp_g",
        candidates: [
          {
            content: { role: "model", parts: [{ text: "hi" }] },
            finishReason: "STOP",
          },
        ],
        modelVersion: "gemini-3-flash-preview",
        usageMetadata: {
          promptTokenCount: 1,
          candidatesTokenCount: 1,
          totalTokenCount: 2,
        },
      }),
    );

    const route = makeRoute("stella/google/gemini-3-flash-preview")!;
    const apiKey = (await route.getApiKey()) ?? "";

    const result = await streamSimple(route.model, userContext("hi"), {
      apiKey,
      maxTokens: 8,
    }).result();
    expect(result.stopReason).toBe("stop");
    expect(result.content).toEqual([{ type: "text", text: "hi" }]);

    const relayCall = calls.find((c) => c.url.startsWith(`${RELAY}/`));
    expect(
      relayCall,
      `expected POST to the gateway relay, got URLs: ${calls
        .map((c) => c.url)
        .join(", ")}`,
    ).toBeDefined();
    expect(relayCall!.url).toContain(":generateContent");
    expect(relayCall!.url).not.toContain(":streamGenerateContent");
    expect(relayCall!.headers.get("authorization")).toBe(
      `Bearer ${CAPABILITY}`,
    );
    expect(relayCall!.headers.get("x-stella-request-id")).toMatch(
      /^[0-9a-f-]{36}$/u,
    );
  });
});

describe("Stella Muse Responses transport", () => {
  it("posts the default model to responses with xhigh reasoning and parses usage", async () => {
    const calls = captureRequest(() =>
      jsonResponse({
        id: "resp_muse",
        object: "response",
        created_at: 1,
        status: "completed",
        model: "meta/muse-spark-1.2-contributor",
        error: null,
        incomplete_details: null,
        output: [
          {
            type: "message",
            id: "msg_1",
            role: "assistant",
            status: "completed",
            content: [{ type: "output_text", text: "hello", annotations: [] }],
          },
        ],
        usage: {
          input_tokens: 11,
          output_tokens: 7,
          total_tokens: 18,
          input_tokens_details: { cached_tokens: 0 },
          output_tokens_details: { reasoning_tokens: 5 },
        },
      }),
    );

    const route = makeRoute("stella/default")!;
    const apiKey = (await route.getApiKey()) ?? "";
    const result = await streamSimple(route.model, userContext("hi"), {
      apiKey,
      maxTokens: 2048,
      reasoning: "xhigh",
    }).result();

    expect(result.stopReason).toBe("stop");
    expect(result.content).toEqual([
      { type: "text", text: "hello", textSignature: '{"v":1,"id":"msg_1"}' },
    ]);
    expect(result.usage).toMatchObject({
      input: 11,
      output: 7,
      reasoning: 5,
      totalTokens: 18,
    });

    const call = calls.find((c) => c.url.startsWith(`${RELAY}/`));
    expect(call).toBeDefined();
    expect(call!.url).toBe(`${RELAY}/responses`);
    expect(call!.headers.get("authorization")).toBe(`Bearer ${CAPABILITY}`);
    const body = JSON.parse(String(call!.init?.body));
    expect(body.model).toBe("stella/default");
    expect(body.stream).toBe(false);
    expect(body.input).toEqual([
      { role: "user", content: [{ type: "input_text", text: "hi" }] },
    ]);
    expect(body.max_output_tokens).toBe(2048);
    expect(body.reasoning).toMatchObject({ effort: "xhigh" });
  });
});

describe("transformMessages: orphan tool_result filter", () => {
  it("drops tool_results whose tool_use does not appear in any preceding assistant message", () => {
    const messages: Message[] = [
      {
        role: "user",
        content: "go",
        timestamp: 0,
      },
      {
        role: "toolResult",
        toolCallId: "toolu_orphan",
        toolName: "ghost",
        content: [{ type: "text", text: "stale result" }],
        isError: false,
        timestamp: 1,
      },
      {
        role: "user",
        content: "again",
        timestamp: 2,
      },
    ];

    const model: Model<"anthropic-messages"> = {
      id: "claude-opus-4.7",
      name: "Claude Opus 4.7",
      api: "anthropic-messages",
      provider: "anthropic",
      baseUrl: "https://api.anthropic.com",
      reasoning: true,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 256_000,
      maxTokens: 16_384,
    };

    const out = transformMessages(messages, model);
    expect(out.some((m) => m.role === "toolResult")).toBe(false);
  });

  it("keeps tool_results paired with a preceding assistant tool_use", () => {
    const messages: Message[] = [
      {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "toolu_pair",
            name: "echo",
            arguments: { text: "hi" },
          },
        ],
        timestamp: 0,
        stopReason: "toolUse",
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        api: "anthropic-messages",
        provider: "anthropic",
        model: "claude-opus-4.7",
      },
      {
        role: "toolResult",
        toolCallId: "toolu_pair",
        toolName: "echo",
        content: [{ type: "text", text: "hi" }],
        isError: false,
        timestamp: 1,
      },
    ];

    const model: Model<"anthropic-messages"> = {
      id: "claude-opus-4.7",
      name: "Claude Opus 4.7",
      api: "anthropic-messages",
      provider: "anthropic",
      baseUrl: "https://api.anthropic.com",
      reasoning: true,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 256_000,
      maxTokens: 16_384,
    };

    const out = transformMessages(messages, model);
    expect(out.filter((m) => m.role === "toolResult")).toHaveLength(1);
  });
});
