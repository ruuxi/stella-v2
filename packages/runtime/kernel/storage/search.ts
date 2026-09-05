import {
  parseRecallReference,
  recallMatchedTerms,
  recallLimit,
  recallSearchPlan,
  shouldBroadenRecall,
} from "@stella/contracts/recall";
/**
 * Recall search over the writer-populated `search_text` columns, indexed by
 * the external-content FTS tables `entry_fts` and `thread_fts`.
 */

import type { SqliteDatabase } from "./shared.js";
import {
  THREAD_SEARCH_FTS_CANDIDATE_CAP,
  TRANSCRIPT_SEARCH_TEXT_CAP,
  throwFtsSearchUnavailable,
  tokenizeSearchQuery,
} from "./view.js";
import {
  RUNTIME_THREAD_SELECT,
  deserializeRuntimeThread,
  type RuntimeThreadListing,
} from "./agent-registry.js";
import {
  listTranscriptNeighborsBatch,
  transcriptHitColumns,
} from "./recall-read-queries.js";

export type TranscriptSearchHit = {
  conversationId: string;
  id: string;
  sequence?: number;
  role: "user" | "assistant";
  atMs: number;
  text: string;
  matchTerms?: string[];
};

const escapeLike = (value: string): string =>
  value.replace(/([\\%_])/g, "\\$1");

export class SearchIndex {
  constructor(private readonly db: SqliteDatabase) {}

  private hasThreadFts: boolean | undefined;
  private hasTranscriptFts: boolean | undefined;

  threadFtsAvailable(): boolean {
    if (this.hasThreadFts === undefined) {
      try {
        this.hasThreadFts = Boolean(
          this.db
            .prepare(
              "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'thread_fts'",
            )
            .get(),
        );
      } catch {
        this.hasThreadFts = false;
      }
    }
    return this.hasThreadFts;
  }

  transcriptFtsAvailable(): boolean {
    if (this.hasTranscriptFts === undefined) {
      try {
        this.hasTranscriptFts = Boolean(
          this.db
            .prepare(
              "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'entry_fts'",
            )
            .get(),
        );
      } catch {
        this.hasTranscriptFts = false;
      }
    }
    return this.hasTranscriptFts;
  }

  /* ------------------------------------------------------------------ */
  /* Threads                                                             */
  /* ------------------------------------------------------------------ */

  searchThreads(args: {
    conversationId: string;
    query: string;
    limit?: number;
    degradedMode?: "like";
  }): RuntimeThreadListing[] {
    const limit = Math.max(1, Math.min(25, Math.floor(args.limit ?? 12)));
    const tokens = tokenizeSearchQuery(args.query);
    if (tokens.length === 0) {
      return this.searchThreadsLike(args.conversationId, tokens, limit);
    }
    if (args.degradedMode === "like") {
      console.warn(
        "[stella:recall:fts-degraded]",
        JSON.stringify({ index: "threads", reason: "explicit LIKE mode" }),
      );
      return this.searchThreadsLike(args.conversationId, tokens, limit);
    }
    if (!this.threadFtsAvailable()) {
      return throwFtsSearchUnavailable("threads", "index table is missing");
    }
    try {
      return this.searchThreadsFts(args.conversationId, tokens, limit);
    } catch (error) {
      return throwFtsSearchUnavailable("threads", "MATCH query failed", error);
    }
  }

  private threadTokenClause(): string {
    return `(
      thread.id LIKE ? ESCAPE '\\'
      OR thread.name LIKE ? ESCAPE '\\'
      OR thread.summary LIKE ? ESCAPE '\\'
      OR agent.description LIKE ? ESCAPE '\\'
    )`;
  }

