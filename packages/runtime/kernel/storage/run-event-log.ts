import type { SqliteDatabase, SqliteStatement } from "./shared.js";

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

  listBufferedRuns(): Array<{
    runId: string;
    conversationId: string;
    updatedAt: number;
    hasTerminalEvent: boolean;
  }> {
    if (this.disposed) return [];
    const rows = this.db
      .prepare(`
        SELECT run_id, seq, payload_json, created_at
        FROM run_event_log
        ORDER BY created_at DESC, seq DESC
      `)
      .all() as Array<{
      run_id: string;
      seq: number;
      payload_json: string;
      created_at: number;
    }>;
    const byRun = new Map<string, BufferedRunRecord>();
    for (const row of rows) {
      try {
        const parsed = JSON.parse(row.payload_json) as {
          conversationId?: unknown;
          type?: unknown;
        };
        const existing = byRun.get(row.run_id);
        const conversationId =
          typeof parsed.conversationId === "string"
            ? parsed.conversationId.trim()
            : "";
        if (!existing && conversationId) {
          byRun.set(row.run_id, {
            runId: row.run_id,
            conversationId,
            updatedAt: row.created_at,
            hasTerminalEvent: parsed.type === "run-finished",
          });
        } else if (existing) {
          existing.hasTerminalEvent =
            existing.hasTerminalEvent || parsed.type === "run-finished";
          existing.updatedAt = Math.max(existing.updatedAt, row.created_at);
        }
      } catch {

      }
    }
    return [...byRun.values()].sort((left, right) => right.updatedAt - left.updatedAt);
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
      oldest != null &&
      Number.isFinite(args.lastSeq) &&
      args.lastSeq < oldest - 1;

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
