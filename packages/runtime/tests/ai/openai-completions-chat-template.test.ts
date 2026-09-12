import { describe, expect, it } from "vitest";

import { buildOpenAICompletionsParams } from "@stella/runtime/ai/providers/openai-completions";
import type {
  Context,
  Model,
} from "@stella/runtime/ai/types";

const context: Context = { messages: [] };

const makeModel = (
  thinkingFormat: "chat-template" | "qwen-chat-template",
): Model<"openai-completions"> => ({
  id: "template-model",
  name: "Template model",
  api: "openai-completions",
  provider: "custom",
  baseUrl: "http://127.0.0.1:4141/v1",
  reasoning: true,
  thinkingLevelMap: { off: null, high: "maximum" },
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128_000,
  maxTokens: 16_000,
  compat: {
    thinkingFormat,
    chatTemplateKwargs: {
      static_string: "value",
      static_number: 7,
      static_boolean: true,
      static_null: null,
      enabled: { $var: "thinking.enabled" },
      effort: { $var: "thinking.effort" },
      only_when_on: {
        $var: "thinking.effort",
        omitWhenOff: true,
      },
    },
  },
});

const fireworksModel: Model<"openai-completions"> = {
  id: "stella/accounts/fireworks/models/deepseek-v4-flash-0731",
  name: "DeepSeek V4 Flash 0731",
  api: "openai-completions",
  provider: "fireworks",
  baseUrl: "https://model-gateway.example.test/v1/relay",
  reasoning: true,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 1_000_000,
  maxTokens: 65_536,
};

describe("openai-completions chat template kwargs", () => {
  it("resolves scalar and thinking-derived kwargs without undefined values", () => {
    const model = makeModel("chat-template");
    const params = buildOpenAICompletionsParams(model, context, {
      reasoningEffort: "high",
    }) as unknown as { chat_template_kwargs?: Record<string, unknown> };

    expect(params.chat_template_kwargs).toEqual({
      static_string: "value",
      static_number: 7,
      static_boolean: true,
      static_null: null,
      enabled: true,
      effort: "maximum",
      only_when_on: "maximum",
    });
    expect(Object.values(params.chat_template_kwargs ?? {})).not.toContain(
      undefined,
    );
  });

  it("omits unavailable effort values and honors omitWhenOff", () => {
    const model = makeModel("chat-template");
    const params = buildOpenAICompletionsParams(
      model,
      context,
    ) as unknown as { chat_template_kwargs?: Record<string, unknown> };

    expect(params.chat_template_kwargs).toEqual({
      static_string: "value",
      static_number: 7,
      static_boolean: true,
      static_null: null,
      enabled: false,
    });
    expect(params.chat_template_kwargs).not.toHaveProperty("effort");
    expect(params.chat_template_kwargs).not.toHaveProperty("only_when_on");
  });

  it("merges custom kwargs while preserving required Qwen defaults", () => {
    const model = makeModel("qwen-chat-template");
    model.compat = {
      ...model.compat,
      chatTemplateKwargs: {
        custom: "configured",
        enable_thinking: false,
        preserve_thinking: false,
      },
    };
    const params = buildOpenAICompletionsParams(model, context, {
      reasoningEffort: "high",
    }) as unknown as { chat_template_kwargs?: Record<string, unknown> };

    expect(params.chat_template_kwargs).toEqual({
      custom: "configured",
      enable_thinking: true,
      preserve_thinking: true,
    });
  });
});

describe("openai-completions prompt cache affinity", () => {
  it("uses the broader prompt cache key for Fireworks gateway requests", () => {
    const params = buildOpenAICompletionsParams(fireworksModel, context, {
      sessionId: "general-thread-1",
      promptCacheKey: "conversation-1",
    }) as unknown as { prompt_cache_key?: string };

    expect(params.prompt_cache_key).toBe("conversation-1");
  });

  it("omits Fireworks cache affinity when retention is disabled", () => {
    const params = buildOpenAICompletionsParams(fireworksModel, context, {
      sessionId: "general-thread-1",
      promptCacheKey: "conversation-1",
      cacheRetention: "none",
    }) as unknown as { prompt_cache_key?: string };

    expect(params.prompt_cache_key).toBeUndefined();
  });
});

describe("openai-completions tool schema compatibility", () => {
  it("removes root combinators without mutating the execution schema", () => {
    const parameters = {
      type: "object" as const,
      properties: {
        prompt: { type: "string" },
        payload: {
          anyOf: [{ type: "string" }, { type: "number" }],
        },
      },
      required: ["prompt"],
      allOf: [{ not: { required: ["tooManyReferences"] } }],
    };
    const toolContext: Context = {
      messages: [],
      tools: [
        {
          name: "image_gen",
          description: "Generate an image",
          parameters,
        },
      ],
    };

    const openRouterModel = {
      ...makeModel("chat-template"),
      id: "anthropic/claude-opus-5",
      provider: "openrouter",
      baseUrl: "https://openrouter.ai/api/v1",
    };
    const params = buildOpenAICompletionsParams(
      openRouterModel,
      toolContext,
    ) as unknown as {
      tools: Array<{
        function: { parameters: Record<string, unknown> };
      }>;
    };
    const outbound = params.tools[0]!.function.parameters;

    expect(outbound).not.toHaveProperty("allOf");
    expect(outbound).not.toHaveProperty("oneOf");
    expect(outbound).not.toHaveProperty("anyOf");
    expect(outbound).toMatchObject({
      type: "object",
      required: ["prompt"],
      properties: {
        payload: { anyOf: [{ type: "string" }, { type: "number" }] },
      },
    });
    expect(parameters).toHaveProperty("allOf");
  });
});
