import { describe, expect, test } from "bun:test";

// The memory/compaction modules import AsyncStorage, whose non-native fallback
// talks to `window.localStorage`; give the bun runtime an in-memory one before
// those modules are imported. (These tests exercise the PURE helpers only.)
const memoryStore = new Map<string, string>();
(globalThis as Record<string, unknown>).window = {
  localStorage: {
    getItem: (key: string) => memoryStore.get(key) ?? null,
    setItem: (key: string, value: string) => {
      memoryStore.set(key, value);
    },
    removeItem: (key: string) => {
      memoryStore.delete(key);
    },
  },
};

import type { ChatMessage } from "../../types";
import {
  buildFtsMatchQuery,
  formatRecallResults,
  rowToHit,
  tokenize,
  type MessageRow,
} from "../chat-recall";
import {
  parseToolBlock,
  createToolBlockFilter,
  buildToolPreamble,
  TOOL_BLOCK_OPEN,
  TOOL_BLOCK_CLOSE,
} from "../chat-tools";
import { formatMemoryForContext, type MemoryFact } from "../chat-memory";
import {
  planCompaction,
  buildCompactedContext,
  contextTokenEstimate,
  type ChatCheckpoint,
} from "../chat-compaction";

const msg = (
  id: string,
  role: ChatMessage["role"],
  text: string,
  createdAt = 0,
): ChatMessage => ({ id, role, text, createdAt });

describe("chat-recall FTS helpers", () => {
  test("buildFtsMatchQuery quotes and OR-joins tokens", () => {
    expect(buildFtsMatchQuery("biscuit dog")).toBe('"biscuit" OR "dog"');
  });

  test("buildFtsMatchQuery neutralizes FTS operators and punctuation", () => {
    // Quotes/operators are stripped by tokenization, so no FTS5 injection.
    expect(buildFtsMatchQuery('cat AND "dog"')).toBe(
      '"cat" OR "and" OR "dog"',
    );
  });

  test("empty / stopword-only query has no match expression", () => {
    expect(buildFtsMatchQuery("   ")).toBeNull();
    expect(buildFtsMatchQuery("a I")).toBeNull();
    expect(tokenize("a I")).toEqual([]);
  });

  test("rowToHit maps a matched row and negates bm25 into a score", () => {
    const row: MessageRow = {
      id: "3",
      role: "user",
      text: "I moved to Austin last year",
      created_at: Date.UTC(2026, 0, 2),
    };
    const hit = rowToHit(row, "austin", -1.7);
    expect(hit.id).toBe("3");
    expect(hit.role).toBe("user");
    expect(hit.snippet).toContain("Austin");
    // bm25 rank (lower = better) is negated so higher score = better.
    expect(hit.score).toBe(1.7);
  });

  test("rowToHit coerces unknown roles to assistant", () => {
    const row: MessageRow = {
      id: "x",
      role: "system",
      text: "hello world",
      created_at: null,
    };
    expect(rowToHit(row, "hello", 0).role).toBe("assistant");
  });

  test("formats hits into a readable block", () => {
    const hit = rowToHit(
      { id: "4", role: "assistant", text: "Austin has great tacos", created_at: null },
      "austin",
      -1,
    );
    const text = formatRecallResults([hit], "austin");
    expect(text).toContain("Earlier messages matching");
    expect(text).toContain("Austin");
  });

  test("empty result set formats a no-match line", () => {
    expect(formatRecallResults([], "austin")).toContain("No earlier messages");
  });
});

