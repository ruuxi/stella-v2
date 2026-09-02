// RUNTIME NOTE: run this suite under real Node (e.g. /opt/homebrew/bin/node).
import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";

import { streamOpenAIResponses } from "../../../../runtime/ai/providers/openai-responses.js";
import type { Context, Model } from "../../../../runtime/ai/types.js";

/**
 * Gateway-mode transport tests for the OpenAI Responses adapter against a
 * real node:http server. The managed lane is request/response: one POST
 * with `stream: false`, one complete JSON `Response` object back. These
 * tests pin the wire shape (headers, body, identities), abort propagation,
 * error surfacing, and the capability re-exchange on 401.
 */

const servers = new Set<http.Server>();

const modelFor = (
  port: number,
  path = "/v1/relay",
  provider = "openai",
): Model<"openai-responses"> => ({
  id: "test-model",
  name: "Gateway transport model",
  api: "openai-responses",
  provider,
  baseUrl: `http://127.0.0.1:${port}${path}`,
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 8_000,
  maxTokens: 1_000,
});

const context: Context = {
  messages: [{ role: "user", content: "say hello", timestamp: 0 }],
};

const listen = async (server: http.Server): Promise<number> => {
  servers.add(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return (server.address() as AddressInfo).port;
};

const readBody = async (request: http.IncomingMessage): Promise<string> => {
  let body = "";
  for await (const chunk of request) body += chunk.toString();
  return body;
};

const completeResponse = (id: string) => ({
  id,
  object: "response",
  created_at: 1,
  status: "completed",
  model: "test-model",
  error: null,
  incomplete_details: null,
  output: [
    {
      type: "reasoning",
      id: "rs_1",
      summary: [{ type: "summary_text", text: "Plan the answer." }],
      encrypted_content: "enc_opaque",
    },
    {
      type: "message",
      id: "msg_1",
      role: "assistant",
      status: "completed",
      content: [{ type: "output_text", text: "hello", annotations: [] }],
    },
    {
      type: "function_call",
      id: "fc_1",
      call_id: "call_1",
      name: "read_file",
      arguments: '{"path":"/tmp/evidence.txt"}',
      status: "completed",
    },
  ],
  usage: {
    input_tokens: 12,
    output_tokens: 9,
    total_tokens: 21,
    input_tokens_details: { cached_tokens: 4 },
    output_tokens_details: { reasoning_tokens: 3 },
  },
});

const sendJson = (
  response: http.ServerResponse,
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
) => {
  response.writeHead(status, {
    "content-type": "application/json",
    ...headers,
  });
  response.end(JSON.stringify(body));
};

afterEach(async () => {
  await Promise.all(
    [...servers].map(
      (server) => new Promise<void>((resolve) => server.close(() => resolve())),
    ),
  );
  servers.clear();
});

describe("OpenAI Responses gateway transport", () => {
  it("posts stream:false once and converts the complete Response into the streaming protocol", async () => {
    const requests: Array<{
      method?: string;
      url?: string;
      body: Record<string, unknown>;
      headers: http.IncomingHttpHeaders;
    }> = [];
    const server = http.createServer(async (request, response) => {
      requests.push({
        method: request.method,
        url: request.url,
        body: JSON.parse(await readBody(request)) as Record<string, unknown>,
        headers: request.headers,
      });
      sendJson(response, 200, completeResponse("resp_gateway"));
    });
    const port = await listen(server);
    const lifecycle: Array<Record<string, unknown>> = [];
    const events: string[] = [];

    const stream = streamOpenAIResponses(modelFor(port), context, {
      apiKey: "session-capability",
      onProviderRequestLifecycle: (proof) => lifecycle.push(proof),
    });
    for await (const event of stream) events.push(event.type);
    const result = await stream.result();

    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ method: "POST", url: "/v1/relay/responses" });
    expect(requests[0]!.body.stream).toBe(false);
    expect(requests[0]!.body.model).toBe("test-model");
    expect(requests[0]!.headers.authorization).toBe("Bearer session-capability");
    expect(requests[0]!.headers["x-stella-request-id"]).toMatch(
      /^[0-9a-f-]{36}$/u,
    );
    expect(requests[0]!.headers["idempotency-key"]).toMatch(/^stella-response-/);

    expect(result.stopReason).toBe("toolUse");
    expect(result.responseId).toBe("resp_gateway");
    expect(result.content).toEqual([
      {
        type: "thinking",
        thinking: "Plan the answer.",
        thinkingSignature: JSON.stringify(completeResponse("x").output[0]),
      },
      {
        type: "text",
        text: "hello",
        textSignature: '{"v":1,"id":"msg_1"}',
      },
      {
        type: "toolCall",
        id: "call_1|fc_1",
        name: "read_file",
        arguments: { path: "/tmp/evidence.txt" },
      },
    ]);
    expect(result.usage).toMatchObject({
      input: 8,
      output: 9,
      reasoning: 3,
      cacheRead: 4,
      cacheWrite: 0,
      totalTokens: 21,
    });
    // Every part: start, exactly one whole delta, end.
    expect(events).toEqual([
      "start",
      "thinking_start",
      "thinking_delta",
      "thinking_end",
      "text_start",
      "text_delta",
      "text_end",
      "toolcall_start",
      "toolcall_delta",
      "toolcall_end",
      "done",
    ]);
    expect(lifecycle.map((event) => event.phase)).toEqual([
      "request-admitted",
      "request-dispatched",
      "stream-open",
      "transport-closed",
    ]);
    expect(lifecycle.map((event) => event.physicalAttempt)).toEqual([1, 1, 1, 1]);
    expect(lifecycle.at(-1)).toMatchObject({ outcome: "completed" });
    expect(JSON.stringify(lifecycle)).not.toContain(
      requests[0]!.headers["idempotency-key"],
    );
  });

  it("aborts the in-flight gateway request and reports stopReason aborted", async () => {
    let observeRequest!: () => void;
    const requestObserved = new Promise<void>((resolve) => {
      observeRequest = resolve;
    });
    let resolveClosed!: () => void;
    const socketClosed = new Promise<void>((resolve) => {
      resolveClosed = resolve;
    });
    const server = http.createServer(async (request, response) => {
      await readBody(request);
      request.socket.once("close", () => resolveClosed());
      observeRequest();
      // Never answer: the client must give up on its own abort.
      response.on("close", () => undefined);
    });
    const port = await listen(server);
    const controller = new AbortController();
    const lifecycle: Array<Record<string, unknown>> = [];

    const stream = streamOpenAIResponses(modelFor(port), context, {
      apiKey: "session-capability",
      signal: controller.signal,
      onProviderRequestLifecycle: (proof) => lifecycle.push(proof),
    });
    await requestObserved;
    controller.abort("user canceled");
    const result = await stream.result();
    await socketClosed;

    expect(result.stopReason).toBe("aborted");
    expect(result.content).toEqual([]);
    expect(lifecycle.at(-1)).toMatchObject({
      phase: "transport-closed",
      outcome: "canceled",
    });
  });

  it("surfaces gateway HTTP errors with the provider's retry-after", async () => {
    const server = http.createServer(async (request, response) => {
      await readBody(request);
      sendJson(
        response,
        429,
        {
          error: {
            code: "rate_limited",
            message: "slow down please",
            retryable: true,
          },
        },
        { "retry-after": "7" },
      );
    });
    const port = await listen(server);

    const result = await streamOpenAIResponses(modelFor(port), context, {
      apiKey: "session-capability",
    }).result();

    expect(result.stopReason).toBe("error");
    expect(result.errorMessage).toContain("slow down please");
    expect(result.retryAfterMs).toBe(7_000);
  });

  it("re-exchanges the capability after a 401 and retries with a fresh request id", async () => {
    const seen: Array<{ authorization?: string; requestId?: string }> = [];
    const server = http.createServer(async (request, response) => {
      await readBody(request);
      seen.push({
        authorization: request.headers.authorization,
        requestId: request.headers["x-stella-request-id"] as string | undefined,
      });
      if (seen.length === 1) {
        sendJson(response, 401, {
          error: {
            code: "capability_expired",
            message: "capability expired",
            retryable: true,
          },
        });
        return;
      }
      sendJson(response, 200, completeResponse("resp_after_refresh"));
    });
    const port = await listen(server);
    let refreshes = 0;

    const result = await streamOpenAIResponses(modelFor(port), context, {
      apiKey: "stale-capability",
      refreshApiKey: async () => {
        refreshes += 1;
        return "fresh-capability";
      },
    }).result();

    expect(result.stopReason).toBe("toolUse");
    expect(result.responseId).toBe("resp_after_refresh");
    expect(refreshes).toBe(1);
    expect(seen.map((entry) => entry.authorization)).toEqual([
      "Bearer stale-capability",
      "Bearer fresh-capability",
    ]);
    expect(seen[0]!.requestId).toMatch(/^[0-9a-f-]{36}$/u);
    expect(seen[1]!.requestId).toMatch(/^[0-9a-f-]{36}$/u);
    expect(seen[1]!.requestId).not.toBe(seen[0]!.requestId);
  });

  it("surfaces a 402 budget exhaustion as a non-retryable error without a retry-after", async () => {
    let refreshes = 0;
    const server = http.createServer(async (request, response) => {
      await readBody(request);
      sendJson(response, 402, {
        error: {
          code: "budget_exhausted",
          message: "managed budget exhausted",
          retryable: false,
        },
      });
    });
    const port = await listen(server);

    const result = await streamOpenAIResponses(modelFor(port), context, {
      apiKey: "session-capability",
      refreshApiKey: async () => {
        refreshes += 1;
        return "fresh-capability";
      },
    }).result();

    expect(result.stopReason).toBe("error");
    expect(result.errorMessage).toContain("managed budget exhausted");
    expect(result.retryAfterMs).toBeUndefined();
    expect(refreshes).toBe(0);
  });

  it("overrides static turn headers and assigns distinct identities to distinct model requests", async () => {
    const identities: Array<{
      idempotencyKey?: string;
      requestId?: string;
    }> = [];
    const server = http.createServer(async (request, response) => {
      await readBody(request);
      identities.push({
        idempotencyKey: request.headers["idempotency-key"] as string | undefined,
        requestId: request.headers["x-stella-request-id"] as string | undefined,
      });
      sendJson(response, 200, completeResponse(`resp_${identities.length}`));
    });
    const port = await listen(server);
    const model = modelFor(port);
    const sharedOptions = {
      apiKey: "session-capability",
      sessionId: "one-agent-turn",
      headers: {
        "idempotency-key": "static-turn-idempotency-key",
        "x-stella-request-id": "static-turn-request-id",
      },
    };

    const first = await streamOpenAIResponses(model, context, sharedOptions).result();
    const second = await streamOpenAIResponses(model, context, sharedOptions).result();

    expect(first.stopReason).toBe("toolUse");
    expect(second.stopReason).toBe("toolUse");
    expect(identities).toHaveLength(2);
    expect(identities[0]?.idempotencyKey).toMatch(/^stella-response-/);
    expect(identities[0]?.requestId).toMatch(/^[0-9a-f-]{36}$/u);
    expect(identities[1]?.idempotencyKey).not.toBe(identities[0]?.idempotencyKey);
    expect(identities[1]?.requestId).not.toBe(identities[0]?.requestId);
  });

  it("keeps direct-provider base URLs on the streaming transport", async () => {
    const requests: Array<{ url?: string; body: Record<string, unknown> }> = [];
    const server = http.createServer(async (request, response) => {
      requests.push({
        url: request.url,
        body: JSON.parse(await readBody(request)) as Record<string, unknown>,
      });
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(
        [
          { type: "response.created", sequence_number: 0, response: { id: "resp_direct" } },
          {
            type: "response.completed",
            sequence_number: 1,
            response: {
              id: "resp_direct",
              status: "completed",
              output: [],
              usage: {
                input_tokens: 1,
                output_tokens: 0,
                total_tokens: 1,
                input_tokens_details: { cached_tokens: 0 },
              },
            },
          },
        ]
          .map((event) => `data: ${JSON.stringify(event)}\n\n`)
          .join("") + "data: [DONE]\n\n",
      );
    });
    const port = await listen(server);

    const result = await streamOpenAIResponses(modelFor(port, "/v1"), context, {
      apiKey: "test",
    }).result();

    expect(result.stopReason).toBe("stop");
    expect(result.responseId).toBe("resp_direct");
    expect(requests).toHaveLength(1);
    expect(requests[0]!.url).toBe("/v1/responses");
    expect(requests[0]!.body.stream).toBe(true);
  });

  it("does not replay a direct-provider POST after a socket fault", async () => {
    let posts = 0;
    const server = http.createServer(async (request) => {
      posts += 1;
      await readBody(request);
      request.socket.destroy();
    });
    const port = await listen(server);

    const result = await streamOpenAIResponses(modelFor(port, "/v1"), context, {
      apiKey: "test",
    }).result();

    expect(result.stopReason).toBe("error");
    expect(posts).toBe(1);
  });
});
