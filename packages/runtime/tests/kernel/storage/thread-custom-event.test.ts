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

type TestContext = { rootPath: string; db: SqliteDatabase; store: SessionStore };

const activeContexts = new Set<TestContext>();

const createTestContext = (): TestContext => {
  const rootPath = path.join(
    os.tmpdir(),
    `stella-thread-custom-event-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  const db = new DatabaseSync(getDesktopDatabasePath(rootPath), {
    timeout: 5000,
  }) as unknown as SqliteDatabase;
  initializeDesktopDatabase(db);
  const context = { rootPath, db, store: new SessionStore(db) };
  activeContexts.add(context);
  return context;
};

afterEach(async () => {
  for (const context of activeContexts) {
    context.db.close();
    await rm(context.rootPath, { recursive: true, force: true });
  }
  activeContexts.clear();
});

describe("hasThreadCustomEvent", () => {
  it("matches one custom message by thread, custom type, and event id", () => {
    const { store } = createTestContext();
    store.appendThreadMessages([
      { threadKey: "thread-a", timestamp: 1, role: "user", content: "hello" },
    ]);
    const append = (
      threadKey: string,
      customType: string,
      eventId: string,
      text = "report",
    ) =>
      store.appendThreadCustomMessage({
        threadKey,
        customType,
        content: [{ type: "text", text }],
        display: false,
        timestamp: 2,
        eventId,
      });
    append("thread-a", "runtime.task_lifecycle", "child:1:agent-completed");
    append("thread-a", "runtime.task_lifecycle_private", "child:2:agent-failed");
    append("thread-b", "runtime.task_lifecycle", "child:3:agent-canceled");
    // Oversized content is truncated for storage; the event id survives.
    append(
      "thread-a",
      "runtime.task_lifecycle",
      "child:4:agent-completed",
      "x".repeat(200_000),
    );

    const has = (threadKey: string, customType: string, eventId: string) =>
      store.hasThreadCustomEvent(threadKey, customType, eventId);
    expect(has("thread-a", "runtime.task_lifecycle", "child:1:agent-completed")).toBe(true);
    expect(has(" thread-a ", "runtime.task_lifecycle", "child:1:agent-completed")).toBe(true);
    expect(has("thread-a", "runtime.task_lifecycle", "child:4:agent-completed")).toBe(true);
    // Wrong custom type, wrong thread, wrong generation, unknown thread.
    expect(has("thread-a", "runtime.task_lifecycle", "child:2:agent-failed")).toBe(false);
    expect(has("thread-a", "runtime.task_lifecycle_private", "child:2:agent-failed")).toBe(true);
    expect(has("thread-a", "runtime.task_lifecycle", "child:3:agent-canceled")).toBe(false);
    expect(has("thread-a", "runtime.task_lifecycle", "child:9:agent-completed")).toBe(false);
    expect(has("missing-thread", "runtime.task_lifecycle", "child:1:agent-completed")).toBe(false);
    expect(has("", "runtime.task_lifecycle", "child:1:agent-completed")).toBe(false);
    expect(has("thread-a", "runtime.task_lifecycle", "")).toBe(false);

    // Agrees with the transcript projection it replaces.
    const scanned = store
      .loadRawThreadMessages("thread-a")
      .filter((message) => message.customMessage?.customType === "runtime.task_lifecycle")
      .map((message) => message.customMessage?.eventId);
    expect(scanned).toEqual(["child:1:agent-completed", "child:4:agent-completed"]);
  });
});
