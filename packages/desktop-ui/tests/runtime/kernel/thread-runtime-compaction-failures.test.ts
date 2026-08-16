import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Compaction must just work: transient provider failures (429/overloaded/
// network/400) and credential blips are retried with backoff, hook override
// summaries are accepted verbatim, and an oversized backlog that cannot fit
// one summary request in the target model's window is compacted via parallel
// chunked summaries (so nothing is silently dropped and it never hard-fails)
// instead of a single truncated pass. A failed compaction is the rare
// terminal outcome, not the first response to one blip.

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
  maybeCompactRuntimeThread,
  setThreadSummaryRetryDelaysForTest,
} from "@stella/runtime/kernel/thread-runtime";
import { compactRuntimeThreadHistory } from "@stella/runtime/kernel/agent-runtime/thread-memory";
import { withForcedThreadCompaction } from "@stella/runtime/kernel/agent-runtime/context-budget";
import type { RuntimeStore } from "@stella/runtime/kernel/storage/runtime-store";
import type { ResolvedLlmRoute } from "@stella/runtime/kernel/model-routing";

// 5 attempts total: the first plus one per (zeroed-for-test) backoff delay.
const MAX_SUMMARY_ATTEMPTS = 5;

// ~10k chars per message; 60 messages ≈ 150k estimated tokens — far past the
// 140k orchestrator trigger on a 200k window, and big enough that the raw
// formatted middle exceeds the summarizer's input budget.
const buildBigThreadMessages = () =>
  Array.from({ length: 60 }, (_, index) => ({
    entryId: `entry-${index + 1}`,
    timestamp: 1_000 + index,
    role: index % 2 === 0 ? "user" : "assistant",
    content: `message ${index + 1} ${"x".repeat(10_000)}`,
  }));

