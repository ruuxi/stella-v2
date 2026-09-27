/**
 * Idle-time maintenance for the desktop database (`stella.sqlite`).
 *
 * The file is shared over WAL by four connections in three processes (this
 * worker, Electron main's chat-history service, the Electron cloud-cache
 * thread, the host's connector outbox). Nothing else ever checkpoints,
 * analyzes or vacuums it, so this module owns all of that, from the worker —
 * the process that owns the database lifetime (`worker/server/session/storage.ts`).
 *
 * Scheduling. One fixed-rate fiber (`forkFixedRateFiber`, the run-event-log
 * sweep idiom) ticks every `intervalMs`. A tick does nothing unless the
 * caller's `isIdle()` holds — the worker wires the same `hasActiveWork`
 * signal the idle-shutdown logic uses (no orchestrator run, no agents, no
 * in-flight RPC handler, no voice/user-app work). Consecutive idle ticks form
 * an idle streak; heavier steps need a longer streak, and a tick runs at most
 * one heavy step:
 *   - every idle tick: `wal_checkpoint(PASSIVE)`, or `TRUNCATE` once the WAL
 *     file exceeds `walTruncateBytes` (the WAL never shrinks on its own);
 *   - every idle tick, until drained: `deleteLegacyRunEventBatch` batches
 *     (entry-retention.ts, <= 5k rows, one immediate transaction each) over
 *     the unread legacy `run_event` rows, for up to 250 ms per tick with a
 *     client attached or 2 s with none, stopping early if the idle
 *     predicate flips between batches; drained is recorded in `meta`.
 *     The budget is checked after each batch, so one tick can overrun it by
 *     at most one batch. Drain estimate for prod's ~1.56 M rows: a 5k batch
 *     measured ~60 ms p50 / ~200 ms max on a prod-shaped fixture, so ~4
 *     batches (~20k rows) per attached idle minute → ~80–90 idle minutes
 *     attached, or ~10 detached ticks (~165k rows each) — versus ~5 idle
 *     hours at one batch per tick;
 *   - streak >= analyzeIdleTicks: one bounded `ANALYZE` per schema version
 *     (meta-guarded), so the planner finally has `sqlite_stat1`;
 *   - zero RPC clients attached AND streak >= reclaimIdleTicks, while
 *     `idx_entry_search_conv_created` is missing: build recall's covering
 *     index (`SEARCH_TEXT_INDEX_SQL`, below) — before the reclaim, so the
 *     VACUUM that follows also compacts it;
 *   - the run_event sweep drained (deleted rows only return space through
 *     VACUUM) AND zero RPC clients attached AND streak >= reclaimIdleTicks
 *     (default 1 — the long streak only ever protected an attached
 *     Electron, and the reclaim never runs attached): the one-time freelist
 *     reclaim (below). Its cheap preconditions are evaluated on every idle
 *     tick while attached, so the idle-shutdown hold is in place at quit.
 * `PRAGMA optimize` runs on the worker's own connection once on the first
 * idle tick and again at shutdown (`stop()`), per SQLite's guidance for
 * long-lived connections.
 *
 * Every statement here is synchronous (bun:sqlite), so a tick can never
 * interleave with a turn's writes on this thread, and `stop()` — also
 * synchronous — cannot race an in-flight tick: cancelling the fiber IS the
 * join. Other processes are handled with SQLITE_BUSY: maintenance uses its
 * own connection with a short busy timeout, and BUSY is always "try again
 * next idle window", never an error.
 *
 * One-time reclaim. Migration v1 dropped the legacy tables without a VACUUM,
 * leaving most of the file on the freelist. When the freelist exceeds both
 * `reclaimMinFreelistBytes` and `reclaimMinFreelistRatio` of the file, and
 * statfs shows room for VACUUM's two transient copies (the temp database and,
 * in WAL mode, a WAL as large as the result), the reclaim runs:
 *   TRUNCATE checkpoint → mark `fts_rebuild_pending` → VACUUM →
 *   rebuild every external-content FTS index + record completion (one tx) →
 *   TRUNCATE checkpoint (this is what actually shrinks the file).
 * The rebuild is mandatory: `entry` and `thread` have no INTEGER PRIMARY KEY,
 * and SQLite documents that VACUUM may change such rowids, which would point
 * the external-content FTS rows at the wrong content. The pending marker makes
 * a crash between VACUUM and rebuild self-healing on the next idle tick.
 *
 * Why not `auto_vacuum = INCREMENTAL`: switching an existing database to it
 * requires a full VACUUM anyway (the one-time cost this module pays once),
 * and incremental vacuum only moves free pages to the end of the file — it
 * never defragments, so a long-lived chat log fragments steadily while paying
 * pointer-map overhead on every write.
 *
 * The detached window. VACUUM holds the write lock for its whole duration
 * (minutes on a multi-GiB file) and blocks this worker's event loop (the
 * driver is synchronous). With Electron attached that would stall the user's
 * next message and fail Electron-main / cloud-cache writes past their 5s
 * busy_timeout, so the reclaim only starts when the peer broker reports zero
 * attached clients (`WorkerPeerBroker.attachedCount`, the same attach/detach
 * events the lifecycle server's idle-shutdown counts). That is the worker's
 * pre-idle-shutdown window: Electron is gone, there are no other writers, and
 * blocking our own loop is harmless. Once the preconditions have held on an
 * idle tick, `holdsWorkerAlive()` is ORed into `hasActiveWork`, so the
 * lifecycle's `shouldKeepAlive` postpones idle shutdown until the next tick
 * has run the reclaim (the VACUUM itself is synchronous, so no timer can
 * fire mid-VACUUM). Three BUSY deferrals end the hold for the session.
 * Worst-case post-quit linger, once per database: one tick (<= 60 s) +
 * VACUUM + FTS rebuild + final checkpoint — about 5–7 minutes for the
 * 13.3 GiB prod file (~6 GiB live).
 *
 * The search-text index. Recall's covering partial index is not in the
 * schema or a migration: building it is one full `entry` scan through every
 * row's payload overflow chain (~6 s warm, ~15–20 s cold on the 13 GiB prod
 * file) holding the write lock, which at open would freeze Electron main
 * (it migrates synchronously) and fail other writers' 5 s busy timeout. So
 * it is built here, in the same detached window as the reclaim, with the
 * same treatment: `holdsWorkerAlive()` pins idle shutdown while it is
 * missing and no client is attached, BUSY defers to the next idle tick,
 * three deferrals give up for the session. `CREATE INDEX` and
 * `ANALYZE idx_entry_search_conv_created` commit in one transaction: with
 * `sqlite_stat1` rows for the other `entry` indexes but none for this one,
 * the planner would pick it for the latest-visible-message lookup over
 * `idx_entry_conv_visible_seq`. The index is ~14 MB on prod, so it needs no
 * disk check. Queries never force it (no `INDEXED BY`); without it they
 * return the same rows, slower. Presence is read from `sqlite_master`.
 * This adds, once per database, one tick plus the build to the post-quit
 * linger below.
 *
 * Kill switch: `STELLA_DB_RECLAIM=0` disables only the reclaim; checkpoint,
 * optimize, ANALYZE and the run_event sweep keep running.
 *
 * Killed mid-VACUUM (e.g. Electron reattaches, the host's attach times out,
 * and its kill ladder SIGTERMs then SIGKILLs the worker — the SIGTERM handler
 * cannot run while VACUUM blocks the loop): VACUUM is one write transaction.
 * In WAL mode its pages go to the WAL and the commit frame is written last,
 * so a SIGKILL before commit leaves the main file untouched and recovery
 * ignores the uncommitted frames; the temp database is an unlinked-on-open
 * (unix) / delete-on-close (Windows) file, so nothing is left behind.
 * Verified by SIGKILLing a VACUUM on a 200 MiB fixture: integrity_check ok,
 * freelist unchanged, `freelist_reclaim_v1` unset. The `fts_rebuild_pending`
 * marker, committed before VACUUM began, survives; the next idle tick
 * rebuilds the FTS indexes (harmless — rowids never moved) and clears it,
 * and the reclaim retries in a later detached window.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getFileLogger } from "../../observability/file-logger.js";
import { openSqliteConnection } from "./database.js";
import { forkFixedRateFiber } from "./effect-runtime.js";
import { deleteLegacyRunEventBatch } from "./entry-retention.js";
import {
  EXTERNAL_CONTENT_FTS_TABLES,
  SCHEMA_VERSION,
  SEARCH_TEXT_INDEX_NAME,
  SEARCH_TEXT_INDEX_SQL,
  rebuildFtsIndexSql,
} from "./schema.js";
import type { SqliteDatabase } from "./shared.js";

const MiB = 1024 * 1024;
const GiB = 1024 * MiB;

export type MaintenanceSettings = {
  intervalMs: number;
  walTruncateBytes: number;
  analyzeIdleTicks: number;
  /** Idle ticks before the reclaim starts; it only ever runs detached. */
  reclaimIdleTicks: number;
  /** Per-tick time budget for the run_event sweep with a client attached. */
  sweepBudgetMs: number;
  /** Per-tick sweep budget with zero clients (nobody waits on the loop). */
  sweepDetachedBudgetMs: number;
  reclaimMinFreelistBytes: number;
  reclaimMinFreelistRatio: number;
  reclaimDiskHeadroomBytes: number;
  busyTimeoutMs: number;
  checkpointBusyTimeoutMs: number;
  analysisLimit: number;
};

