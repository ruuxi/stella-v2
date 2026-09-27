import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { initializeDesktopDatabase } from "./database-init.js";
import { WorkerLifecycleServer } from "../../worker/lifecycle-server.js";
import {
  DatabaseMaintenance,
  MAINTENANCE_META_KEYS,
  analyzeOncePerSchemaVersion,
  buildSearchTextIndex,
  checkReclaimDiskSpace,
  checkpointWal,
  readDatabaseHealth,
  reclaimFreelist,
  recoverPendingFtsRebuild,
  type DiskSpaceProbe,
  type ReclaimPolicy,
} from "./maintenance.js";
import {
  SCHEMA_VERSION,
  SEARCH_TEXT_INDEX_NAME,
  SEARCH_TEXT_INDEX_SQL,
} from "./schema.js";
import type { SqliteDatabase } from "./shared.js";

const MiB = 1024 * 1024;
const cleanups: Array<() => void> = [];

afterEach(() => {
  while (cleanups.length > 0) {
    try {
      cleanups.pop()?.();
    } catch {
      /* best effort */
    }
  }
});

const asDb = (db: Database) => db as unknown as SqliteDatabase;

const openConnection = (dbPath: string): Database => {
  const db = new Database(dbPath);
  db.exec("PRAGMA busy_timeout = 5000;");
  cleanups.push(() => db.close());
  return db;
};

/**
 * A current-schema database with synthetic chat history (entries, threads,
 * thread summaries — every external-content FTS table has rows), rowid gaps
 * from deletes, and a large freelist left by creating and dropping a table,
 * exactly the shape migration v1 left behind in production. The search-text
 * index is pre-built unless `searchIndex: false`, so the reclaim tests see
 * the reclaim as the only pending heavy step.
 */
const makeFixture = (
  options: { junkMiB?: number; searchIndex?: boolean } = {},
) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "stella-maintenance-"));
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  const dbPath = path.join(dir, "stella.sqlite");
  const db = new Database(dbPath);
  cleanups.push(() => db.close());
  initializeDesktopDatabase(asDb(db));

  const now = Date.now();
  db.prepare(
    "INSERT INTO conversation (id, created_at, updated_at) VALUES ('c1', ?, ?)",
  ).run(now, now);
  const insertEntry = db.prepare(
    `INSERT INTO entry (conversation_id, seq, id, type, role, visible,
       payload, search_text, created_at, updated_at)
     VALUES ('c1', ?, ?, 'user_message', 'user', 1, ?, ?, ?, ?)`,
  );
  const insertThread = db.prepare(
    `INSERT INTO thread (id, conversation_id, agent_type, name, status,
       search_text, created_at, last_used_at)
     VALUES (?, 'c1', 'general', ?, 'completed', ?, ?, ?)`,
  );
  const insertSummary = db.prepare(
    `INSERT INTO durable_thread_summaries (source_key, thread_id, run_id,
       agent_type, content, source_updated_at)
     VALUES (?, ?, ?, 'general', ?, ?)`,
  );
  const words = ["alpha", "bravo", "charlie", "delta"];
  db.transaction(() => {
    for (let seq = 1; seq <= 600; seq += 1) {
      const word = words[seq % words.length];
      insertEntry.run(
        seq,
        `e${seq}`,
        JSON.stringify({ text: `${word} ${"x".repeat(200)}` }),
        `${word} message number ${seq}`,
        now + seq,
        now + seq,
      );
    }
    for (let i = 1; i <= 60; i += 1) {
      const word = words[i % words.length];
      insertThread.run(`t${i}`, `thread ${i}`, `${word} thread ${i}`, now, now);
      insertSummary.run(`s${i}`, `t${i}`, `r${i}`, `${word} summary ${i}`, now);
    }
  })();
  // Rowid gaps: the case where renumbering would actually move rows.
  db.exec("DELETE FROM entry WHERE seq % 3 = 0;");
  db.exec("DELETE FROM thread WHERE CAST(substr(id, 2) AS INTEGER) % 4 = 0;");
  if (options.searchIndex !== false) db.exec(SEARCH_TEXT_INDEX_SQL);

  const junkMiB = options.junkMiB ?? 8;
  db.exec("CREATE TABLE junk (b BLOB);");
  const insertJunk = db.prepare("INSERT INTO junk VALUES (zeroblob(65536))");
  db.transaction(() => {
    for (let i = 0; i < junkMiB * 16; i += 1) insertJunk.run();
  })();
  db.exec("DROP TABLE junk;");
  db.exec("PRAGMA wal_checkpoint(TRUNCATE);");
  return { dir, dbPath, db };
};

const searchEntries = (db: Database, term: string) =>
  (
    db
      .prepare(
        `SELECT entry.id AS id FROM entry_fts
         JOIN entry ON entry.rowid = entry_fts.rowid
         WHERE entry_fts MATCH ? ORDER BY entry.id`,
      )
      .all(term) as Array<{ id: string }>
  ).map((row) => row.id);

const searchThreads = (db: Database, term: string) =>
  (
    db
      .prepare(
        `SELECT thread.id AS id FROM thread_fts
         JOIN thread ON thread.rowid = thread_fts.rowid
         WHERE thread_fts MATCH ? ORDER BY thread.id`,
      )
      .all(term) as Array<{ id: string }>
  ).map((row) => row.id);

