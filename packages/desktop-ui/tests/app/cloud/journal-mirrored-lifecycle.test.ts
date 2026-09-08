import { describe, expect, test } from "vitest";
import type { JournalRecord } from "../../../src/features/cloud/conversation-protocol";
import {
  journalRecordsToMessageRecords,
  lifecycleWakeOutcome,
} from "../../../src/features/cloud/journal-message-records";
import { buildBackgroundTaskLifecycleIndex } from "../../../src/features/chat/lib/background-task-lifecycle";
import { projectAgentCompletionSections } from "../../../src/features/chat/hooks/use-event-rows";

const message = (
  seq: number,
  turnId: string,
  role: "user" | "assistant" | "toolResult",
  payload: Record<string, unknown>,
  extra: Partial<Extract<JournalRecord, { kind: "message" }>> = {},
): JournalRecord =>
  ({
    kind: "message",
    seq,
    turnId,
    createdAtMs: seq * 10,
    role,
    hidden: false,
    payload: { role, timestamp: seq * 10, ...payload },
    ...extra,
  }) as JournalRecord;

const wakeText = [
  "<system-reminder>",
  "The agent has finished. The user cannot see this report.",
  "</system-reminder>",
  "[Agent completed]",
  "description: create local-notes file",
  "thread_id: create-local-notes-file",
  "result: Created it.\n\n[local-notes.md](/Users/me/local-notes.md)",
  "agent_state: paused; use send_input on the same thread if follow-up work is needed.",
  "presentation: keep it short.",
].join("\n");

describe("desktop-executed turns mirrored into the journal", () => {
  test("reads the result body out of a wake prompt", () => {
    expect(lifecycleWakeOutcome(wakeText)).toEqual({
      kind: "completed",
      body: "Created it.\n\n[local-notes.md](/Users/me/local-notes.md)",
    });
    expect(lifecycleWakeOutcome("[Task failed]\nthread_id: t\nerror: boom")).toEqual({
      kind: "failed",
      body: "boom",
    });
    expect(lifecycleWakeOutcome("plain prompt")).toBeNull();
  });

  test("synthesizes the spawn and the completion the worker would have carded", () => {
    const records: JournalRecord[] = [
      message(0, "desktop:t1", "user", { content: [{ type: "text", text: "spawn it" }] }, { clientMsgId: "local-1" }),
      message(1, "desktop:t1", "assistant", {
        content: [
          { type: "text", text: "starting" },
          { type: "toolCall", id: "call-1", name: "spawn_agent", arguments: { description: "create local-notes file" } },
        ],
      }),
      message(2, "desktop:t1", "toolResult", {
        toolCallId: "call-1",
        toolName: "spawn_agent",
        content: [{ type: "text", text: JSON.stringify({ status: "spawned_running_in_background", thread_id: "create-local-notes-file" }) }],
      }),
      message(3, "desktop:t1", "assistant", { content: [{ type: "text", text: "on it" }] }),
      message(4, "desktop:t2", "user", { content: [{ type: "text", text: wakeText }] }, { hidden: true, clientMsgId: "message:wake-1" }),
      message(5, "desktop:t2", "assistant", { content: [{ type: "text", text: "done: [local-notes.md](/Users/me/local-notes.md)" }] }),
    ];
    const messages = journalRecordsToMessageRecords(records);
    const byId = new Map(messages.map((entry) => [entry._id, entry]));
    expect(byId.get("cloud:desktop:t1:message:1")?.toolEvents.map((e) => e.type)).toEqual([
      "tool_request",
      "tool_result",
      "agent-started",
    ]);
    expect(byId.get("message:wake-1")?.toolEvents).toEqual([]);
    const relay = byId.get("cloud:desktop:t2:message:5");
    expect(relay?.toolEvents.map((e) => e.type)).toEqual(["agent-completed"]);

    const index = buildBackgroundTaskLifecycleIndex(messages.flatMap((entry) => entry.toolEvents));
    const sections = projectAgentCompletionSections(relay!.toolEvents, index);
    expect(sections).toHaveLength(1);
    expect(sections[0]).toMatchObject({
      agentId: "create-local-notes-file",
      title: "create local-notes file",
    });
    expect(sections[0]!.files.map((entry) => entry.path)).toEqual(["/Users/me/local-notes.md"]);
  });

  test("leaves a task alone when the turn already carries its lifecycle card", () => {
    const records: JournalRecord[] = [
      message(0, "t1", "user", { content: [{ type: "text", text: "spawn it" }] }),
      message(1, "t1", "assistant", {
        content: [{ type: "toolCall", id: "call-1", name: "spawn_agent", arguments: { description: "d" } }],
      }),
      {
        kind: "card",
        seq: 2,
        turnId: "t1",
        createdAtMs: 20,
        card: {
          type: "agent-lifecycle",
          eventId: "cloud:t1:call-1:agent-started",
          event: { type: "agent-started", payload: { agentId: "thr-1", attemptGeneration: 1, description: "d", agentType: "general" } },
        },
      } as JournalRecord,
      message(3, "t1", "toolResult", {
        toolCallId: "call-1",
        toolName: "spawn_agent",
        details: { thread_id: "thr-1", status: "running", description: "d" },
        content: [{ type: "text", text: "Spawned" }],
      }),
      message(4, "t1", "assistant", { content: [{ type: "text", text: "on it" }] }),
    ];
    const messages = journalRecordsToMessageRecords(records);
    const starts = messages.flatMap((entry) => entry.toolEvents).filter((e) => e.type === "agent-started");
    expect(starts).toHaveLength(1);
    expect(starts[0]!._id).toBe("cloud:t1:call-1:agent-started");
  });

  test("projects a blank unflagged prompt (an older mirrored wake) as hidden", () => {
    const records: JournalRecord[] = [
      message(0, "desktop:t9", "user", { content: [{ type: "text", text: "" }] }, { clientMsgId: "message:old-wake" }),
      message(1, "desktop:t9", "assistant", { content: [{ type: "text", text: "done" }] }),
    ];
    const [prompt] = journalRecordsToMessageRecords(records);
    expect(prompt?._id).toBe("message:old-wake");
    expect(
      (prompt?.payload as { metadata?: { ui?: { visibility?: string } } })?.metadata?.ui?.visibility,
    ).toBe("hidden");
  });
});
