import type Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it, vi } from "vitest";

import { streamAnthropic } from "@stella/runtime/ai/providers/anthropic";
import { readAssistantText } from "@stella/runtime/ai/stream";
import type { Context, Model } from "@stella/runtime/ai/types";
import {
  isTransientProviderStreamAnomalyMessage,
  pausedTurnStopMessage,
} from "@stella/runtime/ai/utils/provider-stop";
import {
  classifyAgentRunFailure,
  executeAgentRunWithRetry,
} from "@stella/runtime/kernel/agent-runtime/run-retry";
import { isProviderContentAbortMessage } from "@stella/runtime/kernel/agent-runtime/provider-abort-containment";
import { createRuntimeAgent } from "@stella/runtime/kernel/agent-runtime/shared";
import { executeRuntimeAgentPrompt } from "@stella/runtime/kernel/agent-runtime/run-execution";
import { createRunEventRecorder } from "@stella/runtime/kernel/agent-runtime/run-events";

const model: Model<"anthropic-messages"> = {
  id: "claude-fable-5",
  name: "Claude Fable 5",
  api: "anthropic-messages",
  provider: "anthropic",
  baseUrl: "https://api.anthropic.com/v1",
  reasoning: true,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  maxTokens: 128_000,
  contextWindow: 200_000,
};

const context: Context = {
  systemPrompt: "you are a test",
  messages: [{ role: "user", content: "hi", timestamp: 0 }],
  tools: [],
};

