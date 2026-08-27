import { describe, expect, it, vi } from "vitest";

import type { Agent } from "@stella/runtime/kernel/agent-core/agent";
import type { AgentMessage } from "@stella/runtime/kernel/agent-core/types";
import type { LocalAgentContext } from "@stella/runtime/kernel/agents/local-agent-manager";
import { PiSessionCore } from "@stella/runtime/kernel/agent-runtime/pi-session-core";
import {
  QUARANTINE_CUSTOM_TYPE,
  QUARANTINE_PLACEHOLDER,
  SAFETY_SWAP_STELLA_MODEL_ID,
  serializeQuarantineRecord,
} from "@stella/runtime/kernel/agent-runtime/provider-abort-containment";
import { executeRuntimeAgentPrompt } from "@stella/runtime/kernel/agent-runtime/run-execution";
import {
  AGENT_RUN_MAX_ATTEMPTS,
  executeAgentTurnWithRetry,
  type AgentRunFailure,
  type AgentRunRetryState,
} from "@stella/runtime/kernel/agent-runtime/agent-run-retry";
import type { ResolvedLlmRoute } from "@stella/runtime/kernel/model-routing";
import { providerAbortedStopMessage } from "@stella/runtime/ai/utils/provider-stop";
import type { Api, Model, StopReason } from "@stella/runtime/ai/types";

const SAFETY_ABORT_MESSAGE = providerAbortedStopMessage("refusal");

const usage = {
  input: 1,
  output: 1,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 2,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

const userMessage = (
  timestamp: number,
  text = "do the thing",
): AgentMessage => ({
  role: "user",
  content: text,
  timestamp,
});

const assistantMessage = (
  timestamp: number,
  stopReason: StopReason,
  args?: { errorMessage?: string; text?: string },
): AgentMessage => ({
  role: "assistant",
  content: args?.text ? [{ type: "text", text: args.text }] : [],
  api: "anthropic-messages",
  provider: "anthropic",
  model: "claude-fable-5",
  usage,
  stopReason,
  ...(args?.errorMessage ? { errorMessage: args.errorMessage } : {}),
  timestamp,
});

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
  return {
    route: "stella",
    model,
    getApiKey: () => "token",
  };
};

class TestSession extends PiSessionCore {
  constructor() {
    super({ threadKey: "test-thread", loggerName: "test-session" });
  }

  setRoute(route: ResolvedLlmRoute): void {
    this.setResolvedLlm(route);
  }

  begin(agent: Agent, agentContext: LocalAgentContext) {
    return this.beginAbortContainmentTurn(agent, agentContext, {});
  }

  swap(agent: Agent, errorMessage: string) {
    return this.prepareSafetyModelSwap(agent, { errorMessage, logContext: {} });
  }

  retrySameModel(agent: Agent, errorMessage: string) {
    return this.prepareSafetySameModelRetry(agent, {
      errorMessage,
      logContext: {},
    });
  }

  retryRun(
    agent: Agent,
    failure: AgentRunFailure,
    durable?: { store: unknown; runId: string },
  ) {
    return this.prepareAgentRunRetry(agent, {
      failure,
      ...durable,
      logContext: {},
    });
  }

  fail(
    agent: Agent,
    args: { messagesBefore: number; errorMessage: string },
  ): string {
    return this.noteAbortContainmentFailure(agent, {
      ...args,
      logContext: {},
    });
  }

  streak(): number {
    return this.abortContainment.consecutiveInstantAbortCount;
  }
}

const fakeAgent = (messages: AgentMessage[], route: ResolvedLlmRoute) =>
  ({
    state: { messages, model: route.model },
    subscribe: () => () => {},
    prompt: vi.fn(async () => {}),
    followUp: vi.fn(),
    continue: vi.fn(async () => {}),
    abort: vi.fn(),
  }) as unknown as Agent & {
    prompt: ReturnType<typeof vi.fn>;
    continue: ReturnType<typeof vi.fn>;
  };

