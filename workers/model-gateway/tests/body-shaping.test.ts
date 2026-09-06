import { describe, expect, test } from "bun:test";
import type { GatewayProtocol } from "@stella/contracts/gateway/api";
import type { ManagedGatewayProvider } from "@stella/model-catalog/managed-gateway";
import { toProviderNativeModel } from "@stella/model-catalog/request-shaping";
import { resolveManagedModelDescriptor } from "@stella/model-catalog/gateway-resolution";
import {
  clampOutputTokens,
  shapeUpstreamRequest,
} from "../src/managed-lane.js";
import type { ManagedRoute } from "../src/resolve.js";

/**
 * Parity with the legacy Convex relay for the shaping cases that still apply:
 * the gateway hands `@stella/model-catalog` the same inputs the relay did and
 * forces streaming on top. Routes are constructed directly so providers the
 * alias catalog does not currently expose (DeepSeek direct, Anthropic) are
 * covered too.
 */
const route = (
  provider: ManagedGatewayProvider,
  resolvedModel: string,
  protocol: GatewayProtocol,
  serviceTier?: string,
): ManagedRoute => ({
  requestedModel: `stella/${resolvedModel}`,
  resolvedModel,
  upstreamModel: toProviderNativeModel(resolvedModel, provider),
  provider,
  protocol,
  config: {
    model: resolvedModel,
    managedGatewayProvider: provider,
    serviceTier,
  },
});

