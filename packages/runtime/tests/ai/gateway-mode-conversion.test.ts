import { afterEach, describe, expect, it } from "vitest";

import { streamAnthropic } from "@stella/runtime/ai/providers/anthropic";
import { streamGoogle } from "@stella/runtime/ai/providers/google";
import { streamOpenAICompletions } from "@stella/runtime/ai/providers/openai-completions";
import { streamOpenAIResponses } from "@stella/runtime/ai/providers/openai-responses";
import type {
  AssistantMessage,
  AssistantMessageEventStream,
  Context,
  Model,
} from "@stella/runtime/ai/types";

/**
 * Gateway-mode conversion parity.
 *
 * For each adapter the same completion is served twice: once as the
 * provider's SSE stream against a direct base URL, once as ONE complete
 * provider-native JSON object against the gateway relay base URL. The
 * AssistantMessage assembled from the JSON object must equal the one the
 * streaming path assembles (content, opaque signatures, tool ids, usage and
 * cost), and every content part must arrive as start / exactly one whole
 * delta / end.
 */

const GATEWAY_RELAY = "https://gateway.example.test/v1/relay";
const CAPABILITY = "session-capability";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

type Captured = { url: string; headers: Headers; body: Record<string, any> };

const stubFetch = (respond: {
  relay: () => Response;
  direct: () => Response;
}): Captured[] => {
  const calls: Captured[] = [];
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
    const body =
      typeof init?.body === "string"
        ? (JSON.parse(init.body) as Record<string, any>)
        : {};
    calls.push({ url, headers, body });
    return url.includes("/v1/relay/") ? respond.relay() : respond.direct();
  }) as typeof fetch;
  return calls;
};

const sse = (events: unknown[], eventNames?: string[]) =>
  new Response(
    events
      .map(
        (event, index) =>
          `${eventNames ? `event: ${eventNames[index]}\n` : ""}data: ${JSON.stringify(event)}\n\n`,
      )
      .join("") + (eventNames ? "" : "data: [DONE]\n\n"),
    { status: 200, headers: { "content-type": "text/event-stream" } },
  );

const json = (body: unknown) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

const collect = async (stream: AssistantMessageEventStream) => {
  const events: string[] = [];
  for await (const event of stream) events.push(event.type);
  return { events, result: await stream.result() };
};

/** Streaming emits N deltas per part; gateway emits one. Compare shapes. */
const collapseDeltas = (types: string[]): string[] =>
  types.filter(
    (type, index) => !(type.endsWith("_delta") && types[index - 1] === type),
  );

const comparable = (message: AssistantMessage) => {
  const { timestamp: _timestamp, ...rest } = message;
  return rest;
};

const tools: Context["tools"] = [
  {
    name: "read_file",
    description: "Read a file",
    parameters: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
    } as never,
  },
];

const context: Context = {
  systemPrompt: "Be brief.",
  messages: [{ role: "user", content: "read the file", timestamp: 0 }],
  tools,
};

const cost = { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 };

const modelFor = <TApi extends Model<any>["api"]>(
  base: Omit<Model<TApi>, "baseUrl" | "cost" | "input" | "contextWindow" | "maxTokens">,
  baseUrl: string,
): Model<TApi> => ({
  ...base,
  baseUrl,
  cost,
  input: ["text"],
  contextWindow: 200_000,
  maxTokens: 16_000,
});

const expectGatewayWire = (calls: Captured[]) => {
  const relayCalls = calls.filter((call) => call.url.includes("/v1/relay/"));
  expect(relayCalls).toHaveLength(1);
  const [call] = relayCalls;
  expect(call!.headers.get("authorization")).toBe(`Bearer ${CAPABILITY}`);
  expect(call!.headers.get("x-stella-request-id")).toMatch(/^[0-9a-f-]{36}$/u);
  return call!;
};

