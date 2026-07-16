import path from "path";
import type { SqliteDatabase } from "./shared.js";
import { ensurePrivateDirSync } from "../shared/private-fs.js";

const DB_FILE = "stella.sqlite";

export const ensureDatabaseStateRoot = (stellaDataDir: string) => {
  const stateRoot = stellaDataDir;
  ensurePrivateDirSync(stateRoot);
  return stateRoot;
};

export const getDesktopDatabasePath = (stellaDataDir: string) =>
  path.join(ensureDatabaseStateRoot(stellaDataDir), DB_FILE);

/**
 * Full-text index over what was actually SAID in chat — the FTS5 shadow of
 * the `part` rows whose message is a user/assistant `user_message` /
 * `assistant_message` and whose payload carries `$.text`. `searchTranscripts`
 * was previously a full-table scan running `json_extract(...) LIKE '%…%'`
 * per row per token, so every recall lookup got slower as history grew; the
 * FTS table makes it an index lookup with the extraction done once, at
 * write time.
 *
 * Shape notes:
 * - The FTS rowid IS the `part` rowid. UNINDEXED columns are not queryable
 *   efficiently, so the sync triggers delete by rowid — the one key FTS5
 *   resolves without a scan.
 * - Sync is trigger-based (insert/update/delete on `part`) so EVERY writer
 *   is covered — appendEvent's delete-then-reinsert part rewrites, the
 *   third-party importers, and cascading deletes (SQLite fires child-table
 *   delete triggers for ON DELETE CASCADE), which is what keeps deleted
 *   conversations from lingering in search.
 * - `porter unicode61` stems index and query terms alike, replacing the one
 *   thing the LIKE scan did better (substring matches: "drive" ~ "drives").
 * - Backfill is one-time, guarded by a settings flag, and transactional; a
 *   failed backfill drops the whole index so search degrades to the LIKE
 *   scan instead of silently missing older history. An SQLite build without
 *   FTS5 takes the same degradation path.
 */
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
    // This SQLite build lacks FTS5 — searchTranscripts falls back to the
    // LIKE scan. Nothing else to set up.
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
    // An unset flag with rows present means a previous backfill died midway
    // (or predates the flag) — wipe and redo rather than trust a partial
    // index.
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
      // Not in a transaction — BEGIN itself failed.
    }
    // A half-built index silently loses older history; no index degrades
    // loudly to the LIKE scan and retries the backfill on the next init.
    dropTranscriptSearchIndex(db);
    throw error instanceof Error
      ? new TranscriptFtsBackfillError(error)
      : error;
  }
};

/**
 * Wraps a backfill failure so callers can tell it apart from init failures
 * that must abort startup: the transcript index is an optimization, so
 * `initializeDesktopDatabase` catches this and continues without it.
 */
class TranscriptFtsBackfillError extends Error {
  constructor(cause: Error) {
    super(`Transcript FTS backfill failed: ${cause.message}`);
    this.name = "TranscriptFtsBackfillError";
  }
}

/**
 * Full-text index over delegated agent threads — the FTS5 shadow behind
 * `searchThreads`. The LIKE scan it replaces could only see thread metadata
 * plus the agent's `description`; this index also carries the agent's final
 * `result`/`error` text, which is the only durable record of what a finished
 * thread actually did (`summary` is empty on nearly every real thread) and
 * was previously unreachable by any keyword search.
 *
 * Shape notes:
 * - The FTS rowid IS the `runtime_threads` rowid, so the sync triggers
 *   delete by rowid — the one key FTS5 resolves without a scan.
 * - MATCHING only, never ordering or payload: no volatile columns
 *   (last_used_at, status) live here, or every progress heartbeat would
 *   rewrite index rows. `searchThreads` resolves the FTS candidates back
 *   through the base tables for ordering and record fields.
 * - The `UPDATE OF` column lists on the triggers are the other half of that
 *   guarantee: `touchThread`-style heartbeats (`runtime_threads.last_used_at`)
 *   and status flips never fire them.
 * - `thread_key` is indexed because models search by id fragments
 *   ("connector-discovery"); unicode61 splits the key into those fragments.
 * - Eligibility mirrors `searchThreads`' WHERE clause and is enforced at
 *   write time, so orchestrator threads and implicit `::subagent::`
 *   transcript rows never enter the index at all.
 * - Backfill, degradation, and drop-on-failure follow the transcript index
 *   above: no FTS5 → skip; failed backfill → drop the whole index and fall
 *   back to the LIKE scan.
 */
