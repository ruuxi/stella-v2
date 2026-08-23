/**
 * DreamInboxStore — the single durable queue of everything the Dream agent
 * consolidates into `~/.stella/memories/`.
 *
 * Three kinds of rows flow through it:
 *   - `thread_summary` — one row per finalized subagent run (upserted by
 *     (threadId, runId); re-recording a run resets its processed state).
 *   - `memory_note`    — one row per orchestrator memory-review candidate.
 *   - `chronicle`      — the rolling screen-activity digest per window
 *     ("10m"/"6h"); upserted by window so refreshes coalesce into one
 *     unprocessed row instead of flooding the queue.
 *
 * `processed_by_dream_at IS NULL` is the entire queue state. The persisted
 * consolidation watermark is scheduling bookkeeping only; Dream still lists
 * unprocessed rows and marks them processed by id.
 *
 * The store is intentionally tiny — it is a queue, not a search index.
 *
 * Effect-native: every sqlite access is an Effect (`makeDreamInboxEffects`).
 * The exported `DreamInboxStore` class keeps its synchronous method surface
 * — callers run inside SQLite transactions and cannot await — as a facade
 * over the shared memory ManagedRuntime (`runMemorySync`), rethrowing the
 * original failure objects with byte-identical messages.
 */

import { Effect } from "effect";
import type { SqliteDatabase } from "../storage/shared.js";
import { redactMemoryText, redactMemoryStringArray } from "./redaction.js";
import {
  MemoryNoteInvalidError,
  MemoryNoteKeyExhaustedError,
} from "./errors.js";
import { runMemorySync } from "./effect-runtime.js";

export type DreamInboxKind = "thread_summary" | "memory_note" | "chronicle";

export type DreamInboxRow = {
  id: number;
  kind: DreamInboxKind;
  sourceKey: string;
  threadId: string | null;
  runId: string | null;
  agentType: string | null;
  title: string | null;
  content: string;
  metadata: Record<string, unknown> | null;
  /** Conversation whose raw orchestrator window durably contains the row. */
  conversationId: string | null;
  sourceUpdatedAt: number;
  processedByDreamAt: number | null;
  usageCount: number;
  lastUsage: number | null;
};

export type RecordThreadSummaryArgs = {
  threadId: string;
  runId: string;
  agentType: string;
  rolloutSummary: string;
  /** Omit until the same report has persisted in this conversation. */
  conversationId?: string;
};

export type MemoryNoteCandidate = {
  title: string;
  category: string;
  memory: string;
  recallHooks: string[];
  evidence: string[];
  createdAt?: Date;
};

export type RecordChronicleSummaryArgs = {
  window: string;
  content: string;
  uniqueLines?: number;
};

type DreamInboxRawRow = {
  id: number;
  kind: string;
  source_key: string;
  thread_id: string | null;
  run_id: string | null;
  agent_type: string | null;
  title: string | null;
  content: string;
  metadata: string | null;
  conversation_id: string | null;
  source_updated_at: number;
  processed_by_dream_at: number | null;
  usage_count: number;
  last_usage: number | null;
};

const ROW_COLUMNS = `
  id,
  kind,
  source_key,
  thread_id,
  run_id,
  agent_type,
  title,
  content,
  metadata,
  conversation_id,
  source_updated_at,
  processed_by_dream_at,
  usage_count,
  last_usage
`;

export const DREAM_USAGE_REQUEUE_DEBOUNCE_MS = 6 * 60 * 60 * 1_000;

/** Retention for consumed, no-longer-used, non-Chronicle inbox rows. */
export const DREAM_INBOX_GC_RETENTION_MS = 30 * 24 * 60 * 60 * 1_000;

const parseMetadata = (raw: string | null): Record<string, unknown> | null => {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object"
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
};

const fromRow = (row: DreamInboxRawRow): DreamInboxRow => ({
  id: row.id,
  kind: row.kind as DreamInboxKind,
  sourceKey: row.source_key,
  threadId: row.thread_id,
  runId: row.run_id,
  agentType: row.agent_type,
  title: row.title,
  content: row.content,
  metadata: parseMetadata(row.metadata),
  conversationId: row.conversation_id,
  sourceUpdatedAt: row.source_updated_at,
  processedByDreamAt: row.processed_by_dream_at,
  usageCount: row.usage_count,
  lastUsage: row.last_usage,
});