describe("chat-tools.parseToolBlock", () => {
  test("passes through a reply with no tool block", () => {
    const { visibleText, calls } = parseToolBlock("Hello there.");
    expect(visibleText).toBe("Hello there.");
    expect(calls).toEqual([]);
  });

  test("strips the block and parses calls", () => {
    const raw = [
      "Saved that for you.",
      TOOL_BLOCK_OPEN,
      '{"tool":"remember","key":"home city","value":"Austin"}',
      '{"tool":"map","places":["Blue Bottle SF"]}',
      TOOL_BLOCK_CLOSE,
    ].join("\n");
    const { visibleText, calls } = parseToolBlock(raw);
    expect(visibleText).toBe("Saved that for you.");
    expect(calls).toHaveLength(2);
    expect(calls[0]).toEqual({
      tool: "remember",
      key: "home city",
      value: "Austin",
    });
    expect(calls[1]).toMatchObject({ tool: "map", places: ["Blue Bottle SF"] });
  });

  test("drops malformed / invalid tool lines", () => {
    const raw = [
      "ok",
      TOOL_BLOCK_OPEN,
      "not json",
      '{"tool":"remember","key":""}',
      '{"tool":"nope"}',
      TOOL_BLOCK_CLOSE,
    ].join("\n");
    expect(parseToolBlock(raw).calls).toEqual([]);
  });
});

describe("chat-tools.createToolBlockFilter", () => {
  test("hides the tool block even when split across chunks", () => {
    const raw =
      `Here you go.${TOOL_BLOCK_OPEN}\n` +
      `{"tool":"forget","key":"x"}\n${TOOL_BLOCK_CLOSE}`;
    const filter = createToolBlockFilter();
    let shown = "";
    // Feed one character at a time to stress the hold-back logic.
    for (const ch of raw) shown += filter.feed(ch);
    shown += filter.finalize();
    expect(shown).toBe("Here you go.");
    expect(filter.raw()).toBe(raw);
    expect(parseToolBlock(filter.raw()).calls).toEqual([
      { tool: "forget", key: "x" },
    ]);
  });
});

describe("memory + preamble injection", () => {
  const facts: MemoryFact[] = [
    { key: "name", value: "Ruuxi", updatedAt: 2 },
    { key: "home city", value: "Austin, TX", updatedAt: 1 },
  ];

  test("formats durable facts for context", () => {
    const text = formatMemoryForContext(facts);
    expect(text).toContain("name: Ruuxi");
    expect(text).toContain("home city: Austin, TX");
  });

  test("preamble carries memory, summary, and tool docs", () => {
    const preamble = buildToolPreamble({
      memoryFacts: facts,
      summary: "They are planning a trip.",
    });
    expect(preamble).toContain("Ruuxi");
    expect(preamble).toContain("planning a trip");
    expect(preamble).toContain("remember");
    expect(preamble).toContain("recall");
    expect(preamble).toContain(TOOL_BLOCK_OPEN);
  });

  test("empty memory yields no memory block", () => {
    expect(formatMemoryForContext([])).toBe("");
  });
});

describe("chat-compaction planning", () => {
  const longText = "x".repeat(1000); // ~250 tokens each
  const many: ChatMessage[] = Array.from({ length: 40 }, (_, i) =>
    msg(String(i), i % 2 === 0 ? "user" : "assistant", `${longText} ${i}`, i),
  );

  test("no compaction below the trigger", () => {
    const few = many.slice(0, 3);
    expect(planCompaction(few, null)).toBeNull();
  });

  test("folds an oldest run once over the trigger, protecting the head", () => {
    expect(contextTokenEstimate(many, null)).toBeGreaterThan(6000);
    const plan = planCompaction(many, null);
    expect(plan === null).toBe(false);
    // Head-protected: the first two messages are never in the folded middle.
    expect(plan!.middle.some((m) => m.id === "0" || m.id === "1")).toBe(false);
    // A recent tail stays out of the middle.
    expect(plan!.middle.some((m) => m.id === "39")).toBe(false);
    expect(plan!.middle.length).toBeGreaterThan(0);
    expect(plan!.nextCoveredIds).toEqual(plan!.middle.map((m) => m.id));
  });

  test("compacted context = summary + uncovered tail", () => {
    const checkpoint: ChatCheckpoint = {
      summary: "Earlier: the user introduced themselves.",
      coveredIds: ["0", "1", "2", "3"],
      updatedAt: 1,
    };
    const context = buildCompactedContext(many, checkpoint);
    expect(context.summary).toContain("introduced themselves");
    // Covered rows are dropped from the history sent to the model.
    expect(context.history.length).toBe(many.length - 4);
  });
});
