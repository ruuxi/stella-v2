import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it, vi } from "vitest";

import { AGENT_IDS } from "@stella/contracts/agent-runtime";
import {
  AGENT_PAUSE_CANCEL_REASON,
  MANAGER_MISSING_FINAL_REPORT_FALLBACK,
  type AgentLifecycleEvent,
  type LocalAgentManager,
} from "@stella/runtime/kernel/agents/local-agent-manager";
import { createAgentOrchestration } from "@stella/runtime/kernel/runner/agent-orchestration";
import { createKernelRunSupervisor } from "@stella/runtime/kernel/runner/supervision/run-supervisor";
import {
  handleSendInput,
  handleSpawnManager,
} from "@stella/runtime/kernel/tools/state";
import type { AgentModelConfigSnapshot } from "@stella/contracts/agent-engine";
import type { RunnerContext } from "@stella/runtime/kernel/runner/types";
import {
  getDesktopDatabasePath,
  initializeDesktopDatabase,
} from "@stella/runtime/kernel/storage/database-init";
import { SessionStore } from "@stella/runtime/kernel/storage/session-store";
import {
  RUNTIME_PRIVATE_TASK_LIFECYCLE_CUSTOM_TYPE,
  type LocalChatAppendEventArgs,
  type SqliteDatabase,
} from "@stella/runtime/kernel/storage/shared";
import { buildBackgroundTaskLifecycleIndex } from "@/features/chat/lib/background-task-lifecycle";
import { buildHistorySource } from "@stella/runtime/kernel/agent-runtime/thread-memory";
import { SubagentSession } from "@stella/runtime/kernel/agent-runtime/subagent-session";
import { SAFETY_SWAP_STELLA_MODEL_ID } from "@stella/runtime/kernel/agent-runtime/provider-abort-containment";
import type { SubagentRunOptions } from "@stella/runtime/kernel/agent-runtime/types";
import type { ResolvedLlmRoute } from "@stella/runtime/kernel/model-routing";
import { resolveOrchestratorThreadKey } from "@stella/runtime/kernel/thread-runtime";
import { providerAbortedStopMessage } from "@stella/runtime/ai/utils/provider-stop";
import type { Api, Model } from "@stella/runtime/ai/types";

const sessionExecutionMock = vi.hoisted(() => vi.fn());

vi.mock("@stella/runtime/kernel/agent-runtime/run-execution", () => ({
  executeRuntimeAgentPrompt: (...args: unknown[]) =>
    sessionExecutionMock(...args),
}));

type MockRunArgs = {
  agentId?: string;
  agentType: string;
  userPrompt: string;
  abortSignal?: AbortSignal;
  callbacks?: {
    onStatus?: (event: {
      runId: string;
      seq: number;
      statusText: string;
      statusState?: string;
    }) => void;
    onToolStart?: (event: {
      runId: string;
      seq: number;
      toolCallId: string;
      toolName: string;
      statusText?: string;
    }) => void;
  };
  agentContext?: {
    threadHistory?: Array<{ content: string }>;
    attemptGeneration?: number;
  };
  subagentSession?: SubagentSession;
};

const runMock = vi.hoisted(() => ({
  handler: null as
    | null
    | ((args: MockRunArgs) => Promise<{
        runId: string;
        result: string;
        interrupted?: boolean;
        error?: string;
      }>),
}));

vi.mock("@stella/runtime/kernel/agent-runtime", () => ({
  runSubagentTask: (args: MockRunArgs) => {
    if (!runMock.handler) throw new Error("Missing manager test run handler");
    return runMock.handler(args);
  },
  shutdownSubagentRuntimes: vi.fn(),
}));

type SentMessage = {
  text: string;
  customType?: string;
  responseTarget?: {
    type: string;
    agentId?: string;
    terminalState?: string;
  };
};

type Harness = {
  rootPath: string;
  db: SqliteDatabase;
  store: SessionStore;
  manager: LocalAgentManager;
  appendedEvents: LocalChatAppendEventArgs[];
  sentMessages: SentMessage[];
  rootStatusEvents: Array<{ statusText: string; statusState?: string }>;
  fetchedModelConfigs: Array<AgentModelConfigSnapshot | undefined>;
};

const harnesses = new Set<Harness>();

const waitUntil = async (predicate: () => boolean | Promise<boolean>) => {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("Timed out waiting for manager orchestration state");
};

const waitForAbort = async (signal?: AbortSignal): Promise<void> => {
  if (signal?.aborted) return;
  await new Promise<void>((resolve) =>
    signal?.addEventListener("abort", () => resolve(), { once: true }),
  );
};

const historyText = (args: MockRunArgs): string =>
  (args.agentContext?.threadHistory ?? [])
    .map((message) => message.content)
    .join("\n");

const fableStellaRoute = (): ResolvedLlmRoute => {
  const model = {
    id: "stella/max",
    name: "max",
    api: "anthropic-messages",
    provider: "anthropic",
    baseUrl: "https://relay.example/api/llm",
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 200_000,
    maxTokens: 0,
  } as Model<Api>;
  (model as Model<Api> & { upstreamModelId?: string }).upstreamModelId =
    "claude-fable-5";
  return { route: "stella", model, getApiKey: () => "token" };
};

const hasInFlightAttempt = (
  manager: LocalAgentManager,
  threadId: string,
): boolean =>
  (
    manager as unknown as {
      inFlightAttempts: Map<string, unknown>;
    }
  ).inFlightAttempts.has(threadId);

const reportFromMockManager = async (
  args: MockRunArgs,
  message: string,
  final: boolean,
  reportId: string,
) => {
  const agentId = args.agentId;
  const attemptGeneration = args.agentContext?.attemptGeneration;
  const harness = [...harnesses].find(
    (candidate) =>
      agentId &&
      candidate.store.getAgentRecord(agentId)?.agentType === "manager",
  );
  if (!harness || !agentId || typeof attemptGeneration !== "number") {
    throw new Error("Missing active Manager attempt for report test helper");
  }
  return harness.manager.reportManager({
    threadId: agentId,
    message,
    final,
    attemptGeneration,
    reportId,
  });
};