describe("prepareSafetyModelSwap bail path", () => {
  it("does not mutate the context when it bails on an assistant tail", () => {

    const route = fableStellaRoute();
    const session = new TestSession();
    session.setRoute(route);
    const messages: AgentMessage[] = [
      userMessage(1),
      assistantMessage(2, "stop", { text: "earlier reply" }),
      assistantMessage(3, "error", { errorMessage: SAFETY_ABORT_MESSAGE }),
    ];
    const agent = fakeAgent(messages, route);

    const swap = session.swap(agent, SAFETY_ABORT_MESSAGE);

    expect(swap).toBeNull();
    expect(messages).toHaveLength(3);
    expect(agent.state.model.id).toBe("stella/max");

    const surfaced = session.fail(agent, {
      messagesBefore: 2,
      errorMessage: SAFETY_ABORT_MESSAGE,
    });
    expect(surfaced).toBe(SAFETY_ABORT_MESSAGE);
    expect(session.streak()).toBe(1);
  });

  it("pops the errored tail only when the swap is committed", () => {
    const route = fableStellaRoute();
    const session = new TestSession();
    session.setRoute(route);
    const messages: AgentMessage[] = [
      userMessage(1),
      assistantMessage(2, "error", { errorMessage: SAFETY_ABORT_MESSAGE }),
    ];
    const agent = fakeAgent(messages, route);

    const swap = session.swap(agent, SAFETY_ABORT_MESSAGE);

    expect(swap).not.toBeNull();
    expect(messages).toHaveLength(1);
    expect(messages[0].role).toBe("user");
    expect(agent.state.model.id).toBe(SAFETY_SWAP_STELLA_MODEL_ID);
  });
});

describe("prepareSafetySameModelRetry", () => {
  it("pops the errored tail and keeps the fable route for a same-model retry", () => {
    const route = fableStellaRoute();
    const session = new TestSession();
    session.setRoute(route);
    const messages: AgentMessage[] = [
      userMessage(1),
      assistantMessage(2, "error", { errorMessage: SAFETY_ABORT_MESSAGE }),
    ];
    const agent = fakeAgent(messages, route);

    const retry = session.retrySameModel(agent, SAFETY_ABORT_MESSAGE);

    expect(retry).toEqual({ modelId: "stella/max" });
    expect(messages).toHaveLength(1);
    expect(messages[0].role).toBe("user");

    expect(agent.state.model.id).toBe("stella/max");
  });

  it("declines non-safety errors and non-fable routes", () => {
    const route = fableStellaRoute();
    const session = new TestSession();
    session.setRoute(route);
    const agent = fakeAgent(
      [
        userMessage(1),
        assistantMessage(2, "error", { errorMessage: "boring timeout" }),
      ],
      route,
    );
    expect(session.retrySameModel(agent, "boring timeout")).toBeNull();

    const swapped = session.swap(agent, SAFETY_ABORT_MESSAGE);
    expect(swapped).not.toBeNull();
    expect(session.retrySameModel(agent, SAFETY_ABORT_MESSAGE)).toBeNull();
  });

  it("bails without mutating on an unexpected assistant tail", () => {
    const route = fableStellaRoute();
    const session = new TestSession();
    session.setRoute(route);
    const messages: AgentMessage[] = [
      userMessage(1),
      assistantMessage(2, "stop", { text: "earlier reply" }),
      assistantMessage(3, "error", { errorMessage: SAFETY_ABORT_MESSAGE }),
    ];
    const agent = fakeAgent(messages, route);

    expect(session.retrySameModel(agent, SAFETY_ABORT_MESSAGE)).toBeNull();
    expect(messages).toHaveLength(3);
  });
});

describe("swap-resume flow (end to end)", () => {
  it("fable safety abort → swap to opus → resume continues without re-prompting", async () => {
    const route = fableStellaRoute();
    const session = new TestSession();
    session.setRoute(route);

    const messages: AgentMessage[] = [];
    const agent = fakeAgent(messages, route);

    agent.prompt.mockImplementation(async (prompted: AgentMessage[]) => {
      messages.push(...prompted);
      messages.push(
        assistantMessage(100, "error", { errorMessage: SAFETY_ABORT_MESSAGE }),
      );
    });

    agent.continue.mockImplementation(async () => {
      messages.push(assistantMessage(200, "stop", { text: "recovered" }));
    });

    const executionArgs = {
      agent,
      promptMessages: [{ text: "summarize the emails" }],
      runId: "run-1",
      agentType: "general",
      userMessageId: "msg-1",
      recorder: {} as never,
    };

    const attempt1 = await executeRuntimeAgentPrompt(executionArgs);
    expect(attempt1.errorMessage).toBe(SAFETY_ABORT_MESSAGE);
    expect(agent.prompt).toHaveBeenCalledTimes(1);

    const swap = session.swap(agent, attempt1.errorMessage!);
    expect(swap).not.toBeNull();
    expect(swap!.fromModelId).toBe("stella/max");
    expect(swap!.toModelId).toBe(SAFETY_SWAP_STELLA_MODEL_ID);
    expect(agent.state.model.id).toBe(SAFETY_SWAP_STELLA_MODEL_ID);

    expect(messages.at(-1)?.role).toBe("user");

    const attempt2 = await executeRuntimeAgentPrompt({
      ...executionArgs,
      resume: true,
    });
    expect(attempt2.errorMessage).toBeUndefined();
    expect(attempt2.finalText).toBe("recovered");

    expect(agent.prompt).toHaveBeenCalledTimes(1);
    expect(agent.continue).toHaveBeenCalledTimes(1);
  });
});