const searchSummaries = (db: Database, term: string) =>
  (
    db
      .prepare(
        `SELECT s.source_key AS id FROM durable_thread_summaries_fts f
         JOIN durable_thread_summaries s ON s.id = f.rowid
         WHERE durable_thread_summaries_fts MATCH ? ORDER BY s.source_key`,
      )
      .all(term) as Array<{ id: string }>
  ).map((row) => row.id);

const snapshotSearches = (db: Database) => ({
  entries: searchEntries(db, "bravo"),
  entriesByNumber: searchEntries(db, "400"),
  threads: searchThreads(db, "charlie"),
  summaries: searchSummaries(db, "delta"),
});

/** FTS5 content-consistency check; throws SQLITE_CORRUPT_VTAB on mismatch. */
const assertFtsConsistent = (db: Database) => {
  for (const table of [
    "entry_fts",
    "thread_fts",
    "durable_thread_summaries_fts",
  ]) {
    db.exec(`INSERT INTO ${table}(${table}, rank) VALUES ('integrity-check', 1);`);
  }
};

const plentyOfDisk: DiskSpaceProbe = () => ({
  freeBytes: 1024 * 1024 * MiB,
  device: 1,
});

const policy = (overrides: Partial<ReclaimPolicy> = {}): ReclaimPolicy => ({
  minFreelistBytes: 1 * MiB,
  minFreelistRatio: 0.25,
  diskHeadroomBytes: 1 * MiB,
  busyTimeoutMs: 50,
  checkpointBusyTimeoutMs: 0,
  diskSpace: plentyOfDisk,
  tempDirectory: os.tmpdir(),
  ...overrides,
});

const readMeta = (db: Database, key: string) =>
  (db.prepare("SELECT value FROM meta WHERE key = ?").get(key) as {
    value: string;
  } | null)?.value ?? null;

const captureLogger = () => {
  const events: Array<{ level: string; event: string; fields?: unknown }> = [];
  return {
    events,
    logger: {
      process: (event: string, fields?: Record<string, unknown>) =>
        events.push({ level: "process", event, fields }),
      warn: (event: string, fields?: Record<string, unknown>) =>
        events.push({ level: "warn", event, fields }),
    },
  };
};

describe("storage maintenance: freelist reclaim", () => {
  test("fixture has a large freelist", () => {
    const { db, dbPath } = makeFixture();
    const health = readDatabaseHealth(asDb(db), dbPath);
    expect(health.freelistBytes).toBeGreaterThan(7 * MiB);
    expect(health.freelistBytes / (health.pageCount * health.pageSize)).toBeGreaterThan(0.5);
  });

  test("VACUUM + FTS rebuild shrinks the file and search still returns the same rows", () => {
    const { db, dbPath } = makeFixture();
    const before = snapshotSearches(db);
    expect(before.entries.length).toBeGreaterThan(50);
    expect(before.entriesByNumber).toEqual(["e400"]);
    expect(before.threads.length).toBeGreaterThan(5);
    expect(before.summaries.length).toBeGreaterThan(5);
    const fileBefore = fs.statSync(dbPath).size;

    const conn = openConnection(dbPath);
    const outcome = reclaimFreelist(asDb(conn), dbPath, policy());

    expect(outcome.status).toBe("reclaimed");
    if (outcome.status !== "reclaimed") return;
    expect(outcome.rebuiltIndexes).toEqual([
      "entry_fts",
      "thread_fts",
      "durable_thread_summaries_fts",
    ]);
    expect(outcome.finalCheckpointBusy).toBe(false);
    expect(outcome.after.freelistBytes).toBeLessThan(64 * 1024);
    expect(fs.statSync(dbPath).size).toBeLessThan(fileBefore / 2);
    expect(outcome.after.walBytes).toBe(0);
    // The critical assertion: identical hits through the rowid join.
    expect(snapshotSearches(db)).toEqual(before);
    assertFtsConsistent(db);
    expect(readMeta(db, MAINTENANCE_META_KEYS.freelistReclaimed)).not.toBeNull();
    expect(readMeta(db, MAINTENANCE_META_KEYS.ftsRebuildPending)).toBeNull();
  });

  test("rebuild repairs FTS when VACUUM renumbers content rowids", () => {
    const { db, dbPath } = makeFixture();
    const before = snapshotSearches(db);
    const conn = openConnection(dbPath);
    let staleDuringWindow: string[] | null = null;

    const outcome = reclaimFreelist(
      asDb(conn),
      dbPath,
      policy({
        // What SQLite is documented to be allowed to do to tables without an
        // INTEGER PRIMARY KEY: move every rowid. No FTS trigger fires.
        vacuum: (c) => {
          c.exec("VACUUM;");
          c.exec("UPDATE entry SET rowid = rowid + 100000;");
          c.exec("UPDATE thread SET rowid = rowid + 100000;");
          staleDuringWindow = searchEntries(db, "bravo");
        },
      }),
    );

    expect(outcome.status).toBe("reclaimed");
    // Without the rebuild the index points at rowids that no longer exist.
    expect(staleDuringWindow).toEqual([]);
    expect(snapshotSearches(db)).toEqual(before);
    assertFtsConsistent(db);
  });

  test("disk-space guard skips without touching the file or meta", () => {
    const { db, dbPath } = makeFixture();
    const health = readDatabaseHealth(asDb(db), dbPath);
    const conn = openConnection(dbPath);

    const outcome = reclaimFreelist(
      asDb(conn),
      dbPath,
      policy({
        diskSpace: () => ({ freeBytes: health.liveBytes, device: 1 }),
      }),
    );

    expect(outcome.status).toBe("skipped");
    if (outcome.status !== "skipped") return;
    expect(outcome.reason).toBe("insufficient-disk");
    expect(outcome.detail.requiredBytes).toBe(2 * health.liveBytes + 1 * MiB);
    expect(readDatabaseHealth(asDb(db), dbPath).freelistCount).toBe(
      health.freelistCount,
    );
    expect(readMeta(db, MAINTENANCE_META_KEYS.freelistReclaimed)).toBeNull();
    expect(readMeta(db, MAINTENANCE_META_KEYS.ftsRebuildPending)).toBeNull();
  });

  test("disk-space guard checks the temp volume separately when it differs", () => {
    const health = {
      pageSize: 4096,
      pageCount: 0,
      freelistCount: 0,
      fileBytes: 0,
      freelistBytes: 0,
      liveBytes: 100,
      walBytes: 0,
    };
    const probe =
      (dbFree: number, tmpFree: number): DiskSpaceProbe =>
      (dir) =>
        dir === "/tmp-volume"
          ? { freeBytes: tmpFree, device: 2 }
          : { freeBytes: dbFree, device: 1 };
    const args = { diskHeadroomBytes: 10, tempDirectory: "/tmp-volume" };
    expect(
      checkReclaimDiskSpace(health, "/data/stella.sqlite", {
        ...args,
        diskSpace: probe(110, 110),
      }).ok,
    ).toBe(true);
    expect(
      checkReclaimDiskSpace(health, "/data/stella.sqlite", {
        ...args,
        diskSpace: probe(110, 50),
      }).ok,
    ).toBe(false);
  });

  test("below-threshold freelist is left alone", () => {
    const { db, dbPath } = makeFixture({ junkMiB: 1 });
    const conn = openConnection(dbPath);
    const outcome = reclaimFreelist(
      asDb(conn),
      dbPath,
      policy({ minFreelistBytes: 64 * MiB }),
    );
    expect(outcome).toMatchObject({ status: "skipped", reason: "below-threshold" });
    expect(readDatabaseHealth(asDb(db), dbPath).freelistCount).toBeGreaterThan(0);
  });

  test("the meta row prevents a second reclaim", () => {
    const { db, dbPath } = makeFixture();
    const conn = openConnection(dbPath);
    expect(reclaimFreelist(asDb(conn), dbPath, policy()).status).toBe("reclaimed");

    db.exec("CREATE TABLE junk2 (b BLOB);");
    db.exec(
      "WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 128) INSERT INTO junk2 SELECT zeroblob(65536) FROM n;",
    );
    db.exec("DROP TABLE junk2;");
    const health = readDatabaseHealth(asDb(db), dbPath);
    expect(health.freelistBytes).toBeGreaterThan(7 * MiB);

    expect(reclaimFreelist(asDb(conn), dbPath, policy())).toMatchObject({
      status: "skipped",
      reason: "already-done",
    });
    expect(readDatabaseHealth(asDb(db), dbPath).freelistCount).toBe(
      health.freelistCount,
    );
  });
});

