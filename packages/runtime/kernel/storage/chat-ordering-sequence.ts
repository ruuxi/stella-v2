import type { SqliteDatabase } from "./shared.js";

const BACKFILL_CHUNK_SIZE = 5000;

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

const hasNullSequences = (db: SqliteDatabase): boolean => {
  const row = db
    .prepare(
      `SELECT 1 AS present
         FROM message
        WHERE ordering_sequence IS NULL
        LIMIT 1`,
    )
    .get() as { present?: unknown } | undefined;
  return Boolean(row);
};

export const chatOrderingSequenceIsComplete = (db: SqliteDatabase): boolean => {
  if (!hasColumn(db, "message", "ordering_sequence")) return false;
  return !hasNullSequences(db);
};

const installSchema = (db: SqliteDatabase): void => {
  db.exec("BEGIN IMMEDIATE;");
  try {
    if (!hasColumn(db, "message", "ordering_sequence")) {
      try {
        db.exec("ALTER TABLE message ADD COLUMN ordering_sequence INTEGER;");
      } catch {

      }
    }
    db.exec(`
      CREATE TABLE IF NOT EXISTS message_ordering_counter (
        id            INTEGER PRIMARY KEY CHECK (id = 0),
        next_sequence INTEGER NOT NULL
      );
    `);

    db.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_message_sequence_unique
      ON message(ordering_sequence)
      WHERE ordering_sequence IS NOT NULL;
    `);
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_message_session_sequence
      ON message(session_id, ordering_sequence);
    `);
    db.exec("COMMIT;");
  } catch (error) {
    try {
      db.exec("ROLLBACK;");
    } catch {

    }
    throw error;
  }
};

const backfillChunk = (db: SqliteDatabase, limit: number): number => {
  db.exec("BEGIN IMMEDIATE;");
  try {
    const baseRow = db
      .prepare(
        `SELECT COALESCE(MAX(ordering_sequence), 0) AS base FROM message`,
      )
      .get() as { base?: number };
    const base = typeof baseRow?.base === "number" ? baseRow.base : 0;
    const result = db
      .prepare(
        `WITH batch AS (
           SELECT rowid AS rid,
                  ROW_NUMBER() OVER (ORDER BY created_at ASC, id ASC) AS rn
           FROM message
           WHERE ordering_sequence IS NULL
           ORDER BY created_at ASC, id ASC
           LIMIT ?
         )
         UPDATE message
            SET ordering_sequence =
              ? + (SELECT rn FROM batch WHERE batch.rid = message.rowid)
          WHERE rowid IN (SELECT rid FROM batch)`,
      )
      .run(limit, base) as { changes?: number } | undefined;
    db.exec("COMMIT;");
    return typeof result?.changes === "number" ? result.changes : 0;
  } catch (error) {
    try {
      db.exec("ROLLBACK;");
    } catch {

    }
    throw error;
  }
};

