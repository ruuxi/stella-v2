import { afterEach, describe, expect, it, vi } from "vitest";

import { getModels } from "@stella/runtime/ai/models";
import { streamOpenAICodexResponses } from "@stella/runtime/ai/providers/openai-codex-responses";
import type { Model } from "@stella/runtime/ai/types";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe("OpenAI Codex direct transport", () => {
  it("uses pi-mono's explicit build-time ChatGPT OAuth catalog", () => {
    expect(getModels("openai-codex").map((model) => model.id)).toEqual([
      "gpt-5.3-codex-spark",
      "gpt-5.4",
      "gpt-5.4-mini",
      "gpt-5.5",
      "gpt-5.6-luna",
      "gpt-5.6-sol",
      "gpt-5.6-terra",
    ]);
  });

  it("sends ChatGPT OAuth models directly to the backend API", async () => {
    const payload = Buffer.from(
      JSON.stringify({
        "https://api.openai.com/auth": {
          chatgpt_account_id: "account-123",
        },
      }),
    ).toString("base64url");
    const accessToken = `header.${payload}.signature`;
    let request: Request | undefined;
    globalThis.fetch = vi.fn(async (input, init) => {
      request = input instanceof Request ? input : new Request(input, init);
      return new Response(
        JSON.stringify({ error: { message: "usage limit: intentional test stop" } }),
        {
          status: 400,
          headers: { "content-type": "application/json" },
        },
      );
    }) as typeof fetch;

    const model: Model<"openai-codex-responses"> = {
      id: "gpt-5.6-sol",
      name: "GPT-5.6 SOL",
      api: "openai-codex-responses",
      provider: "openai-codex",
      baseUrl: "https://chatgpt.com/backend-api",
      reasoning: true,
      input: ["text", "image"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 400_000,
      maxTokens: 128_000,
    };

    await streamOpenAICodexResponses(
      model,
      { messages: [] },
      { apiKey: accessToken, transport: "sse", sessionId: "thread-123" },
    ).result();

    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    expect(request?.url).toBe(
      "https://chatgpt.com/backend-api/codex/responses",
    );
    expect(request?.headers.get("authorization")).toBe(`Bearer ${accessToken}`);
    expect(request?.headers.get("chatgpt-account-id")).toBe("account-123");
    expect(request?.headers.get("session_id")).toBe("thread-123");
    await expect(request?.clone().json()).resolves.toMatchObject({
      model: "gpt-5.6-sol",
      store: false,
      stream: true,
    });
  });
});