  private searchThreadsFts(
    conversationId: string,
    tokens: string[],
    limit: number,
  ): RuntimeThreadListing[] {
    const matchQuery = tokens
      .map((token) => `"${token.replace(/"/g, '""')}"`)
      .join(" OR ");
    const candidates = this.db
      .prepare(
        `SELECT thread.id AS threadKey
         FROM thread_fts
         JOIN thread ON thread.rowid = thread_fts.rowid
         WHERE thread_fts MATCH ?
         ORDER BY rank
         LIMIT ${THREAD_SEARCH_FTS_CANDIDATE_CAP}`,
      )
      .all(matchQuery) as Array<{ threadKey: string }>;
    if (candidates.length === 0) return [];
    const candidateKeys = candidates.map((row) => row.threadKey);
    const tokenClause = this.threadTokenClause();
    const where = [
      "thread.agent_type != 'orchestrator'",
      "thread.id != ?",
      "thread.id NOT LIKE '%::subagent::%'",
      `thread.id IN (${candidateKeys.map(() => "?").join(", ")})`,
    ].join("\n        AND ");
    const orderBy = `(thread.conversation_id = ?) DESC,
      (${tokens.map(() => `CASE WHEN ${tokenClause} THEN 1 ELSE 0 END`).join(" + ")}) DESC,
      thread.last_used_at DESC`;
    const params: unknown[] = [
      conversationId,
      ...candidateKeys,
      conversationId,
    ];
    for (const token of tokens) {
      const pattern = `%${escapeLike(token)}%`;
      params.push(pattern, pattern, pattern, pattern);
    }
    params.push(limit);
    const rows = this.db
      .prepare(
        `${RUNTIME_THREAD_SELECT}
         WHERE ${where}
         ORDER BY ${orderBy}
         LIMIT ?`,
      )
      .all(...params);
    return rows.map((row) => deserializeRuntimeThread(row));
  }

  private searchThreadsLike(
    conversationId: string,
    tokens: string[],
    limit: number,
  ): RuntimeThreadListing[] {
    const tokenClause = this.threadTokenClause();
    const where = [
      "thread.agent_type != 'orchestrator'",
      "thread.id != ?",
      "thread.id NOT LIKE '%::subagent::%'",
      ...(tokens.length > 0
        ? [`(${tokens.map(() => tokenClause).join("\n        OR ")})`]
        : []),
    ].join("\n        AND ");
    const scopeOrder = "(thread.conversation_id = ?) DESC";
    const orderBy =
      tokens.length > 0
        ? `${scopeOrder},
      (${tokens.map(() => `CASE WHEN ${tokenClause} THEN 1 ELSE 0 END`).join(" + ")}) DESC,
      thread.last_used_at DESC`
        : `${scopeOrder},
      thread.last_used_at DESC`;
    const params: unknown[] = [conversationId];
    const pushTokenParams = () => {
      for (const token of tokens) {
        const pattern = `%${escapeLike(token)}%`;
        params.push(pattern, pattern, pattern, pattern);
      }
    };
    pushTokenParams();
    params.push(conversationId);
    pushTokenParams();
    params.push(limit);
    const rows = this.db
      .prepare(
        `${RUNTIME_THREAD_SELECT}
         WHERE ${where}
         ORDER BY ${orderBy}
         LIMIT ?`,
      )
      .all(...params);
    return rows.map((row) => deserializeRuntimeThread(row));
  }

  /* ------------------------------------------------------------------ */
  /* Transcripts                                                         */
  /* ------------------------------------------------------------------ */

