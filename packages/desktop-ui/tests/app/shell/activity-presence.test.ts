import { describe, expect, it } from "vitest";
import { getActivityPresence } from "@/features/chat/lib/activity-presence";
import {
  deriveTopLevelActivityWorkUnits,
  type TaskItem,
} from "@/features/chat/lib/event-transforms";
import {
  activityPresenceAllowsSidebar,
  isActivitySidebarDocked,
  shouldAutoOpenActivitySidebar,
} from "@/shell/activity-sidebar-visibility";
import { shouldShowActivityPill } from "@/app/chat/ComposerActivityPill";

const task = (overrides: Partial<TaskItem> & { id: string }): TaskItem => ({
  description: overrides.id,
  agentType: "general",
  status: "running",
  startedAtMs: 100,
  lastUpdatedAtMs: 100,
  ...overrides,
});

describe("authoritative Activity presence", () => {
  it("distinguishes loading, loaded-empty, and displayed work", () => {
    expect(getActivityPresence([], false)).toBe("unknown");
    expect(getActivityPresence([], true)).toBe("empty");
    expect(getActivityPresence([task({ id: "work" })], false)).toBe("present");
  });

  it("uses displayed top-level units, latest attempts, and Manager ownership", () => {
    const tasks = [
      task({
        id: "manager",
        agentType: "manager",
        attemptGeneration: 1,
      }),
      task({
        id: "child",
        parentAgentId: "manager",
      }),
      task({
        id: "standalone",
        attemptGeneration: 1,
        lastUpdatedAtMs: 300,
      }),
      task({
        id: "standalone",
        attemptGeneration: 2,
        status: "completed",
        lastUpdatedAtMs: 200,
      }),
      task({
        id: "internal",
        agentType: "recall",
      }),
    ];

    expect(deriveTopLevelActivityWorkUnits(tasks)).toEqual([
      { id: "hierarchy:manager", status: "running" },
      { id: "task:standalone", status: "completed" },
    ]);
    expect(
      deriveTopLevelActivityWorkUnits(tasks).filter(
        (unit) => unit.status === "running",
      ),
    ).toHaveLength(1);
    expect(getActivityPresence(tasks, true)).toBe("present");
  });

  it("auto-opens only when displayed Activity appears", () => {
    expect(shouldAutoOpenActivitySidebar("unknown", "present")).toBe(true);
    expect(shouldAutoOpenActivitySidebar("empty", "present")).toBe(true);
    expect(shouldAutoOpenActivitySidebar("present", "present")).toBe(false);
    expect(shouldAutoOpenActivitySidebar("present", "empty")).toBe(false);
  });

  it.each([
    ["unknown", true, true, false, true],
    ["empty", true, true, false, false],
    ["present", true, true, false, true],
    ["present", false, true, false, false],
    ["present", true, true, true, false],
    ["present", true, false, false, false],
  ] as const)(
    "resolves %s presence without leaving an empty shell footprint",
    (presence, preferredVisible, isFullWindow, breakpointHidden, expected) => {
      expect(
        isActivitySidebarDocked({
          presence,
          preferredVisible,
          isFullWindow,
          breakpointHidden,
        }),
      ).toBe(expected);
    },
  );

  it.each([
    ["unknown", true, false],
    ["empty", false, false],
    ["present", true, true],
  ] as const)(
    "applies the same %s presence rule to sidebar allowance and the pill",
    (presence, sidebarAllowed, pillVisible) => {
      expect(activityPresenceAllowsSidebar(presence)).toBe(sidebarAllowed);
      expect(shouldShowActivityPill(presence)).toBe(pillVisible);
    },
  );
});