export const MAINTENANCE_DEFAULTS: Readonly<MaintenanceSettings> = {
  intervalMs: 60_000,
  walTruncateBytes: 64 * MiB,
  analyzeIdleTicks: 2,
  reclaimIdleTicks: 1,
  sweepBudgetMs: 250,
  sweepDetachedBudgetMs: 2_000,
  reclaimMinFreelistBytes: 512 * MiB,
  reclaimMinFreelistRatio: 0.25,
  reclaimDiskHeadroomBytes: 1 * GiB,
  /** Lock-acquisition retry window (SQLite's busy handler) for heavy steps. */
  busyTimeoutMs: 2_000,
  /** Checkpoints must not park the event loop waiting on readers. */
  checkpointBusyTimeoutMs: 100,
  /** Rows sampled per index by ANALYZE / optimize (SQLite recommends 100–1000). */
  analysisLimit: 400,
};

export const MAINTENANCE_META_KEYS = {
  analyzedSchemaVersion: "maintenance.analyze_schema_version",
  freelistReclaimed: "maintenance.freelist_reclaim_v1",
  ftsRebuildPending: "maintenance.fts_rebuild_pending",
  runEventSweepDrained: "maintenance.run_event_sweep_drained",
} as const;

export type MaintenanceLogger = {
  process(event: string, fields?: Record<string, unknown>): void;
  warn(event: string, fields?: Record<string, unknown>): void;
};

export type DiskSpace = { freeBytes: number; device: number };
export type DiskSpaceProbe = (directory: string) => DiskSpace | null;

export type DatabaseHealth = {
  pageSize: number;
  pageCount: number;
  freelistCount: number;
  fileBytes: number;
  freelistBytes: number;
  liveBytes: number;
  walBytes: number;
};

export type CheckpointMode = "PASSIVE" | "TRUNCATE";

export type CheckpointResult = {
  mode: CheckpointMode;
  busy: boolean;
  walFrames: number;
  checkpointedFrames: number;
};

export type ReclaimOutcome =
  | {
      status: "reclaimed";
      before: DatabaseHealth;
      after: DatabaseHealth;
      rebuiltIndexes: string[];
      vacuumMs: number;
      rebuildMs: number;
      finalCheckpointBusy: boolean;
    }
  | {
      status: "deferred";
      reason: "busy";
      step: "checkpoint" | "mark-pending" | "vacuum" | "fts-rebuild";
    }
  | {
      status: "skipped";
      reason: "already-done" | "below-threshold" | "insufficient-disk";
      detail: Record<string, unknown>;
    };

