import { describe, expect, it } from "bun:test";

import type { ManagedGatewayProvider } from "@stella/model-catalog/managed-gateway";
import {
  bodyForUpstream,
  cloneForwardHeaders,
  isResponsesRequest,
  resolveCloudManagedProtocol,
  toProviderNativeModel,
  upstreamUrl,
  type RelayRequestShape,
} from "@stella/model-catalog/request-shaping";

const RESOLVED_MODELS: Record<ManagedGatewayProvider, string> = {
  anthropic: "anthropic/claude-opus-5",
  fireworks: "accounts/fireworks/models/kimi-k2p6",
  deepseek: "deepseek/deepseek-v4-flash",
  crof: "crof/deepseek-v4-flash-0731",
  google: "google/gemini-3.6-flash",
  meta: "meta/muse-spark-1.1",
  openai: "openai/gpt-5.5",
  openrouter: "x-ai/grok-4.5",
  wafer: "wafer/deepseek-v4-flash-0731-fast",
  xai: "x-ai/grok-4.5",
};

const UPSTREAM_MODELS: Record<ManagedGatewayProvider, string> = {
  anthropic: "claude-opus-5",
  fireworks: "accounts/fireworks/models/kimi-k2p6",
  deepseek: "deepseek-v4-flash",
  crof: "deepseek-v4-flash-0731",
  google: "gemini-3.6-flash",
  meta: "muse-spark-1.1",
  openai: "gpt-5.5",
  openrouter: "x-ai/grok-4.5",
  wafer: "DeepSeek-V4-Flash-0731-Fast",
  xai: "grok-4.5",
};

const makeAuthorized = (
  provider: ManagedGatewayProvider,
  requestJson: RelayRequestShape["requestJson"] = {
    model: "stella/google/gemini-3.6-flash",
    contents: [{ role: "user", parts: [{ text: "hi" }] }],
  },
): RelayRequestShape => ({
  requestJson,
  resolvedModel: RESOLVED_MODELS[provider],
  upstreamModel: UPSTREAM_MODELS[provider],
  serviceTier: "priority",
});

const requestFor = (path: string, headers?: Record<string, string>): Request =>
  new Request(`https://stella.test${path}`, { method: "POST", headers });

const shaped = (
  provider: ManagedGatewayProvider,
  path: string,
  requestJson?: RelayRequestShape["requestJson"],
) =>
  JSON.parse(
    bodyForUpstream(
      makeAuthorized(provider, requestJson),
      provider,
      requestFor(path),
    ),
  ) as Record<string, unknown>;

