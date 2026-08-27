// Cloud agent home: the Convex half of the orchestrator's memory stack.
//
// Memory DOCUMENTS (MEMORY.md, memory_map.md, profile.md) live in R2 under
// agent-home/<sha256(ownerId)>/generations/<sha256(ownerGeneration)>/memories/
// and are read and written by the orchestrator DO through its AGENT_HOME
// bucket binding — Convex holds only the registry row for each
// (cloud_agent_home_docs). The generation segment prevents a delayed turn
// from a pre-reset generation from replacing the current profile bytes.
//
// The part that genuinely belongs here is Recall's second half: searching the
// owner's prior conversations. Conversation transcripts now live in the
// OrchestratorSession DO, which cannot answer a cross-conversation question,
// so the DO flushes one compact excerpt per turn into
// `cloud_message_excerpts` and this file searches that index.
//
// What that changed, concretely: the old implementation was a bounded scan
// over `cloud_messages` — 12 conversations, 48 messages each, capped at 240
// documents and 1.5 MB, six months of lookback. It could not see conversation
// #13, and it ranked terms by a document frequency computed over whatever the
// budget happened to touch. Search is now corpus-wide and ranked by Convex.
//
// What it cost: tool-call arguments and tool-result bodies are no longer
// searchable (they are the reason the old scan had to budget in bytes at all),
// and phrase preference now applies only within the candidates Convex returns.

import { ConvexError, v } from "convex/values";
import { internalMutation, internalQuery } from "./_generated/server";
import { agentHomeGenerationR2Prefix } from "./lib/cloud_home_policy";
import { assertOwnerMemoryRuntimeEnabled } from "./cloud_memory";

// How many ranked candidates to pull back before re-ranking locally. Convex
// has no phrase operator, so a literal phrase and its words scattered across a
// turn come back indistinguishable; `matchTerm` restores the preference over
// this window. Wider than any `limit` a caller can ask for.
const SEARCH_TAKE = 64;
const SEARCH_DEFAULT_LIMIT = 20;
const SEARCH_MAX_LIMIT = 50;
// A cap on TERMS, matching what the Recall tool accepts from the model.
const SEARCH_MAX_TERMS = 8;
// Legacy callers hand over the terms already joined into one string, which
// erases the boundaries. Splitting that back apart yields WORDS, so it gets a
// wider budget: capping recovered words at the term count would silently drop
// most of a request made of naturally phrased terms.
const SEARCH_MAX_QUERY_WORDS = 24;
const TERM_MIN_CHARS = 2;
const TERM_MAX_CHARS = 80;
// A phrase whose words are all present but not adjacent is a real but weaker
// signal than the phrase itself; scoring it below an exact hit keeps the
// recall the word-splitting search had without letting it outrank a true one.
const PARTIAL_PHRASE_WEIGHT = 0.5;
const EXCERPT_LEAD = 100;
const EXCERPT_TRAIL = 160;

const MEMORY_DOC_NAMES = new Set(["MEMORY.md", "memory_map.md", "profile.md"]);
const AGENT_HOME_DOC_MAX_BYTES = 64 * 1024;

export const agentHomeDocumentKey = async (
  ownerId: string,
  ownerGeneration: string,
  name: string,
): Promise<string> => {
  return `${await agentHomeGenerationR2Prefix({ ownerId, ownerGeneration })}memories/${name}`;
};

// Unchanged shape: /api/cloud/recall and the orchestrator's `formatMatch` read
// this and must not need to change. `seq` now carries the turn's FIRST journal
// seq and `role` is always "conversation" — a match is a turn (question plus
// answer), because a message alone rarely carries its own question.
const matchValidator = v.object({
  conversationId: v.string(),
  seq: v.number(),
  role: v.string(),
  excerpt: v.string(),
  createdAt: v.number(),
});

const documentValidator = v.object({
  name: v.string(),
  r2Key: v.string(),
  sizeBytes: v.number(),
  updatedAt: v.number(),
});

/**
 * One search term as the caller meant it: the whole phrase, plus the words it
 * is made of. Both are needed — the phrase is the strong match, the words are
 * the fallback that keeps a naturally phrased term from finding nothing.
 */
type SearchTerm = { text: string; words: string[] };

