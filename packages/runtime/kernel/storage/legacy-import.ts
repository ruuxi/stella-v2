/**
 * One-time import of a pre-v1 (unversioned) desktop database into the v1
 * schema. Runs inside the migration transaction, exactly once; afterwards
 * every legacy table, trigger, and bookkeeping row is gone.
 *
 * Legacy shape being imported:
 *   session / message / part            -> conversation / entry
 *   runtime_threads / runtime_thread_sessions -> thread
 *   runtime_thread_entries (+ payload chunks) -> thread_entry (+ blob)
 *   latest compaction entry             -> thread_context (materialized)
 *   runtime_agents                      -> agent
 *   message_text_fts / thread_search_fts / ordering counter / run_event_log
 *                                       -> dropped (rebuilt or relocated)
 */

import type { SqliteDatabase } from "./shared.js";
import { parseJsonValue } from "./view.js";

const ULID_GLOB_FILTER =
  "length(id) = 26 AND id NOT GLOB '*[^0123456789ABCDEFGHJKMNPQRSTVWXYZ]*'";

const LEGACY_EXACT_PAYLOAD_MARKER = "__stellaExactPayloadChunks";

const tableExists = (db: SqliteDatabase, name: string): boolean =>
  Boolean(
    db
      .prepare(
        "SELECT 1 FROM sqlite_master WHERE type IN ('table', 'view') AND name = ?",
      )
      .get(name),
  );

const hasColumn = (
  db: SqliteDatabase,
  table: string,
  column: string,
): boolean => {
  const rows = db.prepare(`PRAGMA table_info(${table});`).all() as {
    name?: unknown;
  }[];
  return rows.some((row) => row.name === column);
};

export const legacyTablesPresent = (db: SqliteDatabase): boolean =>
  tableExists(db, "session") && tableExists(db, "message");

/**
 * Retired-feature tables (automatic memory / dream inbox) are dropped
 * outright — those features no longer exist, so nothing is imported.
 */
export const dropRetiredFeatureTables = (db: SqliteDatabase): void => {
  db.exec("DROP TABLE IF EXISTS dream_inbox;");
  db.exec("DROP TABLE IF EXISTS runtime_memory_review_state;");
};

const importConversations = (db: SqliteDatabase): void => {
  db.exec(`
    INSERT OR IGNORE INTO conversation (
      id, kind, title, status, next_seq, created_at, updated_at
    )
    SELECT
      id,
      CASE WHEN ${ULID_GLOB_FILTER} THEN 'chat' ELSE 'derived' END,
      COALESCE(title, ''),
      COALESCE(status, 'active'),
      1,
      created_at,
      updated_at
    FROM session;
  `);
};

