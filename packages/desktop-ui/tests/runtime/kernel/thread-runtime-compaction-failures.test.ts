import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Regression coverage for the production compaction outage: `stella/max`
// remapped upstream to `claude-fable-5`, the summary call's
// `thinking.type=disabled` shape started returning 400, and
// `generateThreadSummary` swallowed the error — so the orchestrator thread
// grew to 260k+ stored tokens without a single [[THREAD_CHECKPOINT]] being
// written and with nothing in the logs.

const completeSimpleMock = vi.fn();

vi.mock("@stella/runtime/ai/stream", () => ({
  completeSimple: (...args: unknown[]) => completeSimpleMock(...args),
  readAssistantText: (message: {
    content: Array<{ type: string; text?: string }>;
  }): string =>
    message.content
      .filter((part) => part.type === "text")
      .map((part) => part.text ?? "")
      .join("")
      .trim(),
}));

import {
  buildDurableMemoryReference,
  buildThreadSummaryRequest,
  formatThreadCheckpointMessage,
  maybeCompactRuntimeThread,
  resetThreadSummaryFailureTracking,
  validateThreadSummary,
} from "@stella/runtime/kernel/thread-runtime";
import { compactRuntimeThreadHistory } from "@stella/runtime/kernel/agent-runtime/thread-memory";
import type { RuntimeStore } from "@stella/runtime/kernel/storage/runtime-store";
import type { ResolvedLlmRoute } from "@stella/runtime/kernel/model-routing";

// ~10k chars per message; 60 messages ≈ 150k estimated tokens — far past the
// 60k orchestrator trigger, and big enough that the raw formatted middle
// exceeds the summarizer's input budget.
const buildBigThreadMessages = () =>
  Array.from({ length: 60 }, (_, index) => ({
    entryId: `entry-${index + 1}`,
    timestamp: 1_000 + index,
    role: index % 2 === 0 ? "user" : "assistant",
    content: `message ${index + 1} ${"x".repeat(10_000)}`,
  }));

const createFakeStore = (
  messages: ReturnType<
    typeof buildBigThreadMessages
  > = buildBigThreadMessages(),
) => {
  const compactCalls: Array<Record<string, unknown>> = [];
  const store = {
    loadThreadMessages: () => messages,
    compactThread: (args: Record<string, unknown>) => {
      compactCalls.push(args);
    },
    updateThreadSummary: () => undefined,
  } as unknown as RuntimeStore;
  return { store, compactCalls };
};

const createRoute = (
  apiKey: string | null,
  contextWindow = 80_000,
): ResolvedLlmRoute =>
  ({
    route: "stella",
    model: { id: "stella/max", contextWindow },
    getApiKey: async () => apiKey,
  }) as unknown as ResolvedLlmRoute;

const validSummary = (
  detail = "The compaction backlog is summarized safely.",
) =>
  [
    "## Topic",
    "Stella runtime compaction acceptance safety.",
    "",
    "## Key Points",
    `${detail} Durable history remains available and provider protocol failures fail closed.`,
    "",
    "## Current State",
    "The implementation is under focused validation with bounded retry behavior.",
    "",
    "## Open Items",
    "Run the remaining checks and obtain an independent review.",
  ].join("\n");

const assistantResult = (
  text: string,
  stopReason: "stop" | "length" | "toolUse" | "error" | "aborted" = "stop",
) => ({
  content: [{ type: "text", text }],
  stopReason,
  ...(stopReason === "error" ? { errorMessage: "provider stream failed" } : {}),
});