const buildTerms = (
  values: readonly string[],
  maxTerms: number,
): SearchTerm[] => {
  const seen = new Set<string>();
  const terms: SearchTerm[] = [];
  for (const value of values) {
    const text = value
      .toLowerCase()
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, TERM_MAX_CHARS)
      .trim();
    if (text.length < TERM_MIN_CHARS || seen.has(text)) continue;
    seen.add(text);
    const words = text.split(" ").filter((w) => w.length >= TERM_MIN_CHARS);
    terms.push({ text, words: words.length > 0 ? words : [text] });
    if (terms.length >= maxTerms) break;
  }
  return terms;
};

/** Where a term matched a row, and how strongly. */
type TermHit = { index: number; length: number; strength: number };

const matchTerm = (haystack: string, term: SearchTerm): TermHit | null => {
  const phrase = haystack.indexOf(term.text);
  if (phrase >= 0) {
    return { index: phrase, length: term.text.length, strength: 1 };
  }
  if (term.words.length < 2) return null;
  let found = 0;
  let index = -1;
  let length = 0;
  for (const word of term.words) {
    const at = haystack.indexOf(word);
    if (at < 0) continue;
    found += 1;
    if (index < 0 || at < index) {
      index = at;
      length = word.length;
    }
  }
  if (found === 0) return null;
  return {
    index,
    length,
    strength: (PARTIAL_PHRASE_WEIGHT * found) / term.words.length,
  };
};

const buildExcerpt = (text: string, index: number, length: number): string => {
  const start = Math.max(0, index - EXCERPT_LEAD);
  const end = Math.min(text.length, index + length + EXCERPT_TRAIL);
  const body = text.slice(start, end).replace(/\s+/g, " ").trim();
  return `${start > 0 ? "…" : ""}${body}${end < text.length ? "…" : ""}`;
};

export const searchOwnerMessagesInternal = internalQuery({
  args: {
    ownerId: v.string(),
    ownerGeneration: v.string(),
    /** Preferred: Recall's terms as the model wrote them, boundaries intact. */
    terms: v.optional(v.array(v.string())),
    /** Legacy: the same terms joined by spaces, so only words survive. */
    query: v.optional(v.string()),
    limit: v.optional(v.number()),
    /**
     * Unused since the search moved to an index — kept because /api/cloud/recall
     * sends it and the route's shape is a published contract.
     */
    now: v.number(),
  },
  returns: v.array(matchValidator),
  handler: async (ctx, args) => {
    await assertOwnerMemoryRuntimeEnabled(
      ctx,
      args.ownerId,
      args.ownerGeneration,
    );
    // A term is a term — "Q4 telemetry migration" is one thing the model asked
    // for, not three. Given real terms, each is matched as a phrase first and
    // as its words second, and each contributes once to the score. A caller
    // that only sends the joined string gets the old word-per-term behaviour,
    // but with a word budget wide enough that eight phrased terms all survive.
    const terms = args.terms?.length
      ? buildTerms(args.terms, SEARCH_MAX_TERMS)
      : buildTerms((args.query ?? "").split(/\s+/), SEARCH_MAX_QUERY_WORDS);
    if (terms.length === 0) return [];
    const limit = Math.min(
      SEARCH_MAX_LIMIT,
      Math.max(1, Math.floor(args.limit ?? SEARCH_DEFAULT_LIMIT)),
    );

    // One query string, because that is what a Convex search index takes. The
    // owner equality rides INSIDE the search predicate: it is the whole
    // authorization story here, and there is no path that ranks or returns
    // another owner's excerpts.
    const needle = terms
      .map((term) => term.text)
      .join(" ")
      .slice(0, 512);
    const rows = await ctx.db
      .query("cloud_message_excerpts")
      .withSearchIndex("search_text", (q) =>
        q.search("searchText", needle).eq("ownerId", args.ownerId),
      )
      .take(SEARCH_TAKE);
    if (rows.length === 0) return [];

    // Convex has already ranked these by relevance over the whole corpus. The
    // local pass only restores what a bag-of-words index cannot express: that
    // "pivot table broken" as a literal phrase beats those three words landing
    // in unrelated sentences of the same turn.
    const ranked: Array<{
      row: (typeof rows)[number];
      score: number;
      anchor: TermHit;
      order: number;
    }> = [];
    for (let order = 0; order < rows.length; order += 1) {
      const row = rows[order]!;
      const haystack = row.searchText.toLowerCase();
      let score = 0;
      let anchor: TermHit | null = null;
      let strongest = -1;
      for (const term of terms) {
        const hit = matchTerm(haystack, term);
        if (!hit) continue;
        score += hit.strength;
        if (
          hit.strength > strongest ||
          (hit.strength === strongest && anchor && hit.index < anchor.index)
        ) {
          strongest = hit.strength;
          anchor = hit;
        }
      }
      // No local hit at all still means Convex matched something (a stem, a
      // typo-tolerant variant). Keep it, ranked below every literal hit, at
      // the position Convex chose.
      ranked.push({
        row,
        score,
        anchor: anchor ?? { index: 0, length: 0, strength: 0 },
        order,
      });
    }
    // Local score first, then Convex's own ordering, then recency.
    ranked.sort(
      (a, b) =>
        b.score - a.score ||
        a.order - b.order ||
        b.row.createdAt - a.row.createdAt,
    );
    return ranked.slice(0, limit).map(({ row, anchor }) => ({
      conversationId: row.conversationId,
      seq: row.seqStart,
      // A match is a turn, not a message: there is no single author to name.
      role: "conversation",
      excerpt: buildExcerpt(row.searchText, anchor.index, anchor.length),
      createdAt: row.createdAt,
    }));
  },
});