export type SearchIndexOutcome =
  | { status: "built"; ms: number; indexBytes: number }
  | { status: "present" }
  | { status: "deferred"; reason: "busy" };

export type ReclaimPolicy = {
  minFreelistBytes: number;
  minFreelistRatio: number;
  diskHeadroomBytes: number;
  busyTimeoutMs: number;
  checkpointBusyTimeoutMs: number;
  diskSpace: DiskSpaceProbe;
  tempDirectory: string;
  /** Test seam: the default runs `VACUUM`. */
  vacuum?: (connection: SqliteDatabase) => void;
};

// ---------------------------------------------------------------------------
// Primitives (exported for tests)
// ---------------------------------------------------------------------------

export const isSqliteBusyError = (error: unknown): boolean => {
  const code = (error as { code?: unknown } | null)?.code;
  if (typeof code === "string" && /SQLITE_(BUSY|LOCKED)/.test(code)) {
    return true;
  }
  const message =
    error instanceof Error ? error.message : String(error ?? "");
  return /\b(database is locked|database table is locked|busy)\b/i.test(
    message,
  );
};

const firstColumn = (row: unknown): unknown =>
  row && typeof row === "object" ? Object.values(row)[0] : undefined;

const pragmaNumber = (db: SqliteDatabase, pragma: string): number => {
  const value = Number(firstColumn(db.prepare(`PRAGMA ${pragma};`).get()));
  return Number.isFinite(value) ? value : 0;
};

const fileSize = (filePath: string): number => {
  try {
    return fs.statSync(filePath).size;
  } catch {
    return 0;
  }
};

export const walPathFor = (databasePath: string): string =>
  `${databasePath}-wal`;

export const readDatabaseHealth = (
  db: SqliteDatabase,
  databasePath: string,
): DatabaseHealth => {
  const pageSize = pragmaNumber(db, "page_size");
  const pageCount = pragmaNumber(db, "page_count");
  const freelistCount = pragmaNumber(db, "freelist_count");
  return {
    pageSize,
    pageCount,
    freelistCount,
    fileBytes: fileSize(databasePath),
    freelistBytes: freelistCount * pageSize,
    liveBytes: Math.max(0, pageCount - freelistCount) * pageSize,
    walBytes: fileSize(walPathFor(databasePath)),
  };
};

/** Run `fn` with a temporary busy_timeout, restoring the previous one. */
export const withBusyTimeout = <A>(
  db: SqliteDatabase,
  timeoutMs: number,
  fn: () => A,
): A => {
  const previous = pragmaNumber(db, "busy_timeout");
  db.exec(`PRAGMA busy_timeout = ${Math.max(0, Math.floor(timeoutMs))};`);
  try {
    return fn();
  } finally {
    db.exec(`PRAGMA busy_timeout = ${previous};`);
  }
};

export const checkpointWal = (
  db: SqliteDatabase,
  mode: CheckpointMode,
): CheckpointResult => {
  const row = db.prepare(`PRAGMA wal_checkpoint(${mode});`).get() as {
    busy?: number;
    log?: number;
    checkpointed?: number;
  } | null;
  return {
    mode,
    busy: Number(row?.busy ?? 0) !== 0,
    walFrames: Number(row?.log ?? 0),
    checkpointedFrames: Number(row?.checkpointed ?? 0),
  };
};

const readMeta = (db: SqliteDatabase, key: string): string | null => {
  const row = db.prepare("SELECT value FROM meta WHERE key = ?").get(key) as {
    value?: unknown;
  } | null;
  return typeof row?.value === "string" ? row.value : null;
};

const writeMeta = (db: SqliteDatabase, key: string, value: string): void => {
  db.prepare(
    `INSERT INTO meta (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value,
       updated_at = excluded.updated_at`,
  ).run(key, value, Date.now());
};

const deleteMeta = (db: SqliteDatabase, key: string): void => {
  db.prepare("DELETE FROM meta WHERE key = ?").run(key);
};

const tableExists = (db: SqliteDatabase, name: string): boolean =>
  Boolean(
    db
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get(name),
  );

/** Run `fn` inside `BEGIN IMMEDIATE`, rolling back on any failure. */
const inImmediateTransaction = <A>(db: SqliteDatabase, fn: () => A): A => {
  db.exec("BEGIN IMMEDIATE;");
  try {
    const result = fn();
    db.exec("COMMIT;");
    return result;
  } catch (error) {
    try {
      db.exec("ROLLBACK;");
    } catch {
      /* the transaction may already be gone */
    }
    throw error;
  }
};

/**
 * Rebuild every schema-owned external-content FTS index that exists (a
 * SQLite build without FTS5 has none). Caller owns the transaction.
 */
export const rebuildExternalContentFtsIndexes = (
  db: SqliteDatabase,
): string[] => {
  const present = EXTERNAL_CONTENT_FTS_TABLES.filter((table) =>
    tableExists(db, table),
  );
  for (const table of present) {
    db.exec(rebuildFtsIndexSql(table));
  }
  return present;
};

/**
 * Finish a reclaim that stopped between VACUUM and the FTS rebuild (crash,
 * or BUSY on the rebuild transaction). Returns the rebuilt indexes, or null
 * when nothing was pending.
 */
export const recoverPendingFtsRebuild = (
  db: SqliteDatabase,
): string[] | null => {
  if (readMeta(db, MAINTENANCE_META_KEYS.ftsRebuildPending) === null) {
    return null;
  }
  return inImmediateTransaction(db, () => {
    const rebuilt = rebuildExternalContentFtsIndexes(db);
    deleteMeta(db, MAINTENANCE_META_KEYS.ftsRebuildPending);
    return rebuilt;
  });
};