const importChatEntries = (db: SqliteDatabase): void => {
  const hasOrderingSequence = hasColumn(db, "message", "ordering_sequence");
  const hasUiVisible = hasColumn(db, "message", "ui_visible");

  // Ordering rule mirrors the legacy reader: use the global ordering
  // sequence only when every row has one; otherwise (created_at, id).
  let orderBySequence = false;
  if (hasOrderingSequence) {
    const nullRow = db
      .prepare("SELECT 1 AS n FROM message WHERE ordering_sequence IS NULL LIMIT 1")
      .get();
    orderBySequence = !nullRow;
  }
  const orderClause = orderBySequence
    ? "m.ordering_sequence ASC, m.id ASC"
    : "m.created_at ASC, m.id ASC";

  const policyHiddenSql = `(
    json_valid(p.data_json) AND (
      COALESCE(json_extract(p.data_json, '$.metadata.ui.visibility'), '') = 'hidden'
      OR COALESCE(json_extract(p.data_json, '$.metadata.trigger.kind'), '') = 'workspace_creation_request'
    )
  )`;
  const visibleSql = hasUiVisible
    ? `CASE
         WHEN m.type IN ('user_message', 'assistant_message') THEN
           CASE
             WHEN m.ui_visible IS NOT NULL THEN m.ui_visible
             WHEN ${policyHiddenSql} THEN 0
             ELSE 1
           END
         ELSE 0
       END`
    : `CASE
         WHEN m.type IN ('user_message', 'assistant_message') THEN
           CASE WHEN ${policyHiddenSql} THEN 0 ELSE 1 END
         ELSE 0
       END`;

  db.exec(`
    WITH ordered AS (
      SELECT
        m.session_id AS conversation_id,
        m.id AS id,
        m.type AS type,
        m.role AS role,
        m.device_id, m.request_id, m.target_device_id,
        m.run_id, m.agent_type,
        p.data_json AS payload,
        CASE
          WHEN json_valid(m.data_json)
          THEN json_extract(m.data_json, '$.channelEnvelope')
          ELSE NULL
        END AS channel_envelope,
        ${visibleSql} AS visible,
        m.created_at, m.updated_at,
        ROW_NUMBER() OVER (
          PARTITION BY m.session_id ORDER BY ${orderClause}
        ) AS seq
      FROM message m
      LEFT JOIN part p ON p.message_id = m.id AND p.ord = 0
    )
    INSERT OR IGNORE INTO entry (
      conversation_id, seq, id, type, role, visible, turn_seq,
      device_id, request_id, target_device_id, run_id, agent_type,
      payload, channel_envelope, search_text, created_at, updated_at
    )
    SELECT
      conversation_id, seq, id, type, role, visible,
      MAX(CASE WHEN type = 'user_message' AND visible = 1 THEN seq END) OVER (
        PARTITION BY conversation_id ORDER BY seq
        ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
      ),
      device_id, request_id, target_device_id, run_id, agent_type,
      payload, channel_envelope,
      CASE
        WHEN type IN ('user_message', 'assistant_message')
          AND json_valid(payload)
          AND json_type(payload, '$.text') = 'text'
        THEN json_extract(payload, '$.text')
      END,
      created_at, updated_at
    FROM ordered
    WHERE EXISTS (SELECT 1 FROM conversation WHERE conversation.id = ordered.conversation_id);
  `);

  db.exec(`
    UPDATE conversation SET next_seq = COALESCE(
      (SELECT MAX(seq) FROM entry WHERE entry.conversation_id = conversation.id),
      0
    ) + 1;
  `);
};

const importThreads = (db: SqliteDatabase): void => {
  const hasSessions = tableExists(db, "runtime_thread_sessions");
  db.exec(`
    INSERT OR IGNORE INTO thread (
      id, conversation_id, agent_type, name, status, summary,
      external_session_id, external_delivered_entry_id, group_key, group_label,
      session_id, session_created_at, cwd, parent_session,
      next_seq, search_text, created_at, last_used_at
    )
    SELECT
      t.thread_key, t.conversation_id, t.agent_type, t.name, t.status, t.summary,
      ${hasColumn(db, "runtime_threads", "external_session_id") ? "t.external_session_id" : "NULL"},
      ${hasColumn(db, "runtime_threads", "external_delivered_entry_id") ? "t.external_delivered_entry_id" : "NULL"},
      ${hasColumn(db, "runtime_threads", "group_key") ? "t.group_key" : "NULL"},
      ${hasColumn(db, "runtime_threads", "group_label") ? "t.group_label" : "NULL"},
      ${hasSessions ? "s.session_id" : "NULL"},
      ${hasSessions ? "s.created_at" : "NULL"},
      ${hasSessions ? "COALESCE(s.cwd, '')" : "''"},
      ${hasSessions ? "s.parent_session" : "NULL"},
      1, NULL, t.created_at, t.last_used_at
    FROM runtime_threads t
    ${hasSessions ? "LEFT JOIN runtime_thread_sessions s ON s.thread_key = t.thread_key" : ""};
  `);
};

