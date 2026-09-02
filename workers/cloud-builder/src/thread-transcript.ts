/**
 * The thread transcript a `BuildSession` owns.
 *
 * A spawned agent's conversation used to live in Convex (`/api/cloud/context`
 * to read it, `/api/cloud/messages` to append). That put a synchronous
 * control-plane round trip on every continuation's critical path and made
 * Convex the authority for state only this Durable Object ever writes. The
 * rows now live in the object's own SQLite: continuations read them here, and
 * a `thread.messages` outbox event projects them for the UI.
 *
 * Ordering is the table's implicit `rowid`, which SQLite assigns in insertion
 * order and never reuses here because nothing deletes a row (owner purge drops
 * the whole table). That is the `seq` the executor's history contract wants,
 * so a continuation reads back exactly the shape the Convex route returned.
 *
 * `turn_counters` is the same idea for numbers the control plane used to
 * assign: the per-attempt event sequence (`turn.event.eventSeq`) and the
 * per-attempt append batch ordinal (`thread.messages.batchOrdinal`). Both are
 * persisted, so a restarted isolate continues the sequence instead of
 * restarting it and colliding with events Convex has already projected.
 */

import type { AgentHistoryRow } from "@stella/executor-cloud/agent-history";
import { AGENT_HISTORY_MAX_ROWS } from "@stella/executor-cloud/agent-history";

export const THREAD_TRANSCRIPT_DDL = [
  `CREATE TABLE IF NOT EXISTS thread_messages (
     turn_id            TEXT    NOT NULL,
     attempt_generation INTEGER NOT NULL,
     ordinal            INTEGER NOT NULL,
     role               TEXT    NOT NULL,
     payload_json       TEXT    NOT NULL,
     created_at         INTEGER NOT NULL,
     PRIMARY KEY (turn_id, attempt_generation, ordinal)
   )`,
  `CREATE TABLE IF NOT EXISTS turn_counters (
     scope              TEXT    NOT NULL,
     turn_id            TEXT    NOT NULL,
     attempt_generation INTEGER NOT NULL,
     next_value         INTEGER NOT NULL,
     PRIMARY KEY (scope, turn_id, attempt_generation)
   )`,
] as const;

export type ThreadTranscriptRole = AgentHistoryRow["role"];

export type ThreadMessageInput = Readonly<{
  ordinal: number;
  role: string;
  payloadJson: string;
}>;

export type ThreadMessageAppend = Readonly<{
  ordinal: number;
  role: ThreadTranscriptRole;
  payloadJson: string;
}>;

/** One append: the rows that were new, and the batch ordinal to project them under. */
export type ThreadAppendReceipt = Readonly<{
  batchOrdinal: number;
  messages: readonly ThreadMessageAppend[];
}>;

export class ThreadTranscriptError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ThreadTranscriptError";
  }
}

const isRole = (value: unknown): value is ThreadTranscriptRole =>
  value === "user" || value === "assistant" || value === "toolResult";

/**
 * The DDL is idempotent, but it is also on the read path of every
 * continuation and every event, so it runs once per storage per isolate.
 */
const provisioned = new WeakSet<SqlStorage>();

export const ensureThreadTranscriptSchema = (sql: SqlStorage): void => {
  if (provisioned.has(sql)) return;
  for (const statement of THREAD_TRANSCRIPT_DDL) sql.exec(statement);
  provisioned.add(sql);
};

const validateAppend = (
  messages: readonly ThreadMessageInput[],
): readonly ThreadMessageAppend[] => {
  const validated: ThreadMessageAppend[] = [];
  const seen = new Set<number>();
  for (const message of messages) {
    if (
      !message ||
      typeof message !== "object" ||
      !Number.isSafeInteger(message.ordinal) ||
      message.ordinal < 0 ||
      seen.has(message.ordinal) ||
      !isRole(message.role) ||
      typeof message.payloadJson !== "string" ||
      message.payloadJson.length === 0
    ) {
      throw new ThreadTranscriptError(
        "Thread transcript rows must carry a unique ordinal, a known role, and a payload.",
      );
    }
    seen.add(message.ordinal);
    validated.push({
      ordinal: message.ordinal,
      role: message.role,
      payloadJson: message.payloadJson,
    });
  }
  return validated.slice().sort((left, right) => left.ordinal - right.ordinal);
};

/**
 * Reserve the next value of one persisted counter. Callers run inside the
 * Durable Object's single-threaded storage, so read-then-write is atomic
 * enough here; there is no concurrent writer for a given (scope, turn,
 * attempt).
 */
const nextCounter = (
  sql: SqlStorage,
  scope: "event" | "batch",
  turnId: string,
  attemptGeneration: number,
): number => {
  ensureThreadTranscriptSchema(sql);
  const current = sql
    .exec<{ next_value: number }>(
      `SELECT next_value FROM turn_counters
        WHERE scope = ? AND turn_id = ? AND attempt_generation = ?`,
      scope,
      turnId,
      attemptGeneration,
    )
    .toArray();
  const value = current[0]?.next_value ?? 1;
  sql.exec(
    `INSERT INTO turn_counters (scope, turn_id, attempt_generation, next_value)
     VALUES (?, ?, ?, ?)
     ON CONFLICT (scope, turn_id, attempt_generation)
     DO UPDATE SET next_value = excluded.next_value`,
    scope,
    turnId,
    attemptGeneration,
    value + 1,
  );
  return value;
};

