import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Compaction must just work: transient provider failures (429/overloaded/
// network/400) and credential blips are retried with backoff, hook override
// summaries are accepted verbatim, and an oversized backlog that cannot fit
// one summary request in the target model's window is capped to the window
// with an explicit elision note (the shrinking-model-switch case is handled
// up front by a blocking compaction on the outgoing route). A failed
// compaction is the rare terminal outcome, not the first response to one
// blip.

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
  setThreadSummaryRetryDelaysForTest,
} from "@stella/runtime/kernel/thread-runtime";
import { compactRuntimeThreadHistory } from "@stella/runtime/kernel/agent-runtime/thread-memory";
import { withForcedThreadCompaction } from "@stella/runtime/kernel/agent-runtime/context-budget";
import type { RuntimeStore } from "@stella/runtime/kernel/storage/runtime-store";
import type { ResolvedLlmRoute } from "@stella/runtime/kernel/model-routing";

// 5 attempts total: the first plus one per (zeroed-for-test) backoff delay.
const MAX_SUMMARY_ATTEMPTS = 5;

// ~10k chars per message; 60 messages ≈ 150k estimated tokens — far past the
// 100k trigger (0.5 x window) on a 200k window, and big enough that the raw
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

  it("caps an oversized backlog into one bounded summary request with an elision note", async () => {
    const { store, compactCalls } = createFakeStore();
    completeSimpleMock.mockResolvedValue(successResponse());

    const result = await maybeCompactRuntimeThread({
      store,
      threadKey: "oversized",
      resolvedLlm: createRoute(async () => "auth-token"),
      agentType: "orchestrator",
    });

    // The ~600k-char middle cannot fit one summary request in the 200k
    // window; the request is capped to the window's input budget, keeping the
    // most recent span and disclosing the elided oldest span, and exactly one
    // checkpoint overlay is written. (The shrinking-model-switch case that
    // used to need chunking is handled before the switch by a blocking
    // compaction on the outgoing larger-window route.)
    expect(result).toEqual({ compacted: true });
    expect(compactCalls).toHaveLength(1);
    expect(completeSimpleMock).toHaveBeenCalledTimes(1);

    const context = completeSimpleMock.mock.calls[0]![1] as {
      messages: Array<{ content: Array<{ text: string }> }>;
    };
    const prompt = context.messages[0]!.content[0]!.text;
    expect(prompt).toContain("[Compaction input truncated");
    // (200k window - 49,152 reserve) * 3 chars/token, plus scaffolding —
    // bounded by the single-pass ceiling instead of the raw middle size.
    expect(prompt.length).toBeLessThan(500_000);
    expect(compactCalls[0]).toMatchObject({ summary: SUMMARY_TEXT });
  });

  it("does not summarize persisted failed provider attempts", async () => {
    const messages = buildBigThreadMessages();
    messages[45] = {
      ...messages[45],
      content: "FAILED_ATTEMPT_MUST_NOT_REPLAY",
      payload: {
        role: "assistant",
        content: [{ type: "text", text: "FAILED_ATTEMPT_MUST_NOT_REPLAY" }],
        stopReason: "error",
      },
    };
    messages[46] = {
      ...messages[46],
      content: "EMPTY_RETRY_ATTEMPT_MUST_NOT_REPLAY",
      payload: {
        role: "assistant",
        content: [
          {
            type: "thinking",
            thinking: "EMPTY_RETRY_ATTEMPT_MUST_NOT_REPLAY",
          },
        ],
        stopReason: "stop",
      },
    };
    const { store } = createFakeStore(messages);
    completeSimpleMock.mockResolvedValue(successResponse());

    const result = await maybeCompactRuntimeThread({
      store,
      threadKey: "failed-attempt-filter",
      resolvedLlm: createRoute(async () => "auth-token"),
      agentType: "orchestrator",
    });

    expect(result).toEqual({ compacted: true });
    const context = completeSimpleMock.mock.calls[0]![1] as {
      messages: Array<{ content: Array<{ text: string }> }>;
    };
    expect(context.messages[0]!.content[0]!.text).not.toContain(
      "FAILED_ATTEMPT_MUST_NOT_REPLAY",
    );
    expect(context.messages[0]!.content[0]!.text).not.toContain(
      "EMPTY_RETRY_ATTEMPT_MUST_NOT_REPLAY",
    );
  });

  it("masks quarantined tool content and discards a suspect prior checkpoint", async () => {
    const rawMessages: Array<Record<string, unknown>> =
      buildBigThreadMessages();
    const messages = [...rawMessages];
    messages[44] = {
      ...messages[44],
      role: "assistant",
      content: formatThreadCheckpointMessage({
        summary: "OLD_CHECKPOINT_SUSPECT_MUST_NOT_REPLAY",
      }),
    };
    messages[45] = {
      ...messages[45],
      timestamp: 2_045,
      role: "toolResult",
      content: "QUARANTINED_RAW_CONTENT_MUST_NOT_REPLAY",
      toolCallId: "call-suspect",
      payload: {
        role: "toolResult",
        toolCallId: "call-suspect",
        toolName: "Read",
        content: [
          { type: "text", text: "QUARANTINED_RAW_CONTENT_MUST_NOT_REPLAY" },
        ],
        isError: false,
        timestamp: 2_045,
      },
    };
    messages[46] = {
      ...messages[46],
      timestamp: 2_046,
      role: "runtimeInternal",
      content: "quarantine record",
      customMessage: {
        customType: "containment.quarantine",
        content: JSON.stringify({
          key: "2045:call-suspect",
          toolName: "Read",
          timestamp: 2_045,
        }),
        display: false,
      },
    };
    rawMessages[45] = messages[45]!;
    rawMessages[46] = messages[46]!;
    messages.splice(45, 1);
    const { store, compactCalls } = createFakeStore(messages);
    (
      store as RuntimeStore & {
        loadRawThreadMessages: () => Array<Record<string, unknown>>;
      }
    ).loadRawThreadMessages = () => rawMessages;
    completeSimpleMock.mockResolvedValue(successResponse());

    const result = await maybeCompactRuntimeThread({
      store,
      threadKey: "quarantine-summary-filter",
      resolvedLlm: createRoute(async () => "auth-token"),
      agentType: "orchestrator",
      overrideSummary: "HOOK_SUMMARY_SUSPECT_MUST_NOT_REPLAY",
    });

    expect(result).toEqual({ compacted: true });
    const prompt = completeSimpleMock.mock.calls
      .map(
        (call) =>
          (call[1] as { messages: Array<{ content: Array<{ text: string }> }> })
            .messages[0]!.content[0]!.text,
      )
      .join("\n");
    expect(prompt).toContain("[content quarantined: triggered provider abort]");
    expect(prompt).not.toContain("QUARANTINED_RAW_CONTENT_MUST_NOT_REPLAY");
    expect(prompt).not.toContain("OLD_CHECKPOINT_SUSPECT_MUST_NOT_REPLAY");
    expect(prompt).not.toContain("quarantine record");
    expect(compactCalls[0]).toMatchObject({ summary: SUMMARY_TEXT });
    expect(compactCalls[0]).not.toMatchObject({
      summary: "HOOK_SUMMARY_SUSPECT_MUST_NOT_REPLAY",
    });
  });

  it("keeps a prior checkpoint when its quarantined result remains in the tail", async () => {
    const messages: Array<Record<string, unknown>> = buildBigThreadMessages();
    messages[44] = {
      ...messages[44],
      role: "assistant",
      content: formatThreadCheckpointMessage({
        summary: "SAFE_PRIOR_CHECKPOINT_MUST_SURVIVE",
      }),
    };
    messages[45] = {
      ...messages[45],
      timestamp: 2_045,
      role: "toolResult",
      content: "QUARANTINED_TAIL_CONTENT_MUST_NOT_REPLAY",
      toolCallId: "call-tail",
      payload: {
        role: "toolResult",
        toolCallId: "call-tail",
        toolName: "Read",
        content: [
          { type: "text", text: "QUARANTINED_TAIL_CONTENT_MUST_NOT_REPLAY" },
        ],
        isError: false,
        timestamp: 2_045,
      },
    };
    messages[46] = {
      ...messages[46],
      timestamp: 2_046,
      role: "runtimeInternal",
      content: "quarantine record",
      customMessage: {
        customType: "containment.quarantine",
        content: JSON.stringify({
          key: "2045:call-tail",
          toolName: "Read",
          timestamp: 2_045,
        }),
        display: false,
      },
    };
    const { store } = createFakeStore(messages);
    completeSimpleMock.mockResolvedValue(successResponse());

    const result = await maybeCompactRuntimeThread({
      store,
      threadKey: "quarantine-safe-checkpoint",
      resolvedLlm: createRoute(async () => "auth-token"),
      agentType: "orchestrator",
    });

    expect(result).toEqual({ compacted: true });
    const context = completeSimpleMock.mock.calls[0]![1] as {
      messages: Array<{ content: Array<{ text: string }> }>;
    };
    const prompt = context.messages[0]!.content[0]!.text;
    expect(prompt).toContain("SAFE_PRIOR_CHECKPOINT_MUST_SURVIVE");
    expect(prompt).toContain("[content quarantined: triggered provider abort]");
    expect(prompt).not.toContain("QUARANTINED_TAIL_CONTENT_MUST_NOT_REPLAY");
  });

  it("does not publish a summary when quarantine engages during generation", async () => {
    const messages: Array<Record<string, unknown>> = buildBigThreadMessages();
    messages[45] = {
      ...messages[45],
      timestamp: 2_045,
      role: "toolResult",
      content: "RESULT_QUARANTINED_WHILE_SUMMARIZING",
      toolCallId: "call-race",
      payload: {
        role: "toolResult",
        toolCallId: "call-race",
        toolName: "Read",
        content: [
          { type: "text", text: "RESULT_QUARANTINED_WHILE_SUMMARIZING" },
        ],
        isError: false,
        timestamp: 2_045,
      },
    };
    let currentMessages = messages;
    const compactCalls: Array<Record<string, unknown>> = [];
    const store = {
      loadThreadMessages: () => currentMessages,
      compactThread: (args: Record<string, unknown>) => compactCalls.push(args),
      updateThreadSummary: () => undefined,
    } as unknown as RuntimeStore;
    completeSimpleMock.mockImplementationOnce(async () => {
      currentMessages = [
        ...messages,
        {
          entryId: "late-quarantine",
          timestamp: 2_100,
          role: "runtimeInternal",
          content: "quarantine record",
          customMessage: {
            customType: "containment.quarantine",
            content: JSON.stringify({
              key: "2045:call-race",
              toolName: "Read",
              timestamp: 2_045,
            }),
            display: false,
          },
        },
      ];
      return successResponse();
    });

    const result = await maybeCompactRuntimeThread({
      store,
      threadKey: "quarantine-generation-race",
      resolvedLlm: createRoute(async () => "auth-token"),
      agentType: "orchestrator",
    });

    expect(result).toEqual({ compacted: false });
    expect(compactCalls).toHaveLength(0);
  });

  it("rebuilds a suspect checkpoint from raw history without dropping safe context", async () => {
    const rawMessages: Array<Record<string, unknown>> =
      buildFittingThreadMessages();
    rawMessages[2] = {
      ...rawMessages[2],
      content: "SAFE_PRECHECKPOINT_HISTORY_MUST_SURVIVE",
    };
    rawMessages[4] = {
      ...rawMessages[4],
      timestamp: 2_004,
      role: "assistant",
      content: "",
      payload: {
        role: "assistant",
        content: [
          { type: "toolCall", id: "call-suspect", name: "Read", arguments: {} },
        ],
        stopReason: "toolUse",
        timestamp: 2_004,
      },
    };
    rawMessages[5] = {
      ...rawMessages[5],
      timestamp: 2_005,
      role: "toolResult",
      content: "RAW_SUSPECT_MUST_BE_MASKED",
      toolCallId: "call-suspect",
      payload: {
        role: "toolResult",
        toolCallId: "call-suspect",
        toolName: "Read",
        content: [{ type: "text", text: "RAW_SUSPECT_MUST_BE_MASKED" }],
        isError: false,
        timestamp: 2_005,
      },
    };
    rawMessages[6] = {
      ...rawMessages[6],
      timestamp: 2_006,
      role: "runtimeInternal",
      content: "quarantine record",
      customMessage: {
        customType: "containment.quarantine",
        content: JSON.stringify({
          key: "2005:call-suspect",
          toolName: "Read",
          timestamp: 2_005,
        }),
        display: false,
      },
    };
    rawMessages[7] = { ...rawMessages[7], timestamp: 2_007 };
    const effectiveMessages = [
      {
        entryId: "old-checkpoint",
        timestamp: 1_500,
        role: "assistant",
        content: formatThreadCheckpointMessage({
          summary: "OLD_CHECKPOINT_SUSPECT_MUST_NOT_REPLAY",
        }),
      },
      // The effective checkpoint covered both the suspect result and its
      // machine-readable quarantine row. The append-only view must still drive
      // quarantine discovery after restart.
      ...rawMessages.slice(7),
    ];
    const compactCalls: Array<Record<string, unknown>> = [];
    const loadRawThreadMessages = vi.fn(() => rawMessages);
    const store = {
      loadThreadMessages: () => effectiveMessages,
      loadRawThreadMessages,
      compactThread: (args: Record<string, unknown>) => compactCalls.push(args),
      updateThreadSummary: () => undefined,
    } as unknown as RuntimeStore;
    completeSimpleMock.mockResolvedValue(successResponse());

    const result = await maybeCompactRuntimeThread({
      store,
      threadKey: "quarantine-raw-rebuild",
      resolvedLlm: createRoute(async () => "auth-token"),
      agentType: "orchestrator",
    });

    expect(result).toEqual({ compacted: true });
    expect(loadRawThreadMessages).toHaveBeenCalledWith(
      "quarantine-raw-rebuild",
    );
    expect(compactCalls[0]).toMatchObject({ fromEntryId: "entry-1" });
    const context = completeSimpleMock.mock.calls[0]![1] as {
      messages: Array<{ content: Array<{ text: string }> }>;
    };
    const prompt = context.messages[0]!.content[0]!.text;
    expect(prompt).toContain("SAFE_PRECHECKPOINT_HISTORY_MUST_SURVIVE");
    expect(prompt).toContain("[content quarantined: triggered provider abort]");
    expect(prompt).not.toContain("RAW_SUSPECT_MUST_BE_MASKED");
    expect(prompt).not.toContain("OLD_CHECKPOINT_SUSPECT_MUST_NOT_REPLAY");
  });

  it("rebuilds an oversized suspect checkpoint in masked chunks without eliding old safe history", async () => {
    const rawMessages: Array<Record<string, unknown>> =
      buildBigThreadMessages();
    rawMessages[2] = {
      ...rawMessages[2],
      content: "SAFE_OLD_HISTORY_MUST_REACH_THE_REBUILT_CHECKPOINT",
    };
    rawMessages[44] = {
      ...rawMessages[44],
      timestamp: 2_044,
      role: "assistant",
      content: "",
      payload: {
        role: "assistant",
        content: [
          { type: "toolCall", id: "call-chunked", name: "Read", arguments: {} },
        ],
        stopReason: "toolUse",
        timestamp: 2_044,
      },
    };
    rawMessages[45] = {
      ...rawMessages[45],
      timestamp: 2_045,
      role: "toolResult",
      content: "CHUNKED_RAW_SUSPECT_MUST_BE_MASKED",
      toolCallId: "call-chunked",
      payload: {
        role: "toolResult",
        toolCallId: "call-chunked",
        toolName: "Read",
        content: [{ type: "text", text: "CHUNKED_RAW_SUSPECT_MUST_BE_MASKED" }],
        isError: false,
        timestamp: 2_045,
      },
    };
    rawMessages[46] = {
      ...rawMessages[46],
      timestamp: 2_046,
      role: "runtimeInternal",
      content: "quarantine record",
      customMessage: {
        customType: "containment.quarantine",
        content: JSON.stringify({
          key: "2045:call-chunked",
          toolName: "Read",
          timestamp: 2_045,
        }),
        display: false,
      },
    };
    const effectiveMessages = [
      {
        entryId: "old-checkpoint",
        timestamp: 1_500,
        role: "assistant",
        content: formatThreadCheckpointMessage({
          summary: "CHUNKED_OLD_CHECKPOINT_MUST_NOT_REPLAY",
        }),
      },
      ...rawMessages.slice(47),
    ];
    const compactCalls: Array<Record<string, unknown>> = [];
    const store = {
      loadThreadMessages: () => effectiveMessages,
      loadRawThreadMessages: () => rawMessages,
      compactThread: (args: Record<string, unknown>) => compactCalls.push(args),
      updateThreadSummary: () => undefined,
    } as unknown as RuntimeStore;
    completeSimpleMock.mockImplementation(
      (
        _model: unknown,
        context: { messages: Array<{ content: Array<{ text: string }> }> },
      ) => {
        const prompt = context.messages[0]!.content[0]!.text;
        const safeHistory = prompt.includes(
          "SAFE_OLD_HISTORY_MUST_REACH_THE_REBUILT_CHECKPOINT",
        )
          ? " SAFE_OLD_HISTORY_MUST_REACH_THE_REBUILT_CHECKPOINT"
          : "";
        return {
          content: [{ type: "text", text: `${SUMMARY_TEXT}${safeHistory}` }],
          stopReason: "stop",
        };
      },
    );

    const result = await maybeCompactRuntimeThread({
      store,
      threadKey: "quarantine-chunked-raw-rebuild",
      resolvedLlm: createRoute(async () => "auth-token"),
      agentType: "orchestrator",
    });

    expect(result).toEqual({ compacted: true });
    expect(completeSimpleMock.mock.calls.length).toBeGreaterThan(1);
    const prompts = completeSimpleMock.mock.calls.map(
      (call) =>
        (call[1] as { messages: Array<{ content: Array<{ text: string }> }> })
          .messages[0]!.content[0]!.text,
    );
    expect(prompts.join("\n")).toContain(
      "SAFE_OLD_HISTORY_MUST_REACH_THE_REBUILT_CHECKPOINT",
    );
    expect(prompts.join("\n")).toContain(
      "[content quarantined: triggered provider abort]",
    );
    expect(prompts.join("\n")).not.toContain("[Compaction input truncated");
    expect(prompts.join("\n")).not.toContain(
      "CHUNKED_RAW_SUSPECT_MUST_BE_MASKED",
    );
    expect(prompts.join("\n")).not.toContain(
      "CHUNKED_OLD_CHECKPOINT_MUST_NOT_REPLAY",
    );
    expect(compactCalls[0]!.summary).toContain(
      "SAFE_OLD_HISTORY_MUST_REACH_THE_REBUILT_CHECKPOINT",
    );
    expect(compactCalls[0]!.details).toMatchObject({
      quarantinedToolResultKeys: ["2045:call-chunked"],
    });
  });

  it("reuses a rebuilt checkpoint whose internal metadata proves quarantine masking", async () => {
    const rawMessages: Array<Record<string, unknown>> =
      buildBigThreadMessages();
    rawMessages[2] = {
      ...rawMessages[2],
      content: "RAW_HISTORY_MUST_NOT_BE_REBUILT_AGAIN",
    };
    rawMessages[44] = {
      ...rawMessages[44],
      timestamp: 2_044,
      role: "toolResult",
      content: "ALREADY_MASKED_SUSPECT",
      toolCallId: "call-covered",
      payload: {
        role: "toolResult",
        toolCallId: "call-covered",
        toolName: "Read",
        content: [{ type: "text", text: "ALREADY_MASKED_SUSPECT" }],
        isError: false,
        timestamp: 2_044,
      },
    };
    rawMessages[45] = {
      ...rawMessages[45],
      timestamp: 2_045,
      role: "runtimeInternal",
      content: "quarantine record",
      customMessage: {
        customType: "containment.quarantine",
        content: JSON.stringify({
          key: "2044:call-covered",
          toolName: "Read",
          timestamp: 2_044,
        }),
        display: false,
      },
    };
    const effectiveMessages = [
      {
        entryId: "safe-checkpoint",
        timestamp: 2_100,
        role: "assistant",
        content: formatThreadCheckpointMessage({
          summary: "SAFE_REBUILT_CHECKPOINT",
        }),
        checkpointQuarantineKeys: ["2044:call-covered"],
      },
      ...rawMessages.slice(46),
    ];
    const compactCalls: Array<Record<string, unknown>> = [];
    const store = {
      loadThreadMessages: () => effectiveMessages,
      loadRawThreadMessages: () => rawMessages,
      compactThread: (args: Record<string, unknown>) => compactCalls.push(args),
      updateThreadSummary: () => undefined,
    } as unknown as RuntimeStore;
    completeSimpleMock.mockResolvedValue(successResponse());

    const result = await withForcedThreadCompaction(
      "quarantine-safe-checkpoint-reuse",
      () =>
        maybeCompactRuntimeThread({
          store,
          threadKey: "quarantine-safe-checkpoint-reuse",
          resolvedLlm: createRoute(async () => "auth-token"),
          agentType: "orchestrator",
        }),
    );

    expect(result).toEqual({ compacted: true });
    const prompts = completeSimpleMock.mock.calls.map(
      (call) =>
        (call[1] as { messages: Array<{ content: Array<{ text: string }> }> })
          .messages[0]!.content[0]!.text,
    );
    expect(prompts.join("\n")).toContain("SAFE_REBUILT_CHECKPOINT");
    expect(prompts.join("\n")).not.toContain(
      "RAW_HISTORY_MUST_NOT_BE_REBUILT_AGAIN",
    );
    expect(completeSimpleMock).toHaveBeenCalledTimes(1);
  });

  it("caps the request for a small-context target model so compaction still succeeds", async () => {
    // A large live thread compacted against a much smaller-context target
    // (e.g. a forced compaction where no larger-window route is available,
    // such as after a worker restart). The single pass caps its input to the
    // small window instead of overflowing it or hard-failing.
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
    expect(completeSimpleMock).toHaveBeenCalledTimes(1);
    const context = completeSimpleMock.mock.calls[0]![1] as {
      messages: Array<{ content: Array<{ text: string }> }>;
    };
    const prompt = context.messages[0]!.content[0]!.text;
    // 32k window → the input-budget floor keeps the request tiny but
    // well-defined (the reserve exceeds the window itself).
    expect(prompt).toContain("[Compaction input truncated");
    expect(prompt.length).toBeLessThan(120_000);
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
    expect(Number.isFinite(context.messages[0]!.content[0]!.text.length)).toBe(
      true,
    );
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

  it("excludes resident and roster messages from checkpoint prose without changing anchors", async () => {
    const messages = [
      {
        entryId: "m1",
        timestamp: 1,
        role: "runtimeInternal",
        content: "STALE_OTHER_THREADS_ROSTER",
        customMessage: {
          customType: "runtime.orchestrator_reminder",
          content: [{ type: "text", text: "STALE_OTHER_THREADS_ROSTER" }],
          display: false,
        },
      },
      {
        entryId: "m2",
        timestamp: 2,
        role: "runtimeInternal",
        content: "STALE_STARTUP_DOC_COPY",
        customMessage: {
          customType: "bootstrap.startup_doc",
          content: [{ type: "text", text: "STALE_STARTUP_DOC_COPY" }],
          display: false,
        },
      },
      {
        entryId: "m3",
        timestamp: 3,
        role: "runtimeInternal",
        content: "STALE_SKILLS_CATALOG",
        customMessage: {
          customType: "bootstrap.skills_catalog",
          content: [{ type: "text", text: "STALE_SKILLS_CATALOG" }],
          display: false,
        },
      },
      {
        entryId: "m4",
        timestamp: 4,
        role: "runtimeInternal",
        content: "STALE_CONTEXT_DELTA",
        customMessage: {
          customType: "runtime.context_delta.tools",
          content: [{ type: "text", text: "STALE_CONTEXT_DELTA" }],
          display: false,
        },
      },
      {
        entryId: "m5",
        timestamp: 5,
        role: "user",
        content: "ORDINARY_HISTORY_TO_SUMMARIZE",
      },
      {
        entryId: "m6",
        timestamp: 6,
        role: "assistant",
        content: "recent tail",
      },
    ];
    completeSimpleMock.mockResolvedValue(successResponse());
    const { store, compactCalls } = createFakeStore(messages);

    const result = await withForcedThreadCompaction("structural-filter", () =>
      maybeCompactRuntimeThread({
        store,
        threadKey: "structural-filter",
        resolvedLlm: createRoute(async () => "auth-token"),
        agentType: "general",
      }),
    );

    expect(result).toEqual({ compacted: true });
    const context = completeSimpleMock.mock.calls[0]![1] as {
      messages: Array<{ content: Array<{ type: string; text: string }> }>;
    };
    const prompt = context.messages[0]!.content[0]!.text;
    expect(prompt).toContain("ORDINARY_HISTORY_TO_SUMMARIZE");
    expect(prompt).not.toContain("STALE_OTHER_THREADS_ROSTER");
    expect(prompt).not.toContain("STALE_STARTUP_DOC_COPY");
    expect(prompt).not.toContain("STALE_SKILLS_CATALOG");
    expect(prompt).not.toContain("STALE_CONTEXT_DELTA");
    expect(compactCalls[0]).toMatchObject({
      fromEntryId: "m1",
      toEntryId: "m5",
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

  it("threads summary guidelines and the retained profile reference into the prompt", async () => {
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
      "LEGACY_RETIRED_SUMMARY",
    );
    fs.writeFileSync(
      path.join(stellaDataDir, "memories", "MEMORY.md"),
      "LEGACY_LEDGER_SENTINEL",
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
      expect(prompt).not.toContain("LEGACY_RETIRED_SUMMARY");
      expect(prompt).not.toContain("LEGACY_LEDGER_SENTINEL");
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
      expect(subagentPrompt).toContain("<conversation>");
      expect(subagentPrompt).toContain("## Goal");
      expect(subagentPrompt).toContain("thread_id");
      expect(subagentPrompt).not.toContain("ALREADY KNOWN");
      expect(subagentPrompt).not.toContain("123 Elm Street");
      expect(subagentPrompt).not.toContain("Do not restate durable memory");
      expect(subagentPrompt).not.toContain("CONVERSATION TO SUMMARIZE");
    } finally {
      fs.rmSync(stellaDataDir, { recursive: true, force: true });
    }
  });

  it("pins a buried follow-up instruction with bounded cost instead of an unbounded tail", async () => {
    // A follow-up user instruction buried deep in a huge middle (~145k
    // estimated tokens after it). The rejected design started the verbatim
    // tail AT that message, keeping ~145k tokens verbatim; the bounded design
    // summarizes the middle as usual, keeps only the token-budgeted recent
    // tail, and carries one capped verbatim copy of the instruction on the
    // overlay.
    const followUpText = `Follow-up task\n\nNow migrate the parser ${"y".repeat(30_000)}`;
    const messages = [
      { entryId: "entry-1", timestamp: 1_000, role: "user", content: "spawn" },
      {
        entryId: "entry-2",
        timestamp: 1_001,
        role: "assistant",
        content: "ok",
      },
      {
        entryId: "entry-3",
        timestamp: 1_002,
        role: "assistant",
        content: "ok",
      },
      {
        entryId: "entry-4",
        timestamp: 1_003,
        role: "user",
        content: followUpText,
      },
      ...Array.from({ length: 58 }, (_, index) => ({
        entryId: `entry-${index + 5}`,
        timestamp: 1_004 + index,
        role: "assistant",
        content: `work chunk ${index} ${"x".repeat(10_000)}`,
      })),
    ];
    const { store, compactCalls } = createFakeStore(messages);
    completeSimpleMock.mockResolvedValue(successResponse());

    const result = await maybeCompactRuntimeThread({
      store,
      threadKey: "buried-follow-up",
      resolvedLlm: createRoute(async () => "auth-token"),
      agentType: "orchestrator",
    });

    expect(result).toEqual({ compacted: true });
    expect(compactCalls).toHaveLength(1);
    const call = compactCalls[0]! as {
      fromEntryId: string;
      toEntryId: string;
      summary: string;
      details?: { pinnedUserInstruction?: { text: string } };
    };

    // The instruction was summarized into the middle...
    const fromIndex = messages.findIndex((m) => m.entryId === call.fromEntryId);
    const toIndex = messages.findIndex((m) => m.entryId === call.toEntryId);
    const followUpIndex = messages.findIndex((m) => m.entryId === "entry-4");
    expect(followUpIndex).toBeGreaterThanOrEqual(fromIndex);
    expect(followUpIndex).toBeLessThanOrEqual(toIndex);

    // ...and carried across the checkpoint as one capped pinned copy.
    const pinned = call.details?.pinnedUserInstruction?.text;
    expect(pinned).toBeDefined();
    expect(pinned).toContain("Follow-up task");
    expect(pinned).toContain("more characters truncated");
    expect(pinned!.length).toBeLessThan(12_100);

    // Boundedness proof: post-compaction size = summary + pinned copy +
    // token-budgeted tail — a fraction of the ~150k-token original, and the
    // verbatim tail alone obeys the ~20k keep-recent budget.
    const estimate = (text: string) => Math.ceil(text.length / 4);
    const tailTokens = messages
      .slice(toIndex + 1)
      .reduce((sum, m) => sum + estimate(m.content), 0);
    expect(tailTokens).toBeLessThanOrEqual(23_000);
    const afterTokens =
      estimate(call.summary) +
      estimate(pinned!) +
      tailTokens +
      messages.slice(0, fromIndex).reduce((s, m) => s + estimate(m.content), 0);
    expect(afterTokens).toBeLessThan(35_000);
  });

  it("pins an active-steer Task update turn and skips pinning when the instruction is already in the tail", async () => {
    const buildMessages = (latestUserAtTail: boolean) => [
      { entryId: "entry-1", timestamp: 1_000, role: "user", content: "spawn" },
      {
        entryId: "entry-2",
        timestamp: 1_001,
        role: "assistant",
        content: "ok",
      },
      {
        entryId: "entry-3",
        timestamp: 1_002,
        role: "assistant",
        content: "ok",
      },
      {
        entryId: "entry-4",
        timestamp: 1_003,
        role: "user",
        content: "Task update: focus on the failing suite only",
      },
      ...Array.from({ length: 48 }, (_, index) => ({
        entryId: `entry-${index + 5}`,
        timestamp: 1_004 + index,
        role: "assistant",
        content: `work chunk ${index} ${"x".repeat(10_000)}`,
      })),
      ...(latestUserAtTail
        ? [
            {
              entryId: "entry-tail-user",
              timestamp: 2_000,
              role: "user",
              content: "Task update: newest steer, still in the tail",
            },
          ]
        : []),
    ];
    completeSimpleMock.mockResolvedValue(successResponse());

    const buried = createFakeStore(buildMessages(false));
    await maybeCompactRuntimeThread({
      store: buried.store,
      threadKey: "task-update-buried",
      resolvedLlm: createRoute(async () => "auth-token"),
      agentType: "orchestrator",
    });
    expect(buried.compactCalls[0]).toMatchObject({
      details: {
        pinnedUserInstruction: {
          text: "Task update: focus on the failing suite only",
        },
      },
    });

    const inTail = createFakeStore(buildMessages(true));
    await maybeCompactRuntimeThread({
      store: inTail.store,
      threadKey: "task-update-in-tail",
      resolvedLlm: createRoute(async () => "auth-token"),
      agentType: "orchestrator",
    });
    const details = inTail.compactCalls[0]!.details as
      | { pinnedUserInstruction?: unknown }
      | undefined;
    expect(details?.pinnedUserInstruction).toBeUndefined();
  });

  it("does not spuriously compact when the effective context fits the target model's window", async () => {
    // Repro for the model-switch spurious-compaction bug. A conversation whose
    // effective (post-checkpoint) context comfortably fits the target model
    // must NOT trigger compaction. The trigger scales with the model's window,
    // so a fitting thread only compacts when the resolved window is wrong
    // (too small) — the measured size is the effective context, not an inflated
    // raw count.
    const effective = Array.from({ length: 20 }, (_, index) => ({
      entryId: `eff-${index + 1}`,
      timestamp: 1_000 + index,
      role: index % 2 === 0 ? "user" : "assistant",
      content: `turn ${index} ${"x".repeat(10_000)}`,
    })); // ~50k estimated tokens

    completeSimpleMock.mockResolvedValue(successResponse());

    // Real ~1M-window target: 0.5 x window dwarfs the ~50k effective size, so
    // nothing compacts and no summary request is made.
    const fits = await maybeCompactRuntimeThread({
      store: createFakeStore(effective).store,
      threadKey: "fits-large-window",
      resolvedLlm: createRoute(async () => "auth-token", 1_000_000),
      agentType: "orchestrator",
    });
    expect(fits).toEqual({ compacted: false });
    expect(completeSimpleMock).not.toHaveBeenCalled();

    // The very same thread on a wrongly-small window DOES cross the trigger —
    // proving the resolved window, not an inflated size count, is what decides.
    const { store, compactCalls } = createFakeStore(effective);
    const wrongSmallWindow = await maybeCompactRuntimeThread({
      store,
      threadKey: "fits-small-window",
      resolvedLlm: createRoute(async () => "auth-token", 60_000),
      agentType: "orchestrator",
    });
    expect(wrongSmallWindow).toEqual({ compacted: true });
    expect(compactCalls).toHaveLength(1);
    expect(completeSimpleMock).toHaveBeenCalled();
  });
});

describe("general/subagent compaction path", () => {
  beforeEach(() => {
    completeSimpleMock.mockReset();
    setThreadSummaryRetryDelaysForTest([0, 0, 0, 0]);
  });

  afterEach(() => {
    setThreadSummaryRetryDelaysForTest();
  });

  it("does not pin a buried latest user instruction for general agents", async () => {
    const followUpText = `Follow-up task\n\nNow migrate the parser ${"y".repeat(30_000)}`;
    const messages = [
      { entryId: "entry-1", timestamp: 1_000, role: "user", content: "spawn" },
      {
        entryId: "entry-2",
        timestamp: 1_001,
        role: "assistant",
        content: "ok",
      },
      {
        entryId: "entry-3",
        timestamp: 1_002,
        role: "assistant",
        content: "ok",
      },
      {
        entryId: "entry-4",
        timestamp: 1_003,
        role: "user",
        content: followUpText,
      },
      ...Array.from({ length: 58 }, (_, index) => ({
        entryId: `entry-${index + 5}`,
        timestamp: 1_004 + index,
        role: "assistant",
        content: `work chunk ${index} ${"x".repeat(10_000)}`,
      })),
    ];
    const { store, compactCalls } = createFakeStore(messages);
    completeSimpleMock.mockResolvedValue(successResponse());

    const result = await maybeCompactRuntimeThread({
      store,
      threadKey: "general-no-pin",
      resolvedLlm: createRoute(async () => "auth-token"),
      agentType: "general",
    });

    expect(result).toEqual({ compacted: true });
    const details = compactCalls[0]!.details as
      | { pinnedUserInstruction?: unknown }
      | undefined;
    expect(details?.pinnedUserInstruction).toBeUndefined();
  });

  it("uses the structured update prompt when a previous checkpoint exists", async () => {
    const messages = [
      { entryId: "h1", timestamp: 1, role: "user", content: "spawn" },
      { entryId: "h2", timestamp: 2, role: "assistant", content: "ok" },
      { entryId: "h3", timestamp: 3, role: "assistant", content: "ok" },
      {
        entryId: "checkpoint",
        timestamp: 4,
        role: "assistant",
        content: formatThreadCheckpointMessage({
          summary: "Earlier structured summary",
        }),
      },
      {
        entryId: "completed-user",
        timestamp: 5,
        role: "user",
        content: "continue the work",
      },
      ...Array.from({ length: 50 }, (_, index) => ({
        entryId: `mid-${index}`,
        timestamp: 6 + index,
        role: "assistant",
        content: `chunk ${index} ${"x".repeat(8_000)}`,
      })),
      {
        entryId: "tail-user",
        timestamp: 60,
        role: "user",
        content: "keep this recent turn",
      },
      ...Array.from({ length: 10 }, (_, index) => ({
        entryId: `tail-${index}`,
        timestamp: 61 + index,
        role: "assistant",
        content: `recent ${index} ${"x".repeat(8_000)}`,
      })),
    ];
    completeSimpleMock.mockResolvedValue(successResponse());
    const result = await maybeCompactRuntimeThread({
      store: createFakeStore(messages).store,
      threadKey: "general-update-prompt",
      resolvedLlm: createRoute(async () => "auth-token"),
      agentType: "general",
    });
    expect(result).toEqual({ compacted: true });

    const context = completeSimpleMock.mock.calls[0]![1] as {
      messages: Array<{ content: Array<{ type: string; text: string }> }>;
    };
    const prompt = context.messages[0]!.content[0]!.text;
    expect(prompt).toContain("<previous-summary>");
    expect(prompt).toContain("Earlier structured summary");
    expect(prompt).toContain("NEW conversation messages");
    expect(prompt).not.toContain("CONVERSATION TO SUMMARIZE");
  });

  it("summarizes a split-turn prefix separately from prior history", async () => {
    const messages = [
      { entryId: "h1", timestamp: 1, role: "user", content: "spawn" },
      { entryId: "h2", timestamp: 2, role: "assistant", content: "ok" },
      { entryId: "h3", timestamp: 3, role: "assistant", content: "ok" },
      {
        entryId: "older",
        timestamp: 4,
        role: "user",
        content: "older ask",
      },
      {
        entryId: "older-reply",
        timestamp: 5,
        role: "assistant",
        content: `older work ${"x".repeat(8_000)}`,
      },
      {
        entryId: "current-user",
        timestamp: 6,
        role: "user",
        content: "do the current task",
      },
      {
        entryId: "prefix",
        timestamp: 7,
        role: "assistant",
        content: `early progress ${"x".repeat(4_000)}`,
      },
      ...Array.from({ length: 12 }, (_, index) => ({
        entryId: `suffix-${index}`,
        timestamp: 8 + index,
        role: "assistant",
        content: `recent suffix ${index} ${"x".repeat(8_000)}`,
      })),
    ];
    completeSimpleMock.mockResolvedValue(successResponse());
    const { store, compactCalls } = createFakeStore(messages);
    const result = await withForcedThreadCompaction("general-split-turn", () =>
      maybeCompactRuntimeThread({
        store,
        threadKey: "general-split-turn",
        resolvedLlm: createRoute(async () => "auth-token"),
        agentType: "general",
      }),
    );

    expect(result).toEqual({ compacted: true });
    expect(completeSimpleMock.mock.calls.length).toBeGreaterThanOrEqual(2);
    const prompts = completeSimpleMock.mock.calls.map((call) => {
      const context = call[1] as {
        messages: Array<{ content: Array<{ type: string; text: string }> }>;
      };
      return context.messages[0]!.content[0]!.text;
    });
    expect(prompts.some((prompt) => prompt.includes("PREFIX of a turn"))).toBe(
      true,
    );
    expect(compactCalls[0]!.summary).toContain("Turn Context (split turn)");
  });

  it("still compacts on a tiny window without keeping an impossible 20k tail", async () => {
    const messages = [
      { entryId: "h1", timestamp: 1, role: "user", content: "spawn" },
      { entryId: "h2", timestamp: 2, role: "assistant", content: "ok" },
      { entryId: "h3", timestamp: 3, role: "assistant", content: "ok" },
      {
        entryId: "mid-user",
        timestamp: 4,
        role: "user",
        content: `middle ${"x".repeat(20_000)}`,
      },
      {
        entryId: "mid-assistant",
        timestamp: 5,
        role: "assistant",
        content: `more ${"x".repeat(20_000)}`,
      },
      {
        entryId: "tail-1",
        timestamp: 6,
        role: "assistant",
        content: `recent ${"x".repeat(12_000)}`,
      },
      {
        entryId: "tail-2",
        timestamp: 7,
        role: "assistant",
        content: `recent more ${"x".repeat(12_000)}`,
      },
    ];
    completeSimpleMock.mockResolvedValue(successResponse());
    const { store, compactCalls } = createFakeStore(messages);
    const result = await maybeCompactRuntimeThread({
      store,
      threadKey: "general-small-window",
      resolvedLlm: createRoute(async () => "auth-token", 16_000),
      agentType: "general",
    });

    expect(result).toEqual({ compacted: true });
    expect(compactCalls[0]).toMatchObject({
      fromEntryId: "mid-user",
      toEntryId: "mid-assistant",
    });
  });
});
