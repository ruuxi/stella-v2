import path from "path";
import type { SqliteDatabase } from "./shared.js";
import { ensurePrivateDirSync } from "../shared/private-fs.js";
import { migrateDesktopDatabase } from "./schema.js";

const DB_FILE = "stella.sqlite";

export const ensureDatabaseStateRoot = (stellaDataDir: string) => {
  const stateRoot = stellaDataDir;
  ensurePrivateDirSync(stateRoot);
  return stateRoot;
};

export const getDesktopDatabasePath = (stellaDataDir: string) =>
  path.join(ensureDatabaseStateRoot(stellaDataDir), DB_FILE);

/**
 * Initialize a freshly opened connection to the desktop database: apply the
 * per-connection pragmas and bring the schema to the current version. A
 * database that is already current performs no writes here — migrations
 * (including the one-time legacy import) run exactly once, guarded by
 * `PRAGMA user_version`.
 */
export const initializeDesktopDatabase = (db: SqliteDatabase) => {
  migrateDesktopDatabase(db);
};
