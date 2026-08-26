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
  buildMobileModelContext,
  normalizeMobileToolCall,
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
    expect(buildFtsMatchQuery('cat AND "dog"')).toBe('"cat" OR "and" OR "dog"');
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
      {
        id: "4",
        role: "assistant",
        text: "Austin has great tacos",
        created_at: null,
      },
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

describe("native mobile tool calls", () => {
  test("normalizes structured provider tool calls", () => {
    expect(
      normalizeMobileToolCall({
        id: "call_web",
        name: "web",
        arguments: { query: "latest news", category: "news" },
      }),
    ).toEqual({
      id: "call_web",
      tool: "web",
      query: "latest news",
      category: "news",
    });
    expect(
      normalizeMobileToolCall({
        id: "call_map",
        name: "map",
        arguments: { places: ["Blue Bottle SF"] },
      }),
    ).toEqual({
      id: "call_map",
      tool: "map",
      places: ["Blue Bottle SF"],
    });
  });

  test("rejects unknown tools and invalid arguments", () => {
    expect(
      normalizeMobileToolCall({ id: "x", name: "unknown", arguments: {} }),
    ).toBeNull();
    expect(
      normalizeMobileToolCall({
        id: "x",
        name: "web",
        arguments: { query: "news", url: "https://example.test" },
      }),
    ).toBeNull();
  });
});

describe("memory + model context", () => {
  const facts: MemoryFact[] = [
    { key: "name", value: "Ruuxi", updatedAt: 2 },
    { key: "home city", value: "Austin, TX", updatedAt: 1 },
  ];

  test("formats durable facts for context", () => {
    const text = formatMemoryForContext(facts);
    expect(text).toContain("name: Ruuxi");
    expect(text).toContain("home city: Austin, TX");
  });

  test("context carries only memory and the compacted summary", () => {
    const modelContext = buildMobileModelContext({
      memoryFacts: facts,
      summary: "They are planning a trip.",
    });
    expect(modelContext).toContain("Ruuxi");
    expect(modelContext).toContain("planning a trip");
    expect(modelContext.includes("Available tools")).toBe(false);
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
