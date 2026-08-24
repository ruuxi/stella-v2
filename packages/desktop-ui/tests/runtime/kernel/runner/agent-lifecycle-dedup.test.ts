import { describe, expect, it, vi } from "vitest";
import { buildAgentEventPrompt } from "@stella/runtime/kernel/runner/shared";
import { createAgentOrchestration } from "@stella/runtime/kernel/runner/agent-orchestration";
import {
  AGENT_PAUSE_CANCEL_REASON,
  AGENT_SHUTDOWN_CANCEL_REASON,
} from "@stella/runtime/kernel/agents/local-agent-manager";

describe("task lifecycle deduping", () => {
  it("reuses a pre-persisted lifecycle timestamp when crash delivery replays", () => {
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

    expect(sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        customType: "runtime.task_lifecycle",
        timestamp: 123,
      }),
    );
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

  it("includes external engine file changes in completed follow-ups", () => {
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
    expect(prompt).toContain("explicit file changes:");
    expect(prompt).toContain("- update: /repo/src/cursor-change.ts");
  });

  it("suppresses the follow-up turn when the orchestrator pauses a task itself", () => {
    // The orchestrator already knows it just paused the task (the pause_agent
    // tool call returned `canceled: true`). Surfacing a hidden
    // `[Task canceled]` follow-up triggers a second assistant turn that
    // typically responds silently and ends up overwriting the user-facing
    // reply, which is the bug this guards against.
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
