/**
 * Desktop database schema and migration runner.
 *
 * The schema is versioned through `PRAGMA user_version` and evolves through
 * the linear, forward-only list in `MIGRATIONS`. Opening a database is:
 * per-connection pragmas, read the version, and — only when the version is
 * behind — run the missing migrations once under an exclusive transaction.
 * A database that is already current performs no writes at open.
 *
 * Design invariants the schema encodes (instead of read-time inference):
 *  - `entry.seq` is a per-conversation sequence assigned in code by the
 *    writer; ordering is always `(conversation_id, seq)`.
 *  - `entry.turn_seq` records the visible user message that opened the turn
 *    an entry belongs to, written at insert time.
 *  - `entry.visible` is computed once at write time by the single policy
 *    function in TypeScript (`chat-event-visibility` contract).
 *  - `entry.search_text` / `thread.search_text` are writer-populated columns
 *    that the external-content FTS indexes mirror via trivial triggers.
 *  - `thread_context` materializes the latest compaction checkpoint so
 *    context assembly never reconstructs overlays from the log.
 */

import type { SqliteDatabase } from "./shared.js";
import {
  dropRetiredFeatureTables,
  importLegacyDatabase,
  legacyTablesPresent,
} from "./legacy-import.js";

export const SCHEMA_VERSION = 1;

const FTS_TOKENIZER = "'porter unicode61 remove_diacritics 2'";