const importThreadEntries = (db: SqliteDatabase): void => {
  if (!tableExists(db, "runtime_thread_entries")) return;
  const hasInsertionSequence = hasColumn(
    db,
    "runtime_thread_entries",
    "insertion_sequence",
  );
  const orderClause = hasInsertionSequence
    ? "e.insertion_sequence IS NULL, e.insertion_sequence ASC, e.rowid ASC"
    : "e.rowid ASC";
  db.exec(`
    WITH ordered AS (
      SELECT
        e.thread_key, e.entry_id, e.entry_type, e.timestamp_iso,
        e.created_at, e.data_json,
        ROW_NUMBER() OVER (
          PARTITION BY e.thread_key ORDER BY ${orderClause}
        ) AS seq
      FROM runtime_thread_entries e
    )
    INSERT OR IGNORE INTO thread_entry (
      thread_id, seq, id, type, role, custom_type, payload, blob_id,
      est_tokens, image_count, image_bytes, timestamp_iso, created_at
    )
    SELECT
      thread_key, seq, entry_id, entry_type,
      CASE WHEN entry_type = 'message' AND json_valid(data_json)
           THEN json_extract(data_json, '$.message.role') END,
      CASE WHEN entry_type = 'custom_message' AND json_valid(data_json)
           THEN json_extract(data_json, '$.customType') END,
      data_json, NULL,
      CASE
        WHEN entry_type NOT IN ('message', 'custom_message') THEN 0
        ELSE CAST(COALESCE(
          CASE WHEN json_valid(data_json)
               THEN json_extract(data_json, '$.__stellaContextPressure.estimatedTokens') END,
          (length(COALESCE(data_json, '')) + 2) / 3
        ) AS INTEGER)
      END,
      CAST(COALESCE(
        CASE WHEN json_valid(data_json)
             THEN json_extract(data_json, '$.__stellaContextPressure.imageCount') END,
        0
      ) AS INTEGER),
      CAST(COALESCE(
        CASE WHEN json_valid(data_json)
             THEN json_extract(data_json, '$.__stellaContextPressure.imageDecodedBytes') END,
        0
      ) AS INTEGER),
      timestamp_iso, created_at
    FROM ordered
    WHERE EXISTS (SELECT 1 FROM thread WHERE thread.id = ordered.thread_key);
  `);

  db.exec(`
    UPDATE thread SET next_seq = COALESCE(
      (SELECT MAX(seq) FROM thread_entry WHERE thread_entry.thread_id = thread.id),
      0
    ) + 1;
  `);
};

const importExactPayloadBlobs = (db: SqliteDatabase): void => {
  if (!tableExists(db, "runtime_thread_entry_payload_chunks")) return;
  const markerRows = db
    .prepare(
      `SELECT thread_id, seq, id, payload FROM thread_entry
       WHERE payload LIKE '%"${LEGACY_EXACT_PAYLOAD_MARKER}"%'`,
    )
    .all() as Array<{
    thread_id: string;
    seq: number;
    id: string;
    payload: string | null;
  }>;
  if (markerRows.length === 0) return;
  const selectChunks = db.prepare(
    `SELECT chunk_text FROM runtime_thread_entry_payload_chunks
     WHERE entry_id = ? ORDER BY chunk_index ASC`,
  );
  const insertBlob = db.prepare(
    "INSERT INTO blob (byte_length, content) VALUES (?, ?) RETURNING id",
  );
  const setBlob = db.prepare(
    "UPDATE thread_entry SET blob_id = ? WHERE thread_id = ? AND seq = ?",
  );
  const encoder = new TextEncoder();
  for (const row of markerRows) {
    const bounded = parseJsonValue(row.payload);
    const marker = bounded?.[LEGACY_EXACT_PAYLOAD_MARKER];
    const expectedChunks =
      marker && typeof marker === "object" ? Number(marker.chunkCount) : NaN;
    const expectedBytes =
      marker && typeof marker === "object" ? Number(marker.byteLength) : NaN;
    const chunks = selectChunks.all(row.id) as Array<{ chunk_text?: string }>;
    const exactJson = chunks
      .map((chunk) => (typeof chunk.chunk_text === "string" ? chunk.chunk_text : ""))
      .join("");
    if (!exactJson) continue;
    const byteLength = encoder.encode(exactJson).byteLength;
    if (
      Number.isFinite(expectedChunks) &&
      Number.isFinite(expectedBytes) &&
      (chunks.length !== expectedChunks || byteLength !== expectedBytes)
    ) {
      // Incomplete legacy chunk set: the bounded payload stays authoritative.
      continue;
    }
    const blobRow = insertBlob.get(byteLength, exactJson) as
      | { id?: number }
      | undefined;
    if (typeof blobRow?.id === "number") {
      setBlob.run(blobRow.id, row.thread_id, row.seq);
    }
  }
};

/**
 * Materialize the latest compaction checkpoint of each thread into
 * `thread_context`, converting the legacy `firstKeptEntryId` form into a
 * covered range. Older, superseded overlays are intentionally dropped —
 * the legacy reader also honored only the latest checkpoint.
 */
