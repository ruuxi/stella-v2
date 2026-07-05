import * as SQLite from "expo-sqlite";
import type { ChatMessage } from "../types";
import { loadChatMessages } from "./offline-chat-storage";
import {
  buildFtsMatchQuery,
  DEFAULT_RECALL_LIMIT,
  rowToHit,
  type MessageRow,
  type RecallHit,
} from "./chat-recall";

/**
 * SQLite FTS5-backed message index for the offline chat's recall tool.
 *
 * The recall search moved off the in-memory transcript scan onto a real
 * on-device SQLite database with an FTS5 full-text index over the chat's own
 * messages. Messages are mirrored into `messages` as they are persisted, an
 * external-content FTS5 table (`messages_fts`) is kept in sync by triggers, and
 * the `recall` tool runs bm25-ranked MATCH queries against it. On first run the
 * existing AsyncStorage transcript is backfilled once so past messages are
 * searchable.
 *
 * The key/value memory (remember/forget) and checkpoint compaction stay on
 * AsyncStorage — only the search layer is SQLite-backed.
 */

const DB_NAME = "stella-chat-index.db";

const SCHEMA_SQL = `
PRAGMA journal_mode = WAL;

CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY NOT NULL,
  role TEXT NOT NULL,
  text TEXT NOT NULL,
  created_at INTEGER
);

CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
  text,
  content='messages',
  content_rowid='rowid',
  tokenize='unicode61 remove_diacritics 2'
);

-- Keep the FTS index in sync with the content table (the canonical FTS5
-- external-content trigger pattern).
CREATE TRIGGER IF NOT EXISTS messages_ai AFTER INSERT ON messages BEGIN
  INSERT INTO messages_fts(rowid, text) VALUES (new.rowid, new.text);
END;
CREATE TRIGGER IF NOT EXISTS messages_ad AFTER DELETE ON messages BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, text) VALUES('delete', old.rowid, old.text);
END;
CREATE TRIGGER IF NOT EXISTS messages_au AFTER UPDATE ON messages BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, text) VALUES('delete', old.rowid, old.text);
  INSERT INTO messages_fts(rowid, text) VALUES (new.rowid, new.text);
END;
`;

let dbPromise: Promise<SQLite.SQLiteDatabase> | null = null;

async function openDb(): Promise<SQLite.SQLiteDatabase> {
  const db = await SQLite.openDatabaseAsync(DB_NAME);
  await db.execAsync(SCHEMA_SQL);
  return db;
}

function getDb(): Promise<SQLite.SQLiteDatabase> {
  if (!dbPromise) dbPromise = openDb();
  return dbPromise;
}

/**
 * Upsert messages into the index. Only rows whose text/role actually changed
 * touch the FTS index (the conflict WHERE guard skips no-op rewrites, so
 * streaming the same reply many times doesn't re-index on every chunk).
 */
export async function indexMessages(messages: ChatMessage[]): Promise<void> {
  const rows = messages.filter(
    (message) => typeof message.text === "string" && message.text.trim().length > 0,
  );
  if (rows.length === 0) return;
  const db = await getDb();
  await db.withTransactionAsync(async () => {
    for (const message of rows) {
      await db.runAsync(
        `INSERT INTO messages(id, role, text, created_at) VALUES(?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           role = excluded.role,
           text = excluded.text,
           created_at = excluded.created_at
         WHERE messages.text <> excluded.text
            OR messages.role <> excluded.role`,
        message.id,
        message.role,
        message.text.trim(),
        typeof message.createdAt === "number" ? message.createdAt : null,
      );
    }
  });
}

let backfilled = false;

/**
 * Open the DB and, on first run, backfill the existing AsyncStorage transcript
 * into the index once so history predating the SQLite index is searchable.
 * Idempotent and safe to call on every mount.
 */
export async function initMessageIndex(): Promise<void> {
  const db = await getDb();
  if (backfilled) return;
  backfilled = true;
  try {
    const countRow = await db.getFirstAsync<{ c: number }>(
      "SELECT COUNT(*) AS c FROM messages",
    );
    if ((countRow?.c ?? 0) > 0) return;
    const existing = await loadChatMessages("cloud");
    if (existing.length > 0) await indexMessages(existing);
  } catch {
    // Best-effort backfill; allow a retry on the next mount.
    backfilled = false;
  }
}

export type RecallSearchOptions = {
  limit?: number;
  /** Message ids to skip (e.g. the in-flight turn's own rows). */
  excludeIds?: Set<string>;
};

/**
 * FTS5-ranked full-text search over the chat's own indexed messages. Returns
 * bm25-ordered hits, honouring `excludeIds` and a bounded `limit`.
 */
export async function searchMessages(
  query: string,
  options: RecallSearchOptions = {},
): Promise<RecallHit[]> {
  const match = buildFtsMatchQuery(query);
  if (!match) return [];
  const limit = options.limit ?? DEFAULT_RECALL_LIMIT;
  const exclude = options.excludeIds;
  // Over-fetch so excludeIds filtering can't starve the result set.
  const fetchLimit = limit + (exclude ? exclude.size : 0);
  const db = await getDb();
  let rows: (MessageRow & { rank: number })[] = [];
  try {
    rows = await db.getAllAsync<MessageRow & { rank: number }>(
      `SELECT m.id AS id, m.role AS role, m.text AS text,
              m.created_at AS created_at, bm25(messages_fts) AS rank
       FROM messages_fts
       JOIN messages m ON m.rowid = messages_fts.rowid
       WHERE messages_fts MATCH ?
       ORDER BY rank
       LIMIT ?`,
      match,
      fetchLimit,
    );
  } catch {
    return [];
  }
  const hits: RecallHit[] = [];
  for (const row of rows) {
    if (exclude?.has(row.id)) continue;
    hits.push(rowToHit(row, query, row.rank));
    if (hits.length >= limit) break;
  }
  return hits;
}

/** Test/maintenance helper: wipe the index (content + FTS stay in sync). */
export async function clearMessageIndex(): Promise<void> {
  const db = await getDb();
  await db.execAsync("DELETE FROM messages;");
}
