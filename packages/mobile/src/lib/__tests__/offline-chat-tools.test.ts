import { describe, expect, test } from "bun:test";
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
  MAX_CHECKPOINT_SUMMARY_CHARS,
  MAX_CONTEXT_MESSAGE_CHARS,
  MAX_CONTEXT_TAIL_MESSAGES,
  runCompaction,
  type ChatCheckpoint,
} from "../chat-compaction";

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
  const longText = "x".repeat(1000);
  const many: ChatMessage[] = Array.from({ length: 40 }, (_, i) =>
    msg(String(i), i % 2 === 0 ? "user" : "assistant", `${longText} ${i}`, i),
  );

  test("no compaction below the trigger", () => {
    const few = many.slice(0, 3);
    expect(planCompaction(few, null)).toBeNull();
  });

  test("folds a contiguous oldest run and records one watermark", () => {
    expect(contextTokenEstimate(many, null)).toBeGreaterThan(6000);
    const plan = planCompaction(many, null);
    expect(plan === null).toBe(false);
    expect(plan!.middle[0]?.id).toBe("0");
    // A recent tail stays out of the middle.
    expect(plan!.middle.some((m) => m.id === "39")).toBe(false);
    expect(plan!.middle.length).toBeGreaterThan(0);
    expect(plan!.nextCoveredIds).toEqual([plan!.middle.at(-1)!.id]);
    expect(plan!.nextCoveredThroughId).toBe(plan!.middle.at(-1)!.id);
  });

  test("compacted context = summary + uncovered tail", () => {
    const checkpoint: ChatCheckpoint = {
      summary: "Earlier: the user introduced themselves.",
      coveredIds: ["0", "1", "2", "3"],
      updatedAt: 1,
    };
    const context = buildCompactedContext(many, checkpoint);
    expect(context.summary).toContain("introduced themselves");
    expect(context.history.length).toBeLessThan(many.length - 4);
    expect(context.history.at(-1)?.text).toContain("39");
  });

  test("bounds 10k short rows and oversized historical Markdown", async () => {
    const shortRows = Array.from({ length: 10_000 }, (_, index) =>
      msg(`short-${index}`, index % 2 ? "assistant" : "user", "ok", index),
    );
    const plan = planCompaction(shortRows, null);
    expect(plan === null).toBe(false);
    const checkpoint: ChatCheckpoint = {
      summary: "Earlier short turns retained in summary form.",
      coveredIds: plan!.nextCoveredIds,
      coveredThroughId: plan!.nextCoveredThroughId,
      updatedAt: 1,
    };
    expect(
      buildCompactedContext(shortRows, checkpoint).history.length,
    ).toBeLessThanOrEqual(MAX_CONTEXT_TAIL_MESSAGES);

    const markdown = `# Report\n\n${"large table cell | ".repeat(20_000)}`;
    const markdownRows = Array.from({ length: 8 }, (_, index) =>
      msg(
        `markdown-${index}`,
        index % 2 ? "assistant" : "user",
        markdown,
        index,
      ),
    );
    const context = buildCompactedContext(markdownRows, null);
    expect(context.history).toHaveLength(4);
    expect(
      context.history.every(
        (turn) => turn.text.length <= MAX_CONTEXT_MESSAGE_CHARS + 64,
      ),
    ).toBe(true);
    expect(context.history[0]?.text).toContain("historical message clipped");

    const promptLengths: number[] = [];
    const markdownCheckpoint = await runCompaction({
      messages: markdownRows,
      checkpoint: null,
      summarize: async (prompt) => {
        promptLengths.push(prompt.length);
        return "Bounded Markdown summary.";
      },
    });
    expect(markdownCheckpoint?.coveredThroughId).toBe("markdown-3");
    expect(promptLengths).toHaveLength(4);
    expect(promptLengths.every((length) => length < 14_000)).toBe(true);

    const oversizedSummary = await runCompaction({
      messages: shortRows,
      checkpoint: null,
      summarize: async () => "summary ".repeat(20_000),
    });
    expect(oversizedSummary?.summary.length).toBeLessThanOrEqual(
      MAX_CHECKPOINT_SUMMARY_CHARS + 64,
    );
  });

  test("hierarchically folds a 10k-row bootstrap with a crash marker", async () => {
    const shortRows = Array.from({ length: 10_000 }, (_, index) =>
      msg(`bootstrap-${index}`, index % 2 ? "assistant" : "user", "ok", index),
    );
    let calls = 0;
    const checkpoint = await runCompaction({
      messages: shortRows,
      checkpoint: null,
      bootstrapPending: true,
      summarize: async () => {
        calls += 1;
        return `summary pass ${calls}`;
      },
    });
    expect(calls).toBeGreaterThan(1);
    expect(checkpoint?.bootstrapPending).toBe(true);
    expect(checkpoint?.coveredThroughId).toBe("bootstrap-9839");
    expect(buildCompactedContext(shortRows, checkpoint).history).toHaveLength(
      MAX_CONTEXT_TAIL_MESSAGES,
    );
  });
});