describe("Anthropic gateway mode", () => {
  const message = {
    id: "msg_1",
    type: "message",
    role: "assistant",
    model: "claude-opus-4.7",
    content: [
      { type: "thinking", thinking: "Let me think.", signature: "sig_abc" },
      { type: "redacted_thinking", data: "redacted_payload" },
      { type: "text", text: "Hello world" },
      {
        type: "tool_use",
        id: "toolu_1",
        name: "read_file",
        input: { path: "/tmp/a.txt" },
      },
    ],
    stop_reason: "tool_use",
    stop_sequence: null,
    usage: {
      input_tokens: 25,
      output_tokens: 42,
      cache_read_input_tokens: 5,
      cache_creation_input_tokens: 3,
    },
  };

  const streamed = () =>
    sse(
      [
        {
          type: "message_start",
          message: {
            ...message,
            content: [],
            stop_reason: null,
            usage: {
              input_tokens: 25,
              output_tokens: 1,
              cache_read_input_tokens: 5,
              cache_creation_input_tokens: 3,
            },
          },
        },
        {
          type: "content_block_start",
          index: 0,
          content_block: { type: "thinking", thinking: "", signature: "" },
        },
        {
          type: "content_block_delta",
          index: 0,
          delta: { type: "thinking_delta", thinking: "Let me " },
        },
        {
          type: "content_block_delta",
          index: 0,
          delta: { type: "thinking_delta", thinking: "think." },
        },
        {
          type: "content_block_delta",
          index: 0,
          delta: { type: "signature_delta", signature: "sig_abc" },
        },
        { type: "content_block_stop", index: 0 },
        {
          type: "content_block_start",
          index: 1,
          content_block: { type: "redacted_thinking", data: "redacted_payload" },
        },
        { type: "content_block_stop", index: 1 },
        {
          type: "content_block_start",
          index: 2,
          content_block: { type: "text", text: "" },
        },
        {
          type: "content_block_delta",
          index: 2,
          delta: { type: "text_delta", text: "Hello " },
        },
        {
          type: "content_block_delta",
          index: 2,
          delta: { type: "text_delta", text: "world" },
        },
        { type: "content_block_stop", index: 2 },
        {
          type: "content_block_start",
          index: 3,
          content_block: {
            type: "tool_use",
            id: "toolu_1",
            name: "read_file",
            input: {},
          },
        },
        {
          type: "content_block_delta",
          index: 3,
          delta: { type: "input_json_delta", partial_json: '{"path":' },
        },
        {
          type: "content_block_delta",
          index: 3,
          delta: { type: "input_json_delta", partial_json: '"/tmp/a.txt"}' },
        },
        { type: "content_block_stop", index: 3 },
        {
          type: "message_delta",
          delta: { stop_reason: "tool_use", stop_sequence: null },
          usage: { output_tokens: 42 },
        },
        { type: "message_stop" },
      ],
      [
        "message_start",
        "content_block_start",
        "content_block_delta",
        "content_block_delta",
        "content_block_delta",
        "content_block_stop",
        "content_block_start",
        "content_block_stop",
        "content_block_start",
        "content_block_delta",
        "content_block_delta",
        "content_block_stop",
        "content_block_start",
        "content_block_delta",
        "content_block_delta",
        "content_block_stop",
        "message_delta",
        "message_stop",
      ],
    );

  const base = {
    id: "claude-opus-4.7",
    name: "Claude Opus 4.7",
    api: "anthropic-messages" as const,
    provider: "anthropic",
    reasoning: true,
  };

  it("produces the same AssistantMessage from one complete Message as from the SSE stream", async () => {
    const calls = stubFetch({ relay: () => json(message), direct: streamed });

    const direct = await collect(
      streamAnthropic(modelFor(base, "https://api.anthropic.test"), context, {
        apiKey: "sk-ant-test",
        thinkingEnabled: true,
        effort: "high",
      }),
    );
    const gateway = await collect(
      streamAnthropic(modelFor(base, GATEWAY_RELAY), context, {
        apiKey: CAPABILITY,
        thinkingEnabled: true,
        effort: "high",
      }),
    );

    expect(direct.result.stopReason).toBe("toolUse");
    expect(comparable(gateway.result)).toEqual(comparable(direct.result));
    expect(gateway.result.content).toEqual([
      { type: "thinking", thinking: "Let me think.", thinkingSignature: "sig_abc" },
      {
        type: "thinking",
        thinking: "[Reasoning redacted]",
        thinkingSignature: "redacted_payload",
        redacted: true,
      },
      { type: "text", text: "Hello world" },
      {
        type: "toolCall",
        id: "toolu_1",
        name: "read_file",
        arguments: { path: "/tmp/a.txt" },
      },
    ]);
    expect(gateway.result.usage).toMatchObject({
      input: 25,
      output: 42,
      cacheRead: 5,
      cacheWrite: 3,
      totalTokens: 75,
    });
    expect(gateway.result.usage.cost.total).toBeGreaterThan(0);
    expect(gateway.result.responseId).toBe("msg_1");

    expect(collapseDeltas(direct.events)).toEqual(gateway.events);
    expect(gateway.events).toEqual([
      "start",
      "thinking_start",
      "thinking_delta",
      "thinking_end",
      "thinking_start",
      "thinking_end",
      "text_start",
      "text_delta",
      "text_end",
      "toolcall_start",
      "toolcall_delta",
      "toolcall_end",
      "done",
    ]);

    const wire = expectGatewayWire(calls);
    expect(wire.url).toBe(`${GATEWAY_RELAY}/v1/messages`);
    expect(wire.body.stream).toBe(false);
    expect(wire.headers.get("x-api-key")).toBeNull();
    const directCall = calls.find((call) => !call.url.includes("/v1/relay/"));
    expect(directCall?.body.stream).toBe(true);
  });

  it("aborts the in-flight gateway request", async () => {
    const controller = new AbortController();
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          const error = new Error("This operation was aborted");
          error.name = "AbortError";
          reject(error);
        });
        controller.abort();
      })) as typeof fetch;

    const result = await streamAnthropic(modelFor(base, GATEWAY_RELAY), context, {
      apiKey: CAPABILITY,
      signal: controller.signal,
    }).result();

    expect(result.stopReason).toBe("aborted");
    expect(result.content).toEqual([]);
  });
});

