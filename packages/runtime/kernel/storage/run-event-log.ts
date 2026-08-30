/**
 * Ephemeral stream-resume buffer for in-flight runs.
 *
 * This is 30-minute scratch state, so it lives in its own database file
 * (`stella-runs.sqlite`) instead of churning the durable store's WAL. The
 * table is created idempotently by the constructor; there is no migration
 * history to keep for a buffer whose contents expire within the hour.
 */

import path from "node:path";
import { createRequire } from "node:module";
import { ensurePrivateDirSync } from "../shared/private-fs.js";
import type { SqliteDatabase, SqliteStatement } from "./shared.js";

const RUN_EVENT_DB_FILE = "stella-runs.sqlite";

export type RunEventRecord = {
  runId: string;
  seq: number;
  payload: Record<string, unknown>;
  createdAt: number;
};

export type BufferedRunRecord = {
  runId: string;
  conversationId: string;
  updatedAt: number;
  hasTerminalEvent: boolean;
};

const DEFAULT_RETENTION_MS = 30 * 60 * 1000;

export const getRunEventDatabasePath = (stellaDataDir: string): string =>
  path.join(stellaDataDir, RUN_EVENT_DB_FILE);

/** Open (or create) the ephemeral run-event database. */
export const openRunEventDatabase = (stellaDataDir: string): SqliteDatabase => {
  ensurePrivateDirSync(stellaDataDir);
  const runtimeRequire = createRequire(import.meta.url);
  const sqliteModule = runtimeRequire(
    process.versions.bun ? "bun:sqlite" : "node:sqlite",
  );
  const Database = sqliteModule.Database ?? sqliteModule.DatabaseSync;
  if (!Database) {
    throw new Error("No compatible SQLite runtime is available.");
  }
  const db = new Database(getRunEventDatabasePath(stellaDataDir)) as SqliteDatabase;
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA synchronous = NORMAL;");
  db.exec("PRAGMA busy_timeout = 5000;");
  return db;
};

type Statements = {
  insert: SqliteStatement;
  selectAfter: SqliteStatement;
  pruneAcked: SqliteStatement;
  pruneByAge: SqliteStatement;
  countForRun: SqliteStatement;
  oldestSeq: SqliteStatement;
  deleteRun: SqliteStatement;
};

export class RunEventLog {
  private readonly statements: Statements;
  private sweepTimer: ReturnType<typeof setInterval> | null = null;
  private disposed = false;

  constructor(
    private readonly db: SqliteDatabase,
    private readonly options: {
      retentionMs?: number;
      sweepIntervalMs?: number;
    } = {},
  ) {
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
    this.statements = {
      insert: db.prepare(`
        INSERT OR IGNORE INTO run_event_log (run_id, seq, payload_json, created_at)
        VALUES (?, ?, ?, ?)
      `),
      selectAfter: db.prepare(`
        SELECT seq, payload_json, created_at
        FROM run_event_log
        WHERE run_id = ? AND seq > ?
        ORDER BY seq ASC
      `),
      pruneAcked: db.prepare(`
        DELETE FROM run_event_log
        WHERE run_id = ? AND seq <= ?
      `),
      pruneByAge: db.prepare(`
        DELETE FROM run_event_log
        WHERE created_at < ?
      `),
      countForRun: db.prepare(`
        SELECT COUNT(*) as count FROM run_event_log WHERE run_id = ?
      `),
      oldestSeq: db.prepare(`
        SELECT MIN(seq) as min_seq FROM run_event_log WHERE run_id = ?
      `),
      deleteRun: db.prepare(`
        DELETE FROM run_event_log WHERE run_id = ?
      `),
    };
  }

  startBackgroundSweep() {
    if (this.sweepTimer || this.disposed) return;
    const intervalMs = this.options.sweepIntervalMs ?? 60_000;
    this.sweepTimer = setInterval(() => {
      try {
        this.sweepExpired();
      } catch {
        /* the next sweep retries */
      }
    }, intervalMs);
    this.sweepTimer.unref?.();
  }