describe("transient run retry resume flow", () => {
  it("removes the durably flushed failed assistant before retrying", () => {
    const route = fableStellaRoute();
    const session = new TestSession();
    session.setRoute(route);
    const messages: AgentMessage[] = [
      userMessage(1),
      assistantMessage(2, "error", { errorMessage: "500 Server Error" }),
    ];
    const agent = fakeAgent(messages, route);
    const durableFailedMessage = {
      ...messages[1],
      stellaRunId: "run-retry",
    };
    const removeThreadMessageEntry = vi.fn(() => true);
    const store = {
      loadThreadMessages: vi.fn(() => [
        {
          entryId: "failed-entry",
          payload: durableFailedMessage,
        },
      ]),
      removeThreadMessageEntry,
    };

    const retry = session.retryRun(
      agent,
      {
        retryable: true,
        category: "http_5xx",
        message: "500 Server Error",
      },
      { store, runId: "run-retry" },
    );

    expect(retry).toBe(true);
    expect(messages).toHaveLength(1);
    expect(removeThreadMessageEntry).toHaveBeenCalledWith(
      "test-thread",
      "failed-entry",
    );
  });

  it("removes a durably flushed empty assistant before retrying", () => {
    const route = fableStellaRoute();
    const session = new TestSession();
    session.setRoute(route);
    const messages: AgentMessage[] = [
      userMessage(1),
      assistantMessage(2, "stop"),
    ];
    const agent = fakeAgent(messages, route);
    const durableEmptyMessage = {
      ...messages[1],
      stellaRunId: "run-empty-retry",
    };
    const removeThreadMessageEntry = vi.fn(() => true);
    const store = {
      loadThreadMessages: vi.fn(() => [
        {
          entryId: "empty-entry",
          payload: durableEmptyMessage,
        },
      ]),
      removeThreadMessageEntry,
    };

    expect(
      session.retryRun(
        agent,
        {
          retryable: true,
          category: "empty_response",
          message: "Provider returned an empty response",
        },
        { store, runId: "run-empty-retry" },
      ),
    ).toBe(true);
    expect(messages).toHaveLength(1);
    expect(removeThreadMessageEntry).toHaveBeenCalledWith(
      "test-thread",
      "empty-entry",
    );
  });

  it("shares the four-attempt budget across transient and safety stages", async () => {
    const route = fableStellaRoute();
    const session = new TestSession();
    session.setRoute(route);

    const messages: AgentMessage[] = [];
    const agent = fakeAgent(messages, route);
    agent.prompt.mockImplementation(async (prompted: AgentMessage[]) => {
      messages.push(...prompted);
      messages.push(
        assistantMessage(100, "error", { errorMessage: "500 Server Error" }),
      );
    });
    agent.continue
      .mockImplementationOnce(async () => {
        messages.push(
          assistantMessage(200, "error", { errorMessage: "500 Server Error" }),
        );
      })
      .mockImplementationOnce(async () => {
        messages.push(
          assistantMessage(300, "error", {
            errorMessage: SAFETY_ABORT_MESSAGE,
          }),
        );
      })
      .mockImplementationOnce(async () => {
        messages.push(
          assistantMessage(400, "error", {
            errorMessage: "429 provider rate limit exceeded",
          }),
        );
      });

    const state: AgentRunRetryState = { attemptsUsed: 0, retriesUsed: 0 };
    const executionArgs = {
      agent,
      promptMessages: [{ text: "stay within the turn budget" }],
      runId: "run-shared-budget",
      agentType: "general",
      userMessageId: "msg-shared-budget",
      recorder: {} as never,
    };
    const executeWithRetry = (initialResume = false) =>
      executeAgentTurnWithRetry({
        state,
        initialResume,
        execute: (resume) =>
          executeRuntimeAgentPrompt({
            ...executionArgs,
            ...(resume ? { resume: true } : {}),
          }),
        prepareRetry: (failure) => session.retryRun(agent, failure),
        random: () => 0.5,
        sleep: async () => undefined,
      });

    let execution = await executeWithRetry();
    expect(execution.errorMessage).toBe(SAFETY_ABORT_MESSAGE);
    expect(
      session.retrySameModel(agent, execution.errorMessage!),
    ).not.toBeNull();

    execution = await executeWithRetry(true);

    expect(state.attemptsUsed).toBe(AGENT_RUN_MAX_ATTEMPTS);
    expect(execution.attempts).toBe(AGENT_RUN_MAX_ATTEMPTS);
    expect(execution.errorMessage).toContain(
      "Automatic recovery exhausted after 4 attempts (rate_limit)",
    );
    expect(agent.prompt).toHaveBeenCalledOnce();
    expect(agent.continue).toHaveBeenCalledTimes(3);
  });

  it("resumes after a completed tool result without replaying its side effect", async () => {
    const route = fableStellaRoute();
    const session = new TestSession();
    session.setRoute(route);

    const messages: AgentMessage[] = [];
    const agent = fakeAgent(messages, route);
    const sideEffect = vi.fn();
    agent.prompt.mockImplementation(async (prompted: AgentMessage[]) => {
      messages.push(...prompted);
      sideEffect();
      messages.push({
        role: "toolResult",
        toolCallId: "call-write",
        toolName: "apply_patch",
        content: [{ type: "text", text: "write completed" }],
        isError: false,
        timestamp: 50,
      });
      messages.push(
        assistantMessage(100, "error", { errorMessage: "unexpected EOF" }),
      );
    });
    agent.continue.mockImplementation(async () => {
      expect(messages.at(-1)?.role).toBe("toolResult");
      messages.push(assistantMessage(200, "stop", { text: "recovered" }));
    });

    const result = await executeAgentTurnWithRetry({
      execute: (resume) =>
        executeRuntimeAgentPrompt({
          agent,
          promptMessages: [{ text: "make one durable change" }],
          runId: "run-transient-tool",
          agentType: "general",
          userMessageId: "msg-transient-tool",
          recorder: {} as never,
          ...(resume ? { resume: true } : {}),
        }),
      prepareRetry: (failure) => session.retryRun(agent, failure),
      random: () => 0.5,
      sleep: async () => undefined,
    });

    expect(result).toMatchObject({ finalText: "recovered", attempts: 2 });
    expect(sideEffect).toHaveBeenCalledOnce();
    expect(agent.prompt).toHaveBeenCalledOnce();
    expect(agent.continue).toHaveBeenCalledOnce();
  });
});