describe("storage maintenance: concurrency with other writers", () => {
  test("an open write transaction on another connection defers, never fails", () => {
    const { db, dbPath } = makeFixture();
    const other = openConnection(dbPath);
    other.exec("BEGIN IMMEDIATE;");
    other.exec("INSERT INTO settings (key, value, updated_at) VALUES ('k', 'v', 1);");

    const conn = openConnection(dbPath);
    const outcome = reclaimFreelist(asDb(conn), dbPath, policy());
    expect(outcome).toMatchObject({ status: "deferred", reason: "busy" });

    other.exec("COMMIT;");
    expect(reclaimFreelist(asDb(conn), dbPath, policy()).status).toBe("reclaimed");
    expect(
      (db.prepare("SELECT value FROM settings WHERE key = 'k'").get() as {
        value: string;
      }).value,
    ).toBe("v");
  });

  test("BUSY on VACUUM itself defers and leaves FTS intact", () => {
    const { db, dbPath } = makeFixture();
    const before = snapshotSearches(db);
    const other = openConnection(dbPath);
    const conn = openConnection(dbPath);

    const outcome = reclaimFreelist(
      asDb(conn),
      dbPath,
      policy({
        vacuum: (c) => {
          // Another process grabs the write lock between the pre-checkpoint
          // and VACUUM.
          other.exec("BEGIN IMMEDIATE;");
          c.exec("VACUUM;");
        },
      }),
    );
    other.exec("ROLLBACK;");

    expect(outcome).toMatchObject({
      status: "deferred",
      reason: "busy",
      step: "vacuum",
    });
    expect(readMeta(db, MAINTENANCE_META_KEYS.freelistReclaimed)).toBeNull();
    expect(snapshotSearches(db)).toEqual(before);
    // The other writer still held the lock, so the marker could not be
    // cleared; the next idle tick pays one harmless rebuild and clears it.
    expect(readMeta(db, MAINTENANCE_META_KEYS.ftsRebuildPending)).toBe("vacuum");
    expect(recoverPendingFtsRebuild(asDb(conn))).toHaveLength(3);
    expect(readMeta(db, MAINTENANCE_META_KEYS.ftsRebuildPending)).toBeNull();
    expect(snapshotSearches(db)).toEqual(before);
    expect(reclaimFreelist(asDb(conn), dbPath, policy()).status).toBe("reclaimed");
  });

  test("a reader on an old snapshot does not block VACUUM; the shrink lands at a later checkpoint", () => {
    const { db, dbPath } = makeFixture();
    const reader = openConnection(dbPath);
    reader.exec("BEGIN;");
    const countBefore = reader.prepare("SELECT count(*) AS n FROM entry").get();

    const conn = openConnection(dbPath);
    const fileBefore = fs.statSync(dbPath).size;
    const outcome = reclaimFreelist(asDb(conn), dbPath, policy());
    expect(outcome).toMatchObject({
      status: "reclaimed",
      finalCheckpointBusy: true,
    });
    // The reader keeps its consistent snapshot throughout.
    expect(reader.prepare("SELECT count(*) AS n FROM entry").get()).toEqual(
      countBefore,
    );
    expect(fs.statSync(dbPath).size).toBe(fileBefore);

    reader.exec("COMMIT;");
    expect(checkpointWal(asDb(conn), "TRUNCATE").busy).toBe(false);
    expect(fs.statSync(dbPath).size).toBeLessThan(fileBefore / 2);
    expect(snapshotSearches(db).entriesByNumber).toEqual(["e400"]);
  });
});