describe("OpenAI Responses gateway mode", () => {
  const reasoningItem = {
    type: "reasoning",
    id: "rs_1",
    summary: [{ type: "summary_text", text: "Thinking about it." }],
    encrypted_content: "enc_abc",
  };
  const messageItem = {
    type: "message",
    id: "msg_1",
    role: "assistant",
    status: "completed",
    content: [{ type: "output_text", text: "Hello world", annotations: [] }],
  };
  const functionCallItem = {
    type: "function_call",
    id: "fc_1",
    call_id: "call_1",
    name: "read_file",
    arguments: '{"path":"/tmp/a.txt"}',
    status: "completed",
  };
  const usage = {
    input_tokens: 30,
    output_tokens: 20,
    total_tokens: 50,
    input_tokens_details: { cached_tokens: 10 },
    output_tokens_details: { reasoning_tokens: 8 },
  };
  const response = {
    id: "resp_1",
    object: "response",
    created_at: 1,
    status: "completed",
    model: "gpt-5.5",
    error: null,
    incomplete_details: null,
    output: [reasoningItem, messageItem, functionCallItem],
    usage,
  };

  const streamed = () =>
    sse([
      { type: "response.created", sequence_number: 0, response: { id: "resp_1" } },
      {
        type: "response.output_item.added",
        sequence_number: 1,
        output_index: 0,
        item: { type: "reasoning", id: "rs_1", summary: [] },
      },
      {
        type: "response.reasoning_summary_part.added",
        sequence_number: 2,
        output_index: 0,
        item_id: "rs_1",
        summary_index: 0,
        part: { type: "summary_text", text: "" },
      },
      {
        type: "response.reasoning_summary_text.delta",
        sequence_number: 3,
        output_index: 0,
        item_id: "rs_1",
        summary_index: 0,
        delta: "Thinking ",
      },
      {
        type: "response.reasoning_summary_text.delta",
        sequence_number: 4,
        output_index: 0,
        item_id: "rs_1",
        summary_index: 0,
        delta: "about it.",
      },
      {
        type: "response.reasoning_summary_part.done",
        sequence_number: 5,
        output_index: 0,
        item_id: "rs_1",
        summary_index: 0,
        part: { type: "summary_text", text: "Thinking about it." },
      },
      {
        type: "response.output_item.done",
        sequence_number: 6,
        output_index: 0,
        item: reasoningItem,
      },
      {
        type: "response.output_item.added",
        sequence_number: 7,
        output_index: 1,
        item: { ...messageItem, status: "in_progress", content: [] },
      },
      {
        type: "response.content_part.added",
        sequence_number: 8,
        output_index: 1,
        item_id: "msg_1",
        content_index: 0,
        part: { type: "output_text", text: "", annotations: [] },
      },
      {
        type: "response.output_text.delta",
        sequence_number: 9,
        output_index: 1,
        item_id: "msg_1",
        content_index: 0,
        delta: "Hello ",
      },
      {
        type: "response.output_text.delta",
        sequence_number: 10,
        output_index: 1,
        item_id: "msg_1",
        content_index: 0,
        delta: "world",
      },
      {
        type: "response.output_item.done",
        sequence_number: 11,
        output_index: 1,
        item: messageItem,
      },
      {
        type: "response.output_item.added",
        sequence_number: 12,
        output_index: 2,
        item: { ...functionCallItem, arguments: "", status: "in_progress" },
      },
      {
        type: "response.function_call_arguments.delta",
        sequence_number: 13,
        output_index: 2,
        item_id: "fc_1",
        delta: '{"path":',
      },
      {
        type: "response.function_call_arguments.delta",
        sequence_number: 14,
        output_index: 2,
        item_id: "fc_1",
        delta: '"/tmp/a.txt"}',
      },
      {
        type: "response.function_call_arguments.done",
        sequence_number: 15,
        output_index: 2,
        item_id: "fc_1",
        arguments: '{"path":"/tmp/a.txt"}',
      },
      {
        type: "response.output_item.done",
        sequence_number: 16,
        output_index: 2,
        item: functionCallItem,
      },
      { type: "response.completed", sequence_number: 17, response },
    ]);

  const base = {
    id: "gpt-5.5",
    name: "GPT-5.5",
    api: "openai-responses" as const,
    provider: "openai",
    reasoning: true,
  };

  it("produces the same AssistantMessage from one complete Response as from the SSE stream", async () => {
    const calls = stubFetch({ relay: () => json(response), direct: streamed });

    const direct = await collect(
      streamOpenAIResponses(modelFor(base, "https://api.openai.test/v1"), context, {
        apiKey: "sk-test",
        reasoningEffort: "high",
      }),
    );
    const gateway = await collect(
      streamOpenAIResponses(modelFor(base, GATEWAY_RELAY), context, {
        apiKey: CAPABILITY,
        reasoningEffort: "high",
      }),
    );

    expect(direct.result.stopReason).toBe("toolUse");
    expect(comparable(gateway.result)).toEqual(comparable(direct.result));
    expect(gateway.result.content).toEqual([
      {
        type: "thinking",
        thinking: "Thinking about it.",
        thinkingSignature: JSON.stringify(reasoningItem),
      },
      { type: "text", text: "Hello world", textSignature: '{"v":1,"id":"msg_1"}' },
      {
        type: "toolCall",
        id: "call_1|fc_1",
        name: "read_file",
        arguments: { path: "/tmp/a.txt" },
      },
    ]);
    expect(gateway.result.usage).toMatchObject({
      input: 20,
      output: 20,
      reasoning: 8,
      cacheRead: 10,
      cacheWrite: 0,
      totalTokens: 50,
    });
    expect(gateway.result.usage.cost.total).toBeGreaterThan(0);
    expect(gateway.result.responseId).toBe("resp_1");

    expect(collapseDeltas(direct.events)).toEqual(gateway.events);
    expect(gateway.events).toEqual([
      "start",
      "thinking_start",
      "thinking_delta",
      "thinking_end",
      "text_start",
      "text_delta",
      "text_end",
      "toolcall_start",
      "toolcall_delta",
      "toolcall_end",
      "done",
    ]);

    const wire = expectGatewayWire(calls);
    expect(wire.url).toBe(`${GATEWAY_RELAY}/responses`);
    expect(wire.body.stream).toBe(false);
    expect(wire.body.include).toEqual(["reasoning.encrypted_content"]);
    expect(wire.headers.get("idempotency-key")).toMatch(/^stella-response-/);
  });

  it("maps an incomplete Response to stopReason length", async () => {
    stubFetch({
      relay: () =>
        json({
          ...response,
          status: "incomplete",
          incomplete_details: { reason: "max_output_tokens" },
          output: [messageItem],
        }),
      direct: streamed,
    });

    const result = await streamOpenAIResponses(modelFor(base, GATEWAY_RELAY), context, {
      apiKey: CAPABILITY,
    }).result();

    expect(result.stopReason).toBe("length");
    expect(result.content).toEqual([
      { type: "text", text: "Hello world", textSignature: '{"v":1,"id":"msg_1"}' },
    ]);
  });

  it("surfaces a failed Response as an error with the provider's detail", async () => {
    stubFetch({
      relay: () =>
        json({
          ...response,
          status: "failed",
          output: [],
          error: { code: "server_error", message: "upstream exploded" },
        }),
      direct: streamed,
    });

    const result = await streamOpenAIResponses(modelFor(base, GATEWAY_RELAY), context, {
      apiKey: CAPABILITY,
    }).result();

    expect(result.stopReason).toBe("error");
    expect(result.errorMessage).toContain("upstream exploded");
  });
});

