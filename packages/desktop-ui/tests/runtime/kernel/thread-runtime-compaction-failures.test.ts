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
  messages: Array<Record<string, unknown>> = buildBigThreadMessages(),
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

const VALID_SUMMARY = [
  "## Topic",
  "Condensed summary of the backlog covering the full compacted span.",
  "## Key Points",
  "All sixty backlog messages were reviewed and folded into this checkpoint,",
  "including the delegated workstreams and their thread ids.",
  "## Current State",
  "Work is ongoing; the latest turns remain uncompacted in the tail.",
  "## Open Items",
  "None outstanding beyond the active workstreams named above.",
].join("\n");

const THREAD_SUMMARY_HEADINGS_FOR_TEST = [
  "Topic",
  "Key Points",
  "Current State",
  "Open Items",
];

const LONG_PREVIOUS_SUMMARY = [
  "## Topic",
  "Multi-week Stella runtime hardening effort spanning compaction and release workstreams.",
  "## Key Points",
  ...Array.from(
    { length: 30 },
    (_, index) =>
      `- Workstream ${index + 1} landed a distinct verified change touching module number ${index + 101} with its own review notes and follow-up owners.`,
  ),
  "## Current State",
  "The release candidate is staged; verification agents are mid-flight across the remaining suites.",
  "## Open Items",
  "Awaiting the final review pass and the user's explicit activation approval.",
].join("\n");

const buildBigThreadMessagesWithCheckpoint = () => [
  {
    entryId: "entry-checkpoint",
    timestamp: 900,
    role: "assistant",
    content: formatThreadCheckpointMessage({ summary: LONG_PREVIOUS_SUMMARY }),
  },
  ...buildBigThreadMessages(),
];

