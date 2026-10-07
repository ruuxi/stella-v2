import { describe, expect, test } from "bun:test";

import type { ChatArtifact, MobileTask } from "../../types";
import { filterHubArtifacts } from "../activity-hub-search";
import {
  collectActivityHubArtifacts,
  groupActivityHubTasks,
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

describe("activity hub source data", () => {
  test("extracts cloud files instead of listing agent completion summaries", () => {
    const file = {
      kind: "markdown" as const,
      filePath: "reports/result.md",
      title: "Research task",
      driveBacked: true,
    };
    const completion = {
      id: "cloud-completion",
      conversationId: "cloud-conversation",
      payload: {
        kind: "agent-work",
        state: "done",
        title: "Research task",
        subtitle: "Finished",
        total: 1,
        completed: 1,
        createdAt: 1000,
        agents: [{ agentId: "agent-1", title: "Research task", files: [file] }],
      },
    } satisfies ChatArtifact;
    const collected = collectActivityHubArtifacts([{ artifacts: [completion] }]);
    expect(collected.map((entry) => entry.payload)).toEqual([file]);
    expect(collectActivityHubArtifacts([{
      artifacts: [{ ...completion, payload: { ...completion.payload, agents: [] } }],
    }])).toEqual([]);
  });

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

  test("pins running tasks ahead of newer inactive tasks", () => {
    const tasks = [
      task("old-running"),
      ...Array.from({ length: 16 }, (_, index) => ({
        ...task(`recent-${index}`),
        createdAt: 2_000 + index,
      })),
    ];
    tasks[0] = { ...tasks[0], status: "running", createdAt: 100 };

    const firstPage = sortHubTasksByRecency(tasks).slice(0, 16);

    expect(firstPage).toHaveLength(16);
    expect(firstPage[0]?.id).toBe("old-running");
    expect(firstPage[1]?.id).toBe("recent-15");
  });

  test("uses last activity recency and deterministic ties within status groups", () => {
    const tasks = [
      {
        ...task("active-older-update"),
        status: "running" as const,
        createdAt: 4_000,
        updatedAt: 5_000,
      },
      {
        ...task("active-newer-update"),
        status: "running" as const,
        createdAt: 2_000,
        updatedAt: 6_000,
      },
      { ...task("done-alpha"), createdAt: 3_000, completedAt: 7_000 },
      { ...task("done-beta"), createdAt: 3_000, completedAt: 7_000 },
    ];

    expect(sortHubTasksByRecency(tasks).map((entry) => entry.id)).toEqual([
      "active-newer-update",
      "active-older-update",
      "done-alpha",
      "done-beta",
    ]);
  });

  test("promotes a collapsed group when one of its subagents is running", () => {
    const recentInactive = { ...task("recent-inactive"), createdAt: 8_000 };
    const inactiveOwner = { ...task("owner"), createdAt: 1_000 };
    const activeChild = {
      ...task("active-child"),
      parentAgentId: inactiveOwner.id,
      status: "running" as const,
      createdAt: 2_000,
      updatedAt: 6_000,
    };

    const groups = groupActivityHubTasks(
      sortHubTasksByRecency([recentInactive, inactiveOwner, activeChild]),
    );

    expect(groups.map((group) => group.owner.id)).toEqual([
      "owner",
      "recent-inactive",
    ]);
    expect(groups[0]?.subagents.map((entry) => entry.id)).toEqual([
      "active-child",
    ]);
  });
});