  searchTranscripts(args: {
    query: string;
    terms?: readonly string[];
    limit?: number;
    degradedMode?: "like";
  }): TranscriptSearchHit[] {
    const reference = parseRecallReference(args.query);
    if (reference) {
      const rows = this.db
        .prepare(
          `SELECT ${transcriptHitColumns()} FROM entry
        WHERE entry.id = ? AND entry.conversation_id = ? AND entry.visible = 1
          AND entry.role IN ('user', 'assistant')`,
        )
        .all(reference.id, reference.scope) as Array<Record<string, unknown>>;
      return this.deserializeTranscriptHits(rows);
    }
    const limit = recallLimit(args.limit);
    const plan = recallSearchPlan(args.terms ?? [args.query]);
    if (!plan) return [];
    if (args.degradedMode === "like") {
      console.warn(
        "[stella:recall:fts-degraded]",
        JSON.stringify({ index: "transcripts", reason: "explicit LIKE mode" }),
      );
      const tokens = tokenizeSearchQuery(args.query);
      return tokens.length ? this.searchTranscriptsLike(tokens, limit) : [];
    }
    if (!this.transcriptFtsAvailable()) {
      return throwFtsSearchUnavailable("transcripts", "index table is missing");
    }
    try {
      const hits = this.searchTranscriptsFts(plan.phrase, limit);
      return shouldBroadenRecall(hits.length, limit) &&
        plan.broad !== plan.phrase
        ? this.searchTranscriptsFts(plan.broad, limit)
        : hits;
    } catch (error) {
      return throwFtsSearchUnavailable(
        "transcripts",
        "MATCH query failed",
        error,
      );
    }
  }

  private searchTranscriptsFts(
    matchQuery: string,
    limit: number,
  ): TranscriptSearchHit[] {
    const rows = this.db
      .prepare(
        `SELECT ${transcriptHitColumns()},
      snippet(entry_fts, 0, char(1), char(2), '…', 24) AS matches
      FROM entry_fts JOIN entry ON entry.rowid = entry_fts.rowid
      WHERE entry_fts MATCH ? AND entry.visible = 1 AND entry.role IN ('user', 'assistant')
      ORDER BY bm25(entry_fts), entry.rowid DESC LIMIT ?`,
      )
      .all(matchQuery, limit) as Array<Record<string, unknown>>;
    return this.deserializeTranscriptHits(rows);
  }

  private searchTranscriptsLike(
    tokens: string[],
    limit: number,
  ): TranscriptSearchHit[] {
    const tokenClause = "entry.search_text LIKE ? ESCAPE '\\'";
    const rows = this.db
      .prepare(
        `SELECT ${transcriptHitColumns(TRANSCRIPT_SEARCH_TEXT_CAP)}
         FROM entry
         WHERE entry.search_text IS NOT NULL
           AND (${tokens.map(() => tokenClause).join("\n          OR ")})
         ORDER BY
           (${tokens.map(() => `CASE WHEN ${tokenClause} THEN 1 ELSE 0 END`).join(" + ")}) DESC,
           entry.created_at DESC
         LIMIT ?`,
      )
      .all(
        ...tokens.map((token) => `%${escapeLike(token)}%`),
        ...tokens.map((token) => `%${escapeLike(token)}%`),
        limit,
      ) as Array<Record<string, unknown>>;
    return this.deserializeTranscriptHits(rows);
  }

  private deserializeTranscriptHits(
    rows: Array<Record<string, unknown>>,
  ): TranscriptSearchHit[] {
    return rows.flatMap((row) => {
      const text = typeof row.text === "string" ? row.text : "";
      if (!text.trim()) return [];
      return [
        {
          conversationId: row.conversationId as string,
          id: row.id as string,
          ...(typeof row.sequence === "number"
            ? { sequence: row.sequence }
            : {}),
          role:
            row.role === "assistant"
              ? ("assistant" as const)
              : ("user" as const),
          atMs: row.atMs as number,
          text,
          ...(typeof row.matches === "string"
            ? { matchTerms: recallMatchedTerms(row.matches) }
            : {}),
        },
      ];
    });
  }

  listTranscriptNeighbors(args: {
    conversationId: string;
    atMs: number;
    sequence?: number;
    before?: number;
    after?: number;
    windowMs?: number;
  }): TranscriptSearchHit[] {
    return listTranscriptNeighborsBatch(this.db, [args], args)[0] ?? [];
  }
}
