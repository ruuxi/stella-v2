/** Durable delegated-thread summaries used by Recall. */

import {
  recallSearchPlan,
  shouldBroadenRecall,
} from "@stella/contracts/recall";

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

/** The FTS join repeats every column name, so hits must qualify them. */
const QUALIFIED_ROW_COLUMNS = `
  s.id AS id,
  s.source_key AS source_key,
  s.thread_id AS thread_id,
  s.run_id AS run_id,
  s.agent_type AS agent_type,
  s.content AS content,
  s.source_updated_at AS source_updated_at
`;

const FTS_TABLE = "durable_thread_summaries_fts";

/**
 * Retention for Recall's durable summaries. Summaries are cheap but unbounded
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

const escapeLike = (value: string): string =>
  value.replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_");

export class ThreadSummaryStore {
  /** Cancel thunk for the fixed-rate retention fiber. */
  private cancelSweep: (() => void) | null = null;
  private hasFts: boolean | undefined;

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

  /** The FTS table is absent on SQLite builds without FTS5 (see schema.ts). */
  ftsAvailable(): boolean {
    if (this.hasFts === undefined) {
      try {
        this.hasFts = Boolean(
          this.db
            .prepare(
              "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?",
            )
            .get(FTS_TABLE),
        );
      } catch {
        this.hasFts = false;
      }
    }
    return this.hasFts;
  }

  searchThreadSummaries(
    queryTokens: readonly string[],
    args?: { limit?: number },
  ): ThreadSummaryRow[] {
    const tokens = [
      ...new Set(queryTokens.map((token) => token.trim()).filter(Boolean)),
    ].slice(0, 12);
    const limit = Math.max(1, Math.min(args?.limit ?? 20, 100));
    if (tokens.length === 0) return this.listRecentThreadSummaries({ limit });
    // Same plan the cloud transcript index runs: quoted phrases first, then a
    // broadened word query when the phrase pass is too thin to be useful.
    const plan = this.ftsAvailable() ? recallSearchPlan(tokens) : null;
    if (plan) {
      try {
        const phraseHits = this.matchThreadSummaries(plan.phrase, limit);
        return plan.broad !== plan.phrase &&
          shouldBroadenRecall(phraseHits.length, limit)
          ? this.matchThreadSummaries(plan.broad, limit)
          : phraseHits;
      } catch {
        // A corrupt or missing index must not take Recall offline.
        this.hasFts = false;
      }
    }
    return this.searchThreadSummariesLike(tokens, limit);
  }

  private matchThreadSummaries(
    query: string,
    limit: number,
  ): ThreadSummaryRow[] {
    return (
      this.db
        .prepare(
          `
          SELECT ${QUALIFIED_ROW_COLUMNS}
          FROM ${FTS_TABLE} AS f
          JOIN durable_thread_summaries AS s ON s.id = f.rowid
          WHERE ${FTS_TABLE} MATCH ?
          ORDER BY bm25(${FTS_TABLE}) ASC,
                   s.source_updated_at DESC,
                   s.id DESC
          LIMIT ?
          `,
        )
        .all(query, limit) as RawRow[]
    ).map(fromRow);
  }

  private searchThreadSummariesLike(
    tokens: readonly string[],
    limit: number,
  ): ThreadSummaryRow[] {
    const matchClause = [
      "content LIKE ? ESCAPE '\\'",
      "thread_id LIKE ? ESCAPE '\\'",
      "run_id LIKE ? ESCAPE '\\'",
      "agent_type LIKE ? ESCAPE '\\'",
    ].join(" OR ");
    const patterns = tokens.map((token) => `%${escapeLike(token)}%`);
    const parameters = patterns.flatMap((pattern) =>
      Array.from({ length: 4 }, () => pattern),
    );
    return (
      this.db
        .prepare(
          `
          SELECT ${ROW_COLUMNS}
          FROM durable_thread_summaries
          WHERE ${tokens.map(() => `(${matchClause})`).join(" OR ")}
          ORDER BY source_updated_at DESC, id DESC
          LIMIT ?
          `,
        )
        .all(...parameters, limit) as RawRow[]
    ).map(fromRow);
  }

  findThreadSummariesByThreadIds(
    threadIds: readonly string[],
  ): ThreadSummaryRow[] {
    const ids = [
      ...new Set(threadIds.map((id) => id.trim()).filter(Boolean)),
    ].slice(0, 100);
    if (ids.length === 0) return [];
    const rows = this.db
      .prepare(
        `
        SELECT ${ROW_COLUMNS}
        FROM durable_thread_summaries
        WHERE thread_id IN (${ids.map(() => "?").join(", ")})
        ORDER BY source_updated_at DESC, id DESC
        `,
      )
      .all(...ids) as RawRow[];
    const seen = new Set<string>();
    return rows.flatMap((row) => {
      if (seen.has(row.thread_id)) return [];
      seen.add(row.thread_id);
      return [fromRow(row)];
    });
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
