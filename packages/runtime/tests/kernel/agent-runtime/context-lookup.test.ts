import { describe, expect, it } from "vitest";

import {
  MAX_THREAD_SEARCH_RESULTS,
  formatThreadSearchResults,
  formatTranscriptSearchResults,
} from "@stella/runtime/kernel/agent-runtime/context-lookup";

describe("formatThreadSearchResults", () => {
  const now = Date.UTC(2026, 6, 10, 20, 0);

  const makeStore = (
    threads: unknown[],
    excerpts: Map<
      string,
      { resultExcerpt?: string; errorExcerpt?: string }
    > = new Map(),
    summariesByAgentId: Record<string, { text: string; atMs: number }[]> = {},
    onSearch?: (args: unknown) => void,
  ) =>
    ({
      searchThreads: (args: unknown) => {
        onSearch?.(args);
        return threads;
      },
      listThreadResultExcerpts: () => excerpts,
      listAgentAssistantMessages: (agentId: string, limit = 3) =>
        (summariesByAgentId[agentId] ?? []).slice(-limit),
    }) as unknown as Parameters<typeof formatThreadSearchResults>[0];

  it("renders newest-first with absolute date/time, live state, scope, and result/error excerpts", () => {
    const out = formatThreadSearchResults(
      makeStore(
        [
          // Given oldest-first to prove the formatter re-orders by recency.
          {
            threadId: "older-thread",
            conversationId: "conv-2",
            name: "Draft the budget",
            createdAt: now - 90 * 60_000,
            lastUsedAt: now - 60 * 60_000,
            description: "Draft the household budget spreadsheet",
            agentStatus: "error",
          },
          {
            threadId: "newer-thread",
            conversationId: "conv-1",
            name: "Deploy the backend",
            createdAt: now - 3 * 60_000,
            lastUsedAt: now - 60_000,
            description: "Deploy the backend",
            agentStatus: "completed",
          },
        ],
        new Map([
          ["newer-thread", { resultExcerpt: "Deployed   rev  42\nto prod" }],
          ["older-thread", { errorExcerpt: "spreadsheet API returned 401" }],
        ]),
      ),
      "conv-1",
      "budget deploy",
    );
    expect(out).toContain("[newest → oldest by last activity]");
    expect(out.indexOf("newer-thread")).toBeLessThan(
      out.indexOf("older-thread"),
    );
    // Absolute date/time per entry for recency awareness.
    expect(out).toMatch(/- newer-thread \| last active [A-Z][a-z]{2} \d/);
    expect(out).toContain("| from this conversation | Deploy the backend");
    expect(out).toContain("| from another conversation | Draft the budget");
    // Result/error excerpts collapse whitespace into one dense line.
    expect(out).toContain("result: Deployed rev 42 to prod");
    expect(out).toContain("error: spreadsheet API returned 401");
    // A description identical to the name adds nothing — deduped.
    expect(out).toContain(
      "description: Draft the household budget spreadsheet",
    );
    expect(out).not.toContain("description: Deploy the backend");
  });

  it("attaches live progress to ACTIVE threads only", () => {
    const liveNow = Date.now();
    const out = formatThreadSearchResults(
      makeStore(
        [
          {
            threadId: "scrape-airline-a",
            conversationId: "conv-1",
            description: "Scrape airline A fares",
            lastUsedAt: liveNow - 60_000,
            agentStatus: "running",
          },
        ],
        new Map(),
        {
          "scrape-airline-a": [
            { text: "paging through fare results", atMs: liveNow - 20_000 },
          ],
        },
      ),
      "conv-1",
      "flights",
    );
    expect(out).toContain("(active, last active");
    expect(out).toContain("agent updates (newest last):");
    expect(out).toMatch(/- \[[^\]]+\] paging through fare results/);
  });

  it("caps the store request at the max even when a larger limit is asked for", () => {
    const calls: Array<{ limit?: number }> = [];
    formatThreadSearchResults(
      makeStore([], new Map(), {}, (args) =>
        calls.push(args as { limit?: number }),
      ),
      "conv-1",
      "anything",
      99,
    );
    expect(calls[0]?.limit).toBe(MAX_THREAD_SEARCH_RESULTS);
  });

  it("explains an empty result differently with and without a query", () => {
    expect(
      formatThreadSearchResults(makeStore([]), "conv-1", "flights"),
    ).toMatch(/No agent threads matched/);
    expect(
      formatThreadSearchResults(makeStore([]), "conv-1", undefined),
    ).toMatch(/No past agent work recorded/);
  });
});

