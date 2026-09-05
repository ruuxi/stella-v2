import { describe, expect, it, vi } from "vitest";
import type { ProviderRequestLifecycleProof } from "../ai/types.js";
import { testModel } from "./fixtures/model.js";

const openAiImport = vi.fn();

vi.mock("openai", () => {
  openAiImport();
  return {
    default: class ForbiddenOpenAIClient {
      constructor() {
        throw new Error("OpenAI SDK should not load on gateway Responses path");
      }
    },
  };
});

const { streamOpenAIResponses } = await import(
  "../ai/providers/openai-responses.js"
);

const GATEWAY_RELAY = "https://gateway.example.test/v1/relay";

const model = testModel<"openai-responses">({
  id: "stella/default",
  name: "Stella default",
  api: "openai-responses",
  provider: "openrouter",
  baseUrl: GATEWAY_RELAY,
  headers: {
    authorization: "Bearer capability-token",
    "x-stella-agent-type": "orchestrator",
    "x-stella-request-id": "stale-request-id",
    "idempotency-key": "stale-idempotency-key",
  },
  reasoning: true,
  thinkingLevelMap: { xhigh: "xhigh", off: "none" },
  input: ["text", "image"],
  contextWindow: 200_000,
  maxTokens: 16_384,
});

const responseBody = {
  id: "resp_1",
  object: "response",
  created_at: 1,
  status: "completed",
  model: "meta/muse-spark-1.3-contributor",
  output: [
    {
      type: "reasoning",
      id: "rs_1",
      summary: [{ type: "summary_text", text: "Thinking about it." }],
      content: [],
      encrypted_content: "sealed",
      status: "completed",
    },
    {
      type: "message",
      id: "msg_1",
      role: "assistant",
      status: "completed",
      content: [{ type: "output_text", text: "Hello world", annotations: [] }],
    },
    {
      type: "function_call",
      id: "fc_1",
      call_id: "call_1",
      name: "read_file",
      arguments: '{"path":"/tmp/a.txt"}',
      status: "completed",
    },
  ],
  usage: {
    input_tokens: 12,
    output_tokens: 7,
    total_tokens: 19,
    input_tokens_details: { cached_tokens: 2 },
    output_tokens_details: { reasoning_tokens: 3 },
  },
};

const context = {
  systemPrompt: "You are Stella.",
  messages: [
    {
      role: "user" as const,
      content: [
        { type: "text" as const, text: "describe this" },
        {
          type: "image" as const,
          mimeType: "image/png",
          data: "iVBORw0KGgo=",
        },
      ],
      timestamp: 1,
    },
  ],
  tools: [
    {
      name: "read_file",
      description: "Read a file",
      parameters: {
        type: "object",
        properties: { path: { type: "string" } },
        required: ["path"],
      },
    },
  ],
};