describe("quarantine restart re-seeding through the session", () => {
  it("re-masks persisted quarantine records on a fresh session", () => {
    const route = fableStellaRoute();
    const session = new TestSession();
    session.setRoute(route);

    const record = { key: "20:call-a", toolName: "read_email", timestamp: 20 };
    const agentContext = {
      threadHistory: [
        {
          role: "runtimeInternal",
          content: "",
          customMessage: {
            customType: QUARANTINE_CUSTOM_TYPE,
            content: [
              {
                type: "text" as const,
                text: serializeQuarantineRecord(record),
              },
            ],
            display: false,
          },
        },
      ],
    } as unknown as LocalAgentContext;

    const messages: AgentMessage[] = [
      userMessage(10),
      {
        role: "toolResult",
        toolCallId: "call-a",
        toolName: "read_email",
        content: [{ type: "text", text: "poisoned quoted content" }],
        isError: false,
        timestamp: 20,
      },
    ];
    const agent = fakeAgent(messages, route);

    const turn = session.begin(agent, agentContext);

    expect(turn.messagesBefore).toBe(2);
    expect(turn.newlyQuarantined).toBeNull();
    const masked = messages[1];
    if (masked.role === "toolResult") {
      expect((masked.content[0] as { text: string }).text).toContain(
        QUARANTINE_PLACEHOLDER,
      );
    }
  });
});
