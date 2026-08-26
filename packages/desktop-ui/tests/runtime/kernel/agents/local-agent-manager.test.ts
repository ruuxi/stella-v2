import { describe, expect, it, vi } from "vitest";

import {
  AGENT_ORPHANED_RESTART_CANCEL_REASON,
  LocalAgentManager,
  sanitizeTaskToolArgsHint,
} from "@stella/runtime/kernel/agents/local-agent-manager";
import type { AgentLifecycleEvent } from "@stella/runtime/kernel/agents/local-agent-manager";
import { AGENT_IDS } from "@stella/contracts/agent-runtime";
import {
  createStateContext,
  handleSendInput,
} from "@stella/runtime/kernel/tools/state";
import type {
  ToolContext,
  ToolResult,
} from "@stella/runtime/kernel/tools/types";
import {
  __privateTaskDecorationStore,
  clearTaskDecoration,
  decorateTask,
  getTaskDecoration,
} from "@/features/chat/streaming/task-decoration-store";
import { waitForAgentSettled } from "../../../helpers/agent.js";

const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

describe("task tool activity sanitization", () => {
  it("redacts environment and credential values before renderer delivery", () => {
    const hint = sanitizeTaskToolArgsHint({
      cmd: "OPENAI_API_KEY=sk-secret curl --token top-secret https://example.com?access_token=url-secret",
      env: { PUBLIC_MODE: "debug", PRIVATE_VALUE: "hidden" },
      password: "also-hidden",
    });

    expect(hint).toContain("OPENAI_API_KEY=[REDACTED]");
    expect(hint).toContain("--token [REDACTED]");
    expect(hint).toContain("access_token=[REDACTED]");
    expect(hint).not.toContain("sk-secret");
    expect(hint).not.toContain("top-secret");
    expect(hint).not.toContain("url-secret");
    expect(hint).not.toContain("debug");
    expect(hint).not.toContain("hidden");
  });
});

describe("LocalAgentManager lifecycle observability", () => {
  it("emits lifecycle events without unconditional stderr traces", async () => {
    const stderrWrite = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);
    const events: AgentLifecycleEvent[] = [];
    try {
      const manager = new LocalAgentManager({
        maxConcurrent: 1,
        fetchAgentContext: async () => ({
          systemPrompt: "",
          dynamicContext: "",
          maxAgentDepth: 3,
        }),
        runSubagent: async (args) => {
          args.onToolStart?.({
            runId: args.runId,
            seq: 1,
            toolCallId: "call-1",
            toolName: "node_repl",
            statusText: "Running Node Repl",
          });
          args.onToolEnd?.({
            runId: args.runId,
            seq: 2,
            toolCallId: "call-1",
            toolName: "node_repl",
            resultPreview: "ok",
          });
          return { runId: args.runId, result: "done" };
        },
        toolExecutor: async (): Promise<ToolResult> => ({ result: "unused" }),
        createCloudAgentRecord: async () => ({ agentId: "cloud-unused" }),
        completeCloudAgentRecord: async () => undefined,
        getCloudAgentRecord: async () => null,
        cancelCloudAgentRecord: async () => ({ canceled: false }),
        onAgentEvent: (event) => events.push(event),
      });

      const created = await manager.createAgent({
        conversationId: "conv-observability",
        description: "trace-free task",
        prompt: "run a tool",
        agentType: AGENT_IDS.GENERAL,
        storageMode: "local",
      });
      await waitForAgentSettled(manager, created.threadId);

      expect(events.map((event) => event.type)).toEqual(
        expect.arrayContaining([
          "agent-started",
          "agent-progress",
          "agent-completed",
        ]),
      );
      expect(stderrWrite).not.toHaveBeenCalled();
    } finally {
      stderrWrite.mockRestore();
    }
  });

  it("evicts completed task payloads after SQLite persistence", async () => {
    const executionRoots: Array<string | undefined> = [];
    let persisted:
      | Parameters<
          NonNullable<
            ConstructorParameters<typeof LocalAgentManager>[0]["saveAgentRecord"]
          >
        >[0]
      | null = null;
    const manager = new LocalAgentManager({
      maxConcurrent: 1,
      fetchAgentContext: async () => ({
        systemPrompt: "",
        dynamicContext: "",
        maxAgentDepth: 3,
      }),
      runSubagent: async (args) => {
        executionRoots.push(args.toolWorkspaceRoot);
        return {
          runId: args.runId,
          result: "x".repeat(50_000),
        };
      },
      toolExecutor: async (): Promise<ToolResult> => ({ result: "unused" }),
      createCloudAgentRecord: async () => ({ agentId: "cloud-unused" }),
      completeCloudAgentRecord: async () => undefined,
      getCloudAgentRecord: async () => null,
      cancelCloudAgentRecord: async () => ({ canceled: false }),
      saveAgentRecord: (record) => {
        persisted = record;
      },
      getAgentRecord: (threadId) =>
        persisted?.threadId === threadId ? persisted : null,
    });

    const created = await manager.createAgent({
      conversationId: "eviction",
      description: "large result",
      prompt: "finish",
      agentType: AGENT_IDS.GENERAL,
      storageMode: "local",
      toolWorkspaceRoot: "/tmp/stella-workspace",
    });
    await waitForAgentSettled(manager, created.threadId);

    expect((manager as unknown as { tasks: Map<string, unknown> }).tasks.size).toBe(
      0,
    );
    expect(persisted).toMatchObject({
      status: "completed",
      result: expect.stringMatching(/^x+$/),
      toolWorkspaceRoot: "/tmp/stella-workspace",
    });
    await manager.sendAgentMessage(
      created.threadId,
      "continue in the same workspace",
      "orchestrator",
    );
    await waitForAgentSettled(manager, created.threadId);
    expect(executionRoots).toEqual([
      "/tmp/stella-workspace",
      "/tmp/stella-workspace",
    ]);
  });

  it("takes over an abort-ignoring attempt after durable cancellation and rehydration", async () => {
    type AgentRecord = Parameters<
      NonNullable<
        ConstructorParameters<typeof LocalAgentManager>[0]["saveAgentRecord"]
      >
    >[0];
    const persisted = new Map<string, AgentRecord>();
    let runCount = 0;
    let firstRunStarted: (() => void) | null = null;
    const firstRunStartedPromise = new Promise<void>((resolve) => {
      firstRunStarted = resolve;
    });
    let settleFirstRun: (() => void) | null = null;
    const settleFirstRunPromise = new Promise<void>((resolve) => {
      settleFirstRun = resolve;
    });

    const manager = new LocalAgentManager({
      maxConcurrent: 1,
      attemptTeardownTimeoutMs: 10,
      fetchAgentContext: async () => ({
        systemPrompt: "",
        dynamicContext: "",
        maxAgentDepth: 3,
      }),
      runSubagent: async (args) => {
        runCount += 1;
        if (runCount === 1) {
          firstRunStarted?.();
          await settleFirstRunPromise;
          return { runId: args.runId, result: "stale result" };
        }
        return { runId: args.runId, result: "resumed" };
      },
      toolExecutor: async (): Promise<ToolResult> => ({ result: "unused" }),
      createCloudAgentRecord: async () => ({ agentId: "cloud-unused" }),
      completeCloudAgentRecord: async () => undefined,
      getCloudAgentRecord: async () => null,
      cancelCloudAgentRecord: async () => ({ canceled: false }),
      saveAgentRecord: (record) => {
        persisted.set(record.threadId, record);
      },
      getAgentRecord: (threadId) => persisted.get(threadId) ?? null,
    });

    const created = await manager.createAgent({
      conversationId: "abort-ignoring-eviction",
      description: "hung task",
      prompt: "wait forever",
      agentType: AGENT_IDS.GENERAL,
      storageMode: "local",
    });
    await firstRunStartedPromise;
    await manager.cancelAgent(created.threadId, "Canceled for regression test");

    expect((manager as unknown as { tasks: Map<string, unknown> }).tasks.size).toBe(
      0,
    );
    const unrelated = await manager.createAgent({
      conversationId: "abort-ignoring-eviction",
      description: "unrelated task",
      prompt: "must not remain blocked",
      agentType: AGENT_IDS.GENERAL,
      storageMode: "local",
    });
    await waitForAgentSettled(manager, unrelated.threadId);
    expect(runCount).toBe(2);
    await expect(
      manager.sendAgentMessage(
        created.threadId,
        "continue after cancellation",
        "orchestrator",
      ),
    ).resolves.toEqual({ delivered: true });

    await waitForAgentSettled(manager, created.threadId);
    expect(runCount).toBe(3);
    await expect(manager.getAgent(created.threadId)).resolves.toMatchObject({
      status: "completed",
      result: "resumed",
    });
    settleFirstRun?.();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(persisted.get(created.threadId)).toMatchObject({
      status: "completed",
      result: "resumed",
    });
  });
});

