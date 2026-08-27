import { describe, expect, it } from "vitest";
import {
  TASK_COMPLETION_INDICATOR_MS,
  buildActivityTasks,
  fallbackTaskDescription,
  isActivityFeedTask,
  extractStepsFromEvents,
  getTaskHierarchyStatusText,
  groupActivityTasks,
  selectFreshActivityTasks,
  updateSeenRunningTaskIds,
  type EventRecord,
  type TaskItem,
} from "@/features/chat/lib/event-transforms";
import type { ThreadActivityRecord } from "@stella/contracts/local-chat";
import {
  buildInlineWorkingIndicatorProps,
  getInlineWorkingIndicatorActive,
  getInlineWorkingIndicatorExitDelayMs,
  shouldTreatResumedAnswerAsStarted,
} from "@/features/chat/working-indicator-state";

const event = (
  id: string,
  timestamp: number,
  type: string,
  payload: Record<string, unknown>,
): EventRecord => ({
  _id: id,
  timestamp,
  type,
  payload,
});

describe("internal helper agent exclusion", () => {
  it("keeps delegated General agents in the activity feed", () => {
    expect(isActivityFeedTask({ agentType: "general" })).toBe(true);
    // The Manager agent type is retired; its rows read as machinery.
    expect(isActivityFeedTask({ agentType: "manager" })).toBe(false);
    expect(isActivityFeedTask({ agentType: "schedule" })).toBe(false);
    expect(isActivityFeedTask({ agentType: "dream" })).toBe(false);
    expect(isActivityFeedTask({ agentType: "orchestrator" })).toBe(false);
  });
});

describe("fallbackTaskDescription", () => {
  it("de-slugs descriptive thread ids into a readable label", () => {
    expect(
      fallbackTaskDescription(
        "sprite-animation-test-rig-in-harness-hmr-reload",
      ),
    ).toBe("Sprite animation test rig in harness hmr reload");
  });

  it("keeps 'Task' for ordinal/namespace/opaque ids with no real words", () => {
    expect(fallbackTaskDescription("task-7")).toBe("Task");
    expect(fallbackTaskDescription(undefined)).toBe("Task");
    expect(fallbackTaskDescription("1234-5678")).toBe("Task");
    expect(fallbackTaskDescription("a1")).toBe("Task");
  });

  it("only de-slugs ids in the spawn-slug format", () => {
    // Underscores, uppercase, and other alphabets never come out of the
    // runtime's slugify(); such ids are opaque, not withheld descriptions.
    expect(fallbackTaskDescription("fix_the_bug")).toBe("Task");
    expect(fallbackTaskDescription("Fix-The-Bug")).toBe("Task");
    expect(fallbackTaskDescription("fix the bug")).toBe("Task");
    expect(fallbackTaskDescription("-fix-the-bug")).toBe("Task");
    // Longer than slugify's 48-char cap.
    expect(
      fallbackTaskDescription(
        "compare-flight-prices-for-the-family-trip-to-portugal-in-june",
      ),
    ).toBe("Task");
    expect(fallbackTaskDescription("x7f")).toBe("Task");
  });

  it("still de-slugs meaningful single-word ids", () => {
    expect(fallbackTaskDescription("research")).toBe("Research");
  });
});

