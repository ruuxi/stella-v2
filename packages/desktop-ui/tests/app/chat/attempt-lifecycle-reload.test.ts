import { rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import {
  getDesktopDatabasePath,
  initializeDesktopDatabase,
} from "@stella/runtime/kernel/storage/database-init";
import { SessionStore } from "@stella/runtime/kernel/storage/session-store";
import type { SqliteDatabase } from "@stella/runtime/kernel/storage/shared";
import {
  buildBackgroundTaskLifecycleIndex,
  resolveBackgroundTaskCardLifecycle,
} from "@/features/chat/lib/background-task-lifecycle";
import { getBackgroundWorks } from "@/features/chat/hooks/use-event-rows";

const roots = new Set<string>();

afterEach(async () => {
  for (const root of roots) {
    await rm(root, { recursive: true, force: true });
  }
  roots.clear();
});

describe("durable attempt lifecycle reload", () => {
  it("binds an equal-millisecond terminal to its generation despite reversed ids", () => {
    const root = path.join(
      os.tmpdir(),
      `stella-attempt-lifecycle-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    roots.add(root);
    const dbPath = getDesktopDatabasePath(root);
    let db = new DatabaseSync(dbPath, {
      timeout: 5_000,
    }) as unknown as SqliteDatabase;
    initializeDesktopDatabase(db);
    let store = new SessionStore(db);
    const conversationId = store.getOrCreateDefaultConversationId();
    const timestamp = 1_700_000_000_000;
    const shared = {
      agentId: "resumed-thread",
      rootRunId: "same-root",
      agentType: "manager",
    };

    store.appendEvent({
      eventId: "zz-old-start",
      conversationId,
      timestamp,
      type: "agent-started",
      payload: {
        ...shared,
        attemptGeneration: 4,
        description: "Old Manager attempt",
      },
    });
    store.appendEvent({
      eventId: "aa-current-start",
      conversationId,
      timestamp,
      type: "agent-started",
      payload: {
        ...shared,
        attemptGeneration: 5,
        description: "Current Manager attempt",
        statusText: "Continue current work",
        isFollowUp: true,
      },
    });
    store.appendEvent({
      eventId: "00-current-terminal",
      conversationId,
      timestamp,
      type: "agent-completed",
      payload: {
        ...shared,
        attemptGeneration: 5,
        result: "Current Manager result",
      },
    });

    db.close();
    db = new DatabaseSync(dbPath, {
      timeout: 5_000,
    }) as unknown as SqliteDatabase;
    initializeDesktopDatabase(db);
    store = new SessionStore(db);
    const activities = store.listActivity(conversationId).activities;

    // SQLite's legacy activity ordering is deliberately hostile here: every
    // timestamp is equal and the terminal id sorts before both starts.
    expect(activities.map((entry) => entry._id)).toEqual([
      "00-current-terminal",
      "aa-current-start",
      "zz-old-start",
    ]);
    expect(
      activities.map(
        (entry) =>
          (entry.payload as { attemptGeneration?: number }).attemptGeneration,
      ),
    ).toEqual([5, 5, 4]);

    const lifecycle = buildBackgroundTaskLifecycleIndex(activities);
    expect(lifecycle.byStartEventId.get("zz-old-start")).toMatchObject({
      attemptGeneration: 4,
      status: "running",
    });
    expect(lifecycle.byStartEventId.get("aa-current-start")).toMatchObject({
      attemptGeneration: 5,
      status: "completed",
      terminalEventId: "00-current-terminal",
    });
    expect(
      lifecycle.startEventIdByLifecycleEventId.get("00-current-terminal"),
    ).toBe("aa-current-start");

    const cards = getBackgroundWorks(activities);
    expect(cards.map((card) => card.cardId)).toEqual([
      "agent-activity:zz-old-start",
      "agent-activity:aa-current-start",
    ]);
    expect(
      cards.map(
        (card) =>
          resolveBackgroundTaskCardLifecycle(
            card.threadIds,
            card.startEventIdsByThread,
            lifecycle,
          ).completedThreadIds,
      ),
    ).toEqual([[], ["resumed-thread"]]);

    db.close();
  });
});
