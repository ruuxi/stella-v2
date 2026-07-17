import { describe, expect, it, vi } from "vitest";

import { createRunEventRecorder } from "@stella/runtime/kernel/agent-runtime/run-events";
import {
  buildPreambleToolBoundaryMessage,
  createExternalAssistantUpdateBuffer,
  persistExternalAssistantPreamble,
} from "@stella/runtime/kernel/agent-runtime/external-engines";

const makeRecorder = () => {
  const store = { recordRunEvent: vi.fn() };
  return createRunEventRecorder({
    store: store as never,
    runId: "run-codex",
    conversationId: "conversation-1",
    agentType: "orchestrator",
    userMessageId: "user-1",
    getResponseTarget: () => ({ type: "user_turn" }),
  });
};

describe("external-engine preamble→tool boundary", () => {
  it.each([
    ["codex", "openai-codex", "codex"],
    ["claude_code", "anthropic", "claude-code"],
  ] as const)(
    "persists one complete %s preamble without partial fragments",
    (engine, provider, model) => {
      const appendThreadMessage = vi.fn();
      persistExternalAssistantPreamble({
        store: { appendThreadMessage } as never,
        threadKey: "agent-1",
        preamble: "  I inspected the route.  ",
        engine,
        runId: "run-7",
        attemptGeneration: 7,
      });

      expect(appendThreadMessage).toHaveBeenCalledOnce();
      expect(appendThreadMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          threadKey: "agent-1",
          role: "assistant",
          content: "I inspected the route.",
          payload: expect.objectContaining({
            role: "assistant",
            provider,
            model,
            stopReason: "toolUse",
            stellaRunId: "run-7",
            stellaAttemptGeneration: 7,
            content: [{ type: "text", text: "I inspected the route." }],
          }),
        }),
      );
    },
  );

  it.each(["codex", "claude_code"] as const)(
    "persists only completed %s interim boundaries across final and interrupted turns",
    (engine) => {
      const appendThreadMessage = vi.fn();
      const createBuffer = () =>
        createExternalAssistantUpdateBuffer({
          store: { appendThreadMessage } as never,
          threadKey: "agent-1",
          engine,
          runId: "run-9",
          attemptGeneration: 9,
        });

      const completed = createBuffer();
      completed.append("I inspected ");
      completed.append("the route.");
      expect(appendThreadMessage).not.toHaveBeenCalled();
      expect(completed.flushBeforeTool()).toBe("I inspected the route.");

      // The buffer left at normal turn completion is the final answer. The
      // caller discards it because persistAssistantReply owns that write.
      completed.append("This is the final answer.");
      completed.discard();
      expect(completed.flushBeforeTool()).toBe("");

      // An interrupted partial stream is likewise never promoted to a
      // completed transcript-backed update.
      const interrupted = createBuffer();
      interrupted.append("Partial text before interruption");
      interrupted.discard();
      expect(interrupted.flushBeforeTool()).toBe("");

      const resumed = createBuffer();
      resumed.append("I resumed and checked the build.");
      expect(resumed.flushBeforeTool()).toBe(
        "I resumed and checked the build.",
      );

      expect(appendThreadMessage).toHaveBeenCalledTimes(2);
      expect(
        appendThreadMessage.mock.calls.map(
          ([message]) =>
            (message as { payload: { content: Array<{ text?: string }> } })
              .payload.content[0]?.text,
        ),
      ).toEqual(["I inspected the route.", "I resumed and checked the build."]);
      expect(
        appendThreadMessage.mock.calls.every(
          ([message]) =>
            (message as { payload: { stopReason: string } }).payload
              .stopReason === "toolUse",
        ),
      ).toBe(true);
    },
  );

  it("pairs streamed preamble text with the tool call it precedes", () => {
    const message = buildPreambleToolBoundaryMessage({
      preamble: "Let me look that up.",
      toolCallId: "call-1",
      toolName: "web",
      toolArgs: { query: "tokyo population" },
    });
    expect(message.role).toBe("assistant");
    const blocks = Array.isArray(message.content) ? message.content : [];
    expect(blocks.map((block) => block.type)).toEqual(["text", "toolCall"]);
    const toolCall = blocks.find((block) => block.type === "toolCall");
    expect(toolCall).toMatchObject({ id: "call-1", name: "web" });
  });

  it("flags the emitted assistant-message event as followedByToolCall", () => {
    const recorder = makeRecorder();
    const event = recorder.recordAssistantMessageEnd(
      buildPreambleToolBoundaryMessage({
        preamble: "Let me look that up.",
        toolCallId: "call-1",
        toolName: "web",
        toolArgs: {},
      }),
    );
    expect(event?.text).toBe("Let me look that up.");
    expect(event?.followedByToolCall).toBe(true);
  });

  it("emits no boundary event for an empty preamble (tool-only step)", () => {
    const recorder = makeRecorder();
    const event = recorder.recordAssistantMessageEnd(
      buildPreambleToolBoundaryMessage({
        preamble: "   ",
        toolCallId: "call-1",
        toolName: "web",
        toolArgs: {},
      }),
    );
    expect(event).toBeNull();
  });

  it("does not flag a plain final answer as followedByToolCall", () => {
    const recorder = makeRecorder();
    const finalEvent = recorder.recordAssistantTextEnd(
      "Tokyo has ~14 million.",
    );
    expect(finalEvent?.text).toBe("Tokyo has ~14 million.");
    expect(finalEvent?.followedByToolCall).toBeUndefined();
  });
});