describe("upstreamUrl", () => {
  it("routes every provider to its native endpoint", () => {
    const cases: Array<[ManagedGatewayProvider, string, string]> = [
      [
        "anthropic",
        "/api/stella/anthropic/v1/messages",
        "https://api.anthropic.com/v1/messages",
      ],
      [
        "openai",
        "/api/stella/openai/v1/chat/completions",
        "https://api.openai.com/v1/chat/completions",
      ],
      [
        "openai",
        "/api/stella/openai/v1/responses",
        "https://api.openai.com/v1/responses",
      ],
      // Fireworks is Responses-only regardless of the relay path.
      [
        "fireworks",
        "/api/stella/fireworks/v1/responses",
        "https://api.fireworks.ai/inference/v1/responses",
      ],
      [
        "fireworks",
        "/api/stella/relay/chat/completions",
        "https://api.fireworks.ai/inference/v1/responses",
      ],
      // DeepSeek serves both APIs off api.deepseek.com's root (no /v1).
      [
        "deepseek",
        "/api/stella/deepseek/v1/responses",
        "https://api.deepseek.com/responses",
      ],
      [
        "deepseek",
        "/api/stella/deepseek/v1/chat/completions",
        "https://api.deepseek.com/chat/completions",
      ],
      [
        "crof",
        "/api/stella/crof/v1/chat/completions",
        "https://crof.ai/v1/chat/completions",
      ],
      [
        "crof",
        "/api/stella/relay/responses",
        "https://crof.ai/v1/chat/completions",
      ],
      [
        "wafer",
        "/api/stella/wafer/v1/chat/completions",
        "https://pass.wafer.ai/v1/chat/completions",
      ],
      [
        "xai",
        "/api/stella/xai/v1/chat/completions",
        "https://api.x.ai/v1/chat/completions",
      ],
      ["xai", "/api/stella/xai/v1/responses", "https://api.x.ai/v1/responses"],
      [
        "openrouter",
        "/api/stella/relay/chat/completions",
        "https://openrouter.ai/api/v1/chat/completions",
      ],
      [
        "openrouter",
        "/api/stella/openrouter/api/v1/responses",
        "https://openrouter.ai/api/v1/responses",
      ],
      [
        "meta",
        "/api/stella/meta/v1/chat/completions",
        "https://api.meta.ai/v1/chat/completions",
      ],
      [
        "meta",
        "/api/stella/meta/v1/responses",
        "https://api.meta.ai/v1/responses",
      ],
    ];
    for (const [provider, path, expected] of cases) {
      expect(
        upstreamUrl(provider, requestFor(path), UPSTREAM_MODELS[provider]),
      ).toBe(expected);
    }
  });

  it("preserves the Google verb and stream query parameters", () => {
    expect(
      upstreamUrl(
        "google",
        requestFor(
          "/api/stella/relay/models/stella%2Fgoogle%2Fgemini-3.6-flash:streamGenerateContent?alt=sse",
        ),
        "gemini-3.6-flash",
      ),
    ).toBe(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.6-flash:streamGenerateContent?alt=sse",
    );
    expect(
      upstreamUrl(
        "google",
        requestFor(
          "/api/stella/relay/models/stella%2Fgoogle%2Fgemini-3.6-flash:generateContent",
        ),
        "gemini-3.6-flash",
      ),
    ).toBe(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.6-flash:generateContent",
    );
  });
});

describe("isResponsesRequest", () => {
  it("is decided by the relay path for dual-API providers only", () => {
    expect(
      isResponsesRequest(
        "openai",
        requestFor("/api/stella/openai/v1/responses"),
      ),
    ).toBe(true);
    expect(
      isResponsesRequest(
        "openai",
        requestFor("/api/stella/openai/v1/chat/completions"),
      ),
    ).toBe(false);
    expect(
      isResponsesRequest(
        "openrouter",
        requestFor("/api/stella/relay/responses"),
      ),
    ).toBe(true);
    expect(
      isResponsesRequest(
        "anthropic",
        requestFor("/api/stella/anthropic/v1/messages"),
      ),
    ).toBe(false);
    expect(
      isResponsesRequest("crof", requestFor("/api/stella/relay/responses")),
    ).toBe(false);
  });
});

describe("toProviderNativeModel", () => {
  it("strips the provider prefix for matching upstreams", () => {
    expect(toProviderNativeModel("anthropic/claude-opus-5", "anthropic")).toBe(
      "claude-opus-5",
    );
    // Anthropic ids use dashes, not dots, at the wire boundary.
    expect(
      toProviderNativeModel("anthropic/claude-sonnet-4.6", "anthropic"),
    ).toBe("claude-sonnet-4-6");
    expect(toProviderNativeModel("openai/gpt-5.6-luna", "openai")).toBe(
      "gpt-5.6-luna",
    );
    expect(toProviderNativeModel("google/gemini-3.6-flash", "google")).toBe(
      "gemini-3.6-flash",
    );
    expect(toProviderNativeModel("meta/muse-spark-1.1", "meta")).toBe(
      "muse-spark-1.1",
    );
    expect(toProviderNativeModel("x-ai/grok-4.5", "xai")).toBe("grok-4.5");
    expect(
      toProviderNativeModel("wafer/deepseek-v4-flash-0731-fast", "wafer"),
    ).toBe("DeepSeek-V4-Flash-0731-Fast");
  });

  it("passes through ids that do not match the relay provider", () => {
    expect(toProviderNativeModel("openai/gpt-5.5", "openrouter")).toBe(
      "openai/gpt-5.5",
    );
    expect(
      toProviderNativeModel("accounts/fireworks/models/kimi-k2p6", "fireworks"),
    ).toBe("accounts/fireworks/models/kimi-k2p6");
  });
});

