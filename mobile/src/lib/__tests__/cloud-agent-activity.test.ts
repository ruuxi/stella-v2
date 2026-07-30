import { describe, expect, test } from "bun:test";
import type { MobileTask } from "../../types";
import {
  cloudAgentThreadToMobileTask,
  mergeCanonicalCloudTasks,
  resolveCloudAgentThreadQueryArgs,
  selectScopedCloudOperationalTasks,
} from "../cloud-agent-activity";
import type { CloudAgentThread } from "../cloud-conversation-api";

const thread = (
  overrides: Partial<CloudAgentThread> = {},
): CloudAgentThread => ({
  threadId: "thread-1",
  ownerId: "owner-1",
  conversationId: "conversation-1",
  description: "Research",
  workspace: "computer",
  agentType: "general",
  status: "running",
  createdAt: 1_000,
  updatedAt: 2_000,
  ...overrides,
});

const task = (overrides: Partial<MobileTask> = {}): MobileTask => ({
  id: "thread-1",
  title: "Research",
  agentType: "general",
  status: "running",
  createdAt: 1_000,
  ...overrides,
});

describe("canonical cloud agent Activity", () => {
  test("gates the owner query on exact identity and migration readiness", () => {
    expect(
      resolveCloudAgentThreadQueryArgs({
        canUseOwnerData: false,
        conversationId: "conversation-1",
      }),
    ).toBe("skip");
    expect(
      resolveCloudAgentThreadQueryArgs({
        canUseOwnerData: true,
        conversationId: null,
      }),
    ).toBe("skip");
    expect(
      resolveCloudAgentThreadQueryArgs({
        canUseOwnerData: true,
        conversationId: "conversation-1",
      }),
    ).toEqual({ conversationId: "conversation-1" });
  });

  test("projects durable lifecycle status and terminal timestamps", () => {
    expect(
      cloudAgentThreadToMobileTask(
        thread({
          description: "  ",
          agentType: "",
          status: "failed",
          updatedAt: 3_000,
        }),
      ),
    ).toEqual({
      id: "thread-1",
      title: "Background work",
      agentType: "general",
      status: "error",
      createdAt: 1_000,
      completedAt: 3_000,
    });
  });

  test("canonical terminal status beats a stale running desktop row", () => {
    const canonical = task({
      title: "Canonical title",
      status: "completed",
      completedAt: 4_000,
    });
    expect(
      mergeCanonicalCloudTasks(
        [canonical],
        [
          task({
            title: "Stale desktop title",
            statusText: "Still working",
            reasoningSummaries: ["Old detail"],
          }),
        ],
      ),
    ).toEqual([canonical]);
  });

  test("matching desktop rows decorate only canonical running detail", () => {
    expect(
      mergeCanonicalCloudTasks(
        [task({ title: "Canonical title", createdAt: 2_000 })],
        [
          task({
            title: "Desktop title",
            createdAt: 9_000,
            statusText: "Reading files",
            reasoningSummaries: ["Checking ownership"],
          }),
        ],
      ),
    ).toEqual([
      task({
        title: "Canonical title",
        createdAt: 2_000,
        statusText: "Reading files",
        reasoningSummaries: ["Checking ownership"],
      }),
    ]);
  });

  test("canonical rows remain when desktop is offline", () => {
    const canonical = task({
      status: "canceled",
      completedAt: 5_000,
    });
    expect(mergeCanonicalCloudTasks([canonical], [])).toEqual([canonical]);
  });

  test("rejects a late bridge refresh after account, conversation, or desktop switches", () => {
    const staleSnapshot = {
      accountScope: "account:a",
      conversationId: "conversation-old",
      desktopDeviceId: "desktop-a",
      tasks: [task({ id: "private-a-task" })],
    };
    expect(
      selectScopedCloudOperationalTasks(staleSnapshot, {
        accountScope: "account:b",
        conversationId: "conversation-new",
        desktopDeviceId: "desktop-b",
      }),
    ).toEqual([]);
    expect(
      selectScopedCloudOperationalTasks(staleSnapshot, {
        accountScope: "account:a",
        conversationId: "conversation-new",
        desktopDeviceId: "desktop-a",
      }),
    ).toEqual([]);
    expect(
      selectScopedCloudOperationalTasks(staleSnapshot, {
        accountScope: "account:a",
        conversationId: "conversation-old",
        desktopDeviceId: "desktop-b",
      }),
    ).toEqual([]);
    expect(
      selectScopedCloudOperationalTasks(staleSnapshot, {
        accountScope: "account:a",
        conversationId: "conversation-old",
        desktopDeviceId: "desktop-a",
      }),
    ).toEqual(staleSnapshot.tasks);
  });

  test("admits only a bounded running-only propagation fallback", () => {
    const operational = Array.from({ length: 12 }, (_, index) =>
      task({
        id: `desktop-${index}`,
        status: index === 0 ? "completed" : "running",
        createdAt: index,
      }),
    );
    const merged = mergeCanonicalCloudTasks([], operational);
    expect(merged).toHaveLength(8);
    expect(merged.every((entry) => entry.status === "running")).toBe(true);
    expect(merged.map((entry) => entry.id)).toEqual([
      "desktop-11",
      "desktop-10",
      "desktop-9",
      "desktop-8",
      "desktop-7",
      "desktop-6",
      "desktop-5",
      "desktop-4",
    ]);
  });
});