describe("LocalAgentManager Exec fs locking", () => {
  it("cancels persisted running agents left behind by a previous worker", () => {
    const savedRecords: Parameters<
      NonNullable<
        ConstructorParameters<typeof LocalAgentManager>[0]["saveAgentRecord"]
      >
    >[0][] = [];
    const lifecycleEvents: AgentLifecycleEvent[] = [];

    new LocalAgentManager({
      maxConcurrent: 1,
      fetchAgentContext: async () => ({
        systemPrompt: "",
        dynamicContext: "",
        maxAgentDepth: 3,
      }),
      runSubagent: async (args) => ({
        runId: args.runId,
        result: "unused",
      }),
      toolExecutor: async (): Promise<ToolResult> => ({ result: "unused" }),
      createCloudAgentRecord: async () => ({ agentId: "cloud-unused" }),
      completeCloudAgentRecord: async () => undefined,
      getCloudAgentRecord: async () => null,
      cancelCloudAgentRecord: async () => ({ canceled: false }),
      listAgentRecordsByStatus: (status) =>
        status === "running"
          ? [
              {
                threadId: "task-8",
                conversationId: "conv-1",
                agentType: "general",
                description: "stale agent task",
                agentDepth: 0,
                status: "running",
                startedAt: 123,
                completedAt: null,
                updatedAt: 456,
              },
              {
                threadId: "task-9",
                conversationId: "conv-1",
                agentType: "general",
                description: "second stale agent task",
                agentDepth: 0,
                status: "running",
                startedAt: 234,
                completedAt: null,
                updatedAt: 567,
              },
            ]
          : [],
      saveAgentRecord: (record) => {
        savedRecords.push(record);
      },
      onAgentEvent: (event) => {
        lifecycleEvents.push(event);
      },
    });

    expect(savedRecords).toHaveLength(2);
    expect(savedRecords).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          threadId: "task-8",
          status: "canceled",
          completedAt: expect.any(Number),
          error: AGENT_ORPHANED_RESTART_CANCEL_REASON,
        }),
        expect.objectContaining({
          threadId: "task-9",
          status: "canceled",
          completedAt: expect.any(Number),
          error: AGENT_ORPHANED_RESTART_CANCEL_REASON,
        }),
      ]),
    );
    expect(lifecycleEvents).toEqual([
      expect.objectContaining({
        type: "agent-canceled",
        conversationId: "conv-1",
        agentId: "task-8",
        error: AGENT_ORPHANED_RESTART_CANCEL_REASON,
        audience: "display-only",
      }),
      expect.objectContaining({
        type: "agent-canceled",
        conversationId: "conv-1",
        agentId: "task-9",
        error: AGENT_ORPHANED_RESTART_CANCEL_REASON,
        audience: "display-only",
      }),
    ]);
  });

  it("emits completed terminal events with the agent result and file changes", async () => {
    const events: AgentLifecycleEvent[] = [];
    const manager = new LocalAgentManager({
      maxConcurrent: 1,
      fetchAgentContext: async () => ({
        systemPrompt: "",
        dynamicContext: "",
        maxAgentDepth: 3,
      }),
      runSubagent: async (args) => ({
        runId: args.runId,
        result: "Agent finished the delegated work.",
        fileChanges: [
          {
            path: "/repo/src/agent-change.ts",
            kind: { type: "update" },
          },
        ],
      }),
      toolExecutor: async (): Promise<ToolResult> => ({ result: "unused" }),
      onAgentEvent: (event) => {
        events.push(event);
      },
      createCloudAgentRecord: async () => ({ agentId: "cloud-unused" }),
      completeCloudAgentRecord: async () => undefined,
      getCloudAgentRecord: async () => null,
      cancelCloudAgentRecord: async () => ({ canceled: false }),
    });

    const task = await manager.createAgent({
      conversationId: "conv-1",
      description: "agent task",
      prompt: "do agent work",
      agentType: "general",
      storageMode: "local",
    });

    await waitForAgentSettled(manager, task.threadId);

    expect(events).toContainEqual(
      expect.objectContaining({
        type: "agent-completed",
        conversationId: "conv-1",
        agentId: task.threadId,
        agentType: "general",
        description: "agent task",
        result: "Agent finished the delegated work.",
        fileChanges: [
          {
            path: "/repo/src/agent-change.ts",
            kind: { type: "update" },
          },
        ],
      }),
    );
  });

  it("threads per-spawn model and engine selections into the agent context fetch", async () => {
    const contextFetches: Array<Record<string, unknown>> = [];
    const manager = new LocalAgentManager({
      maxConcurrent: 1,
      fetchAgentContext: async (args) => {
        contextFetches.push({
          agentType: args.agentType,
          model: args.model,
          spawnEngine: args.spawnEngine,
          spawnReasoningEffort: args.spawnReasoningEffort,
        });
        return {
          systemPrompt: "",
          dynamicContext: "",
          maxAgentDepth: 3,
        };
      },
      runSubagent: async (args) => ({
        runId: args.runId,
        result: "done",
      }),
      toolExecutor: async (): Promise<ToolResult> => ({ result: "unused" }),
      createCloudAgentRecord: async () => ({ agentId: "cloud-unused" }),
      completeCloudAgentRecord: async () => undefined,
      getCloudAgentRecord: async () => null,
      cancelCloudAgentRecord: async () => ({ canceled: false }),
    });

    const modelTask = await manager.createAgent({
      conversationId: "conv-1",
      description: "cheap task",
      prompt: "do work",
      agentType: "general",
      model: "stella/light",
      spawnEngine: { engine: "default" },
      spawnReasoningEffort: "high",
      storageMode: "local",
    });
    await waitForAgentSettled(manager, modelTask.threadId);

    const engineTask = await manager.createAgent({
      conversationId: "conv-1",
      description: "cc task",
      prompt: "do work",
      agentType: "general",
      spawnEngine: { engine: "claude_code_local", model: "opus" },
      storageMode: "local",
    });
    await waitForAgentSettled(manager, engineTask.threadId);

    expect(contextFetches).toEqual([
      {
        agentType: "general",
        model: "stella/light",
        spawnEngine: { engine: "default" },
        spawnReasoningEffort: "high",
      },
      {
        agentType: "general",
        model: undefined,
        spawnEngine: { engine: "claude_code_local", model: "opus" },
        spawnReasoningEffort: undefined,
      },
    ]);
  });

  it("exposes active background agent root runs", async () => {
    let releaseRun: (() => void) | null = null;
    const running = new Promise<void>((resolve) => {
      releaseRun = resolve;
    });
    const manager = new LocalAgentManager({
      maxConcurrent: 1,
      fetchAgentContext: async () => ({
        systemPrompt: "",
        dynamicContext: "",
        maxAgentDepth: 3,
      }),
      runSubagent: async (args) => {
        await running;
        return {
          runId: args.runId,
          result: "ok",
        };
      },
      toolExecutor: async (): Promise<ToolResult> => ({ result: "unused" }),
      createCloudAgentRecord: async () => ({ agentId: "cloud-unused" }),
      completeCloudAgentRecord: async () => undefined,
      getCloudAgentRecord: async () => null,
      cancelCloudAgentRecord: async () => ({ canceled: false }),
    });

    const task = await manager.createAgent({
      conversationId: "conv-1",
      description: "background task",
      prompt: "do work",
      agentType: "general",
      rootRunId: "root-run-1",
      storageMode: "local",
    });

    expect(manager.listActiveAgentRuns()).toEqual([
      { runId: "root-run-1", conversationId: "conv-1" },
    ]);

    releaseRun?.();
    await waitForAgentSettled(manager, task.threadId);
    expect(manager.listActiveAgentRuns()).toEqual([]);
  });

  it("routes send_input task lifecycle through the current root run and clears composer chip state on completion", async () => {
    const events: AgentLifecycleEvent[] = [];
    let runCount = 0;
    let secondRunStarted: (() => void) | null = null;
    const secondRunStartedPromise = new Promise<void>((resolve) => {
      secondRunStarted = resolve;
    });
    let finishSecondRun: (() => void) | null = null;
    const finishSecondRunPromise = new Promise<void>((resolve) => {
      finishSecondRun = resolve;
    });

    const manager = new LocalAgentManager({
      maxConcurrent: 1,
      fetchAgentContext: async () => ({
        systemPrompt: "",
        dynamicContext: "",
        maxAgentDepth: 3,
      }),
      runSubagent: async (args) => {
        runCount += 1;
        if (runCount === 2) {
          secondRunStarted?.();
          await finishSecondRunPromise;
        }
        return {
          runId: args.runId,
          result: `done-${runCount}`,
        };
      },
      toolExecutor: async (): Promise<ToolResult> => ({ result: "unused" }),
      onAgentEvent: (event) => {
        events.push(event);
      },
      createCloudAgentRecord: async () => ({ agentId: "cloud-unused" }),
      completeCloudAgentRecord: async () => undefined,
      getCloudAgentRecord: async () => null,
      cancelCloudAgentRecord: async () => ({ canceled: false }),
    });

    const task = await manager.createAgent({
      conversationId: "conv-1",
      description: "Research current Nvidia news",
      prompt: "Research current Nvidia news",
      agentType: AGENT_IDS.GENERAL,
      rootRunId: "root-original",
      storageMode: "local",
    });
    await waitForAgentSettled(manager, task.threadId);

    const eventOffset = events.length;
    const toolContext = createStateContext("/tmp", {
      createAgent: async (request) => manager.createAgent(request),
      getAgent: async (threadId) => manager.getAgent(threadId),
      cancelAgent: async (threadId, reason) =>
        manager.cancelAgent(threadId, reason),
      sendAgentMessage: async (threadId, message, from, options) =>
        manager.sendAgentMessage(threadId, message, from, options),
    });

    await expect(
      handleSendInput(
        toolContext,
        {
          thread_id: task.threadId,
          message: "resume the web research with the new requirement",
        },
        {
          conversationId: "conv-1",
          deviceId: "device-1",
          requestId: "request-2",
          rootRunId: "root-current",
          agentType: AGENT_IDS.ORCHESTRATOR,
        },
      ),
    ).resolves.toMatchObject({
      result: {
        thread_id: task.threadId,
        status: "delivered_agent_still_working",
        delivered: true,
      },
    });

    await secondRunStartedPromise;
    expect(manager.listActiveAgentRuns()).toEqual([
      { runId: "root-current", conversationId: "conv-1" },
    ]);

    finishSecondRun?.();
    await waitForAgentSettled(manager, task.threadId);

    // The initial spawn's agent-started is NOT flagged a follow-up.
    const spawnStarted = events
      .slice(0, eventOffset)
      .find(
        (event) =>
          event.type === "agent-started" && event.agentId === task.threadId,
      );
    expect(spawnStarted).toBeDefined();
    expect(spawnStarted?.isFollowUp).toBeUndefined();

    const resumedEvents = events.slice(eventOffset);
    // The send_input re-activation IS explicitly flagged a follow-up and
    // reuses the durable spawn description on `statusText`.
    expect(resumedEvents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "agent-started",
          rootRunId: "root-current",
          agentId: task.threadId,
          statusText: "Research current Nvidia news",
          isFollowUp: true,
        }),
        expect.objectContaining({
          type: "agent-completed",
          rootRunId: "root-current",
          agentId: task.threadId,
          result: "done-2",
        }),
      ]),
    );
    expect(
      resumedEvents.every((event) => event.rootRunId === "root-current"),
    ).toBe(true);

    // Renderer side: the follow-up's stream events maintain only the
    // ephemeral decoration (keyed by thread, rebound to the current run),
    // and the completion clears it — no per-run task copies to leak.
    for (const event of resumedEvents) {
      if (!event.agentId) continue;
      if (event.type === "agent-completed") {
        clearTaskDecoration(event.agentId);
        continue;
      }
      decorateTask({
        agentId: event.agentId,
        conversationId: "conv-1",
        runId: event.rootRunId,
        statusText: event.statusText,
      });
      expect(getTaskDecoration(event.agentId)?.runId).toBe("root-current");
    }
    // Completion left no lingering decoration behind.
    expect(getTaskDecoration(task.threadId)).toBeUndefined();
    __privateTaskDecorationStore.resetForTests();
  });

  it("steers a live Pi turn without aborting or starting a replacement run", async () => {
    const events: AgentLifecycleEvent[] = [];
    let runCount = 0;
    let firstRunWasAborted = false;
    let steeringPrompt = "";
    let releaseFirstRun: (() => void) | null = null;
    let firstRunStarted: (() => void) | null = null;
    const firstRunStartedPromise = new Promise<void>((resolve) => {
      firstRunStarted = resolve;
    });
    const completions = () =>
      events.filter((event) => event.type === "agent-completed");
    const waitForCompletions = async (count: number) => {
      for (let attempt = 0; attempt < 100; attempt += 1) {
        if (completions().length >= count) return;
        await sleep(25);
      }
      throw new Error(`Expected ${count} completion event(s) in time.`);
    };

    const manager = new LocalAgentManager({
      maxConcurrent: 1,
      fetchAgentContext: async () => ({
        systemPrompt: "",
        dynamicContext: "",
        maxAgentDepth: 3,
      }),
      runSubagent: async (args) => {
        runCount += 1;
        if (runCount === 1) {
          Object.defineProperty(args.subagentSession, "canSteer", {
            configurable: true,
            get: () => true,
          });
          Object.defineProperty(args.subagentSession, "steer", {
            configurable: true,
            value: (text: string) => {
              steeringPrompt = text;
              releaseFirstRun?.();
              return true;
            },
          });
          firstRunStarted?.();
          await new Promise<void>((resolve) => {
            releaseFirstRun = resolve;
          });
          firstRunWasAborted = args.abortSignal.aborted;
        }
        return { runId: args.runId, result: `done-${runCount}` };
      },
      toolExecutor: async (): Promise<ToolResult> => ({ result: "unused" }),
      onAgentEvent: (event) => {
        events.push(event);
      },
      createCloudAgentRecord: async () => ({ agentId: "cloud-unused" }),
      completeCloudAgentRecord: async () => undefined,
      getCloudAgentRecord: async () => null,
      cancelCloudAgentRecord: async () => ({ canceled: false }),
    });

    const task = await manager.createAgent({
      conversationId: "conv-1",
      description: "long research task",
      prompt: "do long research",
      agentType: AGENT_IDS.GENERAL,
      rootRunId: "root-1",
      storageMode: "local",
    });
    await firstRunStartedPromise;

    await manager.sendAgentMessage(
      task.threadId,
      "how is it going?",
      "orchestrator",
      { rootRunId: "root-2" },
    );
    await waitForCompletions(1);

    expect(firstRunWasAborted).toBe(false);
    expect(runCount).toBe(1);
    expect(steeringPrompt).toContain("how is it going?");
    expect(steeringPrompt).not.toContain("paused");
    expect(completions()).toHaveLength(1);
    expect(completions()[0]).toMatchObject({ result: "done-1" });
    expect(completions()[0]?.audience).toBeUndefined();
    const startedEvents = events.filter(
      (event) => event.type === "agent-started",
    );
    expect(startedEvents).toHaveLength(2);
    expect(startedEvents[1]).toMatchObject({
      rootRunId: "root-2",
      agentId: task.threadId,
      statusText: "long research task",
      isFollowUp: true,
      // A steering receipt is a new UI occurrence on the same live attempt,
      // not evidence of an engine restart.
      attemptGeneration: startedEvents[0]?.attemptGeneration,
    });
    // Fully finished — nothing pending keeps the thread "active".
    expect(manager.getActiveAgentCount()).toBe(0);

    // Orchestrator resumes the now-idle thread: that's a NEW run with its
    // own completion card at its own completion. Done → running-again is
    // honest history, not a glitch to suppress.
    await manager.sendAgentMessage(
      task.threadId,
      "continue the task",
      "orchestrator",
      { rootRunId: "root-2" },
    );
    await waitForCompletions(2);

    expect(completions()).toHaveLength(2);
    expect(completions()[1]).toMatchObject({ result: "done-2" });
    expect(completions()[1]?.audience).toBeUndefined();
    expect(
      events.every(
        (event) =>
          event.audience !== "display-only" &&
          event.audience !== "orchestrator-only",
      ),
    ).toBe(true);
    expect(manager.getActiveAgentCount()).toBe(0);
  });

  it("queues input when no live agent can steer, then continues after natural completion", async () => {
    const events: AgentLifecycleEvent[] = [];
    let runCount = 0;
    let releaseFirstRun: (() => void) | null = null;
    let firstRunStarted: (() => void) | null = null;
    const firstRunStartedPromise = new Promise<void>((resolve) => {
      firstRunStarted = resolve;
    });
    const completions = () =>
      events.filter((event) => event.type === "agent-completed");
    const waitForCompletions = async (count: number) => {
      for (let attempt = 0; attempt < 100; attempt += 1) {
        if (completions().length >= count) return;
        await sleep(25);
      }
      throw new Error(`Expected ${count} completion event(s) in time.`);
    };

    const manager = new LocalAgentManager({
      maxConcurrent: 1,
      fetchAgentContext: async () => ({
        systemPrompt: "",
        dynamicContext: "",
        maxAgentDepth: 3,
      }),
      runSubagent: async (args) => {
        runCount += 1;
        if (runCount === 1) {
          firstRunStarted?.();
          // This mock does not attach any live agent, so send_input must stay
          // queued while the current engine run finishes naturally.
          await new Promise<void>((resolve) => {
            releaseFirstRun = resolve;
          });
          return { runId: args.runId, result: "done-1" };
        }
        return { runId: args.runId, result: `done-${runCount}` };
      },
      toolExecutor: async (): Promise<ToolResult> => ({ result: "unused" }),
      onAgentEvent: (event) => {
        events.push(event);
      },
      createCloudAgentRecord: async () => ({ agentId: "cloud-unused" }),
      completeCloudAgentRecord: async () => undefined,
      getCloudAgentRecord: async () => null,
      cancelCloudAgentRecord: async () => ({ canceled: false }),
    });

    const task = await manager.createAgent({
      conversationId: "conv-1",
      description: "racy task",
      prompt: "do the work",
      agentType: AGENT_IDS.GENERAL,
      rootRunId: "root-1",
      storageMode: "local",
    });
    await firstRunStartedPromise;

    await manager.sendAgentMessage(
      task.threadId,
      "one more thing",
      "orchestrator",
      { rootRunId: "root-2" },
    );
    releaseFirstRun?.();

    await waitForCompletions(1);
    // Exactly one completion: the queued continuation's. The naturally
    // finished internal boundary (done-1) never emitted a completion card.
    expect(completions()).toHaveLength(1);
    expect(completions()[0]).toMatchObject({ result: "done-2" });
    expect(completions()[0]?.audience).toBeUndefined();
    expect(completions().every((event) => event.result !== "done-1")).toBe(
      true,
    );
    expect(manager.getActiveAgentCount()).toBe(0);
  });

  it("emits failed terminal events when an engine turn throws", async () => {
    const events: AgentLifecycleEvent[] = [];
    const manager = new LocalAgentManager({
      maxConcurrent: 1,
      fetchAgentContext: async () => ({
        systemPrompt: "",
        dynamicContext: "",
        maxAgentDepth: 3,
      }),
      runSubagent: async () => {
        throw new Error("engine transport failed");
      },
      toolExecutor: async (): Promise<ToolResult> => ({ result: "unused" }),
      onAgentEvent: (event) => {
        events.push(event);
      },
      createCloudAgentRecord: async () => ({ agentId: "cloud-unused" }),
      completeCloudAgentRecord: async () => undefined,
      getCloudAgentRecord: async () => null,
      cancelCloudAgentRecord: async () => ({ canceled: false }),
    });

    const task = await manager.createAgent({
      conversationId: "conv-1",
      description: "broken engine task",
      prompt: "do work",
      agentType: "general",
      storageMode: "local",
    });

    await waitForAgentSettled(manager, task.threadId);

    await expect(manager.getAgent(task.threadId)).resolves.toMatchObject({
      status: "error",
      error: "engine transport failed",
    });
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "agent-failed",
        conversationId: "conv-1",
        agentId: task.threadId,
        agentType: "general",
        error: "engine transport failed",
      }),
    );
  });

  it("serializes mutating Exec calls across concurrent tasks", async () => {
    let activeCalls = 0;
    let maxConcurrentCalls = 0;

    const manager = new LocalAgentManager({
      maxConcurrent: 2,
      fetchAgentContext: async () => ({
        systemPrompt: "",
        dynamicContext: "",
        maxAgentDepth: 3,
      }),
      runSubagent: async (args) => {
        const toolContext: ToolContext = {
          conversationId: args.conversationId,
          deviceId: "device-1",
          requestId: `${args.runId}-req`,
          agentType: args.agentType,
          storageMode: "local",
        };
        await args.toolExecutor(
          "Exec",
          {
            summary: "mutate files",
            source: `await tools.apply_patch({ patch: "*** Begin Patch\\n*** End Patch\\n" });`,
          },
          toolContext,
          args.abortSignal,
        );
        return {
          runId: args.runId,
          result: "ok",
        };
      },
      toolExecutor: async (
        toolName: string,
        _args: Record<string, unknown>,
        _context: ToolContext,
      ): Promise<ToolResult> => {
        expect(toolName).toBe("Exec");
        activeCalls += 1;
        maxConcurrentCalls = Math.max(maxConcurrentCalls, activeCalls);
        try {
          await sleep(75);
        } finally {
          activeCalls -= 1;
        }
        return { result: "ok" };
      },
      createCloudAgentRecord: async () => ({ agentId: "cloud-unused" }),
      completeCloudAgentRecord: async () => undefined,
      getCloudAgentRecord: async () => null,
      cancelCloudAgentRecord: async () => ({ canceled: false }),
    });

    const first = await manager.createAgent({
      conversationId: "conv-1",
      description: "first",
      prompt: "first prompt",
      agentType: "general",
      storageMode: "local",
    });
    const second = await manager.createAgent({
      conversationId: "conv-1",
      description: "second",
      prompt: "second prompt",
      agentType: "general",
      storageMode: "local",
    });

    await Promise.all([
      waitForAgentSettled(manager, first.threadId),
      waitForAgentSettled(manager, second.threadId),
    ]);

    await expect(manager.getAgent(first.threadId)).resolves.toMatchObject({
      status: "completed",
    });
    await expect(manager.getAgent(second.threadId)).resolves.toMatchObject({
      status: "completed",
    });
    expect(maxConcurrentCalls).toBe(1);
  });

  it("allows concurrent Codex engine runs", async () => {
    let activeRuns = 0;
    let maxConcurrentRuns = 0;

    const manager = new LocalAgentManager({
      maxConcurrent: 2,
      fetchAgentContext: async () => ({
        systemPrompt: "",
        dynamicContext: "",
        agentEngine: "codex_cli",
        maxAgentDepth: 3,
      }),
      runSubagent: async (args) => {
        activeRuns += 1;
        maxConcurrentRuns = Math.max(maxConcurrentRuns, activeRuns);
        try {
          await sleep(75);
        } finally {
          activeRuns -= 1;
        }
        return {
          runId: args.runId,
          result: "ok",
        };
      },
      toolExecutor: async (): Promise<ToolResult> => ({ result: "unused" }),
      createCloudAgentRecord: async () => ({ agentId: "cloud-unused" }),
      completeCloudAgentRecord: async () => undefined,
      getCloudAgentRecord: async () => null,
      cancelCloudAgentRecord: async () => ({ canceled: false }),
    });

    const first = await manager.createAgent({
      conversationId: "conv-1",
      description: "first",
      prompt: "first prompt",
      agentType: "general",
      storageMode: "local",
    });
    const second = await manager.createAgent({
      conversationId: "conv-1",
      description: "second",
      prompt: "second prompt",
      agentType: "general",
      storageMode: "local",
    });

    await Promise.all([
      waitForAgentSettled(manager, first.threadId),
      waitForAgentSettled(manager, second.threadId),
    ]);

    expect(maxConcurrentRuns).toBe(2);
  });

  it("allows concurrent General Codex engine runs", async () => {
    let activeRuns = 0;
    let maxConcurrentRuns = 0;

    const manager = new LocalAgentManager({
      maxConcurrent: 2,
      fetchAgentContext: async () => ({
        systemPrompt: "",
        dynamicContext: "",
        agentEngine: "codex_cli",
        maxAgentDepth: 3,
      }),
      runSubagent: async (args) => {
        activeRuns += 1;
        maxConcurrentRuns = Math.max(maxConcurrentRuns, activeRuns);
        try {
          await sleep(75);
        } finally {
          activeRuns -= 1;
        }
        return {
          runId: args.runId,
          result: "ok",
        };
      },
      toolExecutor: async (): Promise<ToolResult> => ({ result: "unused" }),
      createCloudAgentRecord: async () => ({ agentId: "cloud-unused" }),
      completeCloudAgentRecord: async () => undefined,
      getCloudAgentRecord: async () => null,
      cancelCloudAgentRecord: async () => ({ canceled: false }),
    });

    const first = await manager.createAgent({
      conversationId: "conv-1",
      description: "first",
      prompt: "first prompt",
      agentType: "general",
      storageMode: "local",
    });
    const second = await manager.createAgent({
      conversationId: "conv-1",
      description: "second",
      prompt: "second prompt",
      agentType: "general",
      storageMode: "local",
    });

    await Promise.all([
      waitForAgentSettled(manager, first.threadId),
      waitForAgentSettled(manager, second.threadId),
    ]);

    expect(maxConcurrentRuns).toBe(2);
  });
});