describe("thread summary validation", () => {
  it("rejects malformed, invisible, template, and never-shrinking summaries", () => {
    expect(
      validateThreadSummary("## Topic\nCut off mid-sentence", 20_000),
    ).toMatchObject({
      valid: false,
      reason: "missing informative ## Key Points section",
    });
    expect(validateThreadSummary("\u200B\u200C\u2060", 20_000)).toMatchObject({
      valid: false,
      reason: "no visible content",
    });
    expect(
      validateThreadSummary(
        [
          "## Topic",
          "[What the conversation is about]",
          "## Key Points",
          "Important information, decisions, and conclusions from the conversation",
          "## Current State",
          "Where things stand now — what has been done, what is in progress",
          "## Open Items",
          "Unresolved questions, pending tasks, or next steps discussed",
        ].join("\n"),
        20_000,
      ),
    ).toMatchObject({ valid: false, reason: "template boilerplate" });

    const previousSummary = validSummary("Prior validated state. ".repeat(80));
    expect(
      validateThreadSummary(
        validSummary("Tiny update."),
        20_000,
        previousSummary,
      ),
    ).toMatchObject({
      valid: false,
      reason: expect.stringContaining("never-shrink floor"),
    });
  });

  it("accepts a complete informative summary", () => {
    expect(validateThreadSummary(validSummary(), 20_000)).toMatchObject({
      valid: true,
    });
  });

  it("bounds the complete maximum-overhead request at the smallest supported context", () => {
    const request = buildThreadSummaryRequest({
      formattedConversation: `${"old conversation ".repeat(20_000)}RECENT_CONVERSATION_TAIL`,
      previousSummary: "previous state ".repeat(20_000),
      summaryBudget: 100_000,
      durableMemoryReference: "durable memory ".repeat(20_000),
      correctiveReason: "malformed output ".repeat(2_000),
      systemPrompt: "system instruction ".repeat(20_000),
      resolvedLlm: createRoute("auth-token", 8_000),
    });

    const assembledInputChars =
      request.systemPrompt.length + request.promptBody.length;
    expect(assembledInputChars).toBeLessThanOrEqual(
      request.limits.maxInputChars,
    );
    expect(
      Math.ceil(assembledInputChars / 4) +
        request.maxOutputTokens +
        request.limits.safetyTokens,
    ).toBeLessThanOrEqual(request.limits.contextTokens);
    expect(request.limits.contextTokens).toBe(8_000);
    expect(request.maxOutputTokens).toBe(1_000);
    expect(request.systemPrompt).toContain("system instruction");
    expect(request.promptBody).toContain("previous state");
    expect(request.promptBody).toContain("durable memory");
    expect(request.promptBody).toContain("RETRY CORRECTION");
    expect(request.promptBody).toContain("RECENT_CONVERSATION_TAIL");
    expect(request.promptBody).toContain("Target ~1000 tokens");
  });
});

