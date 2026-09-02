import { describe, expect, test } from "bun:test";
import { createRelayUsageParser } from "@stella/model-catalog/usage";
import { createAnthropicAssembler } from "../src/assemble/anthropic.js";
import { createGoogleAssembler } from "../src/assemble/google.js";
import { createOpenAICompletionsAssembler } from "../src/assemble/openai-completions.js";
import { createOpenAIResponsesAssembler } from "../src/assemble/openai-responses.js";
import { createSseParser, type SseFrame } from "../src/assemble/sse.js";
import type { Assembler } from "../src/assemble/types.js";
import { sseText, type SseFixtureFrame } from "./helpers/env.js";

/** Feed a fixture through the real SSE parser in uneven chunks, then assemble. */
const assemble = (assembler: Assembler, text: string, chunkSize = 11) => {
  const parser = createSseParser();
  for (let offset = 0; offset < text.length; offset += chunkSize) {
    for (const frame of parser.push(text.slice(offset, offset + chunkSize)))
      assembler.push(frame);
  }
  for (const frame of parser.finish()) assembler.push(frame);
  return assembler.finish();
};

const parseAll = (text: string, chunkSize = 5): SseFrame[] => {
  const parser = createSseParser();
  const frames: SseFrame[] = [];
  for (let offset = 0; offset < text.length; offset += chunkSize) {
    frames.push(...parser.push(text.slice(offset, offset + chunkSize)));
  }
  frames.push(...parser.finish());
  return frames;
};

describe("SSE parser", () => {
  test("handles CRLF, comments, multi-line data, ids, a BOM, and a missing trailing blank line", () => {
    const text =
      "﻿: keep-alive\r\n" +
      "event: ping\r\ndata: {}\r\n\r\n" +
      "id: 7\r\ndata: first line\r\ndata: second line\r\n\r\n" +
      "data:no-space\n\n" +
      "data: tail-without-blank-line";
    expect(parseAll(text)).toEqual([
      { event: "ping", data: "{}", id: undefined },
      { event: undefined, data: "first line\nsecond line", id: "7" },
      { event: undefined, data: "no-space", id: "7" },
      { event: undefined, data: "tail-without-blank-line", id: "7" },
    ]);
  });

  test("never splits a CRLF pair or a multi-byte character across chunks", () => {
    const text = "data: héllo 🌍\r\n\r\ndata: done\r\n\r\n";
    for (const chunkSize of [1, 2, 3, 4, 5, 13]) {
      expect(parseAll(text, chunkSize).map((frame) => frame.data)).toEqual([
        "héllo 🌍",
        "done",
      ]);
    }
  });

  test("a frame with only event/id fields and no data is not dispatched", () => {
    expect(
      parseAll("event: nothing\n\nid: 1\n\ndata: x\n\n").map(
        (frame) => frame.data,
      ),
    ).toEqual(["x"]);
  });
});