describe("OpenAI Responses gateway transport", () => {
  it("posts managed gateway JSON without loading the OpenAI SDK", async () => {
    let request: Request | undefined;
    const onPayload = vi.fn((payload: unknown) => payload);
    const onResponse = vi.fn();
    const lifecycle: ProviderRequestLifecycleProof[] = [];
    const transport = vi.fn(
      async (
        input: Parameters<typeof fetch>[0],
        init?: Parameters<typeof fetch>[1],
      ) => {
        request = input instanceof Request ? input : new Request(input, init);
        return Response.json(responseBody, {
          headers: { "x-provider": "gateway" },
        });
      },
    ) as unknown as typeof fetch;

    const result = await streamOpenAIResponses(
      { ...model, fetch: transport },
      context,
      {
        apiKey: "capability-token",
        reasoningEffort: "xhigh",
        sessionId: "session-1",
        promptCacheKey: "prompt-cache-1",
        onPayload,
        onResponse,
        onProviderRequestLifecycle: async (proof) => {
          lifecycle.push(proof);
        },
      },
    ).result();

    expect(openAiImport).not.toHaveBeenCalled();
    expect(transport).toHaveBeenCalledTimes(1);
    expect(request?.url).toBe(`${GATEWAY_RELAY}/responses`);
    expect(request?.headers.get("authorization")).toBe(
      "Bearer capability-token",
    );
    expect(request?.headers.get("x-stella-agent-type")).toBe("orchestrator");
    expect(request?.headers.get("idempotency-key")).toMatch(
      /^stella-response-/,
    );
    expect(request?.headers.get("idempotency-key")).not.toBe(
      "stale-idempotency-key",
    );
    expect(request?.headers.get("x-stella-request-id")).toBeTruthy();
    expect(request?.headers.get("x-stella-request-id")).not.toBe(
      "stale-request-id",
    );

    const body = await request!.clone().json();
    expect(body.stream).toBe(false);
    expect(body.model).toBe("stella/default");
    expect(body.reasoning).toEqual({ effort: "xhigh", summary: "auto" });
    expect(body.include).toEqual(["reasoning.encrypted_content"]);
    expect(JSON.stringify(body.input)).toContain("input_image");
    expect(JSON.stringify(body.tools)).toContain("read_file");
    expect(onPayload).toHaveBeenCalledTimes(1);
    expect(onResponse).toHaveBeenCalledWith(
      {
        status: 200,
        headers: {
          "content-type": "application/json",
          "x-provider": "gateway",
        },
      },
      expect.objectContaining({ id: "stella/default" }),
    );

    expect(result.stopReason).toBe("toolUse");
    expect(result.content).toMatchObject([
      { type: "thinking", thinking: "Thinking about it." },
      { type: "text", text: "Hello world" },
      {
        type: "toolCall",
        id: "call_1|fc_1",
        name: "read_file",
        arguments: { path: "/tmp/a.txt" },
      },
    ]);
    expect(result.usage).toMatchObject({
      input: 10,
      output: 7,
      reasoning: 3,
      cacheRead: 2,
      totalTokens: 19,
    });
    expect(lifecycle.map((proof) => proof.phase)).toEqual([
      "request-admitted",
      "request-dispatched",
      "stream-open",
      "transport-closed",
    ]);
    expect(new Set(lifecycle.map((proof) => proof.requestIdSha256)).size).toBe(
      1,
    );
    expect(lifecycle.at(-1)?.outcome).toBe("completed");
  });

  it("refreshes authorization once with the same logical identity", async () => {
    const authorizations: Array<string | null> = [];
    const idempotencyKeys: Array<string | null> = [];
    const lifecycle: ProviderRequestLifecycleProof[] = [];
    const transport = vi.fn(
      async (
        input: Parameters<typeof fetch>[0],
        init?: Parameters<typeof fetch>[1],
      ) => {
        const request =
          input instanceof Request ? input : new Request(input, init);
        authorizations.push(request.headers.get("authorization"));
        idempotencyKeys.push(request.headers.get("idempotency-key"));
        if (authorizations.length === 1) {
          return Response.json(
            { error: { message: "expired" } },
            { status: 401 },
          );
        }
        return Response.json(responseBody);
      },
    ) as unknown as typeof fetch;

    const result = await streamOpenAIResponses(
      {
        ...model,
        fetch: transport,
        headers: { "x-stella-agent-type": "orchestrator" },
      },
      { messages: [{ role: "user", content: "hello", timestamp: 1 }] },
      {
        apiKey: "stale-token",
        refreshApiKey: async () => "fresh-token",
        onProviderRequestLifecycle: (proof) => {
          lifecycle.push(proof);
        },
      },
    ).result();

    expect(result.stopReason).toBe("toolUse");
    expect(authorizations).toEqual([
      "Bearer stale-token",
      "Bearer fresh-token",
    ]);
    expect(idempotencyKeys).toHaveLength(2);
    expect(idempotencyKeys[0]).toBe(idempotencyKeys[1]);
    expect(
      lifecycle.filter((proof) => proof.phase === "request-dispatched"),
    ).toHaveLength(2);
    expect(new Set(lifecycle.map((proof) => proof.requestIdSha256)).size).toBe(
      1,
    );
  });

  it("cancels while gateway JSON is still draining", async () => {
    const controller = new AbortController();
    const entered = Promise.withResolvers<void>();
    const transport = vi.fn(
      async (
        _input: Parameters<typeof fetch>[0],
        init?: Parameters<typeof fetch>[1],
      ) => {
        const body = new ReadableStream<Uint8Array>({
          start(streamController) {
            streamController.enqueue(
              new TextEncoder().encode('{"id":"resp_pending","output":'),
            );
            init?.signal?.addEventListener(
              "abort",
              () =>
                streamController.error(
                  new DOMException("Aborted", "AbortError"),
                ),
              { once: true },
            );
          },
        });
        entered.resolve();
        return new Response(body, {
          headers: { "content-type": "application/json" },
        });
      },
    ) as unknown as typeof fetch;

    const stream = streamOpenAIResponses(
      { ...model, fetch: transport },
      { messages: [{ role: "user", content: "hello", timestamp: 1 }] },
      { apiKey: "capability-token", signal: controller.signal },
    );
    await entered.promise;
    controller.abort();

    const result = await stream.result();
    expect(result.stopReason).toBe("aborted");
    expect(result.errorMessage).toBe("Aborted");
  });
});
