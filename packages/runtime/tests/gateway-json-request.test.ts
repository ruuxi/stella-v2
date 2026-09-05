import { describe, expect, test, vi } from "vitest";
import OpenAI from "openai";
import { gatewayJsonHeaders, gatewayRetryDelay, requestGatewayJson } from "../ai/providers/gateway-json-request.js";
import { streamOpenAICompletions } from "../ai/providers/openai-completions.js";
import type { Model } from "../ai/types.js";

const body = { model: "stella/test", messages: [{ role: "user" as const, content: "hello" }], stream: false as const };
const reply = { id: "chatcmpl-test", object: "chat.completion", created: 1, model: "test", choices: [] };
const headers = { authorization: "Bearer capability", "x-stella-request-id": "same-request", "x-custom": "kept" };

const run = async (implementation: "sdk" | "gateway", statuses: number[], extraHeaders: Record<string, string> = {}) => {
  const calls: Array<{ body: string; identity: string | null; bearer: string | null; retry: string | null }> = [];
  const transport = Object.assign(async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const request = new Request(input, init);
    calls.push({ body: await request.text(), identity: request.headers.get("x-stella-request-id"),
      bearer: request.headers.get("authorization"), retry: request.headers.get("x-stainless-retry-count") });
    const status = statuses[Math.min(calls.length - 1, statuses.length - 1)];
    return Response.json(status === 200 ? reply : { error: { message: "refused", code: "test_error", metadata: { raw: "detail" } } },
      { status, headers: { "retry-after-ms": "1", ...extraHeaders } });
  }, fetch);
  let result: unknown;
  try {
    result = implementation === "sdk"
      ? await new OpenAI({ apiKey: "capability", baseURL: "https://gateway/v1/relay", fetch: transport,
        defaultHeaders: headers }).chat.completions.create(body)
      : (await requestGatewayJson({ url: "https://gateway/v1/relay/chat/completions", body,
        headers: new Headers(headers), timeoutMs: 1000, fetch: transport,
        readResponse: response => response.json() })).data;
  } catch (error) {
    const value = error instanceof Error ? error : new Error(String(error));
    result = { name: value.constructor.name, message: value.message,
      status: Reflect.get(value, "status"), code: Reflect.get(value, "code"), error: Reflect.get(value, "error") };
  }
  return { calls, result };
};

