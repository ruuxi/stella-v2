import {
  RECALL_LIMIT,
  recallMatchedTerms,
  recallWords,
  recallSearchPlan,
  recallExcerpt,
  renderRecallExchanges,
  type RecallMessage,
} from "@stella/contracts/recall";
import type { ChatMessage } from "../types";

/** Native-free adapter for the shared Recall query and excerpt policy. */

export type RecallHit = {
  id: string;
  role: ChatMessage["role"];
  text: string;
  /** A short excerpt centered on the first matched term. */
  snippet: string;
  createdAt: number | undefined;
  /** Relevance score (higher is better); derived from FTS5 bm25. */
  score: number;
  neighbors?: RecallMessage[];
  sequence?: number;
  matchTerms?: string[];
};

/** A raw row joined out of the SQLite messages table. */
export type MessageRow = {
  id: string;
  role: string;
  text: string;
  created_at: number | null;
  sequence?: number;
  matches?: string;
};

export const DEFAULT_RECALL_LIMIT = RECALL_LIMIT;
export const tokenize = recallWords;
export const buildFtsMatchQuery = (query: string): string | null =>
  recallSearchPlan([query])?.phrase ?? null;

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
  sequence: row.sequence,
  matchTerms: recallMatchedTerms(row.matches ?? ""),
  role: normalizeRole(row.role),
  text: row.text,
  snippet: recallExcerpt(row.text, [query]).text,
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
  return renderRecallExchanges(
    hits.map((hit) => ({
      matchedIds: [hit.id],
      messages: [
        ...(hit.neighbors ?? []),
        {
          scope: "mobile",
          id: hit.id,
          role: hit.role,
          atMs: hit.createdAt ?? null,
          text: hit.text,
          order: hit.sequence,
          matchTerms: hit.matchTerms,
        },
      ],
    })),
    [query],
  );
}
