import { describe, expect, it } from "bun:test";

import { bodyForUpstream, upstreamUrl } from "../../convex/stella_provider";
import type { AuthorizedStellaRequest } from "../../convex/stella_provider/shared";
import type { ManagedGatewayProvider } from "../../convex/lib/managed_gateway";

const makeAuthorized = (
  provider: ManagedGatewayProvider,
  requestJson: AuthorizedStellaRequest["requestJson"] = {
    model: "stella/google/gemini-3-flash-preview",
    contents: [{ role: "user", parts: [{ text: "hi" }] }],
  },
): AuthorizedStellaRequest => ({
  ownerId: "user_123",
  agentType: "orchestrator",
  relayProvider: provider,
  requestJson,
  requestedModel: "stella/google/gemini-3-flash-preview",
  resolvedModel:
    provider === "fireworks"
      ? "accounts/fireworks/models/kimi-k2p6"
      : provider === "openai"
        ? "openai/gpt-5.5"
        : provider === "openrouter"
          ? "x-ai/grok-4.5"
          : "google/gemini-3-flash-preview",
  upstreamModel:
    provider === "fireworks"
      ? "accounts/fireworks/models/kimi-k2p6"
      : provider === "openai"
        ? "gpt-5.5"
        : provider === "openrouter"
          ? "x-ai/grok-4.5"
          : "gemini-3-flash-preview",
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
          "/api/stella/google/v1beta/models/stella%2Fgoogle%2Fgemini-3-flash-preview:streamGenerateContent",
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
  it("preserves Google stream query parameters", () => {
    expect(
      upstreamUrl(
        "google",
        requestFor(
          "/api/stella/relay/models/stella%2Fgoogle%2Fgemini-3-flash-preview:streamGenerateContent?alt=sse",
        ),
        "gemini-3-flash-preview",
      ),
    ).toBe(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-3-flash-preview:streamGenerateContent?alt=sse",
    );
  });

  it("keeps non-stream Google verbs queryless", () => {
    expect(
      upstreamUrl(
        "google",
        requestFor(
          "/api/stella/relay/models/stella%2Fgoogle%2Fgemini-3-flash-preview:generateContent",
        ),
        "gemini-3-flash-preview",
      ),
    ).toBe(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-3-flash-preview:generateContent",
    );
  });
});
