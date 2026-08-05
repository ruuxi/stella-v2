import { rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import {
  getDesktopDatabasePath,
  initializeDesktopDatabase,
} from "@stella/runtime/kernel/storage/database-init";
import { SessionStore } from "../../../../../runtime/kernel/storage/session-store.js";
import type { SqliteDatabase } from "@stella/runtime/kernel/storage/shared";

type TestContext = {
  rootPath: string;
  db: SqliteDatabase;
  store: SessionStore;
};

const activeContexts = new Set<TestContext>();
const conversationId = (suffix: string) => `${"0".repeat(25)}${suffix}`;

const createContext = (): TestContext => {
  const rootPath = path.join(
    os.tmpdir(),
    `stella-conversation-history-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  const db = new DatabaseSync(getDesktopDatabasePath(rootPath), {
    timeout: 5_000,
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

describe("conversation history storage", () => {
  it("paginates newest-first and uses the latest visible chat message as title", () => {
    const { store } = createContext();
    const first = conversationId("A");
    const second = conversationId("B");
    const third = conversationId("C");
    store.appendEvent({
      conversationId: first,
      type: "user_message",
      timestamp: 1_000,
      payload: { text: " First   title\nline " },
    });
    store.appendEvent({
      conversationId: second,
      type: "assistant_message",
      timestamp: 2_000,
      payload: { text: "Second title" },
    });
    store.appendEvent({
      conversationId: third,
      type: "assistant_message",
      timestamp: 2_900,
      payload: { text: "Visible third title" },
    });
    store.appendEvent({
      conversationId: third,
      type: "user_message",
      timestamp: 3_000,
      payload: {
        text: "Hidden trigger",
        metadata: { trigger: { kind: "workspace_creation_request" } },
      },
    });

    const firstPage = store.listConversationSummaries({ limit: 2 });
    expect(firstPage.conversations.map((item) => [item.conversationId, item.title])).toEqual([
      [third, "Visible third title"],
      [second, "Second title"],
    ]);
    expect(firstPage.hasMore).toBe(true);
    expect(firstPage.nextCursor).toEqual({
      updatedAt: 2_000,
      conversationId: second,
    });
    expect(
      store.listConversationSummaries({
        limit: 2,
        cursor: firstPage.nextCursor,
      }).conversations,
    ).toMatchObject([{ conversationId: first, title: "First title line" }]);
  });

  it("omits synthetic sessions and falls back to New chat", () => {
    const { store } = createContext();
    const empty = store.createNewDefaultConversationId();
    store.appendEvent({
      conversationId: "store-install:package-id",
      type: "assistant_message",
      timestamp: Date.now() + 1,
      payload: { text: "Synthetic install" },
    });
    expect(store.listConversationSummaries().conversations).toEqual([
      expect.objectContaining({ conversationId: empty, title: "New chat" }),
    ]);
  });

  it("deletes conversation-owned transcript and thread data", () => {
    const { db, store } = createContext();
    const id = store.getOrCreateDefaultConversationId();
    const event = store.appendEvent({
      conversationId: id,
      type: "user_message",
      timestamp: 1_000,
      payload: { text: "Delete me" },
    });
    db.prepare(
      `INSERT INTO runtime_threads (
        thread_key, conversation_id, agent_type, name, status, created_at, last_used_at
      ) VALUES (?, ?, 'general', 'Child', 'active', 1000, 1000)`,
    ).run("deleted-thread", id);
    db.prepare(
      `INSERT INTO runtime_thread_entries (
        entry_id, thread_key, session_id, entry_type, timestamp_iso, created_at, data_json
      ) VALUES (?, ?, ?, 'message', ?, 1000, '{}')`,
    ).run(
      "deleted-entry",
      "deleted-thread",
      "runtime-session",
      new Date(1_000).toISOString(),
    );

    expect(store.deleteConversation(id)).toBe(true);
    expect(store.deleteConversation(id)).toBe(false);
    expect(db.prepare(`SELECT 1 FROM message WHERE id = ?`).get(event._id)).toBeUndefined();
    expect(
      db.prepare(`SELECT 1 FROM runtime_thread_entries WHERE thread_key = ?`).get("deleted-thread"),
    ).toBeUndefined();
    expect(store.getOrCreateDefaultConversationId()).not.toBe(id);
  });

  it("refuses deletion while a conversation has a running agent", () => {
    const { db, store } = createContext();
    const id = store.getOrCreateDefaultConversationId();
    db.prepare(
      `INSERT INTO runtime_agents (
        thread_id, conversation_id, agent_type, description, agent_depth,
        status, started_at, updated_at
      ) VALUES (?, ?, 'general', 'Still running', 1, 'running', 1000, 1000)`,
    ).run("running-thread", id);

    expect(() => store.deleteConversation(id)).toThrow(
      "A conversation with running tasks cannot be deleted.",
    );
    expect(
      store.listConversationSummaries().conversations.some((item) => item.conversationId === id),
    ).toBe(true);
  });
});
