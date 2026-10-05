import { describe, expect, test } from "bun:test";
import { bareToolName, collectJournalTasks } from "../journal-tasks";
import { mergeJournalTasks } from "../mobile-task-merge";
import {
  resolvePostSendPlacement,
  resolvePostSendTarget,
} from "../chat-post-send-placement";
import type { CloudAgentLifecycleEvent } from "@stella/contracts/cloud-agent-lifecycle";
import type { JournalRecord } from "../cloud-conversation-protocol";
import type { MobileTask } from "../../types";

const lifecycle = (seq: number, event: CloudAgentLifecycleEvent): JournalRecord => ({
  kind: "card",
  seq,
  turnId: "t",
  createdAtMs: seq * 10,
  card: { type: "agent-lifecycle", eventId: `e${seq}`, event },
});

const message = (
  seq: number,
  role: "user" | "assistant" | "toolResult",
  payload: Record<string, unknown>,
  hidden = false,
): JournalRecord => ({
  kind: "message",
  seq,
  turnId: "t",
  createdAtMs: seq * 10,
  role,
  hidden,
  payload,
});

const spawnCall = (seq: number, id: string, name: string, description: string) =>
  message(seq, "assistant", {
    content: [
      { type: "text", text: "On it" },
      { type: "toolCall", id, name, arguments: { description } },
    ],
  });

const running = (tasks: MobileTask[]) =>
  tasks.filter((task) => task.status === "running").map((task) => task.title);

describe("journal tasks", () => {
  test("a cloud lifecycle card runs until its terminal card", () => {
    const started = [
      lifecycle(1, {
        type: "agent-started",
        payload: { agentId: "a", attemptGeneration: 1, description: "Plan the trip", agentType: "general" },
      }),
      lifecycle(2, {
        type: "agent-progress",
        payload: { agentId: "a", attemptGeneration: 1, statusText: "Comparing flights" },
      }),
    ];
    const live = collectJournalTasks(started);
    expect(live).toEqual([
      expect.objectContaining({
        id: "a",
        title: "Plan the trip",
        status: "running",
        statusText: "Comparing flights",
        agentType: "general",
      }),
    ]);

    const done = collectJournalTasks([
      ...started,
      lifecycle(3, {
        type: "agent-completed",
        payload: { agentId: "a", attemptGeneration: 1, result: "Booked" },
      }),
    ]);
    expect(done[0]).toMatchObject({ status: "completed", completedAt: 30 });
    expect(done[0]?.statusText).toBeUndefined();
  });

  test("a terminal card from an older attempt does not settle a follow-up", () => {
    const tasks = collectJournalTasks([
      lifecycle(1, {
        type: "agent-started",
        payload: { agentId: "a", attemptGeneration: 1, description: "Draft", agentType: "general" },
      }),
      lifecycle(2, {
        type: "agent-started",
        payload: { agentId: "a", attemptGeneration: 2, description: "Draft", agentType: "general", isFollowUp: true },
      }),
      lifecycle(3, {
        type: "agent-failed",
        payload: { agentId: "a", attemptGeneration: 1, error: "stale" },
      }),
    ]);
    expect(running(tasks)).toEqual(["Draft"]);
  });

  test("a computer-run spawn mirrored into the journal runs until its wake prompt", () => {
    const spawned = [
      spawnCall(1, "call-1", "spawn_agent", "Clean up downloads"),
      message(2, "toolResult", {
        toolCallId: "call-1",
        toolName: "spawn_agent",
        content: [{ type: "text", text: JSON.stringify({ thread_id: "clean-up-downloads" }) }],
      }),
    ];
    expect(running(collectJournalTasks(spawned))).toEqual(["Clean up downloads"]);

    const finished = collectJournalTasks([
      ...spawned,
      message(
        3,
        "user",
        { content: "[Agent completed]\ndescription: Clean up downloads\nthread_id: clean-up-downloads\nresult: Done" },
        true,
      ),
    ]);
    expect(finished).toEqual([
      expect.objectContaining({ id: "clean-up-downloads", status: "completed" }),
    ]);
  });

  test("reads namespaced tool names the way the runtime does", () => {
    expect(bareToolName("mcp__stella__spawn_agent")).toBe("spawn_agent");
    expect(bareToolName("spawn_agent")).toBe("spawn_agent");
    const tasks = collectJournalTasks([
      spawnCall(1, "call-1", "mcp__stella__spawn_agent", "Summarise inbox"),
      message(2, "toolResult", {
        toolCallId: "call-1",
        toolName: "mcp__stella__spawn_agent",
        details: { thread_id: "summarise-inbox" },
        content: "started",
      }),
    ]);
    expect(running(tasks)).toEqual(["Summarise inbox"]);
  });

  test("send_input resumes a finished mirrored task, and failures stay settled", () => {
    const base = [
      spawnCall(1, "call-1", "spawn_agent", "Write report"),
      message(2, "toolResult", { toolCallId: "call-1", toolName: "spawn_agent", details: { thread_id: "report" } }),
      message(3, "user", { content: "[Task failed]\nthread_id: report\nerror: boom" }, true),
    ];
    expect(collectJournalTasks(base)[0]).toMatchObject({ status: "error" });

    const resumed = collectJournalTasks([
      ...base,
      message(4, "assistant", {
        content: [{ type: "toolCall", id: "call-2", name: "send_input", arguments: { thread_id: "report" } }],
      }),
      message(5, "toolResult", { toolCallId: "call-2", toolName: "send_input", content: "ok" }),
    ]);
    expect(running(resumed)).toEqual(["Write report"]);

    const rejected = collectJournalTasks([
      ...base,
      message(4, "toolResult", { toolCallId: "call-3", toolName: "send_input", isError: true, details: { thread_id: "report" } }),
    ]);
    expect(running(rejected)).toEqual([]);
  });

  test("a carded task ignores the wake prompt the orchestrator also receives", () => {
    const tasks = collectJournalTasks([
      lifecycle(1, {
        type: "agent-started",
        payload: { agentId: "a", attemptGeneration: 1, description: "Research", agentType: "general" },
      }),
      lifecycle(2, {
        type: "agent-started",
        payload: { agentId: "a", attemptGeneration: 2, description: "Research", agentType: "general", isFollowUp: true },
      }),
      message(3, "user", { content: "[Agent completed]\nthread_id: a\nresult: first pass" }, true),
    ]);
    expect(running(tasks)).toEqual(["Research"]);
  });

  test("a wake for a task outside the loaded window adds nothing", () => {
    const tasks = collectJournalTasks([
      message(1, "user", { content: "[Agent completed]\nthread_id: old\nresult: x" }, true),
    ]);
    expect(tasks).toEqual([]);
  });
});

