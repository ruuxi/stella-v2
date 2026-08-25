import { beforeEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AgentMessage } from "@stella/runtime/kernel/agent-core/types";
import type {
  OrchestratorRunOptions,
  SubagentRunOptions,
} from "@stella/runtime/kernel/agent-runtime/types";
import { BackgroundCompactionScheduler } from "@stella/runtime/kernel/agent-runtime/compaction-scheduler";
import { OrchestratorSession } from "@stella/runtime/kernel/agent-runtime/orchestrator-session";
import { SubagentSession } from "@stella/runtime/kernel/agent-runtime/subagent-session";
import { createExternalOrchestratorRunSession } from "@stella/runtime/kernel/agent-runtime/run-session";
import { loadStellaRuntimeAgents } from "@stella/runtime/extensions/stella-runtime/index";

const executeRuntimeAgentPrompt = vi.fn();

vi.mock("@stella/runtime/kernel/agent-runtime/run-execution.js", () => ({
  executeRuntimeAgentPrompt: (...args: unknown[]) =>
    executeRuntimeAgentPrompt(...args),
  isDurablyPersistedRuntimePromptInput: (input: {
    customType?: string;
    messageType?: string;
  }) =>
    input.messageType === "message" &&
    Boolean(input.customType?.trim()) &&
    input.customType !== "runtime.queued_message_reply",
}));

const model = {
  id: "test-model",
  name: "Test Model",
  api: "openai-completions",
  provider: "test",
  baseUrl: "https://example.test",
  reasoning: true,
  input: ["text"],
  cost: {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
  },
  contextWindow: 128_000,
  maxTokens: 4_096,
} as const;

const textFromMessages = (messages: AgentMessage[]): string[] =>
  messages.map((message) => {
    if (typeof message.content === "string") {
      return message.content;
    }
    return message.content
      .map((block) => (block.type === "text" ? block.text : ""))
      .join("\n");
  });

const createOptions = (
  overrides: Partial<OrchestratorRunOptions> = {},
): OrchestratorRunOptions => ({
  runId: "run-1",
  conversationId: "conversation-1",
  userMessageId: "user-message-1",
  agentType: "orchestrator",
  userPrompt: "Hello",
  agentContext: {
    systemPrompt: "System prompt",
    dynamicContext: "",
    maxAgentDepth: 1,
    reasoningEffort: "high",
    threadHistory: [
      {
        role: "user",
        content: "Initial persisted history",
        timestamp: 1,
      },
    ],
  },
  toolCatalog: [],
  toolExecutor: vi.fn(async () => ({ result: "ok" })),
  deviceId: "device-1",
  stellaDataDir: "/tmp/stella",
  stellaAppDir: "/tmp/stella",
  resolvedLlm: {
    model,
    route: "direct-provider",
    getApiKey: () => undefined,
  },
  store: {
    recordRunEvent: vi.fn(),
  } as never,
  callbacks: {
    onStream: vi.fn(),
    onToolStart: vi.fn(),
    onToolEnd: vi.fn(),
    onError: vi.fn(),
    onEnd: vi.fn(),
  },
  compactionScheduler: new BackgroundCompactionScheduler(),
  ...overrides,
});

