import { describe, expect, it, vi } from "vitest";
import { listAgentThreadMessages } from "../../../desktop/electron/services/agent-thread-history.js";

describe("agent thread lifecycle history", () => {
  it("projects dedicated lifecycle entries and deduplicates legacy custom-message rows", () => {
    const legacyEvent = {
      _id: "event-legacy",
      timestamp: 100,
      type: "agent-started",
      payload: { agentId: "child-1" },
    };
    const dedicatedEvent = {
      _id: "event-dedicated",
      timestamp: 200,
      type: "agent-completed",
      payload: { agentId: "child-1" },
    };
    const listThreadLifecycleEntries = vi.fn(() => [
      { entryId: "lifecycle-duplicate", event: legacyEvent },
      { entryId: "lifecycle-dedicated", event: dedicatedEvent },
    ]);
    const store = {
      loadThreadMessages: vi.fn(() => [
        {
          entryId: "legacy-row",
          timestamp: 100,
          role: "custom",
          content: "",
          customMessage: {
            customType: "runtime.task_lifecycle",
            eventId: legacyEvent._id,
          },
        },
      ]),
      listLifecycleEventsByIds: vi.fn(() => [legacyEvent]),
      listThreadLifecycleEntries,
      getAgentRecord: vi.fn(() => null),
    };

    const result = listAgentThreadMessages(store, {
      threadId: " child-1 ",
      limit: 25,
    });

    expect(listThreadLifecycleEntries).toHaveBeenCalledWith("child-1", 25);
    expect(result).toEqual([
      {
        entryId: "legacy-row",
        timestamp: 100,
        role: "lifecycle",
        content: "",
        lifecycleEvent: legacyEvent,
      },
      {
        entryId: "lifecycle-dedicated",
        timestamp: 200,
        role: "lifecycle",
        content: "",
        lifecycleEvent: dedicatedEvent,
      },
    ]);
  });
});
