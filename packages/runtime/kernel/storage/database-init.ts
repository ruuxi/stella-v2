import path from "path";
import { performance } from "node:perf_hooks";
import type { SqliteDatabase } from "./shared.js";
import { ensurePrivateDirSync } from "../shared/private-fs.js";
import { SCHEMA_VERSION, migrateDesktopDatabase } from "./schema.js";
import { getFileLogger } from "../../observability/file-logger.js";

const DB_FILE = "stella.sqlite";

export const ensureDatabaseStateRoot = (stellaDataDir: string) => {
  const stateRoot = stellaDataDir;
  ensurePrivateDirSync(stateRoot);
  return stateRoot;
};

export const getDesktopDatabasePath = (stellaDataDir: string) =>
  path.join(ensureDatabaseStateRoot(stellaDataDir), DB_FILE);

/** How long connection init took and whether it ran a migration. */
export type DesktopDatabaseInitTiming = {
  /** `PRAGMA user_version` before init; -1 when it could not be read. */
  fromVersion: number;
  toVersion: number;
  migrated: boolean;
  /** Pragmas + version check + any migration. */
  durationMs: number;
};

/**
 * Read the schema version without side effects. Failure (e.g. a legacy
 * rollback-journal database locked by another opener) is reported as -1 and
 * never escapes: the real migration below owns lock handling.
 */
const readUserVersionSafely = (db: SqliteDatabase): number => {
  try {
    const row = db.prepare("PRAGMA user_version;").get() as
      | { user_version?: number }
      | undefined;
    return typeof row?.user_version === "number" ? row.user_version : -1;
  } catch {
    return -1;
  }
};

/**
 * Initialize a freshly opened connection to the desktop database: apply the
 * per-connection pragmas and bring the schema to the current version. A
 * database that is already current performs no writes here — migrations
 * (including the one-time legacy import) run exactly once, guarded by
 * `PRAGMA user_version`.
 *
 * A pending migration logs `storage.migration.start` before it runs and
 * `storage.migration.complete` / `storage.migration.failed` after, so a long
 * migration (minutes on a large legacy database) is visible in the process
 * log of whichever process ran it — including Electron main, which
 * initializes the same database for the connector outbox.
 */
export const initializeDesktopDatabase = (
  db: SqliteDatabase,
): DesktopDatabaseInitTiming => {
  const startedAt = performance.now();
  const fromVersion = readUserVersionSafely(db);
  const pending = fromVersion >= 0 && fromVersion < SCHEMA_VERSION;
  if (pending) {
    getFileLogger()?.process("storage.migration.start", {
      fromVersion,
      toVersion: SCHEMA_VERSION,
      pid: process.pid,
    });
  }
  try {
    migrateDesktopDatabase(db);
  } catch (error) {
    if (pending) {
      getFileLogger()?.error("storage.migration.failed", {
        fromVersion,
        toVersion: SCHEMA_VERSION,
        ms: Math.round(performance.now() - startedAt),
        error: error instanceof Error ? error.message : String(error),
      });
    }
    throw error;
  }
  const durationMs = performance.now() - startedAt;
  if (pending) {
    getFileLogger()?.process("storage.migration.complete", {
      fromVersion,
      toVersion: SCHEMA_VERSION,
      ms: Math.round(durationMs),
    });
  }
  return {
    fromVersion,
    toVersion: SCHEMA_VERSION,
    migrated: pending,
    durationMs,
  };
};