const request = (path: string, headers: Record<string, string> = {}) =>
  new Request(`https://gateway.test${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: "Bearer capability-token",
      "x-stella-agent-type": "orchestrator",
      "x-stella-request-id": "req-1",
      "cf-connecting-ip": "203.0.113.1",
      "user-agent": "stella-runtime/1.0",
      ...headers,
    },
  });

const shape = (
  provider: ManagedGatewayProvider,
  resolvedModel: string,
  protocol: GatewayProtocol,
  path: string,
  requestJson: Record<string, unknown>,
  options: {
    serviceTier?: string;
    headers?: Record<string, string>;
    audience?: "anonymous" | "free" | "go" | "pro";
  } = {},
) => {
  const shaped = shapeUpstreamRequest({
    request: request(path, options.headers),
    protocol,
    route: route(provider, resolvedModel, protocol, options.serviceTier),
    requestJson,
    apiKey: "upstream-key",
    audience: options.audience ?? "pro",
  });
  return {
    ...shaped,
    json: JSON.parse(shaped.body) as Record<string, unknown>,
  };
};

describe("managed output caps", () => {
  test("clamps every accepted spelling and does not raise smaller values", () => {
    expect(
      clampOutputTokens({
        requestJson: {
          max_tokens: 99_999,
          max_output_tokens: 1_000,
          max_completion_tokens: 99_999,
          generationConfig: { maxOutputTokens: 99_999 },
        },
        protocol: "openai-responses",
        audience: "free",
        modelCeiling: undefined,
      }),
    ).toMatchObject({
      max_tokens: 4_096,
      max_output_tokens: 1_000,
      max_completion_tokens: 4_096,
      generationConfig: { maxOutputTokens: 4_096 },
    });
  });

  test("sets the protocol field when absent and keeps model ceilings", () => {
    expect(
      clampOutputTokens({
        requestJson: {},
        protocol: "openai-completions",
        audience: "pro",
        modelCeiling: 3_000,
      }).max_completion_tokens,
    ).toBe(3_000);
    expect(
      clampOutputTokens({
        requestJson: {},
        protocol: "google-generative-ai",
        audience: "anonymous",
        modelCeiling: 8_000,
      }).generationConfig,
    ).toEqual({ maxOutputTokens: 2_048 });
    expect(
      clampOutputTokens({
        requestJson: { max_tokens: 100 },
        protocol: "openai-responses",
        audience: "free",
        modelCeiling: undefined,
      }).max_output_tokens,
    ).toBe(100);
  });

  test("the upstream body receives the audience cap when callers omit it", () => {
    const { json } = shape(
      "openrouter",
      "meta/muse-spark-1.3-contributor",
      "openai-responses",
      "/v1/relay/responses",
      { input: "hello" },
      { audience: "go" },
    );
    expect(json.max_output_tokens).toBe(8_192);
  });
});

describe("body shaping parity: deepseek", () => {
  test("Responses path: strips the prefix, drops ignored params, nests clamped reasoning, streams", () => {
    const { url, json } = shape(
      "deepseek",
      "deepseek/deepseek-v4-flash",
      "openai-responses",
      "/v1/relay/responses",
      {
        model: "stella/deepseek/deepseek-v4-flash",
        input: [{ role: "user", content: "hi" }],
        reasoning: { effort: "medium" },
        store: true,
        previous_response_id: "resp_0",
        service_tier: "priority",
        metadata: { a: 1 },
      },
    );
    expect(url).toBe("https://api.deepseek.com/responses");
    expect(json.model).toBe("deepseek-v4-flash");
    expect(json.stream).toBe(true);
    expect(json.reasoning).toEqual({ effort: "high" });
    expect(json.reasoning_effort).toBeUndefined();
    for (const key of [
      "store",
      "previous_response_id",
      "service_tier",
      "metadata",
      "agentType",
    ]) {
      expect(json[key]).toBeUndefined();
    }
  });

  test("chat completions path: converts a Responses body and uses DeepSeek's thinking object", () => {
    const { url, json } = shape(
      "deepseek",
      "deepseek/deepseek-v4-flash",
      "openai-completions",
      "/v1/relay/chat/completions",
      {
        model: "stella/deepseek/deepseek-v4-flash",
        input: [
          { role: "user", content: [{ type: "input_text", text: "hi" }] },
          {
            type: "function_call",
            call_id: "c1",
            name: "lookup",
            arguments: '{"q":1}',
          },
          { type: "function_call_output", call_id: "c1", output: "42" },
        ],
        max_output_tokens: 256,
        reasoning: { effort: "xhigh" },
      },
    );
    expect(url).toBe("https://api.deepseek.com/chat/completions");
    expect(json.input).toBeUndefined();
    expect(json.messages).toEqual([
      { role: "user", content: [{ type: "text", text: "hi" }] },
      {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "c1",
            type: "function",
            function: { name: "lookup", arguments: '{"q":1}' },
          },
        ],
      },
      { role: "tool", tool_call_id: "c1", content: "42" },
    ]);
    expect(json.max_completion_tokens).toBe(256);
    expect(json.thinking).toEqual({ type: "enabled" });
    expect(json.reasoning_effort).toBe("max");
    expect(json.reasoning).toBeUndefined();
    expect(json.stream).toBe(true);
    expect(json.stream_options).toEqual({ include_usage: true });
  });
});

describe("body shaping parity: crof", () => {
  test("uses chat completions, the dated slug, Crof's effort ladder, and include_usage", () => {
    const { url, headers, json } = shape(
      "crof",
      "crof/deepseek-v4-flash-0731",
      "openai-completions",
      "/v1/relay/chat/completions",
      {
        model: "stella/crof/deepseek-v4-flash-0731",
        messages: [{ role: "user", content: "hi" }],
        reasoning: { effort: "xhigh" },
        thinking: { type: "enabled" },
      },
    );
    expect(url).toBe("https://crof.ai/v1/chat/completions");
    expect(headers.get("authorization")).toBe("Bearer upstream-key");
    expect(json.model).toBe("deepseek-v4-flash-0731");
    expect(json.reasoning_effort).toBe("high");
    expect(json.reasoning).toBeUndefined();
    expect(json.thinking).toBeUndefined();
    expect(json.stream_options).toEqual({ include_usage: true });
  });

  test("a Responses-shaped body sent to Crof's chat path is converted", () => {
    const { json } = shape(
      "crof",
      "crof/deepseek-v4-flash-0731",
      "openai-completions",
      "/v1/relay/chat/completions",
      {
        model: "stella/crof/deepseek-v4-flash-0731",
        input: [{ role: "user", content: "hi" }],
        max_output_tokens: 64,
        text: { format: { type: "json_object" } },
        reasoning: { effort: "none" },
      },
    );
    expect(json.messages).toEqual([{ role: "user", content: "hi" }]);
    expect(json.response_format).toEqual({ type: "json_object" });
    expect(json.max_completion_tokens).toBe(64);
    expect(json.reasoning_effort).toBe("none");
    expect(json.text).toBeUndefined();
  });
});

describe("body shaping parity: openrouter", () => {
  test("Muse advertises vision and preserves the runtime's Responses image bytes", () => {
    const model = "stella/meta/muse-spark-1.3-contributor";
    const descriptor = resolveManagedModelDescriptor({
      agentType: "orchestrator",
      requestedModel: model,
      audience: "pro",
    });
    expect(descriptor.supportsImages).toBe(true);
    const input = [{
      role: "user",
      content: [
        { type: "input_text", text: "What color is this image?" },
        { type: "input_image", detail: "auto", image_url: "data:image/png;base64,aW1hZ2U=" },
      ],
    }];
    const { json } = shape(
      "openrouter", "meta/muse-spark-1.3-contributor", "openai-responses",
      "/v1/relay/responses", { model, input },
    );
    expect(json.input).toEqual(input);
  });

  test("Responses path: chat-shaped input is normalized, reasoning stays nested, no store flag", () => {
    const { url, headers, json } = shape(
      "openrouter",
      "meta/muse-spark-1.3-contributor",
      "openai-responses",
      "/v1/relay/responses",
      {
        model: "stella/meta/muse-spark-1.3-contributor",
        messages: [
          { role: "developer", content: "Follow the policy." },
          {
            role: "user",
            content: [
              { type: "text", text: "hi" },
              {
                type: "image_url",
                image_url: { url: "data:image/png;base64,abc" },
              },
            ],
          },
        ],
        max_completion_tokens: 1024,
        response_format: { type: "json_object" },
        reasoning_effort: "none",
      },
    );
    expect(url).toBe("https://openrouter.ai/api/v1/responses");
    expect(headers.get("HTTP-Referer")).toBe("https://stella.sh");
    expect(headers.get("X-OpenRouter-Title")).toBe("Stella");
    expect(json.model).toBe("meta/muse-spark-1.3-contributor");
    expect(json.messages).toBeUndefined();
    expect(json.input).toEqual([
      { role: "developer", content: "Follow the policy." },
      {
        role: "user",
        content: [
          { type: "input_text", text: "hi" },
          {
            type: "input_image",
            image_url: "data:image/png;base64,abc",
            detail: "auto",
          },
        ],
      },
    ]);
    expect(json.max_output_tokens).toBe(1024);
    expect(json.text).toEqual({ format: { type: "json_object" } });
    expect(json.reasoning).toEqual({ effort: "low" });
    expect(json.reasoning_effort).toBeUndefined();
    expect(json.store).toBeUndefined();
    expect(json.stream).toBe(true);
  });

  test("chat path: Grok gets mandatory nested reasoning and include_usage", () => {
    const { url, json } = shape(
      "openrouter",
      "x-ai/grok-4.5",
      "openai-completions",
      "/v1/relay/chat/completions",
      {
        model: "stella/x-ai/grok-4.5",
        messages: [{ role: "user", content: "hi" }],
      },
    );
    expect(url).toBe("https://openrouter.ai/api/v1/chat/completions");
    expect(json.reasoning).toEqual({ effort: "low" });
    expect(json.reasoning_effort).toBeUndefined();
    expect(json.stream_options).toEqual({ include_usage: true });
  });
});

describe("body shaping parity: anthropic", () => {
  test("Messages bodies pass through with the native id, x-api-key, and stream: true", () => {
    const { url, headers, json } = shape(
      "anthropic",
      "anthropic/claude-opus-5",
      "anthropic-messages",
      "/v1/relay/v1/messages",
      {
        model: "stella/anthropic/claude-opus-5",
        max_tokens: 1024,
        system: [{ type: "text", text: "Be brief." }],
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "hi" },
              {
                type: "image",
                source: {
                  type: "base64",
                  media_type: "image/png",
                  data: "abc",
                },
              },
            ],
          },
        ],
        thinking: { type: "adaptive" },
        output_config: { effort: "high" },
        tools: [{ name: "get_weather", input_schema: { type: "object" } }],
        agentType: "orchestrator",
        service_tier: "priority",
      },
      {
        headers: {
          "anthropic-version": "2023-06-01",
          "anthropic-beta": "interleaved-thinking-2025-05-14",
        },
      },
    );
    expect(url).toBe("https://api.anthropic.com/v1/messages");
    expect(headers.get("x-api-key")).toBe("upstream-key");
    expect(headers.has("authorization")).toBe(false);
    expect(headers.get("anthropic-version")).toBe("2023-06-01");
    expect(headers.get("anthropic-beta")).toBe(
      "interleaved-thinking-2025-05-14",
    );
    expect(headers.has("x-stella-agent-type")).toBe(false);
    expect(headers.has("cf-connecting-ip")).toBe(false);
    expect(json).toEqual({
      model: "claude-opus-5",
      max_tokens: 1024,
      system: [{ type: "text", text: "Be brief." }],
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "hi" },
            {
              type: "image",
              source: { type: "base64", media_type: "image/png", data: "abc" },
            },
          ],
        },
      ],
      thinking: { type: "adaptive" },
      output_config: { effort: "high" },
      tools: [{ name: "get_weather", input_schema: { type: "object" } }],
      stream: true,
    });
  });
});

describe("body shaping: google and fireworks", () => {
  test("Google is forced onto streamGenerateContent?alt=sse with the model in the URL only", () => {
    const { url, headers, json } = shape(
      "google",
      "google/gemini-3.6-flash",
      "google-generative-ai",
      "/v1/relay/v1beta/models/stella%2Fgoogle%2Fgemini-3.6-flash:generateContent",
      {
        contents: [{ role: "user", parts: [{ text: "hi" }] }],
        generationConfig: { maxOutputTokens: 100 },
      },
    );
    expect(url).toBe(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.6-flash:streamGenerateContent?alt=sse",
    );
    expect(headers.get("x-goog-api-key")).toBe("upstream-key");
    expect(json.model).toBeUndefined();
    expect(json.stream).toBeUndefined();
    expect(json.contents).toEqual([{ role: "user", parts: [{ text: "hi" }] }]);
  });

  test("Fireworks receives the authorized service tier and store: true", () => {
    const { url, json } = shape(
      "fireworks",
      "accounts/fireworks/models/kimi-k2p6",
      "openai-responses",
      "/v1/relay/responses",
      {
        model: "x",
        input: [{ role: "user", content: "hi" }],
        service_tier: "caller-chosen",
      },
      { serviceTier: "priority" },
    );
    expect(url).toBe("https://api.fireworks.ai/inference/v1/responses");
    expect(json.service_tier).toBe("priority");
    expect(json.store).toBe(true);
    expect(json.stream).toBe(true);
  });
});