describe("anthropic-messages assembly", () => {
  const fixture: SseFixtureFrame[] = [
    {
      event: "message_start",
      data: {
        type: "message_start",
        message: {
          id: "msg_01",
          type: "message",
          role: "assistant",
          model: "claude-opus-5",
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: {
            input_tokens: 25,
            cache_creation_input_tokens: 4,
            cache_read_input_tokens: 6,
            output_tokens: 1,
          },
        },
      },
    },
    {
      event: "content_block_start",
      data: {
        type: "content_block_start",
        index: 0,
        content_block: { type: "thinking", thinking: "" },
      },
    },
    {
      event: "content_block_delta",
      data: {
        type: "content_block_delta",
        index: 0,
        delta: { type: "thinking_delta", thinking: "Let me think" },
      },
    },
    {
      event: "content_block_delta",
      data: {
        type: "content_block_delta",
        index: 0,
        delta: { type: "thinking_delta", thinking: " about this." },
      },
    },
    {
      event: "content_block_delta",
      data: {
        type: "content_block_delta",
        index: 0,
        delta: { type: "signature_delta", signature: "sig-abc" },
      },
    },
    {
      event: "content_block_stop",
      data: { type: "content_block_stop", index: 0 },
    },
    {
      event: "content_block_start",
      data: {
        type: "content_block_start",
        index: 1,
        content_block: { type: "text", text: "" },
      },
    },
    { event: "ping", data: { type: "ping" } },
    {
      event: "content_block_delta",
      data: {
        type: "content_block_delta",
        index: 1,
        delta: { type: "text_delta", text: "I'll check the weather" },
      },
    },
    {
      event: "content_block_delta",
      data: {
        type: "content_block_delta",
        index: 1,
        delta: { type: "text_delta", text: " for you." },
      },
    },
    {
      event: "content_block_delta",
      data: {
        type: "content_block_delta",
        index: 1,
        delta: {
          type: "citations_delta",
          citation: {
            type: "char_location",
            cited_text: "sunny",
            document_index: 0,
          },
        },
      },
    },
    {
      event: "content_block_stop",
      data: { type: "content_block_stop", index: 1 },
    },
    {
      event: "content_block_start",
      data: {
        type: "content_block_start",
        index: 2,
        content_block: {
          type: "tool_use",
          id: "toolu_01",
          name: "get_weather",
          input: {},
        },
      },
    },
    {
      event: "content_block_delta",
      data: {
        type: "content_block_delta",
        index: 2,
        delta: { type: "input_json_delta", partial_json: "" },
      },
    },
    {
      event: "content_block_delta",
      data: {
        type: "content_block_delta",
        index: 2,
        delta: { type: "input_json_delta", partial_json: '{"location": "San' },
      },
    },
    {
      event: "content_block_delta",
      data: {
        type: "content_block_delta",
        index: 2,
        delta: {
          type: "input_json_delta",
          partial_json: ' Francisco", "unit": "c"}',
        },
      },
    },
    {
      event: "content_block_stop",
      data: { type: "content_block_stop", index: 2 },
    },
    {
      event: "content_block_start",
      data: {
        type: "content_block_start",
        index: 3,
        content_block: {
          type: "tool_use",
          id: "toolu_02",
          name: "noop",
          input: {},
        },
      },
    },
    {
      event: "content_block_stop",
      data: { type: "content_block_stop", index: 3 },
    },
    {
      event: "message_delta",
      data: {
        type: "message_delta",
        delta: { stop_reason: "tool_use", stop_sequence: null },
        usage: { output_tokens: 89 },
      },
    },
    { event: "message_stop", data: { type: "message_stop" } },
  ];

  test("folds thinking, text, citations, and tool input into one Message", () => {
    const outcome = assemble(createAnthropicAssembler(), sseText(fixture));
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.body).toEqual({
      id: "msg_01",
      type: "message",
      role: "assistant",
      model: "claude-opus-5",
      content: [
        {
          type: "thinking",
          thinking: "Let me think about this.",
          signature: "sig-abc",
        },
        {
          type: "text",
          text: "I'll check the weather for you.",
          citations: [
            { type: "char_location", cited_text: "sunny", document_index: 0 },
          ],
        },
        {
          type: "tool_use",
          id: "toolu_01",
          name: "get_weather",
          input: { location: "San Francisco", unit: "c" },
        },
        { type: "tool_use", id: "toolu_02", name: "noop", input: {} },
      ],
      stop_reason: "tool_use",
      stop_sequence: null,
      usage: {
        input_tokens: 25,
        cache_creation_input_tokens: 4,
        cache_read_input_tokens: 6,
        output_tokens: 89,
      },
    });
  });

  test("the usage parser reports gross input including both cache buckets", () => {
    const parser = createRelayUsageParser("anthropic");
    parser.pushText(sseText(fixture));
    expect(parser.finish()).toEqual({
      model: "claude-opus-5",
      inputTokens: 35,
      outputTokens: 89,
      cachedInputTokens: 6,
      cacheWriteInputTokens: 4,
    });
  });

  test("an error event fails the assembly with the provider's message", () => {
    const outcome = assemble(
      createAnthropicAssembler(),
      sseText([
        fixture[0]!,
        {
          event: "error",
          data: {
            type: "error",
            error: { type: "overloaded_error", message: "Overloaded" },
          },
        },
      ]),
    );
    expect(outcome).toMatchObject({ ok: false, message: "Overloaded" });
  });

  test("a stream that ends before message_stop is not a result", () => {
    const outcome = assemble(
      createAnthropicAssembler(),
      sseText(fixture.slice(0, -1)),
    );
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.message).toContain("message_stop");
  });
});

