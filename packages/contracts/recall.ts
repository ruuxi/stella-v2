/** Shared, storage-independent policy for cloud, desktop and mobile Recall. */
export const RECALL_LIMIT = 12;
const RECALL_MAX_LIMIT = 30;
export const RECALL_CONTEXT_MESSAGES = 2;
const RECALL_TEXT_BUDGET = 12_000;
const RECALL_MESSAGE_CHARS = 1_500;

export const RECALL_DESCRIPTION =
  "Search past conversation history and return original exchanges with message references, timestamps, and speakers. " +
  "Use memorySearchTerms for a search, or pass a returned messageRef to read more of that message. Follow a neighboring messageRef to inspect what happened next. " +
  "Profile and background memory are already in context and are not searched again. " +
  "An assistant suggestion is not a user decision; check the surrounding exchange and later corrections before treating an old statement as current. " +
  "A retrieval_error does not mean that history is absent.";

export const RECALL_PARAMETERS = {
  type: "object",
  properties: {
    prompt: {
      type: "string",
      description: "What you are trying to find or resolve.",
    },
    memorySearchTerms: {
      type: "array",
      items: { type: "string" },
      description:
        "2-8 concrete search terms: names, projects, files, error text, or prior-decision keywords. Omit when reading a messageRef.",
    },
    messageRef: {
      type: "string",
      description:
        "An exact reference returned by Recall. Reads the original message and surrounding exchange; use its next reference to continue a long message.",
    },
    limit: {
      type: "number",
      description: "Maximum search hits; defaults to 12, capped at 30.",
    },
  },
  required: ["prompt"],
  additionalProperties: false,
} as const;

export function recallLimit(value?: number): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(1, Math.min(RECALL_MAX_LIMIT, Math.trunc(value)))
    : RECALL_LIMIT;
}

export function recallTerms(terms: readonly string[]): string[] {
  return [
    ...new Set(
      terms
        .map((term) =>
          term
            .replace(/[\u0000-\u001f\u007f]/gu, " ")
            .trim()
            .replace(/\s+/gu, " ")
            .slice(0, 120),
        )
        .filter(Boolean),
    ),
  ].slice(0, 8);
}

export function recallWords(text: string): string[] {
  return [...new Set(text.toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? [])];
}

const quote = (value: string): string => `"${value.replace(/"/gu, '""')}"`;

export function recallSearchPlan(
  terms: readonly string[],
): { phrase: string; broad: string } | null {
  const phrases = recallTerms(terms).filter(
    (term) => recallWords(term).length > 0,
  );
  if (!phrases.length) return null;
  const words = recallWords(phrases.join(" "));
  return {
    phrase: phrases.map(quote).join(" OR "),
    // One FTS query and one BM25 ranking, not fusion of separate scores.
    broad: [...new Set([...phrases, ...words])].map(quote).join(" OR "),
  };
}

export function shouldBroadenRecall(hits: number, limit: number): boolean {
  return hits < Math.min(3, recallLimit(limit));
}

type RecallReference = { scope: string; id: string; offset: number };

export function recallReference(scope: string, id: string, offset = 0): string {
  return `recall:${encodeURIComponent(scope)}:${encodeURIComponent(id)}:${offset}`;
}

export function parseRecallReference(value: string): RecallReference | null {
  const match = /^recall:([^:]+):([^:]+):(\d+)$/u.exec(value.trim());
  if (!match) return null;
  const offset = Number(match[3]);
  if (!Number.isSafeInteger(offset) || offset < 0) return null;
  try {
    const scope = decodeURIComponent(match[1]!);
    const id = decodeURIComponent(match[2]!);
    return scope && id ? { scope, id, offset } : null;
  } catch {
    return null;
  }
}

/** Normalize both tool frontends to the same existing lookup payload. */
export function recallRequest(value: unknown): {
  prompt: string;
  terms: string[];
  limit: number;
} {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Recall arguments must be an object.");
  const input = value as Record<string, unknown>;
  const prompt = typeof input.prompt === "string" ? input.prompt.trim() : "";
  if (!prompt) throw new Error("Recall prompt is required.");
  if (input.messageRef !== undefined) {
    if (
      typeof input.messageRef !== "string" ||
      !parseRecallReference(input.messageRef)
    ) {
      throw new Error(
        "messageRef must be an exact reference returned by Recall.",
      );
    }
    return { prompt, terms: [input.messageRef.trim()], limit: 1 };
  }
  const terms = recallTerms(
    Array.isArray(input.memorySearchTerms)
      ? input.memorySearchTerms.filter(
          (term): term is string => typeof term === "string",
        )
      : [],
  );
  if (!terms.length)
    throw new Error(
      "memorySearchTerms is required: pass concrete terms, or a messageRef returned by Recall.",
    );
  return {
    prompt,
    terms,
    limit: recallLimit(
      typeof input.limit === "number" ? input.limit : undefined,
    ),
  };
}

export type RecallMessage = {
  scope: string;
  id: string;
  atMs: number | null;
  role: "user" | "assistant";
  text: string;
  matchTerms?: readonly string[];
  /** Canonical ordering when timestamps collide. */
  order?: number;
};

export type RecallExchange = {
  /** Best-first search order is retained when overlapping exchanges merge. */
  messages: readonly RecallMessage[];
  matchedIds: readonly string[];
};

