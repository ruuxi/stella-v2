import { describe, expect, it, vi } from "vitest";

import {
  executePreparedToolCall,
  runAgentLoop,
  type PreparedToolCall,
} from "@stella/runtime/kernel/agent-core/agent-loop";
import { Agent } from "@stella/runtime/kernel/agent-core/agent";
import type {
  AgentMessage,
  AgentTool,
  AgentToolResult,
} from "@stella/runtime/kernel/agent-core/types";
import { createAssistantMessageEventStream } from "@stella/runtime/ai/utils/event-stream";
import type {
  Api,
  AssistantMessage,
  Model,
} from "@stella/runtime/ai/types";

const makePrepared = (execute: AgentTool["execute"]): PreparedToolCall => ({
  kind: "prepared",
  toolCall: {
    type: "toolCall",
    id: "tool-call-1",
    name: "exec_command",
    arguments: {},
  } as never,
  tool: {
    name: "exec_command",
    label: "Exec",
    description: "test tool",
    parameters: { type: "object", properties: {} } as never,
    execute,
  } as AgentTool,
  args: {},
});

const okResult: AgentToolResult<unknown> = {
  content: [{ type: "text", text: "ok" }],
  details: {},
};

const model = {
  id: "agent-loop-empty-test",
  name: "Agent loop empty test",
  api: "openai-completions",
  provider: "test",
  baseUrl: "https://example.test",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128_000,
  maxTokens: 4_096,
} as Model<Api>;

const assistantMessage = (text: string): AssistantMessage => ({
  role: "assistant",
  content: text ? [{ type: "text", text }] : [],
  api: "openai-completions",
  provider: "test",
  model: model.id,
  usage: {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  },
  stopReason: "stop",
  timestamp: Date.now(),
});

describe("standalone Agent degenerate response recovery", () => {
  it("retains the default one-shot provider retry", async () => {
    const responses = ["", "recovered"];
    const streamFn = vi.fn(() => {
      const stream = createAssistantMessageEventStream();
      const message = assistantMessage(
        responses[streamFn.mock.calls.length - 1] ?? "",
      );
      stream.push({ type: "start", partial: message });
      stream.push({ type: "done", message });
      return stream;
    });
    const agent = new Agent({
      initialState: { model },
      streamFn,
    });
    const endedAttempts: AssistantMessage[] = [];
    agent.subscribe((event) => {
      if (event.type === "message_end" && event.message.role === "assistant") {
        endedAttempts.push(event.message);
      }
    });

    await agent.prompt("Return a visible result.");

    expect(streamFn).toHaveBeenCalledTimes(2);
    expect(endedAttempts.map((message) => message.stopReason)).toEqual([
      "error",
      "stop",
    ]);
    expect(endedAttempts[0]?.errorMessage).toContain("retrying once");
    expect(agent.state.messages).not.toContainEqual(endedAttempts[0]);
    expect(agent.state.messages.at(-1)).toMatchObject({
      role: "assistant",
      content: [{ type: "text", text: "recovered" }],
    });
  });

  it("does not retain the discarded empty attempt when its retry throws", async () => {
    const streamFn = vi.fn(() => {
      if (streamFn.mock.calls.length > 1) {
        throw new Error("retry transport failed");
      }
      const stream = createAssistantMessageEventStream();
      const message = assistantMessage("");
      stream.push({ type: "start", partial: message });
      stream.push({ type: "done", message });
      return stream;
    });
    const agent = new Agent({
      initialState: { model },
      streamFn,
    });

    await agent.prompt("Return a visible result.");

    expect(streamFn).toHaveBeenCalledTimes(2);
    expect(
      agent.state.messages.filter(
        (message) =>
          message.role === "assistant" &&
          message.errorMessage?.includes("retrying once"),
      ),
    ).toEqual([]);
    expect(agent.state.messages.at(-1)).toMatchObject({
      role: "assistant",
      stopReason: "error",
      errorMessage: "retry transport failed",
    });
  });

  it("forwards the selected provider service tier on every model call", async () => {
    const streamFn = vi.fn(() => {
      const stream = createAssistantMessageEventStream();
      const message = assistantMessage("done");
      stream.push({ type: "start", partial: message });
      stream.push({ type: "done", message });
      return stream;
    });
    const agent = new Agent({
      initialState: { model },
      serviceTier: "priority",
      streamFn,
    });

    await agent.prompt("Use Fast.");

    expect(streamFn.mock.calls[0]?.[2]?.serviceTier).toBe("priority");
  });

  it("keeps prompt-cache affinity separate from the agent session", async () => {
    const streamFn = vi.fn(() => {
      const stream = createAssistantMessageEventStream();
      const message = assistantMessage("done");
      stream.push({ type: "start", partial: message });
      stream.push({ type: "done", message });
      return stream;
    });
    const agent = new Agent({
      initialState: { model },
      sessionId: "agent-thread-1",
      promptCacheKey: "conversation-1",
      streamFn,
    });

    await agent.prompt("Use the shared conversation cache.");

    expect(streamFn.mock.calls[0]?.[2]).toMatchObject({
      sessionId: "agent-thread-1",
      promptCacheKey: "conversation-1",
    });
  });
});