describe("LocalAgentManager file records across queued send_input turns", () => {
  it("banks a naturally finished internal boundary into the eventual completion rollup, then drains", async () => {
    const events: AgentLifecycleEvent[] = [];
    let runCount = 0;
    let releaseFirstRun: (() => void) | null = null;
    let firstRunStarted: (() => void) | null = null;
    const firstRunStartedPromise = new Promise<void>((resolve) => {
      firstRunStarted = resolve;
    });
    const completions = () =>
      events.filter((event) => event.type === "agent-completed");
    const waitForCompletions = async (count: number) => {
      for (let attempt = 0; attempt < 100; attempt += 1) {
        if (completions().length >= count) return;
        await sleep(25);
      }
      throw new Error(`Expected ${count} completion event(s) in time.`);
    };

    const manager = new LocalAgentManager({
      maxConcurrent: 1,
      fetchAgentContext: async () => ({
        systemPrompt: "",
        dynamicContext: "",
        maxAgentDepth: 3,
      }),
      runSubagent: async (args) => {
        runCount += 1;
        if (runCount === 1) {
          firstRunStarted?.();
          await new Promise<void>((resolve) => {
            releaseFirstRun = resolve;
          });
          // This mock has no live Pi Agent, so the current engine run
          // finishes naturally before the queued update becomes turn 2.
          return {
            runId: args.runId,
            result: "done-1",
            fileChanges: [
              {
                path: "/home/u/.stella/outputs/demos/review.html",
                kind: { type: "update" as const },
              },
            ],
            producedFiles: [
              {
                path: "/home/u/.stella/outputs/demos/demo1.mp4",
                kind: { type: "add" as const },
              },
            ],
          };
        }
        if (runCount === 2) {
          // Follow-up run re-reports one banked write (dedupe) and adds a
          // new one.
          return {
            runId: args.runId,
            result: `done-${runCount}`,
            producedFiles: [
              {
                path: "/home/u/.stella/outputs/demos/demo1.mp4",
                kind: { type: "add" as const },
              },
              {
                path: "/home/u/.stella/outputs/demos/demo2.mp4",
                kind: { type: "add" as const },
              },
            ],
          };
        }
        // Post-drain run: only its own new file.
        return {
          runId: args.runId,
          result: `done-${runCount}`,
          producedFiles: [
            {
              path: "/home/u/.stella/outputs/demos/final.pdf",
              kind: { type: "add" as const },
            },
          ],
        };
      },
      toolExecutor: async (): Promise<ToolResult> => ({ result: "unused" }),
      onAgentEvent: (event) => {
        events.push(event);
      },
      createCloudAgentRecord: async () => ({ agentId: "cloud-unused" }),
      completeCloudAgentRecord: async () => undefined,
      getCloudAgentRecord: async () => null,
      cancelCloudAgentRecord: async () => ({ canceled: false }),
    });

    const task = await manager.createAgent({
      conversationId: "conv-1",
      description: "render demo videos",
      prompt: "render the demos",
      agentType: AGENT_IDS.GENERAL,
      rootRunId: "root-1",
      storageMode: "local",
    });
    await firstRunStartedPromise;

    // No live Pi loop is available in this mock. The update queues without
    // aborting run 1, then becomes the next turn once run 1 finishes.
    await manager.sendAgentMessage(
      task.threadId,
      "add music to the videos",
      "orchestrator",
      { rootRunId: "root-2" },
    );
    releaseFirstRun?.();
    await waitForCompletions(1);

    // The first EMITTED completion must carry run 1's banked files merged
    // with run 2's, deduped by path+kind.
    const first = completions()[0]!;
    expect(first.fileChanges).toEqual([
      {
        path: "/home/u/.stella/outputs/demos/review.html",
        kind: { type: "update" },
      },
    ]);
    expect(first.producedFiles).toEqual([
      {
        path: "/home/u/.stella/outputs/demos/demo1.mp4",
        kind: { type: "add" },
      },
      {
        path: "/home/u/.stella/outputs/demos/demo2.mp4",
        kind: { type: "add" },
      },
    ]);

    // Resume the now-idle thread: the bank was drained when the first
    // completion emitted, so the resumed run's own completion only reveals
    // the new run's files (append-only property). No audience-split
    // duplicates exist under the state-based completion rule.
    await manager.sendAgentMessage(
      task.threadId,
      "export a final pdf",
      "orchestrator",
      { rootRunId: "root-3" },
    );
    await waitForCompletions(2);

    expect(completions()).toHaveLength(2);
    const second = completions()[1]!;
    expect(second.audience).toBeUndefined();
    expect(second.result).toBe("done-3");
    expect(second.fileChanges).toBeUndefined();
    expect(second.producedFiles).toEqual([
      {
        path: "/home/u/.stella/outputs/demos/final.pdf",
        kind: { type: "add" },
      },
    ]);
  });

  it("advances snapshot lastActivityAt on tool lifecycle during one long tool call", async () => {
    let releaseRun: (() => void) | undefined;
    const runGate = new Promise<void>((resolve) => {
      releaseRun = resolve;
    });
    let toolStarted: (() => void) | undefined;
    const toolStartedPromise = new Promise<void>((resolve) => {
      toolStarted = resolve;
    });

    const manager = new LocalAgentManager({
      maxConcurrent: 1,
      fetchAgentContext: async () => ({
        systemPrompt: "",
        dynamicContext: "",
        maxAgentDepth: 3,
      }),
      // Simulates a run whose only activity is one slow tool: no streamed
      // progress (onProgress never fires), just a tool_start then a long wait.
      runSubagent: async (args) => {
        args.onToolStart?.({
          runId: args.runId,
          seq: 1,
          toolCallId: "call-1",
          toolName: "exec_command",
          statusText: "Running exec_command",
        });
        toolStarted?.();
        await runGate;
        args.onToolEnd?.({
          runId: args.runId,
          seq: 2,
          toolCallId: "call-1",
          toolName: "exec_command",
          resultPreview: "ok",
        });
        return { runId: args.runId, result: "done" };
      },
      toolExecutor: async (): Promise<ToolResult> => ({ result: "unused" }),
      createCloudAgentRecord: async () => ({ agentId: "cloud-unused" }),
      completeCloudAgentRecord: async () => undefined,
      getCloudAgentRecord: async () => null,
      cancelCloudAgentRecord: async () => ({ canceled: false }),
    });

    const beforeCreate = Date.now();
    const task = await manager.createAgent({
      conversationId: "conv-1",
      description: "slow connector probe",
      prompt: "probe the connector",
      agentType: AGENT_IDS.GENERAL,
      rootRunId: "root-1",
      storageMode: "local",
    });
    await toolStartedPromise;

    const midToolSnapshot = await manager.getAgent(task.threadId);
    expect(midToolSnapshot?.status).toBe("running");
    // Tool start stamped liveness and marked the tool in flight.
    expect(midToolSnapshot?.lastActivityAt).toBeGreaterThanOrEqual(
      beforeCreate,
    );
    expect(midToolSnapshot?.activeToolCount).toBe(1);
    expect(midToolSnapshot?.recentActivity).toEqual(["Running exec_command"]);

    // Real manager behavior while the tool keeps running: the stamp does
    // NOT move (nothing re-stamps it mid-call) — `activeToolCount` is the
    // only signal that the agent isn't idle. This is exactly the window
    // where a stamp-only idle test would wrongly cancel.
    const stampAfterStart = midToolSnapshot?.lastActivityAt ?? 0;
    await sleep(30);
    const stillMidToolSnapshot = await manager.getAgent(task.threadId);
    expect(stillMidToolSnapshot?.lastActivityAt).toBe(stampAfterStart);
    expect(stillMidToolSnapshot?.activeToolCount).toBe(1);

    releaseRun?.();
    await waitForAgentSettled(manager, task.threadId);

    const finalSnapshot = await manager.getAgent(task.threadId);
    expect(finalSnapshot?.status).toBe("completed");
    // Tool end bumped the stamp past the tool-start one and cleared the
    // in-flight count.
    expect(finalSnapshot?.lastActivityAt).toBeGreaterThan(stampAfterStart);
    expect(finalSnapshot?.activeToolCount).toBe(0);
  });
});

