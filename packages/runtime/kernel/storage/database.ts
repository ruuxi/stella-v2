import { createRequire } from "node:module";
import {
  getDesktopDatabasePath,
  initializeDesktopDatabase,
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

export const createDesktopDatabase = (stellaDataDir: string): SqliteDatabase => {
  const db = openDatabase(getDesktopDatabasePath(stellaDataDir));
  initializeDesktopDatabase(db);
  return db;
};