describe("manager ownership hierarchy", () => {
  const task = (overrides: Partial<TaskItem> & { id: string }): TaskItem => ({
    description: "Task",
    agentType: "general",
    status: "running",
    startedAtMs: 100,
    lastUpdatedAtMs: 100,
    ...overrides,
  });

  it("nests multiple owned agents under their manager without root duplicates", () => {
    const rows = groupActivityTasks([
      task({ id: "manager", agentType: "manager", description: "Coordinate" }),
      task({ id: "research", parentAgentId: "manager" }),
      task({ id: "draft", parentAgentId: "manager", status: "completed" }),
      task({ id: "unrelated", description: "Independent" }),
    ]);

    expect(rows.map((row) => row.kind)).toEqual(["hierarchy", "task"]);
    const hierarchy =
      rows[0]!.kind === "hierarchy" ? rows[0].hierarchy : undefined;
    expect(hierarchy?.owner.id).toBe("manager");
    expect(
      hierarchy?.children.map((row) =>
        row.kind === "task" ? [row.task.id, row.task.status] : [row.kind],
      ),
    ).toEqual([
      ["research", "running"],
      ["draft", "completed"],
    ]);
    expect(hierarchy?.descendantCount).toBe(2);
    expect(getTaskHierarchyStatusText(hierarchy!)).toBe("2 agents");
    expect(
      rows.some((row) => row.kind === "task" && row.task.id === "research"),
    ).toBe(false);
  });

  it("moves an adopted agent beneath the manager from persisted ownership", () => {
    const manager = task({ id: "manager", agentType: "manager" });
    const nextManager = task({ id: "next-manager", agentType: "manager" });
    const child = task({ id: "adopted" });
    expect(
      groupActivityTasks([manager, nextManager, child]).map((row) => row.kind),
    ).toEqual(["task", "task", "task"]);

    const adopted = groupActivityTasks([
      manager,
      nextManager,
      { ...child, parentAgentId: manager.id, lastUpdatedAtMs: 200 },
    ]);
    expect(adopted).toHaveLength(2);
    expect(adopted[0]?.kind).toBe("hierarchy");
    if (adopted[0]?.kind === "hierarchy") {
      expect(adopted[0].hierarchy.children[0]).toMatchObject({
        kind: "task",
        task: { id: "adopted" },
      });
    }

    const reparented = groupActivityTasks([
      manager,
      nextManager,
      { ...child, parentAgentId: nextManager.id, lastUpdatedAtMs: 300 },
    ]);
    expect(reparented.map((row) => row.kind)).toEqual(["task", "hierarchy"]);
    if (reparented[1]?.kind === "hierarchy") {
      expect(reparented[1].hierarchy).toMatchObject({
        owner: { id: "next-manager" },
        children: [{ kind: "task", task: { id: "adopted" } }],
      });
    }
  });

  it("preserves running, paused, completed, and recursive descendant state", () => {
    const rows = groupActivityTasks([
      task({
        id: "manager",
        agentType: "manager",
        status: "completed",
        completedAtMs: 500,
        outputPreview: "Coordination complete",
      }),
      task({ id: "running", parentAgentId: "manager" }),
      task({ id: "paused", parentAgentId: "manager", status: "canceled" }),
      task({
        id: "complete",
        parentAgentId: "manager",
        status: "completed",
      }),
      task({ id: "descendant", parentAgentId: "running", status: "error" }),
    ]);

    expect(rows).toHaveLength(1);
    const hierarchy =
      rows[0]!.kind === "hierarchy" ? rows[0].hierarchy : undefined;
    expect(hierarchy?.owner).toMatchObject({
      status: "completed",
      outputPreview: "Coordination complete",
    });
    expect(hierarchy?.descendantCount).toBe(4);
    expect(
      hierarchy?.children.map((row) =>
        row.kind === "hierarchy"
          ? [row.hierarchy.owner.id, row.hierarchy.owner.status]
          : row.kind === "task"
            ? [row.task.id, row.task.status]
            : [row.kind],
      ),
    ).toEqual([
      ["running", "running"],
      ["paused", "canceled"],
      ["complete", "completed"],
    ]);
    const nested = hierarchy?.children[0];
    expect(nested?.kind).toBe("hierarchy");
    if (nested?.kind === "hierarchy") {
      expect(nested.hierarchy.children[0]).toMatchObject({
        kind: "task",
        task: { id: "descendant", status: "error" },
      });
    }
  });
});

describe("extractStepsFromEvents", () => {
  it("does not guess a tool result target when the result has no request id", () => {
    const steps = extractStepsFromEvents([
      event("1", 100, "tool_request", {
        toolName: "exec_command",
        requestId: "tool-1",
      }),
      event("2", 200, "tool_request", {
        toolName: "exec_command",
        requestId: "tool-2",
      }),
      event("3", 300, "tool_result", {
        toolName: "exec_command",
      }),
    ]);

    expect(steps.map((step) => step.status)).toEqual(["running", "running"]);
  });
});

