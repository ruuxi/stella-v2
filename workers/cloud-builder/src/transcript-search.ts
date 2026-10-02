/**
 * Full-text index for a transcript stored in the same Durable Object SQLite.
 *
 * The FTS rowid is the transcript's own sequence number, so a MATCH joins
 * straight back to canonical rows, and deleting resident journal rows during
 * rollover does not disturb the index. The orchestrator queries it through
 * `history.sql` in its code tool.
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

  count(): number {
    return this.sql
      .exec<{ count: number }>(`SELECT COUNT(*) AS count FROM ${this.table}`)
      .one().count;
  }
}
