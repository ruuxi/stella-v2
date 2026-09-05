import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";

import {
  listTranscriptNeighborsBatch,
  readRecallFtsHealth,
} from "@stella/runtime/kernel/storage/recall-read-queries";

const databases: DatabaseSync[] = [];

afterEach(() => {
  for (const db of databases) db.close();
  databases.length = 0;
});

const makeDb = (): DatabaseSync => {
  const db = new DatabaseSync(":memory:");
  databases.push(db);
  db.exec(`
    CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT, updated_at INTEGER);
    CREATE TABLE entry (
      conversation_id TEXT NOT NULL,
      seq INTEGER NOT NULL,
      id TEXT NOT NULL,
      role TEXT NOT NULL,
      type TEXT NOT NULL,
      search_text TEXT,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (conversation_id, seq)
    );
  `);
  return db;
};

describe("Recall read queries", () => {
  it("expands multiple transcript hits in one batched query", () => {
    const db = makeDb();
    const insertEntry = db.prepare(
      `INSERT INTO entry (conversation_id, seq, id, role, type, search_text, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const [index, [id, atMs, text]] of (
      [
        ["m1", 100, "before one"],
        ["m2", 200, "hit one"],
        ["m3", 300, "after one"],
        ["m4", 1_000, "before two"],
        ["m5", 1_100, "hit two"],
        ["m6", 1_200, "after two"],
      ] as const
    ).entries()) {
      insertEntry.run(
        "conv-1",
        index + 1,
        id,
        "user",
        "user_message",
        text,
        atMs,
      );
    }

    const rows = listTranscriptNeighborsBatch(
      db as never,
      [
        { conversationId: "conv-1", atMs: 200 },
        { conversationId: "conv-1", atMs: 1_100 },
      ],
      { before: 1, after: 1, windowMs: 500 },
    );

    expect(rows.map((group) => group.map((row) => row.text))).toEqual([
      ["before one", "after one"],
      ["before two", "after two"],
    ]);
  });

  it("reports missing or unbuilt FTS instead of permitting LIKE fallback", () => {
    const db = makeDb();
    expect(readRecallFtsHealth(db as never)).toMatchObject({
      healthy: false,
      transcriptReady: false,
      threadsReady: false,
    });
  });

  it("proves MATCH execution instead of trusting table names and flags", () => {
    const db = makeDb();
    db.exec(`
      CREATE TABLE entry_fts (search_text TEXT);
      CREATE TABLE thread_fts (search_text TEXT);
      INSERT INTO meta (key, value, updated_at) VALUES ('fts_ready', '1', 0);
    `);

    expect(readRecallFtsHealth(db as never)).toMatchObject({
      healthy: false,
      transcriptReady: false,
      threadsReady: false,
    });
    expect(readRecallFtsHealth(db as never).reason).toContain(
      "MATCH probe failed",
    );
  });

  it("reports healthy only when both FTS indexes execute MATCH", () => {
    const db = makeDb();
    db.exec(`
      CREATE VIRTUAL TABLE entry_fts USING fts5(search_text);
      CREATE VIRTUAL TABLE thread_fts USING fts5(search_text);
      INSERT INTO meta (key, value, updated_at) VALUES ('fts_ready', '1', 0);
    `);

    expect(readRecallFtsHealth(db as never)).toEqual({
      healthy: true,
      transcriptReady: true,
      threadsReady: true,
    });
  });

  it("batches canonical neighbors by sequence even when timestamps collide", () => {
    const db = makeDb();
    db.exec("ALTER TABLE entry ADD COLUMN visible INTEGER DEFAULT 1");
    const insert = db.prepare(
      "INSERT INTO entry VALUES ('conv', ?, ?, ?, ?, ?, 1000, ?)",
    );
    insert.run(1, "before", "user", "user_message", "question", 1);
    insert.run(2, "hit", "assistant", "assistant_message", "suggestion", 1);
    insert.run(3, "hidden", "user", "user_message", "internal", 0);
    insert.run(
      4,
      "correction",
      "user",
      "user_message",
      "actually, use PostgreSQL",
      1,
    );
    const rows = listTranscriptNeighborsBatch(
      db as never,
      [{ conversationId: "conv", atMs: 1000, sequence: 2 }],
      { before: 1, after: 1 },
    );
    expect(rows[0]?.map((row) => row.id)).toEqual(["before", "correction"]);
    expect(rows[0]?.[1]?.text).toContain("PostgreSQL");
  });
});
