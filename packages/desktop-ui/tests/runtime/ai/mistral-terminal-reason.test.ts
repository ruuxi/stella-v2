import { beforeEach, describe, expect, it, vi } from "vitest";

const { chatStreamMock } = vi.hoisted(() => ({
  chatStreamMock: vi.fn(),
}));

vi.mock("@mistralai/mistralai", () => ({
  Mistral: class {
    chat = { stream: chatStreamMock };
  },
}));

import { streamMistral } from "@stella/runtime/ai/providers/mistral";
import { readAssistantText } from "@stella/runtime/ai/stream";
import type { Context, Model } from "@stella/runtime/ai/types";
import { classifyAgentRunFailure } from "@stella/runtime/kernel/agent-runtime/run-retry";
import { isProviderContentAbortMessage } from "@stella/runtime/kernel/agent-runtime/provider-abort-containment";

const model: Model<"mistral-conversations"> = {
  id: "mistral-test",
  name: "Mistral Test",
  api: "mistral-conversations",
  provider: "mistral",
  baseUrl: "https://mistral.test/v1",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  maxTokens: 8_000,
  contextWindow: 32_000,
};

const context: Context = {
  messages: [{ role: "user", content: "hello", timestamp: 0 }],
  tools: [],
};

const completionStream = (finishReason: string | null) => ({
  async *[Symbol.asyncIterator]() {
    yield {
      data: {
        id: "mistral-response",
        choices: [
          {
            finishReason,
            delta: { content: "partial answer", toolCalls: [] },
          },
        ],
      },
    };
  },
});

describe("Mistral terminal reason enforcement", () => {
  beforeEach(() => {
    chatStreamMock.mockReset();
  });

  it("fails closed on an unknown future finish reason", async () => {
    chatStreamMock.mockResolvedValue(completionStream("future_shutdown"));

    const result = await streamMistral(model, context, {
      apiKey: "test-key",
    }).result();

    expect(result.stopReason).toBe("error");
    expect(result.errorMessage).toContain('stop reason: "future_shutdown"');
    expect(readAssistantText(result)).toBe("partial answer");
    expect(classifyAgentRunFailure(new Error(result.errorMessage!))).toEqual({
      retryable: true,
      category: "transport",
    });
    expect(isProviderContentAbortMessage(result.errorMessage)).toBe(false);
  });

  it("fails closed when the streamed finish reason is null", async () => {
    chatStreamMock.mockResolvedValue(completionStream(null));

    const result = await streamMistral(model, context, {
      apiKey: "test-key",
    }).result();

    expect(result.stopReason).toBe("error");
    expect(result.errorMessage).toContain('stopReason "error"');
    expect(readAssistantText(result)).toBe("partial answer");
    expect(classifyAgentRunFailure(new Error(result.errorMessage!))).toEqual({
      retryable: true,
      category: "transport",
    });
  });
});
