import { createRequire } from "node:module";
import { performance } from "node:perf_hooks";
import {
  getDesktopDatabasePath,
  initializeDesktopDatabase,
  type DesktopDatabaseInitTiming,
} from "./database-init.js";
import type { SqliteDatabase } from "./shared.js";

type SqliteDatabaseCtor = new (filePath: string) => SqliteDatabase;

const requireRuntime = createRequire(import.meta.url);

let cachedSqliteCtor: SqliteDatabaseCtor | null = null;

/**
 * Resolve the sqlite driver lazily so importing this module never fails on
 * runtimes without `bun:sqlite` (e.g. vitest under Node). Under Bun this
 * resolves `bun:sqlite` exactly as the previous static import did; under
 * Node >= 22.5 it falls back to `node:sqlite`.
 */
const loadSqliteDatabaseCtor = (): SqliteDatabaseCtor => {
  if (cachedSqliteCtor) return cachedSqliteCtor;
  if (process.versions.bun) {
    const bunSqlite = requireRuntime("bun:sqlite") as {
      Database?: SqliteDatabaseCtor;
    };
    if (typeof bunSqlite.Database === "function") {
      cachedSqliteCtor = bunSqlite.Database;
      return cachedSqliteCtor;
    }
  } else {
    const nodeSqlite = requireRuntime("node:sqlite") as {
      DatabaseSync?: SqliteDatabaseCtor;
    };
    if (typeof nodeSqlite.DatabaseSync === "function") {
      cachedSqliteCtor = nodeSqlite.DatabaseSync;
      return cachedSqliteCtor;
    }
  }
  throw new Error(
    "No sqlite driver available: requires Bun (bun:sqlite) or Node >= 22.5 (node:sqlite).",
  );
};

const openDatabase = (dbPath: string): SqliteDatabase => {
  const Database = loadSqliteDatabaseCtor();
  return new Database(dbPath);
};

/**
 * Open a raw extra connection to an already-initialized database: no
 * pragmas, no migration. Used by storage maintenance, which tunes its own
 * connection (temp_store, busy_timeout) without touching the shared one.
 */
export const openSqliteConnection = (dbPath: string): SqliteDatabase =>
  openDatabase(dbPath);

/** Open cost (file open) plus connection init/migration cost. */
export type DesktopDatabaseOpenTiming = DesktopDatabaseInitTiming & {
  openMs: number;
};

export const createDesktopDatabase = (
  stellaDataDir: string,
  options?: { onTiming?: (timing: DesktopDatabaseOpenTiming) => void },
): SqliteDatabase => {
  const startedAt = performance.now();
  const db = openDatabase(getDesktopDatabasePath(stellaDataDir));
  const openMs = performance.now() - startedAt;
  const init = initializeDesktopDatabase(db);
  options?.onTiming?.({ ...init, openMs });
  return db;
};