describe("getInlineWorkingIndicatorActive", () => {
  it("stays visible through thinking, tools and spawned agents until text starts", () => {
    // Pre-tool thinking.
    expect(
      getInlineWorkingIndicatorActive({
        isStreaming: true,
        isStreamingResponseText: false,
        isToolActive: false,
      }),
    ).toBe(true);

    // A tool is actively running.
    expect(
      getInlineWorkingIndicatorActive({
        isStreaming: true,
        isStreamingResponseText: false,
        isToolActive: true,
      }),
    ).toBe(true);

    // Gap after a fast tool returns, before the next tool/answer: keep the
    // thinking label up instead of going blank.
    expect(
      getInlineWorkingIndicatorActive({
        isStreaming: true,
        isStreamingResponseText: false,
        isToolActive: false,
      }),
    ).toBe(true);

    // First visible provider delta: hand off.
    expect(
      getInlineWorkingIndicatorActive({
        isStreaming: true,
        isStreamingResponseText: true,
        isToolActive: false,
      }),
    ).toBe(false);

    // A later tool after text has started: show again.
    expect(
      getInlineWorkingIndicatorActive({
        isStreaming: true,
        isStreamingResponseText: true,
        isToolActive: true,
      }),
    ).toBe(true);

    // Run ended: nothing to show.
    expect(
      getInlineWorkingIndicatorActive({
        isStreaming: false,
        isStreamingResponseText: false,
        isToolActive: false,
      }),
    ).toBe(false);
  });
});

describe("buildInlineWorkingIndicatorProps", () => {
  it("stays visible during pre-text thinking", () => {
    const props = buildInlineWorkingIndicatorProps({
      isStreaming: true,
      isStreamingResponseText: false,
      isToolActive: false,
    });
    expect(props.active).toBe(true);
    // Floor-only: never an early dismiss, so no immediate-exit handoff.
    expect(props.exitImmediately).toBeUndefined();
  });

  it("stays visible while a tool / spawned agent is the turn's first action", () => {
    const props = buildInlineWorkingIndicatorProps({
      isStreaming: true,
      isStreamingResponseText: false,
      isToolActive: true,
      activeToolName: "spawn_agent",
      activeToolCallId: "call-1",
    });
    expect(props.active).toBe(true);
    expect(props.runningTool).toBe("spawn_agent");
  });

  it("stays visible before the first visible delta arrives", () => {
    const props = buildInlineWorkingIndicatorProps({
      isStreaming: true,
      isStreamingResponseText: false,
      isToolActive: false,
    });
    expect(props.active).toBe(true);
  });

  it("hands off on the first visible provider delta", () => {
    const props = buildInlineWorkingIndicatorProps({
      isStreaming: true,
      isStreamingResponseText: true,
      isToolActive: false,
    });
    expect(props.active).toBe(false);
    expect(props.exitImmediately).toBe(true);
  });
});

describe("shouldTreatResumedAnswerAsStarted", () => {
  it("treats a resumed, already-visible answer with no live overlay as started", () => {
    expect(
      shouldTreatResumedAnswerAsStarted({
        isStreaming: true,
        isStreamingResponseText: false,
        hasLiveStreamingOverlay: false,
        activeTurnAnswerVisible: true,
      }),
    ).toBe(true);
  });

  it("is a no-op while a live overlay is streaming the answer", () => {
    expect(
      shouldTreatResumedAnswerAsStarted({
        isStreaming: true,
        isStreamingResponseText: false,
        hasLiveStreamingOverlay: true,
        activeTurnAnswerVisible: true,
      }),
    ).toBe(false);
  });

  it("does not fire when the resumed run has no visible answer yet (still thinking)", () => {
    expect(
      shouldTreatResumedAnswerAsStarted({
        isStreaming: true,
        isStreamingResponseText: false,
        hasLiveStreamingOverlay: false,
        activeTurnAnswerVisible: false,
      }),
    ).toBe(false);
  });

  it("is a no-op once the indicator already handed off, or when no run is active", () => {
    expect(
      shouldTreatResumedAnswerAsStarted({
        isStreaming: true,
        isStreamingResponseText: true,
        hasLiveStreamingOverlay: false,
        activeTurnAnswerVisible: true,
      }),
    ).toBe(false);
    expect(
      shouldTreatResumedAnswerAsStarted({
        isStreaming: false,
        isStreamingResponseText: false,
        hasLiveStreamingOverlay: false,
        activeTurnAnswerVisible: true,
      }),
    ).toBe(false);
  });
});

