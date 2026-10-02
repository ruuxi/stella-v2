import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";

import { migrateDesktopDatabase } from "../kernel/storage/schema.js";
import type { SqliteDatabase } from "../kernel/storage/shared.js";
import {
  THREAD_SUMMARY_MAX_ROWS,
  ThreadSummaryStore,
} from "../kernel/memory/thread-summary-store.js";

const databases: DatabaseSync[] = [];

afterEach(() => {
  while (databases.length > 0) databases.pop()?.close();
});

const openMigrated = (): SqliteDatabase => {
  const db = new DatabaseSync(":memory:");
  databases.push(db);
  const typed = db as unknown as SqliteDatabase;
  migrateDesktopDatabase(typed);
  return typed;
};

const record = (
  store: ThreadSummaryStore,
  threadId: string,
  content: string,
) => {
  store.recordThreadSummary({
    threadId,
    runId: `run-${threadId}`,
    agentType: "general",
    rolloutSummary: content,
  });
};

const touch = (db: SqliteDatabase, threadId: string, atMs: number) => {
  db.prepare(
    "UPDATE durable_thread_summaries SET source_updated_at = ? WHERE thread_id = ?",
  ).run(atMs, threadId);
};

const ftsRowCount = (db: SqliteDatabase): number =>
  Number(
    (
      db
        .prepare("SELECT COUNT(*) AS count FROM durable_thread_summaries_fts")
        .get() as { count: number }
    ).count,
  );

describe("durable thread summary retention sweep", () => {
  it("drops summaries past the retention window", () => {
    const db = openMigrated();
    const store = new ThreadSummaryStore(db);
    record(store, "thread-old", "Ancient summary about invoices.");
    record(store, "thread-new", "Fresh summary about invoices.");
    const now = 10_000_000_000;
    touch(db, "thread-old", now - 200 * 24 * 60 * 60 * 1000);
    touch(db, "thread-new", now - 1_000);

    expect(store.sweepThreadSummaries({ now })).toBe(1);
    expect(
      store.listRecentThreadSummaries().map((row) => row.threadId),
    ).toEqual(["thread-new"]);
    // The external-content index must not keep a stale entry behind.
    expect(ftsRowCount(db)).toBe(1);
  });

  it("trims the oldest rows beyond the count bound, one batch per pass", () => {
    const db = openMigrated();
    const store = new ThreadSummaryStore(db);
    for (let index = 0; index < 12; index += 1) {
      record(store, `thread-${index}`, `Summary number ${index} about work.`);
      touch(db, `thread-${index}`, 1_000 + index);
    }

    expect(
      store.sweepThreadSummaries({ maxRows: 5, batchSize: 3, now: 2_000 }),
    ).toBe(3);
    expect(
      store.sweepThreadSummaries({ maxRows: 5, batchSize: 100, now: 2_000 }),
    ).toBe(4);
    const remaining = store.listRecentThreadSummaries();
    expect(remaining.map((row) => row.threadId)).toEqual([
      "thread-11",
      "thread-10",
      "thread-9",
      "thread-8",
      "thread-7",
    ]);
    expect(ftsRowCount(db)).toBe(5);
  });

  it("leaves a store inside both bounds untouched", () => {
    const db = openMigrated();
    const store = new ThreadSummaryStore(db);
    record(store, "thread-keep", "Recent summary worth keeping.");
    expect(store.sweepThreadSummaries()).toBe(0);
    expect(THREAD_SUMMARY_MAX_ROWS).toBeGreaterThan(0);
    expect(store.listRecentThreadSummaries()).toHaveLength(1);
  });
});