const materializeThreadContexts = (db: SqliteDatabase): void => {
  const compactionRows = db
    .prepare(
      `SELECT te.thread_id, te.seq, te.id, te.payload, te.timestamp_iso, te.created_at
       FROM thread_entry te
       JOIN (
         SELECT thread_id, MAX(seq) AS seq FROM thread_entry
         WHERE type = 'compaction' GROUP BY thread_id
       ) latest ON latest.thread_id = te.thread_id AND latest.seq = te.seq`,
    )
    .all() as Array<{
    thread_id: string;
    seq: number;
    id: string;
    payload: string | null;
    timestamp_iso: string;
    created_at: number;
  }>;
  if (compactionRows.length === 0) return;
  const seqForEntry = db.prepare(
    "SELECT seq FROM thread_entry WHERE thread_id = ? AND id = ? LIMIT 1",
  );
  const firstEntrySeq = db.prepare(
    "SELECT MIN(seq) AS seq FROM thread_entry WHERE thread_id = ? AND type IN ('message', 'custom_message')",
  );
  const insertContext = db.prepare(`
    INSERT OR REPLACE INTO thread_context (
      thread_id, compaction_entry_id, covered_from_seq, covered_through_seq,
      summary, details, tokens_before, timestamp_iso, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const row of compactionRows) {
    const data = parseJsonValue(row.payload);
    const summary = typeof data?.summary === "string" ? data.summary.trim() : "";
    if (!summary) continue;
    let fromSeq: number | null = null;
    let throughSeq: number | null = null;
    const fromEntryId =
      typeof data?.fromEntryId === "string" ? data.fromEntryId.trim() : "";
    const toEntryId =
      typeof data?.toEntryId === "string" ? data.toEntryId.trim() : "";
    const firstKeptEntryId =
      typeof data?.firstKeptEntryId === "string"
        ? data.firstKeptEntryId.trim()
        : "";
    if (fromEntryId && toEntryId) {
      const from = seqForEntry.get(row.thread_id, fromEntryId) as
        | { seq?: number }
        | undefined;
      const through = seqForEntry.get(row.thread_id, toEntryId) as
        | { seq?: number }
        | undefined;
      if (typeof from?.seq === "number" && typeof through?.seq === "number") {
        fromSeq = from.seq;
        throughSeq = through.seq;
      }
    } else if (firstKeptEntryId) {
      const firstKept = seqForEntry.get(row.thread_id, firstKeptEntryId) as
        | { seq?: number }
        | undefined;
      const first = firstEntrySeq.get(row.thread_id) as
        | { seq?: number | null }
        | undefined;
      if (
        typeof firstKept?.seq === "number" &&
        typeof first?.seq === "number" &&
        firstKept.seq > first.seq
      ) {
        fromSeq = first.seq;
        throughSeq = firstKept.seq - 1;
      }
    }
    if (fromSeq === null || throughSeq === null || throughSeq < fromSeq) {
      continue;
    }
    const tokensBefore =
      typeof data?.tokensBefore === "number" && Number.isFinite(data.tokensBefore)
        ? Math.max(0, Math.floor(data.tokensBefore))
        : 0;
    const details =
      data && "details" in data ? JSON.stringify(data.details ?? null) : null;
    insertContext.run(
      row.thread_id,
      row.id,
      fromSeq,
      throughSeq,
      summary,
      details,
      tokensBefore,
      row.timestamp_iso,
      row.created_at,
      row.created_at,
    );
  }
};

const importAgents = (db: SqliteDatabase): void => {
  if (!tableExists(db, "runtime_agents")) return;
  const optional = (column: string, fallback = "NULL") =>
    hasColumn(db, "runtime_agents", column) ? column : fallback;
  db.exec(`
    INSERT OR IGNORE INTO agent (
      thread_id, conversation_id, storage_mode, owner_generation,
      agent_type, description, prompt,
      prompt_created_at, agent_depth, max_agent_depth, parent_agent_id,
      model_config_json, tool_workspace_root, status, started_at,
      completed_at, result, error, updated_at, root_run_id,
      attempt_generation, cloud_terminal_receipt_generation,
      terminal_lifecycle_receipt_generation, descendant_boundary_state_json,
      record_revision
    )
    SELECT
      thread_id, conversation_id,
      ${optional("storage_mode", "'local'")}, ${optional("owner_generation")},
      agent_type, description,
      ${optional("prompt")}, ${optional("prompt_created_at")},
      agent_depth, max_agent_depth, parent_agent_id,
      ${optional("model_config_json")}, ${optional("tool_workspace_root")},
      status, started_at, completed_at, result, error, updated_at,
      ${optional("root_run_id")},
      ${optional("attempt_generation", "0")},
      ${optional("cloud_terminal_receipt_generation")},
      ${optional("terminal_lifecycle_receipt_generation")},
      ${optional("descendant_boundary_state_json")},
      ${optional("record_revision", "0")}
    FROM runtime_agents;
  `);
};

const rebuildThreadSearchText = (db: SqliteDatabase): void => {
  db.exec(`
    UPDATE thread SET search_text = TRIM(
      thread.id || char(10) || thread.name
      || char(10) || COALESCE(thread.summary, '')
      || char(10) || COALESCE((SELECT description FROM agent WHERE agent.thread_id = thread.id), '')
      || char(10) || COALESCE((SELECT result FROM agent WHERE agent.thread_id = thread.id), '')
      || char(10) || COALESCE((SELECT error FROM agent WHERE agent.thread_id = thread.id), '')
    )
    WHERE thread.agent_type != 'orchestrator'
      AND thread.id NOT LIKE '%::subagent::%';
  `);
};

/**
 * Dev-only: the legacy `legacy_chat_cloud_import` table carried a
 * `FOREIGN KEY ... REFERENCES session(id) ON DELETE CASCADE`. Dropping the
 * legacy `session` table performs an implicit DELETE that would cascade and
 * silently erase every import receipt, so the table is rebuilt without the
 * foreign key (matching CLOUD_SCHEMA_SQL) before `session` is dropped.
 */
const rebuildLegacyChatCloudImport = (db: SqliteDatabase): void => {
  if (!tableExists(db, "legacy_chat_cloud_import")) return;
  const hasSessionFk = (
    db
      .prepare("PRAGMA foreign_key_list(legacy_chat_cloud_import);")
      .all() as Array<{ table?: unknown }>
  ).some((row) => row.table === "session");
  if (!hasSessionFk) return;
  db.exec(`
    ALTER TABLE legacy_chat_cloud_import RENAME TO legacy_chat_cloud_import_fk;
    CREATE TABLE legacy_chat_cloud_import (
      local_conversation_id TEXT PRIMARY KEY,
      cloud_conversation_id TEXT,
      owner_generation TEXT,
      next_turn_index INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'pending',
      detail TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    INSERT INTO legacy_chat_cloud_import (
      local_conversation_id, cloud_conversation_id, owner_generation,
      next_turn_index, status, detail, created_at, updated_at
    )
    SELECT
      local_conversation_id, cloud_conversation_id, owner_generation,
      next_turn_index, status, detail, created_at, updated_at
    FROM legacy_chat_cloud_import_fk;
    DROP TABLE legacy_chat_cloud_import_fk;
  `);
};

const dropLegacyTables = (db: SqliteDatabase): void => {
  for (const table of [
    "part",
    "message",
    "session",
    "runtime_thread_entry_payload_chunks",
    "runtime_thread_entries",
    "runtime_thread_sessions",
    "runtime_threads",
    "runtime_agents",
    "agent_progress_summaries",
    "message_ordering_counter",
    "message_text_fts",
    "thread_search_fts",
    "run_event_log",
    "chat_sync_checkpoints",
    "chat_events",
    "chat_conversations",
    "runtime_thread_messages",
    "runtime_run_events",
    "runtime_memories",
    "runtime_tasks",
    "runtime_memory_review_state",
    "dream_inbox",
  ]) {
    db.exec(`DROP TABLE IF EXISTS ${table};`);
  }
  db.prepare(
    `DELETE FROM settings WHERE key IN (
      'transcript_fts_backfilled_v1', 'thread_search_fts_backfilled_v2'
    )`,
  ).run();
};

export const importLegacyDatabase = (db: SqliteDatabase): void => {
  importConversations(db);
  importChatEntries(db);
  importThreads(db);
  importThreadEntries(db);
  importExactPayloadBlobs(db);
  materializeThreadContexts(db);
  importAgents(db);
  rebuildThreadSearchText(db);
  rebuildLegacyChatCloudImport(db);
  dropLegacyTables(db);
};
