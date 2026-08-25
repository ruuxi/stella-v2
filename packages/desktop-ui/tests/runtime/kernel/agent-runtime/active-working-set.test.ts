import { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { BackgroundCompactionScheduler } from "@stella/runtime/kernel/agent-runtime/compaction-scheduler";
import { OrchestratorSession } from "@stella/runtime/kernel/agent-runtime/orchestrator-session";
import { PiSessionCore } from "@stella/runtime/kernel/agent-runtime/pi-session-core";
import {
  clearProviderContextWindow,
  preflightProviderPayload,
} from "@stella/runtime/kernel/agent-runtime/context-budget";
import { initializeDesktopDatabase } from "@stella/runtime/kernel/storage/database-init";
import { SessionStore } from "@stella/runtime/kernel/storage/session-store";
import type { SqliteDatabase } from "@stella/runtime/kernel/storage/shared";

const runCompactionWithHooks = vi.fn();

vi.mock("@stella/runtime/kernel/agent-runtime/run-completion.js", () => ({
  runCompactionWithHooks: (...args: unknown[]) =>
    runCompactionWithHooks(...args),
}));

const zeroUsage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    total: 0,
  },
};

const model = {
  id: "working-set-model",
  name: "Working set model",
  api: "openai-completions",
  provider: "test",
  baseUrl: "https://example.test",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 16_000,
  maxTokens: 1_000,
} as const;

const createSession = () => {
  const session = new PiSessionCore({
    loggerName: "active-working-set-test",
    promptCacheKey: "conversation-working-set",
    threadKey: "thread-working-set",
  });
  const agent = {
    state: {
      systemPrompt: "System prompt",
      tools: [],
      messages: [],
    },
    abort: vi.fn(),
  };
  (session as unknown as { agent: unknown }).agent = agent;
  return { session, agent };
};

const checkpointHistory = [
  {
    entryId: "checkpoint-1",
    role: "assistant",
    content: "[[THREAD_CHECKPOINT]]\n\nDurable summary",
    timestamp: 10,
  },
  {
    entryId: "assistant-tool-1",
    role: "assistant",
    content: "Read(src/file.ts)",
    timestamp: 11,
    payload: {
      role: "assistant",
      content: [
        {
          type: "toolCall",
          id: "call-1",
          name: "Read",
          arguments: { file_path: "src/file.ts" },
        },
      ],
      api: "openai-completions",
      provider: "test",
      model: model.id,
      usage: zeroUsage,
      stopReason: "toolUse",
      timestamp: 11,
    },
  },
  {
    entryId: "tool-result-1",
    role: "toolResult",
    content: "exact file contents",
    toolCallId: "call-1",
    timestamp: 12,
    payload: {
      role: "toolResult",
      toolCallId: "call-1",
      toolName: "Read",
      content: [{ type: "text", text: "exact file contents" }],
      isError: false,
      timestamp: 12,
    },
  },
];

const createArgs = (
  store: unknown,
  scheduler: BackgroundCompactionScheduler,
  signal?: AbortSignal,
) => ({
  opts: {
    store,
    compactionScheduler: scheduler,
    resolvedLlm: {
      model,
      route: "direct-provider",
      getApiKey: () => undefined,
    },
    agentType: "orchestrator",
    conversationId: "conversation-working-set",
    stellaDataDir: "/tmp/stella",
  },
  agentContext: {
    systemPrompt: "System prompt",
    dynamicContext: "",
    maxAgentDepth: 1,
    threadHistory: [],
  },
  runId: "run-working-set",
  signal,
  messages: [
    ...Array.from({ length: 50 }, (_, index) => ({
      role: "user" as const,
      content: `resident-${index}-${"x".repeat(1_000)}`,
      timestamp: index,
    })),
    checkpointHistory[1]!.payload,
    checkpointHistory[2]!.payload,
  ],
  completedMessages: [
    checkpointHistory[1]!.payload,
    {
      role: "toolResult" as const,
      toolCallId: "call-1",
      toolName: "Read",
      content: [{ type: "text" as const, text: "exact file contents" }],
      isError: false,
      timestamp: 12,
    },
  ],
});

