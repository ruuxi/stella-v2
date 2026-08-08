import type { ChatMessage } from "../types";

/**
 * Pure helpers behind the offline chat's message recall — a simplified analog
 * of the desktop's Recall tool. The desktop Recall searches across many
 * threads, agents, and machine state; the mobile offline chat is a single
 * continuous thread with no threads or agents, so recall only ever needs to
 * full-text search the chat's OWN prior messages.
 *
 * The actual search is backed by SQLite FTS5 (see `chat-message-index.ts`);
 * this module holds the native-free pieces — query tokenization, the FTS5
 * MATCH expression builder, row -> hit mapping, and result formatting — so they
 * stay unit-testable without loading the native SQLite module.
 */

export type RecallHit = {
  id: string;
  role: ChatMessage["role"];
  text: string;
  /** A short excerpt centered on the first matched term. */
  snippet: string;
  createdAt: number | undefined;
  /** Relevance score (higher is better); derived from FTS5 bm25. */
  score: number;
};

/** A raw row joined out of the SQLite messages table. */
export type MessageRow = {
  id: string;
  role: string;
  text: string;
  created_at: number | null;
};

const SNIPPET_RADIUS = 90;
export const DEFAULT_RECALL_LIMIT = 8;

/** Lowercase word tokens (letters/digits), 2+ chars, deduped, order kept. */
export const tokenize = (input: string): string[] => {
  const matches = input.toLowerCase().match(/[\p{L}\p{N}]{2,}/gu);
  if (!matches) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const token of matches) {
    if (seen.has(token)) continue;
    seen.add(token);
    out.push(token);
  }
  return out;
};

/**
 * Build an FTS5 MATCH expression from a free-text query. Each token is quoted
 * as a string literal (so query text can never inject FTS5 operators) and the
 * tokens are OR-joined — any term may match, and bm25 ranks multi-term hits
 * higher. Returns null when the query has no usable terms.
 */
export const buildFtsMatchQuery = (query: string): string | null => {
  const terms = tokenize(query);
  if (terms.length === 0) return null;
  return terms.map((term) => `"${term.replace(/"/g, '""')}"`).join(" OR ");
};

const buildSnippet = (text: string, terms: string[]): string => {
  const collapsed = text.replace(/\s+/g, " ").trim();
  const lower = collapsed.toLowerCase();
  let hit = -1;
  for (const term of terms) {
    const index = lower.indexOf(term);
    if (index !== -1 && (hit === -1 || index < hit)) hit = index;
  }
  if (hit === -1 || collapsed.length <= SNIPPET_RADIUS * 2) {
    return collapsed.length > SNIPPET_RADIUS * 2
      ? `${collapsed.slice(0, SNIPPET_RADIUS * 2)}…`
      : collapsed;
  }
  const start = Math.max(0, hit - SNIPPET_RADIUS);
  const end = Math.min(collapsed.length, hit + SNIPPET_RADIUS);
  return `${start > 0 ? "…" : ""}${collapsed.slice(start, end)}${
    end < collapsed.length ? "…" : ""
  }`;
};

const normalizeRole = (role: string): ChatMessage["role"] =>
  role === "user" ? "user" : "assistant";

/**
 * Map a matched SQLite row to a RecallHit. `bm25Rank` is FTS5's bm25 score
 * (lower is better), negated into a higher-is-better `score`.
 */
export const rowToHit = (
  row: MessageRow,
  query: string,
  bm25Rank: number,
): RecallHit => ({
  id: row.id,
  role: normalizeRole(row.role),
  text: row.text,
  snippet: buildSnippet(row.text, tokenize(query)),
  createdAt:
    typeof row.created_at === "number" && Number.isFinite(row.created_at)
      ? row.created_at
      : undefined,
  score: Number.isFinite(bm25Rank) ? -bm25Rank : 0,
});

/** Render recall hits as the tool-result text the model reads to continue. */
export function formatRecallResults(hits: RecallHit[], query: string): string {
  if (hits.length === 0) {
    return `No earlier messages matched "${query}".`;
  }
  const lines = hits.map((hit) => {
    const who = hit.role === "user" ? "User" : "You";
    const when =
      typeof hit.createdAt === "number" && Number.isFinite(hit.createdAt)
        ? new Date(hit.createdAt).toISOString().slice(0, 10)
        : "earlier";
    return `- [${who}, ${when}] ${hit.snippet}`;
  });
  return [`Earlier messages matching "${query}":`, ...lines].join("\n");
}
