import { afterEach, describe, expect, it } from "bun:test";

import { getModeConfig } from "../../convex/agent/model";
import {
  streamManagedChat,
  type ManagedDispatchGuard,
} from "../../convex/runtime_ai/managed";
import type { Context } from "../../convex/runtime_ai/types";

/**
 * End-to-end wire test for the Stella default model
 * (`meta/muse-spark-1.2-contributor`, OpenRouter-hosted): the managed runtime
 * must dispatch it through the OpenAI **Responses** API — POST
 * `https://openrouter.ai/api/v1/responses` with a Responses-shaped body
 * (model + reasoning.effort from the mode config + input array) — and parse
 * streaming Responses usage into our Usage shape.
 *
 * OpenRouter verified live for this model: /api/v1/responses works streaming
 * and non-streaming; reasoning is mandatory; response.completed carries
 * input_tokens/output_tokens (+ output_tokens_details.reasoning_tokens).
 */

const MUSE_MODEL = "meta/muse-spark-1.2-contributor";

const context = (text: string): Context => ({
  messages: [
    {
      role: "user",
      content: text,
      timestamp: 0,
    },
  ],
});

const sseBody = [
  `data: ${JSON.stringify({ type: "response.created", response: { id: "resp_muse" } })}\n\n`,
  `data: ${JSON.stringify({ type: "response.output_item.added", output_index: 0, item: { type: "message", role: "assistant", id: "msg_1", content: [] } })}\n\n`,
  `data: ${JSON.stringify({ type: "response.output_text.delta", item_id: "msg_1", delta: "hello" })}\n\n`,
  `data: ${JSON.stringify({
    type: "response.completed",
    response: {
      id: "resp_muse",
      status: "completed",
      model: MUSE_MODEL,
      usage: {
        input_tokens: 100,
        output_tokens: 40,
        total_tokens: 140,
        output_tokens_details: { reasoning_tokens: 30 },
        input_tokens_details: { cached_tokens: 0 },
      },
    },
  })}\n\n`,
  "data: [DONE]\n\n",
].join("");

type CapturedCall = { url: string; init?: RequestInit };

const originalFetch: typeof fetch = globalThis.fetch;

// Transport-only tests use an explicit local fake. Production code must use
// the durable owner/generation guard from lib/managed_billing.
const testDispatchGuard = (): ManagedDispatchGuard => ({
  signal: new AbortController().signal,
  beginDispatch: async () => ({
    signal: new AbortController().signal,
    deadlineAt: Date.now() + 5_000,
    settle: async () => undefined,
  }),
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("managed Muse Spark 1.2 Contributor transport", () => {
  it("mode config pins openai-responses on the OpenRouter gateway", () => {
    for (const mode of [
      "standard",
      "priority",
      "light",
      "builder",
      "designer",
      "vision",
      "max",
    ] as const) {
      const config = getModeConfig(mode, "pro");
      expect(config.model).toBe(MUSE_MODEL);
      expect(config.managedGatewayProvider).toBe("openrouter");
      expect(config.api).toBe("openai-responses");
    }
  });

  it("streams via POST https://openrouter.ai/api/v1/responses with reasoning.effort=xhigh and Responses-shaped input", async () => {
    process.env.OPENROUTER_API_KEY = "test-openrouter-key";
    const calls: CapturedCall[] = [];
    globalThis.fetch = (async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url;
      calls.push({ url, init });
      return new Response(sseBody, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    }) as typeof fetch;

    const config = getModeConfig("standard", "pro");
    let finalMessage: unknown;
    for await (const event of streamManagedChat({
      config,
      context: context("hi"),
      request: { maxTokens: 2048 },
      dispatchGuard: testDispatchGuard(),
    })) {
      if (event.type === "done") {
        finalMessage = event.message;
      }
      if (event.type === "error") {
        throw new Error(event.error.errorMessage || event.reason);
      }
    }

    expect(calls.length).toBe(1);
    // The URL is the load-bearing assertion: chat completions would be
    // .../api/v1/chat/completions.
    expect(calls[0]!.url).toBe("https://openrouter.ai/api/v1/responses");

    const body = JSON.parse(String(calls[0]!.init?.body)) as Record<
      string,
      any
    >;
    expect(body.model).toBe(MUSE_MODEL);
    expect(body.stream).toBe(true);
    // Reasoning is mandatory upstream and must ship at Stella's top rung.
    expect(body.reasoning).toMatchObject({ effort: "xhigh" });
    // Responses wire format, not chat completions' `messages`.
    expect(body.input).toEqual([
      { role: "user", content: [{ type: "input_text", text: "hi" }] },
    ]);
    expect(body.messages).toBeUndefined();
    expect(body.max_output_tokens).toBe(2048);
    // Existing encrypted-reasoning machinery applies here too: the runtime
    // asks for encrypted_content so multi-turn replay keeps working.
    expect(body.include).toEqual(["reasoning.encrypted_content"]);
    // OpenRouter rejects store:true on this endpoint (verified live).
    expect(body.store).toBeFalsy();

    const message = finalMessage as {
      api: string;
      provider: string;
      model: string;
      usage: Record<string, number>;
      stopReason: string;
    };
    expect(message.api).toBe("openai-responses");
    expect(message.provider).toBe("openrouter");
    expect(message.model).toBe(MUSE_MODEL);
    expect(message.stopReason).toBe("stop");
    // Streaming usage parses into our Usage shape (reasoning tokens are part
    // of gross output, cache reads are broken out of gross input).
    expect(message.usage).toMatchObject({
      input: 100,
      output: 40,
      cacheRead: 0,
      reasoningTokens: 30,
      totalTokens: 140,
    });
  });
});