const NOTE_SLUG_MAX_CHARS = 80;

const slugify = (input: string): string => {
  const slug = input
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, NOTE_SLUG_MAX_CHARS)
    .replace(/-+$/g, "");
  return slug || "memory-note";
};

const formatList = (items: string[]): string =>
  items.length > 0
    ? items.map((item) => `- ${item.trim()}`).join("\n")
    : "- None";

const formatMemoryNote = (note: Required<MemoryNoteCandidate>): string =>
  [
    `- title: ${note.title}`,
    `- category: ${note.category}`,
    `- created_at: ${note.createdAt.toISOString()}`,
    "- source: Orchestrator conversation review",
    "",
    "## Candidate",
    note.memory,
    "",
    "## Recall hooks",
    formatList(note.recallHooks),
    "",
    "## Evidence",
    formatList(note.evidence),
  ].join("\n");

/** One synchronous sqlite interaction as an Effect. */
const trySqlite = <A>(op: () => A): Effect.Effect<A, Error> =>
  Effect.try({ try: op, catch: (error) => error as Error });

export interface DreamInboxEffects {
  readonly recordThreadSummary: (
    args: RecordThreadSummaryArgs,
  ) => Effect.Effect<void, Error>;
  readonly recordMemoryNote: (
    candidate: MemoryNoteCandidate,
    opts?: { conversationId?: string },
  ) => Effect.Effect<
    { id: number },
    Error | MemoryNoteInvalidError | MemoryNoteKeyExhaustedError
  >;
  readonly recordChronicleSummary: (
    args: RecordChronicleSummaryArgs,
  ) => Effect.Effect<void, Error>;
  readonly listUnprocessed: (args?: {
    limit?: number;
  }) => Effect.Effect<DreamInboxRow[], Error>;
  readonly countUnprocessed: () => Effect.Effect<number, Error>;
  readonly pendingFrontier: () => Effect.Effect<number, Error>;
  readonly readConsolidationWatermark: () => Effect.Effect<
    { frontier: number; completedAt: number } | null,
    Error
  >;
  readonly writeConsolidationWatermark: (args: {
    frontier: number;
    completedAt?: number;
  }) => Effect.Effect<void, Error>;
  readonly readDeltaWatermark: (
    conversationId: string,
  ) => Effect.Effect<number, Error>;
  readonly advanceDeltaWatermark: (
    conversationId: string,
    lastMessageTs: number,
  ) => Effect.Effect<void, Error>;
  readonly readAppliedThroughTs: (
    conversationId: string,
  ) => Effect.Effect<number, Error>;
  readonly promoteThreadSummaryConversation: (args: {
    threadId: string;
    conversationId: string;
    rolloutSummary: string;
  }) => Effect.Effect<{ updated: number }, Error>;
  readonly readTokenBaseline: () => Effect.Effect<number | null, Error>;
  readonly writeTokenBaseline: (tokens: number) => Effect.Effect<void, Error>;
  readonly maxProcessedSourceUpdatedAtSince: (
    sinceMs: number,
  ) => Effect.Effect<number, Error>;
  readonly markProcessed: (args: {
    ids: number[];
    processedAt?: number;
  }) => Effect.Effect<{ updated: number }, Error>;
  readonly gcProcessedRows: (args?: {
    retentionMs?: number;
    nowMs?: number;
  }) => Effect.Effect<{ deleted: number }, Error>;
  readonly listRecentThreadSummaries: (args?: {
    limit?: number;
  }) => Effect.Effect<DreamInboxRow[], Error>;
  readonly findThreadSummariesByThreadIds: (
    threadIds: readonly string[],
  ) => Effect.Effect<DreamInboxRow[], Error>;
  readonly listRecentMemoryNotes: (
    limit?: number,
  ) => Effect.Effect<string[], Error>;
  readonly recordUsage: (
    threadId: string,
    runId: string,
    options?: { nowMs?: number; requeueDebounceMs?: number },
  ) => Effect.Effect<void, Error>;
}