describe("duplicate tool-call execution", () => {
  it.each(["sequential", "parallel"] as const)(
    "executes semantically identical calls once in %s mode and preserves an output for every call id",
    async (toolExecution) => {
      const execute = vi.fn(async () => okResult);
      const tool = {
        name: "web",
        label: "Web",
        description: "test web tool",
        parameters: {
          type: "object",
          properties: {},
          additionalProperties: true,
        } as never,
        execute,
      } as AgentTool;
      const toolMessage: AssistantMessage = {
        ...assistantMessage(""),
        content: [
          {
            type: "toolCall",
            id: "web-call-1",
            name: "web",
            arguments: { query: "Express 5", options: { limit: 5 } },
          },
          {
            type: "toolCall",
            id: "web-call-2",
            name: "web",
            arguments: { options: { limit: 5 }, query: "Express 5" },
          },
        ],
        stopReason: "toolUse",
      };
      const responses = [toolMessage, assistantMessage("done")];
      const streamFn = vi.fn(() => {
        const stream = createAssistantMessageEventStream();
        const message = responses[streamFn.mock.calls.length - 1]!;
        stream.push({ type: "start", partial: message });
        stream.push({
          type: "done",
          reason: message.stopReason === "toolUse" ? "toolUse" : "stop",
          message,
        });
        return stream;
      });
      const agent = new Agent({
        initialState: { model, tools: [tool] },
        streamFn,
        toolExecution,
      });

      await agent.prompt("Check the release notes.");

      expect(execute).toHaveBeenCalledTimes(1);
      const results = agent.state.messages.filter(
        (message) => message.role === "toolResult",
      );
      expect(results.map((message) => message.toolCallId)).toEqual([
        "web-call-1",
        "web-call-2",
      ]);
      expect(results[0]?.content).toEqual(okResult.content);
      expect(results[1]?.content[0]).toMatchObject({
        type: "text",
        text: expect.stringContaining("Exact duplicate skipped"),
      });
    },
  );
});

