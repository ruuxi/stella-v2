import { describe, expect, it, vi } from "vitest";

import { createRunEventRecorder } from "@stella/runtime/kernel/agent-runtime/run-events";
import { SubagentSession } from "@stella/runtime/kernel/agent-runtime/subagent-session";
import {
  buildPreambleToolBoundaryMessage,
  createExternalLiveAgent,
  publishQueuedUserMessageStarts,
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

describe("external live steering", () => {
  it("wakes the active engine hook for steer, but not followUp", () => {
    const live = createExternalLiveAgent();
    const interrupt = vi.fn();
    const detach = live.beginSteerableTurn(interrupt);
    const message = {
      role: "user",
      content: [{ type: "text", text: "change direction" }],
      timestamp: Date.now(),
    } as never;

    live.agent.followUp(message);
    expect(interrupt).not.toHaveBeenCalled();

    live.agent.steer(message);
    expect(interrupt).toHaveBeenCalledTimes(1);
    expect(live.drain().map((entry) => entry.delivery)).toEqual([
      "followUp",
      "steer",
    ]);

    detach();
    live.agent.steer(message);
    expect(interrupt).toHaveBeenCalledTimes(1);
    live.finish();
    expect(live.agent.state.isStreaming).toBe(false);
  });

  it("wakes a newly attached engine hook when steering was queued early", () => {
    const live = createExternalLiveAgent();
    const message = {
      role: "user",
      content: [{ type: "text", text: "queued before engine startup" }],
      timestamp: Date.now(),
    } as never;
    const notify = vi.fn();

    live.agent.steer(message);
    const detach = live.beginSteerableTurn(notify);

    expect(notify).toHaveBeenCalledTimes(1);
    expect(live.drainSteering()).toMatchObject([
      { delivery: "steer", message },
    ]);
    detach();
  });

  it("moves callback ownership to every user steer consumed in one engine turn", () => {
    const recorder = createRunEventRecorder({
      store: { recordRunEvent: vi.fn() } as never,
      runId: "run-hidden",
      conversationId: "conversation-1",
      agentType: "orchestrator",
      userMessageId: "hidden-agent-result",
      uiVisibility: "hidden",
    });
    const firstSwitch = vi.fn();
    const secondSwitch = vi.fn();
    recorder.queueUserMessageId("user-1", firstSwitch, "visible");
    recorder.queueUserMessageId("user-2", secondSwitch, "visible");
    const live = createExternalLiveAgent();
    const first = {
      role: "user",
      content: [{ type: "text", text: "first steer" }],
      timestamp: 1,
    } as never;
    const second = {
      role: "user",
      content: [{ type: "text", text: "second steer" }],
      timestamp: 2,
    } as never;
    live.agent.steer(first);
    live.agent.steer(second);
    const onRunStarted = vi.fn();

    publishQueuedUserMessageStarts({
      entries: live.drainSteering(),
      runEvents: recorder,
      callbacks: { onRunStarted },
    });

    expect(firstSwitch).toHaveBeenCalledOnce();
    expect(secondSwitch).toHaveBeenCalledOnce();
    expect(onRunStarted.mock.calls.map(([event]) => event)).toMatchObject([
      { userMessageId: "user-1", uiVisibility: "visible" },
      { userMessageId: "user-2", uiVisibility: "visible" },
    ]);
    expect(recorder.recordStream("answer")).toMatchObject({
      userMessageId: "user-2",
      uiVisibility: "visible",
    });
  });

  it("routes durable subagent session steering into an attached external engine", () => {
    const session = new SubagentSession(
      "general-thread",
      "conversation-1",
      "general",
    );
    const live = createExternalLiveAgent();
    const appendThreadMessage = vi.fn();
    const detach = session.attachExternalLiveAgent(live.agent, {
      store: { appendThreadMessage } as never,
      runId: "run-general",
      attemptGeneration: 3,
    });

    expect(session.canSteer).toBe(true);
    expect(session.steer("change the active task")).toBe(true);
    expect(live.drainSteering()).toMatchObject([
      {
        delivery: "steer",
        message: {
          role: "user",
          content: [{ type: "text", text: "change the active task" }],
        },
      },
    ]);
    expect(appendThreadMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        threadKey: "general-thread",
        role: "user",
      }),
    );

    detach();
    expect(session.canSteer).toBe(false);
    session.dispose();
  });
});