describe("storage maintenance: checkpoint and ANALYZE", () => {
  test("TRUNCATE checkpoint empties a grown WAL", () => {
    const { dbPath } = makeFixture();
    const writer = openConnection(dbPath);
    writer.exec("PRAGMA wal_autocheckpoint = 0;");
    writer.exec("CREATE TABLE wal_growth (b BLOB);");
    writer.exec(
      "WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 64) INSERT INTO wal_growth SELECT zeroblob(65536) FROM n;",
    );
    expect(fs.statSync(`${dbPath}-wal`).size).toBeGreaterThan(4 * MiB);

    const conn = openConnection(dbPath);
    const result = checkpointWal(asDb(conn), "TRUNCATE");
    expect(result.busy).toBe(false);
    expect(fs.statSync(`${dbPath}-wal`).size).toBe(0);
  });

  test("ANALYZE runs once per schema version", () => {
    const { db, dbPath } = makeFixture();
    const conn = openConnection(dbPath);
    expect(analyzeOncePerSchemaVersion(asDb(conn))).toBe(true);
    expect(
      db.prepare("SELECT count(*) AS n FROM sqlite_stat1").get(),
    ).toMatchObject({ n: expect.any(Number) });
    expect(readMeta(db, MAINTENANCE_META_KEYS.analyzedSchemaVersion)).toBe(
      String(SCHEMA_VERSION),
    );
    expect(analyzeOncePerSchemaVersion(asDb(conn))).toBe(false);
  });
});

