// RUNTIME NOTE: run this suite under real Node (e.g. /opt/homebrew/bin/node).
import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";

import { streamOpenAIResponses } from "../../../../runtime/ai/providers/openai-responses.js";
import type { Context, Model } from "../../../../runtime/ai/types.js";

const servers = new Set<http.Server>();

const sse = (events: unknown[]): string =>
  events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("");

const completedResponse = (id: string, text = "") => ({
  id,
  status: "completed",
  output: [],
  usage: {
    input_tokens: 1,
    output_tokens: text ? 1 : 0,
    total_tokens: text ? 2 : 1,
    input_tokens_details: { cached_tokens: 0 },
  },
});

const modelFor = (port: number, path = "/v1"): Model<"openai-responses"> => ({
  id: "test-model",
  name: "Fault injection model",
  api: "openai-responses",
  provider: "openai",
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

const complete = (
  response: http.ServerResponse,
  responseId: string,
  relay?: { requestId: string; sequence?: number },
) => {
  response.writeHead(200, {
    "content-type": "text/event-stream",
    ...(relay
      ? {
          "x-stella-relay-resume": "1",
          "x-stella-relay-request-id": relay.requestId,
        }
      : {}),
  });
  response.end(
    sse([
      {
        type: "response.completed",
        sequence_number: 0,
        ...(relay ? { stella_relay_sequence: relay.sequence ?? 1 } : {}),
        response: completedResponse(responseId),
      },
    ]) + "data: [DONE]\n\n",
  );
};

afterEach(async () => {
  await Promise.all(
    [...servers].map(
      (server) => new Promise<void>((resolve) => server.close(() => resolve())),
    ),
  );
  servers.clear();
});

describe("OpenAI Responses socket fault recovery", () => {
  it("retries a pre-header close with one stable idempotency key and identical body", async () => {
    const idempotencyKeys: Array<string | undefined> = [];
    const requestBodies: string[] = [];
    const retries: Array<{ attempt: number; delayMs: number }> = [];
    const server = http.createServer(async (request, response) => {
      idempotencyKeys.push(request.headers["idempotency-key"] as string);
      let body = "";
      for await (const chunk of request) body += chunk.toString();
      requestBodies.push(body);
      if (requestBodies.length === 1) {
        request.socket.destroy();
        return;
      }
      complete(response, "resp_fault_injection");
    });
    const port = await listen(server);

    const result = await streamOpenAIResponses(modelFor(port), context, {
      apiKey: "test",
      onProviderRetry: ({ attempt, delayMs }) =>
        retries.push({ attempt, delayMs }),
    }).result();

    expect(result.stopReason).toBe("stop");
    expect(result.responseId).toBe("resp_fault_injection");
    expect(requestBodies).toHaveLength(2);
    expect(idempotencyKeys[0]).toMatch(/^stella-response-/);
    expect(idempotencyKeys[1]).toBe(idempotencyKeys[0]);
    expect(requestBodies[1]).toBe(requestBodies[0]);
    expect(retries).toHaveLength(1);
  });

  it("resumes a provider-durable response by id and cursor without duplicating deltas", async () => {
    const responseId = "resp_resume_fault";
    const requests: Array<{ method?: string; url?: string }> = [];
    const server = http.createServer(async (request, response) => {
      requests.push({ method: request.method, url: request.url });
      if (request.method === "POST") {
        for await (const _chunk of request) {
          // Drain the create body before faulting the response stream.
        }
        response.writeHead(200, {
          "content-type": "text/event-stream",
          connection: "close",
        });
        response.write(
          sse([
            {
              type: "response.created",
              sequence_number: 0,
              response: { id: responseId },
            },
            {
              type: "response.output_item.added",
              sequence_number: 1,
              output_index: 0,
              item: {
                type: "message",
                id: "msg_resume",
                role: "assistant",
                content: [],
                status: "in_progress",
              },
            },
            {
              type: "response.output_text.delta",
              sequence_number: 2,
              output_index: 0,
              item_id: "msg_resume",
              content_index: 0,
              delta: "hel",
            },
          ]),
        );
        setImmediate(() => response.destroy());
        return;
      }

      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(
        sse([
          {
            type: "response.output_text.delta",
            sequence_number: 2,
            output_index: 0,
            item_id: "msg_resume",
            content_index: 0,
            delta: "hel",
          },
          {
            type: "response.output_text.delta",
            sequence_number: 3,
            output_index: 0,
            item_id: "msg_resume",
            content_index: 0,
            delta: "lo",
          },
          {
            type: "response.output_item.done",
            sequence_number: 4,
            output_index: 0,
            item: {
              type: "message",
              id: "msg_resume",
              role: "assistant",
              status: "completed",
              content: [
                { type: "output_text", text: "hello", annotations: [] },
              ],
            },
          },
          {
            type: "response.completed",
            sequence_number: 5,
            response: completedResponse(responseId, "hello"),
          },
        ]) + "data: [DONE]\n\n",
      );
    });
    const port = await listen(server);

    const stream = streamOpenAIResponses(modelFor(port), context, {
      apiKey: "test",
      onPayload: (payload) => ({
        ...(payload as Record<string, unknown>),
        background: true,
        store: true,
      }),
    });
    const textDeltas: string[] = [];
    const eventsDone = (async () => {
      for await (const event of stream) {
        if (event.type === "text_delta") textDeltas.push(event.delta);
      }
    })();
    const result = await stream.result();
    await eventsDone;

    expect(result.content).toMatchObject([{ type: "text", text: "hello" }]);
    expect(textDeltas.join("")).toBe("hello");
    expect(requests).toHaveLength(2);
    expect(requests[0]).toMatchObject({ method: "POST", url: "/v1/responses" });
    expect(requests[1]?.method).toBe("GET");
    expect(requests[1]?.url).toContain(
      `/v1/responses/${responseId}?stream=true&starting_after=2`,
    );
  });

  it("resumes relay-buffered tool arguments from the advertised cursor without replaying POST", async () => {
    const requests: Array<{
      method?: string;
      url?: string;
      body: string;
      relayRequestId?: string;
      idempotencyKey?: string;
    }> = [];
    const server = http.createServer(async (request, response) => {
      let body = "";
      for await (const chunk of request) body += chunk.toString();
      const relayRequestId = request.headers["x-stella-relay-request-id"] as
        | string
        | undefined;
      requests.push({
        method: request.method,
        url: request.url,
        body,
        relayRequestId,
        idempotencyKey: request.headers["idempotency-key"] as
          | string
          | undefined,
      });
      const stableRelayId = requests[0]!.relayRequestId!;
      if (request.method === "POST") {
        response.writeHead(200, {
          "content-type": "text/event-stream",
          "x-stella-relay-resume": "1",
          "x-stella-relay-request-id": stableRelayId,
          connection: "close",
        });
        response.write(
          sse([
            {
              type: "response.created",
              sequence_number: 0,
              stella_relay_sequence: 1,
              response: { id: "resp_provider" },
            },
            {
              type: "response.output_item.added",
              sequence_number: 1,
              stella_relay_sequence: 2,
              output_index: 0,
              item: {
                type: "function_call",
                id: "item_tool",
                call_id: "call_tool",
                name: "read_file",
                arguments: "",
                status: "in_progress",
              },
            },
            {
              type: "response.function_call_arguments.delta",
              sequence_number: 2,
              stella_relay_sequence: 3,
              output_index: 0,
              item_id: "item_tool",
              delta: '{"path":"/tmp/',
            },
          ]),
        );
        setImmediate(() => response.destroy());
        return;
      }

      response.writeHead(200, {
        "content-type": "text/event-stream",
        "x-stella-relay-resume": "1",
        "x-stella-relay-request-id": stableRelayId,
      });
      response.end(
        sse([
          {
            type: "response.function_call_arguments.delta",
            sequence_number: 2,
            stella_relay_sequence: 3,
            output_index: 0,
            item_id: "item_tool",
            delta: '{"path":"/tmp/',
          },
          {
            type: "response.function_call_arguments.delta",
            sequence_number: 3,
            stella_relay_sequence: 4,
            output_index: 0,
            item_id: "item_tool",
            delta: 'evidence.txt"}',
          },
          {
            type: "response.output_item.done",
            sequence_number: 4,
            stella_relay_sequence: 5,
            output_index: 0,
            item: {
              type: "function_call",
              id: "item_tool",
              call_id: "call_tool",
              name: "read_file",
              arguments: '{"path":"/tmp/evidence.txt"}',
              status: "completed",
            },
          },
          {
            type: "response.completed",
            sequence_number: 5,
            stella_relay_sequence: 6,
            response: completedResponse("resp_provider"),
          },
        ]) + "data: [DONE]\n\n",
      );
    });
    const port = await listen(server);

    const result = await streamOpenAIResponses(
      modelFor(port, "/api/stella/relay"),
      { messages: [{ role: "user", content: "read it", timestamp: 0 }] },
      { apiKey: "test" },
    ).result();

    expect(result.stopReason).toBe("toolUse");
    expect(result.content).toEqual([
      {
        type: "toolCall",
        id: "call_tool|item_tool",
        name: "read_file",
        arguments: { path: "/tmp/evidence.txt" },
      },
    ]);
    expect(requests.map((request) => request.method)).toEqual(["POST", "GET"]);
    expect(requests[0]?.relayRequestId).toMatch(/^stella-relay-/);
    expect(requests[0]?.idempotencyKey).toMatch(/^stella-response-/);
    expect(requests[1]?.url).toContain(
      `/api/stella/relay/responses/${requests[0]!.relayRequestId}?stream=true&starting_after=3`,
    );
  });

  it("uses GET cursor zero when a managed relay body closes before event one", async () => {
    const methods: string[] = [];
    let upstreamExecutions = 0;
    let relayRequestId = "";
    const server = http.createServer(async (request, response) => {
      methods.push(request.method ?? "");
      for await (const _chunk of request) {
        // Drain request bodies.
      }
      if (request.method === "POST") {
        upstreamExecutions += 1;
        relayRequestId = request.headers["x-stella-relay-request-id"] as string;
        response.writeHead(200, {
          "content-type": "text/event-stream",
          "x-stella-relay-resume": "1",
          "x-stella-relay-request-id": relayRequestId,
          connection: "close",
        });
        response.flushHeaders();
        setImmediate(() => response.destroy());
        return;
      }
      expect(request.url).toContain(
        `/api/stella/relay/responses/${relayRequestId}?stream=true&starting_after=0`,
      );
      complete(response, "resp_zero_event", { requestId: relayRequestId });
    });
    const port = await listen(server);

    const result = await streamOpenAIResponses(
      modelFor(port, "/api/stella/relay"),
      context,
      { apiKey: "test" },
    ).result();

    expect(result.stopReason).toBe("stop");
    expect(methods).toEqual(["POST", "GET"]);
    expect(upstreamExecutions).toBe(1);
  });

  it("overrides static turn headers and assigns distinct identities to distinct model requests", async () => {
    const identities: Array<{
      idempotencyKey?: string;
      relayRequestId?: string;
    }> = [];
    const server = http.createServer(async (request, response) => {
      for await (const _chunk of request) {
        // Drain the body.
      }
      const identity = {
        idempotencyKey: request.headers["idempotency-key"] as
          | string
          | undefined,
        relayRequestId: request.headers["x-stella-relay-request-id"] as
          | string
          | undefined,
      };
      identities.push(identity);
      complete(response, `resp_${identities.length}`, {
        requestId: identity.relayRequestId!,
      });
    });
    const port = await listen(server);
    const model = modelFor(port, "/api/stella/relay");
    const sharedOptions = {
      apiKey: "test",
      sessionId: "one-agent-turn",
      headers: {
        "idempotency-key": "static-turn-idempotency-key",
        "x-stella-relay-request-id": "static-turn-relay-request-id",
      },
    };

    const first = await streamOpenAIResponses(
      model,
      context,
      sharedOptions,
    ).result();
    const second = await streamOpenAIResponses(
      model,
      context,
      sharedOptions,
    ).result();

    expect(first.stopReason).toBe("stop");
    expect(second.stopReason).toBe("stop");
    expect(identities).toHaveLength(2);
    expect(identities[0]?.idempotencyKey).toMatch(/^stella-response-/);
    expect(identities[0]?.relayRequestId).toMatch(/^stella-relay-/);
    expect(identities[1]?.idempotencyKey).not.toBe(
      identities[0]?.idempotencyKey,
    );
    expect(identities[1]?.relayRequestId).not.toBe(
      identities[0]?.relayRequestId,
    );
  });

  it("cancels a managed relay request when aborted before response headers", async () => {
    const methods: string[] = [];
    let relayRequestId = "";
    let releasePost!: () => void;
    const postBlocked = new Promise<void>((resolve) => {
      releasePost = resolve;
    });
    let observePost!: () => void;
    const postObserved = new Promise<void>((resolve) => {
      observePost = resolve;
    });
    let resolveDelete!: () => void;
    const deleted = new Promise<void>((resolve) => {
      resolveDelete = resolve;
    });
    const server = http.createServer(async (request, response) => {
      methods.push(request.method ?? "");
      if (request.method === "DELETE") {
        expect(request.url).toBe(
          `/api/stella/relay/responses/${relayRequestId}`,
        );
        response.writeHead(204);
        response.end();
        resolveDelete();
        releasePost();
        return;
      }
      relayRequestId = request.headers["x-stella-relay-request-id"] as string;
      for await (const _chunk of request) {
        // Drain request bodies.
      }
      observePost();
      await postBlocked;
      response.destroy();
    });
    const port = await listen(server);
    const controller = new AbortController();

    const stream = streamOpenAIResponses(
      modelFor(port, "/api/stella/relay"),
      context,
      { apiKey: "test", signal: controller.signal },
    );
    await postObserved;
    controller.abort("user canceled before headers");
    const result = await stream.result();
    await deleted;

    expect(result.stopReason).toBe("aborted");
    expect(relayRequestId).toMatch(/^stella-relay-/);
    expect(methods).toEqual(["POST", "DELETE"]);
  });

  it("fails closed on an advertised request-id mismatch", async () => {
    let posts = 0;
    const server = http.createServer(async (request, response) => {
      posts += 1;
      for await (const _chunk of request) {
        // Drain the body.
      }
      complete(response, "resp_mismatch", {
        requestId: "relay_mismatched_response_id",
      });
    });
    const port = await listen(server);

    const result = await streamOpenAIResponses(
      modelFor(port, "/api/stella/relay"),
      context,
      { apiKey: "test" },
    ).result();

    expect(result.stopReason).toBe("error");
    expect(result.errorMessage).toContain("mismatched resume request id");
    expect(posts).toBe(1);
  });

  it("surfaces an expired relay cursor without replaying the original POST", async () => {
    let posts = 0;
    let gets = 0;
    let relayRequestId = "";
    const server = http.createServer(async (request, response) => {
      for await (const _chunk of request) {
        // Drain request bodies.
      }
      if (request.method === "POST") {
        posts += 1;
        relayRequestId = request.headers["x-stella-relay-request-id"] as string;
        response.writeHead(200, {
          "content-type": "text/event-stream",
          "x-stella-relay-resume": "1",
          "x-stella-relay-request-id": relayRequestId,
          connection: "close",
        });
        response.write(
          sse([
            {
              type: "response.created",
              sequence_number: 0,
              stella_relay_sequence: 1,
              response: { id: "resp_expired" },
            },
          ]),
        );
        setImmediate(() => response.destroy());
        return;
      }
      gets += 1;
      response.writeHead(410, { "content-type": "application/json" });
      response.end(
        JSON.stringify({ error: { message: "Relay resume cursor expired" } }),
      );
    });
    const port = await listen(server);

    const result = await streamOpenAIResponses(
      modelFor(port, "/api/stella/relay"),
      context,
      { apiKey: "test" },
    ).result();

    expect(result.stopReason).toBe("error");
    expect(result.errorMessage).toContain("Relay resume cursor expired");
    expect(posts).toBe(1);
    expect(gets).toBe(1);
  });

  it("never replays POST after a partial stream without a durable resume id", async () => {
    const requests: Array<{ method?: string; url?: string }> = [];
    const server = http.createServer(async (request, response) => {
      requests.push({ method: request.method, url: request.url });
      for await (const _chunk of request) {
        // Drain the request body before faulting the response stream.
      }
      response.writeHead(200, {
        "content-type": "text/event-stream",
        connection: "close",
      });
      response.write(
        sse([
          {
            type: "response.created",
            sequence_number: 0,
            response: { id: "resp_socket_fault" },
          },
          {
            type: "response.output_item.added",
            sequence_number: 1,
            output_index: 0,
            item: {
              type: "message",
              id: "msg_socket_fault",
              role: "assistant",
              content: [],
              status: "in_progress",
            },
          },
          {
            type: "response.output_text.delta",
            sequence_number: 2,
            output_index: 0,
            item_id: "msg_socket_fault",
            content_index: 0,
            delta: "hel",
          },
        ]),
      );
      setImmediate(() => response.destroy());
    });
    const port = await listen(server);

    const result = await streamOpenAIResponses(modelFor(port), context, {
      apiKey: "test",
      onPayload: (payload) => ({
        ...(payload as Record<string, unknown>),
        background: false,
        store: false,
      }),
    }).result();

    expect(result.stopReason).toBe("error");
    expect(result.errorMessage).toContain("was not replayed");
    expect(requests).toEqual([{ method: "POST", url: "/v1/responses" }]);
  });
});
