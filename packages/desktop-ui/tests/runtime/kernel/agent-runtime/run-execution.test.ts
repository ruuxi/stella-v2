import { describe, expect, it, vi } from "vitest";
import {
  executeRuntimeAgentPrompt,
  isDurablyPersistedRuntimePromptInput,
} from "@stella/runtime/kernel/agent-runtime/run-execution";
import { Agent } from "@stella/runtime/kernel/agent-core/agent";
import type { AgentTool } from "@stella/runtime/kernel/agent-core/types";
import type { Api, Model } from "@stella/runtime/ai/types";
import { createAssistantMessageEventStream } from "@stella/runtime/ai/utils/event-stream";

const model = {
  id: "run-execution-test",
  name: "Run execution test",
  api: "openai-completions",
  provider: "test",
  baseUrl: "https://example.test",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128_000,
  maxTokens: 4_096,
} as Model<Api>;

const createAssistantMessage = (text: string) => ({
  role: "assistant" as const,
  content: [{ type: "text" as const, text }],
  api: "openai-completions" as const,
  provider: "openai",
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
  timestamp: 1,
});

const createTurnEndingAgent = (
  assistant: ReturnType<typeof createAssistantMessage>,
) => {
  const listeners = new Set<(event: unknown) => void>();
  const agent = {
    state: { messages: [] as Array<ReturnType<typeof createAssistantMessage>> },
    subscribe: (listener: (event: unknown) => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    prompt: vi.fn(async () => {
      agent.state.messages = [assistant];
      for (const listener of listeners) {
        listener({ type: "message_end", message: assistant });
        listener({ type: "turn_end", message: assistant, toolResults: [] });
      }
    }),
    followUp: vi.fn(),
    continue: vi.fn(),
    abort: vi.fn(),
  };
  return agent;
};

describe("executeRuntimeAgentPrompt", () => {
  const validPng =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

  it("recovers one transient atomic assistant/tool-group persistence error", async () => {
    const onThreadPersistenceError = vi.fn();
    const onThreadPersistenceRecovered = vi.fn();
    const appendThreadMessages = vi.fn().mockImplementationOnce(() => {
      throw new Error("injected SQLite failure");
    });
    const assistant = createAssistantMessage("done");
    const agent = createTurnEndingAgent(assistant);

    await expect(
      executeRuntimeAgentPrompt({
        agent,
        promptMessages: [{ text: "transient", messageType: "message" }],
        runId: "run-persistence-failure",
        agentType: "orchestrator",
        userMessageId: "msg-persistence-failure",
        recorder: {
          recordAssistantMessageEnd: vi.fn(() => undefined),
        } as never,
        threadStore: {
          appendThreadMessages,
        } as never,
        threadKey: "thread-persistence-failure",
        onThreadPersistenceError,
        onThreadPersistenceRecovered,
      }),
    ).resolves.toMatchObject({ finalText: "done" });
    expect(onThreadPersistenceError).toHaveBeenCalledOnce();
    expect(onThreadPersistenceRecovered).toHaveBeenCalledOnce();
    expect(appendThreadMessages).toHaveBeenCalledTimes(2);
    expect(agent.abort).not.toHaveBeenCalled();
  });

  it("continues the provider tool loop after a transient persistence retry", async () => {
    const toolAssistant = {
      ...createAssistantMessage(""),
      content: [
        {
          type: "toolCall" as const,
          id: "tool-call-1",
          name: "exec_command",
          arguments: {},
        },
      ],
      stopReason: "toolUse" as const,
    };
    const finalAssistant = createAssistantMessage("finished");
    const responses = [toolAssistant, finalAssistant];
    const streamFn = vi.fn(() => {
      const stream = createAssistantMessageEventStream();
      const message = responses[streamFn.mock.calls.length - 1]!;
      stream.push({ type: "start", partial: message });
      stream.push({ type: "done", message });
      return stream;
    });
    const tool = {
      name: "exec_command",
      label: "Exec",
      description: "test tool",
      parameters: { type: "object", properties: {} } as never,
      execute: vi.fn(async () => ({
        content: [{ type: "text" as const, text: "ok" }],
        details: {},
      })),
    } as AgentTool;
    const agent = new Agent({
      initialState: { model, tools: [tool] },
      streamFn,
    });
    const abort = vi.spyOn(agent, "abort");
    const appendThreadMessages = vi.fn().mockImplementationOnce(() => {
      throw new Error("injected SQLite failure");
    });
    const recorder = {
      recordQueuedUserMessageStart: vi.fn(() => null),
      recordAssistantMessageEnd: vi.fn(() => null),
      recordToolStart: vi.fn(() => ({})),
      recordToolEnd: vi.fn(() => ({ resultPreview: "ok" })),
      recordStatus: vi.fn(() => ({})),
    };

    await expect(
      executeRuntimeAgentPrompt({
        agent,
        promptMessages: [{ text: "run", messageType: "message" }],
        runId: "run-persistence-continuation",
        agentType: "orchestrator",
        userMessageId: "msg-persistence-continuation",
        recorder: recorder as never,
        threadStore: { appendThreadMessages } as never,
        threadKey: "thread-persistence-continuation",
      }),
    ).resolves.toMatchObject({ finalText: "finished" });
    expect(streamFn).toHaveBeenCalledTimes(2);
    expect(tool.execute).toHaveBeenCalledOnce();
    expect(appendThreadMessages).toHaveBeenCalledTimes(3);
    expect(abort).not.toHaveBeenCalled();
  });

  it("fails closed when atomic assistant/tool-group persistence cannot recover", async () => {
    const onThreadPersistenceError = vi.fn();
    const onThreadPersistenceRecovered = vi.fn();
    const appendThreadMessages = vi.fn(() => {
      throw new Error("persistent SQLite failure");
    });
    const agent = createTurnEndingAgent(createAssistantMessage("done"));

    await expect(
      executeRuntimeAgentPrompt({
        agent,
        promptMessages: [{ text: "transient", messageType: "message" }],
        runId: "run-persistent-failure",
        agentType: "orchestrator",
        userMessageId: "msg-persistent-failure",
        recorder: {
          recordAssistantMessageEnd: vi.fn(() => undefined),
        } as never,
        threadStore: { appendThreadMessages } as never,
        threadKey: "thread-persistent-failure",
        onThreadPersistenceError,
        onThreadPersistenceRecovered,
      }),
    ).rejects.toThrow(
      "Failed to persist complete assistant/tool group: persistent SQLite failure",
    );
    expect(onThreadPersistenceError).toHaveBeenCalledOnce();
    expect(onThreadPersistenceRecovered).not.toHaveBeenCalled();
    expect(appendThreadMessages).toHaveBeenCalledTimes(2);
    expect(agent.abort).toHaveBeenCalledOnce();
  });

  it("classifies durable and one-shot internal prompts for page-in", () => {
    expect(
      isDurablyPersistedRuntimePromptInput({
        text: "transient reminder",
        messageType: "message",
        customType: "runtime.orchestrator_reminder",
      }),
    ).toBe(true);
    expect(
      isDurablyPersistedRuntimePromptInput({
        text: "durable context delta",
        messageType: "message",
        customType: "runtime.context_delta.tools",
      }),
    ).toBe(true);
    expect(
      isDurablyPersistedRuntimePromptInput({
        text: "already persisted child report",
        messageType: "message",
        customType: "runtime.task_lifecycle",
      }),
    ).toBe(true);
    expect(
      isDurablyPersistedRuntimePromptInput({
        text: "reply to the already-persisted follow-up",
        messageType: "message",
        customType: "runtime.queued_message_reply",
      }),
    ).toBe(false);
  });

  it("does not dispatch a provider prompt for an already-aborted signal", async () => {
    const abortController = new AbortController();
    abortController.abort(new Error("Canceled before dispatch"));
    const agent = {
      state: { messages: [] },
      subscribe: vi.fn(() => () => {}),
      prompt: vi.fn(),
      followUp: vi.fn(),
      continue: vi.fn(),
      abort: vi.fn(),
    };

    await expect(
      executeRuntimeAgentPrompt({
        agent,
        promptText: "must not be sent",
        runId: "run-pre-aborted",
        agentType: "orchestrator",
        userMessageId: "msg-pre-aborted",
        recorder: {} as never,
        abortSignal: abortController.signal,
      }),
    ).rejects.toThrow("Canceled before dispatch");
    expect(agent.prompt).not.toHaveBeenCalled();
    expect(agent.subscribe).not.toHaveBeenCalled();
  });

  it("does not persist or emit internal message prompts", async () => {
    const appendThreadMessage = vi.fn();
    const appendThreadCustomMessage = vi.fn();
    const onUserMessage = vi.fn();
    const prompt = vi.fn(async () => {
      agent.state.messages = [createAssistantMessage("done")];
    });
    const agent = {
      state: {
        messages: [] as Array<ReturnType<typeof createAssistantMessage>>,
      },
      subscribe: () => () => {},
      prompt,
      followUp: vi.fn(),
      continue: vi.fn(),
      abort: vi.fn(),
    };

    const result = await executeRuntimeAgentPrompt({
      agent,
      promptMessages: [
        {
          text: "Hidden reminder",
          uiVisibility: "hidden",
          messageType: "message",
        },
      ],
      runId: "run-1",
      agentType: "orchestrator",
      userMessageId: "msg-1",
      recorder: {} as never,
      callbacks: { onUserMessage },
      threadStore: {
        appendThreadMessage,
        appendThreadCustomMessage,
      } as never,
      threadKey: "thread-1",
    });

    expect(result.finalText).toBe("done");
    expect(prompt).toHaveBeenCalledOnce();
    expect(prompt).toHaveBeenCalledWith([
      expect.objectContaining({
        role: "runtimeInternal",
      }),
    ]);
    expect(appendThreadMessage).not.toHaveBeenCalled();
    expect(appendThreadCustomMessage).not.toHaveBeenCalled();
    expect(onUserMessage).not.toHaveBeenCalled();
  });

  it("persists a task lifecycle prompt once with its stable event ID", async () => {
    const appendThreadCustomMessage = vi.fn();
    const priorAssistant = createAssistantMessage("previous turn");
    const durableLifecycleMessage = {
      role: "runtimeInternal" as const,
      content: [{ type: "text" as const, text: "[Agent completed]" }],
      timestamp: 123,
      customType: "runtime.task_lifecycle",
      eventId: "task-1:1:agent-completed",
      display: false,
    };
    const agent = {
      state: {
        messages: [priorAssistant] as Array<
          | ReturnType<typeof createAssistantMessage>
          | typeof durableLifecycleMessage
        >,
      },
      subscribe: () => () => {},
      prompt: vi.fn(async (messages: Array<typeof durableLifecycleMessage>) => {
        expect(agent.state.messages).toEqual([priorAssistant]);
        agent.state.messages = [
          priorAssistant,
          ...messages,
          createAssistantMessage("done"),
        ];
      }),
      followUp: vi.fn(),
      continue: vi.fn(),
      abort: vi.fn(),
    };

    await executeRuntimeAgentPrompt({
      agent,
      promptMessages: [
        {
          text: "[Agent completed]",
          uiVisibility: "hidden",
          messageType: "message",
          customType: "runtime.task_lifecycle",
          eventId: durableLifecycleMessage.eventId,
          display: false,
          timestamp: 123,
        },
      ],
      runId: "run-task-lifecycle",
      agentType: "orchestrator",
      userMessageId: "msg-task-lifecycle",
      recorder: {} as never,
      callbacks: {},
      threadStore: { appendThreadCustomMessage } as never,
      threadKey: "thread-task-lifecycle",
    });

    expect(appendThreadCustomMessage).toHaveBeenCalledOnce();
    expect(appendThreadCustomMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        customType: "runtime.task_lifecycle",
        eventId: durableLifecycleMessage.eventId,
      }),
    );
    expect(agent.prompt).toHaveBeenCalledWith([durableLifecycleMessage]);
    expect(
      agent.state.messages.filter(
        (message) => message.role === "runtimeInternal",
      ),
    ).toEqual([durableLifecycleMessage]);
  });

  it("does not duplicate a pre-persisted task lifecycle prompt", async () => {
    const appendThreadCustomMessage = vi.fn();
    const priorAssistant = createAssistantMessage("previous turn");
    const durableLifecycleMessage = {
      role: "runtimeInternal" as const,
      content: [{ type: "text" as const, text: "[Agent completed]" }],
      timestamp: 123,
      customType: "runtime.task_lifecycle",
      eventId: "task-1:1:agent-completed",
      display: false,
    };
    const agent = {
      state: {
        messages: [priorAssistant, durableLifecycleMessage] as Array<
          | ReturnType<typeof createAssistantMessage>
          | typeof durableLifecycleMessage
        >,
      },
      subscribe: () => () => {},
      prompt: vi.fn(async (messages: Array<typeof durableLifecycleMessage>) => {
        expect(agent.state.messages).toEqual([priorAssistant]);
        agent.state.messages = [
          priorAssistant,
          ...messages,
          createAssistantMessage("done"),
        ];
      }),
      followUp: vi.fn(),
      continue: vi.fn(),
      abort: vi.fn(),
    };

    await executeRuntimeAgentPrompt({
      agent,
      promptMessages: [
        {
          text: "[Agent completed]",
          uiVisibility: "hidden",
          messageType: "message",
          customType: "runtime.task_lifecycle",
          eventId: durableLifecycleMessage.eventId,
          display: false,
          timestamp: 123,
        },
      ],
      runId: "run-task-lifecycle",
      agentType: "orchestrator",
      userMessageId: "msg-task-lifecycle",
      recorder: {} as never,
      callbacks: {},
      threadStore: { appendThreadCustomMessage } as never,
      threadKey: "thread-task-lifecycle",
    });

    expect(appendThreadCustomMessage).not.toHaveBeenCalled();
    expect(agent.prompt).toHaveBeenCalledWith([durableLifecycleMessage]);
    expect(
      agent.state.messages.filter(
        (message) => message.role === "runtimeInternal",
      ),
    ).toEqual([durableLifecycleMessage]);
  });

  it("consumes a roster reminder only after its hidden message is durable", async () => {
    const appendThreadCustomMessage = vi.fn(async () => undefined);
    const consumeOrchestratorReminder = vi.fn();
    const agent = {
      state: {
        messages: [] as Array<ReturnType<typeof createAssistantMessage>>,
      },
      subscribe: () => () => {},
      prompt: vi.fn(async () => {
        agent.state.messages = [createAssistantMessage("done")];
      }),
      followUp: vi.fn(),
      continue: vi.fn(),
      abort: vi.fn(),
    };

    await executeRuntimeAgentPrompt({
      agent,
      promptMessages: [
        {
          text: "Other Threads fresh snapshot",
          uiVisibility: "hidden",
          messageType: "message",
          customType: "runtime.orchestrator_reminder",
          display: false,
        },
      ],
      runId: "run-roster",
      agentType: "orchestrator",
      conversationId: "conversation-roster",
      userMessageId: "msg-roster",
      recorder: {} as never,
      callbacks: {},
      threadStore: {
        appendThreadCustomMessage,
        consumeOrchestratorReminder,
      } as never,
      threadKey: "thread-roster",
    });

    expect(appendThreadCustomMessage).toHaveBeenCalledOnce();
    expect(appendThreadCustomMessage.mock.invocationCallOrder[0]).toBeLessThan(
      consumeOrchestratorReminder.mock.invocationCallOrder[0]!,
    );
    expect(consumeOrchestratorReminder).toHaveBeenCalledWith(
      "conversation-roster",
    );
  });

  it("leaves a roster reminder armed when durable persistence fails", async () => {
    const appendThreadCustomMessage = vi.fn(() => {
      throw new Error("disk unavailable");
    });
    const consumeOrchestratorReminder = vi.fn();
    const agent = {
      state: { messages: [] },
      subscribe: () => () => {},
      prompt: vi.fn(),
      followUp: vi.fn(),
      continue: vi.fn(),
      abort: vi.fn(),
    };

    await expect(
      executeRuntimeAgentPrompt({
        agent: agent as never,
        promptMessages: [
          {
            text: "Other Threads fresh snapshot",
            uiVisibility: "hidden",
            messageType: "message",
            customType: "runtime.orchestrator_reminder",
            display: false,
          },
        ],
        runId: "run-roster-failure",
        agentType: "orchestrator",
        conversationId: "conversation-roster",
        userMessageId: "msg-roster-failure",
        recorder: {} as never,
        callbacks: {},
        threadStore: {
          appendThreadCustomMessage,
          consumeOrchestratorReminder,
        } as never,
        threadKey: "thread-roster",
      }),
    ).rejects.toThrow("disk unavailable");

    expect(consumeOrchestratorReminder).not.toHaveBeenCalled();
  });

  it("keeps persisting and emitting user prompt messages", async () => {
    const appendThreadMessage = vi.fn();
    const onUserMessage = vi.fn();
    const agent = {
      state: {
        messages: [] as Array<ReturnType<typeof createAssistantMessage>>,
      },
      subscribe: () => () => {},
      prompt: vi.fn(async () => {
        agent.state.messages = [createAssistantMessage("done")];
      }),
      followUp: vi.fn(),
      continue: vi.fn(),
      abort: vi.fn(),
    };

    await executeRuntimeAgentPrompt({
      agent,
      promptMessages: [
        {
          text: "Visible user message",
          uiVisibility: "visible",
        },
      ],
      runId: "run-2",
      agentType: "orchestrator",
      userMessageId: "msg-2",
      recorder: {} as never,
      callbacks: { onUserMessage },
      threadStore: {
        appendThreadMessage,
      } as never,
      threadKey: "thread-2",
    });

    expect(appendThreadMessage).toHaveBeenCalledOnce();
    expect(onUserMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        userMessageId: "msg-2",
        text: "Visible user message",
        uiVisibility: "visible",
      }),
    );
  });

  it("persists file access context separately without exposing it in the user bubble", async () => {
    const appendThreadMessage = vi.fn();
    const appendThreadCustomMessage = vi.fn();
    const onUserMessage = vi.fn();
    const agent = {
      state: { messages: [] as Array<ReturnType<typeof createAssistantMessage>> },
      subscribe: () => () => {},
      prompt: vi.fn(async () => {
        agent.state.messages = [createAssistantMessage("done")];
      }),
      followUp: vi.fn(), continue: vi.fn(), abort: vi.fn(),
    };
    await executeRuntimeAgentPrompt({
      agent,
      promptMessages: [{
        text: "Read the attached file", uiVisibility: "visible",
        attachments: [{ url: "/tmp/test-note.txt", sourcePath: "/tmp/test-note.txt", kind: "file", mimeType: "text/plain" }],
      }],
      runId: "run-file", agentType: "orchestrator", userMessageId: "msg-file",
      recorder: {} as never, callbacks: { onUserMessage },
      threadStore: { appendThreadMessage, appendThreadCustomMessage } as never,
      threadKey: "thread-file",
    });
    expect(agent.prompt).toHaveBeenCalledWith([
      expect.objectContaining({ role: "user", content: [{ type: "text", text: "Read the attached file" }] }),
      expect.objectContaining({
        role: "runtimeInternal", customType: "runtime.file_attachments", display: false,
        content: [{ type: "text", text: expect.stringContaining("/tmp/test-note.txt") }],
      }),
    ]);
    expect(appendThreadMessage).toHaveBeenCalledOnce();
    expect(appendThreadCustomMessage).toHaveBeenCalledWith(expect.objectContaining({ customType: "runtime.file_attachments", display: false }));
    expect(JSON.stringify(onUserMessage.mock.calls)).not.toContain("/tmp/test-note.txt");
    expect(JSON.stringify(appendThreadMessage.mock.calls)).not.toContain("/tmp/test-note.txt");
  });

  it("persists a hidden description beside each new image for text-only models", async () => {
    const appendThreadMessage = vi.fn();
    const appendThreadCustomMessage = vi.fn();
    const onUserMessage = vi.fn();
    const describeImages = vi.fn(
      async () => "A settings window with a red connection error.",
    );
    const agent = {
      state: {
        messages: [] as Array<ReturnType<typeof createAssistantMessage>>,
        model: { input: ["text" as const] },
      },
      subscribe: () => () => {},
      prompt: vi.fn(async () => {
        agent.state.messages = [createAssistantMessage("done")];
      }),
      followUp: vi.fn(),
      continue: vi.fn(),
      abort: vi.fn(),
    };

    await executeRuntimeAgentPrompt({
      agent,
      promptMessages: [
        {
          text: "What is wrong here?",
          uiVisibility: "visible",
          attachments: [
            {
              url: `data:image/png;base64,${validPng}`,
              mimeType: "image/png",
            },
          ],
        },
      ],
      describeImages,
      runId: "run-image",
      agentType: "orchestrator",
      userMessageId: "msg-image",
      recorder: {} as never,
      callbacks: { onUserMessage },
      threadStore: {
        appendThreadMessage,
        appendThreadCustomMessage,
      } as never,
      threadKey: "thread-image",
    });

    expect(describeImages).toHaveBeenCalledOnce();
    expect(agent.prompt).toHaveBeenCalledWith([
      expect.objectContaining({
        role: "user",
        content: expect.arrayContaining([
          { type: "text", text: "What is wrong here?" },
          expect.objectContaining({ type: "image" }),
        ]),
      }),
      expect.objectContaining({
        role: "runtimeInternal",
        customType: "vision.image_description",
        display: false,
        content: [
          {
            type: "text",
            text: "<image_description>\nA settings window with a red connection error.\n</image_description>",
          },
        ],
      }),
    ]);
    expect(appendThreadMessage).toHaveBeenCalledOnce();
    expect(appendThreadCustomMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        customType: "vision.image_description",
        display: false,
      }),
    );
    expect(onUserMessage).toHaveBeenCalledOnce();
  });

  it("sends a new image directly when the selected model supports vision", async () => {
    const describeImages = vi.fn();
    const agent = {
      state: {
        messages: [] as Array<ReturnType<typeof createAssistantMessage>>,
        model: { input: ["text" as const, "image" as const] },
      },
      subscribe: () => () => {},
      prompt: vi.fn(async () => {
        agent.state.messages = [createAssistantMessage("done")];
      }),
      followUp: vi.fn(),
      continue: vi.fn(),
      abort: vi.fn(),
    };

    await executeRuntimeAgentPrompt({
      agent,
      promptText: "Look at this",
      attachments: [
        {
          url: `data:image/png;base64,${validPng}`,
          mimeType: "image/png",
        },
      ],
      describeImages,
      runId: "run-native-image",
      agentType: "orchestrator",
      userMessageId: "msg-native-image",
      recorder: {} as never,
    });

    expect(describeImages).not.toHaveBeenCalled();
    expect(agent.prompt).toHaveBeenCalledWith([
      expect.objectContaining({
        role: "user",
        content: expect.arrayContaining([
          expect.objectContaining({ type: "image" }),
        ]),
      }),
    ]);
  });

  it("fails a silent native agent prompt instead of hanging", async () => {
    const previousTimeout = process.env.STELLA_AGENT_STARTUP_IDLE_TIMEOUT_MS;
    process.env.STELLA_AGENT_STARTUP_IDLE_TIMEOUT_MS = "25";
    const listeners = new Set<(event: never) => void>();
    const agent = {
      state: {
        messages: [] as Array<ReturnType<typeof createAssistantMessage>>,
      },
      subscribe: vi.fn((listener: (event: never) => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      }),
      prompt: vi.fn(() => new Promise<void>(() => {})),
      followUp: vi.fn(),
      continue: vi.fn(),
      abort: vi.fn(),
    };

    try {
      await expect(
        executeRuntimeAgentPrompt({
          agent,
          promptText: "silent",
          runId: "run-3",
          agentType: "general",
          userMessageId: "msg-3",
          recorder: {} as never,
        }),
      ).rejects.toThrow("Agent did not produce activity");
      expect(agent.abort).toHaveBeenCalledOnce();
      expect(listeners.size).toBe(0);
    } finally {
      if (previousTimeout === undefined) {
        delete process.env.STELLA_AGENT_STARTUP_IDLE_TIMEOUT_MS;
      } else {
        process.env.STELLA_AGENT_STARTUP_IDLE_TIMEOUT_MS = previousTimeout;
      }
    }
  });

  it("does not treat a silent in-flight tool as an idle agent", async () => {
    const previousTimeout = process.env.STELLA_AGENT_IDLE_TIMEOUT_MS;
    process.env.STELLA_AGENT_IDLE_TIMEOUT_MS = "25";
    const listeners = new Set<(event: never) => void>();
    let idleListener: ((event: never) => void) | undefined;
    let finishPrompt: (() => void) | undefined;
    const agent = {
      state: {
        messages: [] as Array<ReturnType<typeof createAssistantMessage>>,
      },
      subscribe: vi.fn((listener: (event: never) => void) => {
        idleListener ??= listener;
        listeners.add(listener);
        return () => listeners.delete(listener);
      }),
      prompt: vi.fn(
        () =>
          new Promise<void>((resolve) => {
            finishPrompt = resolve;
          }),
      ),
      followUp: vi.fn(),
      continue: vi.fn(),
      abort: vi.fn(),
    };

    try {
      const execution = executeRuntimeAgentPrompt({
        agent,
        promptText: "run a long command",
        runId: "run-4",
        agentType: "general",
        userMessageId: "msg-4",
        recorder: {} as never,
      });
      await vi.waitFor(() => expect(idleListener).toBeDefined());
      idleListener?.({
        type: "tool_execution_start",
        toolCallId: "tool-1",
        toolName: "exec_command",
        args: {},
      } as never);
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(agent.abort).not.toHaveBeenCalled();

      agent.state.messages = [createAssistantMessage("done")];
      idleListener?.({
        type: "tool_execution_end",
        toolCallId: "tool-1",
        toolName: "exec_command",
        result: { content: [], details: {} },
        isError: false,
      } as never);
      finishPrompt?.();
      await expect(execution).resolves.toMatchObject({ finalText: "done" });
      expect(agent.abort).not.toHaveBeenCalled();
    } finally {
      if (previousTimeout === undefined) {
        delete process.env.STELLA_AGENT_IDLE_TIMEOUT_MS;
      } else {
        process.env.STELLA_AGENT_IDLE_TIMEOUT_MS = previousTimeout;
      }
    }
  });

  it("aborts the run at the tool ceiling when in-flight tool tracking leaks", async () => {
    const previousIdle = process.env.STELLA_AGENT_IDLE_TIMEOUT_MS;
    const previousToolIdle = process.env.STELLA_AGENT_TOOL_IDLE_TIMEOUT_MS;
    process.env.STELLA_AGENT_IDLE_TIMEOUT_MS = "25";
    process.env.STELLA_AGENT_TOOL_IDLE_TIMEOUT_MS = "60";
    let idleListener: ((event: never) => void) | undefined;
    const agent = {
      state: {
        messages: [] as Array<ReturnType<typeof createAssistantMessage>>,
      },
      subscribe: vi.fn((listener: (event: never) => void) => {
        idleListener ??= listener;
        return () => {};
      }),
      prompt: vi.fn(() => new Promise<void>(() => {})),
      followUp: vi.fn(),
      continue: vi.fn(),
      abort: vi.fn(),
    };

    try {
      const execution = executeRuntimeAgentPrompt({
        agent,
        promptText: "run a command whose end event is lost",
        runId: "run-5",
        agentType: "general",
        userMessageId: "msg-5",
        recorder: {} as never,
      });
      await vi.waitFor(() => expect(idleListener).toBeDefined());
      idleListener?.({
        type: "tool_execution_start",
        toolCallId: "tool-leaked",
        toolName: "exec_command",
        args: {},
      } as never);
      // Outlives the plain idle window (25ms) because a tool is in flight...
      await new Promise((resolve) => setTimeout(resolve, 40));
      expect(agent.abort).not.toHaveBeenCalled();
      // ...but the tool ceiling (60ms) still bounds a leaked entry.
      await expect(execution).rejects.toThrow(/still marked in flight/);
      expect(agent.abort).toHaveBeenCalled();
    } finally {
      if (previousIdle === undefined) {
        delete process.env.STELLA_AGENT_IDLE_TIMEOUT_MS;
      } else {
        process.env.STELLA_AGENT_IDLE_TIMEOUT_MS = previousIdle;
      }
      if (previousToolIdle === undefined) {
        delete process.env.STELLA_AGENT_TOOL_IDLE_TIMEOUT_MS;
      } else {
        process.env.STELLA_AGENT_TOOL_IDLE_TIMEOUT_MS = previousToolIdle;
      }
    }
  });
});
