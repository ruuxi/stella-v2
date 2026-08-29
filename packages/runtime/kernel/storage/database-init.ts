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
 *   failed backfill drops the whole index so search surfaces a typed degraded
 *   state instead of silently missing older history. An SQLite build without
 *   FTS5 takes the same degradation path; LIKE requires an explicit opt-in.
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
    // This SQLite build lacks FTS5 — searchTranscripts will surface a typed
    // degraded state. Nothing else to set up.
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
    // loudly and retries the backfill on the next init.
    dropTranscriptSearchIndex(db);
    throw error instanceof Error
      ? new TranscriptFtsBackfillError(error)
      : error;
  }
};

/**
 * Wraps a backfill failure so callers can tell it apart from init failures
 * that must abort startup: the transcript index is an optimization, so
 * `initializeDesktopDatabase` catches this and continues without it; Recall's
 * FTS preflight and SessionStore then expose the degraded state.
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
 *   above: no FTS5 → skip; failed backfill → drop the whole index and expose
 *   typed degradation unless a caller explicitly requests LIKE mode.
 */
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
    // This SQLite build lacks FTS5 — searchThreads will surface a typed
    // degraded state. Nothing else to set up.
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
  // Only the searchable columns are listed: last_used_at churns on every
  // heartbeat and status flips on evict/reactivate, and neither may rewrite
  // index rows. agent_type/thread_key are immutable in practice, so
  // eligibility can't change under an existing row.
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
    // An unset flag with rows present means a previous backfill died midway
    // (or predates the flag) — wipe and redo rather than trust a partial
    // index.
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
      // Not in a transaction — BEGIN itself failed.
    }
    // A half-built index silently loses older threads; no index degrades
    // loudly and retries the backfill on the next init.
    dropThreadSearchIndex(db);
    throw error instanceof Error ? new ThreadFtsBackfillError(error) : error;
  }
};

/**
 * Same contract as `TranscriptFtsBackfillError`: the thread index is an
 * optimization, so `initializeDesktopDatabase` catches this and continues
 * without it; callers then see the typed degraded state.
 */
class ThreadFtsBackfillError extends Error {
  constructor(cause: Error) {
    super(`Thread FTS backfill failed: ${cause.message}`);
    this.name = "ThreadFtsBackfillError";
  }
}

/**
 * Migrates durable thread-entry ordering as one serialized schema transition.
 *
 * A previous initializer backfilled the sequence column, then created the
 * uniqueness index and insert trigger in separate autocommit statements. A
 * second connection could insert in those gaps, leaving NULLs or assigning a
 * sequence that collided with the backfill. BEGIN IMMEDIATE takes SQLite's
 * writer reservation before inspecting or changing the table, so concurrent
 * appenders see either the legacy schema or the complete migrated schema.
 *
 * If an interrupted/older migration left any invalid value or collision, all
 * rows are deliberately re-densified by rowid. rowid is the only authoritative
 * pre-migration insertion order; valid unique sequences are otherwise retained
 * verbatim so repeated startup never renumbers durable history.
 */
