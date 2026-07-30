import { describe, expect, test } from "bun:test";
import type { AgentLifecycleEvent } from "../agents/local-agent-manager.js";
import { appendAgentLifecycleChatEvent } from "./agent-orchestration.js";
import type { RunnerContext } from "./types.js";

const completion: AgentLifecycleEvent = {
  type: "agent-completed",
  conversationId: "conversation-1",
  agentId: "thread-1",
  agentType: "general",
  description: "Build the report",
  result: "Finished",
  fileChanges: [{ path: "report.md", kind: { type: "add" } }],
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
});