describe("storage maintenance: idle scheduler", () => {
  const makeScheduler = (
    fixture: ReturnType<typeof makeFixture>,
    overrides: Partial<ConstructorParameters<typeof DatabaseMaintenance>[0]> = {},
  ) => {
    const { events, logger } = captureLogger();
    const maintenance = new DatabaseMaintenance({
      db: asDb(fixture.db),
      databasePath: fixture.dbPath,
      logger,
      diskSpace: plentyOfDisk,
      intervalMs: 60 * 60 * 1000,
      analyzeIdleTicks: 2,
      reclaimIdleTicks: 3,
      reclaimMinFreelistBytes: 1 * MiB,
      reclaimDiskHeadroomBytes: 1 * MiB,
      walTruncateBytes: 1 * MiB,
      ...overrides,
    });
    cleanups.push(() => maintenance.stop());
    return { maintenance, events };
  };

  test("does nothing while busy; idle streak runs optimize, analyze, then reclaim", () => {
    const fixture = makeFixture();
    const before = snapshotSearches(fixture.db);
    const { maintenance, events } = makeScheduler(fixture);
    let idle = false;
    maintenance.start({ isIdle: () => idle, attachedClientCount: () => 0 });

    maintenance.runIdleTick();
    maintenance.runIdleTick();
    expect(events).toEqual([]);

    idle = true;
    maintenance.runIdleTick(); // streak 1: health + boot optimize
    maintenance.runIdleTick(); // streak 2: analyze
    idle = false;
    maintenance.runIdleTick(); // streak reset
    idle = true;
    maintenance.runIdleTick(); // streak 1
    maintenance.runIdleTick(); // streak 2
    expect(events.map((e) => e.event)).toEqual([
      "storage.maintenance.health",
      "storage.maintenance.optimize",
      "storage.maintenance.run-event-sweep-drained",
      "storage.maintenance.analyze",
    ]);
    maintenance.runIdleTick(); // streak 3: reclaim
    expect(events.at(-1)?.event).toBe("storage.maintenance.reclaim");
    expect(events.some((e) => e.level === "warn")).toBe(false);
    expect(snapshotSearches(fixture.db)).toEqual(before);

    maintenance.runIdleTick();
    maintenance.runIdleTick();
    expect(events.at(-1)?.event).toBe("storage.maintenance.reclaim");

    maintenance.stop();
    expect(events.at(-1)).toMatchObject({
      event: "storage.maintenance.optimize",
      fields: { phase: "close", busy: false },
    });
    maintenance.runIdleTick();
    expect(events.at(-1)?.event).toBe("storage.maintenance.optimize");
  });

  test("idle ticks TRUNCATE a WAL over the threshold", () => {
    const fixture = makeFixture();
    const writer = openConnection(fixture.dbPath);
    writer.exec("PRAGMA wal_autocheckpoint = 0;");
    writer.exec("CREATE TABLE wal_growth (b BLOB);");
    writer.exec(
      "WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 64) INSERT INTO wal_growth SELECT zeroblob(65536) FROM n;",
    );
    const { maintenance, events } = makeScheduler(fixture, {
      reclaimIdleTicks: 99,
      analyzeIdleTicks: 99,
    });
    maintenance.start({ isIdle: () => true, attachedClientCount: () => 0 });
    maintenance.runIdleTick();
    const checkpoint = events.find(
      (e) => e.event === "storage.maintenance.checkpoint",
    );
    expect(checkpoint?.fields).toMatchObject({ mode: "TRUNCATE", busy: false, walBytesAfter: 0 });
  });

  test("a concurrent writer makes the reclaim tick defer quietly and retry later", () => {
    const fixture = makeFixture();
    const other = openConnection(fixture.dbPath);
    const { maintenance, events } = makeScheduler(fixture, {
      analyzeIdleTicks: 99,
      reclaimIdleTicks: 1,
      busyTimeoutMs: 20,
    });
    maintenance.start({ isIdle: () => true, attachedClientCount: () => 0 });
    other.exec("BEGIN IMMEDIATE;");
    maintenance.runIdleTick();
    maintenance.runIdleTick();
    other.exec("COMMIT;");
    expect(events.some((e) => e.level === "warn")).toBe(false);
    expect(
      events.filter((e) => e.event === "storage.maintenance.deferred"),
    ).toHaveLength(1);
    maintenance.runIdleTick();
    expect(events.at(-1)?.event).toBe("storage.maintenance.reclaim");
  });

  test("a pending marker from an interrupted reclaim is repaired on the next idle tick", () => {
    const fixture = makeFixture();
    const before = snapshotSearches(fixture.db);
    // Simulate: VACUUM moved rowids, then the process died before rebuild.
    fixture.db.exec("UPDATE entry SET rowid = rowid + 100000;");
    fixture.db.exec(
      `INSERT INTO meta (key, value, updated_at) VALUES ('${MAINTENANCE_META_KEYS.ftsRebuildPending}', 'vacuum', 0);`,
    );
    expect(searchEntries(fixture.db, "bravo")).toEqual([]);

    const { maintenance, events } = makeScheduler(fixture, {
      reclaimIdleTicks: 99,
      analyzeIdleTicks: 99,
    });
    maintenance.start({ isIdle: () => true, attachedClientCount: () => 0 });
    maintenance.runIdleTick();
    expect(events.map((e) => e.event)).toContain("storage.maintenance.fts-rebuild");
    expect(snapshotSearches(fixture.db)).toEqual(before);
    expect(readMeta(fixture.db, MAINTENANCE_META_KEYS.ftsRebuildPending)).toBeNull();
  });

  const insertRunEvents = (db: Database, count: number) => {
    const insert = db.prepare(
      `INSERT INTO entry (conversation_id, seq, id, type, role, payload,
         created_at, updated_at)
       VALUES ('c1', ?, ?, 'run_event', 'system', '{}', 1, 1)`,
    );
    db.transaction(() => {
      for (let i = 0; i < count; i += 1) insert.run(100_000 + i, `re${i}`);
    })();
  };
  const countRunEvents = (db: Database) =>
    (
      db
        .prepare("SELECT count(*) AS n FROM entry WHERE type = 'run_event'")
        .get() as { n: number }
    ).n;

  test("reclaim waits while a client is attached and runs once detached", () => {
    const fixture = makeFixture();
    const before = snapshotSearches(fixture.db);
    const { maintenance, events } = makeScheduler(fixture, {
      analyzeIdleTicks: 99,
      reclaimIdleTicks: 1,
    });
    let clients = 1;
    maintenance.start({ isIdle: () => true, attachedClientCount: () => clients });

    for (let i = 0; i < 3; i += 1) maintenance.runIdleTick();
    expect(events.map((e) => e.event)).toContain("storage.maintenance.reclaim-waiting");
    expect(events.map((e) => e.event)).not.toContain("storage.maintenance.reclaim");
    expect(readMeta(fixture.db, MAINTENANCE_META_KEYS.freelistReclaimed)).toBeNull();
    // Attached: never pins the worker.
    expect(maintenance.holdsWorkerAlive()).toBe(false);

    clients = 0;
    // Detached with the reclaim ready: pins idle shutdown until it runs.
    expect(maintenance.holdsWorkerAlive()).toBe(true);
    maintenance.runIdleTick();
    expect(events.at(-1)?.event).toBe("storage.maintenance.reclaim");
    expect(maintenance.holdsWorkerAlive()).toBe(false);
    expect(snapshotSearches(fixture.db)).toEqual(before);
  });

  test("reclaim is not eligible until the run_event sweep reports drained", () => {
    const fixture = makeFixture();
    insertRunEvents(fixture.db, 45);
    // A clock that jumps 10 s per read: every batch exhausts the budget, so
    // each tick runs exactly one batch.
    let clock = 0;
    const { maintenance, events } = makeScheduler(fixture, {
      analyzeIdleTicks: 99,
      reclaimIdleTicks: 1,
      sweepBatchSize: 20,
      now: () => (clock += 10_000),
    });
    maintenance.start({ isIdle: () => true, attachedClientCount: () => 0 });

    const reclaimed = () =>
      readMeta(fixture.db, MAINTENANCE_META_KEYS.freelistReclaimed) !== null;
    maintenance.runIdleTick(); // deletes 20
    expect(countRunEvents(fixture.db)).toBe(25);
    maintenance.runIdleTick(); // deletes 20 (resumed)
    maintenance.runIdleTick(); // deletes 5; resumed batch ends: not yet proof
    expect(countRunEvents(fixture.db)).toBe(0);
    expect(reclaimed()).toBe(false);
    expect(
      readMeta(fixture.db, MAINTENANCE_META_KEYS.runEventSweepDrained),
    ).toBeNull();
    maintenance.runIdleTick(); // full walk from the start finds nothing: drained
    expect(
      readMeta(fixture.db, MAINTENANCE_META_KEYS.runEventSweepDrained),
    ).not.toBeNull();
    expect(reclaimed()).toBe(true);
    expect(events.filter((e) => e.event === "storage.maintenance.run-event-sweep")).toHaveLength(3);
  });

  test("STELLA_DB_RECLAIM=0 disables only the reclaim", () => {
    const fixture = makeFixture();
    insertRunEvents(fixture.db, 5);
    const previous = process.env.STELLA_DB_RECLAIM;
    process.env.STELLA_DB_RECLAIM = "0";
    try {
      const { maintenance, events } = makeScheduler(fixture, {
        reclaimIdleTicks: 1,
      });
      maintenance.start({ isIdle: () => true, attachedClientCount: () => 0 });
      for (let i = 0; i < 4; i += 1) maintenance.runIdleTick();
      const names = events.map((e) => e.event);
      expect(names).toContain("storage.maintenance.run-event-sweep-drained");
      expect(names).toContain("storage.maintenance.analyze");
      expect(names).toContain("storage.maintenance.reclaim-skipped");
      expect(names).not.toContain("storage.maintenance.reclaim");
      expect(countRunEvents(fixture.db)).toBe(0);
      expect(maintenance.holdsWorkerAlive()).toBe(false);
      expect(readMeta(fixture.db, MAINTENANCE_META_KEYS.freelistReclaimed)).toBeNull();
    } finally {
      if (previous === undefined) delete process.env.STELLA_DB_RECLAIM;
      else process.env.STELLA_DB_RECLAIM = previous;
    }
  });

  test("idle shutdown is deferred until the detached reclaim has run", async () => {
    const fixture = makeFixture();
    let clients = 1;
    let heldDuringVacuum: boolean | null = null;
    const { maintenance, events } = makeScheduler(fixture, {
      analyzeIdleTicks: 99,
      reclaimIdleTicks: 1,
      vacuum: (c) => {
        heldDuringVacuum = maintenance.holdsWorkerAlive();
        c.exec("VACUUM;");
      },
    });
    maintenance.start({ isIdle: () => true, attachedClientCount: () => clients });
    maintenance.runIdleTick(); // preconditions hold; waiting for detach

    const stellaAppDir = fs.mkdtempSync(path.join(os.tmpdir(), "stella-lifecycle-"));
    cleanups.push(() => fs.rmSync(stellaAppDir, { recursive: true, force: true }));
    // Keep the lifecycle's lock/pid/log files out of the real ~/.stella.
    const previousStateDir = process.env.STELLA_RUNTIME_STATE_DIR;
    process.env.STELLA_RUNTIME_STATE_DIR = path.join(stellaAppDir, "state");
    cleanups.push(() => {
      if (previousStateDir === undefined) {
        delete process.env.STELLA_RUNTIME_STATE_DIR;
      } else {
        process.env.STELLA_RUNTIME_STATE_DIR = previousStateDir;
      }
    });
    const shutdowns: string[] = [];
    const lifecycle = new WorkerLifecycleServer({
      stellaAppDir,
      idleShutdownMs: 10,
      // What entry.ts wires: runtimeServer.hasActiveWork(), whose session
      // part ORs in maintenance.holdsWorkerAlive().
      shouldKeepAlive: () => maintenance.holdsWorkerAlive(),
      onShutdown: (reason) => {
        shutdowns.push(reason);
      },
    });
    const delay = (ms: number) =>
      new Promise((resolve) => setTimeout(resolve, ms));
    try {
      await lifecycle.start();
      lifecycle.noteClientConnected();
      clients = 0;
      lifecycle.noteClientDisconnected();

      await delay(40);
      expect(shutdowns).toEqual([]);

      maintenance.runIdleTick(); // the detached reclaim
      expect(heldDuringVacuum).toBe(true);
      expect(events.at(-1)?.event).toBe("storage.maintenance.reclaim");
      await delay(40);
      expect(shutdowns).toEqual(["idle"]);
    } finally {
      await lifecycle.shutdown("signal");
    }
  });

  test("the sweep runs several batches in one tick within its budget", () => {
    const fixture = makeFixture();
    insertRunEvents(fixture.db, 45);
    const { maintenance, events } = makeScheduler(fixture, {
      analyzeIdleTicks: 99,
      sweepBatchSize: 20,
      sweepBudgetMs: 60_000,
    });
    maintenance.start({ isIdle: () => true, attachedClientCount: () => 1 });
    maintenance.runIdleTick();
    expect(countRunEvents(fixture.db)).toBe(0);
    // 20 + 20 + 5, then the confirming walk from the first conversation.
    expect(events.find((e) => e.event === "storage.maintenance.run-event-sweep")?.fields)
      .toMatchObject({ deleted: 45, batches: 4, drained: true, budgetMs: 60_000 });
    expect(
      readMeta(fixture.db, MAINTENANCE_META_KEYS.runEventSweepDrained),
    ).not.toBeNull();
  });

  test("the sweep stops at its time budget, attached vs detached", () => {
    const run = (clients: number) => {
      const fixture = makeFixture();
      insertRunEvents(fixture.db, 200);
      let clock = 0;
      const { maintenance, events } = makeScheduler(fixture, {
        analyzeIdleTicks: 99,
        sweepBatchSize: 20,
        sweepBudgetMs: 250,
        sweepDetachedBudgetMs: 2_000,
        // Each batch "takes" 100 ms.
        now: () => (clock += 100),
      });
      maintenance.start({ isIdle: () => true, attachedClientCount: () => clients });
      maintenance.runIdleTick();
      return {
        remaining: countRunEvents(fixture.db),
        sweep: events.find((e) => e.event === "storage.maintenance.run-event-sweep")
          ?.fields as { batches: number; budgetMs: number },
      };
    };
    const attached = run(1);
    expect(attached.sweep).toMatchObject({ batches: 3, budgetMs: 250 });
    expect(attached.remaining).toBe(140);
    const detached = run(0);
    expect(detached.sweep.budgetMs).toBe(2_000);
    expect(detached.remaining).toBe(0);
  });

  test("the sweep stops when the idle predicate flips between batches", () => {
    const fixture = makeFixture();
    insertRunEvents(fixture.db, 100);
    const { maintenance, events } = makeScheduler(fixture, {
      analyzeIdleTicks: 99,
      sweepBatchSize: 20,
      sweepBudgetMs: 60_000,
    });
    let idleChecks = 0;
    // Idle at the tick boundary and after the first batch, busy after that.
    maintenance.start({
      isIdle: () => (idleChecks += 1) <= 2,
      attachedClientCount: () => 1,
    });
    maintenance.runIdleTick();
    expect(countRunEvents(fixture.db)).toBe(60);
    expect(events.find((e) => e.event === "storage.maintenance.run-event-sweep")?.fields)
      .toMatchObject({ deleted: 40, batches: 2, drained: false });
  });

  test("detached, the reclaim needs only one idle tick; attached, never", () => {
    const attachedFixture = makeFixture();
    const attached = makeScheduler(attachedFixture, {
      analyzeIdleTicks: 99,
      reclaimIdleTicks: undefined,
    });
    attached.maintenance.start({ isIdle: () => true, attachedClientCount: () => 1 });
    for (let i = 0; i < 12; i += 1) attached.maintenance.runIdleTick();
    expect(attached.events.map((e) => e.event)).not.toContain(
      "storage.maintenance.reclaim",
    );

    const detachedFixture = makeFixture();
    const detached = makeScheduler(detachedFixture, {
      analyzeIdleTicks: 99,
      reclaimIdleTicks: undefined,
    });
    detached.maintenance.start({ isIdle: () => true, attachedClientCount: () => 0 });
    detached.maintenance.runIdleTick();
    expect(detached.events.at(-1)?.event).toBe("storage.maintenance.reclaim");
  });

  const hasSearchIndex = (db: Database) =>
    Boolean(
      db
        .prepare("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = ?")
        .get(SEARCH_TEXT_INDEX_NAME),
    );

  test("search index: built on the first detached idle tick, never while attached, then the reclaim", () => {
    const fixture = makeFixture({ searchIndex: false });
    const before = snapshotSearches(fixture.db);
    const { maintenance, events } = makeScheduler(fixture, {
      analyzeIdleTicks: 99,
      reclaimIdleTicks: 1,
    });
    let clients = 1;
    maintenance.start({ isIdle: () => true, attachedClientCount: () => clients });

    for (let i = 0; i < 4; i += 1) maintenance.runIdleTick();
    const names = () => events.map((e) => e.event);
    expect(names()).toContain("storage.maintenance.search-index-waiting");
    expect(names()).not.toContain("storage.maintenance.search-index");
    expect(hasSearchIndex(fixture.db)).toBe(false);
    expect(maintenance.holdsWorkerAlive()).toBe(false);

    clients = 0;
    expect(maintenance.holdsWorkerAlive()).toBe(true);
    maintenance.runIdleTick(); // the index, and only the index
    expect(events.at(-1)).toMatchObject({
      event: "storage.maintenance.search-index",
      fields: { index: SEARCH_TEXT_INDEX_NAME, ms: expect.any(Number) },
    });
    expect(
      (events.at(-1)?.fields as { indexBytes: number }).indexBytes,
    ).toBeGreaterThan(0);
    expect(hasSearchIndex(fixture.db)).toBe(true);
    expect(
      fixture.db
        .prepare("SELECT stat FROM sqlite_stat1 WHERE idx = ?")
        .get(SEARCH_TEXT_INDEX_NAME),
    ).toMatchObject({ stat: expect.any(String) });
    expect(readMeta(fixture.db, MAINTENANCE_META_KEYS.freelistReclaimed)).toBeNull();
    // The reclaim is still due, so idle shutdown stays pinned.
    expect(maintenance.holdsWorkerAlive()).toBe(true);

    maintenance.runIdleTick(); // the reclaim, which also compacts the index
    expect(events.at(-1)?.event).toBe("storage.maintenance.reclaim");
    expect(maintenance.holdsWorkerAlive()).toBe(false);
    expect(hasSearchIndex(fixture.db)).toBe(true);
    expect(fixture.db.prepare("PRAGMA integrity_check;").get()).toEqual({
      integrity_check: "ok",
    });
    expect(snapshotSearches(fixture.db)).toEqual(before);
    expect(names().filter((e) => e === "storage.maintenance.search-index")).toHaveLength(1);
  });

  test("search index: not rebuilt once present, and built even when no reclaim is due", () => {
    const fixture = makeFixture({ searchIndex: false, junkMiB: 0 });
    let creates = 0;
    const createSearchIndex = (c: SqliteDatabase) => {
      creates += 1;
      c.exec(SEARCH_TEXT_INDEX_SQL);
    };
    const first = makeScheduler(fixture, {
      analyzeIdleTicks: 99,
      reclaimIdleTicks: 1,
      createSearchIndex,
    });
    first.maintenance.start({ isIdle: () => true, attachedClientCount: () => 0 });
    expect(first.maintenance.holdsWorkerAlive()).toBe(false); // nothing seen yet
    first.maintenance.runIdleTick();
    expect(creates).toBe(1);
    expect(first.events.map((e) => e.event)).not.toContain("storage.maintenance.reclaim");
    for (let i = 0; i < 3; i += 1) first.maintenance.runIdleTick();
    expect(creates).toBe(1);
    expect(first.maintenance.holdsWorkerAlive()).toBe(false);
    first.maintenance.stop();

    // A later session finds it in sqlite_master.
    const second = makeScheduler(fixture, {
      analyzeIdleTicks: 99,
      reclaimIdleTicks: 1,
      createSearchIndex,
    });
    second.maintenance.start({ isIdle: () => true, attachedClientCount: () => 0 });
    for (let i = 0; i < 3; i += 1) second.maintenance.runIdleTick();
    expect(creates).toBe(1);
    expect(second.events.map((e) => e.event)).not.toContain(
      "storage.maintenance.search-index",
    );
    expect(second.maintenance.holdsWorkerAlive()).toBe(false);
  });

  test("search index: BUSY defers to the next idle tick and holds the reclaim back", () => {
    const fixture = makeFixture({ searchIndex: false });
    const other = openConnection(fixture.dbPath);
    const { maintenance, events } = makeScheduler(fixture, {
      analyzeIdleTicks: 99,
      reclaimIdleTicks: 1,
      busyTimeoutMs: 20,
    });
    let clients = 1;
    maintenance.start({ isIdle: () => true, attachedClientCount: () => clients });
    maintenance.runIdleTick(); // attached: the sweep drains, the index waits
    clients = 0;
    other.exec("BEGIN IMMEDIATE;");
    maintenance.runIdleTick();
    maintenance.runIdleTick();
    other.exec("COMMIT;");
    expect(events.some((e) => e.level === "warn")).toBe(false);
    expect(
      events.filter(
        (e) =>
          e.event === "storage.maintenance.deferred" &&
          (e.fields as { step?: string }).step === "search-index",
      ),
    ).toHaveLength(1);
    expect(hasSearchIndex(fixture.db)).toBe(false);
    expect(readMeta(fixture.db, MAINTENANCE_META_KEYS.freelistReclaimed)).toBeNull();
    expect(maintenance.holdsWorkerAlive()).toBe(true);

    maintenance.runIdleTick();
    expect(events.at(-1)?.event).toBe("storage.maintenance.search-index");
    maintenance.runIdleTick();
    expect(events.at(-1)?.event).toBe("storage.maintenance.reclaim");
  });

  test("search index: three BUSY deferrals give up for the session and release the reclaim", () => {
    const fixture = makeFixture({ searchIndex: false });
    const { maintenance, events } = makeScheduler(fixture, {
      analyzeIdleTicks: 99,
      reclaimIdleTicks: 1,
      // Another writer takes the lock just for the index build.
      createSearchIndex: () => {
        throw Object.assign(new Error("database is locked"), { code: "SQLITE_BUSY" });
      },
    });
    maintenance.start({ isIdle: () => true, attachedClientCount: () => 0 });
    for (let i = 0; i < 3; i += 1) maintenance.runIdleTick();
    expect(maintenance.holdsWorkerAlive()).toBe(true); // reclaim still due
    maintenance.runIdleTick();
    expect(events.at(-1)?.event).toBe("storage.maintenance.reclaim");
    expect(hasSearchIndex(fixture.db)).toBe(false);
    expect(maintenance.holdsWorkerAlive()).toBe(false);
  });

  test("buildSearchTextIndex covers every search_text row", () => {
    const { db, dbPath } = makeFixture({ searchIndex: false });
    const conn = openConnection(dbPath);
    expect(
      buildSearchTextIndex(asDb(conn), { busyTimeoutMs: 50, analysisLimit: 400 }),
    ).toMatchObject({ status: "built" });
    expect(
      buildSearchTextIndex(asDb(conn), { busyTimeoutMs: 50, analysisLimit: 400 }),
    ).toEqual({ status: "present" });
    const count = (sql: string) => (db.prepare(sql).get() as { n: number }).n;
    expect(
      count(
        `SELECT count(*) AS n FROM entry INDEXED BY ${SEARCH_TEXT_INDEX_NAME} WHERE search_text IS NOT NULL`,
      ),
    ).toBe(count("SELECT count(*) AS n FROM entry NOT INDEXED WHERE search_text IS NOT NULL"));
  });
});