describe("openai-responses assembly", () => {
  const completed = {
    id: "resp_1",
    object: "response",
    status: "completed",
    model: "gpt-5.6-luna",
    output: [
      {
        type: "reasoning",
        id: "rs_1",
        summary: [{ type: "summary_text", text: "Plan the call." }],
      },
      {
        type: "function_call",
        id: "fc_1",
        call_id: "call_1",
        name: "get_weather",
        arguments: '{"city":"Paris"}',
        status: "completed",
      },
      {
        type: "message",
        id: "msg_1",
        role: "assistant",
        status: "completed",
        content: [
          { type: "output_text", text: "Checking Paris.", annotations: [] },
        ],
      },
    ],
    usage: {
      input_tokens: 40,
      output_tokens: 30,
      total_tokens: 70,
      input_tokens_details: { cached_tokens: 8 },
      output_tokens_details: { reasoning_tokens: 12 },
    },
  };
  const fixture: SseFixtureFrame[] = [
    {
      event: "response.created",
      data: {
        type: "response.created",
        sequence_number: 0,
        response: {
          ...completed,
          status: "in_progress",
          output: [],
          usage: null,
        },
      },
    },
    {
      event: "response.output_item.added",
      data: {
        type: "response.output_item.added",
        output_index: 0,
        item: { type: "reasoning", id: "rs_1", summary: [] },
      },
    },
    {
      event: "response.reasoning_summary_text.delta",
      data: {
        type: "response.reasoning_summary_text.delta",
        delta: "Plan the call.",
      },
    },
    {
      event: "response.output_item.added",
      data: {
        type: "response.output_item.added",
        output_index: 1,
        item: {
          type: "function_call",
          id: "fc_1",
          call_id: "call_1",
          name: "get_weather",
          arguments: "",
        },
      },
    },
    {
      event: "response.function_call_arguments.delta",
      data: {
        type: "response.function_call_arguments.delta",
        delta: '{"city":',
      },
    },
    {
      event: "response.function_call_arguments.delta",
      data: {
        type: "response.function_call_arguments.delta",
        delta: '"Paris"}',
      },
    },
    {
      event: "response.output_text.delta",
      data: { type: "response.output_text.delta", delta: "Checking Paris." },
    },
    {
      event: "response.completed",
      data: {
        type: "response.completed",
        sequence_number: 12,
        response: completed,
      },
    },
  ];

  test("returns the response object from the terminal event", () => {
    const outcome = assemble(
      createOpenAIResponsesAssembler(),
      sseText(fixture),
    );
    expect(outcome).toEqual({ ok: true, body: completed });
  });

  test("a failed response is returned as the provider's failed object", () => {
    const failed = {
      ...completed,
      status: "failed",
      output: [],
      error: { code: "server_error", message: "boom" },
    };
    const outcome = assemble(
      createOpenAIResponsesAssembler(),
      sseText([
        fixture[0]!,
        {
          event: "response.failed",
          data: { type: "response.failed", response: failed },
        },
      ]),
    );
    expect(outcome).toEqual({ ok: true, body: failed });
  });

  test("an error event or a missing terminal event is a failure", () => {
    expect(
      assemble(
        createOpenAIResponsesAssembler(),
        sseText([
          fixture[0]!,
          {
            event: "error",
            data: {
              type: "error",
              code: "rate_limit_exceeded",
              message: "Slow down",
            },
          },
        ]),
      ),
    ).toMatchObject({ ok: false, message: "Slow down" });
    const truncated = assemble(
      createOpenAIResponsesAssembler(),
      sseText(fixture.slice(0, -1)),
    );
    expect(truncated.ok).toBe(false);
  });
});

