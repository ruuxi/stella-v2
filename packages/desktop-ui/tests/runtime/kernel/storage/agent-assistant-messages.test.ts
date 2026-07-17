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
    `stella-agent-messages-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  const dbPath = getDesktopDatabasePath(rootPath);
  const db = new DatabaseSync(dbPath, {
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

describe("agent-authored assistant updates", () => {
  it("reads recent assistant messages verbatim and ignores legacy generated rows", () => {
    const { db, store } = createTestContext();
    const { threadId } = store.resolveOrCreateActiveThread({
      conversationId: "conv-1",
      agentType: "general",
      threadId: "agent-1",
      nameHint: "Inspect the routes",
    });

    for (const [index, content] of [
      "Oldest update",
      "I checked the route.\n\nIt already redirects safely.",
      "I removed the stale action.",
      "The focused tests pass.",
    ].entries()) {
      store.appendThreadMessage({
        threadKey: threadId,
        timestamp: 1_000 + index,
        role: "assistant",
        content,
      });
    }
    store.appendThreadMessage({
      threadKey: threadId,
      timestamp: 2_000,
      role: "toolResult",
      toolCallId: "tool-1",
      content: "tool output must not become an agent update",
    });
    db.prepare(
      `INSERT INTO agent_progress_summaries (agent_id, text, created_at)
       VALUES (?, ?, ?)`,
    ).run(threadId, "old generated summary", 3_000);

    expect(store.listAgentAssistantMessages(threadId, 3)).toEqual([
      {
        text: "I checked the route.\n\nIt already redirects safely.",
        atMs: 1_001,
      },
      { text: "I removed the stale action.", atMs: 1_002 },
      { text: "The focused tests pass.", atMs: 1_003 },
    ]);
  });

  it("projects the same assistant messages into Activity rows", () => {
    const { store } = createTestContext();
    const { threadId } = store.resolveOrCreateActiveThread({
      conversationId: "conv-1",
      agentType: "general",
      threadId: "agent-1",
      nameHint: "Inspect the routes",
    });
    store.saveAgentRecord({
      threadId,
      conversationId: "conv-1",
      agentType: "general",
      description: "Inspect the routes",
      agentDepth: 0,
      status: "running",
      startedAt: 1_000,
      completedAt: null,
      updatedAt: 1_000,
    });
    store.appendThreadMessage({
      threadKey: threadId,
      timestamp: 1_001,
      role: "assistant",
      content: "I found the stale navigation path.",
    });

    expect(store.listThreadActivity("conv-1")[0]?.assistantMessages).toEqual([
      "I found the stale navigation path.",
    ]);
  });
});