describe("active-turn working-set boundaries", () => {
  it("does not dispatch when cancellation arrives during prompt preparation", async () => {
    const controller = new AbortController();
    const streamFn = vi.fn();

    await expect(
      runAgentLoop(
        [
          {
            role: "user",
            content: [{ type: "text", text: "run" }],
            timestamp: Date.now(),
          },
        ],
        { systemPrompt: "test", messages: [], tools: [] },
        {
          model,
          transformContext: async (messages) => {
            controller.abort(new Error("Canceled during preparation"));
            return messages;
          },
          convertToLlm: async (messages) => messages as never,
        },
        vi.fn(),
        controller.signal,
        streamFn,
      ),
    ).rejects.toThrow("Canceled during preparation");
    expect(streamFn).not.toHaveBeenCalled();
  });

  it("releases the caller's initial history reference during a normal prompt run", async () => {
    const oldHistory = assistantMessage("x".repeat(10_000));
    const promptMessage: AgentMessage = {
      role: "user",
      content: [{ type: "text", text: "run" }],
      timestamp: Date.now(),
    };
    const toolMessage: AssistantMessage = {
      ...assistantMessage(""),
      content: [
        {
          type: "toolCall",
          id: "release-tool",
          name: "exec_command",
          arguments: {},
        },
      ],
      stopReason: "toolUse",
    };
    const responses = [toolMessage, assistantMessage("done")];
    const streamFn = vi.fn(() => {
      const stream = createAssistantMessageEventStream();
      const message = responses[streamFn.mock.calls.length - 1]!;
      stream.push({ type: "start", partial: message });
      stream.push({ type: "done", message });
      return stream;
    });
    const context = {
      systemPrompt: "test",
      messages: [oldHistory] as AgentMessage[],
      tools: [
        {
          name: "exec_command",
          label: "Exec",
          description: "test tool",
          parameters: { type: "object", properties: {} } as never,
          execute: vi.fn(async () => okResult),
        } as AgentTool,
      ],
    };

    await runAgentLoop(
      [promptMessage],
      context,
      {
        model,
        convertToLlm: async (messages) => messages as never,
        onTurnBoundary: async ({ completedMessages }) => [
          assistantMessage("[[THREAD_CHECKPOINT]] compacted"),
          ...completedMessages,
        ],
      },
      vi.fn(),
      undefined,
      streamFn,
    );

    expect(context.messages).not.toContain(oldHistory);
    expect(context.messages.map((message) => message.role)).toEqual([
      "assistant",
      "assistant",
      "toolResult",
      "assistant",
    ]);
  });

  it.each(["steer", "followUp"] as const)(
    "reports dequeued %s messages before they are emitted",
    async (delivery) => {
      const firstStream = createAssistantMessageEventStream();
      const firstResponse = assistantMessage("first response");
      const finalResponse = assistantMessage("queued message handled");
      const streamFn = vi.fn(() => {
        if (streamFn.mock.calls.length === 1) return firstStream;
        const stream = createAssistantMessageEventStream();
        stream.push({ type: "start", partial: finalResponse });
        stream.push({ type: "done", message: finalResponse });
        return stream;
      });
      const boundary = vi.fn(async () => undefined);
      const agent = new Agent({
        initialState: { model },
        streamFn,
        onTurnBoundary: boundary,
      });
      const queuedMessage: AgentMessage = {
        role: "user",
        content: [{ type: "text", text: "queued message" }],
        timestamp: Date.now(),
      };

      const prompt = agent.prompt("Start the response.");
      await vi.waitFor(() => expect(streamFn).toHaveBeenCalledOnce());
      agent[delivery](queuedMessage);
      firstStream.push({ type: "start", partial: firstResponse });
      firstStream.push({ type: "done", message: firstResponse });
      await prompt;

      expect(boundary).toHaveBeenCalledOnce();
      expect(boundary.mock.calls[0]?.[0].pendingMessages).toEqual([
        queuedMessage,
      ]);
      expect(streamFn.mock.calls[1]?.[1].messages.at(-1)).toEqual(
        queuedMessage,
      );
    },
  );

  it("replaces context only after the assistant/tool-result pair is complete", async () => {
    let releaseTool!: () => void;
    const toolGate = new Promise<void>((resolve) => {
      releaseTool = resolve;
    });
    let toolStarted!: () => void;
    const toolStartedGate = new Promise<void>((resolve) => {
      toolStarted = resolve;
    });
    const toolMessage: AssistantMessage = {
      ...assistantMessage(""),
      content: [
        {
          type: "toolCall",
          id: "boundary-tool-1",
          name: "exec_command",
          arguments: {},
        },
      ],
      stopReason: "toolUse",
    };
    const finalMessage = assistantMessage("done after page-in");
    const responses = [toolMessage, finalMessage];
    const streamFn = vi.fn(() => {
      const stream = createAssistantMessageEventStream();
      const message = responses[streamFn.mock.calls.length - 1]!;
      stream.push({ type: "start", partial: message });
      stream.push({ type: "done", message });
      return stream;
    });
    const tool = {
      name: "exec_command",
      label: "Exec",
      description: "test tool",
      parameters: { type: "object", properties: {} } as never,
      execute: vi.fn(async () => {
        toolStarted();
        await toolGate;
        return okResult;
      }),
    } as AgentTool;
    const checkpoint = assistantMessage(
      "[[THREAD_CHECKPOINT]] compacted history",
    );
    const durablyFlushedRoles: AgentMessage["role"][] = [];
    const boundary = vi.fn(
      async ({ completedMessages }: { completedMessages: AgentMessage[] }) => {
        expect(durablyFlushedRoles.slice(-2)).toEqual([
          "assistant",
          "toolResult",
        ]);
        return [
          checkpoint,
          ...completedMessages.map((message) => structuredClone(message)),
        ];
      },
    );
    const agent = new Agent({
      initialState: { model, tools: [tool] },
      streamFn,
      onTurnBoundary: boundary,
    });
    agent.subscribe((event) => {
      if (event.type === "message_end") {

        durablyFlushedRoles.push(event.message.role);
      }
    });

    const prompt = agent.prompt("Run the tool.");
    await toolStartedGate;

    expect(boundary).not.toHaveBeenCalled();
    expect(agent.state.pendingToolCalls).toEqual(new Set(["boundary-tool-1"]));

    releaseTool();
    await prompt;

    expect(boundary).toHaveBeenCalledOnce();
    expect(
      boundary.mock.calls[0]?.[0].completedMessages.map(
        (message) => message.role,
      ),
    ).toEqual(["assistant", "toolResult"]);
    const secondProviderContext = streamFn.mock.calls[1]?.[1];
    expect(
      secondProviderContext.messages.map(
        (message: AgentMessage) => message.role,
      ),
    ).toEqual(["assistant", "assistant", "toolResult"]);
    expect(secondProviderContext.messages[0]).toMatchObject({
      content: [
        { type: "text", text: "[[THREAD_CHECKPOINT]] compacted history" },
      ],
    });
    expect(agent.state.messages.map((message) => message.role)).toEqual([
      "assistant",
      "assistant",
      "toolResult",
      "assistant",
    ]);
    expect(agent.state.messages).not.toContainEqual(
      expect.objectContaining({ role: "user", content: expect.anything() }),
    );
  });

  it("keeps the existing context when a boundary refresh fails", async () => {
    const toolMessage: AssistantMessage = {
      ...assistantMessage(""),
      content: [
        {
          type: "toolCall",
          id: "boundary-tool-error",
          name: "exec_command",
          arguments: {},
        },
      ],
      stopReason: "toolUse",
    };
    const responses = [toolMessage, assistantMessage("still completed")];
    const streamFn = vi.fn(() => {
      const stream = createAssistantMessageEventStream();
      const message = responses[streamFn.mock.calls.length - 1]!;
      stream.push({ type: "start", partial: message });
      stream.push({ type: "done", message });
      return stream;
    });
    const agent = new Agent({
      initialState: {
        model,
        tools: [
          {
            name: "exec_command",
            label: "Exec",
            description: "test tool",
            parameters: { type: "object", properties: {} } as never,
            execute: vi.fn(async () => okResult),
          } as AgentTool,
        ],
      },
      streamFn,
      onTurnBoundary: async () => {
        throw new Error("page-in failed");
      },
    });

    await agent.prompt("Run despite a checkpoint failure.");

    expect(streamFn).toHaveBeenCalledTimes(2);
    expect(agent.state.messages.map((message) => message.role)).toEqual([
      "user",
      "assistant",
      "toolResult",
      "assistant",
    ]);
  });
});

