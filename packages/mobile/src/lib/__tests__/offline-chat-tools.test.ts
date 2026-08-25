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
  MAX_CHECKPOINT_SUMMARY_CHARS,
  MAX_CONTEXT_MESSAGE_CHARS,
  MAX_CONTEXT_TAIL_MESSAGES,
  runCompaction,
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

  test("parses unified web search and fetch calls", () => {
    const raw = [
      TOOL_BLOCK_OPEN,
      '{"tool":"web","query":"latest news","category":"news"}',
      '{"tool":"web","url":"https://example.test","prompt":"pricing","format":"markdown"}',
      TOOL_BLOCK_CLOSE,
    ].join("\n");
    expect(parseToolBlock(raw).calls).toEqual([
      { tool: "web", query: "latest news", category: "news" },
      {
        tool: "web",
        url: "https://example.test",
        prompt: "pricing",
        format: "markdown",
      },
    ]);
  });

  test("drops malformed / invalid tool lines", () => {
    const raw = [
      "ok",
      TOOL_BLOCK_OPEN,
      "not json",
      '{"tool":"remember","key":""}',
      '{"tool":"web"}',
      '{"tool":"web","query":"news","url":"https://example.test"}',
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
