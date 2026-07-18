import { describe, expect, it, vi } from "vitest";

import type { AssistantMessage } from "@stella/runtime/ai/types";
import { AssistantMessageEventStream } from "@stella/runtime/ai/utils/event-stream";
import { executeRuntimeAgentPrompt } from "@stella/runtime/kernel/agent-runtime/run-execution";
import { createRunEventRecorder } from "@stella/runtime/kernel/agent-runtime/run-events";
import { executeAgentRunWithRetry } from "@stella/runtime/kernel/agent-runtime/run-retry";
import { createRuntimeAgent } from "@stella/runtime/kernel/agent-runtime/shared";

const model = {
  id: "empty-test-model",
  name: "Empty test model",
  api: "openai-completions",
  provider: "test",
  baseUrl: "https://example.test",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128_000,
  maxTokens: 4_096,
} as const;

const assistantMessage = (
  text: string,
  timestamp: number,
): AssistantMessage => ({
  role: "assistant",
  content: [{ type: "text", text }],
  api: "openai-completions",
  provider: "test",
  model: model.id,
  usage: {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  },
  stopReason: "stop",
  timestamp,
});

const streamMessage = (message: AssistantMessage) => {
  const stream = new AssistantMessageEventStream();
  queueMicrotask(() => {
    stream.push({ type: "start", partial: message });
    stream.push({ type: "done", reason: "stop", message });
    stream.end(message);
  });
  return stream;
};

const runProviderSequence = async (responses: string[]) => {
  let providerCalls = 0;
  const streamFn = vi.fn(async () => {
    const text = responses[providerCalls] ?? responses.at(-1) ?? "";
    providerCalls += 1;
    return streamMessage(assistantMessage(text, providerCalls));
  });
  const agent = createRuntimeAgent({
    agentType: "general",
    systemPrompt: "Return a result.",
    resolvedLlm: {
      model,
      route: "direct-provider",
      getApiKey: () => undefined,
    },
    tools: [],
    historySource: [],
  });
  agent.streamFn = streamFn;
  const recorder = createRunEventRecorder({
    store: { recordRunEvent: vi.fn() } as never,
    runId: "provider-budget-run",
    conversationId: "provider-budget-conversation",
    agentType: "general",
    userMessageId: "provider-budget-user",
  });

  const result = await executeAgentRunWithRetry({
    state: { retriesUsed: 0 },
    execute: (resume) =>
      executeRuntimeAgentPrompt({
        agent,
        ...(resume ? { resume: true } : { promptText: "Complete the task." }),
        runId: "provider-budget-run",
        agentType: "general",
        userMessageId: "provider-budget-user",
        recorder,
      }),
    prepareResume: (_reason, classification) => {
      expect(classification.category).toBe("empty-completion");
      const tail = agent.state.messages.at(-1);
      expect(tail?.role).toBe("assistant");
      agent.state.messages.pop();
      return true;
    },
    sleep: async () => undefined,
    random: () => 0.5,
  });

  return { agent, result, streamFn };
};

describe("native empty-completion provider budget", () => {
  it("uses two actual provider calls for empty then success", async () => {
    const { agent, result, streamFn } = await runProviderSequence([
      "",
      "recovered",
    ]);

    expect(agent.streamFn).toBe(streamFn);
    expect(result).toEqual({ finalText: "recovered" });
    expect(streamFn).toHaveBeenCalledTimes(2);
  });

  it("caps persistent empty completions at four actual provider calls", async () => {
    const { result, streamFn } = await runProviderSequence(["", "", "", ""]);

    expect(streamFn).toHaveBeenCalledTimes(4);
    expect(result.errorMessage).toContain("failed after 4 attempts");
    expect(result.errorMessage).toContain("empty completion");
  });
});