const createHarness = (options?: {
  rootPath?: string;
  attemptTeardownTimeoutMs?: number;
  resolvedLlm?: ResolvedLlmRoute;
}): Harness => {
  const rootPath =
    options?.rootPath ??
    path.join(
      os.tmpdir(),
      `stella-manager-orchestration-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
  const db = new DatabaseSync(getDesktopDatabasePath(rootPath), {
    timeout: 5_000,
  }) as unknown as SqliteDatabase;
  initializeDesktopDatabase(db);
  const store = new SessionStore(db);
  const appendedEvents: LocalChatAppendEventArgs[] = [];
  const sentMessages: SentMessage[] = [];
  const rootStatusEvents: Array<{
    statusText: string;
    statusState?: string;
  }> = [];
  const fetchedModelConfigs: Array<AgentModelConfigSnapshot | undefined> = [];
  const context = {
    stellaAppDir: rootPath,
    stellaDataDir: rootPath,
    deviceId: "device-manager-test",
    runtimeStore: store,
    appendLocalChatEvent: (event: LocalChatAppendEventArgs) => {
      appendedEvents.push(event);
      store.appendEvent(event);
    },
    notifyThreadActivityUpdated: vi.fn(),
    state: {
      localAgentManager: null,
      runCallbacksByRunId: new Map([
        [
          "root-run-status",
          {
            onStream: vi.fn(),
            onToolStart: vi.fn(),
            onToolEnd: vi.fn(),
            onError: vi.fn(),
            onEnd: vi.fn(),
            onStatus: (event: { statusText: string; statusState?: string }) =>
              rootStatusEvents.push(event),
          },
        ],
      ]),
      conversationCallbacks: new Map(),
      convexSiteUrl: null,
      authToken: null,
      hasConnectedAccount: false,
      supervisor: createKernelRunSupervisor(),
    },
    toolHost: {
      getToolCatalog: () => [],
      executeTool: async () => ({ result: "unused" }),
      drainCompletedShellProducedFiles: async () => [],
      killShell: async () => {},
    },
  } as unknown as RunnerContext;
  createAgentOrchestration(context, {
    buildAgentContext: async ({ threadId, modelConfigSnapshot }) => {
      fetchedModelConfigs.push(modelConfigSnapshot);
      return {
        systemPrompt: "",
        dynamicContext: "",
        maxAgentDepth: 2,
        // Mirrors buildAgentContext's real non-orchestrator history hydration.
        // Keeping this wired to SessionStore is what exposes replay duplicates.
        threadHistory: store.loadThreadMessages(threadId),
        resolvedLlm:
          options?.resolvedLlm ??
          ({ model: { id: "test-model", provider: "openai" } } as never),
      };
    },
    sendMessage: async (message) => {
      sentMessages.push(message);
    },
    ...(options?.attemptTeardownTimeoutMs !== undefined
      ? { attemptTeardownTimeoutMs: options.attemptTeardownTimeoutMs }
      : {}),
  });
  const harness = {
    rootPath,
    db,
    store,
    manager: context.state.localAgentManager!,
    appendedEvents,
    sentMessages,
    rootStatusEvents,
    fetchedModelConfigs,
  };
  harnesses.add(harness);
  return harness;
};

const closeHarness = async (
  harness: Harness,
  options?: { removeRoot?: boolean },
) => {
  harness.manager.shutdown();
  await new Promise((resolve) => setTimeout(resolve, 20));
  harness.db.close();
  harnesses.delete(harness);
  if (options?.removeRoot !== false) {
    await rm(harness.rootPath, { recursive: true, force: true });
  }
};

afterEach(async () => {
  runMock.handler = null;
  sessionExecutionMock.mockReset();
  for (const harness of harnesses) {
    await closeHarness(harness);
  }
  harnesses.clear();
  vi.clearAllMocks();
});

describe("manager orchestration production routing", () => {
  it("caps safety retries, model swap, and transient recovery at four provider calls", async () => {
    const safetyError = providerAbortedStopMessage("refusal");
    const harness = createHarness({ resolvedLlm: fableStellaRoute() });
    const { manager, store, sentMessages } = harness;
    const observedModels: string[] = [];
    const failures = [
      safetyError,
      safetyError,
      safetyError,
      "429 Transient relay buffer quota exceeded",
    ];
    sessionExecutionMock.mockImplementation(async ({ agent, resume }) => {
      const attempt = sessionExecutionMock.mock.calls.length;
      const errorMessage = failures[attempt - 1]!;
      observedModels.push(agent.state.model.id);
      expect(Boolean(resume)).toBe(attempt > 1);
      agent.state.messages.push({
        role: "assistant",
        content: [],
        api: "anthropic-messages",
        provider: "anthropic",
        model: agent.state.model.id,
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
        errorMessage,
        timestamp: attempt,
      });
      return { finalText: "", errorMessage };
    });
    runMock.handler = async (args) => {
      if (args.agentType === AGENT_IDS.MANAGER) {
        await waitForAbort(args.abortSignal);
        return { runId: "budget-owner-manager", result: "", interrupted: true };
      }
      const session =
        args.subagentSession ??
        new SubagentSession(
          args.agentId ?? "missing-agent",
          "conversation-shared-budget",
          args.agentType,
        );
      return await session.runTurn(args as unknown as SubagentRunOptions);
    };

    const managerTask = await manager.createAgent({
      threadId: "budget-owner-manager",
      conversationId: "conversation-shared-budget",
      description: "Own safety-budget child failure",
      prompt: "Handle the child failure.",
      agentType: AGENT_IDS.MANAGER,
      storageMode: "local",
    });
    const childTask = await manager.createAgent({
      threadId: "safety-budget-child",
      conversationId: "conversation-shared-budget",
      description: "Exercise the shared attempt budget",
      prompt: "Stay within the provider-call budget.",
      agentType: AGENT_IDS.GENERAL,
      parentAgentId: managerTask.threadId,
      storageMode: "local",
    });

    await waitUntil(
      async () =>
        (await manager.getAgent(childTask.threadId))?.status === "error",
    );

    expect(sessionExecutionMock).toHaveBeenCalledTimes(4);
    expect(observedModels).toEqual([
      "stella/max",
      "stella/max",
      "stella/max",
      SAFETY_SWAP_STELLA_MODEL_ID,
    ]);
    const managerFailures = store
      .loadThreadMessages(managerTask.threadId)
      .filter(
        (message) =>
          message.customMessage?.lifecycleEvent?.type === "agent-failed",
      );
    expect(managerFailures).toHaveLength(1);
    expect(JSON.stringify(managerFailures)).toContain(
      "failed after 4 attempts",
    );
    expect(JSON.stringify(managerFailures)).toContain("relay buffer quota");
    expect(
      sentMessages.filter((message) =>
        message.text.includes("relay buffer quota"),
      ),
    ).toHaveLength(0);
  });

  it("routes native persistent-empty exhaustion to the owning Manager only", async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    const harness = createHarness();
    const { manager, store, sentMessages } = harness;
    let providerAttempt = 0;
    sessionExecutionMock.mockImplementation(async ({ agent }) => {
      providerAttempt += 1;
      agent.state.messages.push({
        role: "assistant",
        content: [{ type: "text", text: "" }],
        api: "openai-completions",
        provider: "test",
        model: "test-model",
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
        stopReason: "stop",
        timestamp: providerAttempt,
      });
      return { finalText: "" };
    });
    runMock.handler = async (args) => {
      if (args.agentType === AGENT_IDS.MANAGER) {
        await waitForAbort(args.abortSignal);
        return { runId: "empty-owner-manager", result: "", interrupted: true };
      }
      const session =
        args.subagentSession ??
        new SubagentSession(
          args.agentId ?? "missing-agent",
          "conversation-empty-owner",
          args.agentType,
        );
      return await session.runTurn(args as unknown as SubagentRunOptions);
    };

    try {
      const managerTask = await manager.createAgent({
        threadId: "empty-owner-manager",
        conversationId: "conversation-empty-owner",
        description: "Own empty child failure",
        prompt: "Handle the child failure.",
        agentType: AGENT_IDS.MANAGER,
        storageMode: "local",
      });
      const childTask = await manager.createAgent({
        threadId: "persistent-empty-child",
        conversationId: "conversation-empty-owner",
        description: "Return a real result",
        prompt: "Do not return empty output.",
        agentType: AGENT_IDS.GENERAL,
        parentAgentId: managerTask.threadId,
        storageMode: "local",
      });

      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(1_000);
      await vi.advanceTimersByTimeAsync(2_500);
      await vi.advanceTimersByTimeAsync(6_000);
      await vi.waitFor(
        async () =>
          expect((await manager.getAgent(childTask.threadId))?.status).toBe(
            "error",
          ),
        { timeout: 1_000 },
      );
      expect(sessionExecutionMock).toHaveBeenCalledTimes(4);
      const managerFailures = store
        .loadThreadMessages(managerTask.threadId)
        .filter(
          (message) =>
            message.customMessage?.lifecycleEvent?.type === "agent-failed",
        );
      expect(managerFailures).toHaveLength(1);
      expect(JSON.stringify(managerFailures)).toContain(
        "failed after 4 attempts",
      );
      expect(JSON.stringify(managerFailures)).toContain("empty completion");
      expect(
        sentMessages.filter((message) =>
          message.text.includes("empty completion"),
        ),
      ).toHaveLength(0);
    } finally {
      manager.shutdown();
      vi.restoreAllMocks();
      vi.useRealTimers();
    }
  });

  it("projects production manager-private progress and transitive lifecycle into canonical cards", async () => {
    const {
      manager,
      store,
      db,
      appendedEvents,
      sentMessages,
      rootStatusEvents,
    } = createHarness();
    let releaseFirstCompletion!: () => void;
    const firstCompletionGate = new Promise<void>((resolve) => {
      releaseFirstCompletion = resolve;
    });
    let releaseFollowUpCompletion!: () => void;
    const followUpCompletionGate = new Promise<void>((resolve) => {
      releaseFollowUpCompletion = resolve;
    });
    let releaseFailure!: () => void;
    const failureGate = new Promise<void>((resolve) => {
      releaseFailure = resolve;
    });
    let releaseDescendant!: () => void;
    const descendantGate = new Promise<void>((resolve) => {
      releaseDescendant = resolve;
    });
    let completedAttempts = 0;
    runMock.handler = async (args) => {
      if (args.agentType === AGENT_IDS.MANAGER) {
        await waitForAbort(args.abortSignal);
        return { runId: "manager-interrupted", result: "", interrupted: true };
      }
      if (args.agentId === "private-completed-child") {
        completedAttempts += 1;
        args.callbacks?.onToolStart?.({
          runId: `private-completed-${completedAttempts}`,
          seq: 1,
          toolCallId: `private-completed-tool-${completedAttempts}`,
          toolName: "Read",
          statusText:
            completedAttempts === 1
              ? "Inspecting private completion source"
              : "Inspecting private follow-up source",
        });
        await (completedAttempts === 1
          ? firstCompletionGate
          : followUpCompletionGate);
        return {
          runId: `private-completed-${completedAttempts}`,
          result:
            completedAttempts === 1
              ? "First production completion."
              : "Production follow-up completion.",
        };
      }
      if (args.agentId === "private-failed-child") {
        args.callbacks?.onStatus?.({
          runId: "private-failed-retry",
          seq: 1,
          statusText:
            "Task hit a transient server error — retrying attempt 2/4 in 1s",
          statusState: "provider-retry",
        });
        await failureGate;
        throw new Error("Production managed-child failure.");
      }
      if (args.agentId === "private-canceled-child") {
        await waitForAbort(args.abortSignal);
        return { runId: "private-canceled", result: "", interrupted: true };
      }
      if (args.agentId === "private-transitive-descendant") {
        args.callbacks?.onToolStart?.({
          runId: "private-descendant-run",
          seq: 1,
          toolCallId: "private-descendant-tool",
          toolName: "Grep",
          statusText: "Auditing transitive descendant",
        });
        await descendantGate;
        return {
          runId: "private-descendant-run",
          result: "Transitive descendant completed privately.",
        };
      }
      throw new Error(`Unexpected agent ${args.agentId}`);
    };

    const conversationId = "conversation-private-claude-lifecycle";
    const managerTask = await manager.createAgent({
      threadId: "private-claude-manager",
      conversationId,
      description: "Coordinate private Claude lifecycle",
      prompt: "Coordinate the private children.",
      agentType: AGENT_IDS.MANAGER,
      agentDepth: 1,
      maxAgentDepth: 3,
      storageMode: "local",
      modelConfigSnapshot: {
        engine: "claude_code_local",
        routeModel: "stella/anthropic/claude-fable-5",
        engineModel: "fable",
        reasoningEffort: "high",
      },
      rootRunId: "root-run-status",
    });
    await waitUntil(
      async () =>
        (await manager.getAgent(managerTask.threadId))?.status === "running",
    );

    const appendClaudeCall = (args: {
      id: string;
      name: string;
      arguments: Record<string, unknown>;
    }) => {
      const transportTimestamp = Date.now();
      store.appendThreadMessage({
        threadKey: managerTask.threadId,
        timestamp: transportTimestamp,
        role: "assistant",
        content: "",
        payload: {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              id: args.id,
              name: args.name,
              arguments: args.arguments,
            },
          ],
          api: "anthropic-messages",
          provider: "anthropic",
          model: "claude-code",
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
          timestamp: transportTimestamp,
        } as never,
      });
    };
    const appendClaudeResult = (
      id: string,
      toolName: string,
      result: Record<string, unknown> | string,
    ) => {
      const transportTimestamp = Date.now();
      const text = typeof result === "string" ? result : JSON.stringify(result);
      store.appendThreadMessage({
        threadKey: managerTask.threadId,
        timestamp: transportTimestamp,
        role: "toolResult",
        toolCallId: id,
        content: text,
        payload: {
          role: "toolResult",
          toolCallId: id,
          toolName,
          content: [{ type: "text", text }],
          isError: false,
          timestamp: transportTimestamp,
        } as never,
      });
    };
    const spawnPrivateChild = async (args: {
      threadId: string;
      description: string;
    }) => {
      const callId = `mcp:private:${args.threadId}:spawn`;
      appendClaudeCall({
        id: callId,
        name: "spawn_agent",
        arguments: {
          description: args.description,
          prompt: `Private prompt for ${args.threadId}`,
        },
      });
      const task = await manager.createAgent({
        threadId: args.threadId,
        conversationId,
        description: args.description,
        prompt: `Run ${args.description}.`,
        agentType: AGENT_IDS.GENERAL,
        agentDepth: 2,
        maxAgentDepth: 3,
        parentAgentId: managerTask.threadId,
        rootRunId: "root-run-status",
        storageMode: "local",
      });
      appendClaudeResult(callId, "spawn_agent", {
        thread_id: task.threadId,
        created: true,
        running_in_background: true,
      });
      return task;
    };

    const completedTask = await spawnPrivateChild({
      threadId: "private-completed-child",
      description: "Complete private verification",
    });
    await new Promise((resolve) => setTimeout(resolve, 2));
    releaseFirstCompletion();
    await waitUntil(
      async () =>
        (await manager.getAgent(completedTask.threadId))?.status ===
        "completed",
    );

    const followUpCallId = "mcp:private:completed:follow-up";
    appendClaudeCall({
      id: followUpCallId,
      name: "send_input",
      arguments: {
        thread_id: completedTask.threadId,
        description: "Recheck private verification",
        message: "Private follow-up prompt",
      },
    });
    await manager.sendAgentMessage(
      completedTask.threadId,
      "Run the private follow-up.",
      "orchestrator",
      {
        deliveryKind: "external-input",
        parentAgentId: managerTask.threadId,
      },
    );
    appendClaudeResult(followUpCallId, "send_input", {
      thread_id: completedTask.threadId,
      status: "updated",
      delivered: true,
    });
    await new Promise((resolve) => setTimeout(resolve, 2));
    releaseFollowUpCompletion();
    await waitUntil(
      () =>
        (store.getAgentRecord(completedTask.threadId)?.attemptGeneration ?? 0) >
          1 &&
        store.getAgentRecord(completedTask.threadId)?.status === "completed",
    );

    const failedTask = await spawnPrivateChild({
      threadId: "private-failed-child",
      description: "Fail private verification",
    });
    await new Promise((resolve) => setTimeout(resolve, 2));
    releaseFailure();
    await waitUntil(
      async () =>
        (await manager.getAgent(failedTask.threadId))?.status === "error",
    );

    const canceledTask = await spawnPrivateChild({
      threadId: "private-canceled-child",
      description: "Cancel private verification",
    });
    await waitUntil(
      async () =>
        (await manager.getAgent(canceledTask.threadId))?.status === "running",
    );
    const descendantTask = await manager.createAgent({
      threadId: "private-transitive-descendant",
      conversationId,
      description: "Audit transitive descendant",
      prompt: "Run the transitive descendant audit.",
      agentType: AGENT_IDS.GENERAL,
      agentDepth: 3,
      maxAgentDepth: 3,
      parentAgentId: canceledTask.threadId,
      storageMode: "local",
    });
    await waitUntil(
      async () =>
        (await manager.getAgent(descendantTask.threadId))?.status === "running",
    );
    releaseDescendant();
    await waitUntil(
      async () =>
        (await manager.getAgent(descendantTask.threadId))?.status ===
        "completed",
    );
    await new Promise((resolve) => setTimeout(resolve, 2));
    await manager.cancelAgent(canceledTask.threadId, AGENT_PAUSE_CANCEL_REASON);
    await waitUntil(
      async () =>
        (await manager.getAgent(canceledTask.threadId))?.status === "canceled",
    );

    appendClaudeCall({
      id: "mcp:private:generic-read",
      name: "Read",
      arguments: { file_path: "/private/generic-tool-input" },
    });
    appendClaudeResult(
      "mcp:private:generic-read",
      "Read",
      "private generic tool result",
    );

    await waitUntil(
      () =>
        store
          .loadThreadMessages(managerTask.threadId)
          .filter(
            (message) =>
              message.customMessage?.customType === "runtime.task_lifecycle",
          ).length === 5,
    );
    const reminders = store
      .loadThreadMessages(managerTask.threadId)
      .filter(
        (message) =>
          message.customMessage?.customType === "runtime.task_lifecycle",
      );
    expect(
      reminders.map((message) => message.customMessage?.lifecycleEvent?.type),
    ).toEqual([
      "agent-completed",
      "agent-completed",
      "agent-failed",
      "agent-completed",
      "agent-canceled",
    ]);
    expect(JSON.stringify(reminders)).toContain(
      "Production managed-child failure.",
    );
    expect(
      sentMessages.filter((message) =>
        message.text.includes("Production managed-child failure."),
      ),
    ).toHaveLength(0);
    expect(
      rootStatusEvents.filter(
        (event) => event.statusState === "provider-retry",
      ),
    ).toHaveLength(0);

    const privateLifecycleRows = store
      .loadThreadMessages(managerTask.threadId)
      .filter(
        (message) =>
          message.customMessage?.customType ===
          RUNTIME_PRIVATE_TASK_LIFECYCLE_CUSTOM_TYPE,
      );
    expect(
      privateLifecycleRows.filter(
        (message) =>
          message.customMessage?.lifecycleEvent?.type === "agent-started",
      ),
    ).toHaveLength(5);
    expect(
      privateLifecycleRows
        .filter(
          (message) =>
            message.customMessage?.lifecycleEvent?.type === "agent-progress",
        )
        .map(
          (message) =>
            message.customMessage?.lifecycleEvent?.payload.statusText,
        ),
    ).toEqual(
      expect.arrayContaining([
        "Inspecting private completion source",
        "Inspecting private follow-up source",
        "Task hit a transient server error — retrying attempt 2/4 in 1s",
        "Auditing transitive descendant",
      ]),
    );

    const privateChildIds = new Set([
      completedTask.threadId,
      failedTask.threadId,
      canceledTask.threadId,
      descendantTask.threadId,
    ]);
    expect(
      appendedEvents.filter((event) =>
        privateChildIds.has(
          String((event.payload as { agentId?: unknown })?.agentId ?? ""),
        ),
      ),
    ).toEqual([]);
    expect(
      store
        .listActivity(conversationId)
        .activities.filter((event) =>
          privateChildIds.has(String(event.payload?.agentId ?? "")),
        ),
    ).toEqual([]);

    const transcript = store.listThreadTranscript(managerTask.threadId);
    const lifecycleEvents =
      transcript?.entries.flatMap((entry) =>
        entry.kind === "lifecycle" ? [entry.lifecycleEvent] : [],
      ) ?? [];
    const cards = [
      ...buildBackgroundTaskLifecycleIndex(
        lifecycleEvents,
      ).byStartEventId.values(),
    ];
    expect(
      cards
        .filter((card) => card.agentId === completedTask.threadId)
        .map((card) => ({
          status: card.status,
          progressText: card.progressText,
        })),
    ).toEqual([
      {
        status: "completed",
        progressText: "Inspecting private completion source",
      },
      {
        status: "completed",
        progressText: "Inspecting private follow-up source",
      },
    ]);
    expect(
      cards.find((card) => card.agentId === failedTask.threadId)?.status,
    ).toBe("failed");
    expect(
      cards.find((card) => card.agentId === canceledTask.threadId)?.status,
    ).toBe("canceled");
    expect(
      cards.find((card) => card.agentId === descendantTask.threadId),
    ).toMatchObject({
      status: "completed",
      progressText: "Auditing transitive descendant",
    });
    expect(
      cards.filter((card) => privateChildIds.has(card.agentId)),
    ).toHaveLength(5);
    const modelHistory = buildHistorySource({
      systemPrompt: "",
      dynamicContext: "",
      maxAgentDepth: 3,
      threadHistory: store.loadThreadMessages(managerTask.threadId),
    });
    expect(
      modelHistory.some(
        (message) =>
          message.role === "runtimeInternal" &&
          message.customType === RUNTIME_PRIVATE_TASK_LIFECYCLE_CUSTOM_TYPE,
      ),
    ).toBe(false);
    expect(
      new SessionStore(db).listThreadTranscript(managerTask.threadId),
    ).toEqual(transcript);
    expect(JSON.stringify(transcript)).not.toMatch(
      /spawn_agent|send_input|generic-read|generic-tool-input|generic tool result|Private prompt|Private follow-up prompt/,
    );
  });

  it("persists stable attempt identity on failed and canceled terminals", async () => {
    const { manager, appendedEvents, sentMessages } = createHarness();
    runMock.handler = async (args) => {
      if (args.agentId === "failing-agent") {
        throw new Error("terminal identity failure");
      }
      await waitForAbort(args.abortSignal);
      return { runId: "canceled-run", result: "", interrupted: true };
    };

    const failedTask = await manager.createAgent({
      threadId: "failing-agent",
      conversationId: "conversation-terminal-identity",
      description: "Fail with identity",
      prompt: "Fail",
      agentType: AGENT_IDS.GENERAL,
      storageMode: "local",
    });
    await waitUntil(
      async () =>
        (await manager.getAgent(failedTask.threadId))?.status === "error",
    );
    await waitUntil(() =>
      sentMessages.some((message) =>
        message.text.includes("terminal identity failure"),
      ),
    );
    expect(
      sentMessages.find((message) =>
        message.text.includes("terminal identity failure"),
      ),
    ).toMatchObject({
      customType: "runtime.task_lifecycle",
      responseTarget: {
        type: "agent_turn",
        agentId: failedTask.threadId,
      },
    });

    const canceledTask = await manager.createAgent({
      threadId: "canceled-agent",
      conversationId: "conversation-terminal-identity",
      description: "Cancel with identity",
      prompt: "Wait",
      agentType: AGENT_IDS.GENERAL,
      storageMode: "local",
    });
    await waitUntil(
      async () =>
        (await manager.getAgent(canceledTask.threadId))?.status === "running",
    );
    await manager.cancelAgent(canceledTask.threadId, AGENT_PAUSE_CANCEL_REASON);

    const terminal = (type: string, agentId: string) =>
      appendedEvents.find(
        (event) =>
          event.type === type &&
          (event.payload as { agentId?: string }).agentId === agentId,
      );
    expect(terminal("agent-failed", failedTask.threadId)).toMatchObject({
      eventId: `${failedTask.threadId}:1:agent-failed`,
      payload: { attemptGeneration: 1 },
    });
    expect(terminal("agent-canceled", canceledTask.threadId)).toMatchObject({
      eventId: `${canceledTask.threadId}:1:agent-canceled`,
      payload: { attemptGeneration: 1 },
    });
  });

  it("starts spawn_manager with the spawning Orchestrator model snapshot in a customized existing home", async () => {
    let harness = createHarness();
    await mkdir(path.join(harness.rootPath, "agents"), { recursive: true });
    const customizedPrompt = "My customized orchestrator prompt stays intact.";
    await writeFile(
      path.join(harness.rootPath, "agents", "orchestrator.md"),
      customizedPrompt,
      "utf8",
    );
    runMock.handler = async (args) => {
      expect(args.agentType).toBe(AGENT_IDS.MANAGER);
      await reportFromMockManager(
        args,
        "Consolidated first-turn report.",
        true,
        "first-turn-final",
      );
      return {
        runId: "manager-first-turn",
        result: "Private first-turn final text.",
      };
    };
    const snapshot: AgentModelConfigSnapshot = {
      engine: "default",
      routeModel: "stella/openai/gpt-5.6-sol",
      reasoningEffort: "high",
    };

    const result = await handleSpawnManager(
      {
        stateRoot: harness.rootPath,
        tasks: new Map(),
        agentApi: harness.manager,
      },
      { prompt: "Coordinate one verification and report." },
      {
        conversationId: "conversation-model-inheritance",
        deviceId: "device-manager-test",
        requestId: "spawn-manager-1",
        agentType: AGENT_IDS.ORCHESTRATOR,
        storageMode: "local",
        modelConfigSnapshot: snapshot,
      },
    );

    const threadId = (result.result as { thread_id: string }).thread_id;
    await waitUntil(
      async () =>
        (await harness.manager.getAgent(threadId))?.status === "completed",
    );
    expect(harness.fetchedModelConfigs).toContainEqual(snapshot);
    expect(harness.store.getAgentRecord(threadId)?.modelConfigSnapshot).toEqual(
      snapshot,
    );
    expect(
      await readFile(
        path.join(harness.rootPath, "agents", "orchestrator.md"),
        "utf8",
      ),
    ).toBe(customizedPrompt);

    // Simulate a Manager row created by the pre-snapshot build. Its first
    // explicit send_input after update inherits the current Orchestrator
    // route, then persists it for every later resume.
    harness.db
      .prepare(
        "UPDATE runtime_agents SET model_config_json = NULL WHERE thread_id = ?",
      )
      .run(threadId);
    await closeHarness(harness, { removeRoot: false });
    harness = createHarness({ rootPath: harness.rootPath });
    runMock.handler = async (args) => {
      await reportFromMockManager(
        args,
        "Resumed on the inherited route.",
        true,
        "resumed-final",
      );
      return {
        runId: "manager-resumed-turn",
        result: "Private resumed final text.",
      };
    };
    await handleSendInput(
      {
        stateRoot: harness.rootPath,
        tasks: new Map(),
        agentApi: harness.manager,
      },
      {
        thread_id: threadId,
        description: "Resume manager",
        message: "Resume and confirm the final state.",
      },
      {
        conversationId: "conversation-model-inheritance",
        deviceId: "device-manager-test",
        requestId: "resume-manager-1",
        agentType: AGENT_IDS.ORCHESTRATOR,
        storageMode: "local",
        modelConfigSnapshot: snapshot,
      },
    );
    await waitUntil(() =>
      harness.sentMessages.some((message) =>
        message.text.includes("Resumed on the inherited route."),
      ),
    );
    expect((await harness.manager.getAgent(threadId))?.status).toBe(
      "completed",
    );
    expect(harness.fetchedModelConfigs).toContainEqual(snapshot);
    expect(harness.store.getAgentRecord(threadId)?.modelConfigSnapshot).toEqual(
      snapshot,
    );
  });

  it("uses an explicit fallback and never leaks Manager finalized text when no final report is called", async () => {
    const { manager, appendedEvents, sentMessages } = createHarness();
    runMock.handler = async () => ({
      runId: "manager-no-report",
      result: "SECRET PRIVATE MANAGER FINALIZED TEXT",
    });

    const task = await manager.createAgent({
      conversationId: "conversation-manager-no-report",
      description: "Finish without report",
      prompt: "End without calling report.",
      agentType: AGENT_IDS.MANAGER,
      agentDepth: 1,
      storageMode: "local",
    });
    await waitUntil(
      async () =>
        (await manager.getAgent(task.threadId))?.status === "completed",
    );

    const terminal = appendedEvents.find(
      (event) =>
        event.type === "agent-completed" &&
        (event.payload as { agentId?: string }).agentId === task.threadId,
    );
    expect(terminal?.payload).toMatchObject({
      result: MANAGER_MISSING_FINAL_REPORT_FALLBACK,
    });
    expect(JSON.stringify({ appendedEvents, sentMessages })).toContain(
      MANAGER_MISSING_FINAL_REPORT_FALLBACK,
    );
    expect(JSON.stringify({ appendedEvents, sentMessages })).not.toContain(
      "SECRET PRIVATE MANAGER FINALIZED TEXT",
    );
  });

  it("uses the fallback when an external-input turn ends without any report", async () => {
    const { manager, store, appendedEvents, sentMessages } = createHarness();
    const managerRuns: MockRunArgs[] = [];
    runMock.handler = async (args) => {
      managerRuns.push(args);
      if (managerRuns.length === 1) {
        await reportFromMockManager(
          args,
          "Waiting for the orchestrator's answer.",
          false,
          "external-fallback-question",
        );
        return { runId: "question", result: "Private question response." };
      }
      return {
        runId: "external-no-report",
        result: "SECRET EXTERNAL INPUT FINALIZED TEXT",
      };
    };

    const task = await manager.createAgent({
      conversationId: "conversation-manager-external-no-report",
      description: "Wait for an external answer",
      prompt: "Ask for required input, then wait.",
      agentType: AGENT_IDS.MANAGER,
      agentDepth: 1,
      storageMode: "local",
    });
    await waitUntil(
      () =>
        sentMessages.some((message) =>
          message.text.includes("Waiting for the orchestrator's answer."),
        ) && !hasInFlightAttempt(manager, task.threadId),
    );
    expect(store.getAgentRecord(task.threadId)).toMatchObject({
      status: "running",
      managerReportIds: ["external-fallback-question"],
      managerReportSequence: 1,
    });

    await manager.sendAgentMessage(
      task.threadId,
      "Here is the requested answer.",
      "orchestrator",
      { deliveryKind: "external-input" },
    );
    await waitUntil(
      async () =>
        (await manager.getAgent(task.threadId))?.status === "completed",
    );

    const completions = appendedEvents.filter(
      (event) =>
        event.type === "agent-completed" &&
        (event.payload as { agentId?: string }).agentId === task.threadId,
    );
    expect(completions).toHaveLength(1);
    expect(completions[0]?.payload).toMatchObject({
      result: MANAGER_MISSING_FINAL_REPORT_FALLBACK,
    });
    expect(JSON.stringify({ appendedEvents, sentMessages })).not.toContain(
      "SECRET EXTERNAL INPUT FINALIZED TEXT",
    );
  });

  it("rejects a final report while managed children are active and accepts it at fleet idle", async () => {
    const { manager, store, appendedEvents } = createHarness();
    let releaseFirstManager!: () => void;
    const firstManagerGate = new Promise<void>((resolve) => {
      releaseFirstManager = resolve;
    });
    let releaseChild!: () => void;
    const childGate = new Promise<void>((resolve) => {
      releaseChild = resolve;
    });
    const managerRuns: MockRunArgs[] = [];
    let premature:
      | { accepted: boolean; final: boolean; reason?: string }
      | undefined;
    let accepted:
      | { accepted: boolean; final: boolean; reason?: string }
      | undefined;
    runMock.handler = async (args) => {
      if (args.agentType !== AGENT_IDS.MANAGER) {
        await childGate;
        return { runId: "active-child", result: "Child settled." };
      }
      managerRuns.push(args);
      if (managerRuns.length === 1) {
        await firstManagerGate;
        premature = await reportFromMockManager(
          args,
          "Premature final report.",
          true,
          "fleet-final",
        );
        return { runId: "premature-final", result: "Private premature text." };
      }
      accepted = await reportFromMockManager(
        args,
        "Correct fleet-idle final report.",
        true,
        "fleet-final",
      );
      return { runId: "fleet-idle-final", result: "Private corrected text." };
    };

    const task = await manager.createAgent({
      conversationId: "conversation-manager-active-final",
      description: "Coordinate one active child",
      prompt: "Wait for the child before reporting final.",
      agentType: AGENT_IDS.MANAGER,
      agentDepth: 1,
      storageMode: "local",
    });
    await manager.createAgent({
      conversationId: "conversation-manager-active-final",
      description: "Finish managed work",
      prompt: "Settle the managed work.",
      agentType: AGENT_IDS.GENERAL,
      agentDepth: 2,
      maxAgentDepth: 2,
      parentAgentId: task.threadId,
      storageMode: "local",
    });
    releaseFirstManager();
    await waitUntil(() => premature !== undefined);
    expect(premature).toMatchObject({
      accepted: false,
      final: true,
      reason: expect.stringMatching(/after all managed children have settled/i),
    });
    expect(
      store.getAgentRecord(task.threadId)?.managerFinalReport,
    ).toBeUndefined();
    expect(
      store.getAgentRecord(task.threadId)?.managerReportIds,
    ).toBeUndefined();

    releaseChild();
    await waitUntil(
      async () =>
        (await manager.getAgent(task.threadId))?.status === "completed",
    );
    expect(accepted).toMatchObject({ accepted: true, final: true });
    expect(store.getAgentRecord(task.threadId)).toMatchObject({
      status: "completed",
      result: "Correct fleet-idle final report.",
      managerFinalReport: "Correct fleet-idle final report.",
      managerFinalReportId: "fleet-final",
      managerReportIds: ["fleet-final"],
    });
    expect(
      appendedEvents.filter(
        (event) =>
          event.type === "agent-completed" &&
          (event.payload as { agentId?: string }).agentId === task.threadId,
      ),
    ).toHaveLength(1);
  });

  it("recovers an accepted final report exactly once after a worker restart", async () => {
    const first = createHarness();
    let accepted!: () => void;
    const acceptedReport = new Promise<void>((resolve) => {
      accepted = resolve;
    });
    runMock.handler = async (args) => {
      const outcome = await reportFromMockManager(
        args,
        "Durable restart final report.",
        true,
        "restart-final",
      );
      expect(outcome).toMatchObject({ accepted: true, final: true });
      accepted();
      await new Promise<never>(() => {});
    };

    const task = await first.manager.createAgent({
      conversationId: "conversation-manager-restart-final",
      description: "Persist a final before restart",
      prompt: "Submit the final report, then stop.",
      agentType: AGENT_IDS.MANAGER,
      agentDepth: 1,
      storageMode: "local",
    });
    await acceptedReport;
    expect(first.store.getAgentRecord(task.threadId)).toMatchObject({
      status: "running",
      managerFinalReport: "Durable restart final report.",
      managerFinalReportId: "restart-final",
      managerReportIds: ["restart-final"],
      managerReportSequence: 0,
    });

    const rootPath = first.rootPath;
    harnesses.delete(first);
    first.db.close();

    const recovered = createHarness({ rootPath });
    await waitUntil(() =>
      recovered.sentMessages.some((message) =>
        message.text.includes("Durable restart final report."),
      ),
    );
    expect(recovered.store.getAgentRecord(task.threadId)).toMatchObject({
      status: "completed",
      result: "Durable restart final report.",
      managerFinalReportId: "restart-final",
    });
    expect(
      recovered.appendedEvents.filter(
        (event) =>
          event.type === "agent-completed" &&
          (event.payload as { agentId?: string }).agentId === task.threadId,
      ),
    ).toHaveLength(1);
    expect(
      recovered.sentMessages.filter((message) =>
        message.text.includes("Durable restart final report."),
      ),
    ).toHaveLength(1);

    await closeHarness(recovered, { removeRoot: false });
    const repeatedRestart = createHarness({ rootPath });
    expect(repeatedRestart.appendedEvents).toHaveLength(0);
    expect(repeatedRestart.sentMessages).toHaveLength(0);
    expect(repeatedRestart.store.getAgentRecord(task.threadId)?.status).toBe(
      "completed",
    );
  });

  it("completes a restarted Manager with the fallback when no final report was accepted", async () => {
    const first = createHarness();
    runMock.handler = async () => await new Promise<never>(() => {});

    const task = await first.manager.createAgent({
      conversationId: "conversation-manager-restart-no-final",
      description: "Restart before a final report",
      prompt: "Keep working until the process stops.",
      agentType: AGENT_IDS.MANAGER,
      agentDepth: 1,
      storageMode: "local",
    });
    await waitUntil(
      () => first.store.getAgentRecord(task.threadId)?.status === "running",
    );
    expect(
      first.store.getAgentRecord(task.threadId)?.managerFinalReport,
    ).toBeUndefined();

    const rootPath = first.rootPath;
    harnesses.delete(first);
    first.db.close();

    const recovered = createHarness({ rootPath });
    await waitUntil(() =>
      recovered.sentMessages.some((message) =>
        message.text.includes(MANAGER_MISSING_FINAL_REPORT_FALLBACK),
      ),
    );
    expect(recovered.store.getAgentRecord(task.threadId)).toMatchObject({
      status: "completed",
      result: MANAGER_MISSING_FINAL_REPORT_FALLBACK,
    });
    expect(
      recovered.appendedEvents.filter(
        (event) =>
          event.type === "agent-completed" &&
          (event.payload as { agentId?: string }).agentId === task.threadId,
      ),
    ).toHaveLength(1);
  });

  it("seals spawn and adoption after accepting the final report", async () => {
    const { manager, appendedEvents } = createHarness();
    let releaseManager!: () => void;
    const managerGate = new Promise<void>((resolve) => {
      releaseManager = resolve;
    });
    let releaseStandalone!: () => void;
    const standaloneGate = new Promise<void>((resolve) => {
      releaseStandalone = resolve;
    });
    let finalAccepted!: () => void;
    const finalAcceptedGate = new Promise<void>((resolve) => {
      finalAccepted = resolve;
    });
    runMock.handler = async (args) => {
      if (args.agentType === AGENT_IDS.MANAGER) {
        expect(
          await reportFromMockManager(
            args,
            "Fleet-sealed final report.",
            true,
            "sealed-final",
          ),
        ).toMatchObject({ accepted: true, final: true });
        finalAccepted();
        await managerGate;
        return { runId: "sealed-manager", result: "Private sealed text." };
      }
      await standaloneGate;
      return { runId: "standalone-adoption-target", result: "Settled." };
    };

    const standalone = await manager.createAgent({
      conversationId: "conversation-manager-sealed-fleet",
      description: "Remain available for adoption",
      prompt: "Wait.",
      agentType: AGENT_IDS.GENERAL,
      agentDepth: 1,
      storageMode: "local",
    });
    const task = await manager.createAgent({
      conversationId: "conversation-manager-sealed-fleet",
      description: "Seal the fleet",
      prompt: "Report final at fleet idle.",
      agentType: AGENT_IDS.MANAGER,
      agentDepth: 1,
      storageMode: "local",
    });
    await finalAcceptedGate;

    await expect(
      manager.createAgent({
        conversationId: "conversation-manager-sealed-fleet",
        description: "Late child",
        prompt: "This must not start.",
        agentType: AGENT_IDS.GENERAL,
        agentDepth: 2,
        parentAgentId: task.threadId,
        storageMode: "local",
      }),
    ).rejects.toThrow(/sealed its fleet/i);
    await expect(
      manager.adoptAgent(standalone.threadId, task.threadId),
    ).resolves.toMatchObject({
      adopted: false,
      reason: expect.stringMatching(/sealed the fleet/i),
    });

    releaseManager();
    await waitUntil(
      async () =>
        (await manager.getAgent(task.threadId))?.status === "completed",
    );
    expect(
      appendedEvents.filter(
        (event) =>
          event.type === "agent-completed" &&
          (event.payload as { agentId?: string }).agentId === task.threadId,
      ),
    ).toHaveLength(1);
    expect((await manager.getAgent(task.threadId))?.result).toBe(
      "Fleet-sealed final report.",
    );
    releaseStandalone();
  });

  it("recovers exactly once when Manager completion crashes after the event append", async () => {
    const first = createHarness();
    let releaseManager!: () => void;
    const managerGate = new Promise<void>((resolve) => {
      releaseManager = resolve;
    });
    let finalAccepted!: () => void;
    const finalAcceptedGate = new Promise<void>((resolve) => {
      finalAccepted = resolve;
    });
    runMock.handler = async (args) => {
      await reportFromMockManager(
        args,
        "Crash-safe final report.",
        true,
        "crash-safe-final",
      );
      finalAccepted();
      await managerGate;
      return { runId: "crash-gap-manager", result: "Private crash text." };
    };

    const task = await first.manager.createAgent({
      conversationId: "conversation-manager-completion-crash-gap",
      description: "Crash between event and terminal row",
      prompt: "Submit the final report, then stop.",
      agentType: AGENT_IDS.MANAGER,
      agentDepth: 1,
      storageMode: "local",
    });
    await finalAcceptedGate;

    const originalSaveAgentRecord = first.store.saveAgentRecord.bind(
      first.store,
    );
    let crashInjected = false;
    vi.spyOn(first.store, "saveAgentRecord").mockImplementation((record) => {
      if (
        !crashInjected &&
        record.threadId === task.threadId &&
        record.status === "completed"
      ) {
        crashInjected = true;
        throw new Error("Injected crash after Manager completion event append");
      }
      originalSaveAgentRecord(record);
    });
    releaseManager();
    await waitUntil(
      () =>
        crashInjected &&
        first.appendedEvents.some(
          (event) =>
            event.type === "agent-completed" &&
            (event.payload as { agentId?: string }).agentId === task.threadId,
        ),
    );
    expect(first.store.getAgentRecord(task.threadId)).toMatchObject({
      status: "running",
      managerFinalReport: "Crash-safe final report.",
    });
    expect(
      first.appendedEvents.filter(
        (event) =>
          event.type === "agent-completed" &&
          (event.payload as { agentId?: string }).agentId === task.threadId,
      ),
    ).toHaveLength(1);

    const rootPath = first.rootPath;
    harnesses.delete(first);
    first.db.close();

    const recovered = createHarness({ rootPath });
    expect(recovered.appendedEvents).toHaveLength(0);
    expect(recovered.sentMessages).toHaveLength(0);
    expect(recovered.store.getAgentRecord(task.threadId)).toMatchObject({
      status: "completed",
      result: "Crash-safe final report.",
    });
    expect(
      recovered.store.hasEvent(
        "conversation-manager-completion-crash-gap",
        `${task.threadId}:1:agent-completed`,
        "agent-completed",
      ),
    ).toBe(true);
  });

  it("repairs the orchestrator reminder when completion crashes after the Activity event", async () => {
    const first = createHarness();
    const conversationId = "conversation-manager-reminder-crash-gap";
    let releaseManager!: () => void;
    const managerGate = new Promise<void>((resolve) => {
      releaseManager = resolve;
    });
    let finalAccepted!: () => void;
    const finalAcceptedGate = new Promise<void>((resolve) => {
      finalAccepted = resolve;
    });
    runMock.handler = async (args) => {
      await reportFromMockManager(
        args,
        "Reminder crash-safe final report.",
        true,
        "reminder-crash-safe-final",
      );
      finalAccepted();
      await managerGate;
      return {
        runId: "reminder-crash-gap-manager",
        result: "Private reminder crash text.",
      };
    };

    const task = await first.manager.createAgent({
      conversationId,
      description: "Crash between Activity and reminder",
      prompt: "Submit the final report, then stop.",
      agentType: AGENT_IDS.MANAGER,
      agentDepth: 1,
      storageMode: "local",
    });
    await finalAcceptedGate;
    const attemptGeneration = first.store.getAgentRecord(
      task.threadId,
    )?.attemptGeneration;
    expect(attemptGeneration).toBeTypeOf("number");
    const completionEventId = `${task.threadId}:${attemptGeneration}:agent-completed`;
    const orchestratorThreadId = resolveOrchestratorThreadKey(conversationId);

    const originalAppendThreadCustomMessage =
      first.store.appendThreadCustomMessage.bind(first.store);
    let crashInjected = false;
    vi.spyOn(first.store, "appendThreadCustomMessage").mockImplementation(
      (message) => {
        if (
          !crashInjected &&
          message.threadKey === orchestratorThreadId &&
          message.eventId === completionEventId &&
          message.customType === "runtime.task_lifecycle"
        ) {
          crashInjected = true;
          throw new Error(
            "Injected crash between Activity event and orchestrator reminder",
          );
        }
        originalAppendThreadCustomMessage(message);
      },
    );
    releaseManager();
    await waitUntil(() => crashInjected);

    expect(
      first.store.hasEvent(
        conversationId,
        completionEventId,
        "agent-completed",
      ),
    ).toBe(true);
    expect(
      first.store
        .loadThreadMessages(orchestratorThreadId)
        .filter(
          (message) => message.customMessage?.eventId === completionEventId,
        ),
    ).toHaveLength(0);
    expect(first.store.getAgentRecord(task.threadId)).toMatchObject({
      status: "running",
      managerFinalReport: "Reminder crash-safe final report.",
    });
    expect(
      first.sentMessages.filter((message) =>
        message.text.includes("Reminder crash-safe final report."),
      ),
    ).toHaveLength(0);

    const rootPath = first.rootPath;
    harnesses.delete(first);
    first.db.close();

    const recovered = createHarness({ rootPath });
    await waitUntil(() =>
      recovered.sentMessages.some((message) =>
        message.text.includes("Reminder crash-safe final report."),
      ),
    );
    expect(recovered.appendedEvents).toHaveLength(0);
    expect(recovered.store.getAgentRecord(task.threadId)).toMatchObject({
      status: "completed",
      result: "Reminder crash-safe final report.",
    });
    const recoveredReminders = recovered.store
      .loadThreadMessages(orchestratorThreadId)
      .filter(
        (message) => message.customMessage?.eventId === completionEventId,
      );
    expect(recoveredReminders).toHaveLength(1);
    expect(JSON.stringify(recoveredReminders[0])).toContain(
      "Reminder crash-safe final report.",
    );
    expect(
      recovered.sentMessages.filter((message) =>
        message.text.includes("Reminder crash-safe final report."),
      ),
    ).toHaveLength(1);

    await closeHarness(recovered, { removeRoot: false });
    const repeatedRestart = createHarness({ rootPath });
    expect(repeatedRestart.appendedEvents).toHaveLength(0);
    expect(repeatedRestart.sentMessages).toHaveLength(0);
    expect(
      repeatedRestart.store
        .loadThreadMessages(orchestratorThreadId)
        .filter(
          (message) => message.customMessage?.eventId === completionEventId,
        ),
    ).toHaveLength(1);
    expect(repeatedRestart.store.getAgentRecord(task.threadId)).toMatchObject({
      status: "completed",
      result: "Reminder crash-safe final report.",
    });
  });

  it("repairs an intermediate report acknowledgement without re-emitting the durable update", async () => {
    const harness = createHarness();
    let releaseReport!: () => void;
    const reportGate = new Promise<void>((resolve) => {
      releaseReport = resolve;
    });
    let retryCompleted = false;
    runMock.handler = async (args) => {
      await reportGate;
      const taskState = (
        harness.manager as unknown as {
          tasks: Map<
            string,
            {
              managerReportIds: Set<string>;
              managerReportSequence: number;
            }
          >;
        }
      ).tasks.get(args.agentId!);
      await expect(
        reportFromMockManager(
          args,
          "Durable intermediate update.",
          false,
          "intermediate-crash-gap",
        ),
      ).rejects.toThrow(/Injected intermediate acknowledgement crash/);
      taskState?.managerReportIds.delete("intermediate-crash-gap");
      if (taskState) taskState.managerReportSequence = 0;
      expect(
        await reportFromMockManager(
          args,
          "Durable intermediate update.",
          false,
          "intermediate-crash-gap",
        ),
      ).toMatchObject({ accepted: true, final: false });
      retryCompleted = true;
      return { runId: "intermediate-retry", result: "Private update text." };
    };

    const task = await harness.manager.createAgent({
      conversationId: "conversation-manager-intermediate-crash-gap",
      description: "Repair intermediate acknowledgement",
      prompt: "Send one intermediate update.",
      agentType: AGENT_IDS.MANAGER,
      agentDepth: 1,
      storageMode: "local",
    });
    await waitUntil(
      () => harness.store.getAgentRecord(task.threadId)?.status === "running",
    );
    const originalSaveAgentRecord = harness.store.saveAgentRecord.bind(
      harness.store,
    );
    let crashInjected = false;
    vi.spyOn(harness.store, "saveAgentRecord").mockImplementation((record) => {
      if (
        !crashInjected &&
        record.threadId === task.threadId &&
        record.managerReportIds?.includes("intermediate-crash-gap")
      ) {
        crashInjected = true;
        throw new Error("Injected intermediate acknowledgement crash");
      }
      originalSaveAgentRecord(record);
    });
    releaseReport();
    await waitUntil(() => retryCompleted);

    expect(
      harness.sentMessages.filter((message) =>
        message.text.includes("Durable intermediate update."),
      ),
    ).toHaveLength(1);
    expect(harness.store.getAgentRecord(task.threadId)).toMatchObject({
      status: "running",
      managerReportIds: ["intermediate-crash-gap"],
      managerReportSequence: 1,
    });
  });

  it("routes child completion exclusively to the manager and keeps a status answer non-terminal", async () => {
    const { manager, store, appendedEvents, sentMessages } = createHarness();
    let releaseManagerFirst!: () => void;
    const managerFirstGate = new Promise<void>((resolve) => {
      releaseManagerFirst = resolve;
    });
    let releaseChildA!: () => void;
    const childAGate = new Promise<void>((resolve) => {
      releaseChildA = resolve;
    });
    let releaseChildB!: () => void;
    const childBGate = new Promise<void>((resolve) => {
      releaseChildB = resolve;
    });
    const childAThreadId = "managed-child-a";
    const childBThreadId = "managed-child-b";
    let childBRuns = 0;
    const managerPrompts: string[] = [];
    const managerRuns: MockRunArgs[] = [];
    runMock.handler = async (args) => {
      if (args.agentType === AGENT_IDS.MANAGER) {
        managerRuns.push(args);
        managerPrompts.push(args.userPrompt);
        if (managerPrompts.length === 1) {
          await managerFirstGate;
          return { runId: "manager-1", result: "Waiting for child." };
        }
        if (managerPrompts.length === 2) {
          await reportFromMockManager(
            args,
            "Child still running.",
            false,
            "status-update",
          );
          return {
            runId: "manager-2",
            result: "Private Manager status response.",
          };
        }
        if (managerPrompts.length === 3) {
          return {
            runId: "manager-3",
            result: "Steering acknowledged; child still running.",
          };
        }
        if (managerPrompts.length === 4) {
          return {
            runId: "manager-4",
            result: "Child A is complete; Child B is still running.",
          };
        }
        await reportFromMockManager(
          args,
          "Final consolidated report.",
          true,
          "final-report",
        );
        return { runId: "manager-5", result: "Private Manager final text." };
      }
      if (args.agentId === childAThreadId) {
        await childAGate;
        return { runId: "child-a", result: "Child A finished cleanly." };
      }
      if (args.agentId === childBThreadId) {
        childBRuns += 1;
        if (childBRuns === 1) {
          await waitForAbort(args.abortSignal);
          return {
            runId: "child-b-interrupted",
            result: "",
            interrupted: true,
          };
        }
        await childBGate;
        return { runId: "child-b", result: "Child B passed recheck." };
      }
      return { runId: "standalone", result: "Standalone agent finished." };
    };

    const managerTask = await manager.createAgent({
      conversationId: "conversation-status",
      description: "Coordinate status test",
      prompt: "Coordinate and report once.",
      agentType: AGENT_IDS.MANAGER,
      agentDepth: 1,
      storageMode: "local",
    });
    const childTask = await manager.createAgent({
      threadId: childAThreadId,
      conversationId: "conversation-status",
      description: "Run child verification",
      prompt: "Verify the claim.",
      agentType: AGENT_IDS.GENERAL,
      agentDepth: 2,
      maxAgentDepth: 2,
      parentAgentId: managerTask.threadId,
      storageMode: "local",
    });
    const childTaskB = await manager.createAgent({
      threadId: childBThreadId,
      conversationId: "conversation-status",
      description: "Run second child verification",
      prompt: "Verify the second claim.",
      agentType: AGENT_IDS.GENERAL,
      agentDepth: 2,
      maxAgentDepth: 2,
      parentAgentId: managerTask.threadId,
      storageMode: "local",
    });
    releaseManagerFirst();
    await waitUntil(() => managerPrompts.length === 1);
    await manager.sendAgentMessage(
      managerTask.threadId,
      "Give me a status update, then continue.",
      "orchestrator",
      { deliveryKind: "external-input" },
    );
    await waitUntil(() =>
      sentMessages.some((message) => message.text.includes("[Agent update]")),
    );

    const interim = sentMessages.find((message) =>
      message.text.includes("[Agent update]"),
    );
    expect(interim).toMatchObject({
      customType: "runtime.task_update",
      responseTarget: {
        type: "agent_turn",
        agentId: managerTask.threadId,
      },
    });
    expect(interim?.text).toContain("Child still running.");
    expect(managerPrompts[1]).toContain("Use report(final=false)");
    expect((await manager.getAgent(managerTask.threadId))?.status).toBe(
      "running",
    );
    expect(store.getAgentRecord(managerTask.threadId)?.status).toBe("running");
    expect(appendedEvents.some((event) => event.type === "agent-message")).toBe(
      false,
    );
    expect(
      store
        .listActivity("conversation-status")
        .activities.some((activity) => activity.type === "agent-message"),
    ).toBe(false);
    expect(
      appendedEvents.some(
        (event) =>
          event.type === "agent-completed" &&
          (event.payload as { agentId?: string })?.agentId ===
            managerTask.threadId,
      ),
    ).toBe(false);
    expect(
      sentMessages.some((message) =>
        message.text.includes("Child A finished cleanly."),
      ),
    ).toBe(false);

    await manager.sendAgentMessage(
      managerTask.threadId,
      "Prioritize the child's verification, then finish normally.",
      "orchestrator",
      { deliveryKind: "external-input" },
    );
    await waitUntil(() => managerPrompts.length === 3);
    expect(managerPrompts[2]).toContain("If it changes instructions");
    expect(JSON.stringify(sentMessages)).not.toContain(
      "Steering acknowledged; child still running.",
    );
    expect((await manager.getAgent(managerTask.threadId))?.status).toBe(
      "running",
    );
    expect(
      appendedEvents.some(
        (event) =>
          event.type === "agent-completed" &&
          (event.payload as { agentId?: string })?.agentId ===
            managerTask.threadId,
      ),
    ).toBe(false);

    await waitUntil(() => childBRuns === 1);
    await manager.sendAgentMessage(
      childTaskB.threadId,
      "Recheck the second result before reporting.",
      "orchestrator",
      {
        description: "Recheck child B",
        parentAgentId: managerTask.threadId,
        deliveryKind: "external-input",
      },
    );
    await waitUntil(() => childBRuns === 2);

    releaseChildA();
    await waitUntil(() => managerPrompts.length === 4);
    releaseChildB();
    await waitUntil(async () =>
      ["completed", "error", "canceled"].includes(
        (await manager.getAgent(managerTask.threadId))?.status ?? "",
      ),
    );
    expect(managerPrompts[3]).toContain("newly persisted managed-child event");
    expect(historyText(managerRuns[3]!)).toContain("Child A finished cleanly.");
    expect(managerPrompts[4]).toContain("newly persisted managed-child event");
    expect(historyText(managerRuns[4]!)).toContain("Child B passed recheck.");
    expect(
      appendedEvents.some(
        (event) =>
          event.type === "agent-completed" &&
          (event.payload as { agentId?: string })?.agentId ===
            childTask.threadId,
      ),
    ).toBe(false);
    expect(
      appendedEvents.some(
        (event) =>
          event.type === "agent-completed" &&
          (event.payload as { agentId?: string })?.agentId ===
            childTaskB.threadId,
      ),
    ).toBe(false);
    expect(
      appendedEvents.filter(
        (event) =>
          event.type === "agent-completed" &&
          (event.payload as { agentId?: string })?.agentId ===
            managerTask.threadId,
      ),
    ).toHaveLength(1);
    expect(managerRuns).toHaveLength(5);

    const rootLifecycleEvents = appendedEvents.filter((event) =>
      [
        "agent-started",
        "agent-completed",
        "agent-failed",
        "agent-canceled",
      ].includes(event.type),
    );
    expect(
      rootLifecycleEvents.map((event) => ({
        type: event.type,
        agentId: (event.payload as { agentId?: string }).agentId,
      })),
    ).toEqual([
      { type: "agent-started", agentId: managerTask.threadId },
      { type: "agent-started", agentId: managerTask.threadId },
      { type: "agent-started", agentId: managerTask.threadId },
      { type: "agent-completed", agentId: managerTask.threadId },
    ]);
    const visibleStartGenerations = rootLifecycleEvents
      .filter((event) => event.type === "agent-started")
      .map(
        (event) =>
          (event.payload as { attemptGeneration?: number }).attemptGeneration,
      );
    expect(
      visibleStartGenerations.every(
        (generation) => typeof generation === "number",
      ),
    ).toBe(true);
    expect(visibleStartGenerations).toEqual(
      [...visibleStartGenerations].sort((a, b) => (a ?? 0) - (b ?? 0)),
    );
    const managerTerminal = rootLifecycleEvents.find(
      (event) => event.type === "agent-completed",
    );
    const terminalGeneration = (
      managerTerminal?.payload as { attemptGeneration?: number } | undefined
    )?.attemptGeneration;
    expect(terminalGeneration).toBe(
      store.getAgentRecord(managerTask.threadId)?.attemptGeneration,
    );
    expect(managerTerminal?.eventId).toBe(
      `${managerTask.threadId}:${terminalGeneration}:agent-completed`,
    );
    expect(JSON.stringify(rootLifecycleEvents)).not.toContain(
      "Continuing managed work",
    );
    expect(JSON.stringify(rootLifecycleEvents)).not.toContain(
      "A managed child reached a terminal state",
    );
    expect(JSON.stringify(sentMessages)).not.toContain(
      "A managed child reached a terminal state",
    );
    expect(
      sentMessages.find((message) =>
        message.text.includes("Final consolidated report."),
      ),
    ).toMatchObject({
      responseTarget: {
        type: "agent_terminal_notice",
        agentId: managerTask.threadId,
        terminalState: "completed",
      },
    });

    const managerHistory = JSON.stringify(
      store.loadThreadMessages(managerTask.threadId),
    );
    expect(managerHistory).toContain(
      "A managed child reached a terminal state",
    );
    expect(managerHistory).toContain("Child A finished cleanly.");
    expect(managerHistory).toContain("Child B passed recheck.");

    const activity = store.listThreadActivity("conversation-status");
    expect(activity.map((record) => record.threadId).sort()).toEqual(
      [managerTask.threadId, childTask.threadId, childTaskB.threadId].sort(),
    );
    expect(
      activity.find((record) => record.threadId === childTask.threadId),
    ).toMatchObject({
      parentAgentId: managerTask.threadId,
      status: "completed",
      result: "Child A finished cleanly.",
    });
    expect(
      activity.find((record) => record.threadId === childTaskB.threadId),
    ).toMatchObject({
      parentAgentId: managerTask.threadId,
      status: "completed",
      result: "Child B passed recheck.",
    });

    const standalone = await manager.createAgent({
      conversationId: "conversation-status",
      description: "Run standalone check",
      prompt: "Run standalone check.",
      agentType: AGENT_IDS.GENERAL,
      agentDepth: 1,
      storageMode: "local",
    });
    await waitUntil(
      async () =>
        (await manager.getAgent(standalone.threadId))?.status === "completed",
    );
    expect(
      appendedEvents
        .filter(
          (event) =>
            (event.payload as { agentId?: string }).agentId ===
            standalone.threadId,
        )
        .map((event) => event.type),
    ).toEqual(["agent-started", "agent-completed"]);
  });

  it("keeps transitive descendants private and completes root once from report at fleet idle", async () => {
    const { manager, store, appendedEvents, sentMessages } = createHarness();
    let releaseManagerFirst!: () => void;
    const managerFirstGate = new Promise<void>((resolve) => {
      releaseManagerFirst = resolve;
    });
    let releaseChild!: () => void;
    const childGate = new Promise<void>((resolve) => {
      releaseChild = resolve;
    });
    let releaseDescendant!: () => void;
    const descendantGate = new Promise<void>((resolve) => {
      releaseDescendant = resolve;
    });
    let releaseAudit!: () => void;
    const auditGate = new Promise<void>((resolve) => {
      releaseAudit = resolve;
    });
    const managerRuns: MockRunArgs[] = [];
    let descendantRuns = 0;
    runMock.handler = async (args) => {
      if (args.agentType === AGENT_IDS.MANAGER) {
        managerRuns.push(args);
        if (managerRuns.length === 1) {
          await managerFirstGate;
          return { runId: "manager-initial", result: "Delegated the work." };
        }
        if (managerRuns.length === 2) {
          return {
            runId: "manager-descendant-internal",
            result: "Internal descendant synthesis stays private.",
          };
        }
        if (managerRuns.length === 3) {
          return {
            runId: "manager-parent-reply",
            result: "Parent-visible steering reply.",
          };
        }
        if (managerRuns.length === 4) {
          await reportFromMockManager(
            args,
            "Public status while child remains active.",
            false,
            "transitive-status",
          );
          return {
            runId: "manager-public-status",
            result: "Private status response.",
          };
        }
        if (managerRuns.length === 5) {
          await reportFromMockManager(
            args,
            "Final child settled; audit still required.",
            false,
            "transitive-checkpoint",
          );
          return {
            runId: "manager-milestone",
            result: "Private checkpoint response.",
          };
        }
        await reportFromMockManager(
          args,
          "Fleet-idle consolidated final.",
          true,
          "transitive-final",
        );
        return {
          runId: "manager-final",
          result: "Private Manager final response.",
        };
      }
      if (args.agentId === "general-child") {
        await childGate;
        return { runId: "child-final", result: "General child complete." };
      }
      if (args.agentId === "nested-descendant") {
        descendantRuns += 1;
        if (descendantRuns === 1) {
          await waitForAbort(args.abortSignal);
          return { runId: "descendant-paused", result: "", interrupted: true };
        }
        await descendantGate;
        return {
          runId: "descendant-final",
          result: "Nested descendant complete.",
        };
      }
      if (args.agentId === "manager-audit") {
        await auditGate;
        return { runId: "audit-final", result: "Audit complete." };
      }
      throw new Error(`Unexpected agent ${args.agentId}`);
    };

    const managerTask = await manager.createAgent({
      threadId: "transitive-manager",
      conversationId: "conversation-transitive",
      description: "Coordinate nested work",
      prompt: "Coordinate the nested fleet.",
      agentType: AGENT_IDS.MANAGER,
      agentDepth: 1,
      maxAgentDepth: 4,
      storageMode: "local",
    });
    const child = await manager.createAgent({
      threadId: "general-child",
      conversationId: "conversation-transitive",
      description: "Own nested verification",
      prompt: "Verify and delegate one nested check.",
      agentType: AGENT_IDS.GENERAL,
      agentDepth: 2,
      maxAgentDepth: 4,
      parentAgentId: managerTask.threadId,
      storageMode: "local",
    });
    const descendant = await manager.createAgent({
      threadId: "nested-descendant",
      conversationId: "conversation-transitive",
      description: "Run nested check",
      prompt: "Run the nested check.",
      agentType: AGENT_IDS.GENERAL,
      agentDepth: 3,
      maxAgentDepth: 4,
      parentAgentId: child.threadId,
      storageMode: "local",
    });
    await waitUntil(() => descendantRuns === 1);
    await manager.sendAgentMessage(
      descendant.threadId,
      "Recheck before reporting upward.",
      "orchestrator",
      { deliveryKind: "external-input", parentAgentId: child.threadId },
    );
    await waitUntil(() => descendantRuns === 2);
    releaseManagerFirst();
    await waitUntil(
      () =>
        store.getAgentRecord(managerTask.threadId)?.status === "running" &&
        !hasInFlightAttempt(manager, managerTask.threadId),
    );

    releaseDescendant();
    await waitUntil(() => managerRuns.length === 2);
    expect(store.getAgentRecord(managerTask.threadId)).toMatchObject({
      status: "running",
    });
    expect(JSON.stringify(sentMessages)).not.toContain(
      "Internal descendant synthesis stays private.",
    );

    await manager.sendAgentMessage(
      managerTask.threadId,
      "Reply now, but keep coordinating the active child.",
      "orchestrator",
      { deliveryKind: "external-input" },
    );
    await waitUntil(() => managerRuns.length === 3);
    expect(JSON.stringify(sentMessages)).not.toContain(
      "Parent-visible steering reply.",
    );
    expect(store.getAgentRecord(managerTask.threadId)).toMatchObject({
      status: "running",
    });

    await manager.sendAgentMessage(
      managerTask.threadId,
      "Publish a status, then continue.",
      "orchestrator",
      { deliveryKind: "external-input" },
    );
    await waitUntil(() =>
      sentMessages.some((message) =>
        message.text.includes("Public status while child remains active."),
      ),
    );

    releaseChild();
    await waitUntil(() =>
      sentMessages.some((message) =>
        message.text.includes("Final child settled; audit still required."),
      ),
    );
    expect(store.getAgentRecord(managerTask.threadId)?.status).toBe("running");
    expect(
      appendedEvents.filter(
        (event) =>
          event.type === "agent-completed" &&
          (event.payload as { agentId?: string }).agentId ===
            managerTask.threadId,
      ),
    ).toHaveLength(0);

    const audit = await manager.createAgent({
      threadId: "manager-audit",
      conversationId: "conversation-transitive",
      description: "Run final audit",
      prompt: "Complete the final audit.",
      agentType: AGENT_IDS.GENERAL,
      agentDepth: 2,
      maxAgentDepth: 4,
      parentAgentId: managerTask.threadId,
      storageMode: "local",
    });
    releaseAudit();
    await waitUntil(
      async () =>
        (await manager.getAgent(managerTask.threadId))?.status === "completed",
    );
    expect(managerRuns).toHaveLength(6);
    expect(historyText(managerRuns[1]!)).toContain(
      "Nested descendant complete.",
    );
    expect(managerRuns[1]?.userPrompt).toContain(
      "newly persisted managed-child event",
    );
    expect(store.getAgentRecord(managerTask.threadId)).toMatchObject({
      status: "completed",
      result: "Fleet-idle consolidated final.",
    });

    const rootEvents = appendedEvents.filter((event) =>
      [
        "agent-started",
        "agent-completed",
        "agent-failed",
        "agent-canceled",
      ].includes(event.type),
    );
    expect(
      rootEvents.map((event) => ({
        type: event.type,
        agentId: (event.payload as { agentId?: string }).agentId,
      })),
    ).toEqual([
      { type: "agent-started", agentId: managerTask.threadId },
      { type: "agent-started", agentId: managerTask.threadId },
      { type: "agent-started", agentId: managerTask.threadId },
      { type: "agent-completed", agentId: managerTask.threadId },
    ]);
    const rootJson = JSON.stringify({ rootEvents, sentMessages });
    expect(rootJson).not.toContain("Nested descendant complete.");
    expect(rootJson).not.toContain("A managed child reached a terminal state");
    expect(rootJson).not.toContain("Recheck before reporting upward.");
    expect(
      sentMessages.filter((message) =>
        message.text.includes("Fleet-idle consolidated final."),
      ),
    ).toHaveLength(1);
    expect(
      sentMessages.find((message) =>
        message.text.includes("Fleet-idle consolidated final."),
      ),
    ).toMatchObject({
      responseTarget: {
        type: "agent_terminal_notice",
        agentId: managerTask.threadId,
        terminalState: "completed",
      },
    });
    const activity = store.listThreadActivity("conversation-transitive");
    expect(activity.map((record) => record.threadId).sort()).toEqual(
      [
        managerTask.threadId,
        child.threadId,
        descendant.threadId,
        audit.threadId,
      ].sort(),
    );
    expect(
      activity.find((record) => record.threadId === descendant.threadId),
    ).toMatchObject({
      parentAgentId: child.threadId,
      status: "completed",
      result: "Nested descendant complete.",
    });
  });

  it.each([
    "Status?",
    "Any update?",
    "Give me an update.",
    "What’s the current status?",
    "How’s the work going?",
    "Are you done yet?",
    "How far along are you?",
  ])(
    "keeps a natural-language status poke before the first child non-terminal: %s",
    async (statusRequest) => {
      const { manager, store, appendedEvents, sentMessages } = createHarness();
      const managerRuns: MockRunArgs[] = [];
      runMock.handler = async (args) => {
        managerRuns.push(args);
        if (managerRuns.length === 1) {
          await waitForAbort(args.abortSignal);
          return {
            runId: "planning-interrupted",
            result: "",
            interrupted: true,
          };
        }
        if (managerRuns.length === 2) {
          await reportFromMockManager(
            args,
            "Planning is underway; no child has started yet.",
            false,
            "planning-update",
          );
          return {
            runId: "planning-status",
            result: "Private planning response.",
          };
        }
        await reportFromMockManager(
          args,
          "Planning resumed and the process finished.",
          true,
          "planning-final",
        );
        return {
          runId: "planning-final",
          result: "Private Manager final response.",
        };
      };

      const task = await manager.createAgent({
        conversationId: "conversation-planning-status",
        description: "Plan managed work",
        prompt: "Plan the process before spawning the first child.",
        agentType: AGENT_IDS.MANAGER,
        agentDepth: 1,
        storageMode: "local",
      });
      await waitUntil(() => managerRuns.length === 1);
      await manager.sendAgentMessage(
        task.threadId,
        statusRequest,
        "orchestrator",
        { deliveryKind: "external-input" },
      );
      await waitUntil(() =>
        sentMessages.some((message) =>
          message.text.includes("Planning is underway; no child has started"),
        ),
      );

      expect(managerRuns[1]?.userPrompt).toContain(statusRequest);
      expect(managerRuns[1]?.userPrompt).toContain("Use report(final=false)");
      expect((await manager.getAgent(task.threadId))?.status).toBe("running");
      expect(store.getAgentRecord(task.threadId)?.status).toBe("running");
      expect(
        appendedEvents.filter(
          (event) =>
            event.type === "agent-completed" &&
            (event.payload as { agentId?: string })?.agentId === task.threadId,
        ),
      ).toHaveLength(0);

      await manager.sendAgentMessage(
        task.threadId,
        "Continue the planned process and finish it.",
        "orchestrator",
        { deliveryKind: "external-input" },
      );
      await waitUntil(() => managerRuns.length === 3);
      await waitUntil(() =>
        sentMessages.some((message) =>
          message.text.includes("Planning resumed and the process finished."),
        ),
      );
      expect(managerRuns).toHaveLength(3);
      expect(managerRuns[2]?.userPrompt).toContain(
        "Continue the planned process and finish it.",
      );
      expect(managerRuns[2]?.userPrompt).toContain(
        "If it changes instructions",
      );
      expect(
        appendedEvents.filter(
          (event) =>
            event.type === "agent-completed" &&
            (event.payload as { agentId?: string })?.agentId === task.threadId,
        ),
      ).toHaveLength(1);
      expect((await manager.getAgent(task.threadId))?.status).toBe("completed");
    },
  );

  it("keeps rapid repeated report updates non-terminal", async () => {
    const { manager, appendedEvents, sentMessages } = createHarness();
    const managerRuns: MockRunArgs[] = [];
    runMock.handler = async (args) => {
      managerRuns.push(args);
      if (managerRuns.length <= 2) {
        await waitForAbort(args.abortSignal);
        return {
          runId: `rapid-status-interrupted-${managerRuns.length}`,
          result: "",
          interrupted: true,
        };
      }
      if (managerRuns.length === 3) {
        await reportFromMockManager(
          args,
          "Still planning; no child has started.",
          false,
          "rapid-planning-update",
        );
        return {
          runId: "rapid-status-reply",
          result: "Private rapid-status response.",
        };
      }
      await reportFromMockManager(
        args,
        "Planning finished after the status checks.",
        true,
        "rapid-planning-final",
      );
      return {
        runId: "rapid-status-final",
        result: "Private Manager final response.",
      };
    };

    const task = await manager.createAgent({
      conversationId: "conversation-rapid-status",
      description: "Plan through rapid status checks",
      prompt: "Plan the process, then finish it.",
      agentType: AGENT_IDS.MANAGER,
      agentDepth: 1,
      storageMode: "local",
    });
    await waitUntil(() => managerRuns.length === 1);
    await manager.sendAgentMessage(
      task.threadId,
      "Any update?",
      "orchestrator",
      { deliveryKind: "external-input" },
    );
    await waitUntil(() => managerRuns.length === 2);
    await manager.sendAgentMessage(
      task.threadId,
      "How far along are you?",
      "orchestrator",
      { deliveryKind: "external-input" },
    );
    await waitUntil(() =>
      sentMessages.some((message) =>
        message.text.includes("Still planning; no child has started."),
      ),
    );

    expect(managerRuns).toHaveLength(3);
    expect(managerRuns[1]?.userPrompt).toContain("Any update?");
    expect(managerRuns[2]?.userPrompt).toContain("How far along are you?");
    expect((await manager.getAgent(task.threadId))?.status).toBe("running");
    expect(
      appendedEvents.some(
        (event) =>
          event.type === "agent-completed" &&
          (event.payload as { agentId?: string })?.agentId === task.threadId,
      ),
    ).toBe(false);

    await manager.sendAgentMessage(
      task.threadId,
      "Continue the process and finish.",
      "orchestrator",
      { deliveryKind: "external-input" },
    );
    await waitUntil(() => managerRuns.length === 4);
    await waitUntil(() =>
      sentMessages.some((message) =>
        message.text.includes("Planning finished after the status checks."),
      ),
    );
    expect(managerRuns).toHaveLength(4);
    expect(
      appendedEvents.filter(
        (event) =>
          event.type === "agent-completed" &&
          (event.payload as { agentId?: string })?.agentId === task.threadId,
      ),
    ).toHaveLength(1);
    expect((await manager.getAgent(task.threadId))?.status).toBe("completed");
  });

  it("keeps a between-stage status poke non-terminal with no active child", async () => {
    const { manager, store, appendedEvents, sentMessages } = createHarness();
    let releaseManagerFirst!: () => void;
    const managerFirstGate = new Promise<void>((resolve) => {
      releaseManagerFirst = resolve;
    });
    let releaseStageOne!: () => void;
    const stageOneGate = new Promise<void>((resolve) => {
      releaseStageOne = resolve;
    });
    const managerRuns: MockRunArgs[] = [];
    runMock.handler = async (args) => {
      if (args.agentType !== AGENT_IDS.MANAGER) {
        await stageOneGate;
        return { runId: "stage-one", result: "Stage one finished." };
      }
      managerRuns.push(args);
      if (managerRuns.length === 1) {
        await managerFirstGate;
        return {
          runId: "between-stage-wait",
          result: "Waiting for stage one.",
        };
      }
      if (managerRuns.length === 2) {
        await waitForAbort(args.abortSignal);
        return {
          runId: "between-stage-interrupted",
          result: "",
          interrupted: true,
        };
      }
      if (managerRuns.length === 3) {
        await reportFromMockManager(
          args,
          "Stage one finished; stage two has not started.",
          false,
          "between-stage-update",
        );
        return {
          runId: "between-stage-status",
          result: "Private between-stage response.",
        };
      }
      await reportFromMockManager(
        args,
        "Stage two completed and the process settled.",
        true,
        "between-stage-final",
      );
      return {
        runId: "between-stage-final",
        result: "Private Manager final response.",
      };
    };

    const managerTask = await manager.createAgent({
      conversationId: "conversation-between-stage",
      description: "Coordinate two stages",
      prompt: "Run stage one, then stage two, then report.",
      agentType: AGENT_IDS.MANAGER,
      agentDepth: 1,
      storageMode: "local",
    });
    await manager.createAgent({
      conversationId: "conversation-between-stage",
      description: "Run stage one",
      prompt: "Complete stage one.",
      agentType: AGENT_IDS.GENERAL,
      agentDepth: 2,
      maxAgentDepth: 2,
      parentAgentId: managerTask.threadId,
      storageMode: "local",
    });
    releaseManagerFirst();
    await waitUntil(
      () =>
        managerRuns.length === 1 &&
        !hasInFlightAttempt(manager, managerTask.threadId),
    );
    releaseStageOne();
    await waitUntil(() => managerRuns.length === 2);
    await manager.sendAgentMessage(
      managerTask.threadId,
      "Where do we stand?",
      "orchestrator",
      { deliveryKind: "external-input" },
    );
    await waitUntil(() =>
      sentMessages.some((message) =>
        message.text.includes("Stage one finished; stage two has not started"),
      ),
    );

    expect(managerRuns[2]?.userPrompt).toContain("Where do we stand?");
    expect((await manager.getAgent(managerTask.threadId))?.status).toBe(
      "running",
    );
    expect(store.getAgentRecord(managerTask.threadId)?.status).toBe("running");
    expect(
      appendedEvents.filter(
        (event) =>
          event.type === "agent-completed" &&
          (event.payload as { agentId?: string })?.agentId ===
            managerTask.threadId,
      ),
    ).toHaveLength(0);

    await manager.sendAgentMessage(
      managerTask.threadId,
      "Continue with stage two and finish.",
      "orchestrator",
      { deliveryKind: "external-input" },
    );
    await waitUntil(() => managerRuns.length === 4);
    await waitUntil(() =>
      sentMessages.some((message) =>
        message.text.includes("Stage two completed and the process settled."),
      ),
    );
    expect(managerRuns).toHaveLength(4);
    expect(managerRuns[3]?.userPrompt).toContain(
      "Continue with stage two and finish.",
    );
    expect(
      appendedEvents.filter(
        (event) =>
          event.type === "agent-completed" &&
          (event.payload as { agentId?: string })?.agentId ===
            managerTask.threadId,
      ),
    ).toHaveLength(1);
    expect((await manager.getAgent(managerTask.threadId))?.status).toBe(
      "completed",
    );
  });

  it("keeps post-completion status input on the existing terminal follow-up path", async () => {
    const { manager, appendedEvents, sentMessages } = createHarness();
    const managerRuns: MockRunArgs[] = [];
    runMock.handler = async (args) => {
      managerRuns.push(args);
      if (managerRuns.length === 1) {
        await reportFromMockManager(
          args,
          "Original process complete.",
          true,
          "terminal-first-final",
        );
        return { runId: "terminal-first", result: "Private first final." };
      }
      await reportFromMockManager(
        args,
        "The original process was already complete.",
        false,
        "terminal-follow-up-update",
      );
      return {
        runId: "terminal-status-follow-up",
        result: "Private follow-up response.",
      };
    };

    const task = await manager.createAgent({
      conversationId: "conversation-terminal-status",
      description: "Complete managed work",
      prompt: "Complete the managed work now.",
      agentType: AGENT_IDS.MANAGER,
      agentDepth: 1,
      storageMode: "local",
    });
    await waitUntil(
      async () =>
        (await manager.getAgent(task.threadId))?.status === "completed",
    );
    await manager.sendAgentMessage(
      task.threadId,
      "Give me a status update.",
      "orchestrator",
      { deliveryKind: "external-input" },
    );
    await waitUntil(() => managerRuns.length === 2);
    await waitUntil(() =>
      sentMessages.some((message) => message.text.includes("already complete")),
    );
    expect((await manager.getAgent(task.threadId))?.status).toBe("running");

    expect(managerRuns[1]?.userPrompt).toContain("Give me a status update.");
    expect(managerRuns[1]?.userPrompt).not.toContain(
      "follow the Manager status-response protocol",
    );
    expect(
      sentMessages.some(
        (message) =>
          message.customType === "runtime.task_update" &&
          message.text.includes("already complete"),
      ),
    ).toBe(true);
    expect(
      appendedEvents.filter(
        (event) =>
          event.type === "agent-completed" &&
          (event.payload as { agentId?: string })?.agentId === task.threadId,
      ),
    ).toHaveLength(1);
  });

  it("publishes an instructed non-terminal report without completing the manager", async () => {
    const { manager, store, appendedEvents, sentMessages } = createHarness();
    let releaseManagerFirst!: () => void;
    const managerFirstGate = new Promise<void>((resolve) => {
      releaseManagerFirst = resolve;
    });
    let releaseChild!: () => void;
    const childGate = new Promise<void>((resolve) => {
      releaseChild = resolve;
    });
    const managerPrompts: string[] = [];
    runMock.handler = async (args) => {
      if (args.agentType === AGENT_IDS.MANAGER) {
        managerPrompts.push(args.userPrompt);
        if (managerPrompts.length === 1) {
          await managerFirstGate;
          await reportFromMockManager(
            args,
            "Stage one is complete; continuing stage two.",
            false,
            "stage-one-update",
          );
          return {
            runId: "manager-milestone-1",
            result: "Private stage-one response.",
          };
        }
        await reportFromMockManager(
          args,
          "Final consolidated stage report.",
          true,
          "stages-final",
        );
        return {
          runId: "manager-milestone-2",
          result: "Private Manager final response.",
        };
      }
      await childGate;
      return { runId: "child-stage-2", result: "Stage two is complete." };
    };

    const managerTask = await manager.createAgent({
      conversationId: "conversation-milestone",
      description: "Coordinate staged reporting",
      prompt: "Run the stages. Report after each stage, then continue.",
      agentType: AGENT_IDS.MANAGER,
      agentDepth: 1,
      storageMode: "local",
    });
    await manager.createAgent({
      conversationId: "conversation-milestone",
      description: "Run stage two",
      prompt: "Complete stage two.",
      agentType: AGENT_IDS.GENERAL,
      agentDepth: 2,
      maxAgentDepth: 2,
      parentAgentId: managerTask.threadId,
      storageMode: "local",
    });
    releaseManagerFirst();

    await waitUntil(() =>
      sentMessages.some(
        (message) =>
          message.customType === "runtime.task_update" &&
          message.text.includes("Stage one is complete; continuing stage two"),
      ),
    );
    expect(managerPrompts[0]).toContain(
      "Report after each stage, then continue.",
    );
    expect(
      sentMessages.find((message) =>
        message.text.includes("Stage one is complete; continuing stage two"),
      ),
    ).toMatchObject({
      customType: "runtime.task_update",
      responseTarget: {
        type: "agent_turn",
        agentId: managerTask.threadId,
      },
    });
    expect((await manager.getAgent(managerTask.threadId))?.status).toBe(
      "running",
    );
    expect(store.getAgentRecord(managerTask.threadId)?.status).toBe("running");
    expect(
      appendedEvents.some(
        (event) =>
          event.type === "agent-completed" &&
          (event.payload as { agentId?: string })?.agentId ===
            managerTask.threadId,
      ),
    ).toBe(false);

    releaseChild();
    await waitUntil(async () =>
      ["completed", "error", "canceled"].includes(
        (await manager.getAgent(managerTask.threadId))?.status ?? "",
      ),
    );
    expect(
      appendedEvents.filter(
        (event) =>
          event.type === "agent-completed" &&
          (event.payload as { agentId?: string })?.agentId ===
            managerTask.threadId,
      ),
    ).toHaveLength(1);
  });

  it("internalizes Manager finalized output while children remain active", async () => {
    const { manager, store, appendedEvents, sentMessages } = createHarness();
    let releaseManagerFirst!: () => void;
    const managerFirstGate = new Promise<void>((resolve) => {
      releaseManagerFirst = resolve;
    });
    let releaseChild!: () => void;
    const childGate = new Promise<void>((resolve) => {
      releaseChild = resolve;
    });
    const managerPrompts: string[] = [];
    runMock.handler = async (args) => {
      if (args.agentType === AGENT_IDS.MANAGER) {
        managerPrompts.push(args.userPrompt);
        if (managerPrompts.length === 1) {
          await managerFirstGate;
          return {
            runId: "manager-internal-1",
            result: "Stage one is complete; continuing internally.",
          };
        }
        await reportFromMockManager(
          args,
          "Final consolidated internal report.",
          true,
          "internal-final",
        );
        return {
          runId: "manager-internal-2",
          result: "Private Manager final response.",
        };
      }
      await childGate;
      return { runId: "child-internal-2", result: "Remaining work complete." };
    };

    const managerTask = await manager.createAgent({
      conversationId: "conversation-internal",
      description: "Coordinate internal stages",
      prompt: "Coordinate all stages and report only when the work settles.",
      agentType: AGENT_IDS.MANAGER,
      agentDepth: 1,
      storageMode: "local",
    });
    await manager.createAgent({
      conversationId: "conversation-internal",
      description: "Run remaining work",
      prompt: "Complete the remaining work.",
      agentType: AGENT_IDS.GENERAL,
      agentDepth: 2,
      maxAgentDepth: 2,
      parentAgentId: managerTask.threadId,
      storageMode: "local",
    });
    releaseManagerFirst();

    await waitUntil(
      () =>
        managerPrompts.length === 1 &&
        !hasInFlightAttempt(manager, managerTask.threadId),
    );
    expect(
      sentMessages.some((message) =>
        message.text.includes("Stage one is complete; continuing internally."),
      ),
    ).toBe(false);
    expect((await manager.getAgent(managerTask.threadId))?.status).toBe(
      "running",
    );
    expect(store.getAgentRecord(managerTask.threadId)?.status).toBe("running");
    expect(store.getAgentRecord(managerTask.threadId)?.result).toBeUndefined();
    expect(
      appendedEvents.some(
        (event) =>
          event.type === "agent-completed" &&
          (event.payload as { agentId?: string })?.agentId ===
            managerTask.threadId,
      ),
    ).toBe(false);

    releaseChild();
    await waitUntil(async () =>
      ["completed", "error", "canceled"].includes(
        (await manager.getAgent(managerTask.threadId))?.status ?? "",
      ),
    );
  });

  it("cascade-pauses children and never resurrects a paused manager on a late completion", async () => {
    const { manager, store, sentMessages } = createHarness();
    let releaseManagerFirst!: () => void;
    const managerFirstGate = new Promise<void>((resolve) => {
      releaseManagerFirst = resolve;
    });
    const managerPrompts: string[] = [];
    const managerRuns: MockRunArgs[] = [];
    runMock.handler = async (args) => {
      if (args.agentType === AGENT_IDS.MANAGER) {
        managerRuns.push(args);
        managerPrompts.push(args.userPrompt);
        if (managerPrompts.length === 1) {
          await managerFirstGate;
          return { runId: "manager-wait", result: "Waiting." };
        }
        if (managerPrompts.length === 2) {
          await reportFromMockManager(
            args,
            "Waiting for the child before the pause.",
            false,
            "pause-status",
          );
          return {
            runId: "manager-status-before-pause",
            result: "Private status response.",
          };
        }
        await reportFromMockManager(
          args,
          "Resumed safely.",
          true,
          "pause-resume-final",
        );
        return { runId: "manager-resume", result: "Private resumed final." };
      }
      await waitForAbort(args.abortSignal);
      return { runId: "child-paused", result: "", interrupted: true };
    };

    const managerTask = await manager.createAgent({
      conversationId: "conversation-pause",
      description: "Coordinate pause race",
      prompt: "Wait for child completion.",
      agentType: AGENT_IDS.MANAGER,
      agentDepth: 1,
      storageMode: "local",
    });
    const childTask = await manager.createAgent({
      conversationId: "conversation-pause",
      description: "Long child",
      prompt: "Keep working.",
      agentType: AGENT_IDS.GENERAL,
      agentDepth: 2,
      maxAgentDepth: 2,
      parentAgentId: managerTask.threadId,
      storageMode: "local",
    });
    releaseManagerFirst();
    await waitUntil(
      () =>
        managerPrompts.length === 1 &&
        !hasInFlightAttempt(manager, managerTask.threadId),
    );
    await manager.sendAgentMessage(
      managerTask.threadId,
      "Any update before I pause this?",
      "orchestrator",
      { deliveryKind: "external-input" },
    );
    await waitUntil(() =>
      sentMessages.some((message) =>
        message.text.includes("Waiting for the child before the pause."),
      ),
    );
    expect((await manager.getAgent(managerTask.threadId))?.status).toBe(
      "running",
    );
    await manager.cancelAgent(managerTask.threadId, AGENT_PAUSE_CANCEL_REASON);

    expect((await manager.getAgent(managerTask.threadId))?.status).toBe(
      "canceled",
    );
    expect((await manager.getAgent(childTask.threadId))?.status).toBe(
      "canceled",
    );
    expect(store.getAgentRecord(managerTask.threadId)?.status).toBe("canceled");
    expect(store.getAgentRecord(childTask.threadId)?.status).toBe("canceled");

    const productionEventHandler = (
      manager as unknown as {
        opts: { onAgentEvent?: (event: AgentLifecycleEvent) => void };
      }
    ).opts.onAgentEvent!;
    const lateCompletion: AgentLifecycleEvent = {
      type: "agent-completed",
      conversationId: "conversation-pause",
      eventId: "late-child-completion-1",
      agentId: childTask.threadId,
      agentType: AGENT_IDS.GENERAL,
      description: "Long child",
      parentAgentId: managerTask.threadId,
      result: "Late child completion.",
    };
    productionEventHandler(lateCompletion);
    productionEventHandler(lateCompletion);
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(managerPrompts).toHaveLength(2);
    expect((await manager.getAgent(managerTask.threadId))?.status).toBe(
      "canceled",
    );
    expect(
      sentMessages.some((message) =>
        message.text.includes("Late child completion."),
      ),
    ).toBe(false);

    await manager.sendAgentMessage(
      managerTask.threadId,
      "Resume and report the queued result.",
      "orchestrator",
      { deliveryKind: "external-input" },
    );
    await waitUntil(() => managerPrompts.length === 3);
    expect(managerPrompts[2]).toContain("Resume and report the queued result.");
    expect(managerPrompts[2]).not.toContain("Late child completion.");
    expect(
      historyText(managerRuns[2]!).match(/Late child completion\./g),
    ).toHaveLength(1);
    await waitUntil(() =>
      sentMessages.some((message) => message.text.includes("Resumed safely.")),
    );
    expect((await manager.getAgent(managerTask.threadId))?.status).toBe(
      "completed",
    );
    expect((await manager.getAgent(childTask.threadId))?.status).toBe(
      "canceled",
    );
  });

  it("atomically rejects spawn during manager pause and cancels transitive descendants", async () => {
    const { manager } = createHarness();
    runMock.handler = async (args) => {
      await waitForAbort(args.abortSignal);
      return { runId: `paused-${args.agentId}`, result: "", interrupted: true };
    };

    const managerTask = await manager.createAgent({
      conversationId: "conversation-atomic-pause",
      description: "Atomic pause manager",
      prompt: "Coordinate descendants.",
      agentType: AGENT_IDS.MANAGER,
      agentDepth: 1,
      storageMode: "local",
    });
    const childTask = await manager.createAgent({
      conversationId: "conversation-atomic-pause",
      description: "Legacy child",
      prompt: "Keep working.",
      agentType: AGENT_IDS.GENERAL,
      agentDepth: 2,
      parentAgentId: managerTask.threadId,
      storageMode: "local",
    });
    const descendantTask = await manager.createAgent({
      conversationId: "conversation-atomic-pause",
      description: "Legacy descendant",
      prompt: "Keep working below the child.",
      agentType: AGENT_IDS.GENERAL,
      agentDepth: 3,
      parentAgentId: childTask.threadId,
      storageMode: "local",
    });

    const pausePromise = manager.cancelAgent(
      managerTask.threadId,
      AGENT_PAUSE_CANCEL_REASON,
    );
    await expect(
      manager.createAgent({
        conversationId: "conversation-atomic-pause",
        description: "Late child",
        prompt: "Spawn while pause is cascading.",
        agentType: AGENT_IDS.GENERAL,
        agentDepth: 2,
        parentAgentId: managerTask.threadId,
        storageMode: "local",
      }),
    ).rejects.toThrow(/parent thread .* paused or finished/i);
    await pausePromise;

    expect((await manager.getAgent(childTask.threadId))?.status).toBe(
      "canceled",
    );
    expect((await manager.getAgent(descendantTask.threadId))?.status).toBe(
      "canceled",
    );
  });

  it("does not start a resumed attempt until the paused attempt tears down or let it overwrite final state", async () => {
    const { manager, appendedEvents, sentMessages } = createHarness();
    let releaseOldAttempt!: () => void;
    const oldAttemptGate = new Promise<void>((resolve) => {
      releaseOldAttempt = resolve;
    });
    const managerRuns: MockRunArgs[] = [];
    runMock.handler = async (args) => {
      managerRuns.push(args);
      if (managerRuns.length === 1) {
        await oldAttemptGate;
        const stale = await reportFromMockManager(
          args,
          "Stale canceled report.",
          true,
          "stale-final",
        );
        expect(stale.accepted).toBe(false);
        return {
          runId: "stale-paused-attempt",
          result: "Stale canceled result.",
          interrupted: true,
        };
      }
      const accepted = await reportFromMockManager(
        args,
        "Resumed final result.",
        true,
        "resumed-final",
      );
      const replay = await reportFromMockManager(
        args,
        "Resumed final result.",
        true,
        "resumed-final",
      );
      expect(accepted.accepted).toBe(true);
      expect(replay.accepted).toBe(true);
      return { runId: "resumed-attempt", result: "Private resumed final." };
    };

    const managerTask = await manager.createAgent({
      conversationId: "conversation-overlap",
      description: "Pause resume overlap",
      prompt: "Wait until paused.",
      agentType: AGENT_IDS.MANAGER,
      agentDepth: 1,
      storageMode: "local",
    });
    await waitUntil(() => managerRuns.length === 1);
    await manager.cancelAgent(managerTask.threadId, AGENT_PAUSE_CANCEL_REASON);
    await manager.sendAgentMessage(
      managerTask.threadId,
      "Resume now and finish.",
      "orchestrator",
      { deliveryKind: "external-input" },
    );

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(managerRuns).toHaveLength(1);
    releaseOldAttempt();
    await waitUntil(() => managerRuns.length === 2);
    expect(managerRuns[1]?.userPrompt).toContain("Resume now and finish.");
    await waitUntil(() =>
      sentMessages.some((message) =>
        message.text.includes("Resumed final result."),
      ),
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(await manager.getAgent(managerTask.threadId)).toMatchObject({
      status: "completed",
    });
    const completions = appendedEvents.filter(
      (event) =>
        event.type === "agent-completed" &&
        (event.payload as { agentId?: string }).agentId ===
          managerTask.threadId,
    );
    expect(completions).toHaveLength(1);
    expect(completions[0]?.payload).toMatchObject({
      result: "Resumed final result.",
    });
    expect(
      sentMessages.filter((message) =>
        message.text.includes("Resumed final result."),
      ),
    ).toHaveLength(1);
    expect(JSON.stringify({ appendedEvents, sentMessages })).not.toContain(
      "Private resumed final.",
    );
    expect(JSON.stringify({ appendedEvents, sentMessages })).not.toContain(
      "Stale canceled report.",
    );
    expect(
      appendedEvents.filter(
        (event) =>
          event.type === "agent-canceled" &&
          (event.payload as { agentId?: string }).agentId ===
            managerTask.threadId,
      ),
    ).toHaveLength(1);
  });

  it("takes over a paused attempt after bounded teardown when the old promise never settles", async () => {
    const { manager, appendedEvents, sentMessages } = createHarness({
      attemptTeardownTimeoutMs: 25,
    });
    (
      manager as unknown as {
        opts: { getMaxConcurrent?: () => number };
      }
    ).opts.getMaxConcurrent = () => 1;
    const managerRuns: MockRunArgs[] = [];
    runMock.handler = async (args) => {
      managerRuns.push(args);
      if (managerRuns.length === 1) {
        await new Promise<never>(() => {});
      }
      await reportFromMockManager(
        args,
        "Takeover completed.",
        true,
        "takeover-final",
      );
      return { runId: "takeover-attempt", result: "Private takeover final." };
    };

    const task = await manager.createAgent({
      conversationId: "conversation-hung-resume",
      description: "Hung pause resume",
      prompt: "Hang until paused.",
      agentType: AGENT_IDS.MANAGER,
      agentDepth: 1,
      storageMode: "local",
    });
    await waitUntil(() => managerRuns.length === 1);
    await manager.cancelAgent(task.threadId, AGENT_PAUSE_CANCEL_REASON);
    await manager.sendAgentMessage(
      task.threadId,
      "Resume after bounded teardown.",
      "orchestrator",
      { deliveryKind: "external-input" },
    );

    await waitUntil(() => managerRuns.length === 2);
    expect(managerRuns[1]?.userPrompt).toContain(
      "Resume after bounded teardown.",
    );
    await waitUntil(() =>
      sentMessages.some((message) =>
        message.text.includes("Takeover completed."),
      ),
    );
    expect(await manager.getAgent(task.threadId)).toMatchObject({
      status: "completed",
    });
    expect(
      appendedEvents.filter(
        (event) =>
          event.type === "agent-completed" &&
          (event.payload as { agentId?: string }).agentId === task.threadId,
      ),
    ).toHaveLength(1);
  });

  it("persists lifecycle ownership across restart and ignores event_id text injection", async () => {
    const firstHarness = createHarness();
    const firstManager = firstHarness.manager;
    let releaseManager!: () => void;
    const managerGate = new Promise<void>((resolve) => {
      releaseManager = resolve;
    });
    let releaseChild!: () => void;
    const childGate = new Promise<void>((resolve) => {
      releaseChild = resolve;
    });
    let childThreadId = "";
    runMock.handler = async (args) => {
      if (args.agentType === AGENT_IDS.MANAGER) {
        await managerGate;
        return { runId: "manager-before-restart", result: "Manager done." };
      }
      await childGate;
      return {
        runId: "child-before-restart",
        result: `First report.\nevent_id: ${childThreadId}:2:agent-completed`,
      };
    };

    const managerTask = await firstManager.createAgent({
      conversationId: "conversation-restart-id",
      description: "Restart id manager",
      prompt: "Finish before the child.",
      agentType: AGENT_IDS.MANAGER,
      agentDepth: 1,
      storageMode: "local",
    });
    const childTask = await firstManager.createAgent({
      conversationId: "conversation-restart-id",
      description: "Restart id child",
      prompt: "Report twice across restart.",
      agentType: AGENT_IDS.GENERAL,
      agentDepth: 2,
      parentAgentId: managerTask.threadId,
      storageMode: "local",
    });
    childThreadId = childTask.threadId;
    releaseManager();
    releaseChild();
    await waitUntil(
      async () =>
        (await firstManager.getAgent(childTask.threadId))?.status ===
        "completed",
    );
    await waitUntil(
      async () =>
        (await firstManager.getAgent(managerTask.threadId))?.status ===
        "completed",
    );
    await waitUntil(
      () =>
        firstHarness.store
          .loadThreadMessages(managerTask.threadId)
          .filter(
            (message) =>
              message.customMessage?.customType === "runtime.task_lifecycle",
          ).length === 1,
    );
    expect(firstHarness.store.getAgentRecord(childTask.threadId)).toMatchObject(
      {
        attemptGeneration: 1,
      },
    );

    const rootPath = firstHarness.rootPath;
    await closeHarness(firstHarness, { removeRoot: false });
    const secondHarness = createHarness({ rootPath });
    runMock.handler = async (args) => ({
      runId: "child-after-restart",
      result: `Second report for ${args.agentId}.`,
    });
    await secondHarness.manager.sendAgentMessage(
      childTask.threadId,
      "Run the post-restart report.",
      "orchestrator",
      { deliveryKind: "external-input" },
    );
    await waitUntil(
      async () =>
        (await secondHarness.manager.getAgent(childTask.threadId))?.status ===
        "completed",
    );

    const lifecycleRows = secondHarness.store
      .loadThreadMessages(managerTask.threadId)
      .filter(
        (message) =>
          message.customMessage?.customType === "runtime.task_lifecycle",
      );
    expect(lifecycleRows).toHaveLength(2);
    expect(lifecycleRows.map((row) => row.customMessage?.eventId)).toEqual([
      `${childTask.threadId}:1:agent-completed`,
      `${childTask.threadId}:2:agent-completed`,
    ]);
    expect(lifecycleRows[1]?.content).toContain("Second report");
    expect(
      secondHarness.store.getAgentRecord(childTask.threadId),
    ).toMatchObject({
      attemptGeneration: 2,
    });
  });

  it("wakes a parked manager when its last child is paused directly", async () => {
    const { manager } = createHarness();
    let releaseManager!: () => void;
    const managerGate = new Promise<void>((resolve) => {
      releaseManager = resolve;
    });
    const managerRuns: MockRunArgs[] = [];
    runMock.handler = async (args) => {
      if (args.agentType === AGENT_IDS.MANAGER) {
        managerRuns.push(args);
        if (managerRuns.length === 1) {
          await managerGate;
          return { runId: "manager-park", result: "Waiting for child." };
        }
        return { runId: "manager-woke", result: "Handled paused child." };
      }
      await waitForAbort(args.abortSignal);
      return { runId: "child-direct-pause", result: "", interrupted: true };
    };

    const managerTask = await manager.createAgent({
      conversationId: "conversation-child-pause",
      description: "Handle child pause",
      prompt: "Wait for the only child.",
      agentType: AGENT_IDS.MANAGER,
      agentDepth: 1,
      storageMode: "local",
    });
    const childTask = await manager.createAgent({
      conversationId: "conversation-child-pause",
      description: "Only child",
      prompt: "Keep working.",
      agentType: AGENT_IDS.GENERAL,
      agentDepth: 2,
      parentAgentId: managerTask.threadId,
      storageMode: "local",
    });
    releaseManager();
    await waitUntil(() => managerRuns.length === 1);
    await waitUntil(() => !hasInFlightAttempt(manager, managerTask.threadId));

    await manager.cancelAgent(childTask.threadId, AGENT_PAUSE_CANCEL_REASON);
    await waitUntil(() => managerRuns.length === 2);
    expect(managerRuns[1]?.userPrompt).toContain(
      "newly persisted managed-child event",
    );
    expect(historyText(managerRuns[1]!)).toContain("[Managed child paused]");
    expect(historyText(managerRuns[1]!)).toContain(
      "A managed child was paused by the user",
    );
    await waitUntil(
      async () =>
        (await manager.getAgent(managerTask.threadId))?.status === "completed",
    );
  });

  it("enforces exclusive, acyclic, same-conversation adoption and rejects post-completion adoption", async () => {
    const { manager, sentMessages } = createHarness();
    runMock.handler = async (args) => {
      if (args.userPrompt.includes("Finish immediately")) {
        return { runId: "finished", result: "Already delivered." };
      }
      await waitForAbort(args.abortSignal);
      return { runId: "blocked", result: "", interrupted: true };
    };

    const managerA = await manager.createAgent({
      conversationId: "conversation-adopt",
      description: "Manager A",
      prompt: "Wait.",
      agentType: AGENT_IDS.MANAGER,
      agentDepth: 1,
      storageMode: "local",
    });
    const managerB = await manager.createAgent({
      conversationId: "conversation-adopt",
      description: "Manager B",
      prompt: "Wait.",
      agentType: AGENT_IDS.MANAGER,
      agentDepth: 1,
      storageMode: "local",
    });
    const child = await manager.createAgent({
      conversationId: "conversation-adopt",
      description: "Adoptable child",
      prompt: "Wait.",
      agentType: AGENT_IDS.GENERAL,
      agentDepth: 1,
      storageMode: "local",
    });
    const otherConversationChild = await manager.createAgent({
      conversationId: "conversation-other",
      description: "Other conversation child",
      prompt: "Wait.",
      agentType: AGENT_IDS.GENERAL,
      agentDepth: 1,
      storageMode: "local",
    });
    const cycleChild = await manager.createAgent({
      conversationId: "conversation-adopt",
      description: "Cycle child",
      prompt: "Wait.",
      agentType: AGENT_IDS.GENERAL,
      agentDepth: 1,
      storageMode: "local",
    });
    const cycleManager = await manager.createAgent({
      conversationId: "conversation-adopt",
      description: "Cycle manager",
      prompt: "Wait.",
      agentType: AGENT_IDS.MANAGER,
      agentDepth: 1,
      parentAgentId: cycleChild.threadId,
      storageMode: "local",
    });
    const completed = await manager.createAgent({
      conversationId: "conversation-adopt",
      description: "Completed before adoption",
      prompt: "Finish immediately.",
      agentType: AGENT_IDS.GENERAL,
      agentDepth: 1,
      storageMode: "local",
    });
    await waitUntil(
      async () =>
        (await manager.getAgent(completed.threadId))?.status === "completed",
    );

    await expect(
      manager.adoptAgent(managerA.threadId, managerA.threadId),
    ).resolves.toMatchObject({
      adopted: false,
      reason: expect.stringMatching(/itself/),
    });
    await expect(
      manager.adoptAgent(managerB.threadId, managerA.threadId),
    ).resolves.toMatchObject({
      adopted: false,
      reason: expect.stringMatching(/Managers cannot adopt/),
    });
    await expect(
      manager.adoptAgent(otherConversationChild.threadId, managerA.threadId),
    ).resolves.toMatchObject({
      adopted: false,
      reason: expect.stringMatching(/another conversation/),
    });
    await expect(
      manager.adoptAgent(cycleChild.threadId, cycleManager.threadId),
    ).resolves.toMatchObject({
      adopted: false,
      reason: expect.stringMatching(/cycle/),
    });
    await expect(
      manager.adoptAgent(child.threadId, managerA.threadId),
    ).resolves.toEqual({ adopted: true });
    await expect(
      manager.adoptAgent(child.threadId, managerB.threadId),
    ).resolves.toMatchObject({
      adopted: false,
      reason: expect.stringMatching(/already owned/),
    });
    await expect(
      manager.adoptAgent(completed.threadId, managerA.threadId),
    ).resolves.toMatchObject({
      adopted: false,
      reason: expect.stringMatching(/terminal thread/),
    });
    expect(
      sentMessages.filter((message) =>
        message.text.includes("Already delivered."),
      ),
    ).toHaveLength(1);

    await manager.cancelAgent(managerA.threadId, AGENT_PAUSE_CANCEL_REASON);
    await expect(
      manager.adoptAgent(child.threadId, managerB.threadId),
    ).resolves.toEqual({ adopted: true });
  });
});
