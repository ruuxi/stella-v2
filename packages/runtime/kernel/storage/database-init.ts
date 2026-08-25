import path from "path";
import type { SqliteDatabase } from "./shared.js";
import { ensurePrivateDirSync } from "../shared/private-fs.js";
import { installChatOrderingSequence } from "./chat-ordering-sequence.js";
import { ensureChatUiVisibilityIndex } from "./chat-ui-visibility.js";

const DB_FILE = "stella.sqlite";

export const ensureDatabaseStateRoot = (stellaDataDir: string) => {
  const stateRoot = stellaDataDir;
  ensurePrivateDirSync(stateRoot);
  return stateRoot;
};

export const getDesktopDatabasePath = (stellaDataDir: string) =>
  path.join(ensureDatabaseStateRoot(stellaDataDir), DB_FILE);

const TRANSCRIPT_FTS_BACKFILL_FLAG = "transcript_fts_backfilled_v1";

const TRANSCRIPT_FTS_ELIGIBLE_MESSAGE = `
  message.role IN ('user', 'assistant')
  AND message.type IN ('user_message', 'assistant_message')
`;

const dropTranscriptSearchIndex = (db: SqliteDatabase) => {
  db.exec("DROP TRIGGER IF EXISTS trg_message_text_fts_part_insert;");
  db.exec("DROP TRIGGER IF EXISTS trg_message_text_fts_part_update;");
  db.exec("DROP TRIGGER IF EXISTS trg_message_text_fts_part_delete;");
  db.exec("DROP TABLE IF EXISTS message_text_fts;");
};

