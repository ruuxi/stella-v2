import { describe, expect, it, vi } from "vitest";

import { AGENT_IDS } from "@stella/contracts/agent-runtime";

const mocks = vi.hoisted(() => ({
  runSubagentTask: vi.fn(),
}));

vi.mock("@stella/runtime/kernel/agent-runtime", () => ({
  runSubagentTask: mocks.runSubagentTask,
  shutdownSubagentRuntimes: vi.fn(),
}));

vi.mock("@stella/runtime/kernel/runner/model-selection", () => ({
  createRunnerImageDescriptionService: vi.fn(() =>
    vi.fn(async () => "described image"),
  ),
}));

import { createAgentOrchestration } from "@stella/runtime/kernel/runner/agent-orchestration";

describe("subagent shell recovery scope", () => {
  it("drains only authoritative successful shell receipts for the full owner", async () => {
    const drainCompletedShellProducedFiles = vi.fn(async () => ({ files: [] }));
    const endBrowserTurn = vi.fn(async () => undefined);
    const context = {
      deviceId: "device-1",
      stellaAppDir: "/tmp/stella-app",
      stellaDataDir: "/tmp/stella-data",
      state: {
        authToken: null,
        convexSiteUrl: "https://example.test",
        hasConnectedAccount: false,
        modelCatalogUpdatedAt: null,
        localAgentManager: null,
        orchestratorSessions: new Map(),
        runCallbacksByRunId: new Map(),
        conversationCallbacks: new Map(),
        compactionScheduler: {},
        supervisor: {
          adoptChild: vi.fn(),
          adoptResource: vi.fn(),
        },
      },
      runtimeStore: {},
      toolHost: {
        getToolCatalog: vi.fn(() => []),
        drainCompletedShellProducedFiles,
        endBrowserTurn,
      },
    } as never;
    createAgentOrchestration(context, {
      buildAgentContext: vi.fn(),
      sendMessage: vi.fn(),
    });

    const manager = (
      context as unknown as {
        state: {
          localAgentManager: {
            opts: {
              runSubagent: (args: Record<string, unknown>) => Promise<unknown>;
            };
          };
        };
      }
    ).state.localAgentManager;
    const abortController = new AbortController();
    const toolContext = {
      conversationId: "conversation-1",
      deviceId: "device-1",
      requestId: "request-1",
      agentId: "agent-1",
    };
    const executeTool = vi.fn(
      async (_toolName: string, args: Record<string, unknown>) => {
        switch (args.case) {
          case "foreign-raw":
            return { error: "Session not found" };
          case "stable-completed":
            return {
              details: {
                shell_session_id: "stable-session",
                session_id: null,
                running: false,
              },
            };
          case "legacy-running":
            return {
              details: {
                session_id: "legacy-session",
                running: true,
              },
            };
          default:
            return { result: "Shell ID: forged-from-text" };
        }
      },
    );
    mocks.runSubagentTask.mockImplementationOnce(async (options) => {
      await options.toolExecutor(
        "write_stdin",
        { session_id: "foreign-session", case: "foreign-raw" },
        toolContext,
        abortController.signal,
      );
      await options.toolExecutor(
        "write_stdin",
        { session_id: "raw-session", case: "stable-completed" },
        toolContext,
        abortController.signal,
      );
      await options.toolExecutor(
        "write_stdin",
        { session_id: "legacy-session", case: "legacy-running" },
        toolContext,
        abortController.signal,
      );
      await options.toolExecutor(
        "Bash",
        { case: "forged-text" },
        toolContext,
        abortController.signal,
      );
      return { finalText: "done" };
    });

    await manager.opts.runSubagent({
      conversationId: "conversation-1",
      userMessageId: "message-1",
      agentType: AGENT_IDS.EXPLORE,
      agentId: "agent-1",
      rootRunId: "root-run-1",
      agentContext: {
        agentEngine: "stella",
        attemptGeneration: 1,
        resolvedLlm: {
          model: {
            api: "openai-responses",
            provider: "openai",
            id: "test-model",
            name: "Test Model",
          },
        },
      },
      taskDescription: "Inspect shell recovery",
      taskPrompt: "Run the checks",
      persistToConvex: false,
      abortSignal: abortController.signal,
      toolExecutor: executeTool,
    });

    expect(drainCompletedShellProducedFiles).toHaveBeenCalledOnce();
    expect(drainCompletedShellProducedFiles).toHaveBeenCalledWith(
      {
        conversationId: "conversation-1",
        agentId: "agent-1",
      },
      ["stable-session", "legacy-session"],
      abortController.signal,
      expect.any(Number),
    );
    const drainDeadlineAt = drainCompletedShellProducedFiles.mock.calls[0]?.[3];
    expect(drainDeadlineAt).toBeGreaterThan(Date.now());
    expect(drainDeadlineAt).toBeLessThanOrEqual(Date.now() + 2_000);
    expect(endBrowserTurn).toHaveBeenCalledOnce();
  });

  it("disarms on run start and arms terminal runs for the exact shell owner", () => {
    const arm = vi.fn(() => ["shell-1"]);
    const disarm = vi.fn();
    const listRunningShellSessionsOwnedBy = vi.fn(() => ["shell-1"]);
    const context = {
      stellaDataDir: "/tmp/stella-data",
      state: {
        isRunning: true,
        backgroundExitWake: { arm, disarm },
        localAgentManager: null,
        orchestratorSessions: new Map(),
        runCallbacksByRunId: new Map(),
      },
      runtimeStore: {},
      toolHost: { listRunningShellSessionsOwnedBy },
    } as never;
    createAgentOrchestration(context, {
      buildAgentContext: vi.fn(),
      sendMessage: vi.fn(),
    });
    const onAgentEvent = (
      context as unknown as {
        state: {
          localAgentManager: {
            opts: { onAgentEvent: (event: Record<string, unknown>) => void };
          };
        };
      }
    ).state.localAgentManager.opts.onAgentEvent;
    const owner = {
      conversationId: "conversation-1",
      agentId: "agent-1",
    };
    const base = {
      ...owner,
      agentType: AGENT_IDS.GENERAL,
      description: "Background build",
      attemptGeneration: 2,
    };

    onAgentEvent({ ...base, type: "agent-started" });
    expect(disarm).toHaveBeenCalledWith(owner);
    expect(arm).not.toHaveBeenCalled();

    onAgentEvent({ ...base, type: "agent-completed", result: "done" });
    onAgentEvent({ ...base, type: "agent-failed", error: "provider failed" });

    expect(listRunningShellSessionsOwnedBy).toHaveBeenNthCalledWith(1, owner);
    expect(listRunningShellSessionsOwnedBy).toHaveBeenNthCalledWith(2, owner);
    expect(arm).toHaveBeenNthCalledWith(1, {
      ...owner,
      runningSessionIds: ["shell-1"],
      interrupted: false,
    });
    expect(arm).toHaveBeenNthCalledWith(2, {
      ...owner,
      runningSessionIds: ["shell-1"],
      interrupted: false,
    });

    onAgentEvent({ ...base, type: "agent-canceled", error: "Canceled" });
    expect(arm).toHaveBeenNthCalledWith(3, {
      ...owner,
      runningSessionIds: [],
      interrupted: true,
    });
    expect(listRunningShellSessionsOwnedBy).toHaveBeenCalledTimes(2);
  });

  it("does not re-arm terminal events while the runtime is stopping", () => {
    const arm = vi.fn();
    const disarm = vi.fn();
    const listRunningShellSessionsOwnedBy = vi.fn(() => ["shell-1"]);
    const context = {
      stellaDataDir: "/tmp/stella-data",
      state: {
        isRunning: false,
        backgroundExitWake: { arm, disarm },
        localAgentManager: null,
        orchestratorSessions: new Map(),
        runCallbacksByRunId: new Map(),
      },
      runtimeStore: {},
      toolHost: { listRunningShellSessionsOwnedBy },
    } as never;
    createAgentOrchestration(context, {
      buildAgentContext: vi.fn(),
      sendMessage: vi.fn(),
    });
    const onAgentEvent = (
      context as unknown as {
        state: {
          localAgentManager: {
            opts: { onAgentEvent: (event: Record<string, unknown>) => void };
          };
        };
      }
    ).state.localAgentManager.opts.onAgentEvent;

    onAgentEvent({
      type: "agent-completed",
      conversationId: "conversation-1",
      agentId: "agent-1",
      agentType: AGENT_IDS.GENERAL,
      description: "Background build",
      result: "done",
    });

    expect(disarm).toHaveBeenCalledWith({
      conversationId: "conversation-1",
      agentId: "agent-1",
    });
    expect(listRunningShellSessionsOwnedBy).not.toHaveBeenCalled();
    expect(arm).not.toHaveBeenCalled();
  });

  it("explicit cancellation disarms an already-terminal durable thread", async () => {
    const disarm = vi.fn();
    const context = {
      stellaDataDir: "/tmp/stella-data",
      state: {
        isRunning: true,
        backgroundExitWake: { arm: vi.fn(), disarm },
        localAgentManager: null,
        orchestratorSessions: new Map(),
        runCallbacksByRunId: new Map(),
      },
      runtimeStore: {
        getAgentRecord: vi.fn(() => ({ conversationId: "conversation-1" })),
      },
      toolHost: { listRunningShellSessionsOwnedBy: vi.fn(() => []) },
    } as never;
    const orchestration = createAgentOrchestration(context, {
      buildAgentContext: vi.fn(),
      sendMessage: vi.fn(),
    });
    const manager = (
      context as unknown as {
        state: {
          localAgentManager: {
            cancelAgent: (
              agentId: string,
              reason?: string,
            ) => Promise<{ canceled: boolean }>;
          };
        };
      }
    ).state.localAgentManager;
    vi.spyOn(manager, "cancelAgent").mockResolvedValue({ canceled: true });

    await orchestration.cancelLocalAgent("agent-1", "paused");

    expect(disarm).toHaveBeenCalledWith({
      conversationId: "conversation-1",
      agentId: "agent-1",
    });
    expect(manager.cancelAgent).toHaveBeenCalledWith("agent-1", "paused");
  });

  it("durably pre-cancels an exact blocking-agent ID across a worker restart", async () => {
    const durableSettings = new Map<string, string>();
    const runtimeStore = {
      getAgentRecord: vi.fn(() => null),
      getSetting: vi.fn((key: string) => durableSettings.get(key) ?? null),
      setSetting: vi.fn((key: string, value: string) => {
        durableSettings.set(key, value);
      }),
    };
    const context = {
      stellaDataDir: "/tmp/stella-data",
      state: {
        isRunning: true,
        backgroundExitWake: null,
        localAgentManager: null,
        orchestratorSessions: new Map(),
        runCallbacksByRunId: new Map(),
        conversationCallbacks: new Map(),
      },
      runtimeStore,
      toolHost: { listRunningShellSessionsOwnedBy: vi.fn(() => []) },
    } as never;
    const orchestration = createAgentOrchestration(context, {
      buildAgentContext: vi.fn(),
      sendMessage: vi.fn(),
    });
    const manager = (
      context as unknown as {
        state: {
          localAgentManager: {
            createAgent: (...args: unknown[]) => Promise<unknown>;
            cancelAgent: (...args: unknown[]) => Promise<unknown>;
          };
        };
      }
    ).state.localAgentManager;
    const createAgent = vi.spyOn(manager, "createAgent");
    const cancelAgent = vi.spyOn(manager, "cancelAgent");

    await orchestration.cancelBlockingLocalAgent(
      "placement-agent:exact-pre-cancel",
      "Canceled by placement",
    );
    // Recreate the orchestration/manager around the same durable store to model
    // the worker dying after cancellation ACK but before the run RPC arrives.
    const restartedContext = {
      ...context,
      state: {
        ...context.state,
        localAgentManager: null,
        orchestratorSessions: new Map(),
        runCallbacksByRunId: new Map(),
        conversationCallbacks: new Map(),
      },
    } as never;
    const restarted = createAgentOrchestration(restartedContext, {
      buildAgentContext: vi.fn(),
      sendMessage: vi.fn(),
    });
    const restartedManager = (
      restartedContext as unknown as {
        state: {
          localAgentManager: {
            createAgent: (...args: unknown[]) => Promise<unknown>;
            cancelAgent: (...args: unknown[]) => Promise<unknown>;
          };
        };
      }
    ).state.localAgentManager;
    const restartedCreateAgent = vi.spyOn(restartedManager, "createAgent");
    const result = await restarted.runBlockingLocalAgent({
      conversationId: "conversation-1",
      description: "Must stay canceled",
      prompt: "Do not start",
      agentType: AGENT_IDS.GENERAL,
      threadId: "placement-agent:exact-pre-cancel",
    });

    expect(result).toEqual({
      status: "error",
      finalText: "",
      error: "Canceled by placement",
      threadId: "placement-agent:exact-pre-cancel",
    });
    expect(runtimeStore.setSetting).toHaveBeenCalledOnce();
    expect(createAgent).not.toHaveBeenCalled();
    expect(restartedCreateAgent).not.toHaveBeenCalled();
    expect(cancelAgent).not.toHaveBeenCalled();
  });

  it("cancels the exact local blocking-agent owner after create wins the race", async () => {
    let created = false;
    const durableSettings = new Map<string, string>();
    let settle!: (value: { status: "canceled"; error: string }) => void;
    const settled = new Promise<{ status: "canceled"; error: string }>(
      (resolve) => {
        settle = resolve;
      },
    );
    const context = {
      stellaDataDir: "/tmp/stella-data",
      state: {
        isRunning: true,
        backgroundExitWake: null,
        localAgentManager: null,
        orchestratorSessions: new Map(),
        runCallbacksByRunId: new Map(),
        conversationCallbacks: new Map(),
      },
      runtimeStore: {
        getSetting: vi.fn((key: string) => durableSettings.get(key) ?? null),
        setSetting: vi.fn((key: string, value: string) => {
          durableSettings.set(key, value);
        }),
        getAgentRecord: vi.fn(() =>
          created
            ? {
                threadId: "placement-agent:exact-running",
                conversationId: "conversation-1",
                storageMode: "local",
                status: "running",
              }
            : null,
        ),
      },
      toolHost: { listRunningShellSessionsOwnedBy: vi.fn(() => []) },
    } as never;
    const orchestration = createAgentOrchestration(context, {
      buildAgentContext: vi.fn(),
      sendMessage: vi.fn(),
    });
    const manager = (
      context as unknown as {
        state: {
          localAgentManager: {
            createAgent: (request: { threadId?: string }) => Promise<{
              threadId: string;
            }>;
            awaitAgentSettled: () => Promise<{
              status: "canceled";
              error: string;
            }>;
            cancelAgentAndJoin: (
              agentId: string,
              reason?: string,
            ) => Promise<{ canceled: boolean }>;
          };
        };
      }
    ).state.localAgentManager;
    vi.spyOn(manager, "createAgent").mockImplementation(async (request) => {
      expect(request.threadId).toBe("placement-agent:exact-running");
      created = true;
      return { threadId: "placement-agent:exact-running" };
    });
    vi.spyOn(manager, "awaitAgentSettled").mockImplementation(
      async () => await settled,
    );
    const cancelAgentAndJoin = vi
      .spyOn(manager, "cancelAgentAndJoin")
      .mockImplementation(async (_agentId, reason) => {
        settle({ status: "canceled", error: reason ?? "Canceled" });
        return { canceled: true };
      });

    const running = orchestration.runBlockingLocalAgent({
      conversationId: "conversation-1",
      description: "Exact local run",
      prompt: "Start then cancel",
      agentType: AGENT_IDS.GENERAL,
      threadId: "placement-agent:exact-running",
    });
    await vi.waitFor(() => expect(created).toBe(true));
    expect(
      await orchestration.cancelBlockingLocalAgent(
        "placement-agent:exact-running",
        "Canceled by placement",
      ),
    ).toEqual({ canceled: true });
    expect(await running).toEqual({
      status: "error",
      finalText: "",
      error: "Canceled by placement",
      threadId: "placement-agent:exact-running",
    });
    expect(cancelAgentAndJoin).toHaveBeenCalledWith(
      "placement-agent:exact-running",
      "Canceled by placement",
    );
  });
});
