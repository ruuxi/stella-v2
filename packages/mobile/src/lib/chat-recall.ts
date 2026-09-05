/** Native-free adapter for the shared Recall hit shape and rendering policy. */
import {
  recallMatchedTerms,
  renderRecallExchanges,
  type RecallMessage,
} from "@stella/contracts/recall";
import type { ChatMessage } from "../types";

export type RecallHit = {
  id: string;
  role: ChatMessage["role"];
  text: string;
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

export const normalizeRole = (role: string): ChatMessage["role"] =>
  role === "user" ? "user" : "assistant";

/**
 * Map a matched SQLite row to a RecallHit. `bm25Rank` is FTS5's bm25 score
 * (lower is better), negated into a higher-is-better `score`.
 */
export const rowToHit = (row: MessageRow, bm25Rank: number): RecallHit => ({
  id: row.id,
  sequence: row.sequence,
  matchTerms: recallMatchedTerms(row.matches ?? ""),
  role: normalizeRole(row.role),
  text: row.text,
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
