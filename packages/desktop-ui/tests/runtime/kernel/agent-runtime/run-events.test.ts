import { describe, expect, it, vi } from "vitest";
import { AssistantMessageEventStream } from "@stella/runtime/ai/utils/event-stream";
import type { AssistantMessage } from "@stella/runtime/ai/types";
import { runAgentLoop } from "@stella/runtime/kernel/agent-core/agent-loop";
import type { AgentEvent } from "@stella/runtime/kernel/agent-core/types";
import { createPiTools } from "@stella/runtime/kernel/agent-runtime/tool-adapters";
import type {
  RuntimeStatusEvent,
  RuntimeToolEndEvent,
  RuntimeToolStartEvent,
} from "@stella/runtime/kernel/agent-runtime/types";
import {
  createRunEventRecorder,
  subscribeRuntimeAgentEvents,
} from "@stella/runtime/kernel/agent-runtime/run-events";
import { AGENT_IDS } from "@stella/contracts/agent-runtime";
import {
  initialStoreState,
  streamStoreReducer,
} from "@/features/chat/streaming/store";
import {
  __privateTaskDecorationStore,
  appendTaskReasoning,
  decorateTask,
  getTaskDecoration,
} from "@/features/chat/streaming/task-decoration-store";
import {
  getInlineWorkingIndicatorActive,
  getWorkingIndicatorDisplayStatus,
} from "@/features/chat/working-indicator-state";