export const makeDreamInboxEffects = (
  db: SqliteDatabase,
): DreamInboxEffects => {
  const upsert = (args: {
    kind: DreamInboxKind;
    sourceKey: string;
    threadId: string | null;
    runId: string | null;
    agentType: string | null;
    title: string | null;
    content: string;
    metadata: string | null;
    conversationId?: string | null;
  }): Effect.Effect<void, Error> =>
    trySqlite(() => {
      db.prepare(
        `
        INSERT INTO dream_inbox (
          kind, source_key, thread_id, run_id, agent_type, title,
          content, metadata, conversation_id, source_updated_at, processed_by_dream_at,
          usage_count, last_usage
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 0, NULL)
        ON CONFLICT(kind, source_key) DO UPDATE SET
          thread_id = excluded.thread_id,
          run_id = excluded.run_id,
          agent_type = excluded.agent_type,
          title = excluded.title,
          content = excluded.content,
          metadata = excluded.metadata,
          conversation_id = excluded.conversation_id,
          source_updated_at = excluded.source_updated_at,
          processed_by_dream_at = NULL
        `,
      ).run(
        args.kind,
        args.sourceKey,
        args.threadId,
        args.runId,
        args.agentType,
        args.title,
        args.content,
        args.metadata,
        args.conversationId ?? null,
        Date.now(),
      );
    });

  return {
    /**
     * Insert or replace the rollout summary for (threadId, runId).
     *
     * `rolloutSummary` is the subagent's final output text. Re-recording the
     * same run replaces the content and resets the processed state so Dream
     * picks the freshest version up again.
     */
    recordThreadSummary: (args) =>
      Effect.suspend(() => {
        const summary = redactMemoryText(args.rolloutSummary.trim());
        if (!summary) return Effect.void;
        return upsert({
          kind: "thread_summary",
          sourceKey: `${args.threadId}:${args.runId}`,
          threadId: args.threadId,
          runId: args.runId,
          agentType: args.agentType,
          title: null,
          content: summary,
          metadata: null,
          conversationId: args.conversationId?.trim() || null,
        });
      }),

    /**
     * Queue an orchestrator memory-review candidate. Each note is its own row
     * (no coalescing); the formatted markdown body is what Dream and the
     * known-memory context read. Key probing retries up to 100 suffixed keys
     * before failing with the exhaustion error.
     */
    recordMemoryNote: (candidate, opts) =>
      Effect.gen(function* () {
        const title = redactMemoryText(candidate.title.trim());
        const memory = redactMemoryText(candidate.memory.trim());
        if (!title) {
          return yield* Effect.fail(
            new MemoryNoteInvalidError({ field: "title" }),
          );
        }
        if (!memory) {
          return yield* Effect.fail(
            new MemoryNoteInvalidError({ field: "memory" }),
          );
        }

        const createdAt = candidate.createdAt ?? new Date();
        const note: Required<MemoryNoteCandidate> = {
          title,
          category: redactMemoryText(candidate.category.trim()) || "active_focus",
          memory,
          recallHooks: redactMemoryStringArray(
            candidate.recallHooks.map((hook) => hook.trim()).filter(Boolean),
          ),
          evidence: redactMemoryStringArray(
            candidate.evidence.map((item) => item.trim()).filter(Boolean),
          ),
          createdAt,
        };
        const baseKey = `${createdAt.getTime()}-${slugify(title)}`;
        const content = formatMemoryNote(note);
        const metadata = JSON.stringify({
          category: note.category,
          recallHooks: note.recallHooks,
          evidence: note.evidence,
        });

        const conversationId = opts?.conversationId?.trim() || null;
        for (let attempt = 0; attempt < 100; attempt += 1) {
          const sourceKey = attempt === 0 ? baseKey : `${baseKey}-${attempt + 1}`;
          const result = yield* trySqlite(
            () =>
              db
                .prepare(
                  `
                  INSERT INTO dream_inbox (
                    kind, source_key, thread_id, run_id, agent_type, title,
                    content, metadata, conversation_id, source_updated_at, processed_by_dream_at,
                    usage_count, last_usage
                  )
                  VALUES ('memory_note', ?, NULL, NULL, NULL, ?, ?, ?, ?, ?, NULL, 0, NULL)
                  ON CONFLICT(kind, source_key) DO NOTHING
                  `,
                )
                .run(
                  sourceKey,
                  note.title,
                  content,
                  metadata,
                  conversationId,
                  createdAt.getTime(),
                ) as
                | { changes?: number; lastInsertRowid?: number | bigint }
                | undefined,
          );
          if (Number(result?.changes ?? 0) > 0) {
            return { id: Number(result?.lastInsertRowid ?? 0) };
          }
        }
        return yield* Effect.fail(new MemoryNoteKeyExhaustedError());
      }),

    /**
     * Upsert the rolling chronicle digest for a window. Refreshes overwrite
     * the window's row and reset its processed state, so however often the
     * summarizer runs, Dream only ever sees the latest digest once.
     */
    recordChronicleSummary: (args) =>
      Effect.suspend(() => {
        const content = redactMemoryText(args.content.trim());
        if (!content) return Effect.void;
        return upsert({
          kind: "chronicle",
          sourceKey: args.window,
          threadId: null,
          runId: null,
          agentType: null,
          title: `Chronicle ${args.window} screen-activity digest`,
          content,
          metadata: JSON.stringify({
            window: args.window,
            ...(typeof args.uniqueLines === "number"
              ? { uniqueLines: args.uniqueLines }
              : {}),
          }),
        });
      }),

    /**
     * Frequently surfaced rows lead, then the remaining queue is oldest-first.
     * This makes Dream retain and refresh memory that repeatedly proves useful.
     */
    listUnprocessed: (args) =>
      trySqlite(() => {
        const limit = Math.max(1, Math.min(args?.limit ?? 50, 500));
        const rows = db
          .prepare(
            `
            SELECT ${ROW_COLUMNS}
            FROM dream_inbox
            WHERE processed_by_dream_at IS NULL
            ORDER BY usage_count DESC, COALESCE(last_usage, 0) DESC,
                     source_updated_at ASC, id ASC
            LIMIT ?
            `,
          )
          .all(limit) as DreamInboxRawRow[];
        return rows.map(fromRow);
      }),

    /** Count of unprocessed rows; the Dream scheduler's eligibility gate. */
    countUnprocessed: () =>
      trySqlite(() => {
        const row = db
          .prepare(
            `SELECT COUNT(*) AS c FROM dream_inbox WHERE processed_by_dream_at IS NULL`,
          )
          .get() as { c?: number } | undefined;
        return Number(row?.c ?? 0);
      }),

    /**
     * Newest pending material, used only to skip redundant pre-compaction
     * consolidation waits. Per-row processed state remains the queue authority.
     */
    pendingFrontier: () =>
      trySqlite(() => {
        const row = db
          .prepare(
            `SELECT MAX(source_updated_at) AS frontier FROM dream_inbox WHERE processed_by_dream_at IS NULL`,
          )
          .get() as { frontier?: number | null } | undefined;
        const frontier = Number(row?.frontier ?? 0);
        return Number.isFinite(frontier) && frontier > 0 ? frontier : 0;
      }),

    /** Last completed pass frontier, persisted across app restarts. */
    readConsolidationWatermark: () =>
      trySqlite(() => {
        const row = db
          .prepare(
            `SELECT frontier, completed_at FROM dream_consolidation_watermark WHERE id = 1`,
          )
          .get() as { frontier?: number; completed_at?: number } | undefined;
        if (!row || typeof row.frontier !== "number") return null;
        return {
          frontier: row.frontier,
          completedAt: Number(row.completed_at ?? 0),
        };
      }),

    /**
     * Monotonically advance the completed-pass frontier. A delayed process can
     * never move it backwards; a failed write merely causes a redundant pass.
     */
    writeConsolidationWatermark: (args) =>
      trySqlite(() => {
        if (!Number.isFinite(args.frontier) || args.frontier <= 0) return;
        db.prepare(
          `
          INSERT INTO dream_consolidation_watermark (id, frontier, completed_at)
          VALUES (1, ?, ?)
          ON CONFLICT(id) DO UPDATE SET
            frontier = MAX(dream_consolidation_watermark.frontier, excluded.frontier),
            completed_at = excluded.completed_at
          `,
        ).run(args.frontier, args.completedAt ?? Date.now());
      }),

    /** Persisted raw-message frontier covered by a completed shadow proposal. */
    readDeltaWatermark: (conversationId) =>
      trySqlite(() => {
        const row = db
          .prepare(
            `SELECT last_message_ts FROM dream_delta_watermark WHERE conversation_id = ?`,
          )
          .get(conversationId) as { last_message_ts?: number } | undefined;
        const value = Number(row?.last_message_ts ?? 0);
        return Number.isFinite(value) && value > 0 ? value : 0;
      }),

    /** Monotonic: a stale shadow completion cannot move coverage backwards. */
    advanceDeltaWatermark: (conversationId, lastMessageTs) =>
      trySqlite(() => {
        const id = conversationId.trim();
        if (!id || !Number.isFinite(lastMessageTs) || lastMessageTs <= 0) return;
        db.prepare(
          `
          INSERT INTO dream_delta_watermark (
            conversation_id, last_message_ts, applied_through_ts, updated_at
          ) VALUES (?, ?, NULL, ?)
          ON CONFLICT(conversation_id) DO UPDATE SET
            last_message_ts = MAX(dream_delta_watermark.last_message_ts, excluded.last_message_ts),
            updated_at = excluded.updated_at
          `,
        ).run(id, Math.floor(lastMessageTs), Date.now());
      }),

    /**
     * Production delta consumption remains disabled. This separate field stays
     * null/zero during shadow validation and prevents shadow coverage from ever
     * being mistaken for an applied memory rewrite after a future promotion.
     */
    readAppliedThroughTs: (conversationId) =>
      trySqlite(() => {
        const row = db
          .prepare(
            `SELECT applied_through_ts FROM dream_delta_watermark WHERE conversation_id = ?`,
          )
          .get(conversationId) as
          | { applied_through_ts?: number | null }
          | undefined;
        const value = Number(row?.applied_through_ts ?? 0);
        return Number.isFinite(value) && value > 0 ? value : 0;
      }),

    /**
     * Phase two of report provenance. The agent_end hook creates an unstamped
     * row; only the durable orchestrator-report branch calls this afterwards.
     * Content and thread identity make stale/superseded events fail closed.
     */
    promoteThreadSummaryConversation: (args) =>
      trySqlite(() => {
        const conversationId = args.conversationId.trim();
        const content = redactMemoryText(args.rolloutSummary.trim());
        if (!conversationId || !content) return { updated: 0 };
        const result = db
          .prepare(
            `
            UPDATE dream_inbox
            SET conversation_id = ?
            WHERE kind = 'thread_summary'
              AND thread_id = ?
              AND conversation_id IS NULL
              AND processed_by_dream_at IS NULL
              AND content = ?
            `,
          )
          .run(conversationId, args.threadId, content) as
          | { changes?: number }
          | undefined;
        return { updated: Number(result?.changes ?? 0) };
      }),

    readTokenBaseline: () =>
      trySqlite(() => {
        const row = db
          .prepare(
            `SELECT tokens_at_last_run FROM dream_scheduler_state WHERE id = 1`,
          )
          .get() as { tokens_at_last_run?: number } | undefined;
        const value = Number(row?.tokens_at_last_run);
        return Number.isFinite(value) && value >= 0 ? value : null;
      }),

    writeTokenBaseline: (tokens) =>
      trySqlite(() => {
        if (!Number.isFinite(tokens) || tokens < 0) return;
        db.prepare(
          `
          INSERT INTO dream_scheduler_state (id, tokens_at_last_run, updated_at)
          VALUES (1, ?, ?)
          ON CONFLICT(id) DO UPDATE SET
            tokens_at_last_run = excluded.tokens_at_last_run,
            updated_at = excluded.updated_at
          `,
        ).run(Math.floor(tokens), Date.now());
      }),

    maxProcessedSourceUpdatedAtSince: (sinceMs) =>
      trySqlite(() => {
        const row = db
          .prepare(
            `SELECT MAX(source_updated_at) AS frontier
             FROM dream_inbox
             WHERE processed_by_dream_at IS NOT NULL
               AND processed_by_dream_at >= ?`,
          )
          .get(sinceMs) as { frontier?: number | null } | undefined;
        return Number(row?.frontier ?? 0);
      }),

    /** Stamp rows as consumed by Dream. Returns how many rows were updated. */
    markProcessed: (args) =>
      trySqlite(() => {
        if (args.ids.length === 0) return { updated: 0 };
        const processedAt = args.processedAt ?? Date.now();
        const stmt = db.prepare(
          `
          UPDATE dream_inbox
          SET processed_by_dream_at = ?
          WHERE id = ? AND processed_by_dream_at IS NULL
          `,
        );
        let updated = 0;
        // One atomic sqlite transaction; the driver is synchronous, so the
        // BEGIN/COMMIT/ROLLBACK sequencing stays inside this single Effect.
        db.exec("BEGIN TRANSACTION;");
        try {
          for (const id of args.ids) {
            const result = stmt.run(processedAt, id) as
              | { changes?: number }
              | undefined;
            updated += Number(result?.changes ?? 0);
          }
          db.exec("COMMIT;");
        } catch (error) {
          db.exec("ROLLBACK;");
          throw error;
        }
        return { updated };
      }),

    /**
     * Conservatively collect only old rows that Dream already consumed.
     * Pending rows, recently surfaced rows, and bounded Chronicle window rows
     * are deliberately retained.
     */
    gcProcessedRows: (args) =>
      trySqlite(() => {
        const retentionMs = Math.max(
          0,
          args?.retentionMs ?? DREAM_INBOX_GC_RETENTION_MS,
        );
        const cutoff = (args?.nowMs ?? Date.now()) - retentionMs;
        const result = db
          .prepare(
            `
            DELETE FROM dream_inbox
            WHERE processed_by_dream_at IS NOT NULL
              AND processed_by_dream_at < ?
              AND (last_usage IS NULL OR last_usage < ?)
              AND kind != 'chronicle'
            `,
          )
          .run(cutoff, cutoff) as { changes?: number } | undefined;
        return { deleted: Number(result?.changes ?? 0) };
      }),

    /**
     * Most recent thread summaries by source_updated_at regardless of
     * processed state. Used by background passes that want a "what has the
     * user been doing lately" snapshot.
     */
    listRecentThreadSummaries: (args) =>
      trySqlite(() => {
        const limit = Math.max(1, Math.min(args?.limit ?? 20, 200));
        const rows = db
          .prepare(
            `
            SELECT ${ROW_COLUMNS}
            FROM dream_inbox
            WHERE kind = 'thread_summary'
            ORDER BY source_updated_at DESC
            LIMIT ?
            `,
          )
          .all(limit) as DreamInboxRawRow[];
        return rows.map(fromRow);
      }),

    /** Resolve the newest summary for each exact surfaced thread id. */
    findThreadSummariesByThreadIds: (threadIds) =>
      trySqlite(() => {
        const ids = [
          ...new Set(threadIds.map((id) => id.trim()).filter(Boolean)),
        ].slice(0, 100);
        if (ids.length === 0) return [];
        const rows = db
          .prepare(
            `
            SELECT ${ROW_COLUMNS}
            FROM dream_inbox
            WHERE kind = 'thread_summary'
              AND thread_id IN (${ids.map(() => "?").join(", ")})
            ORDER BY source_updated_at DESC, id DESC
            `,
          )
          .all(...ids) as DreamInboxRawRow[];
        const seen = new Set<string>();
        return rows.flatMap((row) => {
          if (!row.thread_id || seen.has(row.thread_id)) return [];
          seen.add(row.thread_id);
          return [fromRow(row)];
        });
      }),

    /**
     * Newest-first memory-note bodies, consolidated or not. The memory-review
     * pass includes these in its known-memory context so it does not re-propose
     * a candidate Dream has not folded yet.
     */
    listRecentMemoryNotes: (limit = 8) =>
      trySqlite(() => {
        if (limit <= 0) return [];
        const rows = db
          .prepare(
            `
            SELECT content
            FROM dream_inbox
            WHERE kind = 'memory_note'
            ORDER BY source_updated_at DESC, id DESC
            LIMIT ?
            `,
          )
          .all(Math.min(limit, 50)) as Array<{ content: string }>;
        return rows.map((row) => row.content).filter(Boolean);
      }),

    /**
     * Update usage counters when the Orchestrator surfaces a thread summary in
     * its working context. Pure bookkeeping; never throws on missing rows.
     */
    recordUsage: (threadId, runId, options) =>
      trySqlite(() => {
        const nowMs = options?.nowMs ?? Date.now();
        const requeueDebounceMs = Math.max(
          0,
          options?.requeueDebounceMs ?? DREAM_USAGE_REQUEUE_DEBOUNCE_MS,
        );
        db.prepare(
          `
          UPDATE dream_inbox
          SET usage_count = usage_count + 1,
              last_usage = ?,
              processed_by_dream_at = CASE
                WHEN last_usage IS NULL OR last_usage <= ? THEN NULL
                ELSE processed_by_dream_at
              END
          WHERE kind = 'thread_summary' AND thread_id = ? AND run_id = ?
          `,
        ).run(nowMs, nowMs - requeueDebounceMs, threadId, runId);
      }),
  };
};

