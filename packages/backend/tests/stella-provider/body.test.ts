import { describe, expect, it } from "bun:test";

import { bodyForUpstream, upstreamUrl } from "../../convex/stella_provider";
import type { AuthorizedStellaRequest } from "../../convex/stella_provider/shared";
import type { ManagedGatewayProvider } from "../../convex/lib/managed_gateway";

const RESOLVED_MODELS: Record<ManagedGatewayProvider, string> = {
  anthropic: "anthropic/claude-opus-5",
  fireworks: "accounts/fireworks/models/kimi-k2p6",
  deepseek: "deepseek/deepseek-v4-flash",
  crof: "crof/deepseek-v4-flash-0731",
  google: "google/gemini-3.6-flash",
  meta: "meta/muse-spark-1.1",
  openai: "openai/gpt-5.5",
  openrouter: "x-ai/grok-4.5",
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
  xai: "grok-4.5",
};

const makeAuthorized = (
  provider: ManagedGatewayProvider,
  requestJson: AuthorizedStellaRequest["requestJson"] = {
    model: "stella/google/gemini-3.6-flash",
    contents: [{ role: "user", parts: [{ text: "hi" }] }],
  },
): AuthorizedStellaRequest => ({
  ownerId: "user_123",
  agentType: "orchestrator",
  relayProvider: provider,
  requestJson,
  requestedModel: "stella/google/gemini-3.6-flash",
  resolvedModel: RESOLVED_MODELS[provider],
  upstreamModel: UPSTREAM_MODELS[provider],
  serviceTier: "priority",
  apiKey: "test-key",
  tokenEstimate: { inputTokens: 1, outputTokens: 1 },
});

const requestFor = (path: string): Request =>
  new Request(`https://stella.test${path}`, { method: "POST" });