const ensureRuntimeThreadEntryOrdering = (db: SqliteDatabase) => {
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
    const insertionSequenceColumn = db
      .prepare(
        `SELECT 1
         FROM pragma_table_info('runtime_thread_entries')
         WHERE name = 'insertion_sequence'`,
      )
      .get();
    if (!insertionSequenceColumn) {
      db.exec(
        "ALTER TABLE runtime_thread_entries ADD COLUMN insertion_sequence INTEGER;",
      );
    }

    db.exec("DROP INDEX IF EXISTS idx_runtime_thread_entries_thread_append;");

    const invalidSequence = db
      .prepare(
        `SELECT 1
         FROM runtime_thread_entries
         GROUP BY insertion_sequence
         HAVING insertion_sequence IS NULL
           OR typeof(insertion_sequence) != 'integer'
           OR insertion_sequence <= 0
           OR COUNT(*) > 1
         LIMIT 1`,
      )
      .get();

    // Recreate both enforcement objects even when the data is already valid:
    // IF NOT EXISTS alone would trust a partial migration that left a
    // non-unique same-named index or an obsolete trigger body.
    db.exec("DROP TRIGGER IF EXISTS trg_runtime_thread_entries_sequence;");
    db.exec("DROP INDEX IF EXISTS idx_runtime_thread_entries_sequence;");

    if (invalidSequence) {
      db.exec(`
        WITH ranked_entries AS (
          SELECT
            rowid,
            ROW_NUMBER() OVER (ORDER BY rowid) AS insertion_sequence
          FROM runtime_thread_entries
        )
        UPDATE runtime_thread_entries
        SET insertion_sequence = (
          SELECT ranked_entries.insertion_sequence
          FROM ranked_entries
          WHERE ranked_entries.rowid = runtime_thread_entries.rowid
        );
      `);
    }

    db.exec(`
      CREATE UNIQUE INDEX idx_runtime_thread_entries_sequence
      ON runtime_thread_entries(insertion_sequence)
      WHERE insertion_sequence IS NOT NULL;
    `);
    db.exec(`
      CREATE TRIGGER trg_runtime_thread_entries_sequence
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
      // BEGIN itself failed, or SQLite already rolled the transaction back.
    }
    throw error;
  }
};

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
    CREATE INDEX IF NOT EXISTS idx_session_status_updated
    ON session(status, updated_at DESC, id DESC);
    CREATE TABLE IF NOT EXISTS legacy_chat_cloud_import (
      local_conversation_id TEXT PRIMARY KEY,
      cloud_conversation_id TEXT,
      owner_generation TEXT,
      next_turn_index INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'pending',
      detail TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      FOREIGN KEY(local_conversation_id) REFERENCES session(id) ON DELETE CASCADE
    );
  `);
  try {
    db.exec(
      "ALTER TABLE legacy_chat_cloud_import ADD COLUMN owner_generation TEXT;",
    );
  } catch {
    // Existing databases may already have the immutable import authority.
  }
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

  // Chat-ordering re-architecture: the dedicated, never-reused monotonic
  // ordering key on `message` is the default ordering key. The migration runs
  // unconditionally — it is idempotent (a fully-migrated DB just re-checks the
  // trigger), chunked/resumable so a large history never holds the write lock
  // long or hangs launch, and order-preserving (existing rows keep their
  // current (created_at, id) display order).
  //
  // Contained on the launch-critical path: a failure (SQLITE_BUSY past the
  // busy_timeout, disk-full, IO error, an interrupted-migration UNIQUE) must
  // NOT block desktop startup. On failure we log and continue with the column
  // absent or partially backfilled; the store's `orderingBySequence` gate then
  // transparently falls back to the legacy (created_at, id) ordering, and the
  // resumable migration retries on the next launch.
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
    // A failed backfill (e.g. a malformed legacy row) must not brick
    // startup: the index is dropped and keyword search then fails loudly
    // with FtsSearchUnavailableError ([stella:recall:fts-degraded]) until
    // the index rebuilds. LIKE scans run only when a caller explicitly opts
    // in via degradedMode: "like" — never as a silent fallback.
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
  // can prune. On host reconnect (for example, after Electron restart) the
  // new client calls run.resumeEvents { runId, lastSeq }
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
      external_delivered_entry_id TEXT,
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
    db.exec(
      "ALTER TABLE runtime_threads ADD COLUMN external_delivered_entry_id TEXT;",
    );
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
  db.exec("DROP INDEX IF EXISTS idx_runtime_threads_group;");
  // Recall's thread index selects "most recent N by last-active" across ALL
  // conversations; these global recency indexes let that query walk two
  // index scans instead of full-scanning + temp-sorting the tables.
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

  // Keep the column backfill and trigger installation under one writer lock.
  // Without it, an already-running process can insert NULL rows after the
  // backfill but before the trigger exists, leaving a partially migrated DB.
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
      // Column already exists.
    }
    db.exec("DROP INDEX IF EXISTS idx_runtime_thread_entries_thread_append;");
    // Timestamp-prefixed entry ids have a random suffix, so neither
    // `(created_at, entry_id)` nor the timestamp alone records append order.
    // Preserve the current SQLite insertion order for legacy rows once, then
    // assign a durable ordinal to every future row. If an older migration was
    // interrupted between its backfill and trigger creation, re-rank the whole
    // table so its NULL rows regain their real positions without colliding with
    // sequence values that later inserts already claimed.
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
      // Preserve the original migration failure.
    }
    throw error;
  }
  // The usage ledger reads only assistant messages that carry a usage
  // object; this partial index keeps that projection a recency scan
  // instead of json_extract-ing every thread entry. Its WHERE terms must
  // stay textually in sync with the static clauses in listModelUsage so
  // SQLite's partial-index prover keeps matching them.
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
      storage_mode TEXT NOT NULL DEFAULT 'local',
      owner_generation TEXT,
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
      manager_final_report TEXT,
      manager_final_report_id TEXT,
      manager_report_ids_json TEXT,
      manager_report_sequence INTEGER NOT NULL DEFAULT 0,
      cloud_terminal_receipt_generation INTEGER,
      terminal_lifecycle_receipt_generation INTEGER,
      descendant_boundary_state_json TEXT,
      record_revision INTEGER NOT NULL DEFAULT 0
    );
  `);
  try {
    db.exec("ALTER TABLE runtime_agents ADD COLUMN root_run_id TEXT;");
  } catch {
    // Column already exists.
  }
  try {
    db.exec("ALTER TABLE runtime_agents ADD COLUMN prompt TEXT;");
  } catch {
    // Column already exists.
  }
  try {
    db.exec("ALTER TABLE runtime_agents ADD COLUMN prompt_created_at INTEGER;");
  } catch {
    // Column already exists.
  }
  try {
    db.exec(
      "ALTER TABLE runtime_agents ADD COLUMN storage_mode TEXT NOT NULL DEFAULT 'local';",
    );
  } catch {
    // Column already exists.
  }
  try {
    db.exec("ALTER TABLE runtime_agents ADD COLUMN owner_generation TEXT;");
  } catch {
    // Column already exists. NULL cloud rows predate generation fencing and
    // are quarantined from cloud replay by LocalAgentManager.
  }
  for (const column of [
    "manager_final_report TEXT",
    "manager_final_report_id TEXT",
    "manager_report_ids_json TEXT",
    "manager_report_sequence INTEGER NOT NULL DEFAULT 0",
  ]) {
    try {
      db.exec(`ALTER TABLE runtime_agents ADD COLUMN ${column};`);
    } catch {
      // Column already exists.
    }
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
  try {
    db.exec("ALTER TABLE runtime_agents ADD COLUMN tool_workspace_root TEXT;");
  } catch {
    // Column already exists.
  }
  try {
    db.exec(
      "ALTER TABLE runtime_agents ADD COLUMN record_revision INTEGER NOT NULL DEFAULT 0;",
    );
  } catch {
    // Column already exists.
  }
  try {
    db.exec(
      "ALTER TABLE runtime_agents ADD COLUMN cloud_terminal_receipt_generation INTEGER;",
    );
  } catch {
    // Column already exists.
  }
  try {
    db.exec(
      "ALTER TABLE runtime_agents ADD COLUMN terminal_lifecycle_receipt_generation INTEGER;",
    );
  } catch {
    // Column already exists.
  }
  try {
    db.exec(
      "ALTER TABLE runtime_agents ADD COLUMN descendant_boundary_state_json TEXT;",
    );
  } catch {
    // Column already exists.
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
    // index is an optimization, and its absence is surfaced to Recall once
    // the failed index is dropped.
    if (!(error instanceof ThreadFtsBackfillError)) throw error;
  }
  // Legacy generated-summary table retained for schema compatibility with
  // existing databases. New runtimes do not write or read these rows; live
  // Activity updates come from persisted assistant-authored transcript text.
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

  // Durable desktop-to-cloud transcript outbox. Cloud conversations use the
  // Durable Object as their transcript authority, but a local provider turn
  // still has two network boundaries (begin and finish). Both boundaries are
  // committed here before any request is attempted so a worker restart or an
  // offline finish cannot silently lose the turn.
  db.exec(`
    CREATE TABLE IF NOT EXISTS cloud_transcript_outbox (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL CHECK (kind IN ('begin', 'finish')),
      conversation_id TEXT NOT NULL,
      device_id TEXT NOT NULL,
      owner_generation TEXT NOT NULL,
      local_turn_id TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      recovery_json TEXT,
      attempts INTEGER NOT NULL DEFAULT 0,
      last_error TEXT,
      dead_lettered_at INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `);
  for (const column of [
    "owner_generation TEXT",
    "recovery_json TEXT",
    "last_error TEXT",
    "dead_lettered_at INTEGER",
  ]) {
    try {
      db.exec(`ALTER TABLE cloud_transcript_outbox ADD COLUMN ${column};`);
    } catch {
      // Column already exists.
    }
  }
  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_cloud_transcript_outbox_turn_kind
    ON cloud_transcript_outbox(
      conversation_id,
      device_id,
      local_turn_id,
      kind
    );
  `);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_cloud_transcript_outbox_created
    ON cloud_transcript_outbox(created_at, id);
  `);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_cloud_transcript_outbox_delivery
    ON cloud_transcript_outbox(
      dead_lettered_at,
      attempts,
      updated_at,
      created_at,
      id
    );
  `);

  // Ordered, durable foreign journal appends (currently realtime voice).
  // `sequence` is the local admission order. The delivery loop never skips a
  // retryable row, so provider transcripts and tool pairs cannot overtake one
  // another while a cloud/text turn owns the conversation.
  db.exec(`
    CREATE TABLE IF NOT EXISTS cloud_journal_outbox (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      id TEXT NOT NULL UNIQUE,
      conversation_id TEXT NOT NULL,
      device_id TEXT NOT NULL,
      owner_generation TEXT NOT NULL,
      append_id TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      last_error TEXT,
      dead_lettered_at INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `);
  try {
    db.exec(
      "ALTER TABLE cloud_journal_outbox ADD COLUMN owner_generation TEXT;",
    );
  } catch {
    // Existing rows remain NULL and are retired without delivery. Never bind
    // an old voice append to whichever owner generation is current now.
  }
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_cloud_journal_outbox_delivery
    ON cloud_journal_outbox(
      dead_lettered_at,
      sequence
    );
  `);

  // Computer agents execute locally while their canonical lifecycle row lives
  // in Convex. Admit start/terminal/cancel transitions here before attempting
  // the network so auth loss, an offline desktop, or a worker restart cannot
  // leave browser Activity permanently divergent from the local executor.
  // Sequence order is the causal fence: a terminal from generation N can
  // never overtake its start, and generation N+1 cannot overtake generation N.
  db.exec(`
    CREATE TABLE IF NOT EXISTS computer_agent_cloud_outbox (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      id TEXT NOT NULL UNIQUE,
      kind TEXT NOT NULL CHECK (kind IN ('start', 'terminal', 'cancel')),
      thread_id TEXT NOT NULL,
      attempt_generation INTEGER NOT NULL,
      owner_scope TEXT,
      owner_generation TEXT,
      payload_json TEXT NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      next_attempt_at INTEGER NOT NULL,
      last_error TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `);
  try {
    db.exec(
      "ALTER TABLE computer_agent_cloud_outbox ADD COLUMN owner_scope TEXT;",
    );
  } catch {
    // Column already exists. NULL rows are legacy and intentionally never
    // attach themselves to whichever account happens to sign in next.
  }
  try {
    db.exec(
      "ALTER TABLE computer_agent_cloud_outbox ADD COLUMN owner_generation TEXT;",
    );
  } catch {
    // Column already exists. NULL rows predate owner-generation fencing and
    // are never rebound to a later lifecycle epoch.
  }
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_computer_agent_cloud_outbox_delivery
    ON computer_agent_cloud_outbox(next_attempt_at, sequence);
  `);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_computer_agent_cloud_outbox_owner_delivery
    ON computer_agent_cloud_outbox(owner_scope, next_attempt_at, sequence);
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS computer_agent_cloud_thread_owners (
      thread_id TEXT PRIMARY KEY,
      owner_scope TEXT NOT NULL,
      owner_generation TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `);
  try {
    db.exec(
      "ALTER TABLE computer_agent_cloud_thread_owners ADD COLUMN owner_generation TEXT;",
    );
  } catch {
    // Column already exists. NULL is an intentionally untrusted legacy bind.
  }
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_computer_agent_cloud_thread_owners_scope
    ON computer_agent_cloud_thread_owners(owner_scope, updated_at);
  `);
  // An owner-data generation is an immutable lifecycle epoch. Remember every
  // retired epoch so a delayed generation-N start can never rebind a mutable
  // thread id after generation N+1 has already been admitted (ABA).
  db.exec(`
    CREATE TABLE IF NOT EXISTS computer_agent_cloud_retired_generations (
      thread_id TEXT NOT NULL,
      owner_scope TEXT NOT NULL,
      owner_generation TEXT NOT NULL,
      retired_at INTEGER NOT NULL,
      PRIMARY KEY (thread_id, owner_scope, owner_generation)
    );
  `);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_computer_agent_cloud_retired_scope
    ON computer_agent_cloud_retired_generations(owner_scope, retired_at);
  `);

  // Local admission receipts outlive successful outbox deletion so an IPC
  // response lost after commit still replays as the same voice event instead
  // of duplicating the operational thread mirror. They are not transcript
  // content and expire after the renderer retry/restart horizon.
  db.exec(`
    CREATE TABLE IF NOT EXISTS cloud_journal_admission_receipts (
      id TEXT PRIMARY KEY,
      payload_json TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
  `);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_cloud_journal_admission_receipts_created
    ON cloud_journal_admission_receipts(created_at, id);
  `);

  // Desktop cloud-agent controls have two durable identities: the latest
  // authoritative server receipt for a thread, and the immutable tool-call
  // operation that captured that receipt before crossing the network. The
  // former fences send_input/pause against attempt ABA; the latter makes a
  // lost response replay the original generation/expected revision after a
  // process restart instead of adopting whichever attempt is current then.
  db.exec(`
    CREATE TABLE IF NOT EXISTS cloud_agent_thread_controls (
      thread_id TEXT NOT NULL,
      owner_generation TEXT NOT NULL,
      cloud_conversation_id TEXT NOT NULL,
      origin_conversation_id TEXT NOT NULL,
      attempt_generation INTEGER NOT NULL,
      thread_updated_at INTEGER NOT NULL,
      status TEXT NOT NULL CHECK (
        status IN ('running', 'completed', 'failed', 'canceled')
      ),
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (thread_id, owner_generation)
    );
  `);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_cloud_agent_thread_controls_origin
    ON cloud_agent_thread_controls(
      owner_generation,
      origin_conversation_id,
      updated_at
    );
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS cloud_agent_tool_operations (
      operation_id TEXT PRIMARY KEY,
      kind TEXT NOT NULL CHECK (kind IN ('spawn', 'continue', 'cancel')),
      fingerprint TEXT NOT NULL,
      owner_generation TEXT NOT NULL,
      request_json TEXT NOT NULL,
      result_json TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_cloud_agent_tool_operations_updated
    ON cloud_agent_tool_operations(updated_at, operation_id);
  `);

  // Connector routing and follow-up delivery are operational state, not chat
  // history. Keeping them in SQLite lets a terminal spawned-agent notice
  // survive host/auth/network restarts without reintroducing a local
  // conversation transcript.
  db.exec(`
    CREATE TABLE IF NOT EXISTS connector_followup_targets (
      conversation_id TEXT PRIMARY KEY,
      request_id TEXT NOT NULL,
      backend_conversation_id TEXT NOT NULL,
      initial_turn_completed INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_connector_followup_targets_request
    ON connector_followup_targets(request_id);
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS connector_followup_outbox (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      delivery_id TEXT NOT NULL UNIQUE,
      request_id TEXT NOT NULL,
      backend_conversation_id TEXT NOT NULL,
      text TEXT NOT NULL,
      eligible_at INTEGER,
      attempts INTEGER NOT NULL DEFAULT 0,
      next_attempt_at INTEGER NOT NULL,
      last_error TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_connector_followup_outbox_delivery
    ON connector_followup_outbox(eligible_at, next_attempt_at, sequence);
  `);
  // Renderer-to-main pre-admission for realtime voice. Main inserts here
  // synchronously before awaiting the runtime worker; successful worker
  // admission deletes the row. This is operational delivery state only.
  db.exec(`
    CREATE TABLE IF NOT EXISTS voice_transcript_inbox (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      event_id TEXT NOT NULL UNIQUE,
      payload_json TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
  `);
  // Operational idempotency ledger for side-effecting realtime voice tools.
  // A pending row fails closed after a worker crash; completed rows cache the
  // exact cloud append and IPC result so an invoke replay never executes the
  // tool twice or changes the journal payload.
  db.exec(`
    CREATE TABLE IF NOT EXISTS voice_tool_call_receipts (
      conversation_id TEXT NOT NULL,
      call_id TEXT NOT NULL,
      request_fingerprint TEXT NOT NULL,
      operation_id TEXT NOT NULL,
      started_at INTEGER NOT NULL,
      completion_json TEXT,
      completed_at INTEGER,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (conversation_id, call_id)
    );
  `);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_voice_tool_call_receipts_completed
    ON voice_tool_call_receipts(completed_at, updated_at);
  `);

  // Retained delegated-work summaries live independently of the retired
  // automatic memory pipeline. Existing thread-summary rows are migrated
  // once before the obsolete queue is dropped.
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
  db.exec("DROP TABLE IF EXISTS dream_consolidation_watermark;");
  db.exec("DROP TABLE IF EXISTS dream_delta_watermark;");
  db.exec("DROP TABLE IF EXISTS dream_scheduler_state;");
};
