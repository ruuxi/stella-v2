import { beforeEach, describe, expect, it, vi } from "vitest";

const runCompactionWithHooksMock = vi.hoisted(() => vi.fn());

vi.mock("@stella/runtime/kernel/agent-runtime/run-completion.js", () => ({
  runCompactionWithHooks: (...args: unknown[]) =>
    runCompactionWithHooksMock(...args),
}));

import {
  isThreadCompactionForced,
  preflightProviderPayload,
} from "@stella/runtime/kernel/agent-runtime/context-budget.js";
import { executeWithContextOverflowRecovery } from "@stella/runtime/kernel/agent-runtime/context-overflow-recovery.js";
import { getCompactionTriggerTokens } from "@stella/runtime/kernel/thread-runtime";

const THREAD_KEY = "general-parent";

type StoredMessage = {
  entryId: string;
  timestamp: number;
  role: "user" | "assistant";
  content: string;
};

const storedUser = (content: string): StoredMessage => ({
  entryId: `${THREAD_KEY}-user`,
  timestamp: 1,
  role: "user",
  content,
});

const buildToolLoopPayload = (count: number) => ({
  input: Array.from({ length: count }, (_, index) => ({
    type: "tool_result",
    call_id: `call-${index}`,
    output: "x".repeat(2_865),
  })),
});

const createStore = (history: StoredMessage[]) => ({
  history: [...history],
  handoffs: [] as Array<Record<string, unknown>>,
  emergencyCompactions: [] as Array<Record<string, unknown>>,
  loadThreadMessages() {
    return [...this.history];
  },
  appendThreadCustomMessage(args: Record<string, unknown>) {
    this.handoffs.push(args);
  },
  compactThread(args: Record<string, unknown>) {
    this.emergencyCompactions.push(args);
  },
  updateThreadSummary: vi.fn(),
  listThreadActivity: () => [],
});

const createHarness = (args: {
  contextWindow?: number;
  execute: (resume?: boolean) => Promise<{
    finalText: string;
    errorMessage?: string;
  }>;
}) => {
  const store = createStore([storedUser("Compacted durable tail.")]);
  const agent = {
    state: {
      messages: [
        { role: "user", content: "Continue the task.", timestamp: 1 },
      ] as Array<Record<string, unknown>>,
    },
  };
  const notifyCompacted = vi.fn();
  const recordStatus = vi.fn(() => ({ type: "status" }));
  return {
    agent,
    store,
    notifyCompacted,
    run: () =>
      executeWithContextOverflowRecovery({
        execute: args.execute,
        agent,
        opts: {
          store,
          conversationId: "conversation-1",
          agentType: "general",
          resolvedLlm: {
            model: {
              provider: "fireworks",
              id: "deepseek-v4-flash-0731",
              contextWindow: args.contextWindow ?? 1_000_000,
            },
          },
          callbacks: { onStatus: vi.fn() },
        },
        threadKey: THREAD_KEY,
        runId: "run-general-parent",
        runEvents: { recordStatus },
        session: { notifyCompacted },
      }),
  };
};

