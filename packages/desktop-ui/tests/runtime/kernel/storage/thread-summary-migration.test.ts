import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

import { initializeDesktopDatabase } from "@stella/runtime/kernel/storage/database-init";
import type { SqliteDatabase } from "@stella/runtime/kernel/storage/shared";
import { ThreadSummaryStore } from "@stella/runtime/kernel/memory/thread-summary-store";

const databases: DatabaseSync[] = [];

afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});

const tableExists = (db: DatabaseSync, name: string): boolean =>
  Boolean(
    db
      .prepare(
        "SELECT 1 AS found FROM sqlite_master WHERE type = 'table' AND name = ?",
      )
      .get(name),
  );

describe("retired automatic-memory database migration", () => {
  it("idempotently preserves thread summaries and removes queues and counters", () => {
    const db = new DatabaseSync(":memory:");
    databases.push(db);
    db.exec(`
      CREATE TABLE dream_inbox (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        kind TEXT NOT NULL,
        source_key TEXT NOT NULL,
        thread_id TEXT,
        run_id TEXT,
        agent_type TEXT,
        content TEXT NOT NULL,
        source_updated_at INTEGER NOT NULL,
        UNIQUE (kind, source_key)
      );
      CREATE TABLE runtime_memory_review_state (
        conversation_id TEXT PRIMARY KEY,
        user_turns_since_review INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE dream_consolidation_watermark (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        frontier INTEGER NOT NULL,
        completed_at INTEGER NOT NULL
      );
      CREATE TABLE dream_delta_watermark (
        conversation_id TEXT PRIMARY KEY,
        last_message_ts INTEGER NOT NULL,
        applied_through_ts INTEGER,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE dream_scheduler_state (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        tokens_at_last_run INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      INSERT INTO dream_inbox (
        kind, source_key, thread_id, run_id, agent_type, content,
        source_updated_at
      ) VALUES
        ('thread_summary', 'thread-42:run-7', 'thread-42', 'run-7',
         'General', 'Retained rollout result', 1700000000000),
        ('memory_note', 'note-1', NULL, NULL, 'Orchestrator',
         'Obsolete automatic-memory note', 1700000000001);
      INSERT INTO runtime_memory_review_state (
        conversation_id, user_turns_since_review
      ) VALUES ('conv-1', 17);
    `);

    initializeDesktopDatabase(db as unknown as SqliteDatabase);
    initializeDesktopDatabase(db as unknown as SqliteDatabase);

    expect(tableExists(db, "dream_inbox")).toBe(false);
    expect(tableExists(db, "runtime_memory_review_state")).toBe(false);
    expect(tableExists(db, "dream_consolidation_watermark")).toBe(false);
    expect(tableExists(db, "dream_delta_watermark")).toBe(false);
    expect(tableExists(db, "dream_scheduler_state")).toBe(false);
    const summaries = db
      .prepare(
        `
          SELECT source_key, thread_id, run_id, agent_type, content,
                 source_updated_at
          FROM durable_thread_summaries
        `,
      )
      .all();
    expect(summaries).toEqual([
      {
        source_key: "thread-42:run-7",
        thread_id: "thread-42",
        run_id: "run-7",
        agent_type: "General",
        content: "Retained rollout result",
        source_updated_at: 1700000000000,
      },
    ]);
    expect(
      new ThreadSummaryStore(
        db as unknown as SqliteDatabase,
      ).searchThreadSummaries(["rollout", "missing"]),
    ).toMatchObject([
      {
        threadId: "thread-42",
        runId: "run-7",
        content: "Retained rollout result",
      },
    ]);
  });
});
