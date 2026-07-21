import { afterEach, describe, expect, it, vi } from "vitest";

import { streamAzureOpenAIResponses } from "@stella/runtime/ai/providers/azure-openai-responses";
import { streamOpenAICodexResponses } from "@stella/runtime/ai/providers/openai-codex-responses";
import { streamSimpleOpenAICompletions } from "@stella/runtime/ai/providers/openai-completions";
import { readAssistantText } from "@stella/runtime/ai/stream";
import type { Model } from "@stella/runtime/ai/types";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

const eventStream = (events: unknown[]): Response =>
  new Response(
    events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""),
    {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    },
  );

describe("provider premature EOF terminal semantics", () => {
  it("returns an error for OpenAI Completions text without finish_reason", async () => {
    globalThis.fetch = vi.fn(async () =>
      eventStream([
        {
          id: "chatcmpl-partial",
          object: "chat.completion.chunk",
          created: 1,
          model: "partial-model",
          choices: [
            {
              index: 0,
              delta: { role: "assistant", content: "partial summary text" },
              finish_reason: null,
            },
          ],
        },
      ]),
    ) as typeof fetch;

    const model: Model<"openai-completions"> = {
      id: "partial-model",
      name: "Partial model",
      api: "openai-completions",
      provider: "custom",
      baseUrl: "https://completion.test/v1",
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 128_000,
      maxTokens: 16_000,
    };

    const result = await streamSimpleOpenAICompletions(
      model,
      { messages: [] },
      { apiKey: "test-key" },
    ).result();

    expect(result.stopReason).toBe("error");
    expect(result.errorMessage).toContain("stopReason");
    expect(readAssistantText(result)).toBe("partial summary text");
  });

  it("returns an error for Azure Responses text without a terminal event", async () => {
    globalThis.fetch = vi.fn(async () =>
      eventStream([
        {
          type: "response.output_text.delta",
          sequence_number: 1,
          item_id: "message-partial",
          output_index: 0,
          content_index: 0,
          delta: "partial azure summary",
        },
      ]),
    ) as typeof fetch;

    const model: Model<"azure-openai-responses"> = {
      id: "azure-deployment",
      name: "Azure deployment",
      api: "azure-openai-responses",
      provider: "azure-openai-responses",
      baseUrl: "https://azure.test/openai/v1",
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 128_000,
      maxTokens: 16_000,
    };

    const result = await streamAzureOpenAIResponses(
      model,
      { messages: [] },
      {
        apiKey: "test-key",
        azureBaseUrl: "https://azure.test/openai/v1",
        azureApiVersion: "v1",
      },
    ).result();

    expect(result.stopReason).toBe("error");
    expect(result.errorMessage).toContain("stopReason");
    expect(readAssistantText(result)).toBe("partial azure summary");
  });

  it("returns an error for Codex Responses text without a terminal event", async () => {
    globalThis.fetch = vi.fn(async () =>
      eventStream([
        {
          type: "response.output_text.delta",
          sequence_number: 1,
          item_id: "message-partial",
          output_index: 0,
          content_index: 0,
          delta: "partial codex summary",
        },
      ]),
    ) as typeof fetch;

    const model: Model<"openai-codex-responses"> = {
      id: "gpt-test",
      name: "Codex test",
      api: "openai-codex-responses",
      provider: "openai-codex",
      baseUrl: "https://codex.test/backend-api",
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 128_000,
      maxTokens: 16_000,
    };
    const token = `e30.${btoa(
      JSON.stringify({
        "https://api.openai.com/auth": {
          chatgpt_account_id: "account-test",
        },
      }),
    )}.sig`;

    const result = await streamOpenAICodexResponses(
      model,
      { messages: [] },
      { apiKey: token, transport: "sse" },
    ).result();

    expect(result.stopReason).toBe("error");
    expect(result.errorMessage).toContain("stopReason");
    expect(readAssistantText(result)).toBe("partial codex summary");
  });
});

describe("response terminal classification", () => {
  it("treats response.incomplete without a status field as length", async () => {
    globalThis.fetch = vi.fn(async () =>
      eventStream([
        {
          type: "response.incomplete",
          sequence_number: 1,
          response: { id: "resp-incomplete" },
        },
      ]),
    ) as typeof fetch;

    const model: Model<"azure-openai-responses"> = {
      id: "azure-deployment",
      name: "Azure deployment",
      api: "azure-openai-responses",
      provider: "azure-openai-responses",
      baseUrl: "https://azure.test/openai/v1",
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 128_000,
      maxTokens: 16_000,
    };

    const result = await streamAzureOpenAIResponses(
      model,
      { messages: [] },
      {
        apiKey: "test-key",
        azureBaseUrl: "https://azure.test/openai/v1",
        azureApiVersion: "v1",
      },
    ).result();

    expect(result.stopReason).toBe("length");
    expect(result.responseId).toBe("resp-incomplete");
  });

  it("accepts a completed event carrying a stale in_progress status", async () => {
    globalThis.fetch = vi.fn(async () =>
      eventStream([
        {
          type: "response.output_text.delta",
          sequence_number: 1,
          item_id: "message-complete",
          output_index: 0,
          content_index: 0,
          delta: "complete answer",
        },
        {
          type: "response.completed",
          sequence_number: 2,
          response: { id: "resp-complete", status: "in_progress" },
        },
      ]),
    ) as typeof fetch;

    const model: Model<"azure-openai-responses"> = {
      id: "azure-deployment",
      name: "Azure deployment",
      api: "azure-openai-responses",
      provider: "azure-openai-responses",
      baseUrl: "https://azure.test/openai/v1",
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 128_000,
      maxTokens: 16_000,
    };

    const result = await streamAzureOpenAIResponses(
      model,
      { messages: [] },
      {
        apiKey: "test-key",
        azureBaseUrl: "https://azure.test/openai/v1",
        azureApiVersion: "v1",
      },
    ).result();

    expect(result.stopReason).toBe("stop");
    expect(result.errorMessage).toBeUndefined();
    expect(readAssistantText(result)).toBe("complete answer");
  });
});