/** One bounded ANALYZE per schema version. Returns false when already done. */
export const analyzeOncePerSchemaVersion = (
  db: SqliteDatabase,
  analysisLimit: number = MAINTENANCE_DEFAULTS.analysisLimit,
): boolean => {
  const version = String(SCHEMA_VERSION);
  if (readMeta(db, MAINTENANCE_META_KEYS.analyzedSchemaVersion) === version) {
    return false;
  }
  db.exec(`PRAGMA analysis_limit = ${analysisLimit};`);
  inImmediateTransaction(db, () => {
    db.exec("ANALYZE;");
    writeMeta(db, MAINTENANCE_META_KEYS.analyzedSchemaVersion, version);
  });
  return true;
};

export const searchTextIndexExists = (db: SqliteDatabase): boolean =>
  Boolean(
    db
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = ?")
      .get(SEARCH_TEXT_INDEX_NAME),
  );

/**
 * Build recall's covering index and its `sqlite_stat1` row in one
 * immediate transaction. Holds the write lock for the whole `entry` scan,
 * so callers run it only in the detached window. BUSY is a deferral.
 * `indexBytes` is the growth in live pages (the index plus its stat row).
 */
export const buildSearchTextIndex = (
  connection: SqliteDatabase,
  options: {
    busyTimeoutMs: number;
    analysisLimit: number;
    /** Test seam: the default runs `SEARCH_TEXT_INDEX_SQL`. */
    create?: (connection: SqliteDatabase) => void;
  },
): SearchIndexOutcome => {
  if (searchTextIndexExists(connection)) return { status: "present" };
  const livePages = () =>
    pragmaNumber(connection, "page_count") -
    pragmaNumber(connection, "freelist_count");
  const pagesBefore = livePages();
  const startedAt = performance.now();
  try {
    withBusyTimeout(connection, options.busyTimeoutMs, () => {
      connection.exec(`PRAGMA analysis_limit = ${options.analysisLimit};`);
      inImmediateTransaction(connection, () => {
        (options.create ?? ((db) => db.exec(SEARCH_TEXT_INDEX_SQL)))(
          connection,
        );
        connection.exec(`ANALYZE ${SEARCH_TEXT_INDEX_NAME};`);
      });
    });
  } catch (error) {
    if (isSqliteBusyError(error)) return { status: "deferred", reason: "busy" };
    throw error;
  }
  return {
    status: "built",
    ms: elapsedMs(startedAt),
    indexBytes:
      Math.max(0, livePages() - pagesBefore) *
      pragmaNumber(connection, "page_size"),
  };
};

/**
 * `PRAGMA optimize` on a long-lived connection. `boot` uses mask 0x10002
 * (SQLite >= 3.46: consider every table, not only ones this connection
 * queried; older versions ignore the extra bit). BUSY is swallowed — the
 * next boot/shutdown tries again.
 */
export const optimizeConnection = (
  db: SqliteDatabase,
  phase: "boot" | "close",
  options: { busyTimeoutMs?: number; analysisLimit?: number } = {},
): boolean => {
  try {
    withBusyTimeout(db, options.busyTimeoutMs ?? 250, () => {
      db.exec(
        `PRAGMA analysis_limit = ${options.analysisLimit ?? MAINTENANCE_DEFAULTS.analysisLimit};`,
      );
      db.exec(
        phase === "boot" ? "PRAGMA optimize = 0x10002;" : "PRAGMA optimize;",
      );
    });
    return true;
  } catch (error) {
    if (isSqliteBusyError(error)) return false;
    throw error;
  }
};

export const defaultDiskSpaceProbe: DiskSpaceProbe = (directory) => {
  try {
    const stats = fs.statfsSync(directory);
    return {
      freeBytes: Number(stats.bavail) * Number(stats.bsize),
      device: Number(fs.statSync(directory).dev),
    };
  } catch {
    return null;
  }
};

/** Where SQLite's unix/win VFS puts VACUUM's temp database. */
export const sqliteTempDirectory = (): string =>
  process.env.SQLITE_TMPDIR || os.tmpdir();

/**
 * VACUUM needs, transiently, a temp database (~live bytes, in the temp
 * directory) plus a WAL as large as the result (~live bytes, next to the
 * database) before the final checkpoint shrinks the file.
 */
export const checkReclaimDiskSpace = (
  health: DatabaseHealth,
  databasePath: string,
  policy: Pick<ReclaimPolicy, "diskHeadroomBytes" | "diskSpace" | "tempDirectory">,
): { ok: true } | { ok: false; detail: Record<string, unknown> } => {
  const databaseDirectory = path.dirname(databasePath);
  const dbDisk = policy.diskSpace(databaseDirectory);
  const tmpDisk = policy.diskSpace(policy.tempDirectory);
  const perCopy = health.liveBytes + policy.diskHeadroomBytes;
  if (!dbDisk || !tmpDisk) {
    return { ok: false, detail: { reason: "statfs-unavailable" } };
  }
  const sameDevice = dbDisk.device === tmpDisk.device;
  const requiredDbBytes = sameDevice
    ? 2 * health.liveBytes + policy.diskHeadroomBytes
    : perCopy;
  const ok = sameDevice
    ? dbDisk.freeBytes >= requiredDbBytes
    : dbDisk.freeBytes >= perCopy && tmpDisk.freeBytes >= perCopy;
  return ok
    ? { ok: true }
    : {
        ok: false,
        detail: {
          liveBytes: health.liveBytes,
          requiredBytes: requiredDbBytes,
          freeBytes: dbDisk.freeBytes,
          ...(sameDevice ? {} : { tempFreeBytes: tmpDisk.freeBytes }),
        },
      };
};

/**
 * The reclaim's cheap preconditions (meta, freelist thresholds, statfs):
 * `null` when a VACUUM would run now, else the skip outcome.
 */