describe("openai-completions assembly", () => {
  const chunk = (
    delta: Record<string, unknown>,
    finish: string | null = null,
    extra: Record<string, unknown> = {},
  ) => ({
    id: "gen-1",
    object: "chat.completion.chunk",
    created: 1_756_000_000,
    model: "deepseek-v4-flash-0731",
    system_fingerprint: "fp_1",
    choices: [{ index: 0, delta, finish_reason: finish, logprobs: null }],
    ...extra,
  });
  const fixture: SseFixtureFrame[] = [
    { data: chunk({ role: "assistant", content: "", reasoning: "Thinking" }) },
    {
      data: chunk({
        reasoning: " harder",
        reasoning_details: [
          { type: "reasoning.text", text: "Thinking harder" },
        ],
      }),
    },
    { data: chunk({ content: "Let me look" }) },
    { data: chunk({ content: " that up." }) },
    {
      data: chunk({
        tool_calls: [
          {
            index: 0,
            id: "call_1",
            type: "function",
            function: { name: "lookup", arguments: "" },
          },
        ],
      }),
    },
    {
      data: chunk({
        tool_calls: [{ index: 0, function: { arguments: '{"q":' } }],
      }),
    },
    {
      data: chunk({
        tool_calls: [{ index: 0, function: { arguments: '"weather"}' } }],
      }),
    },
    { data: chunk({}, "tool_calls") },
    {
      data: {
        id: "gen-1",
        object: "chat.completion.chunk",
        created: 1_756_000_000,
        model: "deepseek-v4-flash-0731",
        choices: [],
        usage: {
          prompt_tokens: 10,
          completion_tokens: 20,
          total_tokens: 30,
          completion_tokens_details: { reasoning_tokens: 5 },
          cost: 0.00001,
        },
      },
    },
    { data: "[DONE]" },
  ];

  test("merges deltas, tool calls, reasoning, and trailing usage into a ChatCompletion", () => {
    const outcome = assemble(
      createOpenAICompletionsAssembler(),
      sseText(fixture),
    );
    expect(outcome).toEqual({
      ok: true,
      body: {
        id: "gen-1",
        object: "chat.completion",
        created: 1_756_000_000,
        model: "deepseek-v4-flash-0731",
        system_fingerprint: "fp_1",
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: "Let me look that up.",
              reasoning: "Thinking harder",
              reasoning_details: [
                { type: "reasoning.text", text: "Thinking harder" },
              ],
              tool_calls: [
                {
                  id: "call_1",
                  type: "function",
                  function: { name: "lookup", arguments: '{"q":"weather"}' },
                },
              ],
            },
            finish_reason: "tool_calls",
            logprobs: null,
          },
        ],
        usage: {
          prompt_tokens: 10,
          completion_tokens: 20,
          total_tokens: 30,
          completion_tokens_details: { reasoning_tokens: 5 },
          cost: 0.00001,
        },
      },
    });
  });

  test("DeepSeek reasoning_content and content-only completions keep their own fields", () => {
    const outcome = assemble(
      createOpenAICompletionsAssembler(),
      sseText([
        { data: chunk({ role: "assistant", reasoning_content: "step 1" }) },
        { data: chunk({ reasoning_content: ", step 2" }) },
        { data: chunk({ content: "42" }, "stop") },
        { data: "[DONE]" },
      ]),
    );
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    const message = (
      outcome.body.choices as Array<{ message: Record<string, unknown> }>
    )[0]!.message;
    expect(message).toEqual({
      role: "assistant",
      content: "42",
      reasoning_content: "step 1, step 2",
    });
    expect(outcome.body.usage).toBeUndefined();
  });

  test("a mid-stream error frame and a truncated stream both fail", () => {
    expect(
      assemble(
        createOpenAICompletionsAssembler(),
        sseText([
          fixture[0]!,
          {
            data: { error: { message: "Provider returned error", code: 502 } },
          },
        ]),
      ),
    ).toMatchObject({ ok: false, message: "Provider returned error" });
    expect(
      assemble(createOpenAICompletionsAssembler(), sseText(fixture.slice(0, 4)))
        .ok,
    ).toBe(false);
  });

  test("Crof's exact cost survives to the usage parser", () => {
    const parser = createRelayUsageParser("crof");
    parser.pushText(sseText(fixture));
    expect(parser.finish()).toMatchObject({
      inputTokens: 10,
      outputTokens: 20,
      reasoningTokens: 5,
      costMicroCents: 1_000,
    });
  });
});