describe("send_input durable description and run rebind", () => {
  it("keeps an internal child-report wake-up out of root-chat lifecycle cards", async () => {
    const events: AgentLifecycleEvent[] = [];
    let runCount = 0;
    const manager = new LocalAgentManager({
      maxConcurrent: 1,
      fetchAgentContext: async () => ({
        systemPrompt: "",
        dynamicContext: "",
        maxAgentDepth: 3,
      }),
      runSubagent: async (args) => {
        runCount += 1;
        return { runId: args.runId, result: `done-${runCount}` };
      },
      toolExecutor: async (): Promise<ToolResult> => ({ result: "unused" }),
      onAgentEvent: (event) => {
        events.push(event);
      },
      createCloudAgentRecord: async () => ({ agentId: "cloud-unused" }),
      completeCloudAgentRecord: async () => undefined,
      getCloudAgentRecord: async () => null,
      cancelCloudAgentRecord: async () => ({ canceled: false }),
    });

    const task = await manager.createAgent({
      conversationId: "conv-1",
      description: "coordinate the research",
      prompt: "coordinate the research",
      agentType: AGENT_IDS.GENERAL,
      rootRunId: "root-1",
      storageMode: "local",
    });
    await waitForAgentSettled(manager, task.threadId);

    const eventOffset = events.length;
    await manager.sendAgentMessage(
      task.threadId,
      "[Subagent completed]\nresult: private child report",
      "orchestrator",
      {
        deliveryKind: "child-report",
        deliveryEventId: "child-1:1:agent-completed",
      },
    );
    await waitForAgentSettled(manager, task.threadId);

    const wakeEvents = events.slice(eventOffset);
    expect(wakeEvents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "agent-progress",
          statusText: "Reviewing a subagent's report",
          audience: "orchestrator-only",
        }),
        expect.objectContaining({
          type: "agent-started",
          statusText: "Reviewing a subagent's report",
          isFollowUp: true,
          audience: "orchestrator-only",
        }),
        expect.objectContaining({
          type: "agent-completed",
          result: "done-2",
        }),
      ]),
    );
    expect(
      wakeEvents.find((event) => event.type === "agent-completed")?.audience,
    ).toBeUndefined();
  });

  it("keeps the spawn description on the thread across follow-ups", async () => {
    const events: AgentLifecycleEvent[] = [];
    let runCount = 0;
    let releaseFirstRun: (() => void) | null = null;
    let firstRunStarted: (() => void) | null = null;
    const firstRunStartedPromise = new Promise<void>((resolve) => {
      firstRunStarted = resolve;
    });

    const manager = new LocalAgentManager({
      maxConcurrent: 1,
      fetchAgentContext: async () => ({
        systemPrompt: "",
        dynamicContext: "",
        maxAgentDepth: 3,
      }),
      runSubagent: async (args) => {
        runCount += 1;
        if (runCount === 1) {
          firstRunStarted?.();
          await new Promise<void>((resolve) => {
            releaseFirstRun = resolve;
          });
          return { runId: args.runId, result: "done-1" };
        }
        return { runId: args.runId, result: `done-${runCount}` };
      },
      toolExecutor: async (): Promise<ToolResult> => ({ result: "unused" }),
      onAgentEvent: (event) => {
        events.push(event);
      },
      createCloudAgentRecord: async () => ({ agentId: "cloud-unused" }),
      completeCloudAgentRecord: async () => undefined,
      getCloudAgentRecord: async () => null,
      cancelCloudAgentRecord: async () => ({ canceled: false }),
    });

    const task = await manager.createAgent({
      conversationId: "conv-1",
      description: "find the booked itinerary",
      prompt: "find the booked itinerary",
      agentType: AGENT_IDS.GENERAL,
      rootRunId: "root-1",
      storageMode: "local",
    });
    await firstRunStartedPromise;

    await manager.sendAgentMessage(
      task.threadId,
      "search specifically for the forwarded itinerary email",
      "orchestrator",
      {
        rootRunId: "root-2",
      },
    );
    releaseFirstRun?.();
    await waitForAgentSettled(manager, task.threadId);

    const followUpStarted = events.find(
      (event) => event.type === "agent-started" && event.isFollowUp,
    );
    expect(followUpStarted).toMatchObject({
      rootRunId: "root-2",
      description: "find the booked itinerary",
    });
    const completion = events.find((event) => event.type === "agent-completed");
    expect(completion).toMatchObject({
      rootRunId: "root-2",
      description: "find the booked itinerary",
    });
    const snapshot = await manager.getAgent(task.threadId);
    expect(snapshot?.description).toBe("find the booked itinerary");
  });

  it("rebinds a thread's decoration to the follow-up's run without leaking per-run copies", () => {
    // The old per-run task store leaked a frozen "running" copy under the
    // spawn run when send_input rebound a thread to the caller's run —
    // that copy pinned the Activity row open forever. Decorations are
    // keyed by thread: a rebind is an in-place update, and the terminal
    // stream event clears it. Authoritative status lives in the
    // thread-activity rows and never depends on this map.
    decorateTask({
      agentId: "thread-1",
      conversationId: "conv-1",
      runId: "root-1",
      statusText: "find the booked itinerary",
      startsAttempt: true,
    });
    expect(getTaskDecoration("thread-1")?.runId).toBe("root-1");

    // Follow-up streams under the new run: same single entry, new runId.
    decorateTask({
      agentId: "thread-1",
      conversationId: "conv-1",
      runId: "root-2",
      statusText: "search for the itinerary email",
      startsAttempt: true,
    });
    expect(getTaskDecoration("thread-1")).toMatchObject({
      runId: "root-2",
      statusText: "search for the itinerary email",
    });

    clearTaskDecoration("thread-1");
    expect(getTaskDecoration("thread-1")).toBeUndefined();
    __privateTaskDecorationStore.resetForTests();
  });
});