describe("OpenAI Completions gateway mode", () => {
  const reasoningDetail = {
    type: "reasoning.encrypted",
    id: "call_1",
    data: "enc_xyz",
  };
  const usage = {
    prompt_tokens: 40,
    completion_tokens: 15,
    total_tokens: 55,
    prompt_tokens_details: { cached_tokens: 10 },
    completion_tokens_details: { reasoning_tokens: 5 },
  };
  const completion = {
    id: "chatcmpl_1",
    object: "chat.completion",
    created: 1,
    model: "moonshotai/kimi-k2-upstream",
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: "Hello world",
          reasoning: "Consider this.",
          tool_calls: [
            {
              id: "call_1",
              type: "function",
              function: { name: "read_file", arguments: '{"path":"/tmp/a.txt"}' },
            },
          ],
          reasoning_details: [reasoningDetail],
        },
        finish_reason: "tool_calls",
        logprobs: null,
      },
    ],
    usage,
  };

  const chunk = (delta: Record<string, unknown>, finish_reason: string | null = null) => ({
    id: "chatcmpl_1",
    object: "chat.completion.chunk",
    created: 1,
    model: "moonshotai/kimi-k2-upstream",
    choices: [{ index: 0, delta, finish_reason }],
  });

  const streamed = () =>
    sse([
      chunk({ role: "assistant", reasoning: "Consider" }),
      chunk({ reasoning: " this." }),
      chunk({ content: "Hello " }),
      chunk({ content: "world" }),
      chunk({
        tool_calls: [
          {
            index: 0,
            id: "call_1",
            type: "function",
            function: { name: "read_file", arguments: '{"path":' },
          },
        ],
      }),
      chunk({
        tool_calls: [{ index: 0, function: { arguments: '"/tmp/a.txt"}' } }],
      }),
      chunk({ reasoning_details: [reasoningDetail] }, "tool_calls"),
      {
        id: "chatcmpl_1",
        object: "chat.completion.chunk",
        created: 1,
        model: "moonshotai/kimi-k2-upstream",
        choices: [],
        usage,
      },
    ]);

  const base = {
    id: "moonshotai/kimi-k2",
    name: "Kimi K2",
    api: "openai-completions" as const,
    provider: "openrouter",
    reasoning: true,
  };

  it("produces the same AssistantMessage from one complete ChatCompletion as from the chunk stream", async () => {
    const calls = stubFetch({ relay: () => json(completion), direct: streamed });

    const direct = await collect(
      streamOpenAICompletions(modelFor(base, "https://openrouter.ai/api/v1"), context, {
        apiKey: "sk-or-test",
        reasoningEffort: "high",
      }),
    );
    const gateway = await collect(
      streamOpenAICompletions(modelFor(base, GATEWAY_RELAY), context, {
        apiKey: CAPABILITY,
        reasoningEffort: "high",
      }),
    );

    expect(direct.result.stopReason).toBe("toolUse");
    expect(comparable(gateway.result)).toEqual(comparable(direct.result));
    expect(gateway.result.content).toEqual([
      { type: "thinking", thinking: "Consider this.", thinkingSignature: "reasoning" },
      { type: "text", text: "Hello world" },
      {
        type: "toolCall",
        id: "call_1",
        name: "read_file",
        arguments: { path: "/tmp/a.txt" },
        thoughtSignature: JSON.stringify(reasoningDetail),
      },
    ]);
    expect(gateway.result.usage).toMatchObject({
      input: 30,
      output: 15,
      reasoning: 5,
      cacheRead: 10,
      cacheWrite: 0,
      totalTokens: 55,
    });
    expect(gateway.result.usage.cost.total).toBeGreaterThan(0);
    expect(gateway.result.responseId).toBe("chatcmpl_1");
    expect(gateway.result.responseModel).toBe("moonshotai/kimi-k2-upstream");

    expect(collapseDeltas(direct.events)).toEqual(gateway.events);
    expect(gateway.events).toEqual([
      "start",
      "thinking_start",
      "thinking_delta",
      "thinking_end",
      "text_start",
      "text_delta",
      "text_end",
      "toolcall_start",
      "toolcall_delta",
      "toolcall_end",
      "done",
    ]);

    const wire = expectGatewayWire(calls);
    expect(wire.url).toBe(`${GATEWAY_RELAY}/chat/completions`);
    expect(wire.body.stream).toBe(false);
    expect(wire.body.stream_options).toBeUndefined();
    const directCall = calls.find((call) => !call.url.includes("/v1/relay/"));
    expect(directCall?.body.stream).toBe(true);
    expect(directCall?.body.stream_options).toEqual({ include_usage: true });
  });

  it("maps a length finish_reason without tool calls", async () => {
    stubFetch({
      relay: () =>
        json({
          ...completion,
          choices: [
            {
              index: 0,
              message: { role: "assistant", content: "truncated" },
              finish_reason: "length",
              logprobs: null,
            },
          ],
        }),
      direct: streamed,
    });

    const result = await streamOpenAICompletions(modelFor(base, GATEWAY_RELAY), context, {
      apiKey: CAPABILITY,
    }).result();

    expect(result.stopReason).toBe("length");
    expect(result.content).toEqual([{ type: "text", text: "truncated" }]);
  });
});