export const evaluateReclaim = (
  connection: SqliteDatabase,
  databasePath: string,
  policy: ReclaimPolicy,
): { ready: true; health: DatabaseHealth } | (ReclaimOutcome & { ready?: false }) => {
  if (readMeta(connection, MAINTENANCE_META_KEYS.freelistReclaimed) !== null) {
    return { status: "skipped", reason: "already-done", detail: {} };
  }
  const health = readDatabaseHealth(connection, databasePath);
  const totalBytes = health.pageCount * health.pageSize;
  const ratio = totalBytes > 0 ? health.freelistBytes / totalBytes : 0;
  if (
    health.freelistBytes < policy.minFreelistBytes ||
    ratio < policy.minFreelistRatio
  ) {
    return {
      status: "skipped",
      reason: "below-threshold",
      detail: { freelistBytes: health.freelistBytes, ratio },
    };
  }
  const disk = checkReclaimDiskSpace(health, databasePath, policy);
  if (!disk.ok) {
    return { status: "skipped", reason: "insufficient-disk", detail: disk.detail };
  }
  return { ready: true, health };
};

/**
 * The one-time freelist reclaim. `connection` must be a dedicated
 * connection (not the worker's shared one): it is switched to
 * `temp_store = FILE` so VACUUM's copy never lands in RAM.
 */
export const reclaimFreelist = (
  connection: SqliteDatabase,
  databasePath: string,
  policy: ReclaimPolicy,
): ReclaimOutcome => {
  const evaluation = evaluateReclaim(connection, databasePath, policy);
  if (evaluation.ready !== true) return evaluation;
  const before = evaluation.health;

  // Start from an empty WAL: VACUUM will write the whole result into it.
  const preCheckpoint = withBusyTimeout(
    connection,
    policy.checkpointBusyTimeoutMs,
    () => checkpointWal(connection, "TRUNCATE"),
  );
  if (preCheckpoint.busy) {
    return { status: "deferred", reason: "busy", step: "checkpoint" };
  }

  connection.exec("PRAGMA temp_store = FILE;");
  return withBusyTimeout(connection, policy.busyTimeoutMs, () => {
    try {
      writeMeta(connection, MAINTENANCE_META_KEYS.ftsRebuildPending, "vacuum");
    } catch (error) {
      if (isSqliteBusyError(error)) {
        return { status: "deferred", reason: "busy", step: "mark-pending" };
      }
      throw error;
    }

    const vacuumStartedAt = performance.now();
    try {
      (policy.vacuum ?? ((db) => db.exec("VACUUM;")))(connection);
    } catch (error) {
      // VACUUM is atomic: on failure no rowid moved, so drop the marker.
      try {
        deleteMeta(connection, MAINTENANCE_META_KEYS.ftsRebuildPending);
      } catch {
        /* a leftover marker only costs one redundant rebuild */
      }
      if (isSqliteBusyError(error)) {
        return { status: "deferred", reason: "busy", step: "vacuum" };
      }
      throw error;
    }
    const vacuumMs = Math.round(performance.now() - vacuumStartedAt);

    const rebuildStartedAt = performance.now();
    let rebuiltIndexes: string[];
    try {
      rebuiltIndexes = inImmediateTransaction(connection, () => {
        const rebuilt = rebuildExternalContentFtsIndexes(connection);
        deleteMeta(connection, MAINTENANCE_META_KEYS.ftsRebuildPending);
        writeMeta(
          connection,
          MAINTENANCE_META_KEYS.freelistReclaimed,
          JSON.stringify({
            at: Date.now(),
            fileBytesBefore: before.fileBytes,
            freelistBytesBefore: before.freelistBytes,
          }),
        );
        return rebuilt;
      });
    } catch (error) {
      // The pending marker survives; the next idle tick rebuilds.
      if (isSqliteBusyError(error)) {
        return { status: "deferred", reason: "busy", step: "fts-rebuild" };
      }
      throw error;
    }
    const rebuildMs = Math.round(performance.now() - rebuildStartedAt);

    // This checkpoint copies the vacuumed pages back and truncates the file.
    // BUSY (a reader on an old snapshot) is fine: the WAL-size rule on a
    // later idle tick finishes it.
    const finalCheckpoint = withBusyTimeout(
      connection,
      policy.checkpointBusyTimeoutMs,
      () => checkpointWal(connection, "TRUNCATE"),
    );
    return {
      status: "reclaimed",
      before,
      after: readDatabaseHealth(connection, databasePath),
      rebuiltIndexes,
      vacuumMs,
      rebuildMs,
      finalCheckpointBusy: finalCheckpoint.busy,
    };
  });
};

// ---------------------------------------------------------------------------
// Scheduler
// ---------------------------------------------------------------------------

export type DatabaseMaintenanceOptions = {
  /** The worker's long-lived connection (used only for PRAGMA optimize). */
  db: SqliteDatabase;
  databasePath: string;
  openConnection?: (databasePath: string) => SqliteDatabase;
  logger?: MaintenanceLogger | null;
  diskSpace?: DiskSpaceProbe;
  tempDirectory?: string;
  vacuum?: (connection: SqliteDatabase) => void;
  /** Test seam: the default runs `SEARCH_TEXT_INDEX_SQL`. */
  createSearchIndex?: (connection: SqliteDatabase) => void;
  /** Rows per legacy run_event batch transaction (default 5k). */
  sweepBatchSize?: number;
  /** Clock for the sweep budget (test seam; default performance.now). */
  now?: () => number;
} & Partial<MaintenanceSettings>;

export type MaintenanceStartOptions = {
  /** No run/agent/voice/user-app work and no in-flight RPC. Cheap + sync. */
  isIdle: () => boolean;
  /** RPC clients (Electron hosts) attached to the worker right now. */
  attachedClientCount: () => number;
};

/** `STELLA_DB_RECLAIM=0` disables only the one-time VACUUM reclaim. */
export const reclaimKillSwitchEngaged = (): boolean =>
  process.env.STELLA_DB_RECLAIM === "0";

/** Consecutive BUSY deferrals, while detached, before giving up for the session. */
const MAX_DETACHED_RECLAIM_DEFERRALS = 3;
const MAX_DETACHED_SEARCH_INDEX_DEFERRALS = 3;

