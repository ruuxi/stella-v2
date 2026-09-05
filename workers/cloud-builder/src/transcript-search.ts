import {
  parseRecallReference,
  recallMatchedTerms,
  recallLimit,
  recallSearchPlan,
  shouldBroadenRecall,
} from "@stella/contracts/recall";

/**
 * Full-text search for a transcript stored in the same Durable Object SQLite.
 *
 * The FTS rowid is the transcript's own sequence number. Search results can
 * therefore hydrate canonical rows without another lookup table, and deleting
 * resident journal rows during rollover does not disturb the index.
 */

export const DEFAULT_TRANSCRIPT_SEARCH_TABLE = "journal_fts";

const INDEXED_TEXT_MAX_BYTES = 64 * 1024;
export type TranscriptSearchRow = Readonly<{
  seq: number;
  turnId: string;
  role: string;
  createdAt: number;
  hidden: boolean;
  spillKey: string | null;
  payload: unknown;
}>;

export type TranscriptSearchHit = Readonly<{
  seq: number;
  turnId: string;
  role: string;
  createdAt: number;
  snippet: string;
  matchTerms?: string[];
  rank: number;
}>;

const tableIdentifier = (name: string): string => {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(name)) {
    throw new Error(
      "Transcript search table names must be SQLite identifiers.",
    );
  }
  return name;
};

export const transcriptSearchDdl = (
  tableName = DEFAULT_TRANSCRIPT_SEARCH_TABLE,
): string => {
  const table = tableIdentifier(tableName);
  return `CREATE VIRTUAL TABLE IF NOT EXISTS ${table} USING fts5(
    text,
    turn_id UNINDEXED,
    role UNINDEXED,
    created_at UNINDEXED,
    tokenize = 'porter unicode61'
  )`;
};

/** Text-only projection of an AgentMessage. Binary blocks and calls are noise. */
export const extractMessageText = (message: unknown): string => {
  if (!message || typeof message !== "object") return "";
  const content = (message as { content?: unknown }).content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const item of content) {
    if (!item || typeof item !== "object") continue;
    const record = item as {
      type?: unknown;
      text?: unknown;
      content?: unknown;
    };
    if (record.type === "toolCall") continue;
    if (typeof record.text === "string") parts.push(record.text);
    else if (typeof record.content === "string") parts.push(record.content);
  }
  return parts.join("\n");
};

export const collapseWhitespace = (value: string): string =>
  value.replace(/\s+/gu, " ").trim();

const capUtf8 = (value: string, maxBytes: number): string => {
  const encoded = new TextEncoder().encode(value);
  if (encoded.byteLength <= maxBytes) return value;
  return new TextDecoder()
    .decode(encoded.slice(0, maxBytes))
    .replace(/\uFFFD$/u, "");
};

export class TranscriptSearchIndex {
  private readonly table: string;

  constructor(
    private readonly sql: SqlStorage,
    tableName = DEFAULT_TRANSCRIPT_SEARCH_TABLE,
  ) {
    this.table = tableIdentifier(tableName);
  }

  index(row: TranscriptSearchRow): void {
    this.remove(row.seq);
    if (
      (row.role !== "user" && row.role !== "assistant") ||
      row.hidden ||
      row.spillKey !== null
    ) {
      return;
    }
    const text = capUtf8(
      collapseWhitespace(extractMessageText(row.payload)),
      INDEXED_TEXT_MAX_BYTES,
    );
    if (!text) return;
    this.sql.exec(
      `INSERT INTO ${this.table} (rowid, text, turn_id, role, created_at)
       VALUES (?, ?, ?, ?, ?)`,
      row.seq,
      text,
      row.turnId,
      row.role,
      row.createdAt,
    );
  }

  removeAbove(seq: number): void {
    this.sql.exec(`DELETE FROM ${this.table} WHERE rowid > ?`, seq);
  }

  remove(seq: number): void {
    this.sql.exec(`DELETE FROM ${this.table} WHERE rowid = ?`, seq);
  }

  search(terms: readonly string[], limit: number): TranscriptSearchHit[] {
    const plan = recallSearchPlan(terms);
    if (!plan) return [];
    const cappedLimit = recallLimit(limit);
    const phraseHits = this.runSearch(plan.phrase, cappedLimit);
    return plan.broad !== plan.phrase &&
      shouldBroadenRecall(phraseHits.length, cappedLimit)
      ? this.runSearch(plan.broad, cappedLimit)
      : phraseHits;
  }

  /** Only indexed, visible messages can resolve a reference. */
  readReference(value: string, scope: string): TranscriptSearchHit[] {
    const ref = parseRecallReference(value);
    if (!ref || ref.scope !== scope) return [];
    const slash = ref.id.indexOf("/");
    const seq = Number(ref.id.slice(0, slash));
    const turnId = ref.id.slice(slash + 1);
    if (slash < 1 || !Number.isSafeInteger(seq) || seq < 0 || !turnId)
      return [];
    return this.sql
      .exec<{
        seq: number;
        turn_id: string;
        role: string;
        created_at: number;
        snippet: string;
      }>(
        `SELECT rowid AS seq, turn_id, role, created_at, substr(text, 1, 200) AS snippet
       FROM ${this.table} WHERE rowid = ? AND turn_id = ?`,
        seq,
        turnId,
      )
      .toArray()
      .map((row) => ({
        seq: row.seq,
        turnId: row.turn_id,
        role: row.role,
        createdAt: row.created_at,
        snippet: row.snippet,
        rank: 0,
      }));
  }

  count(): number {
    return this.sql
      .exec<{ count: number }>(`SELECT COUNT(*) AS count FROM ${this.table}`)
      .one().count;
  }

  private runSearch(query: string, limit: number): TranscriptSearchHit[] {
    return this.sql
      .exec<{
        seq: number;
        turn_id: string;
        role: string;
        created_at: number;
        snippet: string;
        rank: number;
      }>(
        `SELECT rowid AS seq, turn_id, role, created_at,
                snippet(${this.table}, 0, char(1), char(2), '…', 24) AS snippet,
                bm25(${this.table}) AS rank
           FROM ${this.table}
          WHERE ${this.table} MATCH ?
          ORDER BY rank ASC, rowid DESC
          LIMIT ?`,
        query,
        limit,
      )
      .toArray()
      .map((row) => ({
        seq: row.seq,
        turnId: row.turn_id,
        role: row.role,
        createdAt: row.created_at,
        snippet: row.snippet.replace(/[\u0001\u0002]/gu, ""),
        matchTerms: recallMatchedTerms(row.snippet),
        rank: row.rank,
      }));
  }
}