const ensureTranscriptSearchIndex = (db: SqliteDatabase) => {
  try {
    db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS message_text_fts USING fts5(
        text,
        session_id UNINDEXED,
        role UNINDEXED,
        created_at UNINDEXED,
        tokenize = 'porter unicode61 remove_diacritics 2'
      );
    `);
  } catch {

    return;
  }

  db.exec(`
    CREATE TRIGGER IF NOT EXISTS trg_message_text_fts_part_insert
    AFTER INSERT ON part
    WHEN json_extract(NEW.data_json, '$.text') IS NOT NULL
    BEGIN
      INSERT INTO message_text_fts(rowid, text, session_id, role, created_at)
      SELECT
        NEW.rowid,
        json_extract(NEW.data_json, '$.text'),
        message.session_id,
        message.role,
        message.created_at
      FROM message
      WHERE message.id = NEW.message_id
        AND ${TRANSCRIPT_FTS_ELIGIBLE_MESSAGE};
    END;
  `);
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS trg_message_text_fts_part_update
    AFTER UPDATE OF data_json ON part
    BEGIN
      DELETE FROM message_text_fts WHERE rowid = OLD.rowid;
      INSERT INTO message_text_fts(rowid, text, session_id, role, created_at)
      SELECT
        NEW.rowid,
        json_extract(NEW.data_json, '$.text'),
        message.session_id,
        message.role,
        message.created_at
      FROM message
      WHERE message.id = NEW.message_id
        AND json_extract(NEW.data_json, '$.text') IS NOT NULL
        AND ${TRANSCRIPT_FTS_ELIGIBLE_MESSAGE};
    END;
  `);
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS trg_message_text_fts_part_delete
    AFTER DELETE ON part
    BEGIN
      DELETE FROM message_text_fts WHERE rowid = OLD.rowid;
    END;
  `);

  const backfilled = db
    .prepare("SELECT value FROM settings WHERE key = ?")
    .get(TRANSCRIPT_FTS_BACKFILL_FLAG);
  if (backfilled) return;
  try {
    db.exec("BEGIN IMMEDIATE;");

    db.exec("DELETE FROM message_text_fts;");
    db.exec(`
      INSERT INTO message_text_fts(rowid, text, session_id, role, created_at)
      SELECT
        part.rowid,
        json_extract(part.data_json, '$.text'),
        message.session_id,
        message.role,
        message.created_at
      FROM part
      JOIN message ON message.id = part.message_id
      WHERE json_extract(part.data_json, '$.text') IS NOT NULL
        AND ${TRANSCRIPT_FTS_ELIGIBLE_MESSAGE};
    `);
    db.prepare(
      `
      INSERT INTO settings (key, value, updated_at)
      VALUES (?, '1', ?)
      ON CONFLICT(key) DO UPDATE SET value = '1', updated_at = excluded.updated_at
    `,
    ).run(TRANSCRIPT_FTS_BACKFILL_FLAG, Date.now());
    db.exec("COMMIT;");
  } catch (error) {
    try {
      db.exec("ROLLBACK;");
    } catch {

    }

    dropTranscriptSearchIndex(db);
    throw error instanceof Error
      ? new TranscriptFtsBackfillError(error)
      : error;
  }
};

class TranscriptFtsBackfillError extends Error {
  constructor(cause: Error) {
    super(`Transcript FTS backfill failed: ${cause.message}`);
    this.name = "TranscriptFtsBackfillError";
  }
}

const THREAD_FTS_BACKFILL_FLAG = "thread_search_fts_backfilled_v2";

const THREAD_FTS_ELIGIBLE = `
  runtime_threads.agent_type != 'orchestrator'
  AND runtime_threads.thread_key NOT LIKE '%::subagent::%'
`;

const dropThreadSearchIndex = (db: SqliteDatabase) => {
  db.exec("DROP TRIGGER IF EXISTS trg_thread_search_fts_thread_insert;");
  db.exec("DROP TRIGGER IF EXISTS trg_thread_search_fts_thread_update;");
  db.exec("DROP TRIGGER IF EXISTS trg_thread_search_fts_thread_delete;");
  db.exec("DROP TRIGGER IF EXISTS trg_thread_search_fts_agent_insert;");
  db.exec("DROP TRIGGER IF EXISTS trg_thread_search_fts_agent_update;");
  db.exec("DROP TRIGGER IF EXISTS trg_thread_search_fts_agent_delete;");
  db.exec("DROP TABLE IF EXISTS thread_search_fts;");
};

const ensureThreadSearchIndex = (db: SqliteDatabase) => {
  const existingColumns = db
    .prepare("PRAGMA table_info(thread_search_fts)")
    .all() as Array<{ name?: string }>;
  if (
    existingColumns.some(
      (column) => column.name === "group_key" || column.name === "group_label",
    )
  ) {
    dropThreadSearchIndex(db);
  }
  try {
    db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS thread_search_fts USING fts5(
        thread_key,
        name,
        summary,
        description,
        result,
        error,
        tokenize = 'porter unicode61 remove_diacritics 2'
      );
    `);
  } catch {

    return;
  }

  db.exec(`
    CREATE TRIGGER IF NOT EXISTS trg_thread_search_fts_thread_insert
    AFTER INSERT ON runtime_threads
    WHEN NEW.agent_type != 'orchestrator'
      AND NEW.thread_key NOT LIKE '%::subagent::%'
    BEGIN
      DELETE FROM thread_search_fts WHERE rowid = NEW.rowid;
      INSERT INTO thread_search_fts(
        rowid, thread_key, name, summary,
        description, result, error
      )
      VALUES (
        NEW.rowid, NEW.thread_key, NEW.name, NEW.summary,
        (SELECT description FROM runtime_agents WHERE thread_id = NEW.thread_key),
        (SELECT result FROM runtime_agents WHERE thread_id = NEW.thread_key),
        (SELECT error FROM runtime_agents WHERE thread_id = NEW.thread_key)
      );
    END;
  `);

  db.exec(`
    CREATE TRIGGER IF NOT EXISTS trg_thread_search_fts_thread_update
    AFTER UPDATE OF name, summary ON runtime_threads
    WHEN NEW.agent_type != 'orchestrator'
      AND NEW.thread_key NOT LIKE '%::subagent::%'
    BEGIN
      DELETE FROM thread_search_fts WHERE rowid = OLD.rowid;
      INSERT INTO thread_search_fts(
        rowid, thread_key, name, summary,
        description, result, error
      )
      VALUES (
        NEW.rowid, NEW.thread_key, NEW.name, NEW.summary,
        (SELECT description FROM runtime_agents WHERE thread_id = NEW.thread_key),
        (SELECT result FROM runtime_agents WHERE thread_id = NEW.thread_key),
        (SELECT error FROM runtime_agents WHERE thread_id = NEW.thread_key)
      );
    END;
  `);
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS trg_thread_search_fts_thread_delete
    AFTER DELETE ON runtime_threads
    BEGIN
      DELETE FROM thread_search_fts WHERE rowid = OLD.rowid;
    END;
  `);

  db.exec(`
    CREATE TRIGGER IF NOT EXISTS trg_thread_search_fts_agent_insert
    AFTER INSERT ON runtime_agents
    BEGIN
      DELETE FROM thread_search_fts
      WHERE rowid = (
        SELECT rowid FROM runtime_threads WHERE thread_key = NEW.thread_id
      );
      INSERT INTO thread_search_fts(
        rowid, thread_key, name, summary,
        description, result, error
      )
      SELECT
        runtime_threads.rowid, runtime_threads.thread_key,
        runtime_threads.name, runtime_threads.summary,
        NEW.description, NEW.result, NEW.error
      FROM runtime_threads
      WHERE runtime_threads.thread_key = NEW.thread_id
        AND ${THREAD_FTS_ELIGIBLE};
    END;
  `);

  db.exec(`
    CREATE TRIGGER IF NOT EXISTS trg_thread_search_fts_agent_update
    AFTER UPDATE OF description, result, error ON runtime_agents
    WHEN NEW.description IS NOT OLD.description
      OR NEW.result IS NOT OLD.result
      OR NEW.error IS NOT OLD.error
    BEGIN
      DELETE FROM thread_search_fts
      WHERE rowid = (
        SELECT rowid FROM runtime_threads WHERE thread_key = NEW.thread_id
      );
      INSERT INTO thread_search_fts(
        rowid, thread_key, name, summary,
        description, result, error
      )
      SELECT
        runtime_threads.rowid, runtime_threads.thread_key,
        runtime_threads.name, runtime_threads.summary,
        NEW.description, NEW.result, NEW.error
      FROM runtime_threads
      WHERE runtime_threads.thread_key = NEW.thread_id
        AND ${THREAD_FTS_ELIGIBLE};
    END;
  `);

  db.exec(`
    CREATE TRIGGER IF NOT EXISTS trg_thread_search_fts_agent_delete
    AFTER DELETE ON runtime_agents
    BEGIN
      DELETE FROM thread_search_fts
      WHERE rowid = (
        SELECT rowid FROM runtime_threads WHERE thread_key = OLD.thread_id
      );
      INSERT INTO thread_search_fts(
        rowid, thread_key, name, summary,
        description, result, error
      )
      SELECT
        runtime_threads.rowid, runtime_threads.thread_key,
        runtime_threads.name, runtime_threads.summary,
        NULL, NULL, NULL
      FROM runtime_threads
      WHERE runtime_threads.thread_key = OLD.thread_id
        AND ${THREAD_FTS_ELIGIBLE};
    END;
  `);

  const backfilled = db
    .prepare("SELECT value FROM settings WHERE key = ?")
    .get(THREAD_FTS_BACKFILL_FLAG);
  if (backfilled) return;
  try {
    db.exec("BEGIN IMMEDIATE;");

    db.exec("DELETE FROM thread_search_fts;");
    db.exec(`
      INSERT INTO thread_search_fts(
        rowid, thread_key, name, summary,
        description, result, error
      )
      SELECT
        runtime_threads.rowid, runtime_threads.thread_key,
        runtime_threads.name, runtime_threads.summary,
        runtime_agents.description, runtime_agents.result,
        runtime_agents.error
      FROM runtime_threads
      LEFT JOIN runtime_agents
        ON runtime_agents.thread_id = runtime_threads.thread_key
      WHERE ${THREAD_FTS_ELIGIBLE};
    `);
    db.prepare(
      `
      INSERT INTO settings (key, value, updated_at)
      VALUES (?, '1', ?)
      ON CONFLICT(key) DO UPDATE SET value = '1', updated_at = excluded.updated_at
    `,
    ).run(THREAD_FTS_BACKFILL_FLAG, Date.now());
    db.exec("COMMIT;");
  } catch (error) {
    try {
      db.exec("ROLLBACK;");
    } catch {

    }

    dropThreadSearchIndex(db);
    throw error instanceof Error ? new ThreadFtsBackfillError(error) : error;
  }
};

class ThreadFtsBackfillError extends Error {
  constructor(cause: Error) {
    super(`Thread FTS backfill failed: ${cause.message}`);
    this.name = "ThreadFtsBackfillError";
  }
}

export const initializeDesktopDatabase = (db: SqliteDatabase) => {
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA synchronous = NORMAL;");
  db.exec("PRAGMA temp_store = MEMORY;");
  db.exec("PRAGMA busy_timeout = 5000;");

  db.exec("PRAGMA foreign_keys = ON;");

  db.exec(`
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS session (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'active',
      parent_id TEXT,
      workspace_path TEXT,
      sync_checkpoint_message_id TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_session_status_updated
    ON session(status, updated_at DESC, id DESC);
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS message (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      thread_key TEXT,
      run_id TEXT,
      role TEXT NOT NULL,
      type TEXT NOT NULL,
      request_id TEXT,
      device_id TEXT,
      target_device_id TEXT,
      agent_type TEXT,
      data_json TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      FOREIGN KEY(session_id) REFERENCES session(id) ON DELETE CASCADE
    );
  `);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_message_session_created
    ON message(session_id, created_at, id);
  `);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_message_thread_created
    ON message(thread_key, created_at, id);
  `);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_message_run_created
    ON message(run_id, created_at, id);
  `);

  try {
    installChatOrderingSequence(db);
  } catch (error) {
    console.error(
      "[stella:chat-ordering] sequence migration failed; falling back to legacy ordering this launch",
      error,
    );
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS part (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      message_id TEXT NOT NULL,
      ord INTEGER NOT NULL,
      type TEXT NOT NULL,
      tool_call_id TEXT,
      data_json TEXT,
      created_at INTEGER NOT NULL,
      FOREIGN KEY(session_id) REFERENCES session(id) ON DELETE CASCADE,
      FOREIGN KEY(message_id) REFERENCES message(id) ON DELETE CASCADE
    );
  `);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_part_message_ord
    ON part(message_id, ord);
  `);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_part_session_created
    ON part(session_id, created_at, id);
  `);
  ensureChatUiVisibilityIndex(db);

  try {
    ensureTranscriptSearchIndex(db);
  } catch (error) {

    if (!(error instanceof TranscriptFtsBackfillError)) throw error;
  }

  db.exec("DROP TABLE IF EXISTS chat_sync_checkpoints;");
  db.exec("DROP TABLE IF EXISTS chat_events;");
  db.exec("DROP TABLE IF EXISTS chat_conversations;");
  db.exec("DROP TABLE IF EXISTS runtime_thread_messages;");
  db.exec("DROP TABLE IF EXISTS runtime_run_events;");
  db.exec("DROP TABLE IF EXISTS runtime_memories;");
  db.exec("DROP TABLE IF EXISTS runtime_tasks;");

  db.exec(`
    CREATE TABLE IF NOT EXISTS run_event_log (
      run_id TEXT NOT NULL,
      seq INTEGER NOT NULL,
      payload_json TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (run_id, seq)
    );
  `);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_run_event_log_created
    ON run_event_log(created_at);
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS runtime_threads (
      thread_key TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL,
      agent_type TEXT NOT NULL,
      name TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      last_used_at INTEGER NOT NULL,
      summary TEXT,
      external_session_id TEXT,
      group_key TEXT,
      group_label TEXT
    );
  `);
  try {
    db.exec("ALTER TABLE runtime_threads ADD COLUMN external_session_id TEXT;");
  } catch {

  }
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_runtime_threads_conversation_status
    ON runtime_threads(conversation_id, status, last_used_at);
  `);
  db.exec("DROP INDEX IF EXISTS idx_runtime_threads_group;");

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_runtime_threads_last_used
    ON runtime_threads(last_used_at);
  `);
  db.exec("DROP INDEX IF EXISTS idx_runtime_threads_created;");

  db.exec(`
    CREATE TABLE IF NOT EXISTS runtime_thread_sessions (
      thread_key TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      version INTEGER NOT NULL,
      cwd TEXT NOT NULL DEFAULT '',
      parent_session TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      FOREIGN KEY(thread_key) REFERENCES runtime_threads(thread_key) ON DELETE CASCADE
    );
  `);

  db.exec("BEGIN IMMEDIATE;");
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS runtime_thread_entries (
        entry_id TEXT PRIMARY KEY,
        thread_key TEXT NOT NULL,
        session_id TEXT NOT NULL,
        parent_entry_id TEXT,
        entry_type TEXT NOT NULL,
        timestamp_iso TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        insertion_sequence INTEGER,
        data_json TEXT,
        FOREIGN KEY(thread_key) REFERENCES runtime_threads(thread_key) ON DELETE CASCADE
      );
    `);
    db.exec(`
      CREATE TABLE IF NOT EXISTS runtime_thread_entry_payload_chunks (
        entry_id TEXT NOT NULL,
        thread_key TEXT NOT NULL,
        chunk_index INTEGER NOT NULL,
        chunk_text TEXT NOT NULL,
        PRIMARY KEY (entry_id, chunk_index),
        FOREIGN KEY(entry_id) REFERENCES runtime_thread_entries(entry_id) ON DELETE CASCADE,
        FOREIGN KEY(thread_key) REFERENCES runtime_threads(thread_key) ON DELETE CASCADE
      );
    `);
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_runtime_thread_entry_payload_chunks_thread
      ON runtime_thread_entry_payload_chunks(thread_key, entry_id, chunk_index);
    `);
    try {
      db.exec(
        "ALTER TABLE runtime_thread_entries ADD COLUMN insertion_sequence INTEGER;",
      );
    } catch {

    }
    db.exec("DROP INDEX IF EXISTS idx_runtime_thread_entries_thread_append;");

    const needsInsertionSequenceRepair = db
      .prepare(
        `SELECT 1
         FROM runtime_thread_entries
         WHERE insertion_sequence IS NULL
         LIMIT 1`,
      )
      .get();
    if (needsInsertionSequenceRepair) {
      db.exec("DROP INDEX IF EXISTS idx_runtime_thread_entries_sequence;");
      db.exec(`
        WITH ranked_entries AS (
          SELECT
            rowid AS entry_rowid,
            ROW_NUMBER() OVER (ORDER BY rowid) AS insertion_sequence
          FROM runtime_thread_entries
        )
        UPDATE runtime_thread_entries
        SET insertion_sequence = (
          SELECT ranked_entries.insertion_sequence
          FROM ranked_entries
          WHERE ranked_entries.entry_rowid = runtime_thread_entries.rowid
        );
      `);
    }
    db.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_runtime_thread_entries_sequence
      ON runtime_thread_entries(insertion_sequence)
      WHERE insertion_sequence IS NOT NULL;
    `);
    db.exec(`
      CREATE TRIGGER IF NOT EXISTS trg_runtime_thread_entries_sequence
      AFTER INSERT ON runtime_thread_entries
      WHEN NEW.insertion_sequence IS NULL
      BEGIN
        UPDATE runtime_thread_entries
        SET insertion_sequence = (
          SELECT COALESCE(MAX(insertion_sequence), 0) + 1
          FROM runtime_thread_entries
        )
        WHERE rowid = NEW.rowid;
      END;
    `);
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_runtime_thread_entries_thread_created
      ON runtime_thread_entries(thread_key, created_at, entry_id);
    `);
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_runtime_thread_entries_thread_sequence
      ON runtime_thread_entries(thread_key, insertion_sequence);
    `);
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_runtime_thread_entries_thread_parent
      ON runtime_thread_entries(thread_key, parent_entry_id, created_at, entry_id);
    `);
    db.exec("COMMIT;");
  } catch (error) {
    try {
      db.exec("ROLLBACK;");
    } catch {

    }
    throw error;
  }

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_runtime_thread_entries_usage
    ON runtime_thread_entries(created_at, entry_id)
    WHERE entry_type = 'message'
      AND json_extract(data_json, '$.message.role') = 'assistant'
      AND json_type(data_json, '$.message.usage') = 'object';
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS runtime_agents (
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
  `);
  try {
    db.exec("ALTER TABLE runtime_agents ADD COLUMN root_run_id TEXT;");
  } catch {

  }
  try {
    db.exec("ALTER TABLE runtime_agents ADD COLUMN prompt TEXT;");
  } catch {

  }
  try {
    db.exec("ALTER TABLE runtime_agents ADD COLUMN prompt_created_at INTEGER;");
  } catch {

  }
  try {
    db.exec("ALTER TABLE runtime_agents ADD COLUMN model_config_json TEXT;");
  } catch {

  }
  try {
    db.exec(
      "ALTER TABLE runtime_agents ADD COLUMN attempt_generation INTEGER NOT NULL DEFAULT 0;",
    );
  } catch {

  }
  try {
    db.exec("ALTER TABLE runtime_agents ADD COLUMN tool_workspace_root TEXT;");
  } catch {

  }
  try {
    db.exec(
      "ALTER TABLE runtime_agents ADD COLUMN record_revision INTEGER NOT NULL DEFAULT 0;",
    );
  } catch {

  }
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_runtime_agents_conversation_updated
    ON runtime_agents(conversation_id, updated_at, thread_id);
  `);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_runtime_agents_active_updated
    ON runtime_agents(conversation_id, updated_at DESC, thread_id)
    WHERE status IN ('pending', 'running');
  `);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_runtime_agents_terminal_updated
    ON runtime_agents(conversation_id, updated_at DESC, thread_id)
    WHERE status NOT IN ('pending', 'running');
  `);

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_runtime_agents_updated
    ON runtime_agents(updated_at);
  `);

  try {
    ensureThreadSearchIndex(db);
  } catch (error) {

    if (!(error instanceof ThreadFtsBackfillError)) throw error;
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS agent_progress_summaries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      agent_id TEXT NOT NULL,
      text TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
  `);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_agent_progress_summaries_agent
    ON agent_progress_summaries(agent_id, created_at, id);
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS runtime_conversation_state (
      conversation_id TEXT PRIMARY KEY,
      force_reminder_on_next_turn INTEGER NOT NULL DEFAULT 0
    );
  `);

  db.exec("DROP TABLE IF EXISTS runtime_memory_review_state;");

  db.exec(`
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
  `);
  const legacyDreamInbox = db
    .prepare(
      "SELECT 1 AS found FROM sqlite_master WHERE type = 'table' AND name = 'dream_inbox'",
    )
    .get() as { found?: number } | undefined;
  if (legacyDreamInbox?.found === 1) {
    const columns = new Set(
      (
        db.prepare("PRAGMA table_info(dream_inbox)").all() as Array<{
          name?: string;
        }>
      )
        .map((column) => column.name)
        .filter((name): name is string => Boolean(name)),
    );
    if (!columns.has("conversation_id")) {
      db.exec("ALTER TABLE dream_inbox ADD COLUMN conversation_id TEXT;");
    }
    db.exec(`
      INSERT OR IGNORE INTO durable_thread_summaries (
        source_key, thread_id, run_id, agent_type, content, conversation_id,
        source_updated_at
      )
      SELECT source_key, thread_id, run_id, COALESCE(agent_type, 'general'),
             content, conversation_id, source_updated_at
      FROM dream_inbox
      WHERE kind = 'thread_summary'
        AND thread_id IS NOT NULL
        AND run_id IS NOT NULL;
    `);
  }
  db.exec("DROP TABLE IF EXISTS dream_inbox;");
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_durable_thread_summaries_updated
    ON durable_thread_summaries(source_updated_at);
  `);
};
