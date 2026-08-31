import { rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Worker } from "node:worker_threads";
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
    store.appendEvent({
      conversationId: third,
      type: "user_message",
      timestamp: 3_100,
      payload: {
        text: "",
        attachments: [{ name: "latest.pdf", path: "/tmp/latest.pdf" }],
      },
    });

    const firstPage = store.listConversationSummaries({ limit: 2 });
    expect(
      firstPage.conversations.map((item) => [item.conversationId, item.title]),
    ).toEqual([
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
      conversationId: "synthetic:not-a-chat-id",
      type: "assistant_message",
      timestamp: Date.now() + 1,
      payload: { text: "Synthetic event" },
    });
    expect(store.listConversationSummaries().conversations).toEqual([
      expect.objectContaining({ conversationId: empty, title: "New chat" }),
    ]);
  });

  it("reuses the active empty conversation on repeated new-chat requests", () => {
    const { db, store } = createContext();
    const emptyConversationId = store.getOrCreateDefaultConversationId();
    db.prepare(`UPDATE settings SET updated_at = 123 WHERE key = ?`).run(
      "default_conversation_id",
    );

    expect(store.createNewDefaultConversationId()).toBe(emptyConversationId);
    expect(store.createNewDefaultConversationId()).toBe(emptyConversationId);
    expect(db.prepare(`SELECT COUNT(*) AS count FROM conversation`).get()).toEqual({
      count: 1,
    });
    expect(
      db
        .prepare(`SELECT updated_at AS updatedAt FROM settings WHERE key = ?`)
        .get("default_conversation_id"),
    ).toEqual({ updatedAt: 123 });
  });

  it("reuses the newest eligible empty conversation from a nonempty current chat", () => {
    const { db, store } = createContext();
    const occupied = store.getOrCreateDefaultConversationId();
    store.appendEvent({
      conversationId: occupied,
      type: "user_message",
      timestamp: 1_000,
      payload: { text: "Occupied" },
    });
    const olderEmpty = conversationId("Y");
    const newerEmpty = conversationId("Z");
    db.prepare(
      `INSERT INTO conversation (id, title, status, created_at, updated_at)
       VALUES (?, '', 'active', ?, ?)`,
    ).run(olderEmpty, 1_500, 1_500);
    db.prepare(
      `INSERT INTO conversation (id, title, status, created_at, updated_at)
       VALUES (?, '', 'active', ?, ?)`,
    ).run(newerEmpty, 2_000, 2_000);
    store.setActiveDefaultConversationId(occupied);

    expect(store.createNewDefaultConversationId()).toBe(newerEmpty);
    expect(store.getOrCreateDefaultConversationId()).toBe(newerEmpty);
    expect(
      (
        db.prepare(`SELECT COUNT(*) AS count FROM conversation`).get() as {
          count: number;
        }
      ).count,
    ).toBe(3);
  });

  it("creates only when every existing chat has visible conversation content", () => {
    const { db, store } = createContext();
    const occupied = store.getOrCreateDefaultConversationId();
    store.appendEvent({
      conversationId: occupied,
      type: "assistant_message",
      timestamp: 1_000,
      payload: { text: "Occupied" },
    });

    const created = store.createNewDefaultConversationId();

    expect(created).not.toBe(occupied);
    expect(
      (
        db.prepare(`SELECT COUNT(*) AS count FROM conversation`).get() as {
          count: number;
        }
      ).count,
    ).toBe(2);

    expect(store.createNewDefaultConversationId()).toBe(created);
  });

  it("does not reuse an agent-owned chat even without visible messages", () => {
    const { db, store } = createContext();
    const agentOwned = store.getOrCreateDefaultConversationId();
    db.prepare(
      `INSERT INTO agent (
        thread_id, conversation_id, agent_type, description, agent_depth,
        status, started_at, updated_at
      ) VALUES (?, ?, 'general', 'Background task', 1, 'completed', 1000, 1000)`,
    ).run("completed-agent-thread", agentOwned);

    const created = store.createNewDefaultConversationId();

    expect(created).not.toBe(agentOwned);
    expect(store.createNewDefaultConversationId()).toBe(created);
  });

  it("ignores hidden and system-only events when deciding emptiness", () => {
    const { store } = createContext();
    const id = store.getOrCreateDefaultConversationId();
    store.appendEvent({
      conversationId: id,
      type: "assistant_message",
      timestamp: 1_000,
      payload: {
        text: "Hidden setup",
        metadata: { ui: { visibility: "hidden" } },
      },
    });
    store.appendEvent({
      conversationId: id,
      type: "tool_result",
      timestamp: 1_001,
      payload: { text: "System result" },
    });

    expect(store.createNewDefaultConversationId()).toBe(id);
  });

  it("treats visible attachment-only and context-only messages as occupied", () => {
    const { db, store } = createContext();
    const attachmentOnly = store.getOrCreateDefaultConversationId();
    store.appendEvent({
      conversationId: attachmentOnly,
      type: "user_message",
      timestamp: 1_000,
      payload: {
        text: "",
        attachments: [{ name: "notes.pdf", path: "/tmp/notes.pdf" }],
      },
    });
    const contextOnly = conversationId("X");
    db.prepare(
      `INSERT INTO conversation (id, title, status, created_at, updated_at)
       VALUES (?, '', 'active', 2000, 2000)`,
    ).run(contextOnly);
    store.appendEvent({
      conversationId: contextOnly,
      type: "user_message",
      timestamp: 2_000,
      payload: {
        text: "",
        metadata: { context: { appSelectionLabel: "Selected settings" } },
      },
    });
    store.setActiveDefaultConversationId(attachmentOnly);

    const created = store.createNewDefaultConversationId();

    expect(created).not.toBe(attachmentOnly);
    expect(created).not.toBe(contextOnly);
  });

  it("serializes New Chat selection across two WAL connections", async () => {
    const { rootPath, db, store } = createContext();
    const occupied = store.getOrCreateDefaultConversationId();
    store.appendEvent({
      conversationId: occupied,
      type: "user_message",
      timestamp: 1_000,
      payload: { text: "Occupied" },
    });
    const databasePath = getDesktopDatabasePath(rootPath);
    const competingEmpty = conversationId("W");
    const workerSource = `
      const { parentPort, workerData } = require("node:worker_threads");
      const { DatabaseSync } = require("node:sqlite");
      const db = new DatabaseSync(workerData.databasePath, { timeout: 5000 });
      db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;");
      parentPort.once("message", ({ type }) => {
        if (type !== "go") return;
        try {
          db.exec("BEGIN IMMEDIATE;");
          parentPort.postMessage({ type: "holding" });
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250);
          const now = Date.now();
          db.prepare(\`INSERT INTO conversation (
            id, title, status, created_at, updated_at
          ) VALUES (?, '', 'active', ?, ?)\`).run(
            workerData.competingEmpty,
            now,
            now,
          );
          db.prepare(\`INSERT INTO settings (key, value, updated_at)
            VALUES ('default_conversation_id', ?, ?)
            ON CONFLICT(key) DO UPDATE SET
              value = excluded.value,
              updated_at = excluded.updated_at\`).run(
                workerData.competingEmpty,
                now,
              );
          db.exec("COMMIT;");
          parentPort.postMessage({
            type: "result",
            conversationId: workerData.competingEmpty,
          });
        } catch (error) {
          try { db.exec("ROLLBACK;"); } catch {}
          parentPort.postMessage({
            type: "error",
            message: error instanceof Error ? error.message : String(error),
          });
        } finally {
          db.close();
        }
      });
      parentPort.postMessage({ type: "ready" });
    `;
    const worker = new Worker(workerSource, {
      eval: true,
      workerData: { databasePath, competingEmpty },
    });
    const waitFor = <T extends { type: string }>(
      worker: Worker,
      type: T["type"],
    ) =>
      new Promise<T>((resolve, reject) => {
        const onMessage = (message: T) => {
          if (message.type !== type) return;
          cleanup();
          resolve(message);
        };
        const cleanup = () => {
          worker.off("message", onMessage);
          worker.off("error", onError);
        };
        const onError = (error: Error) => {
          cleanup();
          reject(error);
        };
        worker.on("message", onMessage);
        worker.on("error", onError);
      });
    try {
      await waitFor(worker, "ready");
      const holding = waitFor(worker, "holding");
      worker.postMessage({ type: "go" });
      await holding;
      const competingResult = waitFor<{
        type: "result";
        conversationId: string;
      }>(worker, "result");

      const resolved = store.createNewDefaultConversationId();
      const competing = await competingResult;
      expect(resolved).toBe(competing.conversationId);
      expect(resolved).toBe(competingEmpty);
      expect(
        (
          db.prepare(`SELECT COUNT(*) AS count FROM conversation`).get() as {
            count: number;
          }
        ).count,
      ).toBe(2);
    } finally {
      await worker.terminate();
    }
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
      `INSERT INTO thread (
        id, conversation_id, agent_type, name, status, created_at, last_used_at
      ) VALUES (?, ?, 'general', 'Child', 'active', 1000, 1000)`,
    ).run("deleted-thread", id);
    db.prepare(
      `INSERT INTO thread_entry (
        thread_id, seq, id, type, timestamp_iso, created_at, payload
      ) VALUES (?, 1, ?, 'message', ?, 1000, '{}')`,
    ).run("deleted-thread", "deleted-entry", new Date(1_000).toISOString());

    expect(store.deleteConversation(id)).toBe(true);
    expect(store.deleteConversation(id)).toBe(false);
    expect(
      db.prepare(`SELECT 1 FROM entry WHERE id = ?`).get(event._id),
    ).toBeUndefined();
    expect(
      db
        .prepare(`SELECT 1 FROM thread_entry WHERE thread_id = ?`)
        .get("deleted-thread"),
    ).toBeUndefined();
    expect(store.getOrCreateDefaultConversationId()).not.toBe(id);
  });

  it("refuses deletion while a conversation has a running agent", () => {
    const { db, store } = createContext();
    const id = store.getOrCreateDefaultConversationId();
    db.prepare(
      `INSERT INTO agent (
        thread_id, conversation_id, agent_type, description, agent_depth,
        status, started_at, updated_at
      ) VALUES (?, ?, 'general', 'Still running', 1, 'running', 1000, 1000)`,
    ).run("running-thread", id);

    expect(() => store.deleteConversation(id)).toThrow(
      "A conversation with running tasks cannot be deleted.",
    );
    expect(
      store
        .listConversationSummaries()
        .conversations.some((item) => item.conversationId === id),
    ).toBe(true);
  });
});
