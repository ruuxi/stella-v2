import { describe, expect, it, vi } from "vitest";
import { buildAgentEventPrompt } from "@stella/runtime/kernel/runner/shared";
import { createAgentOrchestration } from "@stella/runtime/kernel/runner/agent-orchestration";
import {
  AGENT_PAUSE_CANCEL_REASON,
  AGENT_SHUTDOWN_CANCEL_REASON,
} from "@stella/runtime/kernel/agents/local-agent-manager";

describe("task lifecycle deduping", () => {
  it("delivers one distinct completion once as hidden ordinary parent history", async () => {
    const persistedMessages: Array<Record<string, unknown>> = [];
    const sendMessage = vi.fn(async (input: Record<string, unknown>) => {
      persistedMessages.push({
        role: "runtimeInternal",
        content: input.text,
        customMessage: {
          customType: input.customType,
          eventId: input.eventId,
          display: input.display,
        },
      });
    });
    const context = {
      state: {
        localAgentManager: null,
        orchestratorSessions: new Map(),
        runCallbacksByRunId: new Map(),
      },
      runtimeStore: {
        loadRawThreadMessages: () => persistedMessages,
      },
      stellaDataDir: "/tmp/stella-test",
    } as never;
    createAgentOrchestration(context, {
      buildAgentContext: vi.fn(),
      sendMessage,
    });
    const manager = (context as { state: { localAgentManager: unknown } }).state
      .localAgentManager as {
      opts: { onAgentEvent: (event: Record<string, unknown>) => void };
    };
    const event = {
      type: "agent-completed",
      conversationId: "conversation-1",
      rootRunId: "run-1",
      eventId: "task-fresh:1:agent-completed",
      agentId: "task-fresh",
      agentType: "general",
      description: "Finish the task",
      result: "Full final report",
      audience: "orchestrator-only",
    };

    manager.opts.onAgentEvent(event);
    await vi.waitFor(() => expect(sendMessage).toHaveBeenCalledOnce());
    manager.opts.onAgentEvent(event);
    await Promise.resolve();

    expect(sendMessage).toHaveBeenCalledOnce();
    expect(sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        uiVisibility: "hidden",
        customType: "runtime.task_lifecycle",
        eventId: event.eventId,
        display: false,
      }),
    );
    expect(persistedMessages).toHaveLength(1);
    expect(JSON.stringify(persistedMessages[0])).toContain("Full final report");
  });

  it("sequences simultaneous distinct completions and deduplicates each one", async () => {
    const persistedMessages: Array<Record<string, unknown>> = [];
    const sendMessage = vi.fn(async (input: Record<string, unknown>) => {
      persistedMessages.push({
        role: "runtimeInternal",
        customMessage: {
          customType: input.customType,
          eventId: input.eventId,
        },
      });
    });
    const context = {
      state: {
        localAgentManager: null,
        orchestratorSessions: new Map(),
        runCallbacksByRunId: new Map(),
      },
      runtimeStore: {
        loadRawThreadMessages: () => persistedMessages,
      },
      stellaDataDir: "/tmp/stella-test",
    } as never;
    createAgentOrchestration(context, {
      buildAgentContext: vi.fn(),
      sendMessage,
    });
    const manager = (context as { state: { localAgentManager: unknown } }).state
      .localAgentManager as {
      opts: { onAgentEvent: (event: Record<string, unknown>) => void };
    };
    const completion = (agentId: string) => ({
      type: "agent-completed",
      conversationId: "conversation-1",
      rootRunId: "run-1",
      eventId: `${agentId}:1:agent-completed`,
      agentId,
      agentType: "general",
      description: `Finish ${agentId}`,
      result: `Report ${agentId}`,
      audience: "orchestrator-only",
    });
    const first = completion("task-a");
    const second = completion("task-b");

    manager.opts.onAgentEvent(first);
    manager.opts.onAgentEvent(second);
    manager.opts.onAgentEvent(first);
    manager.opts.onAgentEvent(second);
    await vi.waitFor(() => expect(sendMessage).toHaveBeenCalledTimes(2));

    expect(sendMessage.mock.calls.map(([input]) => input.eventId)).toEqual([
      first.eventId,
      second.eventId,
    ]);
    expect(persistedMessages).toHaveLength(2);
  });

  it("does not replay a lifecycle report already persisted in parent history", () => {
    const sendMessage = vi.fn(async () => undefined);
    const context = {
      state: {
        localAgentManager: null,
        orchestratorSessions: new Map(),
        runCallbacksByRunId: new Map(),
      },
      runtimeStore: {
        loadRawThreadMessages: () => [
          {
            timestamp: 123,
            role: "runtimeInternal",
            content: "persisted lifecycle report",
            customMessage: {
              customType: "runtime.task_lifecycle",
              eventId: "task-1:1:agent-completed",
            },
          },
        ],
      },
      stellaDataDir: "/tmp/stella-test",
    } as never;
    createAgentOrchestration(context, {
      buildAgentContext: vi.fn(),
      sendMessage,
    });

    const manager = (context as { state: { localAgentManager: unknown } }).state
      .localAgentManager as {
      opts: { onAgentEvent: (event: Record<string, unknown>) => void };
    };
    manager.opts.onAgentEvent({
      type: "agent-completed",
      conversationId: "conversation-1",
      rootRunId: "run-1",
      eventId: "task-1:1:agent-completed",
      agentId: "task-1",
      agentType: "general",
      description: "Finish the task",
      result: "Done",
      audience: "orchestrator-only",
    });

    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("retries a failed delivery, then consumes the event ID exactly once", async () => {
    const persistedMessages: Array<Record<string, unknown>> = [];
    const sendMessage = vi
      .fn()
      .mockRejectedValueOnce(new Error("delivery failed"))
      .mockImplementationOnce(async (input: { eventId?: string }) => {
        persistedMessages.push({
          role: "runtimeInternal",
          customMessage: {
            customType: "runtime.task_lifecycle",
            eventId: input.eventId,
          },
        });
      });
    const context = {
      state: {
        localAgentManager: null,
        orchestratorSessions: new Map(),
        runCallbacksByRunId: new Map(),
      },
      runtimeStore: {
        loadRawThreadMessages: () => persistedMessages,
      },
      stellaDataDir: "/tmp/stella-test",
    } as never;
    createAgentOrchestration(context, {
      buildAgentContext: vi.fn(),
      sendMessage,
    });

    const manager = (context as { state: { localAgentManager: unknown } }).state
      .localAgentManager as {
      opts: { onAgentEvent: (event: Record<string, unknown>) => void };
    };
    const event = {
      type: "agent-completed",
      conversationId: "conversation-1",
      rootRunId: "run-1",
      eventId: "task-2:1:agent-completed",
      agentId: "task-2",
      agentType: "general",
      description: "Finish the task",
      result: "Done",
      audience: "orchestrator-only",
    };

    manager.opts.onAgentEvent(event);
    await vi.waitFor(() => expect(sendMessage).toHaveBeenCalledTimes(1));

    manager.opts.onAgentEvent(event);
    await vi.waitFor(() => expect(sendMessage).toHaveBeenCalledTimes(2));
    expect(sendMessage).toHaveBeenLastCalledWith(
      expect.objectContaining({
        customType: "runtime.task_lifecycle",
        eventId: event.eventId,
      }),
    );

    manager.opts.onAgentEvent(event);
    await Promise.resolve();
    expect(sendMessage).toHaveBeenCalledTimes(2);
  });

  it("does not build hidden orchestrator prompts for agent-started", () => {
    const prompt = buildAgentEventPrompt({
      type: "agent-started",
      conversationId: "conversation-1",
      rootRunId: "run-1",
      agentId: "task-1",
      agentType: "general",
      description: "Open Spotify",
    });

    expect(prompt).toBeNull();
  });

  it("keeps terminal lifecycle prompts for orchestrator follow-ups", () => {
    const completedPrompt = buildAgentEventPrompt({
      type: "agent-completed",
      conversationId: "conversation-1",
      rootRunId: "run-1",
      agentId: "task-1",
      agentType: "general",
      description: "Open Spotify and play jazz",
      result: "Spotify is now open",
    });
    const failedPrompt = buildAgentEventPrompt({
      type: "agent-failed",
      conversationId: "conversation-1",
      rootRunId: "run-1",
      agentId: "task-1",
      agentType: "general",
      error: "Spotify failed to open",
    });
    const canceledPrompt = buildAgentEventPrompt({
      type: "agent-canceled",
      conversationId: "conversation-1",
      rootRunId: "run-1",
      agentId: "task-1",
      agentType: "general",
      error: "Canceled by user",
    });

    expect(completedPrompt).toContain("[Agent completed]");
    expect(completedPrompt).toContain(
      "The agent has finished. The user cannot see this report — respond to them yourself, and delegate follow-up work if the task is unfinished.",
    );
    expect(completedPrompt).not.toContain("not waiting");
    expect(completedPrompt).toContain(
      "description: Open Spotify and play jazz",
    );
    expect(completedPrompt).toContain("result: Spotify is now open");
    expect(completedPrompt).toContain(
      "agent_state: paused; use send_input on the same thread if follow-up work is needed.",
    );
    expect(completedPrompt).toContain(
      "presentation: for a report or dense result, present it as a canvas with the `html` tool",
    );
    expect(failedPrompt).toContain("[Task failed]");
    expect(failedPrompt).toContain("error: Spotify failed to open");
    expect(canceledPrompt).toContain("[Task canceled]");
    expect(canceledPrompt).toContain("error: Canceled by user");
  });

  it("does not append external engine file changes to completed follow-ups", () => {
    const prompt = buildAgentEventPrompt({
      type: "agent-completed",
      conversationId: "conversation-1",
      rootRunId: "run-1",
      agentId: "task-1",
      agentType: "general",
      description: "Cursor implementation",
      result: "Cursor finished the delegated work.",
      fileChanges: [
        {
          path: "/repo/src/cursor-change.ts",
          kind: { type: "update" },
        },
      ],
    });

    expect(prompt).toContain("[Agent completed]");
    expect(prompt).toContain("result: Cursor finished the delegated work.");
    expect(prompt).not.toContain("explicit file changes:");
    expect(prompt).not.toContain("/repo/src/cursor-change.ts");
  });

  it("suppresses the follow-up turn when the orchestrator pauses a task itself", () => {

    const pausedPrompt = buildAgentEventPrompt({
      type: "agent-canceled",
      conversationId: "conversation-1",
      rootRunId: "run-1",
      agentId: "task-1",
      agentType: "general",
      error: AGENT_PAUSE_CANCEL_REASON,
    });

    expect(pausedPrompt).toBeNull();
  });

  it("wakes an owning parent agent when the user pauses its subagent", () => {
    const pausedPrompt = buildAgentEventPrompt(
      {
        type: "agent-canceled",
        conversationId: "conversation-1",
        eventId: "child-1:2:agent-canceled",
        agentId: "child-1",
        agentType: "general",
        error: AGENT_PAUSE_CANCEL_REASON,
      },
      { recipient: "parent_agent" },
    );

    expect(pausedPrompt).toContain("[Subagent paused]");
    expect(pausedPrompt).not.toContain("event_id:");
    expect(pausedPrompt).toContain(
      "A subagent you started reached a terminal state. This report is for you only; continue your own task.",
    );
  });

  it("still suppresses the follow-up when Stella shuts down mid-task", () => {
    const shutdownPrompt = buildAgentEventPrompt({
      type: "agent-canceled",
      conversationId: "conversation-1",
      rootRunId: "run-1",
      agentId: "task-1",
      agentType: "general",
      error: AGENT_SHUTDOWN_CANCEL_REASON,
    });

    expect(shutdownPrompt).toBeNull();
  });
});