describe("Google gateway mode", () => {
  const usageMetadata = {
    promptTokenCount: 50,
    candidatesTokenCount: 12,
    thoughtsTokenCount: 4,
    cachedContentTokenCount: 10,
    totalTokenCount: 66,
  };
  const generateContentResponse = {
    responseId: "resp_g1",
    modelVersion: "gemini-3-flash-preview",
    candidates: [
      {
        content: {
          role: "model",
          parts: [
            { text: "Pondering", thought: true, thoughtSignature: "sig_think" },
            { text: "Hello world", thoughtSignature: "sig_text" },
            {
              functionCall: { name: "read_file", args: { path: "/tmp/a.txt" }, id: "fc_1" },
              thoughtSignature: "sig_tool",
            },
          ],
        },
        finishReason: "STOP",
        index: 0,
      },
    ],
    usageMetadata,
  };

  const streamed = () =>
    new Response(
      [
        {
          responseId: "resp_g1",
          modelVersion: "gemini-3-flash-preview",
          candidates: [
            {
              content: {
                role: "model",
                parts: [{ text: "Ponder", thought: true, thoughtSignature: "sig_think" }],
              },
              index: 0,
            },
          ],
        },
        {
          candidates: [
            {
              content: { role: "model", parts: [{ text: "ing", thought: true }] },
              index: 0,
            },
          ],
        },
        {
          candidates: [
            { content: { role: "model", parts: [{ text: "Hello " }] }, index: 0 },
          ],
        },
        {
          candidates: [
            {
              content: {
                role: "model",
                parts: [{ text: "world", thoughtSignature: "sig_text" }],
              },
              index: 0,
            },
          ],
        },
        {
          candidates: [
            {
              content: {
                role: "model",
                parts: [
                  {
                    functionCall: {
                      name: "read_file",
                      args: { path: "/tmp/a.txt" },
                      id: "fc_1",
                    },
                    thoughtSignature: "sig_tool",
                  },
                ],
              },
              finishReason: "STOP",
              index: 0,
            },
          ],
          usageMetadata,
        },
      ]
        .map((event) => `data: ${JSON.stringify(event)}\n\n`)
        .join(""),
      { status: 200, headers: { "content-type": "text/event-stream" } },
    );

  const base = {
    id: "gemini-3-flash-preview",
    name: "Gemini 3 Flash",
    api: "google-generative-ai" as const,
    provider: "google",
    reasoning: true,
  };

  it("produces the same AssistantMessage from one complete GenerateContentResponse as from the chunk stream", async () => {
    const calls = stubFetch({
      relay: () => json(generateContentResponse),
      direct: streamed,
    });

    const direct = await collect(
      streamGoogle(
        modelFor(base, "https://generativelanguage.googleapis.test/v1beta"),
        context,
        { apiKey: "goog-test", thinking: { enabled: true, level: "HIGH" } },
      ),
    );
    const gateway = await collect(
      streamGoogle(modelFor(base, GATEWAY_RELAY), context, {
        apiKey: CAPABILITY,
        thinking: { enabled: true, level: "HIGH" },
      }),
    );

    expect(direct.result.stopReason).toBe("toolUse");
    expect(comparable(gateway.result)).toEqual(comparable(direct.result));
    expect(gateway.result.content).toEqual([
      { type: "thinking", thinking: "Pondering", thinkingSignature: "sig_think" },
      { type: "text", text: "Hello world", textSignature: "sig_text" },
      {
        type: "toolCall",
        id: "fc_1",
        name: "read_file",
        arguments: { path: "/tmp/a.txt" },
        thoughtSignature: "sig_tool",
      },
    ]);
    expect(gateway.result.usage).toMatchObject({
      input: 40,
      output: 16,
      reasoning: 4,
      cacheRead: 10,
      cacheWrite: 0,
      totalTokens: 66,
    });
    expect(gateway.result.usage.cost.total).toBeGreaterThan(0);
    expect(gateway.result.responseId).toBe("resp_g1");

    expect(collapseDeltas(direct.events)).toEqual(gateway.events);
    expect(gateway.events).toEqual([
      "start",
      "thinking_start",
      "thinking_delta",
      "thinking_end",
      "text_start",
      "text_delta",
      "text_end",
      "toolcall_start",
      "toolcall_delta",
      "toolcall_end",
      "done",
    ]);

    const wire = expectGatewayWire(calls);
    expect(wire.url).toBe(`${GATEWAY_RELAY}/models/gemini-3-flash-preview:generateContent`);
    const directCall = calls.find((call) => !call.url.includes("/v1/relay/"));
    expect(directCall?.url).toContain(":streamGenerateContent");
  });

  it("surfaces a blocked prompt from the complete response", async () => {
    stubFetch({
      relay: () =>
        json({
          responseId: "resp_blocked",
          promptFeedback: { blockReason: "SAFETY", blockReasonMessage: "nope" },
          candidates: [],
        }),
      direct: streamed,
    });

    const result = await streamGoogle(modelFor(base, GATEWAY_RELAY), context, {
      apiKey: CAPABILITY,
    }).result();

    expect(result.stopReason).toBe("error");
    expect(result.errorMessage).toContain("SAFETY");
  });
});
