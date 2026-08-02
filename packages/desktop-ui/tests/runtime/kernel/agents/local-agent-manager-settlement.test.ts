import { describe, expect, it } from "vitest";

import { LocalAgentManager } from "@stella/runtime/kernel/agents/local-agent-manager";
import type { ToolResult } from "@stella/runtime/kernel/tools/types";

/**
 * Event-driven subagent settlement (phase 2 batch 4): blocking waiters wake
 * on the next persisted update instead of a fixed 250ms poll. SQLite stays
 * the only truth — the notifier is a pure wakeup and every wake re-reads
 * the record; the fallback timeout covers rehydrated records written by
 * out-of-band writers.
 */

const buildManager = (args: {
  runSubagent: (runArgs: { runId: string }) => Promise<{
    runId: string;
    result: string;
  }>;
}) =>
  new LocalAgentManager({
    maxConcurrent: 2,
    fetchAgentContext: async () => ({
      systemPrompt: "",
      dynamicContext: "",
      maxAgentDepth: 4,
    }),
    runSubagent: args.runSubagent as never,
    toolExecutor: async (): Promise<ToolResult> => ({ result: "unused" }),
    createCloudAgentRecord: async () => ({ agentId: "cloud-unused" }),
    completeCloudAgentRecord: async () => undefined,
    getCloudAgentRecord: async () => null,
    cancelCloudAgentRecord: async () => ({ canceled: false }),
  });

describe("local agent settlement wakeups", () => {
  it("wakes a blocked waiter on the terminal transition, well before the fallback", async () => {
    let releaseChild!: () => void;
    const childGate = new Promise<void>((resolve) => {
      releaseChild = resolve;
    });
    const manager = buildManager({
      runSubagent: async ({ runId }) => {
        await childGate;
        return { runId, result: "child-result" };
      },
    });

    const { threadId } = await manager.createAgent({
      agentType: "general",
      conversationId: "conv-settle",
      description: "Settle test",
      prompt: "do the thing",
      storageMode: "local",
    } as never);

    // Waiter parked with a fallback far larger than the test budget: only
    // the update notification can wake it in time.
    const waitStarted = Date.now();
    const wait = manager.waitForAgentUpdate(threadId, 60_000);
    releaseChild();
    await wait;
    expect(Date.now() - waitStarted).toBeLessThan(5_000);

    const snapshot = await manager.getAgent(threadId);
    expect(snapshot?.status).toBe("completed");
    expect(snapshot?.result).toBe("child-result");
  });

  it("falls back to the timeout when no update ever lands (rehydration safety)", async () => {
    const manager = buildManager({
      runSubagent: async ({ runId }) => ({ runId, result: "unused" }),
    });
    const startedAt = Date.now();
    await manager.waitForAgentUpdate("thread-that-never-updates", 40);
    const elapsed = Date.now() - startedAt;
    expect(elapsed).toBeGreaterThanOrEqual(30);
    expect(elapsed).toBeLessThan(2_000);
  });
});
