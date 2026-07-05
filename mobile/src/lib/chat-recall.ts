import type { ChatMessage } from "../types";

/**
 * Message recall for the offline chat — a deliberately simplified analog of
 * the desktop's Recall tool. The desktop Recall searches across many threads,
 * agents, and machine state; the mobile offline chat is a single continuous
 * thread with no threads or agents, so recall only ever needs to full-text
 * search the chat's OWN prior messages and pull up things said earlier.
 *
 * The desktop backs Recall with SQLite FTS. The mobile offline chat keeps its
 * transcript in AsyncStorage (no native SQLite module ships in this app), so
 * this is an in-memory ranked search over the already-loaded transcript: the
 * full message history is resident, so searching the array is equivalent to an
 * FTS scan of the on-device messages without pulling in a native dependency
 * that would break the app's over-the-air update path.
 */

export type RecallHit = {
  id: string;
  role: ChatMessage["role"];
  text: string;
  /** A short excerpt centered on the first matched term. */
  snippet: string;
  createdAt: number | undefined;
  score: number;
};

const SNIPPET_RADIUS = 90;
const DEFAULT_LIMIT = 8;

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

export type SearchOptions = {
  limit?: number;
  /** Message ids to skip (e.g. the in-flight turn's own rows). */
  excludeIds?: Set<string>;
};

/**
 * Rank the chat's own messages against a free-text query. Scores by matched
 * distinct terms and total term frequency, with a mild recency tiebreak so a
 * recent mention edges out an equally-relevant older one. Messages matching no
 * query term are dropped entirely (an FTS-style AND-of-any match).
 */
export function searchMessages(
  messages: ChatMessage[],
  query: string,
  options: SearchOptions = {},
): RecallHit[] {
  const terms = tokenize(query);
  if (terms.length === 0) return [];
  const limit = options.limit ?? DEFAULT_LIMIT;
  const exclude = options.excludeIds;
  const total = messages.length;

  const scored: RecallHit[] = [];
  for (let index = 0; index < total; index += 1) {
    const message = messages[index]!;
    if (exclude?.has(message.id)) continue;
    const body = message.text?.trim();
    if (!body) continue;
    const lower = body.toLowerCase();
    let matchedTerms = 0;
    let frequency = 0;
    for (const term of terms) {
      let from = 0;
      let hits = 0;
      for (;;) {
        const at = lower.indexOf(term, from);
        if (at === -1) break;
        hits += 1;
        from = at + term.length;
      }
      if (hits > 0) {
        matchedTerms += 1;
        frequency += hits;
      }
    }
    if (matchedTerms === 0) continue;
    // Distinct-term coverage dominates; frequency and recency break ties.
    const recency = total > 1 ? index / (total - 1) : 1;
    const score = matchedTerms * 100 + Math.min(frequency, 20) + recency;
    scored.push({
      id: message.id,
      role: message.role,
      text: body,
      snippet: buildSnippet(body, terms),
      createdAt: message.createdAt,
      score,
    });
  }

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit);
}

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