describe("orchestrator thread compaction failure handling", () => {
  beforeEach(() => {
    completeSimpleMock.mockReset();
    resetThreadSummaryFailureTracking();
  });

  it("propagates summary-LLM failures below the fallback ceiling", async () => {
    const { store, compactCalls } = createFakeStore();
    completeSimpleMock.mockRejectedValue(
      new Error(
        'upstream anthropic returned 400: "thinking.type.disabled" is not supported for this model. Thinking defaults to adaptive',
      ),
    );

    await expect(
      maybeCompactRuntimeThread({
        store,
        threadKey: "conversation-1",
        resolvedLlm: createRoute("auth-token", 200_000),
        agentType: "orchestrator",
      }),
    ).rejects.toThrow(/thinking\.type\.disabled/);
    expect(compactCalls).toHaveLength(0);

    // The wrapper every caller uses converts the failure into a logged
    // `compacted: false` rather than crashing the turn.
    const wrapped = await compactRuntimeThreadHistory({
      store,
      threadKey: "conversation-1",
      resolvedLlm: createRoute("auth-token", 200_000),
      agentType: "orchestrator",
    });
    expect(wrapped).toEqual({ compacted: false });
  });

  it("counts rejected provider promises through the real wrapper and reaches bounded fallback near the ceiling", async () => {
    const { store, compactCalls } = createFakeStore();
    completeSimpleMock.mockRejectedValue(new Error("upstream stream reset"));

    const first = await compactRuntimeThreadHistory({
      store,
      threadKey: "conversation-thrown-near-ceiling",
      resolvedLlm: createRoute("auth-token"),
      agentType: "orchestrator",
    });
    const second = await compactRuntimeThreadHistory({
      store,
      threadKey: "conversation-thrown-near-ceiling",
      resolvedLlm: createRoute("auth-token"),
      agentType: "orchestrator",
    });

    expect(first).toEqual({ compacted: false });
    expect(second).toMatchObject({ compacted: true, fromOverride: false });
    expect(completeSimpleMock).toHaveBeenCalledTimes(4);
    expect(compactCalls).toHaveLength(1);
    expect(String(compactCalls[0]?.summary)).toContain(
      "Mechanical fallback checkpoint",
    );
    expect(String(compactCalls[0]?.summary)).not.toContain(
      "upstream stream reset",
    );
  });

  it("does not advance a failure streak across no-credential or abort skips", async () => {
    const { store, compactCalls } = createFakeStore();
    const threadKey = "conversation-deterministic-skip-streak";
    completeSimpleMock.mockRejectedValue(
      new Error("eligible provider failure"),
    );

    expect(
      await compactRuntimeThreadHistory({
        store,
        threadKey,
        resolvedLlm: createRoute("auth-token"),
        agentType: "orchestrator",
      }),
    ).toEqual({ compacted: false });
    expect(
      await compactRuntimeThreadHistory({
        store,
        threadKey,
        resolvedLlm: createRoute(null),
        agentType: "orchestrator",
      }),
    ).toEqual({ compacted: false });
    expect(
      await compactRuntimeThreadHistory({
        store,
        threadKey,
        resolvedLlm: createRoute("auth-token"),
        agentType: "orchestrator",
      }),
    ).toEqual({ compacted: false });

    const abortError = new Error("Request was aborted");
    abortError.name = "AbortError";
    completeSimpleMock.mockRejectedValue(abortError);
    expect(
      await compactRuntimeThreadHistory({
        store,
        threadKey,
        resolvedLlm: createRoute("auth-token"),
        agentType: "orchestrator",
      }),
    ).toEqual({ compacted: false });

    completeSimpleMock.mockRejectedValue(new Error("eligible after abort"));
    expect(
      await compactRuntimeThreadHistory({
        store,
        threadKey,
        resolvedLlm: createRoute("auth-token"),
        agentType: "orchestrator",
      }),
    ).toEqual({ compacted: false });
    expect(compactCalls).toHaveLength(0);
  });

  it("caps the summary input so an oversized backlog still compacts", async () => {
    const { store, compactCalls } = createFakeStore();
    completeSimpleMock.mockResolvedValue(assistantResult(validSummary()));

    const result = await maybeCompactRuntimeThread({
      store,
      threadKey: "conversation-1",
      resolvedLlm: createRoute("auth-token"),
      agentType: "orchestrator",
    });

    expect(result).toMatchObject({ compacted: true });
    expect(compactCalls).toHaveLength(1);
    expect(compactCalls[0]).toMatchObject({
      threadKey: "conversation-1",
      summary: validSummary(),
    });

    expect(completeSimpleMock).toHaveBeenCalledTimes(1);
    const context = completeSimpleMock.mock.calls[0]![1] as {
      messages: Array<{ content: Array<{ type: string; text: string }> }>;
    };
    const prompt = context.messages[0]!.content[0]!.text;
    // Input budget: (80k window - 16,384 reserve) tokens * 4 chars, plus the
    // prompt scaffold. The raw middle (~550k chars) must have been truncated.
    expect(prompt.length).toBeLessThan((80_000 - 16_384) * 4 + 5_000);
    expect(prompt).toContain("Compaction input truncated");
    // The most recent part of the compacted middle survives the cap (the
    // very last ~20k tokens are the keep-recent tail, excluded from the
    // middle entirely); the oldest middle messages are elided.
    expect(prompt).toContain("message 50");
    expect(prompt).not.toContain("message 3 ");
  });

  it("retries one malformed summary with a corrective prompt, then compacts the valid replacement", async () => {
    const { store, compactCalls } = createFakeStore();
    completeSimpleMock
      .mockResolvedValueOnce(assistantResult("## Topic\nCut off"))
      .mockResolvedValueOnce(
        assistantResult(
          validSummary("The corrective retry returned complete state."),
        ),
      );

    const result = await maybeCompactRuntimeThread({
      store,
      threadKey: "conversation-corrected",
      resolvedLlm: createRoute("auth-token"),
      agentType: "orchestrator",
    });

    expect(result).toMatchObject({ compacted: true });
    expect(completeSimpleMock).toHaveBeenCalledTimes(2);
    expect(compactCalls).toHaveLength(1);
    expect(compactCalls[0]?.summary).toBe(
      validSummary("The corrective retry returned complete state."),
    );
    const retryContext = completeSimpleMock.mock.calls[1]![1] as {
      messages: Array<{ content: Array<{ type: string; text: string }> }>;
    };
    expect(retryContext.messages[0]!.content[0]!.text).toContain(
      "RETRY CORRECTION",
    );
  });

  it("rejects an invalid hook override and generates a validated replacement", async () => {
    const { store, compactCalls } = createFakeStore();
    completeSimpleMock.mockResolvedValue(
      assistantResult(validSummary("The invalid hook override was replaced.")),
    );

    const result = await maybeCompactRuntimeThread({
      store,
      threadKey: "conversation-invalid-override",
      resolvedLlm: createRoute("auth-token"),
      agentType: "orchestrator",
      overrideSummary: "## Topic\nHook output cut off",
    });

    expect(result).toEqual({
      compacted: true,
      summary: validSummary("The invalid hook override was replaced."),
      fromOverride: false,
    });
    expect(completeSimpleMock).toHaveBeenCalledTimes(1);
    expect(compactCalls).toHaveLength(1);
    expect(compactCalls[0]?.summary).toBe(
      validSummary("The invalid hook override was replaced."),
    );
    const context = completeSimpleMock.mock.calls[0]![1] as {
      messages: Array<{ content: Array<{ type: string; text: string }> }>;
    };
    expect(context.messages[0]!.content[0]!.text).toContain("hook override");
  });

  it("compacts a valid hook override without calling the provider", async () => {
    const { store, compactCalls } = createFakeStore();
    const overrideSummary = validSummary("The hook supplied complete state.");

    const result = await maybeCompactRuntimeThread({
      store,
      threadKey: "conversation-valid-override",
      resolvedLlm: createRoute("auth-token"),
      agentType: "orchestrator",
      overrideSummary,
    });

    expect(result).toEqual({
      compacted: true,
      summary: overrideSummary,
      fromOverride: true,
    });
    expect(completeSimpleMock).not.toHaveBeenCalled();
    expect(compactCalls).toHaveLength(1);
    expect(compactCalls[0]?.summary).toBe(overrideSummary);
  });

  it("bounds malformed output to exactly one corrective retry and preserves raw history", async () => {
    const { store, compactCalls } = createFakeStore();
    completeSimpleMock.mockResolvedValue(
      assistantResult("## Topic\nStill cut off"),
    );

    const result = await maybeCompactRuntimeThread({
      store,
      threadKey: "conversation-malformed",
      resolvedLlm: createRoute("auth-token", 200_000),
      agentType: "orchestrator",
    });

    expect(result).toEqual({ compacted: false });
    expect(completeSimpleMock).toHaveBeenCalledTimes(2);
    expect(compactCalls).toHaveLength(0);
  });

  it.each(["error", "length", "toolUse"] as const)(
    "rejects a %s provider terminal and retries only once",
    async (stopReason) => {
      const { store, compactCalls } = createFakeStore();
      completeSimpleMock.mockResolvedValue(
        assistantResult(validSummary("Partial provider output."), stopReason),
      );

      const result = await maybeCompactRuntimeThread({
        store,
        threadKey: `conversation-terminal-${stopReason}`,
        resolvedLlm: createRoute("auth-token", 200_000),
        agentType: "orchestrator",
      });

      expect(result).toEqual({ compacted: false });
      expect(completeSimpleMock).toHaveBeenCalledTimes(2);
      expect(compactCalls).toHaveLength(0);
    },
  );

  it("does not retry an aborted provider terminal or write a checkpoint", async () => {
    const { store, compactCalls } = createFakeStore();
    completeSimpleMock.mockResolvedValue(
      assistantResult(validSummary("Aborted partial output."), "aborted"),
    );

    const result = await maybeCompactRuntimeThread({
      store,
      threadKey: "conversation-terminal-aborted",
      resolvedLlm: createRoute("auth-token", 200_000),
      agentType: "orchestrator",
    });

    expect(result).toEqual({ compacted: false });
    expect(completeSimpleMock).toHaveBeenCalledTimes(1);
    expect(compactCalls).toHaveLength(0);
  });

  it("carries a validated prior summary near the ceiling without persisting malformed candidates", async () => {
    const previousSummary = validSummary(
      Array.from(
        { length: 100 },
        (_, index) =>
          `ValidatedDecision${index + 1} StoredArtifact${index + 1} remains tracked.`,
      ).join(" "),
    );
    const messages = [
      {
        entryId: "checkpoint-1",
        timestamp: 999,
        role: "assistant",
        content: formatThreadCheckpointMessage({ summary: previousSummary }),
      },
      ...buildBigThreadMessages(),
    ];
    const { store, compactCalls } = createFakeStore(messages);
    completeSimpleMock.mockResolvedValue(
      assistantResult("## Topic\nmalformed provider candidate"),
    );

    const first = await maybeCompactRuntimeThread({
      store,
      threadKey: "conversation-near-ceiling-prior",
      resolvedLlm: createRoute("auth-token"),
      agentType: "orchestrator",
    });
    const second = await maybeCompactRuntimeThread({
      store,
      threadKey: "conversation-near-ceiling-prior",
      resolvedLlm: createRoute("auth-token"),
      agentType: "orchestrator",
    });

    expect(first).toEqual({ compacted: false });
    expect(second).toMatchObject({ compacted: true });
    expect(completeSimpleMock).toHaveBeenCalledTimes(4);
    expect(compactCalls).toHaveLength(1);
    const fallback = String(compactCalls[0]?.summary);
    expect(fallback).toContain(previousSummary);
    expect(fallback).toContain("Compaction Recovery Note");
    expect(fallback).not.toContain("malformed provider candidate");
  });

  it("uses a bounded mechanical fallback near the ceiling when no prior checkpoint exists", async () => {
    const { store, compactCalls } = createFakeStore();
    completeSimpleMock.mockResolvedValue(
      assistantResult("## Topic\nmalformed provider candidate"),
    );

    const first = await maybeCompactRuntimeThread({
      store,
      threadKey: "conversation-near-ceiling-mechanical",
      resolvedLlm: createRoute("auth-token"),
      agentType: "orchestrator",
    });
    const second = await maybeCompactRuntimeThread({
      store,
      threadKey: "conversation-near-ceiling-mechanical",
      resolvedLlm: createRoute("auth-token"),
      agentType: "orchestrator",
    });

    expect(first).toEqual({ compacted: false });
    expect(second).toMatchObject({ compacted: true });
    expect(completeSimpleMock).toHaveBeenCalledTimes(4);
    expect(compactCalls).toHaveLength(1);
    const fallback = String(compactCalls[0]?.summary);
    expect(fallback).toContain("Mechanical fallback checkpoint");
    expect(fallback.length).toBeLessThanOrEqual(1_200);
    expect(fallback).not.toContain("malformed provider candidate");
  });

  it("threads summary guidelines and the durable-memory reference into the prompt", async () => {
    const stellaDataDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "stella-compaction-memory-"),
    );
    fs.mkdirSync(path.join(stellaDataDir, "memories"), { recursive: true });
    fs.writeFileSync(
      path.join(stellaDataDir, "memories", "profile.md"),
      "Rahul's workshop address is 123 Elm Street.",
    );
    fs.writeFileSync(
      path.join(stellaDataDir, "memories", "memory_map.md"),
      "Workflow tiers: tier-1 ships without review.\n<!-- retired transport -->",
    );
    try {
      const { store } = createFakeStore();
      completeSimpleMock.mockResolvedValue(assistantResult(validSummary()));

      await maybeCompactRuntimeThread({
        store,
        threadKey: "conversation-1",
        resolvedLlm: createRoute("auth-token"),
        agentType: "orchestrator",
        stellaDataDir,
      });

      const context = completeSimpleMock.mock.calls[0]![1] as {
        messages: Array<{ content: Array<{ type: string; text: string }> }>;
      };
      const prompt = context.messages[0]!.content[0]!.text;
      // Thread-id mapping + verbatim pending-decision guidelines.
      expect(prompt).toContain("thread_id");
      expect(prompt).toContain("quoted verbatim");
      // The always-loaded docs ride along as a do-not-repeat reference.
      expect(prompt).toContain("ALREADY KNOWN");
      expect(prompt).toContain("123 Elm Street");
      expect(prompt).toContain("tier-1 ships without review");
      expect(prompt).not.toContain("retired transport");
      expect(prompt).toContain("Do not restate durable memory");

      // Non-orchestrator agents don't get the docs injected per turn, so
      // their summaries must keep such facts: no reference, no omit rule.
      completeSimpleMock.mockClear();
      completeSimpleMock.mockResolvedValue(assistantResult(validSummary()));
      await maybeCompactRuntimeThread({
        store: createFakeStore().store,
        threadKey: "conversation-2",
        resolvedLlm: createRoute("auth-token"),
        agentType: "general",
        stellaDataDir,
      });
      const subagentContext = completeSimpleMock.mock.calls[0]![1] as {
        messages: Array<{ content: Array<{ type: string; text: string }> }>;
      };
      const subagentPrompt = subagentContext.messages[0]!.content[0]!.text;
      expect(subagentPrompt).toContain("thread_id");
      expect(subagentPrompt).not.toContain("ALREADY KNOWN");
      expect(subagentPrompt).not.toContain("123 Elm Street");
      expect(subagentPrompt).not.toContain("Do not restate durable memory");
    } finally {
      fs.rmSync(stellaDataDir, { recursive: true, force: true });
    }
  });

  it("preserves an odd-prefix astral document at the exact code-point cap without a lone surrogate", () => {
    const stellaDataDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "stella-compaction-unicode-"),
    );
    const memoriesDir = path.join(stellaDataDir, "memories");
    fs.mkdirSync(memoriesDir, { recursive: true });
    const exact = `x${"😀".repeat(7_999)}`;
    expect(Array.from(exact)).toHaveLength(8_000);
    expect(exact.length).toBe(15_999);
    fs.writeFileSync(path.join(memoriesDir, "profile.md"), exact, "utf-8");

    try {
      const reference = buildDurableMemoryReference(stellaDataDir);
      expect(reference).toBe(
        `### User profile (memories/profile.md)\n${exact}`,
      );
      expect(reference).not.toContain("[truncated]");
      expect(reference).not.toContain("\uFFFD");
      expect(reference).not.toMatch(
        /(?:^|[^\uD800-\uDBFF])[\uDC00-\uDFFF]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])/u,
      );
    } finally {
      fs.rmSync(stellaDataDir, { recursive: true, force: true });
    }
  });

  it("truncates an over-cap durable-memory reference only at a complete line", () => {
    const stellaDataDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "stella-compaction-line-cap-"),
    );
    const memoriesDir = path.join(stellaDataDir, "memories");
    fs.mkdirSync(memoriesDir, { recursive: true });
    const firstLine = `x${"😀".repeat(3_999)}`;
    fs.writeFileSync(
      path.join(memoriesDir, "profile.md"),
      `${firstLine}\n${"z".repeat(4_100)}`,
      "utf-8",
    );

    try {
      expect(buildDurableMemoryReference(stellaDataDir)).toBe(
        `### User profile (memories/profile.md)\n${firstLine}\n[truncated]`,
      );
    } finally {
      fs.rmSync(stellaDataDir, { recursive: true, force: true });
    }
  });

  it("skips without calling the model when no credential is available", async () => {
    const { store, compactCalls } = createFakeStore();

    const result = await maybeCompactRuntimeThread({
      store,
      threadKey: "conversation-1",
      resolvedLlm: createRoute(null),
      agentType: "orchestrator",
    });

    expect(result).toEqual({ compacted: false });
    expect(completeSimpleMock).not.toHaveBeenCalled();
    expect(compactCalls).toHaveLength(0);
  });
});