describe("formatTranscriptSearchResults", () => {
  const makeStore = (messageHits: unknown[], neighbors: unknown[] = []) =>
    ({
      searchTranscripts: () =>
        messageHits.map((hit, index) => ({
          ...(hit as object),
          id: `hit-${index}`,
        })),
      listTranscriptNeighbors: () =>
        neighbors.map((hit, index) => ({
          ...(hit as object),
          id: `neighbor-${index}`,
        })),
    }) as unknown as Parameters<typeof formatTranscriptSearchResults>[0];

  it("keeps exchanges in relevance order with dated, scoped message references", () => {
    const now = Date.now();
    const out = formatTranscriptSearchResults(
      makeStore([
        // Relevance-ranked input: newest/most-relevant first.
        {
          conversationId: "conv-old",
          role: "assistant" as const,
          atMs: now - 1_000,
          text: "took the Emira out to Saguaro Lake",
        },
        {
          conversationId: "conv-1",
          role: "user" as const,
          atMs: now - 500_000,
          text: "emira day",
        },
      ]),
      "conv-1",
      "emira saguaro",
    );
    expect(out).toContain("# Exchange 1 (messages oldest to newest)");
    // Distinct exchanges retain BM25 order. Messages within each exchange are chronological.
    expect(out.indexOf("emira day")).toBeGreaterThan(
      out.indexOf("took the Emira out to Saguaro Lake"),
    );
    expect(out).toMatch(/User \(messageRef=recall:conv-1:hit-1:0\): emira day/);
    expect(out).toMatch(
      /Stella \(messageRef=recall:conv-old:hit-0:0\): took the Emira out to Saguaro Lake/,
    );
  });

  it("expands top message hits with their surrounding exchange", () => {
    const atMs = Date.UTC(2026, 5, 25, 19);
    const out = formatTranscriptSearchResults(
      makeStore(
        [
          {
            conversationId: "conv-old",
            role: "assistant" as const,
            atMs,
            text: "drop this in maps: Saguaro Lake Marina, 14011 N Bush Hwy",
          },
        ],
        [
          {
            conversationId: "conv-old",
            role: "user" as const,
            atMs: atMs - 60_000,
            text: "Give me address so I can tap on my phone",
          },
          {
            conversationId: "conv-old",
            role: "user" as const,
            atMs: atMs + 60_000,
            text: "damn i love the car. lol.",
          },
        ],
      ),
      "conv-1",
      "saguaro marina",
    );
    expect(out).toContain("# Exchange 1");
    expect(out).toMatch(
      /\[[^\]]+\] User \(messageRef=[^)]+\): Give me address so I can tap/,
    );
    expect(out).toMatch(
      /\[[^\]]+\] User \(messageRef=[^)]+\): damn i love the car/,
    );
  });

  it("windows long message texts around the first matching token", () => {
    const filler = "lorem ipsum dolor sit amet ".repeat(40);
    const out = formatTranscriptSearchResults(
      makeStore([
        {
          conversationId: "conv-old",
          role: "user" as const,
          atMs: Date.now(),
          text: `${filler} the emira felt amazing on that road ${filler}`,
        },
      ]),
      "conv-1",
      "emira",
    );
    expect(out).toContain("emira felt amazing");
    expect(out).toContain("…");
    // Snippet stays bounded instead of dumping the whole message.
    expect(out.length).toBeLessThan(1800);
    expect(out).toContain("next: recall:");
  });

  it("explains empty results and unusable queries", () => {
    expect(
      formatTranscriptSearchResults(makeStore([]), "conv-1", "flights"),
    ).toMatch(/Nothing matched in past conversation transcripts/);
    // The tokenizer keeps all-stopword queries searchable; only an EMPTY
    // query has no usable terms.
    expect(
      formatTranscriptSearchResults(makeStore([]), "conv-1", undefined),
    ).toMatch(/No usable search terms/);
  });
});