const elapsedMs = (startedAt: number) =>
  Math.round(performance.now() - startedAt);

export class DatabaseMaintenance {
  private readonly settings: MaintenanceSettings;
  private cancelTicks: (() => void) | null = null;
  private hooks: MaintenanceStartOptions | null = null;
  private connection: SqliteDatabase | null = null;
  private disposed = false;
  private idleStreak = 0;
  private bootDone = false;
  private analyzeDone = false;
  private sweepDrained = false;
  private sweepCursor: string | null = null;
  private reclaimDone = false;
  /** A non-BUSY reclaim failure (e.g. disk full) disables it for this session. */
  private reclaimDisabled = false;
  /** Preconditions held on the last evaluation; waiting for zero clients. */
  private reclaimReady = false;
  private reclaimRunning = false;
  private detachedDeferrals = 0;
  /** The search-text index exists (or was built this session). */
  private searchIndexDone = false;
  /** Seen missing on an idle tick; waiting for (or retrying in) the detached window. */
  private searchIndexPending = false;
  private searchIndexRunning = false;
  /** Three BUSY deferrals or a non-BUSY failure: stop trying this session. */
  private searchIndexDisabled = false;
  private searchIndexDeferrals = 0;
  private readonly loggedSkips = new Set<string>();

  constructor(private readonly options: DatabaseMaintenanceOptions) {
    this.settings = { ...MAINTENANCE_DEFAULTS, ...stripUndefined(options) };
  }

  private get logger(): MaintenanceLogger | null {
    return this.options.logger === undefined
      ? getFileLogger()
      : this.options.logger;
  }

  /** Begin idle ticking. */
  start(hooks: MaintenanceStartOptions): void {
    if (this.disposed || this.cancelTicks) return;
    this.hooks = hooks;
    this.cancelTicks = forkFixedRateFiber(this.settings.intervalMs, () =>
      this.runIdleTick(),
    );
  }

  /**
   * True while the search-index build or the reclaim is running, or either
   * is pending and waiting for the detached window. The worker ORs this into
   * `hasActiveWork`, so the lifecycle's idle-shutdown (`shouldKeepAlive`)
   * keeps the process up after the last client detaches until later ticks
   * have run them. (Both are synchronous, so no timer can fire during them.)
   */
  holdsWorkerAlive(): boolean {
    if (this.reclaimRunning || this.searchIndexRunning) return true;
    if (
      !this.disposed &&
      this.hooks &&
      this.searchIndexPending &&
      !this.searchIndexDone &&
      !this.searchIndexDisabled &&
      safeCount(this.hooks.attachedClientCount) === 0
    ) {
      return true;
    }
    if (
      this.disposed ||
      !this.hooks ||
      !this.reclaimReady ||
      this.reclaimDone ||
      this.reclaimDisabled ||
      reclaimKillSwitchEngaged()
    ) {
      return false;
    }
    return safeCount(this.hooks.attachedClientCount) === 0;
  }

  /**
   * Cancel the tick fiber, close the maintenance connection, and run
   * `PRAGMA optimize` on the worker connection. Ticks are synchronous on
   * this thread, so none can be mid-flight here: cancel is the join.
   * Call before closing `db`.
   */
  stop(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.cancelTicks?.();
    this.cancelTicks = null;
    try {
      this.connection?.close();
    } catch {
      /* already closed */
    }
    this.connection = null;
    const startedAt = performance.now();
    try {
      const ran = optimizeConnection(this.options.db, "close", {
        analysisLimit: this.settings.analysisLimit,
      });
      this.logger?.process("storage.maintenance.optimize", {
        phase: "close",
        busy: !ran,
        ms: elapsedMs(startedAt),
      });
    } catch (error) {
      this.logger?.warn("storage.maintenance.optimize-failed", {
        phase: "close",
        error: (error as Error)?.message ?? String(error),
      });
    }
  }

  /** One tick of the fixed-rate fiber. Never throws. Exposed for tests. */
  runIdleTick(): void {
    if (this.disposed || !this.hooks) return;
    let idle = false;
    try {
      idle = this.hooks.isIdle();
    } catch {
      idle = false;
    }
    if (!idle) {
      this.idleStreak = 0;
      return;
    }
    this.idleStreak += 1;
    try {
      this.runIdleStep();
    } catch (error) {
      if (isSqliteBusyError(error)) {
        this.logOnce("busy", "storage.maintenance.deferred", {
          reason: "busy",
        });
        return;
      }
      this.logger?.warn("storage.maintenance.failed", {
        error: (error as Error)?.message ?? String(error),
      });
    }
  }

  private maintenanceConnection(): SqliteDatabase {
    if (!this.connection) {
      const connection = (this.options.openConnection ?? openSqliteConnection)(
        this.options.databasePath,
      );
      connection.exec(
        `PRAGMA busy_timeout = ${this.settings.busyTimeoutMs}; PRAGMA temp_store = FILE;`,
      );
      this.connection = connection;
    }
    return this.connection;
  }