  stop() {
    this.disposed = true;
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = null;
    }
  }

  listBufferedRuns(): BufferedRunRecord[] {
    if (this.disposed) return [];
    const rows = this.db
      .prepare(
        `SELECT
           run_id,
           MAX(created_at) AS updated_at,
           MAX(
             CASE WHEN json_extract(payload_json, '$.type') = 'run-finished'
             THEN 1 ELSE 0 END
           ) AS has_terminal,
           (
             SELECT json_extract(inner.payload_json, '$.conversationId')
             FROM run_event_log AS inner
             WHERE inner.run_id = run_event_log.run_id
               AND json_type(inner.payload_json, '$.conversationId') = 'text'
             ORDER BY inner.created_at DESC, inner.seq DESC
             LIMIT 1
           ) AS conversation_id
         FROM run_event_log
         GROUP BY run_id
         ORDER BY updated_at DESC`,
      )
      .all() as Array<{
      run_id: string;
      updated_at: number;
      has_terminal: number;
      conversation_id: string | null;
    }>;
    return rows.flatMap((row) => {
      const conversationId =
        typeof row.conversation_id === "string"
          ? row.conversation_id.trim()
          : "";
      if (!conversationId) return [];
      return [
        {
          runId: row.run_id,
          conversationId,
          updatedAt: row.updated_at,
          hasTerminalEvent: row.has_terminal === 1,
        },
      ];
    });
  }

  append(args: {
    runId: string;
    seq: number;
    payload: Record<string, unknown>;
    timestamp?: number;
  }): boolean {
    if (this.disposed) return false;
    const trimmedRunId = args.runId.trim();
    if (!trimmedRunId) return false;
    if (!Number.isFinite(args.seq)) return false;
    const ts = Number.isFinite(args.timestamp) ? Number(args.timestamp) : Date.now();
    const json = (() => {
      try {
        return JSON.stringify(args.payload);
      } catch {
        return null;
      }
    })();
    if (json == null) return false;
    const result = this.statements.insert.run(
      trimmedRunId,
      args.seq,
      json,
      ts,
    ) as { changes?: number } | undefined;
    return Boolean(result?.changes && result.changes > 0);
  }

  resumeAfter(args: {
    runId: string;
    lastSeq: number;
  }): { events: RunEventRecord[]; exhausted: boolean } {
    if (this.disposed) return { events: [], exhausted: true };
    const runId = args.runId.trim();
    if (!runId) return { events: [], exhausted: true };

    const oldestRow = this.statements.oldestSeq.get(runId) as
      | { min_seq: number | null }
      | undefined;
    const oldest = oldestRow?.min_seq ?? null;
    const exhausted =
      oldest != null && Number.isFinite(args.lastSeq) && args.lastSeq < oldest - 1;

    const rows = this.statements.selectAfter.all(runId, args.lastSeq) as Array<{
      seq: number;
      payload_json: string;
      created_at: number;
    }>;

    const events: RunEventRecord[] = [];
    for (const row of rows) {
      let payload: Record<string, unknown>;
      try {
        const parsed = JSON.parse(row.payload_json) as unknown;
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          payload = parsed as Record<string, unknown>;
        } else {
          continue;
        }
      } catch {
        continue;
      }
      events.push({
        runId,
        seq: row.seq,
        payload,
        createdAt: row.created_at,
      });
    }

    return { events, exhausted };
  }

  ack(args: { runId: string; lastSeq: number }): number {
    if (this.disposed) return 0;
    const runId = args.runId.trim();
    if (!runId) return 0;
    if (!Number.isFinite(args.lastSeq)) return 0;
    const result = this.statements.pruneAcked.run(runId, args.lastSeq) as {
      changes?: number;
    };
    return result?.changes ?? 0;
  }

  forget(runId: string): number {
    if (this.disposed) return 0;
    const trimmed = runId.trim();
    if (!trimmed) return 0;
    const result = this.statements.deleteRun.run(trimmed) as {
      changes?: number;
    };
    return result?.changes ?? 0;
  }

  sweepExpired(retentionMs?: number): number {
    if (this.disposed) return 0;
    const cutoff =
      Date.now() - (retentionMs ?? this.options.retentionMs ?? DEFAULT_RETENTION_MS);
    const result = this.statements.pruneByAge.run(cutoff) as {
      changes?: number;
    };
    return result?.changes ?? 0;
  }

  countForRun(runId: string): number {
    if (this.disposed) return 0;
    const trimmed = runId.trim();
    if (!trimmed) return 0;
    const row = this.statements.countForRun.get(trimmed) as
      | { count: number | null }
      | undefined;
    return Number(row?.count ?? 0);
  }
}
