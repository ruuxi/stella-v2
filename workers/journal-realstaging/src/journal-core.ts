// Canonical journal semantics, faithful to the production journal in
// workers/cloud-builder/src/journal.ts. Kept as a small pure module so the
// Durable Object and its tests share one implementation of the invariants:
//
//  - Gapless `seq` allocated from meta.next_seq inside a single transaction
//    (never MAX(seq)+1 — rollover deletes old rows, so MAX goes backwards).
//  - Idempotent foreign append: a batch keyed by writer_key commits its rows
//    and its receipt together, or not at all. A replayed writer_key returns the
//    prior receipt without re-appending (no duplicate, no split-brain).
//  - Optimistic fencing via expectedSeq: a writer that names the wrong current
//    seq is rejected (409), preventing a stale writer from interleaving.
//
// This module is storage-agnostic: it operates on a minimal Sql surface so it
// runs against Durable Object SQLite in production and against an in-memory
// shim in unit tests.

export interface SqlRow {
  [key: string]: unknown;
}

export interface SqlCursor<T> {
  toArray(): T[];
  one(): T;
}

export interface Sql {
  exec<T = SqlRow>(query: string, ...bindings: unknown[]): SqlCursor<T>;
}

export const JOURNAL_DDL: string[] = [
  `CREATE TABLE IF NOT EXISTS meta (
     id           INTEGER PRIMARY KEY CHECK (id = 0),
     next_seq     INTEGER NOT NULL DEFAULT 1,
     hot_min_seq  INTEGER NOT NULL DEFAULT 1,
     created_at   INTEGER NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS journal (
     seq             INTEGER PRIMARY KEY,
     type            TEXT NOT NULL,
     payload         TEXT NOT NULL,
     turn_id         TEXT,
     idempotency_key TEXT,
     placement       TEXT,
     created_at      INTEGER NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS append_receipts (
     writer_key TEXT PRIMARY KEY,
     first_seq  INTEGER NOT NULL,
     last_seq   INTEGER NOT NULL,
     count      INTEGER NOT NULL,
     created_at INTEGER NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS segments (
     first_seq  INTEGER PRIMARY KEY,
     last_seq   INTEGER NOT NULL,
     rows       INTEGER NOT NULL,
     bytes      INTEGER NOT NULL,
     r2_key     TEXT NOT NULL,
     state      TEXT NOT NULL,
     created_at INTEGER NOT NULL
   )`,
];

export interface AppendEvent {
  readonly type: string;
  readonly payload: unknown;
  readonly turnId?: string | null;
  readonly idempotencyKey?: string | null;
  readonly placement?: "local-desktop" | "cloud-sandbox" | null;
}

export interface AppendReceipt {
  readonly writerKey: string;
  readonly firstSeq: number;
  readonly lastSeq: number;
  readonly count: number;
  readonly replayed: boolean;
}

export interface JournalEventRow {
  readonly seq: number;
  readonly type: string;
  readonly payload: unknown;
  readonly turnId: string | null;
  readonly idempotencyKey: string | null;
  readonly placement: string | null;
}

export class FencingConflict extends Error {
  constructor(readonly expectedSeq: number, readonly actualLastSeq: number) {
    super(`fencing conflict: expectedSeq=${expectedSeq} actualLastSeq=${actualLastSeq}`);
    this.name = "FencingConflict";
  }
}

export function ensureSchema(sql: Sql, now: number): void {
  for (const stmt of JOURNAL_DDL) sql.exec(stmt);
  const count = sql.exec<{ c: number }>("SELECT COUNT(*) AS c FROM meta").one().c;
  if (Number(count) === 0) {
    sql.exec("INSERT INTO meta (id, next_seq, hot_min_seq, created_at) VALUES (0, 1, 1, ?)", now);
  }
}

function meta(sql: Sql): { next_seq: number; hot_min_seq: number } {
  const row = sql
    .exec<{ next_seq: number; hot_min_seq: number }>("SELECT next_seq, hot_min_seq FROM meta WHERE id = 0")
    .one();
  return { next_seq: Number(row.next_seq), hot_min_seq: Number(row.hot_min_seq) };
}

export function lastSeq(sql: Sql): number {
  return meta(sql).next_seq - 1;
}