describe("Pi active-turn working set", () => {
  beforeEach(() => {
    runCompactionWithHooks.mockReset();
    clearProviderContextWindow("thread-working-set");
  });

  it("pages in the exact checkpoint tail after durable compaction", async () => {
    const { session } = createSession();
    const scheduler = new BackgroundCompactionScheduler();
    const uncompacted = [
      {
        entryId: "old-1",
        role: "user",
        content: "x".repeat(40_000),
        timestamp: 1,
      },
    ];
    const loadThreadMessages = vi
      .fn()
      .mockReturnValueOnce(uncompacted)
      .mockReturnValueOnce(checkpointHistory);
    const store = { loadThreadMessages };
    runCompactionWithHooks.mockResolvedValue({ compacted: true });

    const refreshed = await session.refreshActiveWorkingSetAtBoundary(
      createArgs(store, scheduler),
    );

    expect(runCompactionWithHooks).toHaveBeenCalledOnce();
    expect(loadThreadMessages).toHaveBeenCalledTimes(2);
    expect(refreshed?.map((message) => message.role)).toEqual([
      "assistant",
      "assistant",
      "toolResult",
    ]);
    expect(refreshed?.[1]).toEqual(checkpointHistory[1]?.payload);
    expect(refreshed?.[2]).toEqual(checkpointHistory[2]?.payload);
    expect((refreshed?.[1] as { content: unknown[] }).content).toEqual([
      expect.objectContaining({ type: "toolCall", id: "call-1" }),
    ]);
    expect(refreshed?.[2]).toMatchObject({
      role: "toolResult",
      toolCallId: "call-1",
      content: [{ type: "text", text: "exact file contents" }],
    });
    session.dispose();
  });

  it("normalizes the persisted display default for durable runtime prompts", async () => {
    const { session } = createSession();
    const scheduler = new BackgroundCompactionScheduler();
    const residentRuntimePrompt = {
      role: "runtimeInternal" as const,
      content: [{ type: "text" as const, text: "Durable reminder" }],
      customType: "runtime.orchestrator_reminder",
      timestamp: 10.5,
    };
    const durableHistory = [
      checkpointHistory[0],
      {
        entryId: "durable-runtime-prompt",
        role: "runtimeInternal",
        content: "Durable reminder",
        timestamp: 10.5,
        customMessage: {
          customType: "runtime.orchestrator_reminder",
          content: [{ type: "text", text: "Durable reminder" }],
          display: false,
        },
      },
      checkpointHistory[1],
      checkpointHistory[2],
    ];
    const loadThreadMessages = vi
      .fn()
      .mockReturnValueOnce([
        {
          entryId: "old-1",
          role: "user",
          content: "x".repeat(40_000),
          timestamp: 1,
        },
      ])
      .mockReturnValueOnce(durableHistory);
    const args = createArgs(
      {
        loadThreadMessages,
        findLatestRangeCompaction: () => ({
          entry: { id: "checkpoint-1" },
        }),
      },
      scheduler,
    );
    args.messages.splice(-2, 0, residentRuntimePrompt);
    runCompactionWithHooks.mockResolvedValue({ compacted: true });

    const refreshed = await session.refreshActiveWorkingSetAtBoundary(args);

    expect(refreshed?.at(-3)).toMatchObject({
      role: "runtimeInternal",
      customType: "runtime.orchestrator_reminder",
      display: false,
    });
    session.dispose();
  });

  it("reconstructs the checkpoint tail from the real SQLite store", async () => {
    const db = new DatabaseSync(":memory:") as unknown as SqliteDatabase;
    initializeDesktopDatabase(db);
    const store = new SessionStore(db);
    const threadKey = "thread-working-set";
    for (let index = 0; index < 40; index += 1) {
      const content = `${index}:${"x".repeat(1_000)}`;
      store.appendThreadMessage({
        threadKey,
        timestamp: index + 1,
        role: "user",
        content,
        payload: { role: "user", content, timestamp: index + 1 },
      });
    }
    store.appendThreadMessage({
      threadKey,
      timestamp: 41,
      role: "assistant",
      content: "Read(src/file.ts)",
      payload: checkpointHistory[1]!.payload,
    });
    store.appendThreadMessage({
      threadKey,
      timestamp: 42,
      role: "toolResult",
      content: "exact file contents",
      toolCallId: "call-1",
      payload: checkpointHistory[2]!.payload,
    });
    runCompactionWithHooks.mockImplementationOnce(async () => {
      const durable = store.loadThreadMessages(threadKey);
      store.compactThread({
        threadKey,
        summary: "Durable active-turn checkpoint",
        fromEntryId: durable[0]!.entryId!,
        toEntryId: durable.at(-3)!.entryId!,
        tokensBefore: 10_000,
        timestamp: 100,
      });
      return { compacted: true };
    });

    const { session } = createSession();
    const args = createArgs(store, new BackgroundCompactionScheduler());
    const refreshed = await session.refreshActiveWorkingSetAtBoundary(args);

    expect(refreshed).toHaveLength(3);
    expect(refreshed?.[0]).toMatchObject({
      role: "assistant",
      content: [
        {
          type: "text",
          text: expect.stringContaining("Durable active-turn checkpoint"),
        },
      ],
    });
    expect(refreshed?.slice(1)).toEqual([
      checkpointHistory[1]!.payload,
      checkpointHistory[2]!.payload,
    ]);
    expect(args.agentContext.threadHistory).toHaveLength(3);

    session.dispose();
    db.close();
  });

  it("does not evict if compaction fails to write an overlay", async () => {
    const { session } = createSession();
    const scheduler = new BackgroundCompactionScheduler();
    const loadThreadMessages = vi.fn(() => [
      {
        entryId: "old-1",
        role: "user",
        content: "x".repeat(40_000),
        timestamp: 1,
      },
    ]);
    runCompactionWithHooks.mockResolvedValue({ compacted: false });

    const refreshed = await session.refreshActiveWorkingSetAtBoundary(
      createArgs({ loadThreadMessages }, scheduler),
    );

    expect(refreshed).toBeUndefined();
    expect(loadThreadMessages).toHaveBeenCalledOnce();
    session.dispose();
  });

  it("does not evict when SQLite reconstructed a truncated completed row", async () => {
    const { session } = createSession();
    const scheduler = new BackgroundCompactionScheduler();
    const truncatedHistory = structuredClone(checkpointHistory);
    const truncated = truncatedHistory[2]!.payload as {
      content: Array<{ type: "text"; text: string }>;
    };
    truncated.content[0]!.text =
      "This tool output was too large to persist in storage";
    const loadThreadMessages = vi
      .fn()
      .mockReturnValueOnce([
        {
          entryId: "old-1",
          role: "user",
          content: "x".repeat(40_000),
          timestamp: 1,
        },
      ])
      .mockReturnValueOnce(truncatedHistory);
    const args = createArgs({ loadThreadMessages }, scheduler);
    runCompactionWithHooks.mockResolvedValue({ compacted: true });

    const refreshed = await session.refreshActiveWorkingSetAtBoundary(args);

    expect(refreshed).toBeUndefined();
    expect(args.agentContext.threadHistory).toEqual([]);
    expect(
      (session as unknown as { pendingHistoryRefresh: boolean })
        .pendingHistoryRefresh,
    ).toBe(true);
    session.dispose();
  });

  it("does not summarize away the current abort-containment suspect tail", async () => {
    const { session } = createSession();
    const scheduler = new BackgroundCompactionScheduler();
    const loadThreadMessages = vi
      .fn()
      .mockReturnValueOnce([
        {
          entryId: "old-1",
          role: "user",
          content: "x".repeat(40_000),
          timestamp: 1,
        },
      ])
      .mockReturnValueOnce(checkpointHistory);
    const baseArgs = createArgs({ loadThreadMessages }, scheduler);
    const args = {
      ...baseArgs,
      requiredResidentSuffix: [
        {
          role: "toolResult" as const,
          toolCallId: "earlier-current-result",
          toolName: "Read",
          content: [{ type: "text" as const, text: "still suspect" }],
          isError: false,
          timestamp: 9,
        },
        ...baseArgs.completedMessages,
      ],
    };
    runCompactionWithHooks.mockResolvedValue({ compacted: true });

    const refreshed = await session.refreshActiveWorkingSetAtBoundary(args);

    expect(refreshed).toBeUndefined();
    expect(
      (session as unknown as { pendingHistoryRefresh: boolean })
        .pendingHistoryRefresh,
    ).toBe(true);
    session.dispose();
  });

  it("does not reintroduce a durable failed-retry row into the live agent", async () => {
    const { session } = createSession();
    const scheduler = new BackgroundCompactionScheduler();
    const failedRetry = {
      entryId: "failed-retry",
      role: "assistant",
      content: "provider failed",
      timestamp: 10,
      payload: {
        ...(checkpointHistory[1]!.payload as NonNullable<
          (typeof checkpointHistory)[number]["payload"]
        >),
        content: [{ type: "text", text: "provider failed" }],
        stopReason: "error",
        timestamp: 10,
      },
    };
    const durableHistory = [
      checkpointHistory[0],
      failedRetry,
      checkpointHistory[1],
      checkpointHistory[2],
    ];
    const loadThreadMessages = vi
      .fn()
      .mockReturnValueOnce([
        {
          entryId: "old-1",
          role: "user",
          content: "x".repeat(40_000),
          timestamp: 1,
        },
      ])
      .mockReturnValueOnce(durableHistory);
    const args = createArgs(
      {
        loadThreadMessages,
        findLatestRangeCompaction: () => ({
          entry: { id: "checkpoint-1" },
        }),
      },
      scheduler,
    );
    runCompactionWithHooks.mockResolvedValue({ compacted: true });

    const refreshed = await session.refreshActiveWorkingSetAtBoundary(args);

    expect(refreshed?.map((message) => message.role)).toEqual([
      "assistant",
      "assistant",
      "toolResult",
    ]);
    expect(JSON.stringify(refreshed)).not.toContain("provider failed");
    session.dispose();
  });

  it("counts a completed tool group before dispatching the next provider call", async () => {
    const { session } = createSession();
    const scheduler = new BackgroundCompactionScheduler();
    const loadThreadMessages = vi.fn();
    runCompactionWithHooks.mockResolvedValue({ compacted: true });
    preflightProviderPayload(
      "thread-working-set",
      { messages: [{ role: "user", content: "small" }] },
      model,
    );
    const args = createArgs({ loadThreadMessages }, scheduler);
    args.completedMessages = [
      {
        ...(checkpointHistory[1]!.payload as NonNullable<
          (typeof checkpointHistory)[number]["payload"]
        >),
        content: [
          {
            type: "toolCall",
            id: "large-call",
            name: "Read",
            arguments: { file_path: "src/large.ts" },
          },
        ],
      },
      {
        role: "toolResult",
        toolCallId: "large-call",
        toolName: "Read",
        content: [{ type: "text", text: "x".repeat(40_000) }],
        isError: false,
        timestamp: 20,
      },
    ];
    loadThreadMessages.mockReturnValue([
      checkpointHistory[0],
      {
        entryId: "large-assistant",
        role: "assistant",
        content: "Read(src/large.ts)",
        timestamp: 19,
        payload: args.completedMessages[0],
      },
      {
        entryId: "large-result",
        role: "toolResult",
        content: "x".repeat(40_000),
        toolCallId: "large-call",
        timestamp: 20,
        payload: args.completedMessages[1],
      },
    ]);

    const refreshed = await session.refreshActiveWorkingSetAtBoundary(args);

    expect(runCompactionWithHooks).toHaveBeenCalledOnce();
    expect(refreshed).toHaveLength(3);
    session.dispose();
  });

  it("does not page stale data into an agent disposed during compaction", async () => {
    const { session, agent } = createSession();
    const scheduler = new BackgroundCompactionScheduler();
    const loadThreadMessages = vi.fn(() => [
      {
        entryId: "old-1",
        role: "user",
        content: "x".repeat(40_000),
        timestamp: 1,
      },
    ]);
    let finishCompaction!: (value: { compacted: boolean }) => void;
    runCompactionWithHooks.mockImplementation(
      () =>
        new Promise<{ compacted: boolean }>((resolve) => {
          finishCompaction = resolve;
        }),
    );

    const refresh = session.refreshActiveWorkingSetAtBoundary(
      createArgs({ loadThreadMessages }, scheduler),
    );
    await vi.waitFor(() =>
      expect(runCompactionWithHooks).toHaveBeenCalledOnce(),
    );
    session.dispose();
    finishCompaction({ compacted: true });

    await expect(refresh).resolves.toBeUndefined();
    expect(agent.abort).toHaveBeenCalledOnce();
    expect(loadThreadMessages).toHaveBeenCalledOnce();
  });

  it("returns promptly on cancellation without abandoning the durable compaction", async () => {
    const { session } = createSession();
    const scheduler = new BackgroundCompactionScheduler();
    const controller = new AbortController();
    const loadThreadMessages = vi.fn(() => [
      {
        entryId: "old-1",
        role: "user",
        content: "x".repeat(40_000),
        timestamp: 1,
      },
    ]);
    let finishCompaction!: (value: { compacted: boolean }) => void;
    runCompactionWithHooks.mockImplementation(
      () =>
        new Promise<{ compacted: boolean }>((resolve) => {
          finishCompaction = resolve;
        }),
    );

    const refresh = session.refreshActiveWorkingSetAtBoundary(
      createArgs({ loadThreadMessages }, scheduler, controller.signal),
    );
    await vi.waitFor(() =>
      expect(runCompactionWithHooks).toHaveBeenCalledOnce(),
    );
    controller.abort();

    await expect(refresh).resolves.toBeUndefined();
    expect(loadThreadMessages).toHaveBeenCalledOnce();

    finishCompaction({ compacted: true });
    await scheduler.drain();
    session.dispose();
  });

  it("does not page in a steer that arrives while compaction is running", async () => {
    const { session } = createSession();
    const scheduler = new BackgroundCompactionScheduler();
    const loadThreadMessages = vi.fn(() => [
      {
        entryId: "queued-steer",
        role: "user",
        content: "queued while compacting",
        timestamp: 2,
      },
    ]);
    let finishCompaction!: (value: { compacted: boolean }) => void;
    runCompactionWithHooks.mockImplementation(
      () =>
        new Promise<{ compacted: boolean }>((resolve) => {
          finishCompaction = resolve;
        }),
    );
    const canApply = vi.fn(() => false);
    preflightProviderPayload(
      "thread-working-set",
      { messages: [{ role: "user", content: "small" }] },
      model,
    );
    const args = createArgs({ loadThreadMessages }, scheduler);
    args.completedMessages = [
      {
        role: "toolResult",
        toolCallId: "large-racing-call",
        toolName: "Read",
        content: [{ type: "text", text: "x".repeat(100_000) }],
        isError: false,
        timestamp: 20,
      },
    ];

    const refresh = session.refreshActiveWorkingSetAtBoundary({
      ...args,
      canApply,
    });
    await vi.waitFor(() =>
      expect(runCompactionWithHooks).toHaveBeenCalledOnce(),
    );
    finishCompaction({ compacted: true });

    await expect(refresh).resolves.toBeUndefined();
    expect(canApply).toHaveBeenCalledOnce();
    // The newly durable steer was never paged into the live context before
    // the agent loop could emit it exactly once.
    expect(loadThreadMessages).not.toHaveBeenCalled();
    expect(
      (session as unknown as { pendingHistoryRefresh: boolean })
        .pendingHistoryRefresh,
    ).toBe(true);
    session.dispose();
  });
});