/**
 * Synchronous facade preserved for callers that run inside SQLite
 * transactions (SessionStore, Dream scheduler, tool dispatch). Every method
 * delegates to the Effect core through the shared memory runtime.
 */
export class DreamInboxStore {
  private readonly effects: DreamInboxEffects;

  constructor(db: SqliteDatabase) {
    this.effects = makeDreamInboxEffects(db);
  }

  recordThreadSummary(args: RecordThreadSummaryArgs): void {
    runMemorySync(this.effects.recordThreadSummary(args));
  }

  recordMemoryNote(
    candidate: MemoryNoteCandidate,
    opts?: { conversationId?: string },
  ): { id: number } {
    return runMemorySync(this.effects.recordMemoryNote(candidate, opts));
  }

  recordChronicleSummary(args: RecordChronicleSummaryArgs): void {
    runMemorySync(this.effects.recordChronicleSummary(args));
  }

  listUnprocessed(args?: { limit?: number }): DreamInboxRow[] {
    return runMemorySync(this.effects.listUnprocessed(args));
  }

  countUnprocessed(): number {
    return runMemorySync(this.effects.countUnprocessed());
  }

  pendingFrontier(): number {
    return runMemorySync(this.effects.pendingFrontier());
  }

  readConsolidationWatermark(): {
    frontier: number;
    completedAt: number;
  } | null {
    return runMemorySync(this.effects.readConsolidationWatermark());
  }