describe("resolveCloudManagedProtocol", () => {
  it("publishes the canonical wire protocol for every gateway", () => {
    expect(resolveCloudManagedProtocol({ relayProvider: "anthropic" })).toBe(
      "anthropic-messages",
    );
    expect(resolveCloudManagedProtocol({ relayProvider: "google" })).toBe(
      "google-generative-ai",
    );
    for (const relayProvider of [
      "openai",
      "fireworks",
      "deepseek",
      "xai",
    ] as const) {
      expect(resolveCloudManagedProtocol({ relayProvider })).toBe(
        "openai-responses",
      );
    }
    for (const relayProvider of [
      "crof",
      "wafer",
      "openrouter",
      "meta",
    ] as const) {
      expect(resolveCloudManagedProtocol({ relayProvider })).toBe(
        "openai-completions",
      );
    }
    expect(
      resolveCloudManagedProtocol({
        relayProvider: "openrouter",
        configuredApi: "openai-responses",
      }),
    ).toBe("openai-responses");
  });
});

describe("cloneForwardHeaders", () => {
  it("places the key in each provider's native header", () => {
    const anthropic = cloneForwardHeaders(
      requestFor("/api/stella/anthropic/v1/messages"),
      "anthropic",
      "sk-ant",
    );
    expect(anthropic.get("x-api-key")).toBe("sk-ant");
    expect(anthropic.get("authorization")).toBeNull();

    const google = cloneForwardHeaders(
      requestFor("/api/stella/relay/models/gemini-3.6-flash:generateContent"),
      "google",
      "goog-key",
    );
    expect(google.get("x-goog-api-key")).toBe("goog-key");
    expect(google.get("authorization")).toBeNull();

    const openrouter = cloneForwardHeaders(
      requestFor("/api/stella/relay/responses"),
      "openrouter",
      "or-key",
    );
    expect(openrouter.get("authorization")).toBe("Bearer or-key");
    expect(openrouter.get("HTTP-Referer")).toBe("https://stella.sh");
    expect(openrouter.get("X-OpenRouter-Title")).toBe("Stella");
    expect(openrouter.get("content-type")).toBe("application/json");
  });

  it("never forwards Stella capabilities, session identity, or edge metadata", () => {
    const headers = cloneForwardHeaders(
      requestFor("/api/stella/anthropic/v1/messages", {
        authorization: "Bearer stella-capability",
        "x-stella-agent-type": "general",
        "x-stella-turn-token": "turn",
        "cf-connecting-ip": "203.0.113.1",
        "x-forwarded-for": "203.0.113.1",
        cookie: "session=abc",
        "anthropic-beta": "context-1m-2025-08-07",
        "user-agent": "stella-runtime",
      }),
      "anthropic",
      "sk-ant",
    );
    expect(headers.get("authorization")).toBeNull();
    expect(headers.get("x-stella-agent-type")).toBeNull();
    expect(headers.get("x-stella-turn-token")).toBeNull();
    expect(headers.get("cf-connecting-ip")).toBeNull();
    expect(headers.get("x-forwarded-for")).toBeNull();
    expect(headers.get("cookie")).toBeNull();
    expect(headers.get("anthropic-beta")).toBe("context-1m-2025-08-07");
    expect(headers.get("user-agent")).toBe("stella-runtime");
  });

  it("sends the Wafer-ZDR header on every wafer request by default and honors explicit extra headers", () => {
    const wafer = cloneForwardHeaders(
      requestFor("/api/stella/wafer/v1/chat/completions"),
      "wafer",
      "wafer-key",
    );
    expect(wafer.get("Wafer-ZDR")).toBe("required");
    expect(wafer.get("authorization")).toBe("Bearer wafer-key");

    // The header is wafer-specific; other gateways must not receive it.
    const crof = cloneForwardHeaders(
      requestFor("/api/stella/crof/v1/chat/completions"),
      "crof",
      "crof-key",
    );
    expect(crof.get("Wafer-ZDR")).toBeNull();

    // An explicit table replaces the gateway default entirely.
    const explicit = cloneForwardHeaders(
      requestFor("/api/stella/wafer/v1/chat/completions"),
      "wafer",
      "wafer-key",
      { "X-Custom": "1" },
    );
    expect(explicit.get("X-Custom")).toBe("1");
    expect(explicit.get("Wafer-ZDR")).toBeNull();
  });
});

