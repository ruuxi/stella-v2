import { describe, expect, test } from "bun:test";

import type { ChatArtifact, ChatMessage, MobileTask } from "../../types";
import { agentWorkCardSections } from "../agent-artifact-consolidation";
import { filterHubArtifacts } from "../activity-hub-search";
import {
  ACTIVITY_PAGE_SIZE,
  collectActivityHubArtifacts,
  groupActivityArtifacts,
  initialActivityWindow,
  loadNewerActivityWindow,
  loadOlderActivityWindow,
  rebaseActivityWindow,
  sortHubTasksByRecency,
} from "../activity-hub-model";

const task = (id: string): MobileTask => ({
  id,
  title: `Task ${id}`,
  status: "completed",
  createdAt: 1_000,
});

const markdown = (id: string, filePath: string): ChatArtifact => ({
  id,
  conversationId: "computer",
  payload: { kind: "markdown", filePath },
});

describe("activity hub artifact ownership", () => {
  test("groups only explicitly attributed files on modern consolidated rows", () => {
    const orchestratorFile = markdown("orchestrator", "/tmp/orchestrator.md");
    const work: ChatArtifact = {
      id: "agent-work:a1",
      conversationId: "computer",
      payload: {
        kind: "agent-work",
        state: "done",
        agentIds: ["a1", "a2"],
        total: 2,
        completed: 2,
        title: "Two tasks",
        subtitle: "Finished",
        createdAt: 1_000,
        agents: [
          {
            agentId: "a1",
            title: "First",
            files: [{ kind: "markdown", filePath: "/tmp/first.md" }],
          },
          {
            agentId: "a2",
            title: "Second",
            files: [{ kind: "markdown", filePath: "/tmp/second.md" }],
          },
        ],
      },
    };
    const sections = agentWorkCardSections(
      work as Parameters<typeof agentWorkCardSections>[0],
    );
    const files = sections?.flatMap((section) => section.files) ?? [];
    const messages: Pick<ChatMessage, "artifacts" | "tasks">[] = [
      {
        artifacts: [orchestratorFile, work],
        tasks: [task("a1"), task("a2")],
      },
    ];

    const grouped = groupActivityArtifacts(messages, [
      orchestratorFile,
      ...files,
    ]);

    expect(grouped.byTaskId.get("a1")?.map((file) => file.payload)).toEqual([
      { kind: "markdown", filePath: "/tmp/first.md" },
    ]);
    expect(grouped.byTaskId.get("a2")?.map((file) => file.payload)).toEqual([
      { kind: "markdown", filePath: "/tmp/second.md" },
    ]);
    expect(grouped.conversation.map((file) => file.id)).toEqual([
      "orchestrator",
    ]);
  });

  test("uses row-scoped fallback only when one legacy task can own the file", () => {
    const taskFile = markdown("task-file", "/tmp/task.md");
    const mainFile = markdown("main-file", "/tmp/main.md");
    const messages: Pick<ChatMessage, "artifacts" | "tasks">[] = [
      { artifacts: [taskFile], tasks: [task("a1")] },
      { artifacts: [mainFile] },
    ];

    const grouped = groupActivityArtifacts(messages, [mainFile, taskFile]);

    expect(grouped.byTaskId.get("a1")?.map((file) => file.id)).toEqual([
      "task-file",
    ]);
    expect(grouped.conversation.map((file) => file.id)).toEqual(["main-file"]);
  });

  test("keeps ambiguous legacy loose files conversation-owned", () => {
    const loose = markdown("loose", "/tmp/loose.md");
    const messages: Pick<ChatMessage, "artifacts" | "tasks">[] = [
      { artifacts: [loose], tasks: [task("a1"), task("a2")] },
    ];

    const grouped = groupActivityArtifacts(messages, [loose]);

    expect(grouped.byTaskId.size).toBe(0);
    expect(grouped.conversation.map((file) => file.id)).toEqual(["loose"]);
  });
});

describe("activity hub source data", () => {
  test("keeps the full deduplicated artifact set available to search", () => {
    const artifacts = Array.from({ length: 25 }, (_, index) =>
      markdown(`file-${index}`, `/tmp/report-${index}.md`),
    );
    const messages = artifacts.map((artifact) => ({ artifacts: [artifact] }));

    const collected = collectActivityHubArtifacts(messages);

    expect(collected).toHaveLength(25);
    expect(
      filterHubArtifacts(collected, "report-0").map((file) => file.id),
    ).toEqual(["file-0"]);
  });

  test("sorts by activity timestamp without pinning running tasks", () => {
    const tasks = [
      task("old-running"),
      ...Array.from({ length: 16 }, (_, index) => ({
        ...task(`recent-${index}`),
        createdAt: 2_000 + index,
      })),
    ];
    tasks[0] = { ...tasks[0], status: "running", createdAt: 100 };

    const firstPage = sortHubTasksByRecency(tasks).slice(0, ACTIVITY_PAGE_SIZE);

    expect(firstPage).toHaveLength(16);
    expect(firstPage.some((entry) => entry.id === "old-running")).toBe(false);
    expect(firstPage[0]?.id).toBe("recent-15");
  });
});

describe("activity hub paging window", () => {
  test("opens on exactly the 16 newest entries", () => {
    expect(initialActivityWindow(50)).toEqual({
      start: 0,
      end: ACTIVITY_PAGE_SIZE,
    });
  });

  test("loads older and newer pages in 16-entry steps with a bounded window", () => {
    let window = initialActivityWindow(100);
    window = loadOlderActivityWindow(window, 100);
    window = loadOlderActivityWindow(window, 100);
    window = loadOlderActivityWindow(window, 100);
    expect(window).toEqual({ start: 16, end: 64 });

    window = loadNewerActivityWindow(window);
    expect(window).toEqual({ start: 0, end: 48 });
  });

  test("preserves the intended window size when the dataset shrinks", () => {
    expect(rebaseActivityWindow({ start: 52, end: 100 }, 53)).toEqual({
      start: 5,
      end: 53,
    });
    expect(rebaseActivityWindow({ start: 0, end: 16 }, 8)).toEqual({
      start: 0,
      end: 8,
    });
  });
});
