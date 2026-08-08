import { describe, expect, test } from "bun:test";

import type { MobileTask } from "../../types";
import {
  mergeMobileTaskSnapshot,
  overlayDesktopThreadTasks,
  selectRootMobileActivityTasks,
} from "../mobile-task-merge";
import type { DesktopTaskDecoration } from "../desktop-bridge-chat";
import { parseThreadActivityTasks } from "../desktop-thread-activity";

/**
 * The authoritative thread-activity overlay: desktop `runtime_agents` rows
 * override the synced-message fold's status/title, and the live decoration
 * snapshot supplies the mid-run statusText/reasoning that `agent-progress`
 * rows used to carry before they stopped being persisted.
 */

const task = (overrides: Partial<MobileTask> & { id: string }): MobileTask => ({
  title: "Background work",
  status: "running",
  createdAt: 1_000,
  ...overrides,
});

const decoration = (
  overrides: Partial<DesktopTaskDecoration>,
): DesktopTaskDecoration => ({
  statusTextByAgentId: {},
  reasoningSummariesByAgentId: {},
  ...overrides,
});

describe("overlayDesktopThreadTasks", () => {
  test("passes the fold through untouched when there is no overlay data", () => {
    const folded = [task({ id: "a" }), task({ id: "b", status: "completed" })];
    expect(overlayDesktopThreadTasks(folded, null, null)).toEqual(folded);
  });

  test("authoritative terminal row settles a task the fold still thinks is running", () => {
    const folded = [task({ id: "research", title: "Research flights" })];
    const merged = overlayDesktopThreadTasks(
      folded,
      [
        task({
          id: "research",
          title: "Research flights",
          status: "completed",
          completedAt: 5_000,
        }),
      ],
      null,
    );
    expect(merged).toHaveLength(1);
    expect(merged[0]?.status).toBe("completed");
    expect(merged[0]?.completedAt).toBe(5_000);
  });

  test("authoritative running row revives a task the fold's staleness heuristic settled", () => {
    // The desktop serializer settles long-silent running tasks to "completed"
    // when their spawn aged out of the loaded window; the authoritative row
    // knows it is genuinely still running.
    const folded = [task({ id: "audit", status: "completed" })];
    const merged = overlayDesktopThreadTasks(
      folded,
      [task({ id: "audit", title: "Audit the codebase" })],
      null,
    );
    expect(merged[0]?.status).toBe("running");
    expect(merged[0]?.title).toBe("Audit the codebase");
  });

  test("running rows outside the fold are added; terminal ones are not", () => {
    const merged = overlayDesktopThreadTasks(
      [],
      [
        task({ id: "live", title: "Live agent" }),
        task({ id: "ancient", status: "completed", completedAt: 2 }),
      ],
      null,
    );
    expect(merged.map((entry) => entry.id)).toEqual(["live"]);
  });

  test("retitle: the authoritative description replaces the fold's spawn title", () => {
    // A send_input follow-up adopts its description onto the thread; the fold
    // only ever saw the original spawn event.
    const folded = [task({ id: "t", title: "Original request" })];
    const merged = overlayDesktopThreadTasks(
      folded,
      [task({ id: "t", title: "Follow-up instruction" })],
      null,
    );
    expect(merged[0]?.title).toBe("Follow-up instruction");
  });

  test("decoration statusText/reasoning land on running tasks only", () => {
    const folded = [
      task({ id: "run", statusText: "Spawn text" }),
      task({ id: "done", status: "completed" }),
    ];
    const merged = overlayDesktopThreadTasks(
      folded,
      null,
      decoration({
        statusTextByAgentId: { run: "Reading files", done: "Stale tick" },
        reasoningSummariesByAgentId: { run: ["Comparing options"] },
      }),
    );
    const running = merged.find((entry) => entry.id === "run");
    const completed = merged.find((entry) => entry.id === "done");
    expect(running?.statusText).toBe("Reading files");
    expect(running?.reasoningSummaries).toEqual(["Comparing options"]);
    expect(completed?.statusText).toBe(undefined);
  });

  test("a running authoritative row keeps the fold's statusText until a decoration tick arrives", () => {
    const folded = [task({ id: "t", statusText: "Spawn status" })];
    const merged = overlayDesktopThreadTasks(
      folded,
      [task({ id: "t" })],
      decoration({}),
    );
    expect(merged[0]?.statusText).toBe("Spawn status");
  });

  test("running tasks sort first, then newest", () => {
    const merged = overlayDesktopThreadTasks(
      [task({ id: "old-done", status: "completed", createdAt: 500 })],
      [task({ id: "young", createdAt: 3_000 }), task({ id: "older", createdAt: 2_000 })],
      null,
    );
    expect(merged.map((entry) => entry.id)).toEqual([
      "young",
      "older",
      "old-done",
    ]);
  });

  test("only the Manager remains when its owned work finishes", () => {
    const folded = [
      task({
        id: "managed-child",
        agentType: "general",
        parentAgentId: "manager",
      }),
    ];
    const merged = overlayDesktopThreadTasks(
      folded,
      [
        task({
          id: "manager",
          agentType: "manager",
          status: "completed",
          completedAt: 5_000,
        }),
        task({
          id: "managed-child",
          agentType: "general",
          parentAgentId: "manager",
          status: "completed",
          completedAt: 5_000,
        }),
      ],
      null,
    );

    expect(merged).toEqual([
      task({
        id: "manager",
        agentType: "manager",
        status: "completed",
        completedAt: 5_000,
      }),
    ]);
  });

  test("terminal snapshots retain ownership learned while running", () => {
    expect(
      mergeMobileTaskSnapshot(
        task({
          id: "managed-child",
          agentType: "general",
          parentAgentId: "manager",
        }),
        task({
          id: "managed-child",
          status: "completed",
          completedAt: 5_000,
        }),
      ),
    ).toMatchObject({
      id: "managed-child",
      agentType: "general",
      parentAgentId: "manager",
      status: "completed",
    });
  });
});