export const installChatOrderingSequence = (db: SqliteDatabase): void => {
  installSchema(db);

  const totalRow = db
    .prepare(`SELECT COUNT(*) AS n FROM message`)
    .get() as { n?: number };
  const total = typeof totalRow?.n === "number" ? totalRow.n : 0;
  const maxChunks = Math.ceil(total / BACKFILL_CHUNK_SIZE) + 8;
  for (let i = 0; i < maxChunks; i += 1) {
    const stamped = backfillChunk(db, BACKFILL_CHUNK_SIZE);
    if (stamped === 0) break;
  }

  db.exec("BEGIN IMMEDIATE;");
  try {
    const baseRow = db
      .prepare(
        `SELECT COALESCE(MAX(ordering_sequence), 0) AS base FROM message`,
      )
      .get() as { base?: number };
    const base = typeof baseRow?.base === "number" ? baseRow.base : 0;
    db.prepare(
      `WITH batch AS (
         SELECT rowid AS rid,
                ROW_NUMBER() OVER (ORDER BY created_at ASC, id ASC) AS rn
         FROM message
         WHERE ordering_sequence IS NULL
         ORDER BY created_at ASC, id ASC
       )
       UPDATE message
          SET ordering_sequence =
            ? + (SELECT rn FROM batch WHERE batch.rid = message.rowid)
        WHERE rowid IN (SELECT rid FROM batch)`,
    ).run(base);
    db.exec(`
      INSERT INTO message_ordering_counter (id, next_sequence)
        VALUES (0, (SELECT COALESCE(MAX(ordering_sequence), 0) + 1 FROM message))
        ON CONFLICT(id) DO UPDATE SET
          next_sequence = MAX(
            message_ordering_counter.next_sequence,
            (SELECT COALESCE(MAX(ordering_sequence), 0) + 1 FROM message)
          );
    `);
    db.exec(`
      CREATE TRIGGER IF NOT EXISTS trg_message_ordering_sequence
      AFTER INSERT ON message
      WHEN NEW.ordering_sequence IS NULL
      BEGIN
        UPDATE message
           SET ordering_sequence = (
             SELECT next_sequence FROM message_ordering_counter WHERE id = 0
           )
         WHERE rowid = NEW.rowid;
        UPDATE message_ordering_counter
           SET next_sequence = next_sequence + 1
         WHERE id = 0;
      END;
    `);
    db.exec("COMMIT;");
  } catch (error) {
    try {
      db.exec("ROLLBACK;");
    } catch {

    }
    throw error;
  }
};

export type ChatOrderingSequenceDivergence = {
  sessionId: string;
  position: number;
  bySequenceId: string;
  byTimestampId: string;
};

export const verifyChatOrderingSequenceOrder = (
  db: SqliteDatabase,
): ChatOrderingSequenceDivergence[] => {
  const sessions = db
    .prepare(`SELECT DISTINCT session_id AS sessionId FROM message`)
    .all() as { sessionId?: unknown }[];
  const divergences: ChatOrderingSequenceDivergence[] = [];
  for (const { sessionId } of sessions) {
    if (typeof sessionId !== "string") continue;
    const bySequence = db
      .prepare(
        `SELECT id FROM message
          WHERE session_id = ?
          ORDER BY ordering_sequence ASC, id ASC`,
      )
      .all(sessionId) as { id?: unknown }[];
    const byTimestamp = db
      .prepare(
        `SELECT id FROM message
          WHERE session_id = ?
          ORDER BY created_at ASC, id ASC`,
      )
      .all(sessionId) as { id?: unknown }[];
    const count = Math.max(bySequence.length, byTimestamp.length);
    for (let i = 0; i < count; i += 1) {
      const seqId = bySequence[i]?.id;
      const tsId = byTimestamp[i]?.id;
      if (seqId !== tsId) {
        divergences.push({
          sessionId,
          position: i,
          bySequenceId: typeof seqId === "string" ? seqId : String(seqId),
          byTimestampId: typeof tsId === "string" ? tsId : String(tsId),
        });
      }
    }
  }
  return divergences;
};

export const uninstallChatOrderingSequence = (db: SqliteDatabase): void => {
  db.exec("BEGIN IMMEDIATE;");
  try {
    db.exec("DROP TRIGGER IF EXISTS trg_message_ordering_sequence;");
    db.exec("DROP INDEX IF EXISTS idx_message_sequence_unique;");
    db.exec("DROP INDEX IF EXISTS idx_message_session_sequence;");
    db.exec("DROP TABLE IF EXISTS message_ordering_counter;");
    if (hasColumn(db, "message", "ordering_sequence")) {
      db.exec("UPDATE message SET ordering_sequence = NULL;");
    }
    db.exec("COMMIT;");
  } catch (error) {
    try {
      db.exec("ROLLBACK;");
    } catch {

    }
    throw error;
  }
};