describe("OrchestratorSession", () => {
  beforeEach(() => {
    executeRuntimeAgentPrompt.mockReset();
  });

  it("reuses the live Pi Agent across turns", async () => {
    const session = new OrchestratorSession("conversation-1");
    const seenAgents: unknown[] = [];

    executeRuntimeAgentPrompt.mockImplementation(async ({ agent }) => {
      seenAgents.push(agent);
      return { finalText: "done" };
    });

    await session.runTurn(createOptions({ runId: "run-1" }));
    await session.runTurn(
      createOptions({ runId: "run-2", userPrompt: "Again" }),
    );

    expect(seenAgents).toHaveLength(2);
    expect(seenAgents[1]).toBe(seenAgents[0]);
  });

  it("keeps a queued-reply wrapper resident, then removes it", async () => {
    const session = new OrchestratorSession("conversation-1");
    const compactionScheduler = new BackgroundCompactionScheduler();
    const schedule = vi.spyOn(compactionScheduler, "schedule");

    executeRuntimeAgentPrompt.mockImplementation(async ({ agent }) => {
      (agent as { state: { messages: AgentMessage[] } }).state.messages.push({
        role: "runtimeInternal",
        content: [
          { type: "text", text: "Reply to the already-persisted follow-up" },
        ],
        customType: "runtime.queued_message_reply",
        timestamp: 2,
      });
      const completedAssistant = {
        role: "assistant" as const,
        content: [{ type: "text" as const, text: "done" }],
        api: "openai-completions" as const,
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
        stopReason: "stop" as const,
        timestamp: 3,
      };
      (agent as { state: { messages: AgentMessage[] } }).state.messages.push(
        completedAssistant,
      );
      const scheduledBeforeBoundary = schedule.mock.calls.length;
      const replacement = await (
        agent as unknown as {
          _onTurnBoundary: (context: {
            context: { messages: AgentMessage[] };
            completedMessages: AgentMessage[];
            pendingMessages: AgentMessage[];
          }) => Promise<AgentMessage[] | undefined>;
        }
      )._onTurnBoundary({
        context: {
          messages: (agent as { state: { messages: AgentMessage[] } }).state
            .messages,
        },
        completedMessages: [completedAssistant],
        pendingMessages: [],
      });
      expect(replacement).toBeUndefined();
      expect(schedule).toHaveBeenCalledTimes(scheduledBeforeBoundary);
      return { finalText: "done" };
    });

    await session.runTurn(
      createOptions({
        userPrompt: "",
        promptMessages: [
          {
            text: "Reply to the already-persisted follow-up",
            messageType: "message",
            customType: "runtime.queued_message_reply",
          },
        ],
        compactionScheduler,
      }),
    );
    const promptedAgent = executeRuntimeAgentPrompt.mock.calls[0]?.[0]
      .agent as {
      state: { messages: AgentMessage[] };
    };
    expect(
      promptedAgent.state.messages.some(
        (message) => message.role === "runtimeInternal",
      ),
    ).toBe(false);
  });

  it("evicts an idle Agent and reconstructs the compacted durable window", async () => {
    vi.useFakeTimers();
    const session = new OrchestratorSession("conversation-1");
    const seenAgents: unknown[] = [];
    const startMessages: string[][] = [];

    try {
      executeRuntimeAgentPrompt.mockImplementation(async ({ agent }) => {
        seenAgents.push(agent);
        startMessages.push(textFromMessages(agent.state.messages));
        return { finalText: "done" };
      });

      await session.runTurn(createOptions({ runId: "run-before-idle" }));
      await vi.advanceTimersByTimeAsync(5 * 60 * 1_000);
      await session.runTurn(
        createOptions({
          runId: "run-after-idle",
          agentContext: {
            systemPrompt: "System prompt",
            dynamicContext: "",
            maxAgentDepth: 1,
            reasoningEffort: "high",
            threadHistory: [
              {
                role: "assistant",
                content: "Durable compacted checkpoint",
                timestamp: 2,
              },
            ],
          },
        }),
      );

      expect(seenAgents[1]).not.toBe(seenAgents[0]);
      expect(startMessages[1]).toContain("Durable compacted checkpoint");
      expect(startMessages[1]).not.toContain("Initial persisted history");
    } finally {
      session.dispose();
      vi.useRealTimers();
    }
  });

  it("never arms idle eviction while another orchestrator turn is active", async () => {
    vi.useFakeTimers();
    const session = new OrchestratorSession("conversation-1");
    const completions: Array<() => void> = [];
    const dispose = vi.spyOn(session, "dispose");

    try {
      executeRuntimeAgentPrompt.mockImplementation(
        () =>
          new Promise<{ finalText: string }>((resolve) => {
            completions.push(() => resolve({ finalText: "done" }));
          }),
      );
      const first = session.runTurn(createOptions({ runId: "queued-1" }));
      await vi.waitFor(() => expect(completions).toHaveLength(1));
      const second = session.runTurn(createOptions({ runId: "queued-2" }));
      await vi.waitFor(() => expect(completions).toHaveLength(2));

      completions[0]!();
      await first;
      await vi.advanceTimersByTimeAsync(5 * 60 * 1_000);
      expect(dispose).not.toHaveBeenCalled();

      completions[1]!();
      await second;
      await vi.advanceTimersByTimeAsync(5 * 60 * 1_000);
      expect(dispose).toHaveBeenCalledOnce();
    } finally {
      session.dispose();
      vi.useRealTimers();
    }
  });

  it("forwards the image description service to prompt execution", async () => {
    const session = new OrchestratorSession("conversation-1");
    const describeImages = vi.fn(async () => "A terminal window.");

    executeRuntimeAgentPrompt.mockResolvedValue({ finalText: "done" });

    await session.runTurn(createOptions({ describeImages }));

    expect(executeRuntimeAgentPrompt).toHaveBeenCalledWith(
      expect.objectContaining({ describeImages }),
    );
  });

  it("describes image-bearing tool results for a text-only model", async () => {
    const session = new OrchestratorSession("conversation-1");
    const describeImages = vi.fn(async () => "A browser error page.");
    let transformed: unknown;

    executeRuntimeAgentPrompt.mockImplementation(async ({ agent }) => {
      transformed = await (
        agent as unknown as {
          _afterToolCall?: (context: unknown) => Promise<unknown>;
        }
      )._afterToolCall?.({
        toolCall: { name: "node_repl" },
        result: {
          content: [
            { type: "text", text: "Browser screenshot attached." },
            { type: "image", mimeType: "image/png", data: "AAAA" },
          ],
          details: {},
        },
      });
      return { finalText: "done" };
    });

    await session.runTurn(createOptions({ describeImages }));

    expect(describeImages).toHaveBeenCalledOnce();
    expect(transformed).toEqual({
      content: [
        { type: "text", text: "Browser screenshot attached." },
        { type: "image", mimeType: "image/png", data: "AAAA" },
        {
          type: "text",
          text: "<image_description>\nA browser error page.\n</image_description>",
        },
      ],
    });
  });

  it("refreshes the advertised tool schema on the next turn of an open session", async () => {
    const session = new OrchestratorSession("conversation-1");
    const advertisedTools: string[][] = [];
    const tempRoot = await mkdtemp(
      path.join(os.tmpdir(), "stella-tool-refresh-"),
    );
    const oldMetadataDir = path.join(tempRoot, "old-agent-metadata");
    await mkdir(oldMetadataDir, { recursive: true });
    const oldTools = ["spawn_agent", "send_input", "pause_agent"];
    await writeFile(
      path.join(oldMetadataDir, "orchestrator.md"),
      [
        "---",
        "name: Orchestrator",
        "description: Old runtime capabilities",
        `tools: ${oldTools.join(", ")}`,
        "maxAgentDepth: 1",
        "---",
        "Legacy-compatible metadata body.",
      ].join("\n"),
    );
    const metadataDir = path.resolve(
      process.cwd(),
      "..",
      "runtime",
      "extensions",
      "stella-runtime",
      "agent-metadata",
    );
    const beforeReload = loadStellaRuntimeAgents(tempRoot, oldMetadataDir).find(
      (agent) => agent.id === "orchestrator",
    );
    const afterReload = loadStellaRuntimeAgents(tempRoot, metadataDir).find(
      (agent) => agent.id === "orchestrator",
    );
    expect(beforeReload?.systemPrompt).toBe("Legacy-compatible metadata body.");
    expect(afterReload?.systemPrompt).toContain(
      "World's best Personal AI Assistant",
    );
    expect(beforeReload?.toolsAllowlist).not.toContain("exec_command");
    expect(afterReload?.toolsAllowlist).toContain("exec_command");
    expect(afterReload?.toolsAllowlist).toContain("node_repl");

    const toolMetadata = (name: string) => ({
      name,
      description: `${name} test tool`,
      parameters: { type: "object", properties: {} },
    });
    const originalTools = beforeReload?.toolsAllowlist ?? [];
    const updatedTools = afterReload?.toolsAllowlist ?? [];

    executeRuntimeAgentPrompt.mockImplementation(async ({ agent }) => {
      advertisedTools.push(agent.state.tools.map((tool) => tool.name));
      return { finalText: "done" };
    });

    await session.runTurn(
      createOptions({
        runId: "run-before-extension-reload",
        agentContext: {
          systemPrompt: "Customized prompt body",
          dynamicContext: "",
          maxAgentDepth: 1,
          toolsAllowlist: originalTools,
        },
        toolCatalog: originalTools.map(toolMetadata),
      }),
    );
    await session.runTurn(
      createOptions({
        runId: "run-after-extension-reload",
        userPrompt: "Continue in this conversation",
        agentContext: {
          systemPrompt: "Customized prompt body",
          dynamicContext: "",
          maxAgentDepth: 1,
          toolsAllowlist: updatedTools,
        },
        toolCatalog: updatedTools.map(toolMetadata),
      }),
    );

    expect(advertisedTools[0]).toEqual(originalTools);
    expect(advertisedTools[1]).toEqual(updatedTools);
    expect(advertisedTools[1]).toContain("exec_command");
    expect(advertisedTools[1]).toContain("node_repl");
    await rm(tempRoot, { recursive: true, force: true });
  });

  it("refreshes the in-memory message mirror after compaction", async () => {
    const session = new OrchestratorSession("conversation-1");
    const startMessages: string[][] = [];

    executeRuntimeAgentPrompt.mockImplementation(async ({ agent }) => {
      startMessages.push(textFromMessages(agent.state.messages));
      return { finalText: "done" };
    });

    await session.runTurn(createOptions({ runId: "run-1" }));

    session.notifyCompacted();

    await session.runTurn(
      createOptions({
        runId: "run-2",
        userPrompt: "After compaction",
        store: {
          recordRunEvent: vi.fn(),
          loadThreadMessages: vi.fn(() => [
            {
              role: "assistant",
              content: "Compacted checkpoint summary",
              timestamp: 2,
            },
          ]),
        } as never,
        agentContext: {
          systemPrompt: "System prompt",
          dynamicContext: "",
          maxAgentDepth: 1,
          reasoningEffort: "high",
          threadHistory: [
            {
              role: "user",
              content: "Stale pre-compaction history",
              timestamp: 1,
            },
          ],
        },
      }),
    );

    expect(startMessages[0]).toContain("Initial persisted history");
    expect(startMessages[1]).toContain("Compacted checkpoint summary");
    expect(startMessages[1]).not.toContain("Initial persisted history");
    expect(startMessages[1]).not.toContain("Stale pre-compaction history");
  });
});