describe("getInlineWorkingIndicatorExitDelayMs", () => {
  it("holds fast tool calls long enough to be readable", () => {
    expect(
      getInlineWorkingIndicatorExitDelayMs({
        activatedAtMs: 1_000,
        nowMs: 1_250,
      }),
    ).toBe(1_750);

    expect(
      getInlineWorkingIndicatorExitDelayMs({
        activatedAtMs: 1_000,
        nowMs: 3_100,
      }),
    ).toBe(0);
  });
});

describe("seen-running expansion stickiness", () => {
  const task = (overrides: Partial<TaskItem> & { id: string }): TaskItem => ({
    description: "Task",
    agentType: "general",
    status: "running",
    startedAtMs: 100,
    lastUpdatedAtMs: 100,
    ...overrides,
  });

  it("keeps a task's id after it completes (row must not auto-collapse)", () => {
    const whileRunning = updateSeenRunningTaskIds(new Set(), [
      task({ id: "a1" }),
    ]);
    expect(whileRunning.has("a1")).toBe(true);
    const afterCompletion = updateSeenRunningTaskIds(whileRunning, [
      task({ id: "a1", status: "completed" }),
    ]);
    expect(afterCompletion.has("a1")).toBe(true);
  });

  it("never admits tasks that were only ever seen completed (history rows)", () => {
    const seen = updateSeenRunningTaskIds(new Set(), [
      task({ id: "old", status: "completed" }),
    ]);
    expect(seen.has("old")).toBe(false);
  });

  it("prunes ids whose task left the list and keeps the reference stable otherwise", () => {
    const seen = updateSeenRunningTaskIds(new Set(), [task({ id: "a1" })]);
    // Unchanged input → same reference (memo-friendly).
    expect(updateSeenRunningTaskIds(seen, [task({ id: "a1" })])).toBe(seen);
    // Task aged out of the window → id pruned.
    const pruned = updateSeenRunningTaskIds(seen, [
      task({ id: "other", status: "completed" }),
    ]);
    expect(pruned.has("a1")).toBe(false);
  });

  it("survives a send_input re-run cycle (running → completed → running → completed)", () => {
    let seen: ReadonlySet<string> = new Set();
    seen = updateSeenRunningTaskIds(seen, [task({ id: "a1" })]);
    seen = updateSeenRunningTaskIds(seen, [
      task({ id: "a1", status: "completed" }),
    ]);
    seen = updateSeenRunningTaskIds(seen, [task({ id: "a1" })]);
    seen = updateSeenRunningTaskIds(seen, [
      task({ id: "a1", status: "completed" }),
    ]);
    expect(seen.has("a1")).toBe(true);
  });
});