// Small enough that the formatted middle fits one summary request in the 200k
// test window, so the retry/credential/store-write mechanics exercise the
// single-pass path. Run under forced compaction so the below-trigger size
// still compacts.
const buildFittingThreadMessages = () =>
  Array.from({ length: 8 }, (_, index) => ({
    entryId: `entry-${index + 1}`,
    timestamp: 1_000 + index,
    role: index % 2 === 0 ? "user" : "assistant",
    content: `message ${index + 1} ${"x".repeat(2_000)}`,
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
  getApiKey: () => Promise<string | null>,
  contextWindow = 200_000,
): ResolvedLlmRoute =>
  ({
    route: "stella",
    model: { id: "stella/max", contextWindow },
    getApiKey,
  }) as unknown as ResolvedLlmRoute;

const SUMMARY_TEXT =
  "The thread covered the compaction rework; retries with backoff now cover transient provider failures.";

const successResponse = () => ({
  content: [{ type: "text", text: SUMMARY_TEXT }],
  stopReason: "stop",
});

describe("orchestrator thread compaction failure handling", () => {
  beforeEach(() => {
    completeSimpleMock.mockReset();
    setThreadSummaryRetryDelaysForTest([0, 0, 0, 0]);
  });

  afterEach(() => {
    setThreadSummaryRetryDelaysForTest();
  });

  it("retries transient summary-LLM failures with backoff and recovers", async () => {
    const { store, compactCalls } = createFakeStore(
      buildFittingThreadMessages(),
    );
    completeSimpleMock
      .mockRejectedValueOnce(
        new Error(
          'upstream anthropic returned 400: "thinking.type.disabled" is not supported for this model.',
        ),
      )
      .mockResolvedValueOnce({
        content: [],
        stopReason: "error",
        errorMessage: "overloaded",
      })
      .mockResolvedValueOnce(successResponse());

    const result = await withForcedThreadCompaction("transient-retry", () =>
      maybeCompactRuntimeThread({
        store,
        threadKey: "transient-retry",
        resolvedLlm: createRoute(async () => "auth-token"),
        agentType: "orchestrator",
      }),
    );

    expect(result).toEqual({ compacted: true });
    expect(completeSimpleMock).toHaveBeenCalledTimes(3);
    expect(compactCalls[0]).toMatchObject({ summary: SUMMARY_TEXT });
  });

  it("reports compacted: false only after the full retry schedule is exhausted", async () => {
    const { store, compactCalls } = createFakeStore(
      buildFittingThreadMessages(),
    );
    completeSimpleMock.mockResolvedValue({
      content: [],
      stopReason: "error",
      errorMessage: "provider stream ended before a clean stop",
    });

    const result = await withForcedThreadCompaction("exhausted", () =>
      compactRuntimeThreadHistory({
        store,
        threadKey: "exhausted",
        resolvedLlm: createRoute(async () => "auth-token"),
        agentType: "orchestrator",
      }),
    );

    expect(result).toEqual({ compacted: false });
    expect(completeSimpleMock).toHaveBeenCalledTimes(MAX_SUMMARY_ATTEMPTS);
    expect(compactCalls).toHaveLength(0);
  });

  it("re-resolves the API key per attempt so a credential blip recovers", async () => {
    const { store, compactCalls } = createFakeStore(
      buildFittingThreadMessages(),
    );
    const getApiKey = vi
      .fn<() => Promise<string | null>>()
      .mockResolvedValueOnce(null)
      .mockResolvedValue("auth-token");
    completeSimpleMock.mockResolvedValue(successResponse());

    const result = await withForcedThreadCompaction("credential-blip", () =>
      maybeCompactRuntimeThread({
        store,
        threadKey: "credential-blip",
        resolvedLlm: createRoute(getApiKey),
        agentType: "orchestrator",
      }),
    );

    expect(result).toEqual({ compacted: true });
    expect(getApiKey).toHaveBeenCalledTimes(2);
    expect(completeSimpleMock).toHaveBeenCalledTimes(1);
    expect(compactCalls).toHaveLength(1);
  });

  it("fails without a checkpoint when no credential ever resolves", async () => {
    const { store, compactCalls } = createFakeStore();

    const result = await maybeCompactRuntimeThread({
      store,
      threadKey: "no-credential",
      resolvedLlm: createRoute(async () => null),
      agentType: "orchestrator",
    });

    expect(result).toEqual({ compacted: false });
    expect(completeSimpleMock).not.toHaveBeenCalled();
    expect(compactCalls).toHaveLength(0);
  });

  it("accepts a hook override summary verbatim without generation", async () => {
    const { store, compactCalls } = createFakeStore();

    const result = await maybeCompactRuntimeThread({
      store,
      threadKey: "hook-override",
      resolvedLlm: createRoute(async () => "auth-token"),
      agentType: "orchestrator",
      overrideSummary: "Compacted.",
    });

    expect(result).toEqual({ compacted: true });
    expect(completeSimpleMock).not.toHaveBeenCalled();
    expect(compactCalls[0]).toMatchObject({ summary: "Compacted." });
  });

  it("compacts an oversized backlog via parallel chunked summaries", async () => {
    const { store, compactCalls } = createFakeStore();
    completeSimpleMock.mockResolvedValue(successResponse());

    const result = await maybeCompactRuntimeThread({
      store,
      threadKey: "oversized",
      resolvedLlm: createRoute(async () => "auth-token"),
      agentType: "orchestrator",
    });

    // The ~600k-char middle cannot fit one summary request in the 200k window,
    // so compaction fans out into chunked segment summaries rather than
    // silently truncating the oldest history — and it still writes exactly one
    // checkpoint overlay.
    expect(result).toEqual({ compacted: true });
    expect(compactCalls).toHaveLength(1);
    expect(completeSimpleMock.mock.calls.length).toBeGreaterThan(1);

    // Every request stays bounded by the model's window (no single overflowing
    // request, no truncation-elision note).
    for (const call of completeSimpleMock.mock.calls) {
      const context = call[1] as {
        messages: Array<{ content: Array<{ text: string }> }>;
      };
      const prompt = context.messages[0]!.content[0]!.text;
      expect(prompt).not.toContain("[Compaction input truncated");
      // (200k window - 49,152 reserve) * 0.5 input fraction * 3 chars/token,
      // plus scaffolding — comfortably under the single-pass ceiling.
      expect(prompt.length).toBeLessThan(300_000);
      expect(prompt).toContain("segment");
    }

    // The mechanical combine concatenates the segment summaries in order under
    // "Part i/N" headings — no combiner LLM call, no lost span.
    const summary = compactCalls[0]!.summary as string;
    expect(summary).toContain("parallel segment summaries");
    expect(summary).toContain("## Part 1/");
    expect(summary).toContain(SUMMARY_TEXT);
  });

  it("chunks an over-budget thread for a small-context target model so compaction never hard-fails", async () => {
    // Reproduce the model-switch failure: a large live thread (built on a big
    // window) is compacted for a much smaller-context target (e.g. after
    // switching the active model). A single pass could not fit the transcript
    // into the target at all; chunked compaction fits every request and
    // succeeds instead of stranding the user with "compaction failed".
    const { store, compactCalls } = createFakeStore();
    completeSimpleMock.mockResolvedValue(successResponse());

    const smallWindow = 32_000;
    const result = await withForcedThreadCompaction("small-target", () =>
      maybeCompactRuntimeThread({
        store,
        threadKey: "small-target",
        resolvedLlm: createRoute(async () => "auth-token", smallWindow),
        agentType: "orchestrator",
      }),
    );

    expect(result).toEqual({ compacted: true });
    expect(compactCalls).toHaveLength(1);
    // Many small chunks for a tiny window, none overflowing it.
    expect(completeSimpleMock.mock.calls.length).toBeGreaterThan(3);
    for (const call of completeSimpleMock.mock.calls) {
      const context = call[1] as {
        messages: Array<{ content: Array<{ text: string }> }>;
      };
      const prompt = context.messages[0]!.content[0]!.text;
      // 32k window → tiny per-chunk request that fits with the completion
      // reserve; the min-chunk floor keeps it from degenerating to zero.
      expect(prompt.length).toBeLessThan(120_000);
    }
    const summary = compactCalls[0]!.summary as string;
    expect(summary).toContain(SUMMARY_TEXT);
  });

  it("resolves a valid context window (falls back to the default) when the target model reports no limit", async () => {
    // A model whose metadata lacks a context window must not make the sizing
    // math operate on undefined/NaN/0 — it falls back to the conservative
    // default so compaction still runs and succeeds.
    const { store, compactCalls } = createFakeStore(
      buildFittingThreadMessages(),
    );
    completeSimpleMock.mockResolvedValue(successResponse());

    const route = {
      route: "stella",
      model: { id: "mystery/model", contextWindow: undefined },
      getApiKey: async () => "auth-token",
    } as unknown as ResolvedLlmRoute;

    const result = await withForcedThreadCompaction("undefined-window", () =>
      maybeCompactRuntimeThread({
        store,
        threadKey: "undefined-window",
        resolvedLlm: route,
        agentType: "orchestrator",
      }),
    );

    expect(result).toEqual({ compacted: true });
    expect(compactCalls).toHaveLength(1);
    expect(completeSimpleMock).toHaveBeenCalled();
    const context = completeSimpleMock.mock.calls[0]![1] as {
      messages: Array<{ content: Array<{ text: string }> }>;
    };
    // Finite prompt built against the default window, not NaN-derived garbage.
    expect(
      Number.isFinite(context.messages[0]!.content[0]!.text.length),
    ).toBe(true);
  });

  it("relaxes the split under forced compaction when the standard cut fails", async () => {
    const bigMessage = "y".repeat(50_000);
    const messages = [
      { entryId: "m1", timestamp: 1, role: "user", content: bigMessage },
      { entryId: "m2", timestamp: 2, role: "assistant", content: bigMessage },
      { entryId: "m3", timestamp: 3, role: "user", content: bigMessage },
      { entryId: "m4", timestamp: 4, role: "user", content: "latest ask" },
    ];
    completeSimpleMock.mockResolvedValue(successResponse());

    // Below the trigger and unsplittable with the subagent head/tail
    // protection (4 messages <= 3 head + 2 tail): a routine compaction skips.
    const routine = await maybeCompactRuntimeThread({
      store: createFakeStore(messages).store,
      threadKey: "relaxed-split",
      resolvedLlm: createRoute(async () => "auth-token"),
      agentType: "general",
    });
    expect(routine).toEqual({ compacted: false });

    // Overflow recovery forces compaction; the relaxed split folds everything
    // but the last message instead of resetting the thread.
    const { store, compactCalls } = createFakeStore(messages);
    const forced = await withForcedThreadCompaction("relaxed-split", () =>
      maybeCompactRuntimeThread({
        store,
        threadKey: "relaxed-split",
        resolvedLlm: createRoute(async () => "auth-token"),
        agentType: "general",
      }),
    );
    expect(forced).toEqual({ compacted: true });
    expect(compactCalls[0]).toMatchObject({
      fromEntryId: "m1",
      toEntryId: "m3",
    });
  });

  it("retries a failed checkpoint store write", async () => {
    const compactCalls: Array<Record<string, unknown>> = [];
    let failures = 1;
    const store = {
      loadThreadMessages: () => buildFittingThreadMessages(),
      compactThread: (args: Record<string, unknown>) => {
        if (failures > 0) {
          failures -= 1;
          throw new Error("database is locked");
        }
        compactCalls.push(args);
      },
      updateThreadSummary: () => undefined,
    } as unknown as RuntimeStore;
    completeSimpleMock.mockResolvedValue(successResponse());

    const result = await withForcedThreadCompaction("store-write-retry", () =>
      maybeCompactRuntimeThread({
        store,
        threadKey: "store-write-retry",
        resolvedLlm: createRoute(async () => "auth-token"),
        agentType: "orchestrator",
      }),
    );

    expect(result).toEqual({ compacted: true });
    // The summary is generated once; only the store write is retried.
    expect(completeSimpleMock).toHaveBeenCalledTimes(1);
    expect(compactCalls).toHaveLength(1);
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
      completeSimpleMock.mockResolvedValue(successResponse());

      await maybeCompactRuntimeThread({
        store,
        threadKey: "conversation-1",
        resolvedLlm: createRoute(async () => "auth-token"),
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
      completeSimpleMock.mockResolvedValue(successResponse());
      await maybeCompactRuntimeThread({
        store: createFakeStore().store,
        threadKey: "conversation-2",
        resolvedLlm: createRoute(async () => "auth-token"),
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
});