const THREAD_FTS_BACKFILL_FLAG = "thread_search_fts_backfilled_v1";

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
  try {
    db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS thread_search_fts USING fts5(
        thread_key,
        name,
        summary,
        group_key,
        group_label,
        description,
        result,
        error,
        tokenize = 'porter unicode61 remove_diacritics 2'
      );
    `);
  } catch {
    // This SQLite build lacks FTS5 — searchThreads falls back to the LIKE
    // scan. Nothing else to set up.
    return;
  }

  // The leading DELETE makes the insert idempotent per rowid: INSERT OR
  // REPLACE on the base table would bypass the delete trigger and leave a
  // stale FTS row behind. No current writer uses OR REPLACE, but the guard
  // is one indexed delete and immunizes against future ones.
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS trg_thread_search_fts_thread_insert
    AFTER INSERT ON runtime_threads
    WHEN NEW.agent_type != 'orchestrator'
      AND NEW.thread_key NOT LIKE '%::subagent::%'
    BEGIN
      DELETE FROM thread_search_fts WHERE rowid = NEW.rowid;
      INSERT INTO thread_search_fts(
        rowid, thread_key, name, summary, group_key, group_label,
        description, result, error
      )
      VALUES (
        NEW.rowid, NEW.thread_key, NEW.name, NEW.summary,
        NEW.group_key, NEW.group_label,
        (SELECT description FROM runtime_agents WHERE thread_id = NEW.thread_key),
        (SELECT result FROM runtime_agents WHERE thread_id = NEW.thread_key),
        (SELECT error FROM runtime_agents WHERE thread_id = NEW.thread_key)
      );
    END;
  `);
  // Only the searchable columns are listed: last_used_at churns on every
  // heartbeat and status flips on evict/reactivate, and neither may rewrite
  // index rows. agent_type/thread_key are immutable in practice, so
  // eligibility can't change under an existing row.
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS trg_thread_search_fts_thread_update
    AFTER UPDATE OF name, summary, group_key, group_label ON runtime_threads
    WHEN NEW.agent_type != 'orchestrator'
      AND NEW.thread_key NOT LIKE '%::subagent::%'
    BEGIN
      DELETE FROM thread_search_fts WHERE rowid = OLD.rowid;
      INSERT INTO thread_search_fts(
        rowid, thread_key, name, summary, group_key, group_label,
        description, result, error
      )
      VALUES (
        NEW.rowid, NEW.thread_key, NEW.name, NEW.summary,
        NEW.group_key, NEW.group_label,
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

  // Agent writes rebuild the OWNING THREAD's row: the FTS rowid is the
  // thread's, and `saveAgentRecord` upserts can land before the thread row
  // exists — the INSERT..SELECT join then inserts nothing, and the later
  // thread insert picks the agent columns up via its subqueries.
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS trg_thread_search_fts_agent_insert
    AFTER INSERT ON runtime_agents
    BEGIN
      DELETE FROM thread_search_fts
      WHERE rowid = (
        SELECT rowid FROM runtime_threads WHERE thread_key = NEW.thread_id
      );
      INSERT INTO thread_search_fts(
        rowid, thread_key, name, summary, group_key, group_label,
        description, result, error
      )
      SELECT
        runtime_threads.rowid, runtime_threads.thread_key,
        runtime_threads.name, runtime_threads.summary,
        runtime_threads.group_key, runtime_threads.group_label,
        NEW.description, NEW.result, NEW.error
      FROM runtime_threads
      WHERE runtime_threads.thread_key = NEW.thread_id
        AND ${THREAD_FTS_ELIGIBLE};
    END;
  `);
  // status/updated_at churn on every agent heartbeat and are deliberately
  // absent from this UPDATE OF list. The WHEN clause closes the remaining
  // hole: saveAgentRecord's upsert SETs every column, and UPDATE OF fires on
  // SET-list MEMBERSHIP, not value change — without it every agent save
  // rebuilt the FTS row. IS NOT is the null-safe inequality.
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
        rowid, thread_key, name, summary, group_key, group_label,
        description, result, error
      )
      SELECT
        runtime_threads.rowid, runtime_threads.thread_key,
        runtime_threads.name, runtime_threads.summary,
        runtime_threads.group_key, runtime_threads.group_label,
        NEW.description, NEW.result, NEW.error
      FROM runtime_threads
      WHERE runtime_threads.thread_key = NEW.thread_id
        AND ${THREAD_FTS_ELIGIBLE};
    END;
  `);
  // The thread row can outlive its agent record, so a deleted agent strips
  // the agent columns from the thread's row rather than dropping it.
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS trg_thread_search_fts_agent_delete
    AFTER DELETE ON runtime_agents
    BEGIN
      DELETE FROM thread_search_fts
      WHERE rowid = (
        SELECT rowid FROM runtime_threads WHERE thread_key = OLD.thread_id
      );
      INSERT INTO thread_search_fts(
        rowid, thread_key, name, summary, group_key, group_label,
        description, result, error
      )
      SELECT
        runtime_threads.rowid, runtime_threads.thread_key,
        runtime_threads.name, runtime_threads.summary,
        runtime_threads.group_key, runtime_threads.group_label,
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
    // An unset flag with rows present means a previous backfill died midway
    // (or predates the flag) — wipe and redo rather than trust a partial
    // index.
    db.exec("DELETE FROM thread_search_fts;");
    db.exec(`
      INSERT INTO thread_search_fts(
        rowid, thread_key, name, summary, group_key, group_label,
        description, result, error
      )
      SELECT
        runtime_threads.rowid, runtime_threads.thread_key,
        runtime_threads.name, runtime_threads.summary,
        runtime_threads.group_key, runtime_threads.group_label,
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
      // Not in a transaction — BEGIN itself failed.
    }
    // A half-built index silently loses older threads; no index degrades
    // loudly to the LIKE scan and retries the backfill on the next init.
    dropThreadSearchIndex(db);
    throw error instanceof Error ? new ThreadFtsBackfillError(error) : error;
  }
};

/**
 * Same contract as `TranscriptFtsBackfillError`: the thread index is an
 * optimization, so `initializeDesktopDatabase` catches this and continues
 * without it.
 */
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
  // Per-connection in SQLite (OFF by default) — without it every ON DELETE
  // CASCADE declared below is inert. Every connection funnels through this
  // initializer, and no writer uses INSERT OR REPLACE on a parent table, so
  // enforcement cannot trigger a surprise delete-then-cascade.
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

  try {
    ensureTranscriptSearchIndex(db);
  } catch (error) {
    // The transcript index is an optimization — a failed backfill (e.g. a
    // malformed legacy row) must not brick startup. The index was dropped,
    // so search degrades to the LIKE scan.
    if (!(error instanceof TranscriptFtsBackfillError)) throw error;
  }

  db.exec("DROP TABLE IF EXISTS chat_sync_checkpoints;");
  db.exec("DROP TABLE IF EXISTS chat_events;");
  db.exec("DROP TABLE IF EXISTS chat_conversations;");
  db.exec("DROP TABLE IF EXISTS runtime_thread_messages;");
  db.exec("DROP TABLE IF EXISTS runtime_run_events;");
  db.exec("DROP TABLE IF EXISTS runtime_memories;");
  db.exec("DROP TABLE IF EXISTS runtime_tasks;");

  // Worker-side ring buffer of streamed run events. Each row represents one
  // notification the worker sent to a connected client over JSON-RPC. The
  // client (Electron host) subscribes via NOTIFICATION_NAMES.RUN_EVENT and
  // is expected to ack with run.ackEvents { runId, lastSeq } so the worker
  // can prune. On host reconnect (after Electron restart, mini-window
  // open, etc.) the new client calls run.resumeEvents { runId, lastSeq }
  // to replay everything past `lastSeq`. The fallback retention is the
  // periodic time-based sweep below — acks are an optimization, not a
  // correctness requirement.
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
    // Column already exists.
  }
  try {
    db.exec("ALTER TABLE runtime_threads ADD COLUMN group_key TEXT;");
  } catch {
    // Column already exists.
  }
  try {
    db.exec("ALTER TABLE runtime_threads ADD COLUMN group_label TEXT;");
  } catch {
    // Column already exists.
  }
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_runtime_threads_conversation_status
    ON runtime_threads(conversation_id, status, last_used_at);
  `);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_runtime_threads_group
    ON runtime_threads(group_key);
  `);
  // Recall's thread index selects "most recent N by last-active" across ALL
  // conversations; these global recency indexes let that query walk two
  // index scans instead of full-scanning + temp-sorting the tables.
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_runtime_threads_last_used
    ON runtime_threads(last_used_at);
  `);
  // Recall's adaptive-limit preflight counts threads created in the last
  // day on every call; this recency index keeps that COUNT a range scan
  // instead of a full-table scan over all history.
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_runtime_threads_created
    ON runtime_threads(created_at);
  `);

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

  db.exec(`
    CREATE TABLE IF NOT EXISTS runtime_thread_entries (
      entry_id TEXT PRIMARY KEY,
      thread_key TEXT NOT NULL,
      session_id TEXT NOT NULL,
      parent_entry_id TEXT,
      entry_type TEXT NOT NULL,
      timestamp_iso TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      data_json TEXT,
      FOREIGN KEY(thread_key) REFERENCES runtime_threads(thread_key) ON DELETE CASCADE
    );
  `);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_runtime_thread_entries_thread_created
    ON runtime_thread_entries(thread_key, created_at, entry_id);
  `);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_runtime_thread_entries_thread_parent
    ON runtime_thread_entries(thread_key, parent_entry_id, created_at, entry_id);
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS runtime_agents (
      thread_id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL,
      agent_type TEXT NOT NULL,
      description TEXT NOT NULL,
      agent_depth INTEGER NOT NULL,
      max_agent_depth INTEGER,
      parent_agent_id TEXT,
      model_config_json TEXT,
      status TEXT NOT NULL,
      started_at INTEGER NOT NULL,
      completed_at INTEGER,
      result TEXT,
      error TEXT,
      updated_at INTEGER NOT NULL,
      root_run_id TEXT,
      attempt_generation INTEGER NOT NULL DEFAULT 0
    );
  `);
  try {
    db.exec("ALTER TABLE runtime_agents ADD COLUMN root_run_id TEXT;");
  } catch {
    // Column already exists.
  }
  try {
    db.exec("ALTER TABLE runtime_agents ADD COLUMN model_config_json TEXT;");
  } catch {
    // Column already exists.
  }
  try {
    db.exec(
      "ALTER TABLE runtime_agents ADD COLUMN attempt_generation INTEGER NOT NULL DEFAULT 0;",
    );
  } catch {
    // Column already exists.
  }
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_runtime_agents_conversation_updated
    ON runtime_agents(conversation_id, updated_at, thread_id);
  `);
  // Second half of the recall-index recency scan (see runtime_threads
  // counterpart above): a running turn bumps only the agent record, so
  // "recently active" candidates also come from agent updated_at order.
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_runtime_agents_updated
    ON runtime_agents(updated_at);
  `);

  // Must run AFTER runtime_threads and runtime_agents exist — the sync
  // triggers reference both tables.
  try {
    ensureThreadSearchIndex(db);
  } catch (error) {
    // Same degradation contract as the transcript index above: the thread
    // index is an optimization, and searchThreads falls back to its LIKE
    // scan once the failed index is dropped.
    if (!(error instanceof ThreadFtsBackfillError)) throw error;
  }
  // Rolling per-agent progress-summary phrases ("searching documentation for
  // rate limits"), generated by the renderer's progress-summary engine and
  // mirrored here so runtime consumers (Recall) can report what a running
  // agent is doing right now without interrupting it. Ring buffer per agent:
  // each publish replaces that agent's rows wholesale (newest ≤5 phrases).
  // `agent_id` is the runtime thread id (`runtime_agents.thread_id`).
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
      reminder_tokens_since_last_injection INTEGER NOT NULL DEFAULT 0,
      force_reminder_on_next_turn INTEGER NOT NULL DEFAULT 0
    );
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS runtime_memory_review_state (
      conversation_id TEXT PRIMARY KEY,
      user_turns_since_review INTEGER NOT NULL DEFAULT 0,
      last_review_at INTEGER,
      last_reviewed_message_ts INTEGER
    );
  `);
  try {
    db.exec(
      "ALTER TABLE runtime_memory_review_state ADD COLUMN last_reviewed_message_ts INTEGER;",
    );
  } catch {
    // Column already exists.
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS social_session_sync_state (
      session_id TEXT PRIMARY KEY,
      local_folder_path TEXT NOT NULL,
      local_folder_name TEXT NOT NULL,
      role TEXT NOT NULL,
      last_applied_file_op_ordinal INTEGER NOT NULL DEFAULT 0,
      last_observed_turn_ordinal INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL
    );
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS social_session_files (
      session_id TEXT NOT NULL,
      relative_path TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      size_bytes INTEGER NOT NULL,
      mtime_ms INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (session_id, relative_path)
    );
  `);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_social_session_files_session
    ON social_session_files(session_id, updated_at);
  `);

  // Unified Dream inbox: every durable input Dream consolidates flows through
  // this one queue — subagent rollout summaries, orchestrator memory-review
  // notes, and chronicle screen-activity digests. `processed_by_dream_at IS
  // NULL` is the entire queue state; there is no separate watermark file.
  // Replaces the pre-launch `thread_summaries` table (hard cut, no migration).
  db.exec("DROP TABLE IF EXISTS thread_summaries;");
  db.exec(`
    CREATE TABLE IF NOT EXISTS dream_inbox (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      kind TEXT NOT NULL,
      source_key TEXT NOT NULL,
      thread_id TEXT,
      run_id TEXT,
      agent_type TEXT,
      title TEXT,
      content TEXT NOT NULL,
      metadata TEXT,
      source_updated_at INTEGER NOT NULL,
      processed_by_dream_at INTEGER,
      usage_count INTEGER NOT NULL DEFAULT 0,
      last_usage INTEGER,
      UNIQUE (kind, source_key)
    );
  `);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_dream_inbox_unprocessed
    ON dream_inbox(processed_by_dream_at, source_updated_at);
  `);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_dream_inbox_kind_updated
    ON dream_inbox(kind, source_updated_at);
  `);
};
