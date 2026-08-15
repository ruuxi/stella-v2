import type { SqliteDatabase } from "./shared.js";

/**
 * Phase 0 of the chat-ordering re-architecture (see the hardened plan v2.1):
 * a dedicated, strictly-increasing, NEVER-REUSED monotonic ordering key on the
 * chat `message` table, assigned by the authoritative desktop.
 *
 * This is entirely gated behind the STELLA_CHAT_ORDERING_SEQUENCE env flag and
 * is NOT installed on a default startup — so a normal launch is byte-identical
 * to today and no real user data is touched until an operator opts in. Ordering
 * still happens by the legacy `(created_at, id)` comparator everywhere; this
 * only populates the new column so a later, separately-signed-off phase can
 * flip the comparator behind its own flag.
 *
 * Design (resolves the adversarial findings F1/F2 and review items V1/V5):
 *  - GLOBAL-per-database counter, never called "per-thread". A global monotone
 *    integer yields a correct per-thread subsequence for free; the random ULID
 *    stays the identity/tiebreak.
 *  - NEVER-REUSED via a persistent high-water counter row that DELETE / "Rewind
 *    here" (truncateConversationAtEvent) / ON DELETE CASCADE can never lower —
 *    unlike a live `MAX(...)+1`, which recycles freed numbers and re-poisons a
 *    monotonic cursor.
 *  - The whole migration (add column -> backfill EVERY row in current display
 *    order -> seed the counter above MAX -> install indexes -> install the
 *    trigger LAST) runs under ONE writer lock, so the trigger can never mint a
 *    value before the backfill has claimed the legacy range. That closes the
 *    backfill/trigger UNIQUE-collision the review reproduced (V1).
 *  - Backfill ranks by `(created_at, id)` — the CURRENT display order — NOT by
 *    rowid. For every existing transcript this makes
 *    `ORDER BY ordering_sequence` == `ORDER BY (created_at, id)`, so a later
 *    comparator flip is a provable no-op on settled desktop history (F5).
 */

export const CHAT_ORDERING_SEQUENCE_ENV_FLAG = "STELLA_CHAT_ORDERING_SEQUENCE";

/**
 * Phase 3/4 flip: order the chat timeline (and its cutoff / keyset / delta / and
 * destructive Rewind & Fork predicates) by `ordering_sequence` instead of the
 * legacy `(created_at, id)` tuple. Default off. Only takes effect when the
 * column is fully backfilled (`chatOrderingSequenceIsComplete`) so a flip can
 * never key on a NULL sequence.
 */
export const CHAT_ORDERING_BY_SEQUENCE_ENV_FLAG =
  "STELLA_CHAT_ORDERING_BY_SEQUENCE";

const isTruthyFlag = (raw: string | undefined): boolean => {
  const v = (raw ?? "").trim().toLowerCase();
  return v === "1" || v === "true" || v === "on" || v === "yes";
};

/** Whether the Phase-0 ordering-sequence migration is opted into for this process. */
export const isChatOrderingSequenceEnabled = (
  env: NodeJS.ProcessEnv = process.env,
): boolean => isTruthyFlag(env[CHAT_ORDERING_SEQUENCE_ENV_FLAG]);

/** Whether the Phase-3/4 comparator/predicate flip is opted into for this process. */
export const isChatOrderingBySequenceEnabled = (
  env: NodeJS.ProcessEnv = process.env,
): boolean => isTruthyFlag(env[CHAT_ORDERING_BY_SEQUENCE_ENV_FLAG]);

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
 * Every legacy row carries a non-NULL ordering_sequence. This is the invariant
 * the mixed-version bridge capability must gate on (V5): advertising sequence
 * support while any row is NULL would let a `ordering_sequence > :since` delta
 * silently drop those rows (`NULL > N` is unknown).
 */
export const chatOrderingSequenceIsComplete = (db: SqliteDatabase): boolean => {
  if (!hasColumn(db, "message", "ordering_sequence")) return false;
  return !hasNullSequences(db);
};

/**
 * Install the ordering-sequence column + high-water counter + assign-once
 * trigger, backfilling the whole table in current display order, atomically.
 * Idempotent: a fully-migrated DB is a no-op (the re-rank is guarded on a NULL
 * existing, and every DDL is `IF NOT EXISTS`). Safe to call on every startup
 * once the flag is on.
 */
export const installChatOrderingSequence = (db: SqliteDatabase): void => {
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

    // Backfill EVERY row in current display order, before the trigger exists.
    // Whole-table re-rank (not NULLs-only) so an interrupted prior migration
    // re-converges without colliding with values later inserts already claimed
    // — mirrors the runtime_thread_entries repair. Guarded on a NULL existing so
    // a completed migration is a no-op.
    if (hasNullSequences(db)) {
      db.exec("DROP INDEX IF EXISTS idx_message_sequence_unique;");
      db.exec(`
        WITH ranked AS (
          SELECT rowid AS rid,
                 ROW_NUMBER() OVER (ORDER BY created_at ASC, id ASC) AS seq
          FROM message
        )
        UPDATE message
           SET ordering_sequence = (
             SELECT ranked.seq FROM ranked WHERE ranked.rid = message.rowid
           );
      `);
    }

    // Seed the high-water counter ABOVE the max backfilled value, BEFORE the
    // trigger can fire, so the first minted value is strictly greater than every
    // backfilled row. On a re-run, keep the counter at least this high.
    db.exec(`
      INSERT INTO message_ordering_counter (id, next_sequence)
        VALUES (0, (SELECT COALESCE(MAX(ordering_sequence), 0) + 1 FROM message))
        ON CONFLICT(id) DO UPDATE SET
          next_sequence = MAX(
            message_ordering_counter.next_sequence,
            (SELECT COALESCE(MAX(ordering_sequence), 0) + 1 FROM message)
          );
    `);

    // Uniqueness assertion (never-reuse tripwire) + per-thread ordering scan.
    db.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_message_sequence_unique
      ON message(ordering_sequence)
      WHERE ordering_sequence IS NOT NULL;
    `);
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_message_session_sequence
      ON message(session_id, ordering_sequence);
    `);

    // Trigger LAST. AFTER INSERT only, guarded WHEN NEW.ordering_sequence IS
    // NULL — the upsert's ON CONFLICT DO UPDATE path is an UPDATE and does not
    // re-fire this, so an existing row's sequence is immutable.
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
      // Preserve the original migration failure.
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
 * DB as a rehearsal before any real-data migration.
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
 * Reverse the Phase-0 migration: drop the trigger/indexes/counter and NULL the
 * column. The column itself is left in place (dropping a column is a heavier
 * rewrite and unnecessary — a NULL column is invisible to the legacy path).
 * Makes the migration reversible for a clean rollback.
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
