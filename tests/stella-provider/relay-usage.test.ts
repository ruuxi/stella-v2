import { describe, expect, it } from "bun:test";

import { createRelayUsageParser } from "../../convex/stella_provider/relay_usage";

const feed = (parser: ReturnType<typeof createRelayUsageParser>, chunks: string[]) => {
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
            model: "claude-opus-4-8",
            usage: { input_tokens: 100, cache_read_input_tokens: 40 },
          },
        })}\n\n`,
        `event: message_delta\ndata: ${JSON.stringify({
          type: "message_delta",
          delta: { stop_reason: "end_turn" },
          usage: { output_tokens: 50 },
        })}\n\n`,
      ]);

      expect(usage).toEqual({
        model: "claude-opus-4-8",
        inputTokens: 100,
        outputTokens: 50,
        cachedInputTokens: 40,
      });
    });

    it("survives a usage chunk split across pushText calls", () => {
      const parser = createRelayUsageParser("anthropic");
      const payload = `event: message_start\ndata: ${JSON.stringify({
        type: "message_start",
        message: { model: "claude-opus-4-8", usage: { input_tokens: 12 } },
      })}\n\n`;
      const half = Math.floor(payload.length / 2);
      const usage = feed(parser, [payload.slice(0, half), payload.slice(half)]);
      expect(usage?.inputTokens).toBe(12);
      expect(usage?.model).toBe("claude-opus-4-8");
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

  describe("google", () => {
    it("derives totalTokens when only per-bucket counts are present", () => {
      const parser = createRelayUsageParser("google");
      const usage = feed(parser, [
        `data: ${JSON.stringify({
          modelVersion: "gemini-3-flash-preview",
          usageMetadata: {
            promptTokenCount: 10,
            candidatesTokenCount: 20,
            thoughtsTokenCount: 5,
            cachedContentTokenCount: 3,
          },
        })}\n\n`,
      ]);

      expect(usage).toEqual({
        model: "gemini-3-flash-preview",
        inputTokens: 10,
        outputTokens: 20,
        reasoningTokens: 5,
        cachedInputTokens: 3,
        totalTokens: 35,
      });
    });
  });

  it("returns null when no usage events arrived", () => {
    const parser = createRelayUsageParser("anthropic");
    expect(feed(parser, ["data: [DONE]\n\n"])).toBeNull();
  });
});
