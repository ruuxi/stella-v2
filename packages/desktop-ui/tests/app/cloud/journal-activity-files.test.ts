import { describe, expect, test } from "vitest";
import type { EventRecord } from "@stella/contracts/local-chat";
import type { TaskItem } from "../../../src/features/chat/lib/event-transforms";
import {
  journalRecordsToCloudActivityEvents,
  journalRecordsToCloudFileEvents,
  LOCAL_CLOUD_EVENT_OVERLAY_TTL_MS,
  mergeCanonicalCloudEventsWithLocalOverlay,
  nextLocalCloudEventOverlayExpiry,
} from "../../../src/features/cloud/journal-activity-files";
import type { JournalRecord } from "../../../src/features/cloud/conversation-protocol";
import type { CloudAgentThread } from "../../../src/features/cloud/cloud-api";
import {
  cloudThreadsForOwnerSubject,
  mergeCloudConversationTasks,
} from "../../../src/features/cloud/use-cloud-activity";
import { deriveConversationFiles } from "../../../src/features/workspace-display/derive-conversation-files";

const records: JournalRecord[] = [
  {
    kind: "message",
    seq: 1,
    turnId: "wake-1",
    createdAtMs: 10,
    role: "user",
    hidden: true,
    payload: {
      role: "user",
      source: "agent-thread",
      content: "[Agent completed] Make a report (thread thr-cloud-1)\n\nDone.",
      timestamp: 10,
    },
  },
  {
    kind: "message",
    seq: 2,
    turnId: "wake-1",
    createdAtMs: 11,
    role: "toolResult",
    hidden: false,
    payload: {
      role: "toolResult",
      toolCallId: "call-1",
      toolName: "exec",
      content: [{ type: "text", text: "Created report" }],
      details: {
        agentId: "thr-cloud-1",
        producedFiles: [
          { path: "/tmp/local-report.pdf", kind: { type: "add" } },
        ],
      },
      timestamp: 11,
    },
  },
  {
    kind: "card",
    seq: 3,
    turnId: "wake-1",
    createdAtMs: 12,
    card: {
      type: "files",
      files: [
        {
          path: "reports/cloud-report.pdf",
          name: "cloud-report.pdf",
          sizeBytes: 2048,
          contentType: "application/pdf",
        },
      ],
    },
  },
];