export const CORE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS conversation (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL DEFAULT 'chat',
  title TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'active',
  next_seq INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_conversation_kind_status_updated
  ON conversation(kind, status, updated_at DESC, id DESC);

CREATE TABLE IF NOT EXISTS entry (
  conversation_id TEXT NOT NULL REFERENCES conversation(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  id TEXT NOT NULL,
  type TEXT NOT NULL,
  role TEXT NOT NULL,
  visible INTEGER NOT NULL DEFAULT 0,
  turn_seq INTEGER,
  device_id TEXT,
  request_id TEXT,
  target_device_id TEXT,
  run_id TEXT,
  agent_type TEXT,
  payload TEXT,
  channel_envelope TEXT,
  search_text TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (conversation_id, seq)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_entry_id ON entry(id);
CREATE INDEX IF NOT EXISTS idx_entry_conv_visible_seq
  ON entry(conversation_id, seq) WHERE visible = 1;
CREATE INDEX IF NOT EXISTS idx_entry_conv_type_seq
  ON entry(conversation_id, type, seq);
CREATE INDEX IF NOT EXISTS idx_entry_conv_turn_seq
  ON entry(conversation_id, turn_seq, seq);
CREATE INDEX IF NOT EXISTS idx_entry_created ON entry(created_at);
CREATE INDEX IF NOT EXISTS idx_entry_run
  ON entry(run_id) WHERE run_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS thread (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  agent_type TEXT NOT NULL,
  name TEXT NOT NULL,
  status TEXT NOT NULL,
  summary TEXT,
  external_session_id TEXT,
  group_key TEXT,
  group_label TEXT,
  session_id TEXT,
  session_created_at INTEGER,
  cwd TEXT NOT NULL DEFAULT '',
  parent_session TEXT,
  next_seq INTEGER NOT NULL DEFAULT 1,
  search_text TEXT,
  created_at INTEGER NOT NULL,
  last_used_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_thread_conv_status
  ON thread(conversation_id, status, last_used_at);
CREATE INDEX IF NOT EXISTS idx_thread_last_used ON thread(last_used_at);

CREATE TABLE IF NOT EXISTS blob (
  id INTEGER PRIMARY KEY,
  byte_length INTEGER NOT NULL,
  content TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS thread_entry (
  thread_id TEXT NOT NULL REFERENCES thread(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  id TEXT NOT NULL,
  type TEXT NOT NULL,
  role TEXT,
  custom_type TEXT,
  payload TEXT,
  blob_id INTEGER,
  est_tokens INTEGER NOT NULL DEFAULT 0,
  image_count INTEGER NOT NULL DEFAULT 0,
  image_bytes INTEGER NOT NULL DEFAULT 0,
  timestamp_iso TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (thread_id, seq)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_thread_entry_id ON thread_entry(id);
CREATE INDEX IF NOT EXISTS idx_thread_entry_assistant_created
  ON thread_entry(created_at) WHERE role = 'assistant' AND type = 'message';
CREATE INDEX IF NOT EXISTS idx_thread_entry_thread_role
  ON thread_entry(thread_id, role, seq);
CREATE INDEX IF NOT EXISTS idx_thread_entry_thread_custom
  ON thread_entry(thread_id, custom_type, seq) WHERE custom_type IS NOT NULL;

CREATE TABLE IF NOT EXISTS thread_context (
  thread_id TEXT PRIMARY KEY REFERENCES thread(id) ON DELETE CASCADE,
  compaction_entry_id TEXT NOT NULL,
  covered_from_seq INTEGER NOT NULL,
  covered_through_seq INTEGER NOT NULL,
  summary TEXT NOT NULL,
  details TEXT,
  tokens_before INTEGER NOT NULL DEFAULT 0,
  timestamp_iso TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS agent (
  thread_id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  agent_type TEXT NOT NULL,
  description TEXT NOT NULL,
  prompt TEXT,
  prompt_created_at INTEGER,
  agent_depth INTEGER NOT NULL,
  max_agent_depth INTEGER,
  parent_agent_id TEXT,
  model_config_json TEXT,
  tool_workspace_root TEXT,
  status TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  completed_at INTEGER,
  result TEXT,
  error TEXT,
  updated_at INTEGER NOT NULL,
  root_run_id TEXT,
  attempt_generation INTEGER NOT NULL DEFAULT 0,
  record_revision INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_agent_conversation_updated
  ON agent(conversation_id, updated_at, thread_id);
CREATE INDEX IF NOT EXISTS idx_agent_active_updated
  ON agent(conversation_id, updated_at DESC, thread_id)
  WHERE status IN ('pending', 'running');
CREATE INDEX IF NOT EXISTS idx_agent_terminal_updated
  ON agent(conversation_id, updated_at DESC, thread_id)
  WHERE status NOT IN ('pending', 'running');
CREATE INDEX IF NOT EXISTS idx_agent_status ON agent(status, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_agent_updated ON agent(updated_at);

CREATE TABLE IF NOT EXISTS durable_thread_summaries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_key TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  agent_type TEXT NOT NULL,
  content TEXT NOT NULL,
  conversation_id TEXT,
  source_updated_at INTEGER NOT NULL,
  UNIQUE (source_key)
);
CREATE INDEX IF NOT EXISTS idx_durable_thread_summaries_updated
  ON durable_thread_summaries(source_updated_at);

CREATE TABLE IF NOT EXISTS runtime_conversation_state (
  conversation_id TEXT PRIMARY KEY,
  force_reminder_on_next_turn INTEGER NOT NULL DEFAULT 0
);
`;

export const FTS_SCHEMA_SQL = `
CREATE VIRTUAL TABLE IF NOT EXISTS entry_fts USING fts5(
  search_text,
  content='entry',
  content_rowid='rowid',
  tokenize = ${FTS_TOKENIZER}
);
CREATE TRIGGER IF NOT EXISTS trg_entry_fts_insert
AFTER INSERT ON entry WHEN NEW.search_text IS NOT NULL
BEGIN
  INSERT INTO entry_fts(rowid, search_text) VALUES (NEW.rowid, NEW.search_text);
END;
CREATE TRIGGER IF NOT EXISTS trg_entry_fts_delete
AFTER DELETE ON entry WHEN OLD.search_text IS NOT NULL
BEGIN
  INSERT INTO entry_fts(entry_fts, rowid, search_text)
  VALUES ('delete', OLD.rowid, OLD.search_text);
END;
CREATE TRIGGER IF NOT EXISTS trg_entry_fts_update
AFTER UPDATE OF search_text ON entry
BEGIN
  INSERT INTO entry_fts(entry_fts, rowid, search_text)
  SELECT 'delete', OLD.rowid, OLD.search_text WHERE OLD.search_text IS NOT NULL;
  INSERT INTO entry_fts(rowid, search_text)
  SELECT NEW.rowid, NEW.search_text WHERE NEW.search_text IS NOT NULL;
END;

CREATE VIRTUAL TABLE IF NOT EXISTS thread_fts USING fts5(
  search_text,
  content='thread',
  content_rowid='rowid',
  tokenize = ${FTS_TOKENIZER}
);
CREATE TRIGGER IF NOT EXISTS trg_thread_fts_insert
AFTER INSERT ON thread WHEN NEW.search_text IS NOT NULL
BEGIN
  INSERT INTO thread_fts(rowid, search_text) VALUES (NEW.rowid, NEW.search_text);
END;
CREATE TRIGGER IF NOT EXISTS trg_thread_fts_delete
AFTER DELETE ON thread WHEN OLD.search_text IS NOT NULL
BEGIN
  INSERT INTO thread_fts(thread_fts, rowid, search_text)
  VALUES ('delete', OLD.rowid, OLD.search_text);
END;
CREATE TRIGGER IF NOT EXISTS trg_thread_fts_update
AFTER UPDATE OF search_text ON thread
BEGIN
  INSERT INTO thread_fts(thread_fts, rowid, search_text)
  SELECT 'delete', OLD.rowid, OLD.search_text WHERE OLD.search_text IS NOT NULL;
  INSERT INTO thread_fts(rowid, search_text)
  SELECT NEW.rowid, NEW.search_text WHERE NEW.search_text IS NOT NULL;
END;
`;

const readUserVersion = (db: SqliteDatabase): number => {
  const row = db.prepare("PRAGMA user_version;").get() as
    | { user_version?: number }
    | undefined;
  return typeof row?.user_version === "number" ? row.user_version : 0;
};

type Migration = {
  version: number;
  apply: (db: SqliteDatabase) => void;
};

const MIGRATIONS: Migration[] = [
  {
    version: 1,
    apply: (db) => {
      db.exec(CORE_SCHEMA_SQL);
      db.exec(FTS_SCHEMA_SQL);
      dropRetiredFeatureTables(db);
      if (legacyTablesPresent(db)) {
        importLegacyDatabase(db);
      }
      db.prepare(
        `INSERT INTO meta (key, value, updated_at) VALUES (?, '1', ?)
         ON CONFLICT(key) DO UPDATE SET value = '1', updated_at = excluded.updated_at`,
      ).run("fts_ready", Date.now());
    },
  },
];

/**
 * Rebuild both external-content FTS indexes from their content tables.
 * The maintenance entry point for a corrupted or manually cleared index —
 * never part of the boot path.
 */
export const rebuildSearchIndexes = (db: SqliteDatabase): void => {
  db.exec("INSERT INTO entry_fts(entry_fts) VALUES ('rebuild');");
  db.exec("INSERT INTO thread_fts(thread_fts) VALUES ('rebuild');");
  db.prepare(
    `INSERT INTO meta (key, value, updated_at) VALUES ('fts_ready', '1', ?)
     ON CONFLICT(key) DO UPDATE SET value = '1', updated_at = excluded.updated_at`,
  ).run(Date.now());
};

export const applyConnectionPragmas = (db: SqliteDatabase): void => {
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA synchronous = NORMAL;");
  db.exec("PRAGMA temp_store = MEMORY;");
  db.exec("PRAGMA busy_timeout = 5000;");
  db.exec("PRAGMA foreign_keys = ON;");
};

const MIGRATION_LOCK_ATTEMPTS = 12;
const MIGRATION_LOCK_RETRY_MS = 5_000;

const sleepSync = (ms: number) => {
  const buffer = new SharedArrayBuffer(4);
  Atomics.wait(new Int32Array(buffer), 0, 0, ms);
};

/**
 * Bring the database to the current schema version. A database already at
 * the current version performs no writes. Migrations run once, under an
 * exclusive transaction; a concurrent opener blocks on the lock (retrying
 * past the busy timeout) and then observes the bumped version.
 */
export const migrateDesktopDatabase = (db: SqliteDatabase): void => {
  applyConnectionPragmas(db);
  if (readUserVersion(db) >= SCHEMA_VERSION) return;

  let locked = false;
  for (let attempt = 0; attempt < MIGRATION_LOCK_ATTEMPTS; attempt += 1) {
    try {
      db.exec("BEGIN EXCLUSIVE;");
      locked = true;
      break;
    } catch (error) {
      if (!/busy|locked/i.test(String(error))) throw error;
      sleepSync(MIGRATION_LOCK_RETRY_MS);
    }
  }
  if (!locked) {
    throw new Error(
      "Could not acquire the migration lock on the desktop database.",
    );
  }
  try {
    const version = readUserVersion(db);
    for (const migration of MIGRATIONS) {
      if (migration.version <= version) continue;
      migration.apply(db);
    }
    db.exec(`PRAGMA user_version = ${SCHEMA_VERSION};`);
    db.exec("COMMIT;");
  } catch (error) {
    try {
      db.exec("ROLLBACK;");
    } catch {
      /* the transaction may already be gone */
    }
    throw error;
  }
};
