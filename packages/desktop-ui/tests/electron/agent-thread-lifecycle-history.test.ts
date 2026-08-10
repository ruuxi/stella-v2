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

  it("projects only persisted reasoning and tool activity without synthetic progress summaries", () => {
    const store = {
      loadThreadMessages: vi.fn(() => [
        {
          entryId: "assistant-tool-turn",
          timestamp: 100,
          role: "assistant",
          content: "",
          payload: {
            role: "assistant",
            content: [
              {
                type: "thinking",
                thinking:
                  'Checking Authorization: Bearer reasoning-secret. {"password":"json-secret"} The passphrase is prose-secret.',
              },
              {
                type: "toolCall",
                id: "call-1",
                name: "exec_command",
                arguments: {
                  command: "curl https://example.com?token=tool-input-secret",
                  password: "plain-password-secret",
                  screenshot: {
                    mimeType: "image/png",
                    data: "A".repeat(1_000),
                  },
                },
              },
            ],
          },
        },
        {
          entryId: "tool-result",
          timestamp: 110,
          role: "toolResult",
          content: "",
          payload: {
            role: "toolResult",
            toolCallId: "call-1",
            toolName: "exec_command",
            isError: false,
            content: [
              {
                type: "text",
                text: `Cookie: session=result-secret\napiKey: colon-secret\n${"x".repeat(13_000)}`,
              },
            ],
          },
        },
      ]),
      listLifecycleEventsByIds: vi.fn(() => []),
      listThreadLifecycleEntries: vi.fn(() => []),
      listAgentAssistantMessages: vi.fn(() => [
        "Synthetic generated progress summary",
      ]),
      getAgentRecord: vi.fn(() => null),
    };

    const result = listAgentThreadMessages(store, {
      threadId: "agent-tool-only",
    });

    expect(result.map((record) => record.role)).toEqual(["reasoning", "tool"]);
    expect(store.listAgentAssistantMessages).not.toHaveBeenCalled();
    expect(result.some((record) => record.role === "assistant")).toBe(false);
    expect(JSON.stringify(result)).not.toContain(
      "Synthetic generated progress summary",
    );
    expect(result[0]).toMatchObject({
      entryId: "assistant-tool-turn:block:0",
      content: expect.stringContaining("Checking Authorization: [REDACTED]"),
    });
    expect(result[1]).toMatchObject({
      entryId: "assistant-tool-turn:block:1",
      content: "exec_command completed",
      toolActivity: {
        toolCallId: "call-1",
        toolName: "exec_command",
        status: "completed",
        completedAt: 110,
      },
    });
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("reasoning-secret");
    expect(serialized).not.toContain("tool-input-secret");
    expect(serialized).not.toContain("plain-password-secret");
    expect(serialized).not.toContain("result-secret");
    expect(serialized).not.toContain("json-secret");
    expect(serialized).not.toContain("prose-secret");
    expect(serialized).not.toContain("colon-secret");
    expect(result[1]?.toolActivity?.input).toContain(
      '"password": "[REDACTED]"',
    );
    expect(result[1]?.toolActivity?.input).toContain(
      "[Binary data omitted: 1,000 characters]",
    );
    expect(result[1]?.toolActivity?.input).not.toContain("A".repeat(100));
    expect(result[1]?.toolActivity?.output).toContain(
      "characters omitted from this view",
    );
  });

  it("keeps compaction checkpoints typed separately from authored assistant prose", () => {
    const store = {
      loadThreadMessages: vi.fn(() => [
        {
          entryId: "compaction-1",
          timestamp: 100,
          role: "assistant",
          content:
            "[[THREAD_CHECKPOINT]]\n\n## Goal\nInspect the active agent thread.",
        },
        {
          entryId: "assistant-after-compaction",
          timestamp: 200,
          role: "assistant",
          content: "",
          payload: {
            role: "assistant",
            content: [
              { type: "thinking", thinking: "Continue from the checkpoint." },
            ],
          },
        },
      ]),
      listLifecycleEventsByIds: vi.fn(() => []),
      listThreadLifecycleEntries: vi.fn(() => []),
      getAgentRecord: vi.fn(() => null),
    };

    const result = listAgentThreadMessages(store, {
      threadId: "agent-compacted",
    });

    expect(result).toEqual([
      {
        entryId: "compaction-1",
        timestamp: 100,
        role: "checkpoint",
        content: "## Goal\nInspect the active agent thread.",
      },
      {
        entryId: "assistant-after-compaction:block:0",
        timestamp: 200,
        role: "reasoning",
        content: "Continue from the checkpoint.",
      },
    ]);
  });
});