describe("canonical cloud Activity and Files projection", () => {
  test("projects tool results and durable file cards with agent attribution", () => {
    const activity = journalRecordsToCloudActivityEvents(records);
    expect(activity.map((event) => event.type)).toEqual([
      "tool_result",
      "cloud_files",
    ]);
    expect(activity[1]?.payload).toMatchObject({
      agentId: "thr-cloud-1",
      cloudDriveFiles: [
        {
          path: "reports/cloud-report.pdf",
          name: "cloud-report.pdf",
        },
      ],
    });
    expect(activity[0]?.payload).not.toHaveProperty("producedFiles");

    const files = deriveConversationFiles(
      journalRecordsToCloudFileEvents(records),
    );
    expect(files.map((entry) => entry.path)).toEqual([
      "reports/cloud-report.pdf",
    ]);
    expect(files[0]?.cloudDriveFile).toMatchObject({
      path: "reports/cloud-report.pdf",
      sizeBytes: 2048,
    });
  });

  test("retires an acknowledged desktop event but keeps local-only overlays", () => {
    const canonical = journalRecordsToCloudActivityEvents(records);
    const local: EventRecord[] = [
      {
        _id: "sqlite-tool-result",
        timestamp: 9,
        type: "tool_result",
        requestId: "call-1",
        payload: { toolName: "exec" },
      },
      {
        _id: "desktop-operational-only",
        timestamp: 8,
        type: "agent-progress",
        payload: { agentId: "thr-local" },
      },
    ];

    expect(
      mergeCanonicalCloudEventsWithLocalOverlay(canonical, local, {
        nowMs: 12,
      }).map((event) => event._id),
    ).toEqual([
      "desktop-operational-only",
      "cloud:wake-1:tool-result:2",
      "cloud:wake-1:files:3",
    ]);
  });

  test("retires unmatched pre-cloud Activity and Files cache rows", () => {
    const nowMs = 1_000_000;
    const recent: EventRecord = {
      _id: "recent-unacknowledged-file",
      timestamp: nowMs - LOCAL_CLOUD_EVENT_OVERLAY_TTL_MS + 1,
      type: "tool_result",
      payload: {
        producedFiles: [{ path: "/tmp/recent.pdf", kind: { type: "add" } }],
      },
    };
    const staleActivity: EventRecord = {
      _id: "stale-agent-completed",
      timestamp: nowMs - LOCAL_CLOUD_EVENT_OVERLAY_TTL_MS,
      type: "agent-completed",
      payload: { agentId: "thr-pre-cloud" },
    };
    const staleFile: EventRecord = {
      _id: "stale-unmatched-file",
      timestamp: nowMs - LOCAL_CLOUD_EVENT_OVERLAY_TTL_MS - 1,
      type: "tool_result",
      payload: {
        producedFiles: [{ path: "/tmp/stale.pdf", kind: { type: "add" } }],
      },
    };

    expect(
      mergeCanonicalCloudEventsWithLocalOverlay(
        [],
        [staleActivity, recent, staleFile],
        { nowMs },
      ).map((event) => event._id),
    ).toEqual(["recent-unacknowledged-file"]);
    expect(
      nextLocalCloudEventOverlayExpiry(
        [staleActivity, recent, staleFile],
        nowMs,
      ),
    ).toBe(recent.timestamp + LOCAL_CLOUD_EVENT_OVERLAY_TTL_MS);
  });

  test("does not let a malformed future cache timestamp become permanent", () => {
    const nowMs = 1_000_000;
    const future: EventRecord = {
      _id: "future-cache-row",
      timestamp: nowMs + 60_001,
      type: "agent-progress",
      payload: { agentId: "thr-clock-skew" },
    };
    expect(
      mergeCanonicalCloudEventsWithLocalOverlay([], [future], { nowMs }),
    ).toEqual([]);
    expect(nextLocalCloudEventOverlayExpiry([future], nowMs)).toBeNull();
  });
});

const task = (
  id: string,
  status: TaskItem["status"],
  extras: Partial<TaskItem> = {},
): TaskItem => ({
  id,
  description: id,
  agentType: "general",
  source: "stella",
  readOnly: false,
  status,
  startedAtMs: 1,
  lastUpdatedAtMs: 2,
  ...extras,
});

describe("cloud Activity authority", () => {
  test("fences cached thread pages to the active account scope", () => {
    const cloudThread = (
      threadId: string,
      ownerId: string,
    ): CloudAgentThread => ({
      threadId,
      ownerId,
      conversationId: "conversation-1",
      description: threadId,
      workspace: "stella",
      agentType: "general",
      status: "completed",
      createdAt: 1,
      updatedAt: 2,
    });

    expect(
      cloudThreadsForOwnerSubject(
        [
          cloudThread("owned", "https://deployment.convex.site|owner-a"),
          cloudThread("stale", "https://deployment.convex.site|owner-b"),
        ],
        "https://deployment.convex.site|owner-a",
      ).map((thread) => thread.threadId),
    ).toEqual(["owned"]);
    expect(
      cloudThreadsForOwnerSubject(
        [
          cloudThread(
            "anonymous",
            "https://deployment.convex.site|anonymous-owner",
          ),
        ],
        "https://deployment.convex.site|anonymous-owner",
      ).map((thread) => thread.threadId),
    ).toEqual(["anonymous"]);
  });

  test("keeps cloud status authoritative and overlays live desktop detail", () => {
    const merged = mergeCloudConversationTasks(
      [
        task("running", "running"),
        task("terminal", "completed", { completedAtMs: 3 }),
      ],
      [
        task("running", "running", { statusText: "Writing report" }),
        task("terminal", "running", { statusText: "Stale local state" }),
        task("local-only", "running"),
      ],
    );

    expect(merged.map((entry) => entry.id)).toEqual([
      "running",
      "terminal",
      "local-only",
    ]);
    expect(merged[0]?.statusText).toBe("Writing report");
    expect(merged[1]?.status).toBe("completed");
    expect(merged[1]?.statusText).toBeUndefined();
  });
});