describe("google-generative-ai assembly", () => {
  const candidate = (
    parts: unknown[],
    extra: Record<string, unknown> = {},
  ) => ({
    candidates: [{ content: { parts, role: "model" }, index: 0, ...extra }],
  });
  const fixture: SseFixtureFrame[] = [
    {
      data: {
        ...candidate([{ text: "Thinking about", thought: true }]),
        usageMetadata: { promptTokenCount: 8, totalTokenCount: 8 },
        modelVersion: "gemini-3.6-flash",
        responseId: "r1",
      },
    },
    {
      data: candidate([
        { text: " the request.", thought: true, thoughtSignature: "sig-a" },
      ]),
    },
    { data: candidate([{ text: "Sure, " }]) },
    { data: candidate([{ text: "calling the tool." }]) },
    {
      data: {
        ...candidate(
          [
            {
              functionCall: { name: "get_weather", args: { city: "Paris" } },
              thoughtSignature: "sig-b",
            },
          ],
          {
            finishReason: "STOP",
            safetyRatings: [
              {
                category: "HARM_CATEGORY_HATE_SPEECH",
                probability: "NEGLIGIBLE",
              },
            ],
          },
        ),
        usageMetadata: {
          promptTokenCount: 8,
          candidatesTokenCount: 12,
          thoughtsTokenCount: 6,
          totalTokenCount: 26,
        },
        modelVersion: "gemini-3.6-flash",
        responseId: "r1",
      },
    },
  ];

  test("merges text runs by thought flag, keeps signatures and function calls whole", () => {
    const outcome = assemble(createGoogleAssembler(), sseText(fixture));
    expect(outcome).toEqual({
      ok: true,
      body: {
        candidates: [
          {
            content: {
              role: "model",
              parts: [
                {
                  text: "Thinking about the request.",
                  thought: true,
                  thoughtSignature: "sig-a",
                },
                { text: "Sure, calling the tool." },
                {
                  functionCall: {
                    name: "get_weather",
                    args: { city: "Paris" },
                  },
                  thoughtSignature: "sig-b",
                },
              ],
            },
            finishReason: "STOP",
            safetyRatings: [
              {
                category: "HARM_CATEGORY_HATE_SPEECH",
                probability: "NEGLIGIBLE",
              },
            ],
            index: 0,
          },
        ],
        usageMetadata: {
          promptTokenCount: 8,
          candidatesTokenCount: 12,
          thoughtsTokenCount: 6,
          totalTokenCount: 26,
        },
        modelVersion: "gemini-3.6-flash",
        responseId: "r1",
      },
    });
  });

  test("a blocked prompt is a valid response without candidates", () => {
    const outcome = assemble(
      createGoogleAssembler(),
      sseText([
        {
          data: {
            promptFeedback: { blockReason: "SAFETY" },
            usageMetadata: { promptTokenCount: 3, totalTokenCount: 3 },
          },
        },
      ]),
    );
    expect(outcome).toEqual({
      ok: true,
      body: {
        promptFeedback: { blockReason: "SAFETY" },
        usageMetadata: { promptTokenCount: 3, totalTokenCount: 3 },
      },
    });
  });

  test("an error frame and a candidate without finishReason both fail", () => {
    expect(
      assemble(
        createGoogleAssembler(),
        sseText([
          {
            data: {
              error: {
                code: 429,
                message: "Resource exhausted",
                status: "RESOURCE_EXHAUSTED",
              },
            },
          },
        ]),
      ),
    ).toMatchObject({ ok: false, message: "Resource exhausted" });
    expect(
      assemble(createGoogleAssembler(), sseText(fixture.slice(0, 3))).ok,
    ).toBe(false);
  });

  test("the usage parser rolls thoughts back into gross output", () => {
    const parser = createRelayUsageParser("google");
    parser.pushText(sseText(fixture));
    expect(parser.finish()).toMatchObject({
      inputTokens: 8,
      outputTokens: 18,
      reasoningTokens: 6,
      totalTokens: 26,
    });
  });
});
