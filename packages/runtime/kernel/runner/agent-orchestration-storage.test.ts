import { describe, expect, test } from "bun:test";
import type { AgentLifecycleEvent } from "../agents/local-agent-manager.js";
import {
  appendAgentLifecycleChatEvent,
  hasDurableAgentLifecycleEvent,
} from "./agent-orchestration.js";
import type { RunnerContext } from "./types.js";

const completion: AgentLifecycleEvent = {
  type: "agent-completed",
  conversationId: "conversation-1",
  agentId: "thread-1",
  agentType: "general",
  description: "Build the report",
  result: "Finished",
};

describe("agent lifecycle transcript ownership", () => {
  test("keeps cloud agent lifecycle details out of local chat events", () => {
    const appended: unknown[] = [];
    const context = {
      runtimeStore: {
        getAgentRecord: () => ({ storageMode: "cloud" }),
      },
      appendLocalChatEvent: (event: unknown) => appended.push(event),
    } as unknown as RunnerContext;

    appendAgentLifecycleChatEvent(context, completion);

    expect(appended).toEqual([]);
  });

  test("retains lifecycle chat events for explicit local conversations", () => {
    const appended: unknown[] = [];
    const context = {
      runtimeStore: {
        getAgentRecord: () => ({ storageMode: "local" }),
      },
      appendLocalChatEvent: (event: unknown) => appended.push(event),
    } as unknown as RunnerContext;

    appendAgentLifecycleChatEvent(context, completion);

    expect(appended).toHaveLength(1);
  });

  test("requires both the parent reminder and its durable wake receipt", () => {
    const eventId = "child-thread:2:agent-completed";
    let wakeAccepted = false;
    const context = {
      state: {
        localAgentManager: {
          resolveOwningParentThread: () => "parent-thread",
        },
      },
      runtimeStore: {
        loadRawThreadMessages: (threadKey: string) =>
          threadKey === "parent-thread"
            ? [
                {
                  customMessage: {
                    customType: "runtime.task_lifecycle",
                    eventId,
                  },
                },
              ]
            : [],
        getAgentRecord: () => ({
          descendantBoundaryState: {
            consumedEventIds: wakeAccepted ? [eventId] : [],
            wakePending: wakeAccepted,
          },
        }),
        hasEvent: () => false,
      },
    } as unknown as RunnerContext;
    const event: AgentLifecycleEvent = {
      ...completion,
      eventId,
      attemptGeneration: 2,
      audience: "orchestrator-only",
    };

    expect(hasDurableAgentLifecycleEvent(context, event)).toBe(false);
    wakeAccepted = true;
    expect(hasDurableAgentLifecycleEvent(context, event)).toBe(true);
  });
});