  writeConsolidationWatermark(args: {
    frontier: number;
    completedAt?: number;
  }): void {
    runMemorySync(this.effects.writeConsolidationWatermark(args));
  }

  readDeltaWatermark(conversationId: string): number {
    return runMemorySync(this.effects.readDeltaWatermark(conversationId));
  }

  advanceDeltaWatermark(conversationId: string, lastMessageTs: number): void {
    runMemorySync(
      this.effects.advanceDeltaWatermark(conversationId, lastMessageTs),
    );
  }

  readAppliedThroughTs(conversationId: string): number {
    return runMemorySync(this.effects.readAppliedThroughTs(conversationId));
  }

  promoteThreadSummaryConversation(args: {
    threadId: string;
    conversationId: string;
    rolloutSummary: string;
  }): { updated: number } {
    return runMemorySync(this.effects.promoteThreadSummaryConversation(args));
  }

  readTokenBaseline(): number | null {
    return runMemorySync(this.effects.readTokenBaseline());
  }

  writeTokenBaseline(tokens: number): void {
    runMemorySync(this.effects.writeTokenBaseline(tokens));
  }

  maxProcessedSourceUpdatedAtSince(sinceMs: number): number {
    return runMemorySync(
      this.effects.maxProcessedSourceUpdatedAtSince(sinceMs),
    );
  }

  markProcessed(args: { ids: number[]; processedAt?: number }): {
    updated: number;
  } {
    return runMemorySync(this.effects.markProcessed(args));
  }

  gcProcessedRows(args?: { retentionMs?: number; nowMs?: number }): {
    deleted: number;
  } {
    return runMemorySync(this.effects.gcProcessedRows(args));
  }

  listRecentThreadSummaries(args?: { limit?: number }): DreamInboxRow[] {
    return runMemorySync(this.effects.listRecentThreadSummaries(args));
  }

  findThreadSummariesByThreadIds(
    threadIds: readonly string[],
  ): DreamInboxRow[] {
    return runMemorySync(
      this.effects.findThreadSummariesByThreadIds(threadIds),
    );
  }

  listRecentMemoryNotes(limit = 8): string[] {
    return runMemorySync(this.effects.listRecentMemoryNotes(limit));
  }

  recordUsage(
    threadId: string,
    runId: string,
    options?: { nowMs?: number; requeueDebounceMs?: number },
  ): void {
    runMemorySync(this.effects.recordUsage(threadId, runId, options));
  }
}
