import { describe, expect, test } from "bun:test";
import {
  AGENT_PAUSE_CANCEL_REASON,
  LocalAgentManager,
  type LocalAgentContext,
} from "./local-agent-manager.js";

const context = { maxAgentDepth: 3 } as LocalAgentContext;

describe("LocalAgentManager cloud-owned computer lifecycle", () => {
  test("publishes the running attempt and its terminal result under one id", async () => {
    const starts: unknown[] = [];
    let settleTerminal!: (value: unknown) => void;
    const terminal = new Promise<unknown>((resolve) => {
      settleTerminal = resolve;
    });
    const manager = new LocalAgentManager({
      maxConcurrent: 1,
      fetchAgentContext: async () => context,
      runSubagent: async () => ({
        runId: "run-1",
        result: "Finished on this computer",
      }),
      toolExecutor: async () => ({ result: null }),
      createCloudAgentRecord: async (args) => {
        starts.push(args);
        return { agentId: args.agentId };
      },
      completeCloudAgentRecord: async (args) => {
        settleTerminal(args);
      },
      getCloudAgentRecord: async () => null,
      cancelCloudAgentRecord: async () => ({ canceled: false }),
    });

    const created = await manager.createAgent({
      threadId: "thread-7",
      conversationId: "conversation-1",
      description: "Inspect the workspace",
      prompt: "Inspect it",
      agentType: "manager",
      storageMode: "cloud",
    });

    expect(created.threadId).toBe("thread-7");
    expect(starts).toEqual([
      {
        agentId: "thread-7",
        conversationId: "conversation-1",
        description: "Inspect the workspace",
        prompt: "Inspect it",
        agentType: "manager",
        attemptGeneration: 1,
      },
    ]);
    expect(await terminal).toEqual({
      agentId: "thread-7",
      attemptGeneration: 1,
      status: "completed",
      result: "Finished on this computer",
      error: undefined,
    });
  });

  test("waits for publication before mirroring a local cancellation", async () => {
    let releaseStart!: () => void;
    const startGate = new Promise<void>((resolve) => {
      releaseStart = resolve;
    });
    const cancels: unknown[] = [];
    const manager = new LocalAgentManager({
      maxConcurrent: 1,
      fetchAgentContext: async () => context,
      runSubagent: async ({ abortSignal }) =>
        await new Promise((resolve) => {
          abortSignal.addEventListener(
            "abort",
            () =>
              resolve({
                runId: "run-1",
                result: "",
                interrupted: true,
              }),
            { once: true },
          );
        }),
      toolExecutor: async () => ({ result: null }),
      createCloudAgentRecord: async (args) => {
        await startGate;
        return { agentId: args.agentId };
      },
      completeCloudAgentRecord: async () => {},
      getCloudAgentRecord: async () => null,
      cancelCloudAgentRecord: async (...args) => {
        cancels.push(args);
        return { canceled: true };
      },
    });

    await manager.createAgent({
      threadId: "thread-8",
      conversationId: "conversation-1",
      description: "Inspect the workspace",
      prompt: "Inspect it",
      agentType: "manager",
      storageMode: "cloud",
    });
    const cancel = manager.cancelAgent("thread-8", AGENT_PAUSE_CANCEL_REASON);
    await Promise.resolve();
    expect(cancels).toEqual([]);
    releaseStart();
    await expect(cancel).resolves.toEqual({ canceled: true });
    expect(cancels).toEqual([["thread-8", AGENT_PAUSE_CANCEL_REASON, 1]]);
  });
});