describe("progress-aware context overflow recovery", () => {
  beforeEach(() => {
    runCompactionWithHooksMock.mockReset();
  });

  it("uses the real model window and a uniform 70% full-payload boundary", () => {
    expect(
      getCompactionTriggerTokens({
        model: { contextWindow: 1_000_000 },
      } as never),
    ).toBe(700_000);
    expect(
      getCompactionTriggerTokens({
        model: { contextWindow: 80_000 },
      } as never),
    ).toBe(56_000);

    expect(() =>
      preflightProviderPayload(
        THREAD_KEY,
        { input: "x".repeat(2_099_000) },
        { contextWindow: 1_000_000 },
      ),
    ).not.toThrow();
    expect(() =>
      preflightProviderPayload(
        THREAD_KEY,
        { input: "x".repeat(2_100_000) },
        { contextWindow: 1_000_000 },
      ),
    ).toThrow(/700000-token safe input budget/u);

    expect(() =>
      preflightProviderPayload(
        THREAD_KEY,
        { input: "x".repeat(167_000) },
        { contextWindow: 80_000 },
      ),
    ).not.toThrow();
    expect(() =>
      preflightProviderPayload(
        THREAD_KEY,
        { input: "x".repeat(168_000) },
        { contextWindow: 80_000 },
      ),
    ).toThrow(/56000-token safe input budget/u);
  });

  it("forces compaction, rebuilds durable history, and retries", async () => {
    runCompactionWithHooksMock.mockImplementation(
      async ({ threadKey }: { threadKey: string }) => {
        expect(isThreadCompactionForced(threadKey)).toBe(true);
        return { compacted: true };
      },
    );
    const execute = vi
      .fn<(resume?: boolean) => Promise<{ finalText: string }>>()
      .mockImplementationOnce(async () => {
        preflightProviderPayload(THREAD_KEY, buildToolLoopPayload(230), {
          contextWindow: 272_000,
        });
        return { finalText: "unreachable" };
      })
      .mockResolvedValueOnce({ finalText: "Recovered after compaction." });
    const harness = createHarness({ contextWindow: 272_000, execute });

    await expect(harness.run()).resolves.toEqual({
      finalText: "Recovered after compaction.",
    });
    expect(execute).toHaveBeenCalledTimes(2);
    expect(runCompactionWithHooksMock).toHaveBeenCalledOnce();
    expect(harness.notifyCompacted).toHaveBeenCalledOnce();
    expect(harness.store.handoffs).toHaveLength(0);
  });

  it("hands off when a compacted retry overflows without new progress", async () => {
    runCompactionWithHooksMock.mockResolvedValue({ compacted: true });
    const execute = vi.fn(async () => {
      preflightProviderPayload(THREAD_KEY, buildToolLoopPayload(230), {
        contextWindow: 272_000,
      });
      return { finalText: "unreachable" };
    });
    const harness = createHarness({ contextWindow: 272_000, execute });

    const result = await harness.run();

    expect(result.finalText).toContain(
      "the compacted retry overflowed again before any new model output or tool result",
    );
    expect(result.errorMessage).toContain(
      "Continuing queued messages in a clean General turn",
    );
    expect(execute).toHaveBeenCalledTimes(2);
    expect(runCompactionWithHooksMock).toHaveBeenCalledOnce();
    expect(harness.store.handoffs).toHaveLength(1);
    expect(harness.store.emergencyCompactions).toEqual([
      expect.objectContaining({
        threadKey: THREAD_KEY,
        fromEntryId: `${THREAD_KEY}-user`,
        toEntryId: `${THREAD_KEY}-user`,
        details: {
          kind: "context-overflow-recovery",
          runId: "run-general-parent",
        },
      }),
    ]);
    expect(harness.notifyCompacted).toHaveBeenCalledTimes(2);
  });

  it("compacts again after genuine tool progress refills the fallback window", async () => {
    runCompactionWithHooksMock.mockResolvedValue({ compacted: true });
    const execute = vi
      .fn<(resume?: boolean) => Promise<{ finalText: string }>>()
      .mockImplementationOnce(async () => {
        preflightProviderPayload(THREAD_KEY, buildToolLoopPayload(230), {
          contextWindow: 80_000,
        });
        return { finalText: "unreachable" };
      })
      .mockImplementationOnce(async () => {
        liveState.messages.push({
          role: "toolResult",
          toolCallId: "progress-call",
          content: [{ type: "text", text: "inspection complete" }],
          timestamp: 2,
        });
        preflightProviderPayload(THREAD_KEY, buildToolLoopPayload(230), {
          contextWindow: 80_000,
        });
        return { finalText: "unreachable" };
      })
      .mockResolvedValueOnce({
        finalText: "Recovered after the second compaction.",
      });
    const harness = createHarness({ contextWindow: 80_000, execute });
    const liveState = harness.agent.state;

    await expect(harness.run()).resolves.toEqual({
      finalText: "Recovered after the second compaction.",
    });
    expect(execute).toHaveBeenCalledTimes(3);
    expect(runCompactionWithHooksMock).toHaveBeenCalledTimes(2);
    expect(harness.notifyCompacted).toHaveBeenCalledTimes(2);
    expect(harness.store.handoffs).toHaveLength(0);
  });
});
