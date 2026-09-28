import type { TranscriptSearchHit } from "./search.js";
import type { SqliteDatabase } from "./shared.js";
import { TRANSCRIPT_SEARCH_TEXT_CAP } from "./view.js";

/** The `entry` projection every transcript hit query returns; `textCap` truncates `search_text`. */
export const transcriptHitColumns = (textCap?: number): string =>
  `entry.id, entry.seq AS sequence, entry.conversation_id AS conversationId,
        entry.role AS role, entry.created_at AS atMs,
        ${textCap === undefined ? "entry.search_text" : `substr(entry.search_text, 1, ${textCap})`} AS text`;

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
        return `SELECT ${index} AS targetIndex, * FROM (SELECT ${transcriptHitColumns()}
        FROM entry WHERE entry.conversation_id = ? AND entry.visible = 1
          AND entry.role IN ('user', 'assistant') AND entry.search_text IS NOT NULL AND entry.seq ${side.op} ?
        ORDER BY entry.seq ${side.order} LIMIT ?)`;
      }),
    );
    const rows = db
      .prepare(selects.join(" UNION ALL "))
      .all(...params) as Array<TranscriptSearchHit & { targetIndex: number }>;
    return targets.map((_, index) =>
      rows
        .filter((row) => row.targetIndex === index && row.text.trim())
        .map(({ targetIndex: _, ...hit }) => hit)
        .sort((a, b) => a.sequence! - b.sequence!),
    );
  }
  const windowMs = Math.max(60_000, options?.windowMs ?? 2 * 60 * 60 * 1000);
  // Nearest `before` hits strictly earlier than the target and nearest
  // `after` hits strictly later, each within `windowMs`. Once idle
  // maintenance has built the covering partial index
  // idx_entry_search_conv_created (conversation_id, created_at, seq, ...)
  // WHERE search_text IS NOT NULL, every side is an ordered seek on it and
  // the table row (and its payload overflow chain) is never read; before
  // that, the same rows come back via idx_entry_conv_turn_seq, slower. No
  // INDEXED BY: the index may not exist. Equal timestamps break toward the
  // target by `seq`.
  const params: unknown[] = [];
  const selects = targets.flatMap((target, index) => {
    params.push(
      target.conversationId,
      target.atMs - windowMs,
      target.atMs,
      before,
      target.conversationId,
      target.atMs,
      target.atMs + windowMs,
      after,
    );
    return [
      `SELECT ${index} AS targetIndex, * FROM (SELECT ${transcriptHitColumns(TRANSCRIPT_SEARCH_TEXT_CAP)}
        FROM entry WHERE entry.conversation_id = ? AND entry.search_text IS NOT NULL
          AND entry.created_at >= ? AND entry.created_at < ?
        ORDER BY entry.created_at DESC, entry.seq DESC LIMIT ?)`,
      `SELECT ${index} AS targetIndex, * FROM (SELECT ${transcriptHitColumns(TRANSCRIPT_SEARCH_TEXT_CAP)}
        FROM entry WHERE entry.conversation_id = ? AND entry.search_text IS NOT NULL
          AND entry.created_at > ? AND entry.created_at <= ?
        ORDER BY entry.created_at ASC, entry.seq ASC LIMIT ?)`,
    ];
  });
  type Row = {
    targetIndex: number;
    conversationId: string;
    id: string;
    sequence: number;
    role: string;
    atMs: number;
    text: unknown;
  };
  const rows = (
    db.prepare(selects.join(" UNION ALL ")).all(...params) as Row[]
  ).sort(
    (a, b) =>
      a.targetIndex - b.targetIndex ||
      a.atMs - b.atMs ||
      a.sequence - b.sequence,
  );
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