export const listOwnerDocumentsInternal = internalQuery({
  args: { ownerId: v.string(), ownerGeneration: v.string() },
  returns: v.array(documentValidator),
  handler: async (ctx, args) => {
    const memory = await assertOwnerMemoryRuntimeEnabled(
      ctx,
      args.ownerId,
      args.ownerGeneration,
    );
    const rows = await ctx.db
      .query("cloud_agent_home_docs")
      .withIndex("by_ownerId_and_updatedAt", (q) =>
        q.eq("ownerId", args.ownerId),
      )
      .order("desc")
      .take(20);
    const currentRows = rows.filter(
      (row) =>
        row.ownerGeneration === args.ownerGeneration ||
        (row.ownerGeneration === undefined && args.ownerGeneration === "legacy"),
    );
    if (
      currentRows.some(
        (row) => (row.memoryEpoch ?? "legacy") !== memory.memoryEpoch,
      )
    ) {
      throw new ConvexError({
        code: "CLOUD_MEMORY_EPOCH_STALE",
        message: "Cloud memory metadata belongs to an erased memory epoch.",
      });
    }
    return currentRows
      .map((row) => ({
        name: row.name,
        r2Key: row.r2Key,
        sizeBytes: row.sizeBytes,
        updatedAt: row.updatedAt,
      }));
  },
});

// Called after the orchestrator DO writes a memory document to R2, so Convex
// stays the canonical record of what exists. Idempotent per (owner, name).
export const recordDocumentInternal = internalMutation({
  args: {
    ownerId: v.string(),
    ownerGeneration: v.string(),
    name: v.string(),
    r2Key: v.string(),
    sizeBytes: v.number(),
    now: v.number(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const memory = await assertOwnerMemoryRuntimeEnabled(
      ctx,
      args.ownerId,
      args.ownerGeneration,
    );
    if (!MEMORY_DOC_NAMES.has(args.name)) {
      throw new ConvexError(
        `Unknown memory document "${args.name}". Expected MEMORY.md, memory_map.md, or profile.md.`,
      );
    }
    if (
      !Number.isSafeInteger(args.sizeBytes) ||
      args.sizeBytes < 0 ||
      args.sizeBytes > AGENT_HOME_DOC_MAX_BYTES
    ) {
      throw new ConvexError(
        `Memory documents must be between 0 and ${AGENT_HOME_DOC_MAX_BYTES} bytes.`,
      );
    }
    const expectedKey = await agentHomeDocumentKey(
      args.ownerId,
      args.ownerGeneration,
      args.name,
    );
    if (args.r2Key !== expectedKey) {
      throw new ConvexError(
        "Memory document key does not match its owner and name.",
      );
    }
    const existing = await ctx.db
      .query("cloud_agent_home_docs")
      .withIndex("by_ownerId_and_name", (q) =>
        q.eq("ownerId", args.ownerId).eq("name", args.name),
      )
      .unique();
    if (existing) {
      await ctx.db.patch(existing._id, {
        r2Key: args.r2Key,
        ownerGeneration: args.ownerGeneration,
        memoryEpoch: memory.memoryEpoch,
        sizeBytes: args.sizeBytes,
        updatedAt: args.now,
      });
      return null;
    }
    await ctx.db.insert("cloud_agent_home_docs", {
      ownerId: args.ownerId,
      name: args.name,
      r2Key: args.r2Key,
      ownerGeneration: args.ownerGeneration,
      memoryEpoch: memory.memoryEpoch,
      sizeBytes: args.sizeBytes,
      createdAt: args.now,
      updatedAt: args.now,
    });
    return null;
  },
});
