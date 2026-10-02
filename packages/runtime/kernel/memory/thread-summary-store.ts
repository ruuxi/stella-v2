/** Durable delegated-thread summaries. */

import type { SqliteDatabase } from "../storage/shared.js";
import { forkFixedRateFiber } from "../storage/effect-runtime.js";
import { redactMemoryText } from "./redaction.js";

export type ThreadSummaryRow = {
  id: number;
  sourceKey: string;
  threadId: string;
  runId: string;
  agentType: string;
  content: string;
  sourceUpdatedAt: number;
};

export type RecordThreadSummaryArgs = {
  threadId: string;
  runId: string;
  agentType: string;
  rolloutSummary: string;
};

type RawRow = {
  id: number;
  source_key: string;
  thread_id: string;
  run_id: string;
  agent_type: string;
  content: string;
  source_updated_at: number;
};

const ROW_COLUMNS = `
  id,
  source_key,
  thread_id,
  run_id,
  agent_type,
  content,
  source_updated_at
`;

/**
 * Retention for durable thread summaries. Summaries are cheap but unbounded
 * — a long-lived install would otherwise keep every delegated thread forever.
 * Age and count both apply; each pass deletes at most one batch so the sweep
 * never blocks the writer on a huge backlog.
 */
export const THREAD_SUMMARY_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;
export const THREAD_SUMMARY_MAX_ROWS = 5_000;
export const THREAD_SUMMARY_SWEEP_BATCH = 500;
export const THREAD_SUMMARY_SWEEP_INTERVAL_MS = 6 * 60 * 60 * 1000;

const fromRow = (row: RawRow): ThreadSummaryRow => ({
  id: row.id,
  sourceKey: row.source_key,
  threadId: row.thread_id,
  runId: row.run_id,
  agentType: row.agent_type,
  content: row.content,
  sourceUpdatedAt: row.source_updated_at,
});

export class ThreadSummaryStore {
  /** Cancel thunk for the fixed-rate retention fiber. */
  private cancelSweep: (() => void) | null = null;

  constructor(private readonly db: SqliteDatabase) {}

  recordThreadSummary(args: RecordThreadSummaryArgs): void {
    const content = redactMemoryText(args.rolloutSummary.trim());
    if (!content) return;
    this.db
      .prepare(
        `
        INSERT INTO durable_thread_summaries (
          source_key, thread_id, run_id, agent_type, content,
          source_updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(source_key) DO UPDATE SET
          thread_id = excluded.thread_id,
          run_id = excluded.run_id,
          agent_type = excluded.agent_type,
          content = excluded.content,
          source_updated_at = excluded.source_updated_at
        `,
      )
      .run(
        `${args.threadId}:${args.runId}`,
        args.threadId,
        args.runId,
        args.agentType,
        content,
        Date.now(),
      );
  }

  promoteThreadSummaryConversation(args: {
    threadId: string;
    conversationId: string;
    rolloutSummary: string;
  }): { updated: number } {
    const conversationId = args.conversationId.trim();
    const content = redactMemoryText(args.rolloutSummary.trim());
    if (!conversationId || !content) return { updated: 0 };
    const result = this.db
      .prepare(
        `
        UPDATE durable_thread_summaries
        SET conversation_id = ?
        WHERE thread_id = ? AND conversation_id IS NULL AND content = ?
        `,
      )
      .run(conversationId, args.threadId, content) as
      | { changes?: number }
      | undefined;
    return { updated: Number(result?.changes ?? 0) };
  }

  listRecentThreadSummaries(args?: { limit?: number }): ThreadSummaryRow[] {
    const limit = Math.max(1, Math.min(args?.limit ?? 20, 200));
    return (
      this.db
        .prepare(
          `
          SELECT ${ROW_COLUMNS}
          FROM durable_thread_summaries
          ORDER BY source_updated_at DESC
          LIMIT ?
          `,
        )
        .all(limit) as RawRow[]
    ).map(fromRow);
  }

  /**
   * Bounded retention pass, modeled on the run-event-log sweep: drop summaries
   * past `retentionMs`, then trim the tail beyond `maxRows`. Each statement is
   * capped at `THREAD_SUMMARY_SWEEP_BATCH` rows so a backlog drains over
   * several passes instead of one long write.
   */
  sweepThreadSummaries(args?: {
    retentionMs?: number;
    maxRows?: number;
    batchSize?: number;
    now?: number;
  }): number {
    const retentionMs = args?.retentionMs ?? THREAD_SUMMARY_RETENTION_MS;
    const maxRows = Math.max(0, args?.maxRows ?? THREAD_SUMMARY_MAX_ROWS);
    const batchSize = Math.max(
      1,
      args?.batchSize ?? THREAD_SUMMARY_SWEEP_BATCH,
    );
    const cutoff = (args?.now ?? Date.now()) - retentionMs;
    const byAge = this.db
      .prepare(
        `
        DELETE FROM durable_thread_summaries
        WHERE id IN (
          SELECT id FROM durable_thread_summaries
          WHERE source_updated_at < ?
          ORDER BY source_updated_at ASC, id ASC
          LIMIT ?
        )
        `,
      )
      .run(cutoff, batchSize) as { changes?: number } | undefined;
    const byCount = this.db
      .prepare(
        `
        DELETE FROM durable_thread_summaries
        WHERE id IN (
          SELECT id FROM durable_thread_summaries
          ORDER BY source_updated_at DESC, id DESC
          LIMIT ? OFFSET ?
        )
        `,
      )
      .run(batchSize, maxRows) as { changes?: number } | undefined;
    return Number(byAge?.changes ?? 0) + Number(byCount?.changes ?? 0);
  }

  /** Fixed-rate retention fiber; the cancel thunk is the old `clearInterval`. */
  startBackgroundSweep(options?: {
    intervalMs?: number;
    retentionMs?: number;
    maxRows?: number;
  }): void {
    if (this.cancelSweep) return;
    this.cancelSweep = forkFixedRateFiber(
      options?.intervalMs ?? THREAD_SUMMARY_SWEEP_INTERVAL_MS,
      () => {
        try {
          this.sweepThreadSummaries(options);
        } catch {
          /* the next sweep retries */
        }
      },
    );
  }

  stopBackgroundSweep(): void {
    if (!this.cancelSweep) return;
    this.cancelSweep();
    this.cancelSweep = null;
  }
}
