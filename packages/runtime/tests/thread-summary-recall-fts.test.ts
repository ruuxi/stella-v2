import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";

import {
  SCHEMA_VERSION,
  migrateDesktopDatabase,
} from "../kernel/storage/schema.js";
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

const dropSummaryIndex = (db: SqliteDatabase) => {
  db.exec("DROP TRIGGER trg_durable_thread_summaries_fts_insert;");
  db.exec("DROP TRIGGER trg_durable_thread_summaries_fts_update;");
  db.exec("DROP TRIGGER trg_durable_thread_summaries_fts_delete;");
  db.exec("DROP TABLE durable_thread_summaries_fts;");
};

const ftsRowCount = (db: SqliteDatabase): number =>
  Number(
    (
      db
        .prepare("SELECT COUNT(*) AS count FROM durable_thread_summaries_fts")
        .get() as { count: number }
    ).count,
  );

describe("durable thread summary FTS", () => {
  it("creates the summary index at the current schema version", () => {
    const db = openMigrated();
    const version = db.prepare("PRAGMA user_version;").get() as {
      user_version: number;
    };
    expect(version.user_version).toBe(SCHEMA_VERSION);
    expect(new ThreadSummaryStore(db).ftsAvailable()).toBe(true);
  });

  it("ranks by relevance rather than recency", () => {
    const db = openMigrated();
    const store = new ThreadSummaryStore(db);
    record(
      store,
      "thread-relevant",
      "Migrated the invoice reconciliation pipeline. The invoice job now " +
        "reconciles every invoice batch nightly.",
    );
    record(
      store,
      "thread-recent",
      "Renamed a button and mentioned an invoice once in passing while " +
        "mostly discussing unrelated layout work.",
    );
    // The weak match is the newest row: recency ordering would float it first.
    touch(db, "thread-relevant", 1_000);
    touch(db, "thread-recent", 9_000);

    const hits = store.searchThreadSummaries(["invoice"]);
    expect(hits.map((hit) => hit.threadId)).toEqual([
      "thread-relevant",
      "thread-recent",
    ]);
  });

  it("matches stemmed and diacritic-folded forms the LIKE scan missed", () => {
    const db = openMigrated();
    const store = new ThreadSummaryStore(db);
    record(store, "thread-stem", "Reconciling the café deployments nightly.");

    expect(
      store.searchThreadSummaries(["reconcile"]).map((hit) => hit.threadId),
    ).toEqual(["thread-stem"]);
    expect(
      store.searchThreadSummaries(["cafe"]).map((hit) => hit.threadId),
    ).toEqual(["thread-stem"]);
  });

  it("keeps FTS syntax out of user tokens", () => {
    const db = openMigrated();
    const store = new ThreadSummaryStore(db);
    record(store, "thread-quote", 'He said "ship it" on the release call.');

    expect(() => store.searchThreadSummaries(['"ship it"'])).not.toThrow();
    expect(
      store.searchThreadSummaries(['"ship it"']).map((hit) => hit.threadId),
    ).toEqual(["thread-quote"]);
    expect(store.searchThreadSummaries(["OR AND NOT ("])).toEqual([]);
  });

  it("mirrors updates and deletes into the index", () => {
    const db = openMigrated();
    const store = new ThreadSummaryStore(db);
    record(store, "thread-1", "First summary about penguins.");
    store.recordThreadSummary({
      threadId: "thread-1",
      runId: "run-thread-1",
      agentType: "general",
      rolloutSummary: "Replaced summary about walruses.",
    });

    expect(store.searchThreadSummaries(["penguins"])).toEqual([]);
    expect(
      store.searchThreadSummaries(["walruses"]).map((hit) => hit.threadId),
    ).toEqual(["thread-1"]);

    db.prepare("DELETE FROM durable_thread_summaries").run();
    expect(ftsRowCount(db)).toBe(0);
  });

  it("falls back to the LIKE scan when the index is unavailable", () => {
    const db = openMigrated();
    // A SQLite build without FTS5 gets neither the index nor its triggers.
    dropSummaryIndex(db);
    const store = new ThreadSummaryStore(db);
    store.recordThreadSummary({
      threadId: "thread-like",
      runId: "run-1",
      agentType: "general",
      rolloutSummary: "Quarterly invoice reconciliation notes.",
    });

    expect(store.ftsAvailable()).toBe(false);
    expect(
      store.searchThreadSummaries(["invoice"]).map((hit) => hit.threadId),
    ).toEqual(["thread-like"]);
  });

  it("backfills rows written before the index migration", () => {
    const db = openMigrated();
    // Return the database to the pre-FTS shape, rows and all.
    dropSummaryIndex(db);
    db.prepare(
      `INSERT INTO durable_thread_summaries (
         source_key, thread_id, run_id, agent_type, content, source_updated_at
       ) VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(
      "legacy:run-legacy",
      "thread-legacy",
      "run-legacy",
      "general",
      "Legacy summary about the invoice reconciliation rollout.",
      1_000,
    );
    db.exec(`PRAGMA user_version = ${SCHEMA_VERSION - 1};`);

    migrateDesktopDatabase(db);

    expect(ftsRowCount(db)).toBe(1);
    expect(
      new ThreadSummaryStore(db)
        .searchThreadSummaries(["reconciliation"])
        .map((hit) => hit.threadId),
    ).toEqual(["thread-legacy"]);
  });
});

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
    expect(
      store.searchThreadSummaries(["invoices"]).map((hit) => hit.threadId),
    ).toEqual(["thread-new"]);
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