  private runIdleStep(): void {
    const connection = this.maintenanceConnection();
    const { databasePath } = this.options;

    if (!this.bootDone) {
      this.bootDone = true;
      const health = readDatabaseHealth(connection, databasePath);
      this.logger?.process("storage.maintenance.health", { ...health });
      const startedAt = performance.now();
      const ran = optimizeConnection(this.options.db, "boot", {
        analysisLimit: this.settings.analysisLimit,
      });
      this.logger?.process("storage.maintenance.optimize", {
        phase: "boot",
        busy: !ran,
        ms: elapsedMs(startedAt),
      });
    }

    // Heavy step 1: finish an interrupted reclaim before anything else.
    const recoverStartedAt = performance.now();
    const recovered = recoverPendingFtsRebuild(connection);
    if (recovered) {
      this.logger?.process("storage.maintenance.fts-rebuild", {
        reason: "pending-marker",
        indexes: recovered.join(","),
        ms: elapsedMs(recoverStartedAt),
      });
      return;
    }

    this.checkpoint(connection);
    this.sweepLegacyRunEvents(connection);

    if (
      !this.analyzeDone &&
      this.idleStreak >= this.settings.analyzeIdleTicks
    ) {
      const startedAt = performance.now();
      const ran = withBusyTimeout(connection, this.settings.busyTimeoutMs, () =>
        analyzeOncePerSchemaVersion(connection, this.settings.analysisLimit),
      );
      this.analyzeDone = true;
      if (ran) {
        this.logger?.process("storage.maintenance.analyze", {
          schemaVersion: SCHEMA_VERSION,
          ms: elapsedMs(startedAt),
        });
        return;
      }
    }

    // Heavy, detached only, and before the reclaim so VACUUM compacts it.
    const searchIndex = this.searchIndexStep(connection);

    // Readiness is evaluated on every idle tick (cheap: pragmas + statfs)
    // so the idle-shutdown hold is already in place when Electron quits;
    // the VACUUM itself only runs detached (see reclaim()), and not on a
    // tick that built the index or while the index is still pending.
    if (this.sweepDrained && !this.reclaimDone && !this.reclaimDisabled) {
      this.reclaim(connection, searchIndex === "settled");
    }
  }

  /**
   * "settled": the index exists or this session gave up on it; "waiting":
   * missing, not in the detached window yet; "ran": this tick built it or
   * deferred on BUSY (the tick's one heavy step).
   */
  private searchIndexStep(
    connection: SqliteDatabase,
  ): "settled" | "waiting" | "ran" {
    if (this.searchIndexDone || this.searchIndexDisabled) return "settled";
    if (searchTextIndexExists(connection)) {
      this.searchIndexDone = true;
      this.searchIndexPending = false;
      return "settled";
    }
    this.searchIndexPending = true;
    if (!this.isDetached()) {
      this.logOnce(
        "search-index-waiting",
        "storage.maintenance.search-index-waiting",
        { reason: "clients-attached" },
      );
      return "waiting";
    }
    if (this.idleStreak < this.settings.reclaimIdleTicks) return "waiting";
    let outcome: SearchIndexOutcome;
    this.searchIndexRunning = true;
    const startedAt = performance.now();
    try {
      outcome = buildSearchTextIndex(connection, {
        busyTimeoutMs: this.settings.busyTimeoutMs,
        analysisLimit: this.settings.analysisLimit,
        ...(this.options.createSearchIndex
          ? { create: this.options.createSearchIndex }
          : {}),
      });
    } catch (error) {
      this.searchIndexDisabled = true;
      this.logger?.warn("storage.maintenance.search-index-failed", {
        error: (error as Error)?.message ?? String(error),
        ms: elapsedMs(startedAt),
      });
      return "ran";
    } finally {
      this.searchIndexRunning = false;
    }
    switch (outcome.status) {
      case "present":
        this.searchIndexDone = true;
        this.searchIndexPending = false;
        return "settled";
      case "built":
        this.searchIndexDone = true;
        this.searchIndexPending = false;
        this.logger?.process("storage.maintenance.search-index", {
          index: SEARCH_TEXT_INDEX_NAME,
          indexBytes: outcome.indexBytes,
          ms: outcome.ms,
        });
        return "ran";
      case "deferred":
        this.searchIndexDeferrals += 1;
        if (this.searchIndexDeferrals >= MAX_DETACHED_SEARCH_INDEX_DEFERRALS) {
          this.searchIndexDisabled = true;
        }
        this.logOnce("deferred:search-index", "storage.maintenance.deferred", {
          step: "search-index",
          reason: outcome.reason,
        });
        return "ran";
    }
  }

  private checkpoint(connection: SqliteDatabase): void {
    const walPath = walPathFor(this.options.databasePath);
    const walBytesBefore = fileSize(walPath);
    if (walBytesBefore === 0) return;
    if (walBytesBefore < this.settings.walTruncateBytes) {
      checkpointWal(connection, "PASSIVE");
      return;
    }
    const startedAt = performance.now();
    const result = withBusyTimeout(
      connection,
      this.settings.checkpointBusyTimeoutMs,
      () => checkpointWal(connection, "TRUNCATE"),
    );
    this.logger?.process("storage.maintenance.checkpoint", {
      mode: result.mode,
      busy: result.busy,
      walBytesBefore,
      walBytesAfter: fileSize(walPath),
      fileBytes: fileSize(this.options.databasePath),
      ms: elapsedMs(startedAt),
    });
  }

  /**
   * Drain legacy `run_event` rows in `deleteLegacyRunEventBatch` batches
   * (<= 5k rows, one immediate transaction each) for up to a per-tick time
   * budget: 250 ms with a client attached, 2 s with none. Between batches
   * the loop stops when the budget is spent or the idle predicate no longer
   * holds. Drained is proven only by a batch that started from the first
   * conversation and found nothing left (a resumed batch ending at null
   * triggers one confirming walk), and is recorded in `meta` so later
   * sessions skip the sweep. Reclaim waits for it: deleted rows only return
   * disk space through VACUUM.
   */
  private sweepLegacyRunEvents(connection: SqliteDatabase): void {
    if (this.sweepDrained) return;
    if (readMeta(connection, MAINTENANCE_META_KEYS.runEventSweepDrained) !== null) {
      this.sweepDrained = true;
      return;
    }
    const now = this.options.now ?? (() => performance.now());
    const budgetMs = this.isDetached()
      ? this.settings.sweepDetachedBudgetMs
      : this.settings.sweepBudgetMs;
    const startedAt = now();
    let deleted = 0;
    let batches = 0;
    for (;;) {
      const fromConversationId = this.sweepCursor;
      const batch = deleteLegacyRunEventBatch(connection, {
        fromConversationId,
        ...(this.options.sweepBatchSize
          ? { batchSize: this.options.sweepBatchSize }
          : {}),
      });
      this.sweepCursor = batch.resumeFrom;
      deleted += batch.deleted;
      batches += 1;
      if (batch.resumeFrom === null && fromConversationId === null) {
        writeMeta(
          connection,
          MAINTENANCE_META_KEYS.runEventSweepDrained,
          String(Date.now()),
        );
        this.sweepDrained = true;
        break;
      }
      if (now() - startedAt >= budgetMs) break;
      if (!this.stillIdle()) break;
    }
    if (deleted > 0) {
      this.logger?.process("storage.maintenance.run-event-sweep", {
        deleted,
        batches,
        budgetMs,
        drained: this.sweepDrained,
        ms: Math.round(now() - startedAt),
      });
    }
    if (this.sweepDrained) {
      this.logger?.process("storage.maintenance.run-event-sweep-drained", {});
    }
  }

