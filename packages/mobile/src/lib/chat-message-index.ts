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

let writeQueue: Promise<unknown> = Promise.resolve();

function enqueueWrite<T>(work: () => Promise<T>): Promise<T> {
  const run = writeQueue.then(work, work);
  writeQueue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

export async function indexMessages(messages: ChatMessage[]): Promise<void> {
  const rows = messages.filter(
    (message) => typeof message.text === "string" && message.text.trim().length > 0,
  );
  if (rows.length === 0) return;
  try {
    const db = await getDb();
    await enqueueWrite(() =>
      db.withTransactionAsync(async () => {
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
      }),
    );
  } catch {

  }
}

let backfilled = false;

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

    backfilled = false;
  }
}

export type RecallSearchOptions = {
  limit?: number;

  excludeIds?: Set<string>;
};

export async function searchMessages(
  query: string,
  options: RecallSearchOptions = {},
): Promise<RecallHit[]> {
  const match = buildFtsMatchQuery(query);
  if (!match) return [];
  const limit = options.limit ?? DEFAULT_RECALL_LIMIT;
  const exclude = options.excludeIds;

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

export async function clearMessageIndex(): Promise<void> {
  const db = await getDb();
  await enqueueWrite(() => db.execAsync("DELETE FROM messages;"));
}
