import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  GATEWAY_AGENT_TYPE_HEADER,
  GATEWAY_REQUEST_ID_HEADER,
} from "@stella/contracts/gateway/api";
import { STELLA_DEFAULT_MODEL } from "../../../src/shared/stella-api.js";

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  getConvexToken: vi.fn(),
  getDeviceIdOrNull: vi.fn(),
}));

vi.mock("@/platform/convex/convex-client", () => ({
  convexClient: { query: mocks.query },
}));
vi.mock("@/global/auth/services/auth-token", () => ({
  getConvexToken: mocks.getConvexToken,
}));
vi.mock("@/platform/electron/device", () => ({
  getDeviceIdOrNull: mocks.getDeviceIdOrNull,
}));

const GATEWAY_ORIGIN = "https://gateway.example";
const SESSION_URL = `${GATEWAY_ORIGIN}/v1/capabilities/session`;
const CHAT_URL = `${GATEWAY_ORIGIN}/v1/relay/chat/completions`;
const JWT = "better-auth-jwt";

type FetchCall = { url: string; init: RequestInit };

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

/**
 * Fake gateway: mints numbered capabilities on the session route and answers
 * chat completions from a scripted queue (default: one "done" reply).
 */
const installGateway = (
  chatResponses: Array<() => Response> = [
    () => json({ choices: [{ message: { content: "done" } }] }),
  ],
) => {
  const calls: FetchCall[] = [];
  let minted = 0;
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init: init ?? {} });
    if (url === SESSION_URL) {
      minted += 1;
      return json({
        capability: `capability-${minted}`,
        expiresAt: Date.now() + 60 * 60 * 1000,
        audience: "free",
        budgetMicroCents: 1,
      });
    }
    if (url === CHAT_URL) {
      const next = chatResponses.shift();
      if (!next) throw new Error("unexpected chat completion call");
      return next();
    }
    throw new Error(`unexpected fetch ${url}`);
  });
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  return {
    calls,
    sessionCalls: () => calls.filter((call) => call.url === SESSION_URL),
    chatCalls: () => calls.filter((call) => call.url === CHAT_URL),
  };
};

const headersOf = (call: FetchCall): Record<string, string> =>
  call.init.headers as Record<string, string>;
const bodyOf = (call: FetchCall): Record<string, unknown> =>
  JSON.parse(call.init.body as string) as Record<string, unknown>;

const loadLlm = () => import("../../../src/platform/ai/llm.js");