describe("bodyForUpstream: deepseek", () => {
  it("strips the deepseek/ prefix and the params DeepSeek ignores", () => {
    const body = shaped("deepseek", "/api/stella/deepseek/v1/responses", {
      model: "stella/default",
      input: [{ role: "user", content: "hi" }],
      reasoning: { effort: "medium", summary: "auto" },
      prompt_cache_key: "session-1",
      prompt_cache_retention: "24h",
      include: ["reasoning.encrypted_content"],
      service_tier: "priority",
      stream: true,
    });

    expect(body.model).toBe("deepseek-v4-flash");
    // DeepSeek's Responses API is stateless: never claim `store`.
    expect(body.store).toBeUndefined();
    expect(body.prompt_cache_key).toBeUndefined();
    expect(body.prompt_cache_retention).toBeUndefined();
    expect(body.include).toBeUndefined();
    expect(body.service_tier).toBeUndefined();
  });

  it("clamps Stella's effort ladder onto DeepSeek's low/high/max", () => {
    const effortFor = (requested: Record<string, unknown>) =>
      shaped("deepseek", "/api/stella/deepseek/v1/responses", {
        model: "stella/default",
        input: [{ role: "user", content: "hi" }],
        ...requested,
      }).reasoning;

    expect(effortFor({ reasoning: { effort: "minimal" } })).toEqual({
      effort: "low",
    });
    expect(effortFor({ reasoning: { effort: "medium" } })).toEqual({
      effort: "high",
    });
    expect(effortFor({ reasoning_effort: "xhigh" })).toEqual({ effort: "max" });
    expect(effortFor({ reasoning: { effort: "off" } })).toEqual({
      effort: "none",
    });
    expect(effortFor({ reasoning: { effort: "high" } })).toEqual({
      effort: "max",
    });
    // Absent or unrecognized efforts land on max, not DeepSeek's own default.
    expect(effortFor({})).toEqual({ effort: "max" });
  });

  it("uses DeepSeek's thinking object on the chat-completions path", () => {
    const body = shaped(
      "deepseek",
      "/api/stella/deepseek/v1/chat/completions",
      {
        model: "stella/default",
        messages: [{ role: "user", content: "hi" }],
        reasoning: { effort: "medium" },
        stream: true,
      },
    );

    expect(body.model).toBe("deepseek-v4-flash");
    expect(body.thinking).toEqual({ type: "enabled" });
    expect(body.reasoning_effort).toBe("high");
    expect(body.reasoning).toBeUndefined();
    expect(body.stream_options).toEqual({ include_usage: true });
  });

  it("converts a stale Responses body for the chat-completions path", () => {
    const body = shaped("deepseek", "/api/stella/relay/chat/completions", {
      model: "stella/default",
      input: [{ role: "user", content: [{ type: "input_text", text: "hi" }] }],
      max_output_tokens: 256,
      reasoning: { effort: "off" },
    });

    expect(body.input).toBeUndefined();
    expect(body.messages).toEqual([
      { role: "user", content: [{ type: "text", text: "hi" }] },
    ]);
    expect(body.max_completion_tokens).toBe(256);
    expect(body.thinking).toEqual({ type: "disabled" });
    expect(body.reasoning_effort).toBeUndefined();
  });
});

describe("bodyForUpstream: crof", () => {
  it("uses chat completions, the dated model slug, and Crof reasoning levels", () => {
    const body = shaped("crof", "/api/stella/crof/v1/chat/completions", {
      model: "stella/default",
      messages: [{ role: "user", content: "hi" }],
      reasoning: { effort: "xhigh" },
      stream: true,
    });
    expect(body.model).toBe("deepseek-v4-flash-0731");
    expect(body.reasoning_effort).toBe("high");
    expect(body.reasoning).toBeUndefined();
    expect(body.thinking).toBeUndefined();
    expect(body.stream_options).toEqual({ include_usage: true });
  });

  it("normalizes Wafer bodies like Crof with the exact upstream casing", () => {
    const body = shaped("wafer", "/api/stella/wafer/v1/chat/completions", {
      model: "stella/wafer/deepseek-v4-flash-0731-fast",
      messages: [{ role: "user", content: "hi" }],
      reasoning: { effort: "xhigh" },
      stream: true,
    });
    expect(body.model).toBe("DeepSeek-V4-Flash-0731-Fast");
    expect(body.reasoning_effort).toBe("high");
    expect(body.reasoning).toBeUndefined();
    expect(body.stream_options).toEqual({ include_usage: true });
  });
});

