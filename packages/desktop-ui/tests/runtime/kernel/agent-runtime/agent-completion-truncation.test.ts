import { describe, expect, it } from "vitest";
import { getAgentCompletion } from "@stella/runtime/kernel/agent-runtime/shared";
import type { AssistantMessage, StopReason } from "@stella/runtime/ai/types";

const usage = (output: number) => ({
  input: 2,
  output,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: output + 2,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
});

const assistantMessage = (args: {
  stopReason: StopReason;
  content: AssistantMessage["content"];
  outputTokens?: number;
  errorMessage?: string;
}): AssistantMessage => ({
  role: "assistant",
  content: args.content,
  api: "openai-completions",
  provider: "openrouter",
  model: "anthropic/claude-fable-5",
  usage: usage(args.outputTokens ?? 100),
  stopReason: args.stopReason,
  ...(args.errorMessage ? { errorMessage: args.errorMessage } : {}),
  timestamp: 1,
});

const completionFor = (message: AssistantMessage) =>
  getAgentCompletion({ state: { messages: [message], error: undefined } });

describe("getAgentCompletion truncated-reasoning detection", () => {
  it("reports an error for a length stop with thinking-only content", () => {

    const completion = completionFor(
      assistantMessage({
        stopReason: "length",
        content: [
          { type: "thinking", thinking: "reasoning that hit the cap…" },
        ],
        outputTokens: 4096,
      }),
    );

    expect(completion.finalText).toBe("");
    expect(completion.errorMessage).toMatch(/truncated/i);
    expect(completion.errorMessage).toMatch(/4096/);
    expect(completion.errorMessage).toMatch(/no visible reply/i);
  });

  it("reports an error for a length stop with empty content", () => {
    const completion = completionFor(
      assistantMessage({ stopReason: "length", content: [] }),
    );

    expect(completion.errorMessage).toMatch(/truncated/i);
  });

  it("does not flag a length stop that still produced visible text", () => {

    const completion = completionFor(
      assistantMessage({
        stopReason: "length",
        content: [
          { type: "thinking", thinking: "…" },
          { type: "text", text: "Partial answer before the cap." },
        ],
      }),
    );

    expect(completion.finalText).toBe("Partial answer before the cap.");
    expect(completion.errorMessage).toBeUndefined();
  });

  it("does not flag a length stop that ended on a tool call", () => {

    const completion = completionFor(
      assistantMessage({
        stopReason: "length",
        content: [
          { type: "toolCall", id: "t1", name: "exec_command", arguments: {} },
        ],
      }),
    );

    expect(completion.errorMessage).toBeUndefined();
  });

  it("does not flag a normal stop with a final reply", () => {
    const completion = completionFor(
      assistantMessage({
        stopReason: "stop",
        content: [{ type: "text", text: "All done." }],
      }),
    );

    expect(completion.finalText).toBe("All done.");
    expect(completion.errorMessage).toBeUndefined();
  });

  it("prefers an explicit provider errorMessage over the truncation text", () => {
    const completion = completionFor(
      assistantMessage({
        stopReason: "length",
        content: [{ type: "thinking", thinking: "…" }],
        errorMessage: "provider 400: thinking block mismatch",
      }),
    );

    expect(completion.errorMessage).toBe(
      "provider 400: thinking block mismatch",
    );
  });
});