describe("bodyForUpstream", () => {
  it("forwards service_tier only to Fireworks", () => {
    const body = JSON.parse(
      bodyForUpstream(
        makeAuthorized("fireworks"),
        "fireworks",
        requestFor("/api/stella/fireworks/v1/responses"),
      ),
    );

    expect(body.service_tier).toBe("priority");
  });

  it("does not forward service_tier to Google", () => {
    const body = JSON.parse(
      bodyForUpstream(
        makeAuthorized("google"),
        "google",
        requestFor(
          "/api/stella/google/v1beta/models/stella%2Fgoogle%2Fgemini-3.6-flash:streamGenerateContent",
        ),
      ),
    );

    expect(body.service_tier).toBeUndefined();
    expect(body.model).toBeUndefined();
  });

  it("does not forward service_tier to OpenAI-compatible providers", () => {
    const body = JSON.parse(
      bodyForUpstream(
        makeAuthorized("openai"),
        "openai",
        requestFor("/api/stella/openai/v1/responses"),
      ),
    );

    expect(body.service_tier).toBeUndefined();
    expect(body.model).toBe("gpt-5.5");
    expect(body.store).toBe(true);
  });

  it("strips legacy messages from OpenAI Responses bodies", () => {
    const body = JSON.parse(
      bodyForUpstream(
        makeAuthorized("openai", {
          model: "stella/openai/gpt-5.5",
          messages: [
            {
              role: "user",
              content: [{ type: "text", text: "finish the update" }],
            },
          ],
          stream: true,
        }),
        "openai",
        requestFor("/api/stella/openai/v1/responses"),
      ),
    );

    expect(body.messages).toBeUndefined();
    expect(body.input).toEqual([
      {
        role: "user",
        content: [{ type: "input_text", text: "finish the update" }],
      },
    ]);
  });

  it("renames legacy chat-completions fields for OpenAI Responses bodies", () => {
    const body = JSON.parse(
      bodyForUpstream(
        makeAuthorized("openai", {
          model: "stella/openai/gpt-5.5",
          input: [{ role: "user", content: "finish the update" }],
          max_tokens: 1024,
          max_completion_tokens: 2048,
          response_format: { type: "json_object" },
          stream_options: { include_usage: true },
          text: { verbosity: "low" },
        }),
        "openai",
        requestFor("/api/stella/openai/v1/responses"),
      ),
    );

    expect(body.max_tokens).toBeUndefined();
    expect(body.max_completion_tokens).toBeUndefined();
    expect(body.max_output_tokens).toBe(1024);
    expect(body.response_format).toBeUndefined();
    expect(body.stream_options).toBeUndefined();
    expect(body.text).toEqual({
      verbosity: "low",
      format: { type: "json_object" },
    });
  });

  it("keeps chat-completions messages unchanged", () => {
    const body = JSON.parse(
      bodyForUpstream(
        makeAuthorized("openai", {
          model: "stella/openai/gpt-5.5",
          messages: [{ role: "user", content: "hello" }],
          stream: true,
        }),
        "openai",
        requestFor("/api/stella/openai/v1/chat/completions"),
      ),
    );

    expect(body.messages).toEqual([{ role: "user", content: "hello" }]);
    expect(body.input).toBeUndefined();
    expect(body.stream_options).toEqual({ include_usage: true });
  });

  it("converts stale Responses bodies for OpenRouter chat completions", () => {
    const body = JSON.parse(
      bodyForUpstream(
        makeAuthorized("openrouter", {
          model: "stella/standard",
          input: [
            {
              role: "developer",
              content: "Follow the policy.",
            },
            {
              role: "user",
              content: [
                { type: "input_text", text: "hi" },
                {
                  type: "input_image",
                  image_url: "data:image/png;base64,abc",
                },
              ],
            },
          ],
          tools: [
            {
              type: "function",
              name: "spawn_agent",
              description: "Start an agent",
              parameters: { type: "object", properties: {} },
            },
          ],
          max_output_tokens: 1024,
          reasoning: { effort: "none", summary: "auto" },
          text: { format: { type: "json_object" } },
          prompt_cache_key: "stale-cache-key",
          prompt_cache_retention: "24h",
          store: false,
          include: ["reasoning.encrypted_content"],
          stream: true,
        }),
        "openrouter",
        requestFor("/api/stella/relay/responses"),
      ),
    );

    expect(body.model).toBe("x-ai/grok-4.5");
    expect(body.input).toBeUndefined();
    expect(body.max_output_tokens).toBeUndefined();
    expect(body.max_completion_tokens).toBe(1024);
    expect(body.prompt_cache_key).toBeUndefined();
    expect(body.prompt_cache_retention).toBeUndefined();
    expect(body.store).toBeUndefined();
    expect(body.include).toBeUndefined();
    expect(body.text).toBeUndefined();
    expect(body.response_format).toEqual({ type: "json_object" });
    expect(body.reasoning).toEqual({ effort: "low" });
    expect(body.messages).toEqual([
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
    ]);
    expect(body.tools).toEqual([
      {
        type: "function",
        function: {
          name: "spawn_agent",
          description: "Start an agent",
          parameters: { type: "object", properties: {} },
        },
      },
    ]);
    expect(body.stream_options).toEqual({ include_usage: true });
  });

  it("adds mandatory Grok 4.5 reasoning for OpenRouter chat bodies", () => {
    const body = JSON.parse(
      bodyForUpstream(
        makeAuthorized("openrouter", {
          model: "stella/standard",
          messages: [{ role: "user", content: "hi" }],
          reasoning: { effort: "none" },
          stream: true,
        }),
        "openrouter",
        requestFor("/api/stella/relay/chat/completions"),
      ),
    );

    expect(body.messages).toEqual([{ role: "user", content: "hi" }]);
    expect(body.reasoning).toEqual({ effort: "low" });
    expect(body.stream_options).toEqual({ include_usage: true });
  });
});