const sse = (events: Array<[string, unknown]>): string =>
  events
    .map(
      ([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`,
    )
    .join("");

function makeQueuedClient(bodies: string[]) {
  const requests: Array<{
    messages: Array<{ role: string; content: unknown }>;
  }> = [];
  const requestOptions: Array<{ maxRetries?: number }> = [];
  let call = 0;
  const create = (body: unknown, options?: { maxRetries?: number }) => {
    requests.push(body as (typeof requests)[number]);
    requestOptions.push(options ?? {});
    const sseBody = bodies[Math.min(call, bodies.length - 1)]!;
    call += 1;
    return {
      asResponse: async () =>
        new Response(new TextEncoder().encode(sseBody), {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        }),
    };
  };
  return {
    client: { messages: { create } } as unknown as Anthropic,
    requests,
    requestOptions,
  };
}

const messageStart = (id: string, inputTokens: number): [string, unknown] => [
  "message_start",
  {
    type: "message_start",
    message: {
      id,
      usage: {
        input_tokens: inputTokens,
        output_tokens: 0,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
      },
    },
  },
];

const textBlock = (text: string): Array<[string, unknown]> => [
  [
    "content_block_start",
    {
      type: "content_block_start",
      index: 0,
      content_block: { type: "text", text: "" },
    },
  ],
  [
    "content_block_delta",
    {
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text },
    },
  ],
  ["content_block_stop", { type: "content_block_stop", index: 0 }],
];

const messageEnd = (
  stopReason: string,
  outputTokens: number,
): Array<[string, unknown]> => [
  [
    "message_delta",
    {
      type: "message_delta",
      delta: { stop_reason: stopReason },
      usage: { output_tokens: outputTokens },
    },
  ],
  ["message_stop", { type: "message_stop" }],
];

const pausedSegment = sse([
  messageStart("msg_paused", 10),
  ...textBlock("Hello "),
  ...messageEnd("pause_turn", 5),
]);

describe("anthropic pause_turn resubmission", () => {
  it("resubmits paused content and completes the turn", async () => {
    const completedSegment = sse([
      messageStart("msg_done", 7),
      ...textBlock("world"),
      ...messageEnd("end_turn", 3),
    ]);
    const { client, requests } = makeQueuedClient([
      pausedSegment,
      completedSegment,
    ]);

    const result = await streamAnthropic(model, context, { client }).result();

    expect(result.stopReason).toBe("stop");
    expect(result.errorMessage).toBeUndefined();
    expect(readAssistantText(result)).toBe("Hello world");
    expect(result.usage.input).toBe(17);
    expect(result.usage.output).toBe(8);
    expect(requests).toHaveLength(2);
    const continuation = requests[1]!.messages.at(-1)!;
    expect(continuation).toEqual({
      role: "assistant",
      content: [{ type: "text", text: "Hello " }],
    });
  });

  it("surfaces a retryable pause error after the bounded budget", async () => {
    const { client, requests } = makeQueuedClient([pausedSegment]);

    const result = await streamAnthropic(model, context, { client }).result();

    expect(result.stopReason).toBe("error");
    expect(result.errorMessage).toBe(pausedTurnStopMessage());
    expect(requests).toHaveLength(4);
    expect(classifyAgentRunFailure(new Error(result.errorMessage!))).toEqual({
      retryable: true,
      category: "transport",
    });
    expect(isProviderContentAbortMessage(result.errorMessage)).toBe(false);
  });

  it("shares one four-request budget across continuation, outer recovery, and SDK policy", async () => {
    const { client, requests, requestOptions } = makeQueuedClient([
      pausedSegment,
    ]);
    const agent = createRuntimeAgent({
      agentType: "general",
      systemPrompt: context.systemPrompt ?? "",
      resolvedLlm: {
        model,
        route: "direct-provider",
        getApiKey: () => "test-key",
      },
      tools: [],
      historySource: [],
    });
    agent.streamFn = ((_model, llmContext, options) =>
      streamAnthropic(model, llmContext, {
        ...options,
        client,
      })) as typeof agent.streamFn;
    const recorder = createRunEventRecorder({
      store: { recordRunEvent: vi.fn() } as never,
      runId: "pause-budget-run",
      conversationId: "pause-budget-conversation",
      agentType: "general",
      userMessageId: "pause-budget-user",
    });

    const result = await executeAgentRunWithRetry({
      state: { attemptsUsed: 0, retriesUsed: 0 },
      execute: (resume) =>
        executeRuntimeAgentPrompt({
          agent,
          ...(resume ? { resume: true } : { promptText: "Continue safely." }),
          runId: "pause-budget-run",
          agentType: "general",
          userMessageId: "pause-budget-user",
          recorder,
        }),
      prepareResume: (_reason, classification) => {
        expect(classification).toEqual({
          retryable: true,
          category: "transport",
        });
        expect(agent.state.messages.at(-1)?.role).toBe("assistant");
        agent.state.messages.pop();
        return true;
      },
      sleep: async () => undefined,
      random: () => 0.5,
    });

    expect(result.errorMessage).toContain("failed after 4 attempts");
    expect(result.errorMessage).toContain('"pause_turn"');
    expect(requests).toHaveLength(4);
    expect(requestOptions).toHaveLength(4);
    expect(requestOptions.every((options) => options.maxRetries === 0)).toBe(
      true,
    );
  });

  it("does not resubmit a pause containing uncaptured server-tool blocks", async () => {
    const serverToolSegment = sse([
      messageStart("msg_server_tool", 10),
      [
        "content_block_start",
        {
          type: "content_block_start",
          index: 0,
          content_block: {
            type: "server_tool_use",
            id: "st_1",
            name: "web_search",
          },
        },
      ],
      ["content_block_stop", { type: "content_block_stop", index: 0 }],
      ...messageEnd("pause_turn", 2),
    ]);
    const { client, requests } = makeQueuedClient([serverToolSegment]);

    const result = await streamAnthropic(model, context, { client }).result();

    expect(requests).toHaveLength(1);
    expect(result.errorMessage).toBe(pausedTurnStopMessage());
    expect(
      classifyAgentRunFailure(new Error(result.errorMessage!)).retryable,
    ).toBe(true);
  });
});

describe("anthropic terminal anomaly retry policy", () => {
  it("classifies an unknown future stop reason as retryable, never clean", async () => {
    const { client } = makeQueuedClient([
      sse([
        messageStart("msg_unknown", 4),
        ...textBlock("partial answer"),
        ...messageEnd("hyperstream_reset", 2),
      ]),
    ]);

    const result = await streamAnthropic(model, context, { client }).result();

    expect(result.stopReason).toBe("error");
    expect(result.errorMessage).toContain('stop reason: "hyperstream_reset"');
    expect(classifyAgentRunFailure(new Error(result.errorMessage!))).toEqual({
      retryable: true,
      category: "transport",
    });
    expect(isProviderContentAbortMessage(result.errorMessage)).toBe(false);
  });

  it("classifies premature EOF before message_stop as retryable", async () => {
    const { client } = makeQueuedClient([
      sse([
        messageStart("msg_truncated", 6),
        [
          "content_block_start",
          {
            type: "content_block_start",
            index: 0,
            content_block: { type: "text", text: "" },
          },
        ],
        [
          "content_block_delta",
          {
            type: "content_block_delta",
            index: 0,
            delta: { type: "text_delta", text: "partial reply" },
          },
        ],
      ]),
    ]);

    const result = await streamAnthropic(model, context, { client }).result();

    expect(result.stopReason).toBe("error");
    expect(result.errorMessage).toContain("stream ended before message_stop");
    expect(readAssistantText(result)).toBe("partial reply");
    expect(isTransientProviderStreamAnomalyMessage(result.errorMessage)).toBe(
      true,
    );
    expect(classifyAgentRunFailure(new Error(result.errorMessage!))).toEqual({
      retryable: true,
      category: "transport",
    });
  });
});
