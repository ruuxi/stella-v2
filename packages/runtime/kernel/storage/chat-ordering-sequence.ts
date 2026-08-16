import type { SqliteDatabase } from "./shared.js";

/**
 * The chat `message` table's dedicated, strictly-increasing, NEVER-REUSED
 * monotonic ordering key, assigned by the authoritative desktop. This is now the
 * DEFAULT and ONLY ordering key for the chat timeline — there are no feature
 * flags; the migration runs unconditionally at database init.
 *
 * Design:
 *  - GLOBAL-per-database counter (never "per-thread"): a global monotone integer
 *    yields a correct per-thread subsequence for free; the random ULID stays the
 *    identity/tiebreak.
 *  - NEVER-REUSED via a persistent high-water counter row that DELETE / "Rewind
 *    here" (truncateConversationAtEvent) / ON DELETE CASCADE can never lower —
 *    unlike a live `MAX(...)+1`, which recycles freed numbers and re-poisons a
 *    monotonic cursor.
 *  - ORDER-PRESERVING backfill: existing rows are numbered in current display
 *    order `(created_at, id)`, so `ORDER BY ordering_sequence` reproduces the
 *    exact order users already see. New rows get arrival order (the counter).
 *  - CHUNKED + RESUMABLE so a large history never holds the write lock for a
 *    single long transaction and never hangs launch (L1). The bulk of the
 *    backfill runs in bounded chunks, each its own short transaction; only a
 *    tiny final step (stragglers + trigger install) holds the write lock, and
 *    it is atomic so no insert can interleave. A crash mid-backfill resumes on
 *    the next launch (only NULL rows are touched).
 *  - The trigger is installed LAST, in the final atomic step AFTER every row has
 *    a sequence, so it can never mint a value that collides with the backfill
 *    range — and, because no trigger exists during the chunked phase, a
 *    concurrent insert lands as a NULL row that the backfill picks up in order.
 */

/** Rows backfilled per short transaction. Keeps each write-lock hold brief. */
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

/**
 * True once every message row carries a non-NULL ordering_sequence (the column
 * exists and the backfill has completed). Callers that need a hard guarantee the
 * sequence is populated — e.g. before advertising it as a cross-device ordering
 * key — gate on this.
 */
export const chatOrderingSequenceIsComplete = (db: SqliteDatabase): boolean => {
  if (!hasColumn(db, "message", "ordering_sequence")) return false;
  return !hasNullSequences(db);
};

/** Install the column, counter, and both indexes (no trigger yet). Short lock. */
const installSchema = (db: SqliteDatabase): void => {
  db.exec("BEGIN IMMEDIATE;");
  try {
    if (!hasColumn(db, "message", "ordering_sequence")) {
      try {
        db.exec("ALTER TABLE message ADD COLUMN ordering_sequence INTEGER;");
      } catch {
        // Column already exists (raced by another connection under the lock).
      }
    }
    db.exec(`
      CREATE TABLE IF NOT EXISTS message_ordering_counter (
        id            INTEGER PRIMARY KEY CHECK (id = 0),
        next_sequence INTEGER NOT NULL
      );
    `);
    // Uniqueness assertion (never-reuse tripwire) — partial, so it is a no-op
    // while every sequence is still NULL, and enforces uniqueness as the
    // backfill assigns contiguous values.
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
      // Preserve the original failure.
    }
    throw error;
  }
};

/**
 * Assign the next chunk of still-NULL rows contiguous sequence values in
 * `(created_at, id)` order, in one short transaction. Returns the number of rows
 * stamped (0 when none remain). `base` is the current max, recomputed each chunk
 * so the process is resumable after a crash.
 */
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
      // Preserve the original failure.
    }
    throw error;
  }
};

/**
 * Install the ordering-sequence machinery and backfill existing rows. Runs
 * unconditionally at database init. Idempotent (a fully-migrated DB skips
 * straight to the trigger check), chunked/resumable, and order-preserving.
 */
export const installChatOrderingSequence = (db: SqliteDatabase): void => {
  installSchema(db);

  // Chunked bulk backfill under short, interleavable locks. Bounded by the row
  // count observed at the start (plus generous slack) so a pathological writer
  // inserting NULL rows faster than a chunk drains them can never livelock the
  // loop — whatever remains is finished by the final atomic step below, which
  // holds the write lock and therefore blocks concurrent inserts to completion.
  const totalRow = db
    .prepare(`SELECT COUNT(*) AS n FROM message`)
    .get() as { n?: number };
  const total = typeof totalRow?.n === "number" ? totalRow.n : 0;
  const maxChunks = Math.ceil(total / BACKFILL_CHUNK_SIZE) + 8;
  for (let i = 0; i < maxChunks; i += 1) {
    const stamped = backfillChunk(db, BACKFILL_CHUNK_SIZE);
    if (stamped === 0) break;
  }

  // Final atomic step: stamp any stragglers that raced in during the chunked
  // phase (they land as NULL because no trigger exists yet), seed the counter
  // strictly above every assigned value, then install the trigger — all while
  // the write lock is held, so no insert can interleave between "no NULL rows"
  // and "trigger installed". After this, minted values are always > every
  // backfilled value, so a mint can never collide with the backfill range.
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
      // Preserve the original failure.
    }
    throw error;
  }
};

/** A single per-session ordering divergence found by the verifier. */
export type ChatOrderingSequenceDivergence = {
  sessionId: string;
  position: number;
  bySequenceId: string;
  byTimestampId: string;
};

/**
 * Prove the backfill preserved current display order: for every session,
 * `ORDER BY ordering_sequence` must equal `ORDER BY (created_at, id)`. Returns
 * the divergences (empty === order-preserving). Intended to run on a COPY of a
 * DB as a rehearsal.
 */
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

/**
 * Reverse the migration: drop the trigger/indexes/counter and NULL the column.
 * The column itself is left in place (dropping a column is a heavier rewrite and
 * unnecessary). Provided for a clean rollback / rehearsal; note that a
 * subsequent install re-ranks by `(created_at, id)`, so it is a rollback, not a
 * byte-perfect round-trip of arrival order.
 */
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
      // Preserve the original failure.
    }
    throw error;
  }
};
