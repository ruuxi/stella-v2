/**
 * Full-text search for a transcript stored in the same Durable Object SQLite.
 *
 * The FTS rowid is the transcript's own sequence number. Search results can
 * therefore hydrate canonical rows without another lookup table, and deleting
 * resident journal rows during rollover does not disturb the index.
 */

export const DEFAULT_TRANSCRIPT_SEARCH_TABLE = "journal_fts";

const INDEXED_TEXT_MAX_BYTES = 64 * 1024;
const SEARCH_LIMIT_MAX = 30;
const SEARCH_TERM_MAX_CHARS = 512;
const SEARCH_TERM_MAX_COUNT = 30;

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

const sanitizedTerms = (terms: readonly string[]): string[] =>
  terms
    .filter((term): term is string => typeof term === "string")
    .map((term) =>
      collapseWhitespace(term.replace(/[\u0000-\u001F\u007F]/gu, " ")).slice(
        0,
        SEARCH_TERM_MAX_CHARS,
      ),
    )
    .filter(Boolean)
    .slice(0, SEARCH_TERM_MAX_COUNT);

const quotedPhrase = (term: string): string => `"${term.replace(/"/gu, '""')}"`;

const matchExpression = (terms: readonly string[]): string =>
  terms.map(quotedPhrase).join(" OR ");

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
    const phrases = sanitizedTerms(terms);
    if (phrases.length === 0) return [];
    const cappedLimit = Math.min(
      SEARCH_LIMIT_MAX,
      Math.max(1, Number.isFinite(limit) ? Math.trunc(limit) : 1),
    );
    const phraseHits = this.runSearch(matchExpression(phrases), cappedLimit);
    if (phraseHits.length > 0) return phraseHits;
    const words = [
      ...new Set(
        phrases.flatMap((phrase) => phrase.match(/[\p{L}\p{N}_]+/gu) ?? []),
      ),
    ];
    return words.length > 0
      ? this.runSearch(matchExpression(words), cappedLimit)
      : [];
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
                snippet(${this.table}, 0, '', '', '…', 24) AS snippet,
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
        snippet: row.snippet,
        rank: row.rank,
      }));
  }
}