/**
 * The per-attempt event ordinal Convex used to assign when the DO sent
 * `seq: "auto"`. Monotonic from 1 and durable across isolate restarts.
 */
export const nextTurnEventSeq = (
  sql: SqlStorage,
  turnId: string,
  attemptGeneration: number,
): number => nextCounter(sql, "event", turnId, attemptGeneration);

/**
 * Record that an ordinal a caller chose itself has been used, so a later
 * auto-assigned one cannot land on it. The app-build lane numbers its own
 * events (it has to, because its retries replay an exact ordinal), while its
 * recovery paths take the next one from here — without this they would
 * eventually collide on the same outbox key.
 */
export const reserveTurnEventSeq = (
  sql: SqlStorage,
  turnId: string,
  attemptGeneration: number,
  eventSeq: number,
): void => {
  if (!Number.isSafeInteger(eventSeq) || eventSeq < 0) return;
  ensureThreadTranscriptSchema(sql);
  sql.exec(
    `INSERT INTO turn_counters (scope, turn_id, attempt_generation, next_value)
     VALUES ('event', ?, ?, ?)
     ON CONFLICT (scope, turn_id, attempt_generation)
     DO UPDATE SET next_value = MAX(next_value, excluded.next_value)`,
    turnId,
    attemptGeneration,
    eventSeq + 1,
  );
};

/**
 * Append a batch of transcript rows. Re-appending the same (turn, attempt,
 * ordinal) is a no-op, so a retried commit cannot duplicate the transcript;
 * the receipt names only what was actually new, which is what gets projected.
 */
export const appendThreadMessages = (
  sql: SqlStorage,
  args: {
    turnId: string;
    attemptGeneration: number;
    messages: readonly ThreadMessageInput[];
    now: number;
  },
): ThreadAppendReceipt => {
  if (!args.turnId.trim()) {
    throw new ThreadTranscriptError("Thread transcript rows require a turn id.");
  }
  if (
    !Number.isSafeInteger(args.attemptGeneration) ||
    args.attemptGeneration < 1
  ) {
    throw new ThreadTranscriptError(
      "Thread transcript rows require an attempt generation.",
    );
  }
  const validated = validateAppend(args.messages);
  ensureThreadTranscriptSchema(sql);
  if (validated.length === 0) {
    return { batchOrdinal: 0, messages: [] };
  }
  const existing = new Set(
    sql
      .exec<{ ordinal: number }>(
        `SELECT ordinal FROM thread_messages
          WHERE turn_id = ? AND attempt_generation = ?`,
        args.turnId,
        args.attemptGeneration,
      )
      .toArray()
      .map((row) => row.ordinal),
  );
  const fresh = validated.filter((message) => !existing.has(message.ordinal));
  for (const message of fresh) {
    sql.exec(
      `INSERT OR IGNORE INTO thread_messages
         (turn_id, attempt_generation, ordinal, role, payload_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      args.turnId,
      args.attemptGeneration,
      message.ordinal,
      message.role,
      message.payloadJson,
      args.now,
    );
  }
  if (fresh.length === 0) return { batchOrdinal: 0, messages: [] };
  return {
    batchOrdinal: nextCounter(
      sql,
      "batch",
      args.turnId,
      args.attemptGeneration,
    ),
    messages: fresh,
  };
};

/**
 * The thread's history, oldest first, in the exact row shape the executor and
 * the resident loop already validate. Bounded to the newest
 * `AGENT_HISTORY_MAX_ROWS` rows, which is the same ceiling the Convex context
 * route enforced, so a long-lived thread degrades by dropping its oldest turns
 * rather than failing the whole preflight.
 */
export const readThreadHistory = (
  sql: SqlStorage,
  options: { excludeTurnId?: string; limit?: number } = {},
): AgentHistoryRow[] => {
  ensureThreadTranscriptSchema(sql);
  const limit = options.limit ?? AGENT_HISTORY_MAX_ROWS;
  const exclude = options.excludeTurnId?.trim() ?? "";
  const rows = exclude
    ? sql
        .exec<{
          seq: number;
          turn_id: string;
          role: string;
          payload_json: string;
        }>(
          `SELECT rowid AS seq, turn_id, role, payload_json FROM thread_messages
            WHERE turn_id != ? ORDER BY rowid DESC LIMIT ?`,
          exclude,
          limit,
        )
        .toArray()
    : sql
        .exec<{
          seq: number;
          turn_id: string;
          role: string;
          payload_json: string;
        }>(
          `SELECT rowid AS seq, turn_id, role, payload_json FROM thread_messages
            ORDER BY rowid DESC LIMIT ?`,
          limit,
        )
        .toArray();
  return rows
    .reverse()
    .filter((row) => isRole(row.role))
    .map((row) => ({
      seq: row.seq,
      role: row.role as ThreadTranscriptRole,
      payloadJson: row.payload_json,
      turnId: row.turn_id,
    }));
};

/** Owner purge: the thread's private job state goes with the rest of it. */
export const purgeThreadTranscript = (sql: SqlStorage): void => {
  sql.exec(`DROP TABLE IF EXISTS thread_messages`);
  sql.exec(`DROP TABLE IF EXISTS turn_counters`);
  provisioned.delete(sql);
};