describe("buildActivityTasks", () => {
  const record = (
    overrides: Partial<ThreadActivityRecord> = {},
  ): ThreadActivityRecord => ({
    threadId: "research-flights",
    conversationId: "conv-1",
    agentType: "general",
    description: "Research flights",
    status: "running",
    startedAt: 1_000,
    updatedAt: 1_500,
    ...overrides,
  });

  it("maps authoritative rows and overlays decoration only on running rows", () => {
    const tasks = buildActivityTasks(
      [
        record(),
        record({
          threadId: "book-hotel",
          description: "Book the hotel",
          status: "completed",
          rootRunId: "root-2",
          startedAt: 2_000,
          completedAt: 3_000,
          updatedAt: 3_000,
          result: "Booked the Marriott",
        }),
      ],
      {
        "research-flights": {
          statusText: "Comparing fares",
          reasoningText: "checking SAS…",
        },
        // Decoration for a terminal row must be ignored entirely — a stale
        // "running" leftover can never re-open a finished thread.
        "book-hotel": { statusText: "still working" },
      },
    );

    expect(tasks).toHaveLength(2);
    const [running, done] = tasks;
    expect(running).toMatchObject({
      id: "research-flights",
      status: "running",
      description: "Research flights",
      statusText: "Comparing fares",
      reasoningText: "checking SAS…",
    });
    expect(done).toMatchObject({
      id: "book-hotel",
      status: "completed",
      description: "Book the hotel",
      runId: "root-2",
      completedAtMs: 3_000,
      outputPreview: "Booked the Marriott",
    });
    expect(done?.statusText).toBeUndefined();
    expect(done?.reasoningText).toBeUndefined();
  });

  it("shows the durable spawn description after a send_input follow-up", () => {
    const tasks = buildActivityTasks([
      record({ description: "Travel" }),
    ]);
    expect(tasks[0]?.description).toBe("Travel");
  });

  it("keeps the durable task description when a newer live attempt reports tool status", () => {
    const tasks = buildActivityTasks(
      [
        record({
          description: "Chrome Web Store Stella Browser fresh retry",
          attemptGeneration: 1,
          rootRunId: "run-1",
        }),
      ],
      {
        "research-flights": {
          status: "running",
          attemptGeneration: 2,
          runId: "run-2",
          startedAtMs: 2_000,
          observedAtMs: 2_100,
          statusText: "Running Node Repl",
        },
      },
    );

    expect(tasks[0]).toMatchObject({
      description: "Chrome Web Store Stella Browser fresh retry",
      statusText: "Checking",
      attemptGeneration: 2,
      runId: "run-2",
    });
  });

  it("falls back to the description as statusText for running rows without decoration", () => {
    const tasks = buildActivityTasks([record()]);
    expect(tasks[0]?.statusText).toBe("Research flights");
  });

  it("excludes orchestrator-internal helper agents", () => {
    const tasks = buildActivityTasks([
      record({ threadId: "helper", agentType: "schedule" }),
      record(),
    ]);
    expect(tasks.map((task) => task.id)).toEqual(["research-flights"]);
  });

  // Retired `manager` rows are machinery now, so they drop out of the feed
  // while the ownership edge on their surviving children is preserved.
  it("drops retired manager rows but keeps persisted ownership on children", () => {
    const tasks = buildActivityTasks([
      record({
        threadId: "parent",
        description: "Coordinate work",
      }),
      record({
        threadId: "retired",
        agentType: "manager",
        description: "Old manager",
      }),
      record({
        threadId: "child",
        parentAgentId: "parent",
      }),
    ]);

    expect(tasks.map((task) => task.id)).toEqual(["child", "parent"]);
    expect(tasks.find((task) => task.id === "child")).toMatchObject({
      id: "child",
      parentAgentId: "parent",
    });
  });

  it("surfaces the error text as the preview for failed rows", () => {
    const tasks = buildActivityTasks([
      record({
        status: "error",
        completedAt: 2_000,
        updatedAt: 2_000,
        error: "Mailbox unreachable",
      }),
    ]);
    expect(tasks[0]).toMatchObject({
      status: "error",
      outputPreview: "Mailbox unreachable",
    });
  });

  it("orders by started time with id tie-break", () => {
    const tasks = buildActivityTasks([
      record({ threadId: "b-second", startedAt: 2_000 }),
      record({ threadId: "a-first", startedAt: 1_000 }),
      record({ threadId: "a-also-second", startedAt: 2_000 }),
    ]);
    expect(tasks.map((task) => task.id)).toEqual([
      "a-first",
      "a-also-second",
      "b-second",
    ]);
  });
});

describe("selectFreshActivityTasks", () => {
  const task = (overrides: Partial<TaskItem>): TaskItem => ({
    id: "t",
    description: "Task",
    agentType: "general",
    // Presence surfaces only count rows Stella owns; claude-native rows are
    // observability, so the selector requires an explicit `stella` source.
    source: "stella",
    status: "running",
    startedAtMs: 0,
    lastUpdatedAtMs: 0,
    ...overrides,
  });

  it("keeps running rows and recently-finished rows, drops old history", () => {
    const nowMs = 100_000;
    const fresh = selectFreshActivityTasks(
      [
        task({ id: "running" }),
        task({
          id: "just-done",
          status: "completed",
          completedAtMs: nowMs - TASK_COMPLETION_INDICATOR_MS + 500,
        }),
        task({ id: "old-done", status: "completed", completedAtMs: 1_000 }),
        task({ id: "old-error", status: "error", completedAtMs: 2_000 }),
      ],
      nowMs,
    );
    expect(fresh.map((entry) => entry.id)).toEqual(["running", "just-done"]);
  });
});