  private isDetached(): boolean {
    return !!this.hooks && safeCount(this.hooks.attachedClientCount) === 0;
  }

  private stillIdle(): boolean {
    try {
      return this.hooks?.isIdle() ?? false;
    } catch {
      return false;
    }
  }

  private reclaimPolicy(): ReclaimPolicy {
    return {
      minFreelistBytes: this.settings.reclaimMinFreelistBytes,
      minFreelistRatio: this.settings.reclaimMinFreelistRatio,
      diskHeadroomBytes: this.settings.reclaimDiskHeadroomBytes,
      busyTimeoutMs: this.settings.busyTimeoutMs,
      checkpointBusyTimeoutMs: this.settings.checkpointBusyTimeoutMs,
      diskSpace: this.options.diskSpace ?? defaultDiskSpaceProbe,
      tempDirectory: this.options.tempDirectory ?? sqliteTempDirectory(),
      ...(this.options.vacuum ? { vacuum: this.options.vacuum } : {}),
    };
  }

  private reclaim(connection: SqliteDatabase, mayRun: boolean): void {
    if (reclaimKillSwitchEngaged()) {
      this.reclaimReady = false;
      this.logOnce("kill-switch", "storage.maintenance.reclaim-skipped", {
        reason: "STELLA_DB_RECLAIM=0",
      });
      return;
    }
    const policy = this.reclaimPolicy();
    const evaluation = evaluateReclaim(
      connection,
      this.options.databasePath,
      policy,
    );
    if (evaluation.ready !== true) {
      this.reclaimReady = false;
      this.handleOutcome(evaluation, 0);
      return;
    }
    // The detached window: with a client attached, a multi-minute
    // synchronous VACUUM would stall its messages and fail other
    // processes' writes. Wait (and keep the worker alive) for zero clients.
    this.reclaimReady = true;
    if (!this.isDetached()) {
      this.logOnce("waiting-for-detach", "storage.maintenance.reclaim-waiting", {
        reason: "clients-attached",
        freelistBytes: evaluation.health.freelistBytes,
      });
      return;
    }
    // No attached client to protect, so no long streak: the default of one
    // idle tick keeps the post-quit linger to a single tick.
    if (this.idleStreak < this.settings.reclaimIdleTicks) return;
    if (!mayRun) return;
    const startedAt = performance.now();
    let outcome: ReclaimOutcome;
    this.reclaimRunning = true;
    try {
      outcome = reclaimFreelist(connection, this.options.databasePath, policy);
    } catch (error) {
      this.reclaimDisabled = true;
      this.logger?.warn("storage.maintenance.reclaim-failed", {
        error: (error as Error)?.message ?? String(error),
        ms: elapsedMs(startedAt),
      });
      return;
    } finally {
      this.reclaimRunning = false;
    }
    this.handleOutcome(outcome, elapsedMs(startedAt));
  }

  private handleOutcome(outcome: ReclaimOutcome, ms: number): void {
    switch (outcome.status) {
      case "reclaimed":
        this.reclaimDone = true;
        this.reclaimReady = false;
        this.logger?.process("storage.maintenance.reclaim", {
          fileBytesBefore: outcome.before.fileBytes,
          freelistBytesBefore: outcome.before.freelistBytes,
          fileBytesAfter: outcome.after.fileBytes,
          freelistBytesAfter: outcome.after.freelistBytes,
          walBytesAfter: outcome.after.walBytes,
          vacuumMs: outcome.vacuumMs,
          ftsRebuildMs: outcome.rebuildMs,
          ftsIndexes: outcome.rebuiltIndexes.join(","),
          finalCheckpointBusy: outcome.finalCheckpointBusy,
          ms,
        });
        return;
      case "deferred":
        this.detachedDeferrals += 1;
        if (this.detachedDeferrals >= MAX_DETACHED_RECLAIM_DEFERRALS) {
          // Something outside this process keeps the lock; stop pinning
          // the worker alive for it. The next session tries again.
          this.reclaimDisabled = true;
        }
        this.logOnce(`deferred:${outcome.step}`, "storage.maintenance.deferred", {
          step: outcome.step,
          reason: outcome.reason,
        });
        return;
      case "skipped":
        if (outcome.reason === "already-done") {
          this.reclaimDone = true;
          return;
        }
        if (outcome.reason === "insufficient-disk") {
          this.logOnce(
            "insufficient-disk",
            "storage.maintenance.reclaim-skipped",
            { reason: outcome.reason, ...outcome.detail },
          );
        }
        return;
    }
  }

  private logOnce(
    key: string,
    event: string,
    fields: Record<string, unknown>,
  ): void {
    if (this.loggedSkips.has(key)) return;
    this.loggedSkips.add(key);
    this.logger?.process(event, fields);
  }
}

const safeCount = (count: () => number): number => {
  try {
    const value = count();
    return Number.isFinite(value) ? value : 1;
  } catch {
    return 1;
  }
};

const stripUndefined = (value: object): Partial<MaintenanceSettings> =>
  Object.fromEntries(
    Object.entries(value).filter(
      ([key, entry]) => typeof entry === "number" && key in MAINTENANCE_DEFAULTS,
    ),
  ) as Partial<MaintenanceSettings>;
