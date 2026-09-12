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

type TestContext = {
  rootPath: string;
  db: SqliteDatabase;
  store: SessionStore;
};

const activeContexts = new Set<TestContext>();

const createTestContext = (): TestContext => {
  const rootPath = path.join(
    os.tmpdir(),
    `stella-recall-excerpts-${Date.now()}-${Math.random().toString(36).slice(2)}`,
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

describe("listThreadResultExcerpts", () => {
  it("keeps 1,600 Unicode result characters while bounding errors separately", () => {
    const { store } = createTestContext();
    const { threadId } = store.resolveOrCreateActiveThread({
      conversationId: "conv-a",
      agentType: "general",
      nameHint: "Unicode result",
    });
    store.saveAgentRecord({
      threadId,
      conversationId: "conv-a",
      agentType: "general",
      description: "Unicode result",
      agentDepth: 0,
      status: "error",
      startedAt: 2_000,
      completedAt: 3_000,
      result: `${"x".repeat(1_599)}😀must be truncated`,
      error: "e".repeat(500),
      updatedAt: 3_000,
    });

    const excerpt = store.listThreadResultExcerpts([threadId]).get(threadId);
    expect(Array.from(excerpt?.resultExcerpt ?? "")).toHaveLength(1_600);
    expect(excerpt?.resultExcerpt).toBe(`${"x".repeat(1_599)}😀`);
    expect(excerpt?.resultExcerpt).not.toContain("must be truncated");
    expect(excerpt?.errorExcerpt).toBe("e".repeat(300));
  });
});