/**
 * Idempotent, fenced, gapless append. `writerKey` identifies the logical batch;
 * a replay returns the recorded receipt. `expectedSeq`, when provided, must be
 * the current last seq or the append is rejected.
 */
export function appendBatch(
  sql: Sql,
  writerKey: string,
  events: AppendEvent[],
  now: number,
  expectedSeq?: number,
): AppendReceipt {
  // Idempotency: a known writer_key returns its prior receipt untouched.
  const prior = sql
    .exec<{ first_seq: number; last_seq: number; count: number }>(
      "SELECT first_seq, last_seq, count FROM append_receipts WHERE writer_key = ?",
      writerKey,
    )
    .toArray();
  if (prior.length > 0) {
    const r = prior[0]!;
    return {
      writerKey,
      firstSeq: Number(r.first_seq),
      lastSeq: Number(r.last_seq),
      count: Number(r.count),
      replayed: true,
    };
  }

  const m = meta(sql);
  const currentLast = m.next_seq - 1;
  if (expectedSeq !== undefined && expectedSeq !== currentLast) {
    throw new FencingConflict(expectedSeq, currentLast);
  }

  if (events.length === 0) {
    // Empty batch still records a receipt so a retry is stable.
    sql.exec(
      "INSERT INTO append_receipts (writer_key, first_seq, last_seq, count, created_at) VALUES (?, ?, ?, 0, ?)",
      writerKey,
      currentLast,
      currentLast,
      now,
    );
    return { writerKey, firstSeq: currentLast, lastSeq: currentLast, count: 0, replayed: false };
  }

  let seq = m.next_seq;
  const firstSeq = seq;
  for (const ev of events) {
    sql.exec(
      "INSERT INTO journal (seq, type, payload, turn_id, idempotency_key, placement, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      seq,
      ev.type,
      JSON.stringify(ev.payload),
      ev.turnId ?? null,
      ev.idempotencyKey ?? null,
      ev.placement ?? null,
      now,
    );
    seq += 1;
  }
  const lastSeqOut = seq - 1;
  sql.exec("UPDATE meta SET next_seq = ? WHERE id = 0", seq);
  sql.exec(
    "INSERT INTO append_receipts (writer_key, first_seq, last_seq, count, created_at) VALUES (?, ?, ?, ?, ?)",
    writerKey,
    firstSeq,
    lastSeqOut,
    events.length,
    now,
  );
  return { writerKey, firstSeq, lastSeq: lastSeqOut, count: events.length, replayed: false };
}

export function readHot(sql: Sql, fromSeq = 1): JournalEventRow[] {
  const rows = sql
    .exec<{
      seq: number;
      type: string;
      payload: string;
      turn_id: string | null;
      idempotency_key: string | null;
      placement: string | null;
    }>(
      "SELECT seq, type, payload, turn_id, idempotency_key, placement FROM journal WHERE seq >= ? ORDER BY seq ASC",
      fromSeq,
    )
    .toArray();
  return rows.map((r) => ({
    seq: Number(r.seq),
    type: String(r.type),
    payload: JSON.parse(String(r.payload)),
    turnId: r.turn_id === null ? null : String(r.turn_id),
    idempotencyKey: r.idempotency_key === null ? null : String(r.idempotency_key),
    placement: r.placement === null ? null : String(r.placement),
  }));
}

export interface SegmentManifest {
  readonly firstSeq: number;
  readonly lastSeq: number;
  readonly rows: number;
  readonly bytes: number;
  readonly r2Key: string;
  readonly state: string;
}

export function listSegments(sql: Sql): SegmentManifest[] {
  return sql
    .exec<{
      first_seq: number;
      last_seq: number;
      rows: number;
      bytes: number;
      r2_key: string;
      state: string;
    }>("SELECT first_seq, last_seq, rows, bytes, r2_key, state FROM segments ORDER BY first_seq ASC")
    .toArray()
    .map((r) => ({
      firstSeq: Number(r.first_seq),
      lastSeq: Number(r.last_seq),
      rows: Number(r.rows),
      bytes: Number(r.bytes),
      r2Key: String(r.r2_key),
      state: String(r.state),
    }));
}

export function hotMinSeq(sql: Sql): number {
  return meta(sql).hot_min_seq;
}
