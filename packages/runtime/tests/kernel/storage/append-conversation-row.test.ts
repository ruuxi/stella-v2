import { rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import {
  getDesktopDatabasePath,
  initializeDesktopDatabase,
} from "@stella/runtime/kernel/storage/database-init";
import { SessionStore } from "../../../kernel/storage/session-store.js";
import {
  cachedStatements,
  type SqliteDatabase,
} from "@stella/runtime/kernel/storage/shared";

// appendEvent no longer runs a separate `ensureConversation` upsert: the
// conversation row is created only when missing and otherwise updated by the
// seq claim (new entry) or a touch (existing entry). These pin that the row
// ends up exactly as the upsert left it.

type TestContext = { rootPath: string; db: SqliteDatabase; store: SessionStore };

const activeContexts = new Set<TestContext>();

const createContext = (): TestContext => {
  const rootPath = path.join(
    os.tmpdir(),
    `stella-append-conversation-${Date.now()}-${Math.random().toString(36).slice(2)}`,
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

type ConversationRow = {
  kind: string;
  nextSeq: number;
  createdAt: number;
  updatedAt: number;
};

const readConversation = (
  db: SqliteDatabase,
  conversationId: string,
): ConversationRow | undefined =>
  db
    .prepare(
      `SELECT kind, next_seq AS nextSeq, created_at AS createdAt,
              updated_at AS updatedAt
       FROM conversation WHERE id = ?`,
    )
    .get(conversationId) as ConversationRow | undefined;

describe("appendEvent conversation row", () => {
  it("creates a missing conversation on the first append", () => {
    const { db, store } = createContext();
    const chatId = "local_append-creates";
    const derivedId = "derived-append-creates";
    expect(readConversation(db, chatId)).toBeUndefined();

    const event = store.appendEvent({
      conversationId: chatId,
      eventId: "first",
      type: "user_message",
      timestamp: 1_000,
      payload: { text: "hello" },
    });
    store.appendEvent({
      conversationId: derivedId,
      eventId: "derived-first",
      type: "assistant_message",
      timestamp: 1_500,
      payload: { text: "hi" },
    });

    expect(event.sequence).toBe(1);
    expect(readConversation(db, chatId)).toEqual({
      kind: "chat",
      nextSeq: 2,
      createdAt: 1_000,
      updatedAt: 1_000,
    });
    expect(readConversation(db, derivedId)).toMatchObject({
      kind: "derived",
      nextSeq: 2,
      updatedAt: 1_500,
    });
  });

  it("keeps updated_at monotonic across new and updated entries", () => {
    const { db, store } = createContext();
    const id = "local_append-monotonic";
    store.appendEvent({
      conversationId: id,
      eventId: "a",
      type: "user_message",
      timestamp: 2_000,
      payload: { text: "a" },
    });
    const older = store.appendEvent({
      conversationId: id,
      eventId: "b",
      type: "assistant_message",
      timestamp: 1_000,
      payload: { text: "b" },
    });
    expect(older.sequence).toBe(2);
    expect(readConversation(db, id)?.updatedAt).toBe(2_000);

    // Re-appending an existing id updates the entry in place and still
    // bumps the conversation, without claiming a new seq.
    const updated = store.appendEvent({
      conversationId: id,
      eventId: "b",
      type: "assistant_message",
      timestamp: 3_000,
      payload: { text: "b2" },
    });
    expect(updated.sequence).toBe(2);
    expect(readConversation(db, id)).toMatchObject({
      nextSeq: 3,
      createdAt: 2_000,
      updatedAt: 3_000,
    });
  });

  it("re-derives a stale kind the way the upsert did", () => {
    const { db, store } = createContext();
    const id = "local_append-stale-kind";
    db.prepare(
      `INSERT INTO conversation (id, kind, title, status, next_seq, created_at, updated_at)
       VALUES (?, 'derived', '', 'active', 1, 10, 10)`,
    ).run(id);
    store.appendEvent({
      conversationId: id,
      eventId: "kind-a",
      type: "user_message",
      timestamp: 20,
      payload: { text: "a" },
    });
    expect(readConversation(db, id)?.kind).toBe("chat");

    db.prepare("UPDATE conversation SET kind = 'derived' WHERE id = ?").run(id);
    store.appendEvent({
      conversationId: id,
      eventId: "kind-a",
      type: "user_message",
      timestamp: 30,
      payload: { text: "a2" },
    });
    expect(readConversation(db, id)).toMatchObject({
      kind: "chat",
      updatedAt: 30,
    });
  });

  it("recreates a deleted conversation and moves an entry across conversations", () => {
    const { db, store } = createContext();
    const first = "local_append-first";
    const second = "local_append-second";
    store.appendEvent({
      conversationId: first,
      eventId: "moving",
      type: "user_message",
      timestamp: 100,
      payload: { text: "moving" },
    });
    expect(store.deleteConversation(first)).toBe(true);
    expect(readConversation(db, first)).toBeUndefined();

    store.appendEvent({
      conversationId: first,
      eventId: "after-delete",
      type: "user_message",
      timestamp: 200,
      payload: { text: "back" },
    });
    expect(readConversation(db, first)).toMatchObject({
      nextSeq: 2,
      updatedAt: 200,
    });

    store.appendEvent({
      conversationId: first,
      eventId: "moved",
      type: "user_message",
      timestamp: 300,
      payload: { text: "moved" },
    });
    const moved = store.appendEvent({
      conversationId: second,
      eventId: "moved",
      type: "user_message",
      timestamp: 400,
      payload: { text: "moved" },
    });
    expect(moved.sequence).toBe(1);
    expect(readConversation(db, second)).toMatchObject({
      kind: "chat",
      nextSeq: 2,
      updatedAt: 400,
    });
    expect(store.hasEvent(first, "moved")).toBe(false);
    expect(store.hasEvent(second, "moved")).toBe(true);
  });
});

describe("cachedStatements", () => {
  it("shares one statement per SQL text per connection", () => {
    const { db } = createContext();
    const cache = cachedStatements(db);
    expect(cachedStatements(db)).toBe(cache);
    const statement = cache.prepare("SELECT 1 AS one");
    expect(cache.prepare("SELECT 1 AS one")).toBe(statement);
    expect(cache.prepare("SELECT 2 AS one")).not.toBe(statement);
    const echo = cache.prepare("SELECT ? AS a, ? AS b");
    expect(echo.get(1, 2)).toEqual({ a: 1, b: 2 });
    expect(echo.get(3, 4)).toEqual({ a: 3, b: 4 });
  });

  it("drops the cache when the connection closes", async () => {
    const rootPath = path.join(
      os.tmpdir(),
      `stella-statement-cache-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    const db = new DatabaseSync(getDesktopDatabasePath(rootPath), {
      timeout: 5_000,
    }) as unknown as SqliteDatabase;
    try {
      initializeDesktopDatabase(db);
      const cache = cachedStatements(db);
      const statement = cache.prepare("SELECT COUNT(*) AS count FROM conversation");
      expect(statement.get()).toEqual({ count: 0 });
      db.close();
      expect(() => statement.get()).toThrow();
      expect(() => cache.prepare("SELECT 1")).toThrow();
    } finally {
      await rm(rootPath, { recursive: true, force: true });
    }
  });
});
