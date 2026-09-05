import { describe, expect, it, vi } from "vitest";
import { Type } from "@sinclair/typebox";
import type { Api, AssistantMessage, Model } from "../ai/types.js";
import { createAssistantMessageEventStream } from "../ai/utils/event-stream.js";
import { ExplicitModelAgent } from "../kernel/agent-core/explicit-model-agent.js";
import type { AgentTool, StreamFn } from "../kernel/agent-core/types.js";

const model = {
  id: "test",
  name: "test",
  api: "openai-completions",
  provider: "test",
  baseUrl: "https://example.test",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128_000,
  maxTokens: 4096,
} satisfies Model<Api>;
const message = (
  content: AssistantMessage["content"],
  stopReason: AssistantMessage["stopReason"],
): AssistantMessage => ({
  role: "assistant",
  content,
  api: model.api,
  provider: model.provider,
  model: model.id,
  usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
  stopReason,
  timestamp: 1,
});
const toolMessage = (args: unknown) =>
  message(
    [{ type: "toolCall", id: "call-1", name: "count", arguments: args }],
    "toolUse",
  );
const done = message([{ type: "text", text: "done" }], "stop");
const stream = (...messages: AssistantMessage[]): StreamFn => {
  let index = 0;
  return () => {
    const current = messages[index++] ?? done;
    const result = createAssistantMessageEventStream();
    result.push({ type: "start", partial: current });
    result.push({ type: "done", reason: current.stopReason, message: current });
    return result;
  };
};
const tool = (execute: AgentTool["execute"]): AgentTool => ({
  name: "count",
  label: "Count",
  description: "Count",
  parameters: Type.Object(
    { count: Type.Integer({ minimum: 1 }) },
    { additionalProperties: false },
  ),
  execute,
});

const createAgent = (execute: AgentTool["execute"], args: unknown) =>
  new ExplicitModelAgent({
    initialState: { model, tools: [tool(execute)] },
    streamFn: stream(toolMessage(args), done),
    toolExecution: "sequential",
  });

describe("lazy agent tool validation", () => {
  it("preserves AJV coercion on the first tool invocation", async () => {
    const execute = vi.fn(async () => ({
      content: [{ type: "text" as const, text: "ok" }],
      details: null,
    }));
    await createAgent(execute, { count: "2" }).prompt("count");
    expect(execute.mock.calls[0]?.[1]).toEqual({ count: 2 });
  });

  it("preserves strict rejection without invoking the tool", async () => {
    const execute = vi.fn();
    const agent = createAgent(execute, { count: 0, extra: true });
    await agent.prompt("count");
    expect(execute).not.toHaveBeenCalled();
    const result = agent.state.messages.find(
      (entry) => entry.role === "toolResult",
    );
    expect(result).toMatchObject({ isError: true });
    expect(JSON.stringify(result)).toContain("Validation failed for tool");
    expect(JSON.stringify(result)).toContain("additional properties");
  });

  it("keeps the validated invocation attached to Agent cancellation", async () => {
    const execute = vi.fn(
      (_id, _args, signal?: AbortSignal) =>
        new Promise<never>((_resolve, reject) =>
          signal?.addEventListener(
            "abort",
            () => reject(new Error("canceled")),
            { once: true },
          ),
        ),
    );
    const agent = createAgent(execute, { count: 2 });
    const pending = agent.prompt("count");
    await vi.waitFor(() => expect(execute).toHaveBeenCalledOnce());
    agent.abort();
    await expect(pending).resolves.toBeUndefined();
    expect(
      agent.state.messages.some((entry) => entry.role === "toolResult"),
    ).toBe(true);
  });
});