describe("upstreamUrl", () => {
  it("routes xAI chat completions and Responses directly to api.x.ai", () => {
    expect(
      upstreamUrl(
        "xai",
        requestFor("/api/stella/xai/v1/chat/completions"),
        "grok-4.5",
      ),
    ).toBe("https://api.x.ai/v1/chat/completions");
    expect(
      upstreamUrl(
        "xai",
        requestFor("/api/stella/xai/v1/responses"),
        "grok-4.5",
      ),
    ).toBe("https://api.x.ai/v1/responses");
  });

  it("preserves Google stream query parameters", () => {
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
  });

  it("keeps non-stream Google verbs queryless", () => {
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

describe("direct xAI Grok relay", () => {
  it("uses xAI's top-level reasoning_effort for chat completions", () => {
    const body = JSON.parse(
      bodyForUpstream(
        makeAuthorized("xai", {
          model: "stella/standard",
          messages: [{ role: "user", content: "hi" }],
          reasoning: { effort: "none" },
          stream: true,
        }),
        "xai",
        requestFor("/api/stella/xai/v1/chat/completions"),
      ),
    );

    expect(body.model).toBe("grok-4.5");
    expect(body.reasoning_effort).toBe("low");
    expect(body.reasoning).toBeUndefined();
    expect(body.stream_options).toEqual({ include_usage: true });
  });

  it("uses xAI's nested reasoning object for Responses", () => {
    const body = JSON.parse(
      bodyForUpstream(
        makeAuthorized("xai", {
          model: "stella/standard",
          input: [{ role: "user", content: "hi" }],
          reasoning_effort: "high",
        }),
        "xai",
        requestFor("/api/stella/xai/v1/responses"),
      ),
    );

    expect(body.model).toBe("grok-4.5");
    expect(body.reasoning_effort).toBeUndefined();
    expect(body.reasoning).toEqual({ effort: "high" });
    expect(body.store).toBe(true);
  });
});

describe("direct DeepSeek relay", () => {
  it("routes both DeepSeek APIs off api.deepseek.com's root", () => {
    expect(
      upstreamUrl(
        "deepseek",
        requestFor("/api/stella/deepseek/v1/responses"),
        "deepseek-v4-flash",
      ),
    ).toBe("https://api.deepseek.com/responses");
    expect(
      upstreamUrl(
        "deepseek",
        requestFor("/api/stella/deepseek/v1/chat/completions"),
        "deepseek-v4-flash",
      ),
    ).toBe("https://api.deepseek.com/chat/completions");
  });

  it("strips the deepseek/ prefix and the params DeepSeek ignores", () => {
    const body = JSON.parse(
      bodyForUpstream(
        makeAuthorized("deepseek", {
          model: "stella/default",
          input: [{ role: "user", content: "hi" }],
          reasoning: { effort: "medium", summary: "auto" },
          prompt_cache_key: "session-1",
          prompt_cache_retention: "24h",
          include: ["reasoning.encrypted_content"],
          service_tier: "priority",
          stream: true,
        }),
        "deepseek",
        requestFor("/api/stella/deepseek/v1/responses"),
      ),
    );

    expect(body.model).toBe("deepseek-v4-flash");
    // DeepSeek's Responses API is stateless — claiming otherwise would make a
    // `previous_response_id` continuation look supported when it isn't.
    expect(body.store).toBeUndefined();
    expect(body.prompt_cache_key).toBeUndefined();
    expect(body.prompt_cache_retention).toBeUndefined();
    expect(body.include).toBeUndefined();
    expect(body.service_tier).toBeUndefined();
  });

  it("clamps Stella's effort ladder onto DeepSeek's low/high/max", () => {
    const effortFor = (
      requested: Record<string, unknown>,
      path = "/api/stella/deepseek/v1/responses",
    ) =>
      JSON.parse(
        bodyForUpstream(
          makeAuthorized("deepseek", {
            model: "stella/default",
            input: [{ role: "user", content: "hi" }],
            ...requested,
          }),
          "deepseek",
          requestFor(path),
        ),
      );

    expect(effortFor({ reasoning: { effort: "minimal" } }).reasoning).toEqual({
      effort: "low",
    });
    // Older desktop builds still send "medium", which is not in DeepSeek's
    // ladder.
    expect(effortFor({ reasoning: { effort: "medium" } }).reasoning).toEqual({
      effort: "high",
    });
    expect(effortFor({ reasoning_effort: "xhigh" }).reasoning).toEqual({
      effort: "max",
    });
    expect(effortFor({ reasoning: { effort: "off" } }).reasoning).toEqual({
      effort: "none",
    });
    // Stella runs this model at max unless the caller asked for less, so an
    // absent or unrecognized effort lands there rather than DeepSeek's own
    // `high` default.
    expect(effortFor({ reasoning: { effort: "high" } }).reasoning).toEqual({
      effort: "max",
    });
    expect(effortFor({}).reasoning).toEqual({ effort: "max" });
  });

  it("uses DeepSeek's thinking object on the chat-completions path", () => {
    const body = JSON.parse(
      bodyForUpstream(
        makeAuthorized("deepseek", {
          model: "stella/default",
          messages: [{ role: "user", content: "hi" }],
          reasoning: { effort: "medium" },
          stream: true,
        }),
        "deepseek",
        requestFor("/api/stella/deepseek/v1/chat/completions"),
      ),
    );

    expect(body.model).toBe("deepseek-v4-flash");
    expect(body.thinking).toEqual({ type: "enabled" });
    expect(body.reasoning_effort).toBe("high");
    expect(body.reasoning).toBeUndefined();
    expect(body.stream_options).toEqual({ include_usage: true });
  });

  it("converts a stale Responses body for the chat-completions path", () => {
    // Desktop builds that predate the `deepseek/` prefix infer `openrouter`
    // and post chat completions; the reverse can happen mid-rollout too.
    const body = JSON.parse(
      bodyForUpstream(
        makeAuthorized("deepseek", {
          model: "stella/default",
          input: [
            { role: "user", content: [{ type: "input_text", text: "hi" }] },
          ],
          max_output_tokens: 256,
          reasoning: { effort: "off" },
        }),
        "deepseek",
        requestFor("/api/stella/relay/chat/completions"),
      ),
    );

    expect(body.input).toBeUndefined();
    expect(body.messages).toEqual([
      { role: "user", content: [{ type: "text", text: "hi" }] },
    ]);
    expect(body.max_completion_tokens).toBe(256);
    expect(body.thinking).toEqual({ type: "disabled" });
    expect(body.reasoning_effort).toBeUndefined();
  });
});

describe("CrofAI DeepSeek relay", () => {
  it("uses chat completions, the dated model slug, and Crof reasoning levels", () => {
    expect(
      upstreamUrl(
        "crof",
        requestFor("/api/stella/crof/v1/chat/completions"),
        "deepseek-v4-flash-0731",
      ),
    ).toBe("https://crof.ai/v1/chat/completions");

    const body = JSON.parse(
      bodyForUpstream(
        makeAuthorized("crof", {
          model: "stella/default",
          messages: [{ role: "user", content: "hi" }],
          reasoning: { effort: "xhigh" },
          stream: true,
        }),
        "crof",
        requestFor("/api/stella/crof/v1/chat/completions"),
      ),
    );
    expect(body.model).toBe("deepseek-v4-flash-0731");
    expect(body.reasoning_effort).toBe("high");
    expect(body.reasoning).toBeUndefined();
    expect(body.stream_options).toEqual({ include_usage: true });
  });
});

describe("meta Muse Spark relay", () => {
  it("routes Meta chat completions to api.meta.ai chat/completions", () => {
    expect(
      upstreamUrl(
        "meta",
        requestFor("/api/stella/meta/v1/chat/completions"),
        "muse-spark-1.1",
      ),
    ).toBe("https://api.meta.ai/v1/chat/completions");
  });

  it("routes Meta responses to api.meta.ai responses", () => {
    expect(
      upstreamUrl(
        "meta",
        requestFor("/api/stella/meta/v1/responses"),
        "muse-spark-1.1",
      ),
    ).toBe("https://api.meta.ai/v1/responses");
  });

  it("strips the meta/ prefix and coerces none reasoning effort to low", () => {
    const body = JSON.parse(
      bodyForUpstream(
        makeAuthorized("meta", {
          model: "stella/meta/muse-spark-1.1",
          messages: [{ role: "user", content: "hi" }],
          reasoning: { effort: "none" },
          stream: true,
        }),
        "meta",
        requestFor("/api/stella/meta/v1/chat/completions"),
      ),
    );

    expect(body.model).toBe("muse-spark-1.1");
    expect(body.reasoning_effort).toBe("low");
    expect(body.reasoning).toBeUndefined();
    expect(body.stream_options).toEqual({ include_usage: true });
  });

  it("preserves supported Muse reasoning effort values", () => {
    const body = JSON.parse(
      bodyForUpstream(
        makeAuthorized("meta", {
          model: "stella/meta/muse-spark-1.1",
          messages: [{ role: "user", content: "hi" }],
          reasoning: { effort: "high" },
        }),
        "meta",
        requestFor("/api/stella/meta/v1/chat/completions"),
      ),
    );

    expect(body.reasoning_effort).toBe("high");
    expect(body.reasoning).toBeUndefined();
  });

  it("uses nested reasoning only for Meta responses", () => {
    const body = JSON.parse(
      bodyForUpstream(
        makeAuthorized("meta", {
          model: "stella/meta/muse-spark-1.1",
          input: [{ role: "user", content: "hi" }],
          reasoning_effort: "none",
        }),
        "meta",
        requestFor("/api/stella/meta/v1/responses"),
      ),
    );

    expect(body.reasoning_effort).toBeUndefined();
    expect(body.reasoning).toEqual({ effort: "low" });
  });
});
