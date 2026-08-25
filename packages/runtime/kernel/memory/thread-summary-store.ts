/** Durable delegated-thread summaries used by Recall. */

import type { SqliteDatabase } from "../storage/shared.js";
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

  searchThreadSummaries(
    queryTokens: readonly string[],
    args?: { limit?: number },
  ): ThreadSummaryRow[] {
    const tokens = [
      ...new Set(queryTokens.map((token) => token.trim()).filter(Boolean)),
    ].slice(0, 12);
    const limit = Math.max(1, Math.min(args?.limit ?? 20, 100));
    if (tokens.length === 0) return this.listRecentThreadSummaries({ limit });
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
}
