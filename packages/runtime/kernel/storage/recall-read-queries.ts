import type { TranscriptSearchHit } from "./search.js";
import type { SqliteDatabase } from "./shared.js";

const TRANSCRIPT_TEXT_CAP = 4_000;

export type RecallFtsHealth = {
  healthy: boolean;
  transcriptReady: boolean;
  threadsReady: boolean;
  reason?: string;
};

const probeRecallFtsMatch = (
  db: SqliteDatabase,
  table: "entry_fts" | "thread_fts",
): string | undefined => {
  try {
    db.prepare(`SELECT rowid FROM ${table} WHERE ${table} MATCH ? LIMIT 1`).get(
      '"__stella_recall_fts_probe__"',
    );
    return undefined;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
};

/**
 * Recall must never accidentally enter SessionStore's slow LIKE fallback.
 * This read-only preflight turns a missing table or incomplete backfill into
 * a visible retrieval failure instead.
 */
export const readRecallFtsHealth = (db: SqliteDatabase): RecallFtsHealth => {
  try {
    const tableRows = db
      .prepare(
        `SELECT name FROM sqlite_master
         WHERE type = 'table' AND name IN ('entry_fts', 'thread_fts')`,
      )
      .all() as Array<{ name?: string }>;
    const tables = new Set(tableRows.map((row) => row.name));
    const readyRow = db
      .prepare("SELECT value FROM meta WHERE key = 'fts_ready'")
      .get() as { value?: string } | undefined;
    const indexed = readyRow?.value === "1";
    const transcriptProbeError = tables.has("entry_fts")
      ? probeRecallFtsMatch(db, "entry_fts")
      : undefined;
    const threadProbeError = tables.has("thread_fts")
      ? probeRecallFtsMatch(db, "thread_fts")
      : undefined;
    const transcriptReady =
      tables.has("entry_fts") && indexed && !transcriptProbeError;
    const threadsReady =
      tables.has("thread_fts") && indexed && !threadProbeError;
    return {
      healthy: transcriptReady && threadsReady,
      transcriptReady,
      threadsReady,
      ...(!transcriptReady || !threadsReady
        ? {
            reason: [
              !transcriptReady
                ? transcriptProbeError
                  ? `transcript FTS MATCH probe failed: ${transcriptProbeError}`
                  : "transcript FTS missing or not built"
                : "",
              !threadsReady
                ? threadProbeError
                  ? `thread FTS MATCH probe failed: ${threadProbeError}`
                  : "thread FTS missing or not built"
                : "",
            ]
              .filter(Boolean)
              .join("; "),
          }
        : {}),
    };
  } catch (error) {
    return {
      healthy: false,
      transcriptReady: false,
      threadsReady: false,
      reason: `FTS health preflight failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }
};

export type TranscriptNeighborTarget = {
  conversationId: string;
  atMs: number;
  sequence?: number;
};

/** Expand every selected transcript hit with one SQL statement. */
export const listTranscriptNeighborsBatch = (
  db: SqliteDatabase,
  targets: readonly TranscriptNeighborTarget[],
  options?: { before?: number; after?: number; windowMs?: number },
): TranscriptSearchHit[][] => {
  if (targets.length === 0) return [];
  const before = Math.max(0, Math.min(8, Math.floor(options?.before ?? 2)));
  const after = Math.max(0, Math.min(10, Math.floor(options?.after ?? 2)));
  if (targets.every((target) => target.sequence !== undefined)) {
    const params: unknown[] = [];
    const selects = targets.flatMap((target, index) =>
      [
        { op: "<", order: "DESC", count: before },
        { op: ">", order: "ASC", count: after },
      ].map((side) => {
        params.push(target.conversationId, target.sequence, side.count);
        return `SELECT ${index} AS targetIndex, * FROM (SELECT id, seq AS sequence,
        conversation_id AS conversationId, role, created_at AS atMs, search_text AS text
        FROM entry WHERE conversation_id = ? AND visible = 1
          AND role IN ('user', 'assistant') AND search_text IS NOT NULL AND seq ${side.op} ?
        ORDER BY seq ${side.order} LIMIT ?)`;
      }),
    );
    const rows = db
      .prepare(selects.join(" UNION ALL "))
      .all(...params) as Array<TranscriptSearchHit & { targetIndex: number }>;
    return targets.map((_, index) =>
      rows
        .filter((row) => row.targetIndex === index)
        .map(({ targetIndex: _, ...hit }) => hit)
        .sort((a, b) => a.sequence! - b.sequence!),
    );
  }
  const windowMs = Math.max(60_000, options?.windowMs ?? 2 * 60 * 60 * 1000);
  const values = targets.map(() => "(?, ?, ?)").join(", ");
  const params = targets.flatMap((target, index) => [
    index,
    target.conversationId,
    target.atMs,
  ]);
  type Row = {
    targetIndex: number;
    conversationId: string;
    id: string;
    sequence: number;
    role: string;
    atMs: number;
    text: unknown;
  };
  const rows = db
    .prepare(
      `WITH targets(target_index, conversation_id, target_ms) AS (
         VALUES ${values}
       ), ranked AS (
         SELECT
           targets.target_index AS targetIndex,
           entry.id, entry.seq AS sequence,
           entry.conversation_id AS conversationId,
           entry.role AS role,
           entry.created_at AS atMs,
           substr(entry.search_text, 1, ${TRANSCRIPT_TEXT_CAP}) AS text,
           CASE WHEN entry.created_at < targets.target_ms THEN 'before' ELSE 'after' END AS side,
           ROW_NUMBER() OVER (
             PARTITION BY targets.target_index,
               CASE WHEN entry.created_at < targets.target_ms THEN 'before' ELSE 'after' END
             ORDER BY ABS(entry.created_at - targets.target_ms) ASC
           ) AS distanceRank
         FROM targets
         JOIN entry ON entry.conversation_id = targets.conversation_id
         WHERE entry.search_text IS NOT NULL
           AND entry.created_at != targets.target_ms
           AND entry.created_at BETWEEN targets.target_ms - ? AND targets.target_ms + ?
       )
       SELECT targetIndex, id, sequence, conversationId, role, atMs, text
       FROM ranked
       WHERE (side = 'before' AND distanceRank <= ?)
          OR (side = 'after' AND distanceRank <= ?)
       ORDER BY targetIndex ASC, atMs ASC`,
    )
    .all(...params, windowMs, windowMs, before, after) as Row[];
  const grouped = targets.map(() => [] as TranscriptSearchHit[]);
  for (const row of rows) {
    const text = typeof row.text === "string" ? row.text.trim() : "";
    if (!text || !grouped[row.targetIndex]) continue;
    grouped[row.targetIndex]!.push({
      conversationId: row.conversationId,
      id: row.id,
      sequence: row.sequence,
      role: row.role === "assistant" ? "assistant" : "user",
      atMs: row.atMs,
      text,
    });
  }
  return grouped;
};