describe("Orchestrator active-turn boundary integration", () => {
  const userMessages = (count: number) =>
    Array.from({ length: count }, (_, timestamp) => ({
      role: "user" as const,
      content: [{ type: "text" as const, text: `message-${timestamp}` }],
      timestamp,
    }));

  it("preserves the abort-containment tail across a page-in", async () => {
    const session = new OrchestratorSession("boundary-containment");
    const originalMessages = userMessages(20);
    const replacement = [
      ...userMessages(5),
      ...originalMessages.slice(18),
    ];
    const containmentTurn = {
      messagesBefore: 15,
      failureMessagesBefore: 15,
      newlyQuarantined: null,
    };
    const activeContext = {
      opts: {},
      agentContext: {},
      runId: "run-boundary",
      onCompacting: vi.fn(),
      containmentTurn,
      refreshBlocked: false,
    };
    (session as unknown as { agent: unknown }).agent = {
      state: { systemPrompt: "", tools: [], messages: [] },
      abort: vi.fn(),
      hasQueuedMessages: () => false,
    };
    (
      session as unknown as { currentActiveWorkingSetContext: unknown }
    ).currentActiveWorkingSetContext = activeContext;
    const refresh = vi
      .spyOn(session, "refreshActiveWorkingSetAtBoundary")
      .mockResolvedValueOnce(replacement)
      .mockResolvedValueOnce(undefined);

    await session.handleActiveTurnBoundary({
      context: {
        systemPrompt: "",
        messages: originalMessages,
        tools: [],
      },
      completedMessages: originalMessages.slice(18),
      pendingMessages: [],
    });

    // The successful provider boundary makes earlier turn messages safe, while
    // the newly produced group remains suspect across reconstruction.
    expect(containmentTurn.messagesBefore).toBe(5);
    expect(containmentTurn.failureMessagesBefore).toBe(replacement.length);
    expect(refresh).toHaveBeenCalledWith(
      expect.objectContaining({
        requiredResidentSuffix: originalMessages.slice(18),
      }),
    );

    const nextCompleted = userMessages(2).map((message, index) => ({
      ...message,
      timestamp: 20 + index,
    }));
    await session.handleActiveTurnBoundary({
      context: {
        systemPrompt: "",
        messages: [...replacement, ...nextCompleted],
        tools: [],
      },
      completedMessages: nextCompleted,
      pendingMessages: [],
    });

    // The next successfully completed provider call advances past the tail
    // preserved by page-in; its own newly completed group remains suspect.
    expect(containmentTurn.messagesBefore).toBe(replacement.length);
    expect(containmentTurn.failureMessagesBefore).toBe(
      replacement.length + nextCompleted.length,
    );
    session.dispose();
  });

  it("classifies a first-call abort after a successful tool group as instant", async () => {
    const session = new OrchestratorSession("boundary-containment-failure");
    const completedMessages: AgentMessage[] = [
      {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "suspect-call",
            name: "Read",
            arguments: {},
          },
        ],
        api: "openai-completions",
        provider: "test",
        model: "test",
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            total: 0,
          },
        },
        stopReason: "toolUse",
        timestamp: 10,
      },
      {
        role: "toolResult",
        toolCallId: "suspect-call",
        toolName: "Read",
        content: [{ type: "text", text: "suspect external content" }],
        isError: false,
        timestamp: 11,
      },
    ];
    const messages = [...userMessages(1), ...completedMessages];
    const containmentTurn = {
      messagesBefore: 1,
      failureMessagesBefore: 1,
      newlyQuarantined: null,
    };
    const agent = {
      state: { systemPrompt: "", tools: [], messages: [] as AgentMessage[] },
      abort: vi.fn(),
      hasQueuedMessages: () => false,
    };
    (session as unknown as { agent: unknown }).agent = agent;
    (
      session as unknown as { currentActiveWorkingSetContext: unknown }
    ).currentActiveWorkingSetContext = {
      opts: {},
      agentContext: {},
      runId: "run-boundary-failure",
      onCompacting: vi.fn(),
      containmentTurn,
      refreshBlocked: true,
    };

    await session.handleActiveTurnBoundary({
      context: { systemPrompt: "", messages, tools: [] },
      completedMessages,
      pendingMessages: [],
    });

    agent.state.messages = [
      ...messages,
      {
        role: "assistant",
        content: [],
        api: "openai-completions",
        provider: "test",
        model: "test",
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            total: 0,
          },
        },
        stopReason: "error",
        errorMessage:
          'Provider aborted the response (stop reason: "refusal").',
        timestamp: 12,
      },
    ];
    session.noteAbortContainmentFailure(agent as never, {
      messagesBefore: containmentTurn.messagesBefore,
      failureMessagesBefore: containmentTurn.failureMessagesBefore,
      errorMessage:
        'Provider aborted the response (stop reason: "refusal").',
    });

    expect(
      (
        session as unknown as {
          abortContainment: { consecutiveInstantAbortCount: number };
        }
      ).abortContainment.consecutiveInstantAbortCount,
    ).toBe(1);
    session.dispose();
  });

  it("defers page-in only until a live steer is consumed", async () => {
    const session = new OrchestratorSession("boundary-live-steer");
    const activeContext = {
      opts: {},
      agentContext: {},
      runId: "run-steer",
      onCompacting: vi.fn(),
      containmentTurn: { messagesBefore: 0, newlyQuarantined: null },
      refreshBlocked: false,
    };
    (session as unknown as { agent: unknown }).agent = {
      state: { systemPrompt: "", tools: [], messages: [] },
      abort: vi.fn(),
      hasQueuedMessages: () => false,
    };
    (
      session as unknown as { currentActiveWorkingSetContext: unknown }
    ).currentActiveWorkingSetContext = activeContext;
    const replacement = userMessages(1);
    const refresh = vi
      .spyOn(session, "refreshActiveWorkingSetAtBoundary")
      .mockResolvedValue(replacement);

    const result = await session.handleActiveTurnBoundary({
      context: { systemPrompt: "", messages: [], tools: [] },
      completedMessages: userMessages(1),
      pendingMessages: userMessages(1),
    });

    expect(result).toBeUndefined();
    expect(refresh).not.toHaveBeenCalled();
    expect(activeContext.refreshBlocked).toBe(false);

    const afterConsumption = await session.handleActiveTurnBoundary({
      context: { systemPrompt: "", messages: userMessages(2), tools: [] },
      completedMessages: userMessages(1),
      pendingMessages: [],
    });

    expect(refresh).toHaveBeenCalledTimes(1);
    expect(afterConsumption).toBe(replacement);
    session.dispose();
  });

  it("retains and blocks a live session after an unresolved persistence failure", async () => {
    const session = new OrchestratorSession("boundary-persistence-failure");
    (
      session as unknown as { hasUnresolvedThreadPersistenceFailure: boolean }
    ).hasUnresolvedThreadPersistenceFailure = true;

    await expect(session.runTurn({} as never)).rejects.toThrow(
      "Cannot continue this live session after an unresolved thread persistence failure.",
    );
    (
      session as unknown as {
        scheduleIdleEviction: () => void;
        idleEvictionTimer: ReturnType<typeof setTimeout> | null;
      }
    ).scheduleIdleEviction();
    expect(
      (session as unknown as { idleEvictionTimer: unknown }).idleEvictionTimer,
    ).toBeNull();

    (
      session as unknown as { hasUnresolvedThreadPersistenceFailure: boolean }
    ).hasUnresolvedThreadPersistenceFailure = false;
    session.dispose();
  });
});
