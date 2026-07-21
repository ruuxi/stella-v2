import { afterEach, describe, expect, it, vi } from "vitest";

import { streamGoogle } from "@stella/runtime/ai/providers/google";
import { streamGoogleGeminiCli } from "@stella/runtime/ai/providers/google-gemini-cli";
import type { Context, Model } from "@stella/runtime/ai/types";
import { classifyAgentRunFailure } from "@stella/runtime/kernel/agent-runtime/run-retry";
import { isProviderContentAbortMessage } from "@stella/runtime/kernel/agent-runtime/provider-abort-containment";

const baseModel = {
  id: "gemini-3-pro",
  name: "Gemini Test",
  provider: "google",
  baseUrl: "https://gemini.test/v1beta",
  reasoning: true,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  maxTokens: 128_000,
  contextWindow: 200_000,
} as const;

const context: Context = {
  systemPrompt: "you are a test",
  messages: [{ role: "user", content: "hi", timestamp: 0 }],
  tools: [],
};

describe("Google prompt-block classification", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("surfaces Gemini promptFeedback as a deterministic content abort", async () => {
    const encoder = new TextEncoder();
    const sse = `data: ${JSON.stringify({
      promptFeedback: {
        blockReason: "PROHIBITED_CONTENT",
        blockReasonMessage: "blocked by policy",
      },
    })}\n\n`;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(encoder.encode(sse), {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        }),
      ),
    );

    const model: Model<"google-generative-ai"> = {
      ...baseModel,
      api: "google-generative-ai",
    };
    const result = await streamGoogle(model, context, {
      apiKey: "test-key",
    }).result();

    expect(result.stopReason).toBe("error");
    expect(result.errorMessage).toContain('block reason: "PROHIBITED_CONTENT"');
    expect(result.errorMessage).toContain("blocked by policy");
    expect(isProviderContentAbortMessage(result.errorMessage)).toBe(true);
    expect(classifyAgentRunFailure(new Error(result.errorMessage!))).toEqual({
      retryable: false,
      category: "unknown",
    });
  });

  it("does not replay a Cloud Code prompt block as an empty stream", async () => {
    const encoder = new TextEncoder();
    const sse = [
      `data: ${JSON.stringify({
        response: { promptFeedback: { blockReason: "SAFETY" } },
      })}`,
      "",
      "",
    ].join("\n");
    const fetchMock = vi.fn(async () =>
      new Response(encoder.encode(sse), {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const model: Model<"google-gemini-cli"> = {
      ...baseModel,
      api: "google-gemini-cli",
      provider: "google-gemini-cli",
      baseUrl: "https://cloudcode.example",
    };
    const result = await streamGoogleGeminiCli(model, context, {
      apiKey: JSON.stringify({ token: "test-token", projectId: "proj" }),
    }).result();

    expect(result.stopReason).toBe("error");
    expect(result.errorMessage).toContain('block reason: "SAFETY"');
    expect(isProviderContentAbortMessage(result.errorMessage)).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