describe("root mobile Activity ownership", () => {
  test("parses Manager and General ownership rows for ancestry resolution", () => {
    expect(
      parseThreadActivityTasks([
        {
          threadId: "manager",
          agentType: "manager",
          description: "Coordinate",
          status: "running",
          startedAt: 100,
        },
        {
          threadId: "child",
          agentType: "general",
          parentAgentId: "manager",
          description: "Research",
          status: "completed",
          startedAt: 110,
          completedAt: 200,
        },
      ]),
    ).toEqual([
      task({
        id: "manager",
        agentType: "manager",
        title: "Coordinate",
        createdAt: 100,
      }),
      task({
        id: "child",
        agentType: "general",
        parentAgentId: "manager",
        title: "Research",
        status: "completed",
        createdAt: 110,
        completedAt: 200,
      }),
    ]);
  });

  test("shows standalone General work and Managers but omits descendants", () => {
    const tasks = [
      task({
        id: "standalone",
        agentType: "general",
        parentAgentId: "orchestrator-not-in-activity",
      }),
      task({ id: "manager", agentType: "manager" }),
      task({
        id: "child",
        agentType: "general",
        parentAgentId: "manager",
      }),
      task({
        id: "grandchild",
        agentType: "general",
        parentAgentId: "child",
      }),
    ];

    expect(
      selectRootMobileActivityTasks(tasks).map((entry) => entry.id),
    ).toEqual(["standalone", "manager"]);
  });

  test("shows only root Managers and fails closed for parented Managers", () => {
    const tasks = [
      task({ id: "root-manager", agentType: "manager" }),
      task({
        id: "nested-manager",
        agentType: "manager",
        parentAgentId: "root-manager",
      }),
      task({
        id: "malformed-manager",
        agentType: "manager",
        parentAgentId: " ",
      }),
    ];

    expect(
      selectRootMobileActivityTasks(tasks).map((entry) => entry.id),
    ).toEqual(["root-manager"]);
  });

  test("fails closed for cycles and broken ancestry after a resolved parent", () => {
    const tasks = [
      task({ id: "cycle-a", agentType: "general", parentAgentId: "cycle-b" }),
      task({ id: "cycle-b", agentType: "general", parentAgentId: "cycle-a" }),
      task({ id: "known", agentType: "general", parentAgentId: "missing" }),
      task({ id: "broken", agentType: "general", parentAgentId: "known" }),
    ];

    expect(
      selectRootMobileActivityTasks(tasks).map((entry) => entry.id),
    ).toEqual(["known"]);
  });
});