describe("gateway JSON transport parity with the installed OpenAI SDK", () => {
  test("retains pinned SDK Retry-After boundaries without an added sixty-second clamp", () => {
    // openai 6.39.0 retryRequest accepts parsed values verbatim. Only an
    // undefined delay uses exponential backoff, unlike older SDK releases.
    for (const delay of [-1, 0, 1, 59999, 60000, 60001]) {
      expect(gatewayRetryDelay(0, new Headers({ "retry-after-ms": String(delay) }))).toBe(delay);
      expect(gatewayRetryDelay(0, new Headers({ "retry-after": String(delay / 1000) }))).toBe(delay);
    }
    expect(gatewayRetryDelay(0, new Headers({ "retry-after-ms": "0", "retry-after": "2" }))).toBe(2000);
    expect(gatewayRetryDelay(0, new Headers({ "retry-after-ms": "invalid" }))).toBeGreaterThanOrEqual(375);
    expect(gatewayRetryDelay(0, new Headers({ "retry-after-ms": "invalid" }))).toBeLessThanOrEqual(500);
  });
  test("matches SDK routing/auth/default headers and explicit overrides", async () => {
    vi.stubEnv("OPENAI_ORG_ID", "test-organization");
    vi.stubEnv("OPENAI_PROJECT_ID", "test-project");
    vi.stubEnv("OPENAI_CUSTOM_HEADERS", "x-env: inherited\nx-custom: environment\nx-stella-request-id: environment-id");
    try {
      let received = new Headers();
      const transport = Object.assign(async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
        received = new Request(input, init).headers;
        return Response.json(reply);
      }, fetch);
      await new OpenAI({ apiKey: "capability", baseURL: "https://gateway/v1/relay", fetch: transport,
        defaultHeaders: headers }).chat.completions.create(body, { timeout: 1000,
        headers: { "x-stella-request-id": "physical-id" } });
      const expected = gatewayJsonHeaders({ apiKey: "capability", defaults: headers,
        perRequest: { "x-stella-request-id": "physical-id" }, timeoutMs: 1000 });
      expected.set("x-stainless-retry-count", "0");
      // Platform telemetry belongs to the full SDK, not the JSON transport.
      for (const name of ["x-stainless-lang", "x-stainless-package-version", "x-stainless-os",
        "x-stainless-arch", "x-stainless-runtime", "x-stainless-runtime-version"]) received.delete(name);
      expect(Object.fromEntries(expected)).toEqual(Object.fromEntries(received));
    } finally { vi.unstubAllEnvs(); }
  });
  for (const statuses of [[408, 200], [409, 200], [429, 200], [503, 503, 200], [503, 503, 503], [401]]) {
    test(`preserves requests, retry count and errors for ${statuses.join("→")}`, async () => {
      expect(await run("gateway", statuses)).toEqual(await run("sdk", statuses));
    });
  }
  test("honors explicit no-retry for descriptor mismatch", async () => {
    const result = await run("gateway", [409, 200], { "x-should-retry": "false" });
    expect(result.calls).toHaveLength(1);
    expect(result).toEqual(await run("sdk", [409, 200], { "x-should-retry": "false" }));
  });
  test("honors explicit retry even for normally final status", async () => {
    expect(await run("gateway", [400, 200], { "x-should-retry": "true" }))
      .toEqual(await run("sdk", [400, 200], { "x-should-retry": "true" }));
  });
  for (const implementation of ["sdk", "gateway"] as const) test(`${implementation} retains the raw abort while response JSON is arriving`, async () => {
    const abort = new AbortController();
    const entered = Promise.withResolvers<void>();
    const transport = Object.assign(async (_input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
        const responseBody = new ReadableStream<Uint8Array>({ start(controller) {
          controller.enqueue(new TextEncoder().encode('{"pending":'));
          init?.signal?.addEventListener("abort", () => controller.error(new DOMException("Aborted", "AbortError")), { once: true });
        } });
        entered.resolve();
        return new Response(responseBody, { headers: { "content-type": "application/json" } });
      }, fetch);
    const work = implementation === "sdk"
      ? new OpenAI({ apiKey: "capability", baseURL: "https://gateway/v1/relay", fetch: transport })
        .chat.completions.create(body, { signal: abort.signal, maxRetries: 0 }).then(value => value)
      : requestGatewayJson({ url: "https://gateway/model", body, headers: new Headers(headers),
        timeoutMs: 1000, signal: abort.signal, maxRetries: 0, fetch: transport, readResponse: response => response.json() });
    const failure = expect(work).rejects.toMatchObject({ name: "AbortError", message: "Aborted" });
    await entered.promise;
    abort.abort();
    await failure;
  });
  test("timeout preserves the SDK error without an unrequested retry", async () => {
    let calls = 0;
    await expect(requestGatewayJson({ url: "https://gateway/model", body, headers: new Headers(headers),
      timeoutMs: 1, maxRetries: 0,
      fetch: Object.assign(async (_input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
        calls++;
        return await new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
        });
      }, fetch), readResponse: response => response.json(),
    })).rejects.toThrow("Request timed out.");
    expect(calls).toBe(1);
  });
  test("adapter refreshes authentication once with a fresh request identity", async () => {
    const calls: Array<{ bearer: string | null; identity: string | null }> = [];
    const model: Model<"openai-completions"> = {
      id: "stella/test", name: "test", api: "openai-completions", provider: "openrouter",
      baseUrl: "https://gateway/v1/relay", reasoning: false, input: ["text"],
      contextWindow: 10000, maxTokens: 1000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      fetch: Object.assign(async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
        const request = new Request(input, init);
        calls.push({ bearer: request.headers.get("authorization"), identity: request.headers.get("x-stella-request-id") });
        return calls.length === 1 ? Response.json({ error: { message: "expired" } }, { status: 401 })
          : Response.json({ ...reply, choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: "hello" } }] });
      }, fetch),
    };
    const stream = streamOpenAICompletions(model, { messages: [{ role: "user", content: "hello", timestamp: 1 }] },
      { apiKey: "old", refreshApiKey: async () => "new" });
    const result = await stream.result();
    expect(result.stopReason).toBe("stop");
    expect(calls.map(call => call.bearer)).toEqual(["Bearer old", "Bearer new"]);
    expect(calls[0].identity).toBeTruthy();
    expect(calls[0].identity).not.toBe(calls[1].identity);
  });
  for (const fixture of [
    { name: "missing completion metadata", finish: "stop", message: { content: "hello" },
      delta: { role: "assistant", content: "hello" }, expected: [{ type: "text", text: "hello" }] },
    { name: "missing tool call id", finish: "tool_calls",
      message: { tool_calls: [{ type: "function", function: { name: "Recall", arguments: "{}" } }] },
      delta: { role: "assistant", tool_calls: [{ index: 0, type: "function", function: { name: "Recall", arguments: "{}" } }] },
      expected: [{ type: "toolCall", id: "", name: "Recall", arguments: {} }] },
    { name: "missing optional function fields", finish: "tool_calls",
      message: { tool_calls: [{ type: "function", function: {} }] },
      delta: { role: "assistant", tool_calls: [{ index: 0, type: "function", function: {} }] },
      expected: [{ type: "toolCall", id: "", name: "", arguments: {} }] },
  ]) test(`preserves existing accumulator behavior for ${fixture.name}`, async () => {
    const usage = { prompt_tokens: 7, completion_tokens: 2, prompt_cache_hit_tokens: 3, vendor_extra: "preserved" };
    const completion = { choices: [{ finish_reason: fixture.finish, message: fixture.message }], usage };
    // These are the chunks produced by the old tolerant converter. Serve them
    // through the real native SDK path, independently of the new JSON parser.
    const chunk = { choices: [{ index: 0, delta: fixture.delta, finish_reason: fixture.finish, logprobs: null }], usage };
    const results = [];
    for (const gateway of [false, true]) {
      const model: Model<"openai-completions"> = {
        id: "stella/test", name: "test", api: "openai-completions", provider: "openrouter",
        baseUrl: gateway ? "https://gateway/v1/relay" : "https://provider/v1", reasoning: false, input: ["text"],
        contextWindow: 10000, maxTokens: 1000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        fetch: Object.assign(async () => gateway ? Response.json(completion)
          : new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } }), fetch),
      };
      const result = await streamOpenAICompletions(model, { messages: [{ role: "user", content: "hello", timestamp: 1 }] },
        { apiKey: "key" }).result();
      const { timestamp: _timestamp, ...stable } = result;
      results.push(stable);
      expect(result.content).toEqual(fixture.expected);
      expect(result.stopReason).toBe(fixture.finish === "stop" ? "stop" : "toolUse");
    }
    expect(results[1]).toEqual(results[0]);
  });
});