describe("merging journal tasks with the computer's live rows", () => {
  const task = (overrides: Partial<MobileTask>): MobileTask => ({
    id: "a",
    title: "Task",
    status: "running",
    createdAt: 100,
    ...overrides,
  });

  test("the journal alone supplies running work when no computer reports", () => {
    expect(mergeJournalTasks([task({})], [])).toEqual([task({})]);
  });

  test("a computer's terminal row settles a spawn whose wake has not mirrored yet", () => {
    const merged = mergeJournalTasks(
      [task({})],
      [task({ status: "completed", completedAt: 200 })],
    );
    expect(merged[0]).toMatchObject({ status: "completed" });
  });

  test("a stale running row cannot revive a task the journal saw finish", () => {
    const merged = mergeJournalTasks(
      [task({ status: "completed", completedAt: 200 })],
      [task({ statusText: "Reading" })],
    );
    expect(merged[0]).toMatchObject({ status: "completed" });
  });

  test("running work sorts first and the computer's status text survives", () => {
    const merged = mergeJournalTasks(
      [
        task({ id: "done", status: "completed", createdAt: 300, completedAt: 400 }),
        task({ id: "a", createdAt: 100 }),
      ],
      [task({ id: "a", createdAt: 100, statusText: "Reading files" })],
    );
    expect(merged.map((entry) => entry.id)).toEqual(["a", "done"]);
    expect(merged[0]?.statusText).toBe("Reading files");
  });
});

describe("post-send placement under a floating top bar", () => {
  test("a short row still lands with the list at its end", () => {
    expect(
      resolvePostSendTarget({
        rowTop: 900,
        rowBottom: 960,
        viewportHeight: 800,
        trailingSlackPx: 120,
        leadingInsetPx: 100,
      }),
    ).toBe(960 - 800 + 120);
  });

  test("a tall row aligns its top below the bar instead of under it", () => {
    expect(
      resolvePostSendPlacement({
        contentHeightPx: 2000,
        viewportHeightPx: 800,
        trailingSlackPx: 120,
        rowHeightPx: 640,
        leadingInsetPx: 100,
      }),
    ).toBe(2000 - 120 - 640 - 100);
  });
});