describe("SubagentSession", () => {
  beforeEach(() => {
    executeRuntimeAgentPrompt.mockReset();
  });

  it("forwards the image description service to prompt execution", async () => {
    const session = new SubagentSession(
      "image-thread",
      "conversation-1",
      "general",
    );
    const describeImages = vi.fn(async () => "A terminal window.");
    executeRuntimeAgentPrompt.mockResolvedValue({ finalText: "done" });

    await session.runTurn({
      runId: "image-run",
      conversationId: "conversation-1",
      userMessageId: "image-user",
      agentId: "image-thread",
      agentType: "general",
      userPrompt: "What is shown?",
      agentContext: {
        systemPrompt: "General prompt",
        dynamicContext: "",
        maxAgentDepth: 1,
        threadHistory: [],
      },
      toolCatalog: [],
      toolExecutor: vi.fn(async () => ({ result: "ok" })),
      deviceId: "device-1",
      stellaDataDir: "/tmp/stella",
      stellaAppDir: "/tmp/stella",
      resolvedLlm: {
        model,
        route: "direct-provider",
        getApiKey: () => undefined,
      },
      describeImages,
      store: {
        recordRunEvent: vi.fn(),
        appendThreadCustomMessage: vi.fn(),
        loadThreadMessages: vi.fn(() => []),
      } as never,
      callbacks: {},
      compactionScheduler: new BackgroundCompactionScheduler(),
    } satisfies SubagentRunOptions);

    expect(executeRuntimeAgentPrompt).toHaveBeenCalledWith(
      expect.objectContaining({ describeImages }),
    );
  });

  it("describes image-bearing tool results for a text-only subagent", async () => {
    const session = new SubagentSession(
      "tool-image-thread",
      "conversation-1",
      "general",
    );
    const describeImages = vi.fn(async () => "A desktop settings window.");
    let transformed: unknown;
    executeRuntimeAgentPrompt.mockImplementation(async ({ agent }) => {
      transformed = await (
        agent as unknown as {
          _afterToolCall?: (context: unknown) => Promise<unknown>;
        }
      )._afterToolCall?.({
        toolCall: { name: "Read" },
        result: {
          content: [{ type: "image", mimeType: "image/png", data: "AAAA" }],
          details: {},
        },
      });
      return { finalText: "done" };
    });

    await session.runTurn({
      runId: "tool-image-run",
      conversationId: "conversation-1",
      userMessageId: "tool-image-user",
      agentId: "tool-image-thread",
      agentType: "general",
      userPrompt: "Inspect the image.",
      agentContext: {
        systemPrompt: "General prompt",
        dynamicContext: "",
        maxAgentDepth: 1,
        threadHistory: [],
      },
      toolCatalog: [],
      toolExecutor: vi.fn(async () => ({ result: "ok" })),
      deviceId: "device-1",
      stellaDataDir: "/tmp/stella",
      stellaAppDir: "/tmp/stella",
      resolvedLlm: {
        model,
        route: "direct-provider",
        getApiKey: () => undefined,
      },
      describeImages,
      store: {
        recordRunEvent: vi.fn(),
        appendThreadCustomMessage: vi.fn(),
        loadThreadMessages: vi.fn(() => []),
      } as never,
      callbacks: {},
      compactionScheduler: new BackgroundCompactionScheduler(),
    } satisfies SubagentRunOptions);

    expect(describeImages).toHaveBeenCalledOnce();
    expect(transformed).toEqual({
      content: [
        { type: "image", mimeType: "image/png", data: "AAAA" },
        {
          type: "text",
          text: "<image_description>\nA desktop settings window.\n</image_description>",
        },
      ],
    });
  });

  it("reloads a history event persisted while the first Agent is being created", async () => {
    const session = new SubagentSession(
      "manager-thread",
      "conversation-1",
      "manager",
    );
    let releaseAgentStart!: () => void;
    const agentStartGate = new Promise<void>((resolve) => {
      releaseAgentStart = resolve;
    });
    let agentStartEntered!: () => void;
    const agentStartEnteredGate = new Promise<void>((resolve) => {
      agentStartEntered = resolve;
    });
    const persistedHistory = [
      {
        role: "user",
        content: "Stale snapshot before managed-child completion",
        timestamp: 1,
      },
    ];
    const store = {
      recordRunEvent: vi.fn(),
      appendThreadCustomMessage: vi.fn(),
      loadThreadMessages: vi.fn(() => persistedHistory),
    };
    const hookEmitter = {
      emitAll: vi.fn(async (event: string) => {
        if (event === "before_agent_start") {
          agentStartEntered();
          await agentStartGate;
        }
        return [];
      }),
      emit: vi.fn(async () => undefined),
    };
    let executionHistory: string[] = [];
    executeRuntimeAgentPrompt.mockImplementation(async ({ agent }) => {
      executionHistory = textFromMessages(agent.state.messages);
      return { finalText: "done" };
    });

    const turn = session.runTurn({
      runId: "manager-run-1",
      conversationId: "conversation-1",
      userMessageId: "manager-user-1",
      agentId: "manager-thread",
      agentType: "manager",
      userPrompt: "Review the new child event.",
      agentContext: {
        systemPrompt: "Manager prompt",
        dynamicContext: "",
        maxAgentDepth: 2,
        threadHistory: [...persistedHistory],
      },
      toolCatalog: [],
      toolExecutor: vi.fn(async () => ({ result: "ok" })),
      deviceId: "device-1",
      stellaDataDir: "/tmp/stella",
      stellaAppDir: "/tmp/stella",
      resolvedLlm: {
        model,
        route: "direct-provider",
        getApiKey: () => undefined,
      },
      store: store as never,
      hookEmitter: hookEmitter as never,
      callbacks: {},
      compactionScheduler: new BackgroundCompactionScheduler(),
    } satisfies SubagentRunOptions);

    await agentStartEnteredGate;
    persistedHistory.push({
      role: "runtimeInternal",
      content: "Child completed during manager session creation",
      timestamp: 2,
    });
    session.notifyHistoryChanged();
    releaseAgentStart();
    await turn;

    expect(store.loadThreadMessages).toHaveBeenCalledWith("manager-thread");
    expect(executionHistory).toContain(
      "Child completed during manager session creation",
    );
  });

  it("persists a live steering instruction before queueing it", async () => {
    const session = new SubagentSession(
      "steered-thread",
      "conversation-1",
      "general",
    );
    const appendThreadMessage = vi.fn();
    const store = {
      recordRunEvent: vi.fn(),
      appendThreadMessage,
      appendThreadCustomMessage: vi.fn(),
      loadThreadMessages: vi.fn(() => []),
    };
    let markExecutionStarted!: () => void;
    const executionStarted = new Promise<void>((resolve) => {
      markExecutionStarted = resolve;
    });
    let releaseExecution!: () => void;
    const executionGate = new Promise<void>((resolve) => {
      releaseExecution = resolve;
    });
    executeRuntimeAgentPrompt.mockImplementation(async () => {
      markExecutionStarted();
      await executionGate;
      return { finalText: "done" };
    });

    const turn = session.runTurn({
      runId: "steered-run",
      conversationId: "conversation-1",
      userMessageId: "user-1",
      agentId: "steered-thread",
      agentType: "general",
      userPrompt: "Start the task.",
      agentContext: {
        systemPrompt: "General prompt",
        dynamicContext: "",
        maxAgentDepth: 1,
        attemptGeneration: 4,
        threadHistory: [],
      },
      toolCatalog: [],
      toolExecutor: vi.fn(async () => ({ result: "ok" })),
      deviceId: "device-1",
      stellaDataDir: "/tmp/stella",
      stellaAppDir: "/tmp/stella",
      resolvedLlm: {
        model,
        route: "direct-provider",
        getApiKey: () => undefined,
      },
      store: store as never,
      callbacks: {},
      compactionScheduler: new BackgroundCompactionScheduler(),
    } satisfies SubagentRunOptions);

    await executionStarted;
    Object.defineProperty(session, "canSteer", {
      configurable: true,
      get: () => true,
    });
    const steerLiveAgent = vi.fn(() => true);
    Object.defineProperty(session, "steerLiveAgent", {
      configurable: true,
      value: steerLiveAgent,
    });

    expect(session.steer("Keep this proposal-only.")).toBe(true);
    expect(appendThreadMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        threadKey: "steered-thread",
        role: "user",
        content: "Keep this proposal-only.",
      }),
    );
    expect(steerLiveAgent).toHaveBeenCalledWith(
      expect.objectContaining({ role: "user" }),
    );

    releaseExecution();
    await turn;
  });
});

describe("external engine session lifecycle", () => {
  it("runs the shared beforeRunEnd finalizer for Claude Code", async () => {
    const beforeRunEnd = vi.fn(async () => undefined);
    const options = createOptions({
      agentContext: {
        systemPrompt: "System prompt",
        dynamicContext: "",
        maxAgentDepth: 1,
        reasoningEffort: "high",
        agentEngine: "claude_code_local",
      },
      beforeRunEnd,
    });
    const session = createExternalOrchestratorRunSession(options, {
      runId: "claude-code-install-update",
    });

    await session.finalizeSuccess("Update applied");

    expect(beforeRunEnd).toHaveBeenCalledOnce();
    expect(beforeRunEnd).toHaveBeenCalledWith({
      runId: "claude-code-install-update",
      threadKey: "conversation-1",
      finalText: "Update applied",
      outcome: "success",
    });
  });
});