describe("Stella LLM helper", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    vi.resetModules();
    mocks.query.mockReset().mockResolvedValue({ origin: `${GATEWAY_ORIGIN}/` });
    mocks.getConvexToken.mockReset().mockResolvedValue(JWT);
    mocks.getDeviceIdOrNull.mockReset().mockResolvedValue("device-id");
    globalThis.fetch = originalFetch;
  });

  it("exchanges the JWT for a capability and posts a non-streaming completion to the gateway", async () => {
    const gateway = installGateway();
    const { callStellaLlmText } = await loadLlm();

    await expect(callStellaLlmText("Summarize this.")).resolves.toBe("done");

    const [session] = gateway.sessionCalls();
    expect(session).toBeDefined();
    expect(headersOf(session!).Authorization).toBe(`Bearer ${JWT}`);
    expect(bodyOf(session!)).toEqual({ deviceId: "device-id" });

    const [chat] = gateway.chatCalls();
    expect(chat).toBeDefined();
    expect(chat!.url).toBe(CHAT_URL);
    expect(chat!.init.method).toBe("POST");
    const headers = headersOf(chat!);
    expect(headers.Authorization).toBe("Bearer capability-1");
    expect(headers[GATEWAY_AGENT_TYPE_HEADER]).toBe("app");
    expect(headers["Content-Type"]).toBe("application/json");
    expect(headers[GATEWAY_REQUEST_ID_HEADER]).toEqual(expect.any(String));
    expect(bodyOf(chat!)).toEqual({
      model: STELLA_DEFAULT_MODEL,
      messages: [{ role: "user", content: "Summarize this." }],
      stream: false,
    });
    // The JWT never reaches a model request.
    expect(headers.Authorization).not.toContain(JWT);
  });

  it("passes explicit options through to the completion body", async () => {
    const gateway = installGateway([
      () => json({ choices: [{ message: { content: "ok" } }] }),
    ]);
    const { callStellaLlm } = await loadLlm();

    await callStellaLlm({
      agentType: "widget",
      model: "stella/light",
      maxTokens: 128,
      temperature: 0.2,
      messages: [{ role: "user", content: "Name this." }],
      body: { response_format: { type: "json_object" } },
    });

    const [chat] = gateway.chatCalls();
    expect(headersOf(chat!)[GATEWAY_AGENT_TYPE_HEADER]).toBe("widget");
    expect(bodyOf(chat!)).toEqual({
      response_format: { type: "json_object" },
      model: "stella/light",
      messages: [{ role: "user", content: "Name this." }],
      max_tokens: 128,
      temperature: 0.2,
      stream: false,
    });
  });

  it("accepts prompt, system prompt, and prior history", async () => {
    const gateway = installGateway([
      () => json({ choices: [{ message: { content: "ok" } }] }),
      () => json({ choices: [{ message: { content: "ok" } }] }),
    ]);
    const { callStellaLlm } = await loadLlm();

    await callStellaLlm({
      agentType: "widget",
      prompt: "Name this note.",
      systemPrompt: "Return only plain text.",
    });
    await callStellaLlm({
      prompt: "What should I do next?",
      systemPrompt: "You are concise.",
      messages: [
        { role: "user", content: "I have three tasks." },
        { role: "assistant", content: "List them by urgency." },
      ],
    });

    const [first, second] = gateway.chatCalls();
    expect(bodyOf(first!).messages).toEqual([
      { role: "system", content: "Return only plain text." },
      { role: "user", content: "Name this note." },
    ]);
    expect(bodyOf(second!).messages).toEqual([
      { role: "system", content: "You are concise." },
      { role: "user", content: "I have three tasks." },
      { role: "assistant", content: "List them by urgency." },
      { role: "user", content: "What should I do next?" },
    ]);
    expect(headersOf(second!)[GATEWAY_AGENT_TYPE_HEADER]).toBe("app");
  });

  it("forces stream:false on raw chat completions and forwards extra headers", async () => {
    const gateway = installGateway([
      () => json({ choices: [{ message: { content: "cleaned" } }] }),
    ]);
    const { callChatCompletion } = await loadLlm();

    await callChatCompletion({
      agentType: "dictation",
      messages: [{ role: "user", content: "um hello" }],
      headers: { "X-Test": "1" },
      body: { model: "stella/inception/mercury-2", max_tokens: 512, stream: true },
    });

    const [chat] = gateway.chatCalls();
    const headers = headersOf(chat!);
    expect(headers[GATEWAY_AGENT_TYPE_HEADER]).toBe("dictation");
    expect(headers["X-Test"]).toBe("1");
    expect(headers.Authorization).toBe("Bearer capability-1");
    expect(bodyOf(chat!)).toEqual({
      model: "stella/inception/mercury-2",
      max_tokens: 512,
      messages: [{ role: "user", content: "um hello" }],
      stream: false,
    });
  });

  it("reuses the cached capability and re-exchanges once after the gateway rejects it", async () => {
    const gateway = installGateway([
      () => json({ choices: [{ message: { content: "one" } }] }),
      () =>
        json(
          {
            error: {
              code: "capability_expired",
              message: "expired",
              retryable: true,
            },
          },
          401,
        ),
      () => json({ choices: [{ message: { content: "two" } }] }),
    ]);
    const { callStellaLlmText } = await loadLlm();

    await expect(callStellaLlmText("first")).resolves.toBe("one");
    await expect(callStellaLlmText("second")).resolves.toBe("two");

    expect(gateway.sessionCalls()).toHaveLength(2);
    expect(mocks.query).toHaveBeenCalledTimes(1);
    const chats = gateway.chatCalls();
    expect(chats.map((call) => headersOf(call).Authorization)).toEqual([
      "Bearer capability-1",
      "Bearer capability-1",
      "Bearer capability-2",
    ]);
    // The retry replays the same idempotency key with the new capability.
    expect(headersOf(chats[2]!)[GATEWAY_REQUEST_ID_HEADER]).toBe(
      headersOf(chats[1]!)[GATEWAY_REQUEST_ID_HEADER],
    );
  });

  it("surfaces gateway errors with their code", async () => {
    installGateway([
      () =>
        json(
          {
            error: {
              code: "model_forbidden",
              message: "not for this audience",
              retryable: false,
            },
          },
          403,
        ),
    ]);
    const { callStellaLlmText } = await loadLlm();

    await expect(callStellaLlmText("x")).rejects.toThrow(
      "Stella LLM call failed with HTTP 403 (model_forbidden: not for this audience)",
    );
  });

  it("fails readably when the deployment advertises no gateway", async () => {
    const gateway = installGateway([]);
    mocks.query.mockResolvedValue({ origin: "" });
    const { callStellaLlmText } = await loadLlm();

    await expect(callStellaLlmText("x")).rejects.toThrow(
      /model gateway is not configured/i,
    );
    expect(gateway.calls).toHaveLength(0);
  });

  it("requires a signed-in session before exchanging a capability", async () => {
    const gateway = installGateway([]);
    mocks.getConvexToken.mockResolvedValue(null);
    const { callStellaLlmText } = await loadLlm();

    await expect(callStellaLlmText("x")).rejects.toThrow(/sign in/i);
    expect(gateway.calls).toHaveLength(0);
  });
});