/** Center search excerpts on their strongest literal match; references page the original text. */
export function recallExcerpt(
  text: string,
  terms: readonly string[],
  offset?: number,
  maxChars = RECALL_MESSAGE_CHARS,
): { text: string; nextOffset: number | null } {
  let start = offset ?? 0;
  if (offset === undefined && text.length > maxChars) {
    const needles = [
      ...recallTerms(terms),
      ...recallWords(terms.join(" ")),
    ].sort((a, b) => b.length - a.length);
    for (const needle of needles) {
      const escaped = needle.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
      const match = new RegExp(escaped, "iu").exec(text);
      if (match) {
        start = Math.max(0, match.index - Math.floor(maxChars / 3));
        break;
      }
    }
  }
  start = Math.min(start, text.length);
  const end = Math.min(text.length, start + maxChars);
  return {
    text: `${start > 0 ? "…" : ""}${text.slice(start, end).trim()}${end < text.length ? "…" : ""}`,
    nextOffset: end < text.length ? end : null,
  };
}

export function mergeRecallExchanges(
  exchanges: readonly RecallExchange[],
): RecallExchange[] {
  const groups: Array<{
    messages: Map<string, RecallMessage>;
    matchedIds: Set<string>;
  }> = [];
  const key = (m: RecallMessage): string => recallReference(m.scope, m.id);
  for (const exchange of exchanges) {
    const messages = new Map(
      exchange.messages.filter((m) => m.text.trim()).map((m) => [key(m), m]),
    );
    if (!messages.size) continue;
    const overlapping = groups.filter((group) =>
      [...messages.keys()].some((id) => group.messages.has(id)),
    );
    const group = overlapping[0] ?? {
      messages: new Map<string, RecallMessage>(),
      matchedIds: new Set<string>(),
    };
    if (!overlapping.length) groups.push(group);
    for (const other of overlapping.slice(1)) {
      for (const [id, message] of other.messages)
        group.messages.set(id, message);
      for (const id of other.matchedIds) group.matchedIds.add(id);
      groups.splice(groups.indexOf(other), 1);
    }
    for (const [id, message] of messages) {
      const existing = group.messages.get(id);
      group.messages.set(
        id,
        existing?.matchTerms?.length && !message.matchTerms?.length
          ? { ...message, matchTerms: existing.matchTerms }
          : message,
      );
    }
    for (const id of exchange.matchedIds) group.matchedIds.add(id);
  }
  return groups.map((group) => ({
    messages: [...group.messages.values()].sort(
      (a, b) =>
        a.scope.localeCompare(b.scope) ||
        (a.order ?? a.atMs ?? 0) - (b.order ?? b.atMs ?? 0) ||
        a.id.localeCompare(b.id),
    ),
    matchedIds: [...group.matchedIds],
  }));
}

export function renderRecallExchanges(
  exchanges: readonly RecallExchange[],
  terms: readonly string[],
  budget = RECALL_TEXT_BUDGET,
): string {
  const groups = mergeRecallExchanges(exchanges);
  const requested = terms.length === 1 ? parseRecallReference(terms[0]!) : null;
  const blocks: string[] = [];
  let remaining = budget;
  for (const [index, group] of groups.entries()) {
    const cap = Math.min(
      remaining,
      Math.max(3_000, Math.floor(remaining / (groups.length - index))),
    );
    const heading = `# Exchange ${index + 1} (messages oldest to newest)`;
    let available = cap - heading.length - 2;
    const selected = new Map<RecallMessage, string>();
    // Reserve space for matching messages before their neighbors. Render in
    // canonical order afterward so a response never appears before its question.
    const prioritized = [...group.messages].sort(
      (a, b) =>
        Number(group.matchedIds.includes(b.id)) -
        Number(group.matchedIds.includes(a.id)),
    );
    for (const message of prioritized) {
      const ref = recallReference(message.scope, message.id);
      const sameReference =
        requested?.scope === message.scope && requested.id === message.id;
      const isMatch = group.matchedIds.includes(message.id);
      const excerpt = recallExcerpt(
        message.text,
        message.matchTerms?.length ? message.matchTerms : terms,
        sameReference ? requested.offset : undefined,
        isMatch ? RECALL_MESSAGE_CHARS : 350,
      );
      const timestamp =
        message.atMs !== null &&
        Number.isFinite(new Date(message.atMs).getTime())
          ? new Date(message.atMs).toISOString()
          : "unknown time";
      const label = `- [${timestamp}] ${message.role === "user" ? "User" : "Stella"} (messageRef=${ref}):`;
      const next =
        excerpt.nextOffset === null
          ? ""
          : `\n  next: ${recallReference(message.scope, message.id, excerpt.nextOffset)}`;
      const room = available - label.length - next.length - 3;
      if (room < 80) continue;
      const body = excerpt.text;
      if (body.length > room) continue;
      const rendered = `${label} ${body.replace(/\n/gu, "\n  ")}${next}`;
      if (rendered.length + 1 > available) continue;
      selected.set(message, rendered);
      available -= rendered.length + 1;
    }
    if (!selected.size) continue;
    const block = [
      heading,
      ...group.messages.flatMap((message) =>
        selected.has(message) ? [selected.get(message)!] : [],
      ),
    ].join("\n");
    if (block.length + 2 > remaining) break;
    blocks.push(block);
    remaining -= block.length + 2;
  }
  return blocks.join("\n\n");
}

/** Actual token forms from FTS snippets, including stemming/diacritic matches. */
export function recallMatchedTerms(snippet: string): string[] {
  return [...snippet.matchAll(/\u0001([^\u0002]+)\u0002/gu)].map(
    (match) => match[1]!,
  );
}