describe("executePreparedToolCall inactivity bound", () => {
  it("cancels a fully silent tool and reports an error result instead of hanging", async () => {
    let toolSignal: AbortSignal | undefined;
    const prepared = makePrepared((_id, _args, signal) => {
      toolSignal = signal;
      return new Promise(() => {});
    });

    const outcome = await executePreparedToolCall(
      prepared,
      undefined,
      vi.fn(),
      25,
    );

    expect(outcome.isError).toBe(true);
    const text = outcome.result.content
      .map((c) => (c.type === "text" ? c.text : ""))
      .join(" ");
    expect(text).toContain("produced no output");
    expect(toolSignal?.aborted).toBe(true);
  });

  it("keeps a long-running tool alive as long as it reports progress", async () => {
    const emitted: string[] = [];
    const prepared = makePrepared(async (_id, _args, signal, onUpdate) => {
      for (let i = 0; i < 5; i++) {
        await new Promise((resolve) => setTimeout(resolve, 15));
        expect(signal?.aborted).toBe(false);
        onUpdate?.({
          content: [{ type: "text", text: `tick ${i}` }],
          details: {},
        });
      }
      return okResult;
    });

    const outcome = await executePreparedToolCall(
      prepared,
      undefined,
      (event) => {
        if (event.type === "tool_execution_update")
          emitted.push(event.toolCallId);
      },
      40,
    );

    expect(outcome.isError).toBe(false);
    expect(outcome.result).toEqual(okResult);
    expect(emitted).toHaveLength(5);
  });

  it("disables the bound when the timeout is <= 0", async () => {
    const prepared = makePrepared(async () => {
      await new Promise((resolve) => setTimeout(resolve, 60));
      return okResult;
    });

    const outcome = await executePreparedToolCall(
      prepared,
      undefined,
      vi.fn(),
      0,
    );

    expect(outcome.isError).toBe(false);
    expect(outcome.result).toEqual(okResult);
  });

  it("propagates an outer abort to the tool's composed signal", async () => {
    const outer = new AbortController();
    let toolSignal: AbortSignal | undefined;
    const prepared = makePrepared((_id, _args, signal) => {
      toolSignal = signal;
      return new Promise((_, reject) => {
        signal?.addEventListener("abort", () => reject(new Error("aborted")));
      });
    });

    const execution = executePreparedToolCall(
      prepared,
      outer.signal,
      vi.fn(),
      10_000,
    );
    outer.abort();
    const outcome = await execution;

    expect(toolSignal?.aborted).toBe(true);
    expect(outcome.isError).toBe(true);
  });
});
