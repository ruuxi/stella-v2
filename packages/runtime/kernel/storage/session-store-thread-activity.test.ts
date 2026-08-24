import { afterEach, describe, expect, test } from "bun:test";
import { DatabaseSync } from "node:sqlite";
import { SessionStore } from "./session-store.js";

const databases: DatabaseSync[] = [];

const createStore = () => {
  const db = new DatabaseSync(":memory:");
  databases.push(db);
  db.exec(`
    CREATE TABLE runtime_agents (
      thread_id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL,
      agent_type TEXT NOT NULL,
      description TEXT NOT NULL,
      status TEXT NOT NULL,
      attempt_generation INTEGER,
      parent_agent_id TEXT,
      model_config_json TEXT,
      started_at INTEGER NOT NULL,
      completed_at INTEGER,
      result TEXT,
      error TEXT,
      updated_at INTEGER NOT NULL,
      root_run_id TEXT,
      record_revision INTEGER NOT NULL DEFAULT 0
    )
  `);
  return { db, store: new SessionStore(db) };
};

const insertActivity = (
  db: DatabaseSync,
  args: {
    threadId: string;
    status: "running" | "completed";
    startedAt: number;
    updatedAt: number;
    result?: string;
  },
) => {
  db.prepare(
    `
    INSERT INTO runtime_agents (
      thread_id, conversation_id, agent_type, description, status,
      attempt_generation, started_at, completed_at, result, updated_at
    ) VALUES (?, 'conversation', 'general', ?, ?, 1, ?, ?, ?, ?)
  `,
  ).run(
    args.threadId,
    `Task ${args.threadId}`,
    args.status,
    args.startedAt,
    args.status === "completed" ? args.updatedAt : null,
    args.result ?? null,
    args.updatedAt,
  );
};

afterEach(() => {
  while (databases.length > 0) databases.pop()?.close();
});

describe("SessionStore compact thread activity", () => {
  test("bounds the projection, prioritizes running work, and omits heavy fields", () => {
    const { db, store } = createStore();
    insertActivity(db, {
      threadId: "old-complete",
      status: "completed",
      startedAt: 1,
      updatedAt: 10,
      result: "old",
    });
    insertActivity(db, {
      threadId: "running",
      status: "running",
      startedAt: 2,
      updatedAt: 20,
    });
    insertActivity(db, {
      threadId: "new-complete",
      status: "completed",
      startedAt: 3,
      updatedAt: 30,
      result: "x".repeat(700),
    });

    const rows = store.listThreadActivity("conversation", {
      view: "mobile-summary",
      maxItems: 2,
    });

    expect(rows.map((row) => row.threadId)).toEqual([
      "running",
      "new-complete",
    ]);
    expect(rows[1]?.result).toHaveLength(512);
    expect(rows[0]).not.toHaveProperty("modelConfigSnapshot");
    expect(rows[0]).not.toHaveProperty("assistantMessages");
    expect(rows[0]).not.toHaveProperty("groupKey");

    expect(
      store.listThreadActivity("conversation", {
        view: "mobile-summary",
        maxItems: Number.NaN,
      }),
    ).toHaveLength(3);
  });
});
