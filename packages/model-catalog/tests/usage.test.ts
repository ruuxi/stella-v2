import { describe, expect, it } from "bun:test";

import { createRelayUsageParser } from "@stella/model-catalog/usage";

const feed = (
  parser: ReturnType<typeof createRelayUsageParser>,
  chunks: string[],
) => {
  for (const chunk of chunks) {
    parser.pushText(chunk);
  }
  return parser.finish();
};

const sse = (event: string, payload: unknown) =>
  `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;

describe("createRelayUsageParser: anthropic", () => {
  it("extracts usage and model from message_start + message_delta as gross input", () => {
    const usage = feed(createRelayUsageParser("anthropic"), [
      sse("message_start", {
        type: "message_start",
        message: {
          id: "msg_1",
          model: "claude-opus-5",
          usage: { input_tokens: 100, cache_read_input_tokens: 40 },
        },
      }),
      sse("message_delta", {
        type: "message_delta",
        delta: { stop_reason: "end_turn" },
        usage: { output_tokens: 50 },
      }),
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
    const usage = feed(createRelayUsageParser("anthropic"), [
      sse("message_start", {
        type: "message_start",
        message: {
          model: "claude-opus-5",
          usage: {
            input_tokens: 200,
            cache_read_input_tokens: 5_000,
            cache_creation_input_tokens: 1_200,
          },
        },
      }),
    ]);

    expect(usage?.inputTokens).toBe(6_400);
    expect(usage?.cachedInputTokens).toBe(5_000);
    expect(usage?.cacheWriteInputTokens).toBe(1_200);
  });

  it("keeps gross input correct when message_delta repeats input_tokens alone", () => {
    // Cache counts arrive only on message_start, so the gross conversion has
    // to run after the stream's fields merge, not per event.
    const usage = feed(createRelayUsageParser("anthropic"), [
      sse("message_start", {
        type: "message_start",
        message: {
          model: "claude-opus-5",
          usage: { input_tokens: 100, cache_read_input_tokens: 40 },
        },
      }),
      sse("message_delta", {
        type: "message_delta",
        usage: { input_tokens: 100, output_tokens: 50 },
      }),
    ]);

    expect(usage?.inputTokens).toBe(140);
    expect(usage?.outputTokens).toBe(50);
  });

  it("survives a usage chunk split across pushText calls", () => {
    const payload = sse("message_start", {
      type: "message_start",
      message: { model: "claude-opus-5", usage: { input_tokens: 12 } },
    });
    const half = Math.floor(payload.length / 2);
    const usage = feed(createRelayUsageParser("anthropic"), [
      payload.slice(0, half),
      payload.slice(half),
    ]);
    expect(usage?.inputTokens).toBe(12);
    expect(usage?.model).toBe("claude-opus-5");
  });

  it("meters a non-streaming Messages JSON body", () => {
    const usage = feed(createRelayUsageParser("anthropic"), [
      JSON.stringify({
        id: "msg_1",
        type: "message",
        model: "claude-opus-5",
        usage: {
          input_tokens: 30,
          output_tokens: 9,
          cache_read_input_tokens: 10,
        },
      }),
    ]);
    expect(usage).toEqual({
      model: "claude-opus-5",
      inputTokens: 40,
      outputTokens: 9,
      cachedInputTokens: 10,
    });
  });
});

describe("createRelayUsageParser: google", () => {
  it("derives totalTokens and folds thinking back into output", () => {
    const usage = feed(createRelayUsageParser("google"), [
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
    const usage = feed(createRelayUsageParser("google"), [
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

  it("prefers the reported totalTokenCount over the derived sum", () => {
    const usage = feed(createRelayUsageParser("google"), [
      `data: ${JSON.stringify({
        usageMetadata: {
          promptTokenCount: 10,
          candidatesTokenCount: 20,
          totalTokenCount: 31,
        },
      })}\n\n`,
    ]);
    expect(usage?.totalTokens).toBe(31);
  });
});

describe("createRelayUsageParser: openai-compatible", () => {
  it("exposes usage from complete events before the stream finishes", () => {
    const parser = createRelayUsageParser("crof");
    parser.pushText(
      `data: ${JSON.stringify({
        usage: { prompt_tokens: 3, completion_tokens: 5 },
      })}\n\n`,
    );
    expect(parser.current()).toMatchObject({
      inputTokens: 3,
      outputTokens: 5,
    });
  });

  it("reads Responses usage off response.completed for the Muse default", () => {
    const usage = feed(createRelayUsageParser("openrouter"), [
      `data: ${JSON.stringify({ type: "response.created", response: { id: "resp_1" } })}\n\n`,
      `data: ${JSON.stringify({
        type: "response.completed",
        response: {
          id: "resp_1",
          model: "meta/muse-spark-1.2-contributor",
          usage: {
            input_tokens: 11,
            output_tokens: 22,
            total_tokens: 33,
            output_tokens_details: { reasoning_tokens: 9 },
          },
        },
      })}\n\n`,
      "data: [DONE]\n\n",
    ]);

    expect(usage).toEqual({
      model: "meta/muse-spark-1.2-contributor",
      inputTokens: 11,
      outputTokens: 22,
      totalTokens: 33,
      reasoningTokens: 9,
    });
  });

  it("captures Crof token buckets and exact provider-reported cost", () => {
    const usage = feed(createRelayUsageParser("crof"), [
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

  it("reads DeepSeek's top-level prompt_cache_hit_tokens off chat completions", () => {
    const usage = feed(createRelayUsageParser("deepseek"), [
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

it("returns null when no usage events arrived", () => {
  expect(
    feed(createRelayUsageParser("anthropic"), ["data: [DONE]\n\n"]),
  ).toBeNull();
  expect(
    feed(createRelayUsageParser("google"), [": keepalive\n\n"]),
  ).toBeNull();
});