const usage = {
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

const assistantMessage = {
  role: "assistant" as const,
  content: [
    {
      type: "thinking" as const,
      thinking: "Need to inspect the task.",
      thinkingSignature: '{"type":"reasoning","id":"rs_123"}',
    },
    { type: "text" as const, text: "" },
  ],
  api: "openai-responses" as const,
  provider: "openai",
  model: "gpt-5.4",
  usage,
  stopReason: "stop" as const,
  timestamp: 1,
};

const createToolCallMessage = (toolName: string): AssistantMessage => ({
  role: "assistant",
  content: [
    {
      type: "toolCall",
      id: `call-${toolName}`,
      name: toolName,
      arguments: {},
    },
  ],
  api: "openai-completions",
  provider: "openai",
  model: "test-model",
  usage,
  stopReason: "toolUse",
  timestamp: 1,
});

const createTextMessage = (text: string): AssistantMessage => ({
  role: "assistant",
  content: [{ type: "text", text }],
  api: "openai-completions",
  provider: "openai",
  model: "test-model",
  usage,
  stopReason: "stop",
  timestamp: 2,
});

const streamMessage = (
  message: AssistantMessage,
): AssistantMessageEventStream => {
  const stream = new AssistantMessageEventStream();
  queueMicrotask(() => {
    stream.push({
      type: "start",
      partial: message,
    });
    stream.push({
      type: "done",
      reason: message.stopReason === "toolUse" ? "toolUse" : "stop",
      message,
    });
    stream.end(message);
  });
  return stream;
};

const runToolStatusIntegration = async (
  toolName: string,
  toolResult: { result?: unknown; error?: string } = { result: "ok" },
) => {
  const runId = `run-${toolName}`;
  const conversationId = `conversation-${toolName}`;
  const userMessageId = `user-${toolName}`;
  const listeners = new Set<(event: AgentEvent) => void>();
  const agent = {
    state: { messages: [] },
    subscribe: (listener: (event: AgentEvent) => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  const recordedRunEvents: unknown[] = [];
  const statusEvents: RuntimeStatusEvent[] = [];
  const toolStartEvents: RuntimeToolStartEvent[] = [];
  const toolEndEvents: RuntimeToolEndEvent[] = [];
  const store = {
    recordRunEvent: (event: unknown) => {
      recordedRunEvents.push(event);
    },
  };

  subscribeRuntimeAgentEvents({
    agent,
    runId,
    agentType: AGENT_IDS.ORCHESTRATOR,
    recorder: createRunEventRecorder({
      store: store as never,
      runId,
      conversationId,
      agentType: AGENT_IDS.ORCHESTRATOR,
      userMessageId,
    }),
    callbacks: {
      onStatus: (event) => {
        statusEvents.push(event);
      },
      onToolStart: (event) => {
        toolStartEvents.push(event);
      },
      onToolEnd: (event) => {
        toolEndEvents.push(event);
      },
    },
  });

  const tools = createPiTools({
    runId,
    conversationId,
    agentType: AGENT_IDS.ORCHESTRATOR,
    deviceId: "device-1",
    toolsAllowlist: [toolName],
    toolCatalog: [
      {
        name: toolName,
        description: `${toolName} tool`,
        parameters: {
          type: "object",
          properties: {},
        },
      },
    ],
    store: store as never,
    toolExecutor: async () => toolResult,
  });

  let callCount = 0;
  await runAgentLoop(
    [{ role: "user", content: "Use the tool.", timestamp: 1 }],
    {
      systemPrompt: "Use the requested tool, then answer.",
      messages: [],
      tools,
    },
    {
      model: {
        provider: "openai",
        id: "test-model",
        contextWindow: 128_000,
      },
      convertToLlm: async (messages) => messages as never,
      toolExecution: "sequential",
    } as never,
    async (event) => {
      for (const listener of listeners) {
        listener(event);
      }
    },
    undefined,
    async () => {
      callCount += 1;
      return streamMessage(
        callCount === 1
          ? createToolCallMessage(toolName)
          : createTextMessage("Done."),
      );
    },
  );

  const statusEvent = statusEvents[0];
  if (!statusEvent) {
    throw new Error(`Expected ${toolName} to emit a status event`);
  }

  let state = streamStoreReducer(initialStoreState, {
    type: "run-started",
    runId,
    conversationId,
    userMessageId,
  });
  const activeBeforeTool = getInlineWorkingIndicatorActive({
    isStreaming: true,
    isToolActive: Boolean(
      Object.keys(state.runsById[runId]?.activeToolCalls ?? {}).length,
    ),
  });
  state = streamStoreReducer(state, {
    type: "run-status",
    runId,
    statusText: statusEvent.statusText,
  });
  const toolStartEvent = toolStartEvents[0];
  if (!toolStartEvent) {
    throw new Error(`Expected ${toolName} to emit a tool start event`);
  }
  state = streamStoreReducer(state, {
    type: "tool-start",
    runId,
    conversationId,
    ...(toolStartEvent.toolCallId
      ? { toolCallId: toolStartEvent.toolCallId }
      : {}),
    ...(toolStartEvent.toolName ? { toolName: toolStartEvent.toolName } : {}),
    statusText: toolStartEvent.statusText ?? null,
  });
  const toolActiveRun = state.runsById[runId];
  const activeDuringTool = getInlineWorkingIndicatorActive({
    isStreaming: true,
    isToolActive: Boolean(
      Object.keys(toolActiveRun?.activeToolCalls ?? {}).length,
    ),
  });
  const displayStatusDuringTool = getWorkingIndicatorDisplayStatus({
    status: toolActiveRun?.statusText ?? undefined,
    toolName: toolStartEvent.toolName,
    toolCallId: toolStartEvent.toolCallId,
  });
  const toolEndEvent = toolEndEvents[0];
  if (!toolEndEvent) {
    throw new Error(`Expected ${toolName} to emit a tool end event`);
  }
  state = streamStoreReducer(state, {
    type: "tool-end",
    runId,
    ...(toolEndEvent.toolCallId ? { toolCallId: toolEndEvent.toolCallId } : {}),
    ...(toolEndEvent.toolName ? { toolName: toolEndEvent.toolName } : {}),
  });
  const toolEndedRun = state.runsById[runId];
  const activeAfterToolBeforeAnswer = getInlineWorkingIndicatorActive({
    isStreaming: true,
    isToolActive: Boolean(
      Object.keys(toolEndedRun?.activeToolCalls ?? {}).length,
    ),
  });

  return {
    rawStatusText: statusEvent.statusText as string,
    rawToolStartStatusText: toolStartEvent.statusText,
    rawToolEndName: toolEndEvent.toolName,
    rawToolEndIsError: toolEndEvent.isError,
    activeBeforeTool,
    activeDuringTool,
    activeAfterToolBeforeAnswer,
    statusAfterToolEnd: toolEndedRun?.statusText ?? null,
    persistedToolEvent: recordedRunEvents.find(
      (event) =>
        typeof event === "object" &&
        event !== null &&
        (event as { type?: unknown }).type === "tool_start",
    ),
    persistedToolEndEvent: recordedRunEvents.find(
      (event) =>
        typeof event === "object" &&
        event !== null &&
        (event as { type?: unknown }).type === "tool_end",
    ),
    displayStatus: displayStatusDuringTool,
  };
};

describe("subscribeRuntimeAgentEvents", () => {
  it("persists native tool failures with an explicit error result envelope", async () => {
    const failed = await runToolStatusIntegration("native_failure", {
      error: "[TOOL_ERROR] isolated native failure",
    });

    expect(failed.rawToolEndIsError).toBe(true);
    expect(failed.persistedToolEndEvent).toEqual(
      expect.objectContaining({
        type: "tool_end",
        isError: true,
        resultPreview: expect.stringContaining("[TOOL_ERROR] isolated native failure"),
      }),
    );
  });

  it("displays real runtime tool status text with friendly working indicator copy", async () => {
    const web = await runToolStatusIntegration("web");
    expect(web.rawStatusText).toBe("Running Web");
    expect(web.rawToolStartStatusText).toBe("Running Web");
    expect(web.rawToolEndName).toBe("web");
    expect(web.persistedToolEvent).toEqual(
      expect.objectContaining({ type: "tool_start", toolName: "web" }),
    );
    expect(web.activeBeforeTool).toBe(true);
    expect(web.activeDuringTool).toBe(true);
    // Gap after a fast tool returns: keep showing the thinking label rather
    // than going blank until the next tool/answer.
    expect(web.activeAfterToolBeforeAnswer).toBe(true);
    expect(web.statusAfterToolEnd).toBeNull();
    expect(web.displayStatus).toBe("Searching");

    // Recall is the orchestrator's longest wait (delegates to a recall
    // agent); the indicator must read as memory-digging, not a generic
    // thinking/working verb, and revert to normal labels once it returns.
    const recall = await runToolStatusIntegration("Recall");
    expect(recall.rawStatusText).toBe("Running Recall");
    expect(recall.rawToolStartStatusText).toBe("Running Recall");
    expect(recall.rawToolEndName).toBe("Recall");
    expect(recall.persistedToolEvent).toEqual(
      expect.objectContaining({ type: "tool_start", toolName: "Recall" }),
    );
    expect(recall.activeBeforeTool).toBe(true);
    expect(recall.activeDuringTool).toBe(true);
    expect(recall.activeAfterToolBeforeAnswer).toBe(true);
    expect(recall.statusAfterToolEnd).toBeNull();
    expect(recall.displayStatus).toBe("Searching my memory");
    // Direct tool-name path: TOOL_START carries the runtime's PascalCase
    // name, which must normalize onto the recall phrase pool.
    expect(
      getWorkingIndicatorDisplayStatus({ toolName: "Recall", toolCallId: "" }),
    ).toBe("Searching my memory");

    const spawnAgent = await runToolStatusIntegration("spawn_agent");
    expect(spawnAgent.rawStatusText).toBe("Running Spawn Agent");
    expect(spawnAgent.rawToolStartStatusText).toBe("Running Spawn Agent");
    expect(spawnAgent.rawToolEndName).toBe("spawn_agent");
    expect(spawnAgent.persistedToolEvent).toEqual(
      expect.objectContaining({ type: "tool_start", toolName: "spawn_agent" }),
    );
    expect(spawnAgent.activeBeforeTool).toBe(true);
    expect(spawnAgent.activeDuringTool).toBe(true);
    expect(spawnAgent.activeAfterToolBeforeAnswer).toBe(true);
    expect(spawnAgent.statusAfterToolEnd).toBeNull();
    expect(spawnAgent.displayStatus).toBe("On it");

    const pauseAgent = await runToolStatusIntegration("pause_agent");
    expect(pauseAgent.rawStatusText).toBe("Running Pause Agent");
    expect(pauseAgent.rawToolStartStatusText).toBe("Running Pause Agent");
    expect(pauseAgent.rawToolEndName).toBe("pause_agent");
    expect(pauseAgent.persistedToolEvent).toEqual(
      expect.objectContaining({ type: "tool_start", toolName: "pause_agent" }),
    );
    expect(pauseAgent.activeBeforeTool).toBe(true);
    expect(pauseAgent.activeDuringTool).toBe(true);
    expect(pauseAgent.activeAfterToolBeforeAnswer).toBe(true);
    expect(pauseAgent.statusAfterToolEnd).toBeNull();
    expect(pauseAgent.displayStatus).toBe("Pausing");

    const sendInput = await runToolStatusIntegration("send_input");
    expect(sendInput.rawStatusText).toBe("Running Send Input");
    expect(sendInput.rawToolStartStatusText).toBe("Running Send Input");
    expect(sendInput.rawToolEndName).toBe("send_input");
    expect(sendInput.persistedToolEvent).toEqual(
      expect.objectContaining({ type: "tool_start", toolName: "send_input" }),
    );
    expect(sendInput.activeBeforeTool).toBe(true);
    expect(sendInput.activeDuringTool).toBe(true);
    expect(sendInput.activeAfterToolBeforeAnswer).toBe(true);
    expect(sendInput.statusAfterToolEnd).toBeNull();
    expect(sendInput.displayStatus).toBe("On it");
  });

  it("keeps the indicator up for the whole run — text lands as a whole message", () => {
    const runId = "run-update-agent";
    const conversationId = "conversation-1";
    let state = streamStoreReducer(initialStoreState, {
      type: "run-started",
      runId,
      conversationId,
      userMessageId: "user-1",
    });
    state = streamStoreReducer(state, {
      type: "run-status",
      runId,
      statusText: "Resume current Nvidia web research test again",
    });

    const activeFor = (current: typeof state) =>
      getInlineWorkingIndicatorActive({
        isStreaming: !current.runsById[runId]?.terminal,
        isToolActive: Boolean(
          Object.keys(current.runsById[runId]?.activeToolCalls ?? {}).length,
        ),
      });

    // Pre-tool thinking: the orchestrator line is active.
    expect(activeFor(state)).toBe(true);

    // A spawned sub-agent starts working — the orchestrator's own indicator
    // stays up.
    state = streamStoreReducer(state, {
      type: "task-upsert",
      runId,
      conversationId,
      userMessageId: "user-1",
      task: {
        id: "agent-1",
        description: "long research task",
        agentType: AGENT_IDS.GENERAL,
        status: "running",
        startedAtMs: 1_000,
        lastUpdatedAtMs: 1_000,
      },
    });
    expect(activeFor(state)).toBe(true);

    // The sub-agent finishes — still thinking, still visible.
    state = streamStoreReducer(state, {
      type: "task-upsert",
      runId,
      conversationId,
      userMessageId: "user-1",
      task: {
        id: "agent-1",
        description: "long research task",
        agentType: AGENT_IDS.GENERAL,
        status: "completed",
        startedAtMs: 1_000,
        completedAtMs: 2_000,
        lastUpdatedAtMs: 2_000,
      },
    });
    expect(activeFor(state)).toBe(true);

    // A whole assistant message landing does NOT dismiss the indicator: the
    // run is still live (the model may keep working), so only the terminal
    // run event takes it down.
    state = streamStoreReducer(state, {
      type: "assistant-message-boundary",
      runId,
    });
    expect(activeFor(state)).toBe(true);

    state = streamStoreReducer(state, {
      type: "run-finished",
      runId,
      conversationId,
      outcome: "completed",
    });
    expect(activeFor(state)).toBe(false);
  });

  it("marks a preamble→tool-call boundary as pending a tool, and releases it on tool-end", () => {
    const runId = "run-preamble";
    const conversationId = "conversation-1";
    let state = streamStoreReducer(initialStoreState, {
      type: "run-started",
      runId,
      conversationId,
      userMessageId: "user-1",
    });
    expect(state.runsById[runId]?.pendingToolAfterPreamble).toBe(false);

    // A plain boundary (the run's final answer) records nothing.
    state = streamStoreReducer(state, {
      type: "assistant-message-boundary",
      runId,
    });
    expect(state.runsById[runId]?.pendingToolAfterPreamble).toBe(false);

    // A preamble that ends with a tool call arms the marker.
    state = streamStoreReducer(state, {
      type: "assistant-message-boundary",
      runId,
      followedByToolCall: true,
    });
    expect(state.runsById[runId]?.pendingToolAfterPreamble).toBe(true);

    // It survives the tool starting (and any parallel tool),...
    state = streamStoreReducer(state, {
      type: "tool-start",
      runId,
      conversationId,
      toolCallId: "call-1",
      toolName: "web",
    });
    state = streamStoreReducer(state, {
      type: "tool-start",
      runId,
      conversationId,
      toolCallId: "call-2",
      toolName: "read",
    });
    expect(state.runsById[runId]?.pendingToolAfterPreamble).toBe(true);

    // ...and is only released once the whole tool phase is over.
    state = streamStoreReducer(state, {
      type: "tool-end",
      runId,
      toolCallId: "call-1",
      toolName: "web",
    });
    expect(state.runsById[runId]?.pendingToolAfterPreamble).toBe(true);
    state = streamStoreReducer(state, {
      type: "tool-end",
      runId,
      toolCallId: "call-2",
      toolName: "read",
    });
    expect(state.runsById[runId]?.pendingToolAfterPreamble).toBe(false);
  });

  it("clears the in-flight tool even when tool-end is keyed differently than tool-start", () => {
    const runId = "run-tool-mismatch";
    const conversationId = "conversation-1";
    let state = streamStoreReducer(initialStoreState, {
      type: "run-started",
      runId,
      conversationId,
      userMessageId: "user-1",
    });

    // Start keyed by toolCallId, end carries only the toolName.
    state = streamStoreReducer(state, {
      type: "tool-start",
      runId,
      conversationId,
      toolCallId: "call-abc",
      toolName: "web",
    });
    expect(Object.keys(state.runsById[runId]?.activeToolCalls ?? {})).toEqual([
      "call-abc",
    ]);
    state = streamStoreReducer(state, {
      type: "tool-end",
      runId,
      toolName: "web",
    });
    expect(state.runsById[runId]?.activeToolCalls).toEqual({});

    // End carrying an unrelated id still closes the single in-flight tool.
    state = streamStoreReducer(state, {
      type: "tool-start",
      runId,
      conversationId,
      toolCallId: "call-def",
      toolName: "read",
    });
    state = streamStoreReducer(state, {
      type: "tool-end",
      runId,
      toolCallId: "stale-id",
    });
    expect(state.runsById[runId]?.activeToolCalls).toEqual({});
  });

  it("keeps only the most recent completed tool for the live status row", () => {
    const runId = "run-latest-tool";
    const conversationId = "conversation-1";
    let state = streamStoreReducer(initialStoreState, {
      type: "run-started",
      runId,
      conversationId,
    });
    state = streamStoreReducer(state, {
      type: "tool-start",
      runId,
      conversationId,
      toolCallId: "call-command",
      toolName: "exec_command",
    });
    state = streamStoreReducer(state, {
      type: "tool-end",
      runId,
      toolCallId: "call-command",
      toolName: "exec_command",
      exitCode: 0,
    });
    expect(state.runsById[runId]?.latestCompletedTool).toEqual({
      toolCallId: "call-command",
      toolName: "exec_command",
      exitCode: 0,
    });

    state = streamStoreReducer(state, {
      type: "tool-start",
      runId,
      conversationId,
      toolCallId: "call-read",
      toolName: "Read",
    });
    expect(state.runsById[runId]?.latestCompletedTool).toBeNull();
    state = streamStoreReducer(state, {
      type: "tool-end",
      runId,
      toolCallId: "call-read",
      toolName: "Read",
    });
    expect(state.runsById[runId]?.latestCompletedTool).toEqual({
      toolCallId: "call-read",
      toolName: "Read",
    });

    state = streamStoreReducer(state, {
      type: "run-finished",
      runId,
      conversationId,
      outcome: "completed",
    });
    expect(state.runsById[runId]?.latestCompletedTool).toBeNull();
  });

  it("flags a preamble message that ends with a tool call as followedByToolCall", () => {
    const store = { recordRunEvent: vi.fn() };
    const recorder = createRunEventRecorder({
      store: store as never,
      runId: "run-preamble",
      conversationId: "conversation-1",
      agentType: "orchestrator",
      userMessageId: "user-1",
      getResponseTarget: () => ({ type: "user_turn" }),
    });

    const preambleWithTool: AssistantMessage = {
      role: "assistant",
      content: [
        { type: "text", text: "Let me look that up." },
        { type: "toolCall", id: "call-web", name: "web", arguments: {} },
      ],
      api: "openai-completions",
      provider: "openai",
      model: "test-model",
      usage,
      stopReason: "toolUse",
      timestamp: 7,
    };
    const preambleEvent = recorder.recordAssistantMessageEnd(preambleWithTool);
    expect(preambleEvent?.followedByToolCall).toBe(true);

    // A plain text message (the run's final answer) carries no such flag.
    const finalAnswer = createTextMessage("All done.");
    const finalEvent = recorder.recordAssistantMessageEnd(finalAnswer);
    expect(finalEvent?.text).toBe("All done.");
    expect(finalEvent?.followedByToolCall).toBeUndefined();
  });

  it("records a completed assistant text event without a Pi message object", () => {
    const store = { recordRunEvent: vi.fn() };
    const recorder = createRunEventRecorder({
      store: store as never,
      runId: "run-claude",
      conversationId: "conversation-1",
      agentType: "orchestrator",
      userMessageId: "user-1",
      getResponseTarget: () => ({ type: "user_turn" }),
    });

    recorder.noteAssistantTextChunk("Hello ");
    const event = recorder.recordAssistantTextEnd(" Hello from Claude Code. ");

    expect(event).toEqual(
      expect.objectContaining({
        runId: "run-claude",
        agentType: "orchestrator",
        // Text deltas no longer consume a recorder seq — the assistant
        // message is the first (and only) event this recorder emitted.
        seq: 1,
        userMessageId: "user-1",
        text: "Hello from Claude Code.",
        responseTarget: { type: "user_turn" },
      }),
    );
    // The delta only stamps the segment's first-text anchor.
    expect(typeof event?.firstTextAtMs).toBe("number");
    // Chunks are never persisted as run_event rows.
    expect(store.recordRunEvent).not.toHaveBeenCalled();
  });

  it("persists a complete orchestrator tool group in one atomic batch", () => {
    const listeners = new Set<(event: AgentEvent) => void>();
    const appendThreadMessages = vi.fn();
    const appendThreadMessage = vi.fn();
    const agent = {
      state: { messages: [] },
      subscribe: (listener: (event: AgentEvent) => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    };
    const assistant = {
      ...createToolCallMessage("first"),
      content: [
        { type: "toolCall" as const, id: "call-first", name: "first", arguments: {} },
        { type: "toolCall" as const, id: "call-second", name: "second", arguments: {} },
      ],
    };
    const toolResults = [
      {
        role: "toolResult" as const,
        toolCallId: "call-first",
        toolName: "first",
        content: [{ type: "text" as const, text: "first result" }],
        details: {},
        isError: false,
        timestamp: 2,
      },
      {
        role: "toolResult" as const,
        toolCallId: "call-second",
        toolName: "second",
        content: [{ type: "text" as const, text: "second result" }],
        details: {},
        isError: false,
        timestamp: 3,
      },
    ];

    subscribeRuntimeAgentEvents({
      agent,
      runId: "run-atomic-group",
      agentType: AGENT_IDS.ORCHESTRATOR,
      recorder: createRunEventRecorder({
        store: { recordRunEvent: vi.fn() } as never,
        runId: "run-atomic-group",
        conversationId: "conversation-atomic-group",
        agentType: AGENT_IDS.ORCHESTRATOR,
        userMessageId: "user-atomic-group",
      }),
      threadStore: { appendThreadMessage, appendThreadMessages } as never,
      threadKey: "thread-atomic-group",
    });

    for (const listener of listeners) {
      listener({ type: "message_end", message: assistant });
      for (const result of toolResults) {
        listener({ type: "message_end", message: result });
      }
    }
    expect(appendThreadMessage).not.toHaveBeenCalled();
    expect(appendThreadMessages).not.toHaveBeenCalled();

    for (const listener of listeners) {
      listener({ type: "turn_end", message: assistant, toolResults });
    }
    expect(appendThreadMessages).toHaveBeenCalledOnce();
    expect(appendThreadMessages.mock.calls[0]?.[0]).toHaveLength(3);
    expect(
      appendThreadMessages.mock.calls[0]?.[0].map(
        (message: { payload: { role: string } }) => message.payload.role,
      ),
    ).toEqual(["assistant", "toolResult", "toolResult"]);
  });

  it("routes provider thinking_delta to onReasoning and skips thinking_end", () => {
    // Reasoning deltas feed the per-agent reasoning UI. Text deltas emit
    // nothing at all now — assistant text ships whole on `message_end`.
    let listener: ((event: AgentEvent) => void) | undefined;
    const agent = {
      state: { messages: [] },
      subscribe: vi.fn((next: (event: AgentEvent) => void) => {
        listener = next;
        return () => undefined;
      }),
    };
    const store = { recordRunEvent: vi.fn() };
    const onReasoning = vi.fn();
    const onProgress = vi.fn();

    subscribeRuntimeAgentEvents({
      agent,
      runId: "run-1",
      agentType: "general",
      recorder: createRunEventRecorder({
        store: store as never,
        runId: "run-1",
        conversationId: "conversation-1",
        agentType: "general",
        userMessageId: "user-1",
      }),
      callbacks: {
        onReasoning,
      },
      onProgress,
    });

    listener?.({
      type: "message_update",
      message: assistantMessage,
      assistantMessageEvent: {
        type: "thinking_delta",
        contentIndex: 0,
        delta: "Need to inspect the task.",
        partial: assistantMessage,
      },
    });
    listener?.({
      type: "message_update",
      message: assistantMessage,
      assistantMessageEvent: {
        type: "thinking_end",
        contentIndex: 0,
        content: "Need to inspect the task.",
        partial: assistantMessage,
      },
    });
    listener?.({
      type: "message_update",
      message: assistantMessage,
      assistantMessageEvent: {
        type: "text_delta",
        contentIndex: 1,
        delta: "Done.",
        partial: {
          ...assistantMessage,
          content: [
            assistantMessage.content[0],
            { type: "text" as const, text: "Done." },
          ],
        },
      },
    });

    expect(onReasoning).toHaveBeenCalledTimes(1);
    expect(onReasoning).toHaveBeenCalledWith(
      expect.objectContaining({ chunk: "Need to inspect the task." }),
    );
    expect(onReasoning).not.toHaveBeenCalledWith(
      expect.objectContaining({ chunk: "" }),
    );
    // Text deltas produce no wire event; they only feed the subagent
    // Activity feed (`onProgress`) and the segment first-text anchor.
    expect(onProgress).toHaveBeenCalledTimes(1);
    expect(onProgress).toHaveBeenCalledWith("Done.");
    expect(store.recordRunEvent).not.toHaveBeenCalled();
  });

  it("skips empty thinking_delta chunks", () => {
    let listener: ((event: AgentEvent) => void) | undefined;
    const agent = {
      state: { messages: [] },
      subscribe: vi.fn((next: (event: AgentEvent) => void) => {
        listener = next;
        return () => undefined;
      }),
    };
    const store = { recordRunEvent: vi.fn() };
    const onReasoning = vi.fn();

    subscribeRuntimeAgentEvents({
      agent,
      runId: "run-1",
      agentType: "general",
      recorder: createRunEventRecorder({
        store: store as never,
        runId: "run-1",
        conversationId: "conversation-1",
        agentType: "general",
        userMessageId: "user-1",
      }),
      callbacks: { onReasoning },
    });

    listener?.({
      type: "message_update",
      message: assistantMessage,
      assistantMessageEvent: {
        type: "thinking_delta",
        contentIndex: 0,
        delta: "",
        partial: assistantMessage,
      },
    });

    expect(onReasoning).not.toHaveBeenCalled();
  });
});

describe("queued user steer visibility", () => {
  it("keeps hidden context hidden, then promotes the consumed user steer", () => {
    const store = { recordRunEvent: vi.fn() };
    const recorder = createRunEventRecorder({
      store: store as never,
      runId: "run-hidden",
      conversationId: "conversation-1",
      agentType: AGENT_IDS.ORCHESTRATOR,
      userMessageId: "hidden-lifecycle-message",
      uiVisibility: "hidden",
    });
    const onStart = vi.fn();

    expect(recorder.recordStatus("processing agent result").uiVisibility).toBe(
      "hidden",
    );
    recorder.queueUserMessageId("user-steer", onStart, "visible");

    expect(recorder.recordQueuedUserMessageStart()).toMatchObject({
      userMessageId: "user-steer",
      uiVisibility: "visible",
    });
    expect(onStart).toHaveBeenCalledOnce();
    expect(recorder.recordAssistantTextEnd("reply")).toMatchObject({
      userMessageId: "user-steer",
      uiVisibility: "visible",
    });
  });
});

describe("sensitive runtime event payloads", () => {
  it("redacts reasoning, status, tool events, and persisted previews before dispatch", () => {
    const store = { recordRunEvent: vi.fn() };
    const recorder = createRunEventRecorder({
      store: store as never,
      runId: "run-redaction",
      conversationId: "conversation-redaction",
      agentType: AGENT_IDS.GENERAL,
      userMessageId: "user-redaction",
    });
    const jwt =
      "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJzZWNyZXQtdXNlciJ9.signature123";
    const privateKey =
      "-----BEGIN PRIVATE KEY-----\nprivate-material\n-----END PRIVATE KEY-----";
    const reasoning = recorder.recordReasoning(
      `checking Authorization: Bearer reasoning-secret ${jwt} ${privateKey}`,
    );
    const status = recorder.recordStatus(
      "Cookie: session=status-secret; tracking=1",
    );
    const toolStart = recorder.recordToolStart({
      toolCallId: "tool-redaction",
      toolName: "exec_command",
      statusText: "Authorization: Basic c3RhdHVzOnNlY3JldA==",
      toolArgs: {
        command: "API_TOKEN=command-secret curl --password flag-secret",
        headers: { authorization: "Bearer header-secret" },
        privateKey,
      },
    });
    const toolEnd = recorder.recordToolEnd({
      toolCallId: "tool-redaction",
      toolName: "exec_command",
      result: "Cookie: session=result-secret",
      details: {
        output: `Authorization: Bearer detail-secret ${jwt}`,
        password: "object-secret",
      },
      isError: true,
    });

    expect(toolEnd.isError).toBe(true);
    expect(store.recordRunEvent).toHaveBeenCalledWith(
      expect.objectContaining({ isError: true }),
    );

    const serialized = JSON.stringify({
      reasoning,
      status,
      toolStart,
      toolEnd,
      persisted: store.recordRunEvent.mock.calls,
    });
    for (const secret of [
      "reasoning-secret",
      "private-material",
      "status-secret",
      "command-secret",
      "flag-secret",
      "header-secret",
      "result-secret",
      "detail-secret",
      "object-secret",
      jwt,
    ]) {
      expect(serialized).not.toContain(secret);
    }

    decorateTask({
      agentId: "agent-redaction",
      conversationId: "conversation-redaction",
      runId: "run-redaction",
      statusText: status.statusText,
    });
    appendTaskReasoning({
      agentId: "agent-redaction",
      conversationId: "conversation-redaction",
      runId: "run-redaction",
      chunk: reasoning.chunk,
    });
    const decoration = getTaskDecoration("agent-redaction");
    expect(decoration?.reasoningText).toContain("[REDACTED]");
    expect(decoration?.statusText).not.toContain("status-secret");
    __privateTaskDecorationStore.resetForTests();
  });

  it("does not publish exec_command results as working-indicator status", () => {
    const listeners = new Set<(event: AgentEvent) => void>();
    const agent = {
      state: { messages: [] },
      subscribe: (listener: (event: AgentEvent) => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    };
    const statusEvents: RuntimeStatusEvent[] = [];
    subscribeRuntimeAgentEvents({
      agent,
      runId: "run-exec-update",
      agentType: AGENT_IDS.GENERAL,
      recorder: createRunEventRecorder({
        store: { recordRunEvent: () => undefined } as never,
        runId: "run-exec-update",
        conversationId: "conversation-exec-update",
        agentType: AGENT_IDS.GENERAL,
        userMessageId: "user-exec-update",
      }),
      callbacks: {
        onStatus: (event) => {
          statusEvents.push(event);
        },
      },
    });

    const details = {
      session_id: null,
      running: false,
      exit_code: 127,
      wall_time_seconds: 45.209,
      original_token_count: 0,
      cwd: "C:\\\\Users\\\\user\\\\AppData\\\\Local\\\\Programs\\\\Stella\\\\resources",
      command: 'wsl -e bash -lc "nvcc --version"',
    };
    const commandResults = [
      JSON.stringify({ ...details, output: "" }, null, 2),
      [
        "Wall time: 45.209 seconds",
        "Process exited with code 127",
        "Original token count: 0",
        "Output:",
        "command not found",
      ].join("\n"),
    ];
    for (const commandResult of commandResults) {
      for (const listener of listeners) {
        listener({
          type: "tool_execution_update",
          toolCallId: "call-exec",
          toolName: "exec_command",
          args: { cmd: details.command },
          partialResult: {
            content: [{ type: "text", text: commandResult }],
            details,
          },
        });
      }
    }

    expect(statusEvents).toEqual([]);
  });
});
