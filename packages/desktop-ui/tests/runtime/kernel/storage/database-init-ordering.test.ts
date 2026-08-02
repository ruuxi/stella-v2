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
import type { SqliteDatabase } from "@stella/runtime/kernel/storage/shared";

const roots = new Set<string>();
const databases = new Set<SqliteDatabase>();
const workers = new Set<Worker>();

const openDatabase = () => {
  const rootPath = path.join(
    os.tmpdir(),
    `stella-database-init-ordering-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  roots.add(rootPath);
  const dbPath = getDesktopDatabasePath(rootPath);
  const db = new DatabaseSync(dbPath, {
    timeout: 5000,
  }) as unknown as SqliteDatabase;
  databases.add(db);
  return { db, dbPath };
};

const createLegacyEntryTable = (db: SqliteDatabase) => {
  db.exec(`
    CREATE TABLE runtime_thread_entries (
      entry_id TEXT PRIMARY KEY,
      thread_key TEXT NOT NULL,
      session_id TEXT NOT NULL,
      parent_entry_id TEXT,
      entry_type TEXT NOT NULL,
      timestamp_iso TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      insertion_sequence INTEGER,
      data_json TEXT
    );
  `);
};

const insertLegacyEntry = (
  db: SqliteDatabase,
  entryId: string,
  insertionSequence: unknown,
) => {
  db.prepare(
    `INSERT INTO runtime_thread_entries (
       entry_id, thread_key, session_id, entry_type, timestamp_iso, created_at,
       insertion_sequence, data_json
     ) VALUES (?, 'legacy-thread', 'legacy-session', 'message', ?, ?, ?, '{}')`,
  ).run(
    entryId,
    new Date(1_700_000_000_000).toISOString(),
    1_700_000_000_000,
    insertionSequence,
  );
};

const readSequences = (db: SqliteDatabase) =>
  db
    .prepare(
      `SELECT entry_id AS entryId, insertion_sequence AS insertionSequence
       FROM runtime_thread_entries
       ORDER BY rowid`,
    )
    .all() as Array<{ entryId: string; insertionSequence: unknown }>;

afterEach(async () => {
  await Promise.all(
    [...workers].map(async (worker) => {
      await worker.terminate();
    }),
  );
  workers.clear();
  for (const db of databases) {
    db.close();
  }
  databases.clear();
  await Promise.all(
    [...roots].map((rootPath) =>
      rm(rootPath, { recursive: true, force: true }),
    ),
  );
  roots.clear();
});

describe("runtime thread entry ordering migration", () => {
  it("installs sequence enforcement on a fresh database and stays idempotent", () => {
    const { db } = openDatabase();

    initializeDesktopDatabase(db);
    initializeDesktopDatabase(db);

    const sequenceIndex = db
      .prepare("PRAGMA index_list('runtime_thread_entries')")
      .all()
      .find(
        (row) =>
          (row as { name?: unknown }).name ===
          "idx_runtime_thread_entries_sequence",
      ) as { unique?: unknown } | undefined;
    expect(sequenceIndex?.unique).toBe(1);
    expect(
      db
        .prepare(
          `SELECT sql FROM sqlite_schema
           WHERE type = 'trigger'
             AND name = 'trg_runtime_thread_entries_sequence'`,
        )
        .get(),
    ).toMatchObject({
      sql: expect.stringContaining("MAX(insertion_sequence)"),
    });

    db.exec(`
      INSERT INTO runtime_threads (
        thread_key, conversation_id, agent_type, name, status, created_at,
        last_used_at
      ) VALUES ('fresh-thread', 'fresh-conversation', 'general', 'Fresh',
        'active', 1, 1);
      INSERT INTO runtime_thread_entries (
        entry_id, thread_key, session_id, entry_type, timestamp_iso, created_at,
        data_json
      ) VALUES ('fresh-entry', 'fresh-thread', 'fresh-session', 'message',
        '2026-01-01T00:00:00.000Z', 1, '{}');
    `);
    expect(readSequences(db)).toEqual([
      { entryId: "fresh-entry", insertionSequence: 1 },
    ]);
  });

  it("preserves valid sparse ordering across repeated startup", () => {
    const { db } = openDatabase();
    createLegacyEntryTable(db);
    insertLegacyEntry(db, "first", 10);
    insertLegacyEntry(db, "second", 20);
    db.exec(`
      CREATE INDEX idx_runtime_thread_entries_thread_append
      ON runtime_thread_entries(thread_key, created_at);
    `);

    initializeDesktopDatabase(db);
    initializeDesktopDatabase(db);

    expect(readSequences(db)).toEqual([
      { entryId: "first", insertionSequence: 10 },
      { entryId: "second", insertionSequence: 20 },
    ]);
    insertLegacyEntry(db, "third", null);
    expect(readSequences(db)).toEqual([
      { entryId: "first", insertionSequence: 10 },
      { entryId: "second", insertionSequence: 20 },
      { entryId: "third", insertionSequence: 21 },
    ]);
    expect(
      db
        .prepare(
          `SELECT 1 FROM sqlite_schema
           WHERE type = 'index'
             AND name = 'idx_runtime_thread_entries_thread_append'`,
        )
        .get(),
    ).toBeUndefined();
  });

  it("recovers nulls, collisions, invalid values, and stale enforcement", () => {
    const { db } = openDatabase();
    createLegacyEntryTable(db);
    insertLegacyEntry(db, "first", null);
    insertLegacyEntry(db, "second", 9);
    insertLegacyEntry(db, "third", 9);
    insertLegacyEntry(db, "fourth", "invalid");
    db.exec(`
      CREATE INDEX idx_runtime_thread_entries_sequence
      ON runtime_thread_entries(insertion_sequence);
      CREATE TRIGGER trg_runtime_thread_entries_sequence
      AFTER INSERT ON runtime_thread_entries
      WHEN NEW.insertion_sequence IS NULL
      BEGIN
        UPDATE runtime_thread_entries
        SET insertion_sequence = -1
        WHERE rowid = NEW.rowid;
      END;
    `);

    initializeDesktopDatabase(db);
    initializeDesktopDatabase(db);

    expect(readSequences(db)).toEqual([
      { entryId: "first", insertionSequence: 1 },
      { entryId: "second", insertionSequence: 2 },
      { entryId: "third", insertionSequence: 3 },
      { entryId: "fourth", insertionSequence: 4 },
    ]);
    insertLegacyEntry(db, "fifth", null);
    expect(readSequences(db).at(-1)).toEqual({
      entryId: "fifth",
      insertionSequence: 5,
    });
  });

  it("rolls back an interrupted transition and recovers on the next startup", () => {
    const { db } = openDatabase();
    createLegacyEntryTable(db);
    insertLegacyEntry(db, "first", null);
    insertLegacyEntry(db, "second", 7);
    insertLegacyEntry(db, "third", 7);
    // This legacy name collision fails the last index creation after the data
    // repair and enforcement objects have run, exercising rollback of the
    // complete ordering transition rather than only an early statement.
    db.exec(
      "CREATE TABLE idx_runtime_thread_entries_thread_sequence (id TEXT);",
    );
    const before = readSequences(db);

    expect(() => initializeDesktopDatabase(db)).toThrow(
      /idx_runtime_thread_entries_thread_sequence/,
    );

    expect(readSequences(db)).toEqual(before);
    expect(
      db
        .prepare(
          `SELECT name FROM sqlite_schema
           WHERE name IN (
             'idx_runtime_thread_entries_sequence',
             'trg_runtime_thread_entries_sequence'
           )`,
        )
        .all(),
    ).toEqual([]);

    db.exec("DROP TABLE idx_runtime_thread_entries_thread_sequence;");
    initializeDesktopDatabase(db);
    expect(readSequences(db)).toEqual([
      { entryId: "first", insertionSequence: 1 },
      { entryId: "second", insertionSequence: 2 },
      { entryId: "third", insertionSequence: 3 },
    ]);
  });

  it("serializes a second connection appending during the exact migration", async () => {
    const { db, dbPath } = openDatabase();
    createLegacyEntryTable(db);
    insertLegacyEntry(db, "first", null);
    insertLegacyEntry(db, "second", null);

    const controlBuffer = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT);
    const control = new Int32Array(controlBuffer);
    const worker = new Worker(
      `
        const { DatabaseSync } = require("node:sqlite");
        const { parentPort, workerData } = require("node:worker_threads");
        const control = new Int32Array(workerData.controlBuffer);
        const db = new DatabaseSync(workerData.dbPath, { timeout: 5000 });
        db.exec("PRAGMA busy_timeout = 5000;");
        const insert = db.prepare(\`
          INSERT INTO runtime_thread_entries (
            entry_id, thread_key, session_id, entry_type, timestamp_iso,
            created_at, data_json
          ) VALUES (
            'concurrent', 'legacy-thread', 'legacy-session', 'message',
            '2026-01-01T00:00:00.000Z', 1700000000001, '{}'
          )
        \`);
        parentPort.postMessage({ type: "ready" });
        parentPort.once("message", () => {
          Atomics.store(control, 0, 1);
          Atomics.notify(control, 0);
          try {
            insert.run();
            const row = db.prepare(\`
              SELECT insertion_sequence AS insertionSequence
              FROM runtime_thread_entries
              WHERE entry_id = 'concurrent'
            \`).get();
            db.close();
            parentPort.postMessage({ type: "complete", row });
          } catch (error) {
            db.close();
            parentPort.postMessage({
              type: "error",
              message: error instanceof Error ? error.message : String(error),
            });
          }
        });
      `,
      {
        eval: true,
        workerData: { controlBuffer, dbPath },
      },
    );
    workers.add(worker);

    const ready = await new Promise<unknown>((resolve, reject) => {
      worker.once("message", resolve);
      worker.once("error", reject);
    });
    expect(ready).toEqual({ type: "ready" });
    const completion = new Promise<unknown>((resolve, reject) => {
      worker.once("message", resolve);
      worker.once("error", reject);
    });

    let orderingMigrationArmed = false;
    const instrumentedDb: SqliteDatabase = {
      exec: (sql) => {
        db.exec(sql);
        if (
          sql.includes("CREATE TABLE IF NOT EXISTS runtime_thread_sessions")
        ) {
          orderingMigrationArmed = true;
          return;
        }
        if (orderingMigrationArmed && sql.trim() === "BEGIN IMMEDIATE;") {
          orderingMigrationArmed = false;
          worker.postMessage({ type: "append" });
          if (Atomics.wait(control, 0, 0, 5000) === "timed-out") {
            throw new Error(
              "Concurrent writer did not reach its append attempt.",
            );
          }
        }
      },
      prepare: (sql) => db.prepare(sql),
      close: () => db.close(),
    };

    initializeDesktopDatabase(instrumentedDb);

    expect(await completion).toEqual({
      type: "complete",
      row: { insertionSequence: 3 },
    });
    expect(readSequences(db)).toEqual([
      { entryId: "first", insertionSequence: 1 },
      { entryId: "second", insertionSequence: 2 },
      { entryId: "concurrent", insertionSequence: 3 },
    ]);
  });
});