describe("bodyForUpstream: openrouter responses", () => {
  it("normalizes chat-shaped bodies for the OpenRouter Responses path", () => {
    const body = shaped("openrouter", "/api/stella/relay/responses", {
      model: "stella/standard",
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
      stream_options: { include_usage: true },
      stream: true,
    });

    expect(body.model).toBe("x-ai/grok-4.5");
    expect(body.messages).toBeUndefined();
    expect(body.max_completion_tokens).toBeUndefined();
    expect(body.max_output_tokens).toBe(1024);
    expect(body.response_format).toBeUndefined();
    expect(body.stream_options).toBeUndefined();
    expect(body.text).toEqual({ format: { type: "json_object" } });
    // Reasoning is mandatory for Grok: none/off collapse to low, nested only.
    expect(body.reasoning).toEqual({ effort: "low" });
    expect(body.reasoning_effort).toBeUndefined();
    expect(body.input).toEqual([
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
    // OpenRouter's stateful handling is unverified: no `store`.
    expect(body.store).toBeUndefined();
  });

  it("keeps an explicit xhigh reasoning effort", () => {
    const body = shaped("openrouter", "/api/stella/relay/responses", {
      model: "stella/standard",
      input: [{ role: "user", content: [{ type: "input_text", text: "hi" }] }],
      reasoning: { effort: "xhigh" },
    });
    expect(body.reasoning).toEqual({ effort: "xhigh" });
    expect(body.reasoning_effort).toBeUndefined();
  });

  it("adds mandatory Grok reasoning for OpenRouter chat bodies", () => {
    const body = shaped("openrouter", "/api/stella/relay/chat/completions", {
      model: "stella/standard",
      messages: [{ role: "user", content: "hi" }],
      reasoning: { effort: "none" },
      stream: true,
    });
    expect(body.messages).toEqual([{ role: "user", content: "hi" }]);
    expect(body.reasoning).toEqual({ effort: "low" });
    expect(body.reasoning_effort).toBeUndefined();
    expect(body.stream_options).toEqual({ include_usage: true });
  });
});

describe("bodyForUpstream: anthropic", () => {
  it("forwards Messages bodies untouched apart from the native model id and backend-owned fields", () => {
    const body = shaped("anthropic", "/api/stella/anthropic/v1/messages", {
      model: "stella/anthropic/claude-opus-5",
      agentType: "general",
      service_tier: "priority",
      system: "be brief",
      messages: [{ role: "user", content: "hi" }],
      max_tokens: 256,
      thinking: { type: "adaptive" },
      stream: true,
    });

    expect(body).toEqual({
      model: "claude-opus-5",
      system: "be brief",
      messages: [{ role: "user", content: "hi" }],
      max_tokens: 256,
      thinking: { type: "adaptive" },
      stream: true,
    });
  });

  it("keeps image blocks for the vision-capable Anthropic route", () => {
    const messages = [
      {
        role: "user",
        content: [
          { type: "text", text: "what is this" },
          {
            type: "image",
            source: { type: "base64", media_type: "image/png", data: "abc" },
          },
        ],
      },
    ];
    const body = shaped("anthropic", "/api/stella/anthropic/v1/messages", {
      model: "stella/anthropic/claude-opus-5",
      messages,
      max_tokens: 64,
    });
    expect(body.messages).toEqual(messages);
  });
});

describe("bodyForUpstream: other providers", () => {
  it("forwards service_tier only to Fireworks", () => {
    expect(
      shaped("fireworks", "/api/stella/fireworks/v1/responses").service_tier,
    ).toBe("priority");
    expect(
      shaped("openai", "/api/stella/openai/v1/responses").service_tier,
    ).toBeUndefined();
  });

  it("drops the model from Google bodies (it lives in the URL)", () => {
    const body = shaped(
      "google",
      "/api/stella/google/v1beta/models/stella%2Fgoogle%2Fgemini-3.6-flash:streamGenerateContent",
    );
    expect(body.model).toBeUndefined();
    expect(body.service_tier).toBeUndefined();
  });

  it("marks OpenAI Responses stateful and renames legacy chat fields", () => {
    const body = shaped("openai", "/api/stella/openai/v1/responses", {
      model: "stella/openai/gpt-5.5",
      messages: [{ role: "user", content: [{ type: "text", text: "finish" }] }],
      max_tokens: 1024,
      response_format: { type: "json_object" },
      stream_options: { include_usage: true },
      text: { verbosity: "low" },
    });
    expect(body.model).toBe("gpt-5.5");
    expect(body.store).toBe(true);
    expect(body.messages).toBeUndefined();
    expect(body.input).toEqual([
      { role: "user", content: [{ type: "input_text", text: "finish" }] },
    ]);
    expect(body.max_tokens).toBeUndefined();
    expect(body.max_output_tokens).toBe(1024);
    expect(body.stream_options).toBeUndefined();
    expect(body.text).toEqual({
      verbosity: "low",
      format: { type: "json_object" },
    });
  });

  it("uses xAI's top-level reasoning_effort for chat and nested reasoning for Responses", () => {
    const chat = shaped("xai", "/api/stella/xai/v1/chat/completions", {
      model: "stella/standard",
      messages: [{ role: "user", content: "hi" }],
      reasoning: { effort: "none" },
      stream: true,
    });
    expect(chat.model).toBe("grok-4.5");
    expect(chat.reasoning_effort).toBe("low");
    expect(chat.reasoning).toBeUndefined();

    const responses = shaped("xai", "/api/stella/xai/v1/responses", {
      model: "stella/standard",
      input: [{ role: "user", content: "hi" }],
      reasoning_effort: "high",
    });
    expect(responses.reasoning_effort).toBeUndefined();
    expect(responses.reasoning).toEqual({ effort: "high" });
    expect(responses.store).toBe(true);
  });

  it("coerces Muse Spark's mandatory reasoning to low on the Meta gateway", () => {
    const chat = shaped("meta", "/api/stella/meta/v1/chat/completions", {
      model: "stella/meta/muse-spark-1.1",
      messages: [{ role: "user", content: "hi" }],
      reasoning: { effort: "none" },
      stream: true,
    });
    expect(chat.model).toBe("muse-spark-1.1");
    expect(chat.reasoning_effort).toBe("low");
    expect(chat.reasoning).toBeUndefined();

    const responses = shaped("meta", "/api/stella/meta/v1/responses", {
      model: "stella/meta/muse-spark-1.1",
      input: [{ role: "user", content: "hi" }],
      reasoning_effort: "none",
    });
    expect(responses.reasoning_effort).toBeUndefined();
    expect(responses.reasoning).toEqual({ effort: "low" });
  });

  it("serializes native connected-credential bodies without cross-provider shaping", () => {
    const body = JSON.parse(
      bodyForUpstream(
        {
          requestJson: {
            model: "stella/anthropic/claude-opus-5",
            agentType: "general",
            system: "native",
            messages: [{ role: "user", content: "hi" }],
          },
          resolvedModel: "anthropic/claude-opus-5",
          upstreamModel: "claude-opus-5",
          userCredential: {
            provider: "anthropic",
            accessToken: "oauth-token",
            injectClaudeCodeIdentity: true,
          },
        },
        "anthropic",
        requestFor("/api/stella/anthropic/v1/messages"),
      ),
    ) as Record<string, unknown>;
    expect(body.model).toBe("claude-opus-5");
    expect(body.agentType).toBeUndefined();
    expect(body.system).toEqual([
      {
        type: "text",
        text: "You are Claude Code, Anthropic's official CLI for Claude.",
      },
      { type: "text", text: "native" },
    ]);
  });
});
