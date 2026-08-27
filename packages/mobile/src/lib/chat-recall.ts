import type { ChatMessage } from "../types";

export type RecallHit = {
  id: string;
  role: ChatMessage["role"];
  text: string;

  snippet: string;
  createdAt: number | undefined;

  score: number;
};

export type MessageRow = {
  id: string;
  role: string;
  text: string;
  created_at: number | null;
};

const SNIPPET_RADIUS = 90;
export const DEFAULT_RECALL_LIMIT = 8;

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
