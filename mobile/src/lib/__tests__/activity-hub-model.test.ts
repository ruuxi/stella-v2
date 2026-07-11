import { describe, expect, test } from "bun:test";

import type { ChatArtifact, ChatMessage, MobileTask } from "../../types";
import { agentWorkCardSections } from "../agent-artifact-consolidation";
import {
  ACTIVITY_PAGE_SIZE,
  groupActivityArtifacts,
  initialActivityWindow,
  loadNewerActivityWindow,
  loadOlderActivityWindow,
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
  test("groups desktop-attributed files under their exact agent id", () => {
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
      { artifacts: [work], tasks: [task("a1"), task("a2")] },
    ];

    const grouped = groupActivityArtifacts(messages, files);

    expect(grouped.byTaskId.get("a1")?.map((file) => file.payload)).toEqual([
      { kind: "markdown", filePath: "/tmp/first.md" },
    ]);
    expect(grouped.byTaskId.get("a2")?.map((file) => file.payload)).toEqual([
      { kind: "markdown", filePath: "/tmp/second.md" },
    ]);
    expect(grouped.conversation).toEqual([]);
  });

  test("keeps direct files with their task row or the main conversation", () => {
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
});
