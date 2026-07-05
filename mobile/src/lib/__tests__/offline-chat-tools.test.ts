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
  searchMessages,
  formatRecallResults,
  tokenize,
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

describe("chat-recall.searchMessages", () => {
  const messages: ChatMessage[] = [
    msg("1", "user", "My dog is named Biscuit", 1),
    msg("2", "assistant", "Nice, Biscuit is a great dog name", 2),
    msg("3", "user", "I moved to Austin last year", 3),
    msg("4", "assistant", "Austin has great tacos", 4),
  ];

  test("ranks messages that match query terms and drops non-matches", () => {
    const hits = searchMessages(messages, "biscuit dog");
    expect(hits.length).toBe(2);
    expect(hits.every((h) => /biscuit|dog/i.test(h.text))).toBe(true);
    // Both terms present ranks above single-term match.
    expect(hits[0]!.text).toContain("Biscuit");
  });

  test("excludeIds skips the in-flight turn's rows", () => {
    const hits = searchMessages(messages, "austin", {
      excludeIds: new Set(["3"]),
    });
    expect(hits.map((h) => h.id)).toEqual(["4"]);
  });

  test("empty / stopword-only query returns nothing", () => {
    expect(searchMessages(messages, "   ")).toEqual([]);
    expect(tokenize("a I")).toEqual([]);
  });

  test("formats hits into a readable block", () => {
    const text = formatRecallResults(searchMessages(messages, "austin"), "austin");
    expect(text).toContain("Earlier messages matching");
    expect(text).toContain("Austin");
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
    expect(plan).not.toBeNull();
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