describe("orchestrator thread compaction failure handling", () => {
  beforeEach(() => {
    completeSimpleMock.mockReset();
    resetThreadSummaryFailureTracking();
  });

  it("propagates summary-LLM failures instead of silently skipping compaction", async () => {
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
        resolvedLlm: createRoute("auth-token"),
        agentType: "orchestrator",
      }),
    ).rejects.toThrow(/thinking\.type\.disabled/);
    expect(compactCalls).toHaveLength(0);

    // The wrapper every caller uses converts the failure into a logged
    // `compacted: false` rather than crashing the turn.
    const wrapped = await compactRuntimeThreadHistory({
      store,
      threadKey: "conversation-1",
      resolvedLlm: createRoute("auth-token"),
      agentType: "orchestrator",
    });
    expect(wrapped).toEqual({ compacted: false });
  });

  it.each(["error", "aborted", "length", "toolUse"])(
    "refuses an unclean %s summary even when partial text exists",
    async (stopReason) => {
      const { store, compactCalls } = createFakeStore();
      completeSimpleMock.mockResolvedValue({
        content: [{ type: "text", text: VALID_SUMMARY }],
        stopReason,
        errorMessage: "provider stream ended before a clean stop",
      });

      const result = await maybeCompactRuntimeThread({
        store,
        threadKey: `unclean-${stopReason}`,
        resolvedLlm: createRoute("auth-token"),
        agentType: "orchestrator",
      });

      expect(result).toEqual({ compacted: false });
      expect(completeSimpleMock).toHaveBeenCalledTimes(2);
      expect(compactCalls).toHaveLength(0);
    },
  );

  it("retries an invalid generated summary with a corrective prompt", async () => {
    const { store, compactCalls } = createFakeStore();
    completeSimpleMock
      .mockResolvedValueOnce({
        content: [{ type: "text", text: "## Topic\nTruncated." }],
        stopReason: "stop",
      })
      .mockResolvedValueOnce({
        content: [{ type: "text", text: VALID_SUMMARY }],
        stopReason: "stop",
      });

    const result = await maybeCompactRuntimeThread({
      store,
      threadKey: "corrective-retry",
      resolvedLlm: createRoute("auth-token"),
      agentType: "orchestrator",
    });

    expect(result).toEqual({ compacted: true });
    expect(completeSimpleMock).toHaveBeenCalledTimes(2);
    const retryContext = completeSimpleMock.mock.calls[1]![1] as {
      messages: Array<{ content: Array<{ text: string }> }>;
    };
    expect(retryContext.messages[0]!.content[0]!.text).toContain(
      "RETRY CORRECTION",
    );
    expect(compactCalls[0]).toMatchObject({ summary: VALID_SUMMARY });
  });

  it("falls back to generation when a hook override is invalid", async () => {
    const { store, compactCalls } = createFakeStore();
    completeSimpleMock.mockResolvedValue({
      content: [{ type: "text", text: VALID_SUMMARY }],
      stopReason: "stop",
    });

    const result = await maybeCompactRuntimeThread({
      store,
      threadKey: "invalid-override",
      resolvedLlm: createRoute("auth-token"),
      agentType: "orchestrator",
      overrideSummary: "Compacted.",
    });

    expect(result).toEqual({ compacted: true });
    expect(completeSimpleMock).toHaveBeenCalledTimes(1);
    expect(compactCalls[0]).toMatchObject({ summary: VALID_SUMMARY });
  });

  it("validates Unicode content and rejects repetition, gibberish, and template echoes", () => {
    const zeroWidth = "\u200b".repeat(400);
    expect(validateThreadSummary(zeroWidth, 190_576)).toMatchObject({
      valid: false,
      visibleCodePoints: 0,
    });

    const repeated = THREAD_SUMMARY_HEADINGS_FOR_TEST.map(
      (heading) => `## ${heading}\n${"alpha ".repeat(80)}`,
    ).join("\n");
    expect(validateThreadSummary(repeated, 190_576)).toMatchObject({
      valid: false,
      reason: "extreme repetition",
    });

    const consonants = "bcdfghjklmnpqrstvwxz";
    const gibberishWord = (value: number) => {
      let remainder = value;
      let suffix = "";
      do {
        suffix = consonants[remainder % consonants.length] + suffix;
        remainder = Math.floor(remainder / consonants.length);
      } while (remainder > 0);
      return `qzx${suffix.padStart(4, "q")}`;
    };
    const gibberish = THREAD_SUMMARY_HEADINGS_FOR_TEST.map(
      (heading, sectionIndex) =>
        `## ${heading}\n${Array.from({ length: 16 }, (_, wordIndex) =>
          gibberishWord(sectionIndex * 16 + wordIndex),
        ).join(" ")}`,
    ).join("\n");
    expect(validateThreadSummary(gibberish, 190_576)).toMatchObject({
      valid: false,
      reason: "gibberish-like token distribution",
    });

    const boilerplate = [
      "## Topic",
      "[What the conversation is about]",
      "## Key Points",
      "Important information, decisions, and conclusions from the conversation",
      "## Current State",
      "Where things stand now — what has been done, what is in progress",
      "## Open Items",
      "Unresolved questions, pending tasks, or next steps discussed",
    ].join("\n");
    expect(validateThreadSummary(boilerplate, 190_576)).toMatchObject({
      valid: false,
      reason: "template boilerplate",
    });
  });

  it("rejects a summary that falls below the previous checkpoint floor", async () => {
    const { store, compactCalls } = createFakeStore(
      buildBigThreadMessagesWithCheckpoint(),
    );
    completeSimpleMock.mockResolvedValue({
      content: [{ type: "text", text: VALID_SUMMARY }],
      stopReason: "stop",
    });

    const result = await maybeCompactRuntimeThread({
      store,
      threadKey: "never-shrink",
      resolvedLlm: createRoute("auth-token"),
      agentType: "orchestrator",
    });

    expect(result).toEqual({ compacted: false });
    expect(completeSimpleMock).toHaveBeenCalledTimes(2);
    expect(compactCalls).toHaveLength(0);
    expect(
      validateThreadSummary(VALID_SUMMARY, 500, LONG_PREVIOUS_SUMMARY),
    ).toMatchObject({
      valid: false,
      reason: expect.stringContaining("never-shrink"),
    });
  });

  it("escalates after repeated failures only near the hard context limit", async () => {
    completeSimpleMock.mockResolvedValue({
      content: [{ type: "text", text: "## Topic\nStill truncated." }],
      stopReason: "stop",
    });

    const first = await maybeCompactRuntimeThread({
      store: createFakeStore(buildBigThreadMessagesWithCheckpoint()).store,
      threadKey: "hard-limit",
      resolvedLlm: createRoute("auth-token"),
      agentType: "orchestrator",
    });
    expect(first).toEqual({ compacted: false });

    const { store, compactCalls } = createFakeStore(
      buildBigThreadMessagesWithCheckpoint(),
    );
    const second = await maybeCompactRuntimeThread({
      store,
      threadKey: "hard-limit",
      resolvedLlm: createRoute("auth-token"),
      agentType: "orchestrator",
    });
    expect(second).toEqual({ compacted: true });
    const summary = String(compactCalls[0]!.summary);
    expect(summary).toMatch(
      /^\[compaction summary refresh failed \d{4}-\d{2}-\d{2}; state may lag\]/,
    );
    expect(summary).toContain("Awaiting the final review pass");
    expect(summary).not.toContain("Still truncated.");

    resetThreadSummaryFailureTracking();
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const headroom = createFakeStore();
      const result = await maybeCompactRuntimeThread({
        store: headroom.store,
        threadKey: "still-headroom",
        resolvedLlm: createRoute("auth-token", 200_000),
        agentType: "orchestrator",
      });
      expect(result).toEqual({ compacted: false });
      expect(headroom.compactCalls).toHaveLength(0);
    }
  });

  it("caps the summary input so an oversized backlog still compacts", async () => {
    const { store, compactCalls } = createFakeStore();
    completeSimpleMock.mockResolvedValue({
      content: [{ type: "text", text: VALID_SUMMARY }],
      stopReason: "stop",
    });

    const result = await maybeCompactRuntimeThread({
      store,
      threadKey: "conversation-1",
      resolvedLlm: createRoute("auth-token"),
      agentType: "orchestrator",
    });

    expect(result).toEqual({ compacted: true });
    expect(compactCalls).toHaveLength(1);
    expect(compactCalls[0]).toMatchObject({
      threadKey: "conversation-1",
      summary: VALID_SUMMARY,
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
      path.join(stellaDataDir, "memories", "memory_summary.md"),
      "Workflow tiers: tier-1 ships without review.",
    );
    try {
      const { store } = createFakeStore();
      completeSimpleMock.mockResolvedValue({
        content: [{ type: "text", text: VALID_SUMMARY }],
        stopReason: "stop",
      });

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
      expect(prompt).toContain("Do not restate durable memory");

      // Non-orchestrator agents don't get the docs injected per turn, so
      // their summaries must keep such facts: no reference, no omit rule.
      completeSimpleMock.mockClear();
      completeSimpleMock.mockResolvedValue({
        content: [{ type: "text", text: VALID_SUMMARY }],
        stopReason: "stop",
      });
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
