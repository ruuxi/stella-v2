import { describe, expect, test } from "bun:test";
import {
  AGENT_PAUSE_CANCEL_REASON,
  LocalAgentManager,
  type LocalAgentContext,
} from "./local-agent-manager.js";
import { CloudAgentStartAdmissionError } from "../runner/computer-agent-cloud-records.js";

const context = { maxAgentDepth: 3 } as LocalAgentContext;
const OWNER_GENERATION = "owner-generation-1";

const waitFor = async (predicate: () => boolean): Promise<void> => {
  const deadline = Date.now() + 2_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for condition.");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
};

describe("LocalAgentManager cloud-owned computer lifecycle", () => {
  test("replays an unadmitted terminal runtime receipt after restart exactly once", async () => {
    const terminalRecord = {
      threadId: "thread-restart-receipt",
      conversationId: "conversation-1",
      storageMode: "cloud",
      ownerGeneration: OWNER_GENERATION,
      agentType: "manager",
      description: "Recover the result",
      agentDepth: 1,
      status: "completed",
      attemptGeneration: 4,
      startedAt: 100,
      completedAt: 200,
      result: "Recovered result",
      updatedAt: 200,
    };
    const records = new Map<string, Record<string, any>>([
      [terminalRecord.threadId, terminalRecord],
    ]);
    const completions: unknown[] = [];

    new LocalAgentManager({
      maxConcurrent: 1,
      fetchAgentContext: async () => context,
      runSubagent: async () => ({ runId: "unused", result: "" }),
      toolExecutor: async () => ({ result: null }),
      saveAgentRecord: (record) => {
        records.set(record.threadId, { ...record });
      },
      getAgentRecord: (threadId) => records.get(threadId) ?? null,
      listAgentRecordsByStatus: (status) =>
        [...records.values()].filter((record) => record.status === status),
      completeCloudAgentRecord: async (args) => {
        completions.push(args);
      },
    });
    for (
      let index = 0;
      index < 10 &&
      records.get("thread-restart-receipt")
        ?.cloudTerminalReceiptGeneration !== 4;
      index += 1
    ) {
      await Promise.resolve();
    }

    expect(completions).toEqual([
      {
        agentId: "thread-restart-receipt",
        attemptGeneration: 4,
        ownerGeneration: OWNER_GENERATION,
        status: "completed",
        result: "Recovered result",
        error: undefined,
      },
    ]);
    expect(
      records.get("thread-restart-receipt")
        ?.cloudTerminalReceiptGeneration,
    ).toBe(4);

    completions.length = 0;
    new LocalAgentManager({
      maxConcurrent: 1,
      fetchAgentContext: async () => context,
      runSubagent: async () => ({ runId: "unused", result: "" }),
      toolExecutor: async () => ({ result: null }),
      saveAgentRecord: (record) => {
        records.set(record.threadId, { ...record });
      },
      getAgentRecord: (threadId) => records.get(threadId) ?? null,
      listAgentRecordsByStatus: (status) =>
        [...records.values()].filter((record) => record.status === status),
      completeCloudAgentRecord: async (args) => {
        completions.push(args);
      },
    });
    await Promise.resolve();
    expect(completions).toEqual([]);
  });

  test("admits the durable terminal receipt before lifecycle delivery and eviction", async () => {
    const records = new Map<string, Record<string, unknown>>();
    const order: string[] = [];
    let releaseReceipt!: () => void;
    const receiptGate = new Promise<void>((resolve) => {
      releaseReceipt = resolve;
    });
    const manager = new LocalAgentManager({
      maxConcurrent: 1,
      fetchAgentContext: async () => context,
      runSubagent: async () => ({
        runId: "run-receipt",
        result: "Durable result",
      }),
      toolExecutor: async () => ({ result: null }),
      saveAgentRecord: (record) => {
        records.set(record.threadId, { ...record });
      },
      getAgentRecord: (threadId) => records.get(threadId) ?? null,
      listAgentRecordsByStatus: (status) =>
        [...records.values()].filter((record) => record.status === status),
      createCloudAgentRecord: async (args) => ({ agentId: args.agentId }),
      completeCloudAgentRecord: async () => {
        order.push("receipt-started");
        await receiptGate;
        order.push("receipt-durable");
      },
      getCloudAgentRecord: async () => null,
      cancelCloudAgentRecord: async () => ({ canceled: false }),
      hasAgentLifecycleEvent: () => false,
      onAgentEvent: async (event) => {
        if (event.type === "agent-completed") {
          order.push("lifecycle-delivered");
        }
      },
    });

    await manager.createAgent({
      threadId: "thread-receipt",
      conversationId: "conversation-1",
      description: "Prove receipt ordering",
      prompt: "Finish",
      agentType: "manager",
      storageMode: "cloud",
      ownerGeneration: OWNER_GENERATION,
    });
    for (let index = 0; index < 10 && order.length === 0; index += 1) {
      await Promise.resolve();
    }
    expect(order).toEqual(["receipt-started"]);
    expect(manager.tasks.has("thread-receipt")).toBe(true);

    releaseReceipt();
    for (
      let index = 0;
      index < 10 && manager.tasks.has("thread-receipt");
      index += 1
    ) {
      await Promise.resolve();
    }
    expect(order).toEqual([
      "receipt-started",
      "receipt-durable",
      "lifecycle-delivered",
    ]);
    expect(manager.tasks.has("thread-receipt")).toBe(false);
    expect(records.get("thread-receipt")?.status).toBe("completed");
  });

  test("retains a failed terminal admission and replays it after restart", async () => {
    const records = new Map<string, Record<string, any>>();
    let admissionAttempts = 0;
    const options = {
      maxConcurrent: 1,
      fetchAgentContext: async () => context,
      runSubagent: async () => ({
        runId: "run-admission-failure",
        result: "Recover me",
      }),
      toolExecutor: async () => ({ result: null }),
      saveAgentRecord: (record: Record<string, any>) => {
        records.set(record.threadId, { ...record });
      },
      getAgentRecord: (threadId: string) => records.get(threadId) ?? null,
      listAgentRecordsByStatus: (status: string) =>
        [...records.values()].filter((record) => record.status === status),
      createCloudAgentRecord: async (args: { agentId: string }) => ({
        agentId: args.agentId,
      }),
      completeCloudAgentRecord: async () => {
        admissionAttempts += 1;
        if (admissionAttempts === 1) throw new Error("sqlite unavailable");
      },
      getCloudAgentRecord: async () => null,
      cancelCloudAgentRecord: async () => ({ canceled: false }),
    };
    const manager = new LocalAgentManager(options);

    await manager.createAgent({
      threadId: "thread-admission-failure",
      conversationId: "conversation-1",
      description: "Prove restart replay",
      prompt: "Finish",
      agentType: "manager",
      storageMode: "cloud",
      ownerGeneration: OWNER_GENERATION,
    });
    for (
      let index = 0;
      index < 20 && admissionAttempts === 0;
      index += 1
    ) {
      await Promise.resolve();
    }

    expect(admissionAttempts).toBe(1);
    expect(manager.tasks.has("thread-admission-failure")).toBe(true);
    expect(
      records.get("thread-admission-failure")
        ?.cloudTerminalReceiptGeneration,
    ).toBeUndefined();

    new LocalAgentManager(options);
    for (
      let index = 0;
      index < 10 &&
      records.get("thread-admission-failure")
        ?.cloudTerminalReceiptGeneration !== 1;
      index += 1
    ) {
      await Promise.resolve();
    }
    expect(admissionAttempts).toBe(2);
    expect(
      records.get("thread-admission-failure")
        ?.cloudTerminalReceiptGeneration,
    ).toBe(1);
  });

  test("never admits a terminal-only poison row when start admission fails", async () => {
    const records = new Map<string, Record<string, any>>();
    let allowStart = false;
    let startAttempts = 0;
    const terminals: unknown[] = [];
    const baseOptions = {
      maxConcurrent: 1,
      fetchAgentContext: async () => context,
      runSubagent: async () => ({ runId: "run-poison", result: "Done" }),
      toolExecutor: async () => ({ result: null }),
      saveAgentRecord: (record: Record<string, any>) => {
        records.set(record.threadId, { ...record });
      },
      getAgentRecord: (threadId: string) => records.get(threadId) ?? null,
      listAgentRecordsByStatus: (status: string) =>
        [...records.values()].filter((record) => record.status === status),
      createCloudAgentRecord: async (args: { agentId: string }) => {
        startAttempts += 1;
        if (!allowStart) {
          throw new CloudAgentStartAdmissionError({
            code: "COMPUTER_AGENT_START_ACK_PENDING",
            message: "outbox unavailable",
            retryable: true,
          });
        }
        return { agentId: args.agentId };
      },
      completeCloudAgentRecord: async (args: unknown) => {
        terminals.push(args);
      },
      getCloudAgentRecord: async () => null,
      cancelCloudAgentRecord: async () => ({ canceled: false }),
    };
    const manager = new LocalAgentManager(baseOptions);

    await manager.createAgent({
      threadId: "thread-start-poison",
      conversationId: "conversation-1",
      description: "Do not poison the outbox",
      prompt: "Finish",
      agentType: "manager",
      storageMode: "cloud",
      ownerGeneration: OWNER_GENERATION,
    });
    await waitFor(
      () =>
        startAttempts === 1 &&
        records.get("thread-start-poison")?.status === "error",
    );
    expect(startAttempts).toBe(1);
    expect(terminals).toEqual([]);
    expect(manager.tasks.has("thread-start-poison")).toBe(true);
    expect(
      records.get("thread-start-poison")?.cloudTerminalReceiptGeneration,
    ).toBeUndefined();

    allowStart = true;
    new LocalAgentManager(baseOptions);
    await waitFor(
      () =>
        records.get("thread-start-poison")
          ?.cloudTerminalReceiptGeneration === 1,
    );
    expect(terminals).toHaveLength(1);
    expect(
      records.get("thread-start-poison")?.cloudTerminalReceiptGeneration,
    ).toBe(1);
  });

  test("does not start a provider or tool before exact cloud start admission", async () => {
    let releaseStart!: () => void;
    const startGate = new Promise<void>((resolve) => {
      releaseStart = resolve;
    });
    let providerRuns = 0;
    let toolRuns = 0;
    const manager = new LocalAgentManager({
      maxConcurrent: 1,
      fetchAgentContext: async () => context,
      runSubagent: async (args) => {
        providerRuns += 1;
        await args.toolExecutor(
          "read",
          {},
          { conversationId: "conversation-1" },
          args.abortSignal,
        );
        return { runId: "run-after-admission", result: "Done" };
      },
      toolExecutor: async () => {
        toolRuns += 1;
        return { result: null };
      },
      createCloudAgentRecord: async (args) => {
        await startGate;
        return { agentId: args.agentId };
      },
      completeCloudAgentRecord: async () => {},
      getCloudAgentRecord: async () => null,
      cancelCloudAgentRecord: async () => ({ canceled: false }),
    });

    try {
      await manager.createAgent({
        threadId: "thread-pre-admission",
        conversationId: "conversation-1",
        description: "Wait for authority",
        prompt: "Read only after admission",
        agentType: "manager",
        storageMode: "cloud",
        ownerGeneration: OWNER_GENERATION,
      });
      await Promise.resolve();
      await Promise.resolve();
      expect(providerRuns).toBe(0);
      expect(toolRuns).toBe(0);

      releaseStart();
      await waitFor(() => providerRuns === 1 && toolRuns === 1);
    } finally {
      releaseStart();
      await manager.shutdown();
    }
  });

  test("keeps rejected generation send_input and lost-response retries out of providers", async () => {
    const starts: Array<{ attemptGeneration: number; ownerGeneration?: string }> = [];
    const terminals: unknown[] = [];
    let providerRuns = 0;
    let toolRuns = 0;
    const lifecycleEvents: Array<{
      type: string;
      audience?: string;
      attemptGeneration?: number;
    }> = [];
    const manager = new LocalAgentManager({
      maxConcurrent: 1,
      fetchAgentContext: async () => context,
      runSubagent: async (args) => {
        providerRuns += 1;
        await args.toolExecutor(
          "read",
          {},
          { conversationId: "conversation-1" },
          args.abortSignal,
        );
        return { runId: "must-not-run", result: "unsafe" };
      },
      toolExecutor: async () => {
        toolRuns += 1;
        return { result: null };
      },
      createCloudAgentRecord: async (args) => {
        starts.push({
          attemptGeneration: args.attemptGeneration,
          ownerGeneration: args.ownerGeneration,
        });
        throw new CloudAgentStartAdmissionError({
          code: "OWNER_DATA_GENERATION_STALE",
          message: "OWNER_DATA_GENERATION_STALE",
          retryable: false,
        });
      },
      completeCloudAgentRecord: async (args) => {
        terminals.push(args);
      },
      getCloudAgentRecord: async () => null,
      cancelCloudAgentRecord: async () => ({ canceled: false }),
      onAgentEvent: async (event) => {
        lifecycleEvents.push(event);
      },
    });

    try {
      await manager.createAgent({
        threadId: "thread-stale-generation",
        conversationId: "conversation-1",
        description: "Reject the stale generation",
        prompt: "Do not execute",
        agentType: "manager",
        storageMode: "cloud",
        ownerGeneration: OWNER_GENERATION,
      });
      await waitFor(
        () =>
          starts.length === 1 &&
          lifecycleEvents.some((event) => event.type === "agent-failed"),
      );
      expect(providerRuns).toBe(0);
      expect(toolRuns).toBe(0);
      expect(terminals).toEqual([]);
      expect(
        lifecycleEvents.filter((event) => event.type === "agent-failed"),
      ).toEqual([
        expect.objectContaining({
          audience: "display-only",
          attemptGeneration: 1,
        }),
      ]);

      await expect(
        manager.sendAgentMessage(
          "thread-stale-generation",
          "Try the stale thread again",
          "orchestrator",
        ),
      ).resolves.toEqual({ delivered: true });
      await waitFor(
        () =>
          starts.length === 2 &&
          lifecycleEvents.filter((event) => event.type === "agent-failed")
            .length === 2,
      );
      expect(providerRuns).toBe(0);
      expect(toolRuns).toBe(0);
      expect(terminals).toEqual([]);
      expect(starts.every((entry) => entry.ownerGeneration === OWNER_GENERATION)).toBe(
        true,
      );
      const attemptGenerations = starts.map(
        (entry) => entry.attemptGeneration,
      );
      expect(attemptGenerations[0]).toBe(1);
      expect(attemptGenerations[1]).toBeGreaterThan(
        attemptGenerations[0] ?? 0,
      );
      expect(
        lifecycleEvents
          .filter((event) => event.type === "agent-failed")
          .map((event) => event.audience),
      ).toEqual(["display-only", "display-only"]);
    } finally {
      await manager.shutdown();
    }
  });

  test("replays a failed local terminal wake after restart", async () => {
    const records = new Map<string, Record<string, any>>();
    const delivered: string[] = [];
    let failDelivery = true;
    const options = {
      maxConcurrent: 1,
      fetchAgentContext: async () => context,
      runSubagent: async () => ({
        runId: "run-local-replay",
        result: "Local result",
      }),
      toolExecutor: async () => ({ result: null }),
      saveAgentRecord: (record: Record<string, any>) => {
        records.set(record.threadId, { ...record });
      },
      getAgentRecord: (threadId: string) => records.get(threadId) ?? null,
      listAgentRecordsByStatus: (status: string) =>
        [...records.values()].filter((record) => record.status === status),
      hasAgentLifecycleEvent: () => false,
      onAgentEvent: async (event: { type: string; eventId?: string }) => {
        if (event.type !== "agent-completed") return;
        if (failDelivery) throw new Error("transcript unavailable");
        delivered.push(event.eventId ?? "");
      },
    };
    const manager = new LocalAgentManager(options);

    await manager.createAgent({
      threadId: "thread-local-replay",
      conversationId: "conversation-1",
      description: "Replay the wake",
      prompt: "Finish",
      agentType: "manager",
      storageMode: "local",
    });
    for (
      let index = 0;
      index < 20 &&
      records.get("thread-local-replay")?.status !== "completed";
      index += 1
    ) {
      await Promise.resolve();
    }
    expect(manager.tasks.has("thread-local-replay")).toBe(true);
    expect(
      records.get("thread-local-replay")
        ?.terminalLifecycleReceiptGeneration,
    ).toBeUndefined();

    failDelivery = false;
    new LocalAgentManager(options);
    for (
      let index = 0;
      index < 20 &&
      records.get("thread-local-replay")
        ?.terminalLifecycleReceiptGeneration !== 1;
      index += 1
    ) {
      await Promise.resolve();
    }
    expect(delivered).toEqual([
      "thread-local-replay:1:agent-completed",
    ]);
    expect(
      records.get("thread-local-replay")
        ?.terminalLifecycleReceiptGeneration,
    ).toBe(1);
  });

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
      ownerGeneration: OWNER_GENERATION,
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
        ownerGeneration: OWNER_GENERATION,
      },
    ]);
    expect(await terminal).toEqual({
      agentId: "thread-7",
      attemptGeneration: 1,
      ownerGeneration: OWNER_GENERATION,
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
      ownerGeneration: OWNER_GENERATION,
    });
    const cancel = manager.cancelAgent("thread-8", AGENT_PAUSE_CANCEL_REASON);
    await Promise.resolve();
    expect(cancels).toEqual([]);
    releaseStart();
    await expect(cancel).resolves.toEqual({ canceled: true });
    expect(cancels).toEqual([
      ["thread-8", AGENT_PAUSE_CANCEL_REASON, 1, OWNER_GENERATION],
    ]);
  });

  test("keeps a stale cancel fenced from a concurrently resumed generation", async () => {
    let releaseStart!: () => void;
    const startGate = new Promise<void>((resolve) => {
      releaseStart = resolve;
    });
    let releaseRun!: (value: unknown) => void;
    const runGate = new Promise<unknown>((resolve) => {
      releaseRun = resolve;
    });
    const records = new Map<string, Record<string, any>>();
    const cancels: unknown[] = [];
    const terminalEvents: string[] = [];
    const manager = new LocalAgentManager({
      maxConcurrent: 1,
      fetchAgentContext: async () => context,
      runSubagent: async () => await runGate,
      toolExecutor: async () => ({ result: null }),
      saveAgentRecord: (record) => {
        records.set(record.threadId, { ...record });
      },
      getAgentRecord: (threadId) => records.get(threadId) ?? null,
      listAgentRecordsByStatus: (status) =>
        [...records.values()].filter((record) => record.status === status),
      createCloudAgentRecord: async (args) => {
        if (args.attemptGeneration === 1) await startGate;
        return { agentId: args.agentId };
      },
      completeCloudAgentRecord: async () => {},
      getCloudAgentRecord: async () => null,
      cancelCloudAgentRecord: async (...args) => {
        cancels.push(args);
        return { canceled: true };
      },
      onAgentEvent: async (event) => {
        if (event.type === "agent-canceled") {
          terminalEvents.push(event.eventId ?? "");
        }
      },
    });

    await manager.createAgent({
      threadId: "thread-cancel-race",
      conversationId: "conversation-1",
      description: "Fence the cancel",
      prompt: "Wait",
      agentType: "manager",
      storageMode: "cloud",
      ownerGeneration: OWNER_GENERATION,
    });
    const cancel = manager.cancelAgent(
      "thread-cancel-race",
      AGENT_PAUSE_CANCEL_REASON,
    );
    await Promise.resolve();
    await manager.sendAgentMessage(
      "thread-cancel-race",
      "Continue with the next attempt",
      "orchestrator",
    );
    releaseStart();
    await expect(cancel).resolves.toEqual({ canceled: true });

    expect(cancels).toEqual([
      [
        "thread-cancel-race",
        AGENT_PAUSE_CANCEL_REASON,
        1,
        OWNER_GENERATION,
      ],
    ]);
    expect(terminalEvents).toEqual([
      `thread-cancel-race:${OWNER_GENERATION}:1:agent-canceled`,
    ]);
    const successor = manager.tasks.get("thread-cancel-race");
    expect(successor?.attemptGeneration).toBeGreaterThan(1);
    expect(successor?.terminalEventEmitted).toBe(false);
    expect(successor?.cloudTerminalReceiptGeneration).toBeUndefined();

    releaseRun({ runId: "run-stale", result: "", interrupted: true });
  });
});
