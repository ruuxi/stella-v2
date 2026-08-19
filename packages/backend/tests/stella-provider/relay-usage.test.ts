import { describe, expect, it } from "bun:test";

import { createRelayUsageParser } from "../../convex/stella_provider/relay_usage";

const feed = (
  parser: ReturnType<typeof createRelayUsageParser>,
  chunks: string[],
) => {
  for (const chunk of chunks) {
    parser.pushText(chunk);
  }
  return parser.finish();
};

describe("createRelayUsageParser", () => {
  describe("anthropic", () => {
    it("extracts usage and model from message_start + message_delta", () => {
      const parser = createRelayUsageParser("anthropic");
      const usage = feed(parser, [
        `event: message_start\ndata: ${JSON.stringify({
          type: "message_start",
          message: {
            id: "msg_1",
            model: "claude-opus-5",
            usage: { input_tokens: 100, cache_read_input_tokens: 40 },
          },
        })}\n\n`,
        `event: message_delta\ndata: ${JSON.stringify({
          type: "message_delta",
          delta: { stop_reason: "end_turn" },
          usage: { output_tokens: 50 },
        })}\n\n`,
      ]);

      // Anthropic's `input_tokens` excludes the cache buckets; the parser
      // reports gross input (100 + 40) so billing's subtraction lands on the
      // 100 uncached tokens instead of clamping to zero.
      expect(usage).toEqual({
        model: "claude-opus-5",
        inputTokens: 140,
        outputTokens: 50,
        cachedInputTokens: 40,
      });
    });

    it("folds cache writes into gross input", () => {
      const parser = createRelayUsageParser("anthropic");
      const usage = feed(parser, [
        `event: message_start\ndata: ${JSON.stringify({
          type: "message_start",
          message: {
            model: "claude-opus-5",
            usage: {
              input_tokens: 200,
              cache_read_input_tokens: 5_000,
              cache_creation_input_tokens: 1_200,
            },
          },
        })}\n\n`,
      ]);

      expect(usage?.inputTokens).toBe(6_400);
      expect(usage?.cachedInputTokens).toBe(5_000);
      expect(usage?.cacheWriteInputTokens).toBe(1_200);
    });

    it("keeps gross input correct when message_delta repeats input_tokens alone", () => {
      // Cache counts arrive only on message_start, so the gross conversion has
      // to run after the stream's fields merge, not per event.
      const parser = createRelayUsageParser("anthropic");
      const usage = feed(parser, [
        `event: message_start\ndata: ${JSON.stringify({
          type: "message_start",
          message: {
            model: "claude-opus-5",
            usage: { input_tokens: 100, cache_read_input_tokens: 40 },
          },
        })}\n\n`,
        `event: message_delta\ndata: ${JSON.stringify({
          type: "message_delta",
          usage: { input_tokens: 100, output_tokens: 50 },
        })}\n\n`,
      ]);

      expect(usage?.inputTokens).toBe(140);
      expect(usage?.outputTokens).toBe(50);
    });

    it("survives a usage chunk split across pushText calls", () => {
      const parser = createRelayUsageParser("anthropic");
      const payload = `event: message_start\ndata: ${JSON.stringify({
        type: "message_start",
        message: { model: "claude-opus-5", usage: { input_tokens: 12 } },
      })}\n\n`;
      const half = Math.floor(payload.length / 2);
      const usage = feed(parser, [payload.slice(0, half), payload.slice(half)]);
      expect(usage?.inputTokens).toBe(12);
      expect(usage?.model).toBe("claude-opus-5");
    });
  });

  describe("openai chat completions", () => {
    it("extracts usage from the terminal chunk with stream_options.include_usage", () => {
      const parser = createRelayUsageParser("openrouter");
      const usage = feed(parser, [
        `data: ${JSON.stringify({
          id: "chatcmpl",
          model: "openai/gpt-5.5",
          choices: [{ index: 0, delta: { content: "hi" } }],
        })}\n\n`,
        `data: ${JSON.stringify({
          id: "chatcmpl",
          model: "openai/gpt-5.5",
          choices: [],
          usage: {
            prompt_tokens: 30,
            completion_tokens: 7,
            total_tokens: 37,
            prompt_tokens_details: { cached_tokens: 4 },
            completion_tokens_details: { reasoning_tokens: 2 },
          },
        })}\n\n`,
        "data: [DONE]\n\n",
      ]);

      expect(usage).toEqual({
        model: "openai/gpt-5.5",
        inputTokens: 30,
        outputTokens: 7,
        totalTokens: 37,
        cachedInputTokens: 4,
        reasoningTokens: 2,
      });
    });

    it("ignores non-JSON heartbeat comments", () => {
      const parser = createRelayUsageParser("openrouter");
      const usage = feed(parser, [
        ": keepalive\n\n",
        `data: ${JSON.stringify({
          model: "openai/gpt-5.5",
          usage: { prompt_tokens: 1, completion_tokens: 2 },
        })}\n\n`,
      ]);
      expect(usage?.inputTokens).toBe(1);
      expect(usage?.outputTokens).toBe(2);
    });
  });

  describe("openai responses", () => {
    it("reads usage off response.completed", () => {
      const parser = createRelayUsageParser("openai");
      const usage = feed(parser, [
        `data: ${JSON.stringify({
          type: "response.completed",
          response: {
            id: "resp_1",
            model: "gpt-5.5",
            usage: {
              input_tokens: 11,
              output_tokens: 22,
              total_tokens: 33,
              input_tokens_details: { cached_tokens: 5 },
              output_tokens_details: { reasoning_tokens: 9 },
            },
          },
        })}\n\n`,
      ]);

      expect(usage).toEqual({
        model: "gpt-5.5",
        inputTokens: 11,
        outputTokens: 22,
        totalTokens: 33,
        cachedInputTokens: 5,
        reasoningTokens: 9,
      });
    });
  });

  describe("crof", () => {
    it("captures token buckets and exact provider-reported cost", () => {
      const parser = createRelayUsageParser("crof");
      const usage = feed(parser, [
        `data: ${JSON.stringify({
          model: "deepseek-v4-flash-0731",
          choices: [],
          usage: {
            prompt_tokens: 49,
            completion_tokens: 4,
            reasoning_tokens: 1,
            total_tokens: 53,
            prompt_tokens_details: { cached_tokens: 7 },
            cost: 0.0000067536,
          },
        })}\n\n`,
        "data: [DONE]\n\n",
      ]);

      expect(usage).toEqual({
        model: "deepseek-v4-flash-0731",
        inputTokens: 49,
        outputTokens: 4,
        totalTokens: 53,
        cachedInputTokens: 7,
        reasoningTokens: 1,
        costMicroCents: 675,
      });
    });
  });

  describe("deepseek", () => {
    it("reads cached_tokens off a streamed Responses event", () => {
      const parser = createRelayUsageParser("deepseek");
      const usage = feed(parser, [
        `data: ${JSON.stringify({
          type: "response.completed",
          response: {
            model: "deepseek-v4-flash",
            usage: {
              input_tokens: 4096,
              output_tokens: 120,
              total_tokens: 4216,
              input_tokens_details: { cached_tokens: 3968 },
              output_tokens_details: { reasoning_tokens: 80 },
            },
          },
        })}\n\n`,
      ]);

      expect(usage).toEqual({
        model: "deepseek-v4-flash",
        inputTokens: 4096,
        outputTokens: 120,
        totalTokens: 4216,
        cachedInputTokens: 3968,
        reasoningTokens: 80,
      });
    });

    it("reads cached_tokens off a non-streamed Responses body", () => {
      // Plain JSON, so usage sits at the top level with no `response`
      // envelope — the parser has to pick its shape from the usage fields.
      const parser = createRelayUsageParser("deepseek");
      const usage = feed(parser, [
        JSON.stringify({
          id: "resp_1",
          object: "response",
          model: "deepseek-v4-flash",
          usage: {
            input_tokens: 200,
            output_tokens: 30,
            total_tokens: 230,
            input_tokens_details: { cached_tokens: 128 },
          },
        }),
      ]);

      expect(usage).toEqual({
        model: "deepseek-v4-flash",
        inputTokens: 200,
        outputTokens: 30,
        totalTokens: 230,
        cachedInputTokens: 128,
        cacheWriteInputTokens: undefined,
        reasoningTokens: undefined,
      });
    });

    it("reads prompt_cache_hit_tokens off chat completions", () => {
      // DeepSeek reports chat-completions cache hits at the top level rather
      // than under prompt_tokens_details, and `prompt_tokens` is already
      // gross (hit + miss). Missing this bills every cached read at full rate.
      const parser = createRelayUsageParser("deepseek");
      const usage = feed(parser, [
        `data: ${JSON.stringify({
          model: "deepseek-v4-flash",
          usage: {
            prompt_tokens: 1000,
            completion_tokens: 40,
            total_tokens: 1040,
            prompt_cache_hit_tokens: 960,
            prompt_cache_miss_tokens: 40,
            completion_tokens_details: { reasoning_tokens: 25 },
          },
        })}\n\n`,
      ]);

      expect(usage).toMatchObject({
        model: "deepseek-v4-flash",
        inputTokens: 1000,
        outputTokens: 40,
        totalTokens: 1040,
        cachedInputTokens: 960,
        reasoningTokens: 25,
      });
    });
  });

  describe("xAI", () => {
    it("parses direct chat-completions usage", () => {
      const parser = createRelayUsageParser("xai");
      const usage = feed(parser, [
        `data: ${JSON.stringify({
          model: "grok-4.5",
          usage: {
            prompt_tokens: 12,
            completion_tokens: 8,
            total_tokens: 20,
            prompt_tokens_details: { cached_tokens: 3 },
            completion_tokens_details: { reasoning_tokens: 5 },
          },
        })}\n\n`,
      ]);

      expect(usage).toEqual({
        model: "grok-4.5",
        inputTokens: 12,
        outputTokens: 8,
        totalTokens: 20,
        cachedInputTokens: 3,
        reasoningTokens: 5,
      });
    });

    it("parses direct Responses usage", () => {
      const parser = createRelayUsageParser("xai");
      const usage = feed(parser, [
        `data: ${JSON.stringify({
          type: "response.completed",
          response: {
            model: "grok-4.5",
            usage: {
              input_tokens: 14,
              output_tokens: 9,
              total_tokens: 23,
              input_tokens_details: { cached_tokens: 4 },
              output_tokens_details: { reasoning_tokens: 6 },
            },
          },
        })}\n\n`,
      ]);

      expect(usage).toEqual({
        model: "grok-4.5",
        inputTokens: 14,
        outputTokens: 9,
        totalTokens: 23,
        cachedInputTokens: 4,
        reasoningTokens: 6,
      });
    });
  });

  describe("google", () => {
    it("derives totalTokens when only per-bucket counts are present", () => {
      const parser = createRelayUsageParser("google");
      const usage = feed(parser, [
        `data: ${JSON.stringify({
          modelVersion: "gemini-3.6-flash",
          usageMetadata: {
            promptTokenCount: 10,
            candidatesTokenCount: 20,
            thoughtsTokenCount: 5,
            cachedContentTokenCount: 3,
          },
        })}\n\n`,
      ]);

      // `candidatesTokenCount` excludes thinking, so output is reported as
      // 20 + 5 to keep it inclusive of `reasoningTokens`.
      expect(usage).toEqual({
        model: "gemini-3.6-flash",
        inputTokens: 10,
        outputTokens: 25,
        reasoningTokens: 5,
        cachedInputTokens: 3,
        totalTokens: 35,
      });
    });

    it("keeps output above reasoning when thinking dominates the response", () => {
      const parser = createRelayUsageParser("google");
      const usage = feed(parser, [
        `data: ${JSON.stringify({
          modelVersion: "gemini-3.6-flash",
          usageMetadata: {
            promptTokenCount: 100,
            candidatesTokenCount: 300,
            thoughtsTokenCount: 4_000,
          },
        })}\n\n`,
      ]);

      expect(usage?.outputTokens).toBe(4_300);
      expect(usage?.reasoningTokens).toBe(4_000);
    });
  });

  it("returns null when no usage events arrived", () => {
    const parser = createRelayUsageParser("anthropic");
    expect(feed(parser, ["data: [DONE]\n\n"])).toBeNull();
  });
});
