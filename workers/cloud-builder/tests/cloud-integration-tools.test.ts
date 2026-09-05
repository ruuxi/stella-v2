import { describe, expect, test } from "bun:test";
import { createCloudIntegrationTools } from "../src/cloud-integration-tools.js";
import { CLOUD_INTEGRATION_TOOL_SPECS } from "../src/cloud-integration-tool-specs.js";

type RpcRequest = {
  jsonrpc?: unknown;
  id?: unknown;
  method?: unknown;
  params?: Record<string, unknown>;
};

const HASH = /^[a-f0-9]{64}$/u;
const RPC_ID = /^mcp-[a-f0-9]{64}$/u;
const rpcResult = (id: unknown, result: unknown): Response =>
  Response.json({ jsonrpc: "2.0", id, result });
const initializeResult = (
  id: unknown,
  extras: Record<string, unknown> = {},
): Response =>
  rpcResult(id, {
    protocolVersion: "2025-03-26",
    capabilities: { tools: { listChanged: false } },
    serverInfo: { name: "stella-native-integrations", version: "1" },
    ...extras,
  });

const searchedTool = (name: string) => ({
  name,
  integration: "gmail",
  action: name.split("__").at(-1),
  revision: "v1:11:reviewed.v1",
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
  },
});

const listedTool = (
  name: string,
  options: {
    description?: string;
    annotations?: Record<string, unknown>;
    inputSchema?: Record<string, unknown>;
    meta?: Record<string, unknown>;
    revision?: string;
  } = {},
) => ({
  name,
  ...(options.description ? { description: options.description } : {}),
  inputSchema: options.inputSchema ?? {
    type: "object",
    additionalProperties: false,
  },
  annotations: options.annotations ?? {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
  },
  _meta: options.meta ?? {
    "stella/integration": "gmail",
    "stella/revision": options.revision ?? "v1:11:reviewed.v1",
    "stella/codePolicyVersion": "gmail-read.v1",
  },
});

const initializedPost =
  (handler: (request: RpcRequest, signal?: AbortSignal) => Promise<Response>) =>
  async (_path: string, body: unknown, signal?: AbortSignal) => {
    const request = body as RpcRequest;
    if (request.method === "initialize") return initializeResult(request.id);
    if (request.method === "notifications/initialized") {
      return new Response(null, { status: 204 });
    }
    return handler(request, signal);
  };

const parseText = (
  result: { content: Array<{ type: string; text?: string }> },
  index = 0,
): Record<string, any> =>
  JSON.parse(result.content[index]!.text ?? "null") as Record<string, any>;

describe("cloud integration tools", () => {
  test("keeps static descriptors in sync with the executable tools", () => {
    const tools = createCloudIntegrationTools({
      post: async () => {
        throw new Error("descriptor construction must not call integrations");
      },
    });
    expect(
      tools.map(({ execute: _execute, ...descriptor }) => descriptor),
    ).toEqual([...CLOUD_INTEGRATION_TOOL_SPECS]);
  });

  test("preserves search/describe/call and derives distinct RPC ids", async () => {
    const requests: RpcRequest[] = [];
    const controller = new AbortController();
    const receivedSignals: Array<AbortSignal | undefined> = [];
    const tools = createCloudIntegrationTools({
      post: async (_path, body, signal) => {
        const request = body as RpcRequest;
        requests.push(request);
        receivedSignals.push(signal);
        if (request.method === "initialize")
          return initializeResult(request.id);
        if (request.method === "notifications/initialized") {
          return new Response(null, { status: 204 });
        }
        if (request.method === "stella/tools/search") {
          expect(request.params).toEqual({ query: "mail profile", limit: 8 });
          return rpcResult(request.id, {
            tools: [searchedTool("native__gmail__GMAIL_GET_PROFILE")],
          });
        }
        if (request.method === "stella/tools/describe") {
          return rpcResult(request.id, {
            tool: listedTool("native__gmail__GMAIL_GET_PROFILE"),
          });
        }
        if (request.method === "tools/call") {
          return rpcResult(request.id, {
            content: [{ type: "text", text: "ok" }],
            _meta: { replayed: false },
          });
        }
        throw new Error(`unexpected method: ${String(request.method)}`);
      },
    });

    expect(tools.map((tool) => [tool.name, tool.codeEligibility])).toEqual([
      ["tool_search", "read_only"],
      ["mcp_list", "read_only"],
      ["mcp_describe", "read_only"],
      ["mcp_call", "read_only"],
    ]);
    const searchResult = await tools
      .find((tool) => tool.name === "tool_search")!
      .execute("outer-search-id", { query: "mail profile" }, controller.signal);
    const describeResult = await tools
      .find((tool) => tool.name === "mcp_describe")!
      .execute(
        "outer-describe-id",
        { name: "native__gmail__GMAIL_GET_PROFILE" },
        controller.signal,
      );
    const callResult = await tools
      .find((tool) => tool.name === "mcp_call")!
      .execute(
        "outer-call-id",
        {
          name: "native__gmail__GMAIL_GET_PROFILE",
          revision: "v1:11:reviewed.v1",
          arguments: {},
        },
        controller.signal,
      );

    expect(receivedSignals.every((seen) => seen === controller.signal)).toBe(
      true,
    );
    const ids = requests
      .filter((request) => request.id !== undefined)
      .map((request) => String(request.id));
    expect(ids).toHaveLength(4);
    expect(ids.every((id) => RPC_ID.test(id))).toBe(true);
    expect(new Set(ids).size).toBe(ids.length);
    expect(JSON.stringify(requests)).not.toContain("outer-search-id");
    expect(searchResult.details).toEqual({ count: 1 });
    expect((callResult.content[0] as { text: string }).text).toBe("ok");
    const callProof = parseText(callResult as any, 1).stellaMcpProof;
    const describeProof = parseText(describeResult as any, 1).stellaMcpProof;
    expect(describeProof).toEqual({
      describeRequestIdSha256: expect.stringMatching(HASH),
      toolIdSha256: expect.stringMatching(HASH),
      describeReceiptSha256: expect.stringMatching(HASH),
      describeCompleted: true,
    });
    expect(JSON.stringify(describeProof)).not.toContain("inputSchema");
    expect(callProof.callRequestIdSha256).toMatch(HASH);
    expect(callProof.initializeRequestIdSha256).toMatch(HASH);
    expect(callProof.callRequestIdSha256).not.toBe(
      callProof.initializeRequestIdSha256,
    );
    expect(describeProof.describeRequestIdSha256).not.toBe(
      callProof.callRequestIdSha256,
    );
  });

  test("paginates tools/list and returns stable ids plus hash-only proof", async () => {
    const requests: RpcRequest[] = [];
    const rawOuterId = "outer-list-id-that-must-not-leak";
    const secretEndpoint =
      "https://private.example.invalid/mcp?token=raw-secret";
    const secretAccount = "account-owner-private-123";
    const tools = createCloudIntegrationTools({
      post: async (_path, body) => {
        const request = body as RpcRequest;
        requests.push(request);
        if (request.method === "initialize") {
          return initializeResult(request.id, {
            privateDebug: { endpoint: secretEndpoint, account: secretAccount },
          });
        }
        if (request.method === "notifications/initialized") {
          return new Response(null, { status: 202 });
        }
        if (request.method === "tools/list") {
          return request.params?.cursor === undefined
            ? rpcResult(request.id, {
                tools: [
                  listedTool("native__gmail__GMAIL_GET_PROFILE", {
                    description: secretEndpoint,
                    inputSchema: {
                      type: "object",
                      description: secretEndpoint,
                    },
                  }),
                ],
                nextCursor: "opaque-page-2",
              })
            : rpcResult(request.id, {
                tools: [
                  listedTool("native__gmail__GMAIL_LIST_THREADS", {
                    revision: "v1:12:reviewed.v2",
                  }),
                ],
              });
        }
        throw new Error(`unexpected method: ${String(request.method)}`);
      },
    });
    const result = await tools
      .find((tool) => tool.name === "mcp_list")!
      .execute(rawOuterId, { deadline_ms: 1_000 });
    const payload = parseText(result as any);

    expect(payload.tools).toEqual([
      {
        integration: "gmail",
        name: "native__gmail__GMAIL_GET_PROFILE",
        revision: "v1:11:reviewed.v1",
        toolIdSha256: expect.stringMatching(HASH),
      },
      {
        integration: "gmail",
        name: "native__gmail__GMAIL_LIST_THREADS",
        revision: "v1:12:reviewed.v2",
        toolIdSha256: expect.stringMatching(HASH),
      },
    ]);
    expect(payload.proof).toMatchObject({
      schemaVersion: 1,
      protocolVersion: "2025-03-26",
      initializedNotificationSent: true,
      toolsListPageCount: 2,
      toolsListCompleted: true,
      toolCount: 2,
      serverIdSha256: expect.stringMatching(HASH),
      initializeRequestIdSha256: expect.stringMatching(HASH),
      initializationReceiptSha256: expect.stringMatching(HASH),
      initializedNotificationReceiptSha256: expect.stringMatching(HASH),
      catalogSha256: expect.stringMatching(HASH),
      toolsListRequestIdSha256s: [
        expect.stringMatching(HASH),
        expect.stringMatching(HASH),
      ],
    });
    const rpcIds = requests
      .filter((request) => request.id !== undefined)
      .map((request) => String(request.id));
    expect(rpcIds).toHaveLength(3);
    expect(rpcIds.every((id) => RPC_ID.test(id))).toBe(true);
    expect(new Set(rpcIds).size).toBe(3);
    expect(new Set(payload.proof.toolsListRequestIdSha256s).size).toBe(2);
    const visible = JSON.stringify(payload);
    expect(visible).not.toContain(rawOuterId);
    expect(visible).not.toContain("opaque-page-2");
    expect(visible).not.toContain(secretEndpoint);
    expect(visible).not.toContain(secretAccount);
    for (const rawRpcId of rpcIds) expect(visible).not.toContain(rawRpcId);
    expect(visible).not.toContain("inputSchema");
    expect(visible).not.toContain("description");
  });

  test("reuses initialization across list and call while keeping ids distinct", async () => {
    const requests: RpcRequest[] = [];
    const tools = createCloudIntegrationTools({
      post: async (_path, body) => {
        const request = body as RpcRequest;
        requests.push(request);
        if (request.method === "initialize")
          return initializeResult(request.id);
        if (request.method === "notifications/initialized") {
          return new Response(null, { status: 204 });
        }
        if (request.method === "tools/list") {
          return rpcResult(request.id, {
            tools: [listedTool("native__gmail__GMAIL_GET_PROFILE")],
          });
        }
        if (request.method === "tools/call") {
          return rpcResult(request.id, {
            content: [{ type: "text", text: '{"email":"me@example.com"}' }],
            _meta: { replayed: false },
          });
        }
        throw new Error(`unexpected method: ${String(request.method)}`);
      },
    });
    const listed = await tools
      .find((tool) => tool.name === "mcp_list")!
      .execute("same-outer-id", {});
    const called = await tools
      .find((tool) => tool.name === "mcp_call")!
      .execute("same-outer-id", {
        name: "native__gmail__GMAIL_GET_PROFILE",
        revision: "v1:11:reviewed.v1",
        arguments: {},
      });
    const payload = parseText(listed as any);
    const callProof = parseText(called as any, 1).stellaMcpProof;
    const ids = requests
      .filter((request) => request.id !== undefined)
      .map((request) => String(request.id));

    expect(
      requests.filter((request) => request.method === "initialize"),
    ).toHaveLength(1);
    expect(ids).toHaveLength(3);
    expect(new Set(ids).size).toBe(3);
    expect(callProof.initializeRequestIdSha256).toBe(
      payload.proof.initializeRequestIdSha256,
    );
    expect(callProof.callRequestIdSha256).not.toBe(
      payload.proof.toolsListRequestIdSha256s[0],
    );
  });

  test("rejects a repeated tools/list cursor", async () => {
    let pages = 0;
    const tools = createCloudIntegrationTools({
      post: initializedPost(async (request) => {
        if (request.method !== "tools/list")
          throw new Error("unexpected method");
        pages += 1;
        return rpcResult(request.id, {
          tools: [listedTool(`native__gmail__READ_${pages}`)],
          nextCursor: "cursor-loop",
        });
      }),
    });
    await expect(
      tools.find((tool) => tool.name === "mcp_list")!.execute("list", {}),
    ).rejects.toThrow(/repeated.*cursor/i);
    expect(pages).toBe(2);
  });

  test("enforces the tools/list page cap", async () => {
    let pages = 0;
    const tools = createCloudIntegrationTools({
      post: initializedPost(async (request) => {
        if (request.method !== "tools/list")
          throw new Error("unexpected method");
        pages += 1;
        return rpcResult(request.id, {
          tools: [listedTool(`native__gmail__READ_${pages}`)],
          nextCursor: `cursor-${pages}`,
        });
      }),
    });
    await expect(
      tools.find((tool) => tool.name === "mcp_list")!.execute("list", {}),
    ).rejects.toThrow(/page limit/i);
    expect(pages).toBe(8);
  });

  test("enforces per-page and aggregate tools/list item caps", async () => {
    const perPageTools = createCloudIntegrationTools({
      post: initializedPost(async (request) =>
        rpcResult(request.id, {
          tools: Array.from({ length: 9 }, (_, index) =>
            listedTool(`native__gmail__READ_${index}`),
          ),
        }),
      ),
    });
    await expect(
      perPageTools
        .find((tool) => tool.name === "mcp_list")!
        .execute("list", {}),
    ).rejects.toThrow(/item limit/i);

    let page = 0;
    const aggregateTools = createCloudIntegrationTools({
      post: initializedPost(async (request) => {
        page += 1;
        return rpcResult(request.id, {
          tools: Array.from({ length: 8 }, (_, index) =>
            listedTool(`native__gmail__READ_${page}_${index}`),
          ),
          nextCursor: `cursor-${page}`,
        });
      }),
    });
    await expect(
      aggregateTools
        .find((tool) => tool.name === "mcp_list")!
        .execute("list", {}),
    ).rejects.toThrow(/aggregate.*item limit/i);
    expect(page).toBe(7);
  });

  test("enforces the aggregate tools/list byte cap", async () => {
    let page = 0;
    const tools = createCloudIntegrationTools({
      post: initializedPost(async (request) => {
        page += 1;
        return rpcResult(request.id, {
          tools: [
            listedTool(`native__gmail__LARGE_${page}`, {
              description: "x".repeat(70 * 1024),
            }),
          ],
          ...(page === 1 ? { nextCursor: "second" } : {}),
        });
      }),
    });
    await expect(
      tools.find((tool) => tool.name === "mcp_list")!.execute("list", {}),
    ).rejects.toThrow(/aggregate.*byte limit/i);
    expect(page).toBe(2);
  });

  test("aborts and joins tools/list transport before reporting its deadline", async () => {
    let listSignal: AbortSignal | undefined;
    let activeTransports = 0;
    let cleanupObserved = false;
    const tools = createCloudIntegrationTools({
      post: initializedPost(async (request, signal) => {
        if (request.method !== "tools/list")
          throw new Error("unexpected method");
        listSignal = signal;
        activeTransports += 1;
        return await new Promise<Response>((_resolve, reject) => {
          const settle = () => {
            cleanupObserved = true;
            void Bun.sleep(20).then(() => {
              activeTransports -= 1;
              reject(signal?.reason);
            });
          };
          if (signal?.aborted) settle();
          else signal?.addEventListener("abort", settle, { once: true });
        });
      }),
    });
    const list = tools.find((tool) => tool.name === "mcp_list")!;
    await expect(
      list.execute("invalid-deadline", { deadline_ms: 15_001 }),
    ).rejects.toThrow(/1 to 15000/i);
    const started = performance.now();
    await expect(
      list.execute("list", { deadline_ms: 10 }),
    ).rejects.toThrow(/deadline/i);
    expect(performance.now() - started).toBeLessThan(500);
    expect(listSignal?.aborted).toBe(true);
    expect(cleanupObserved).toBe(true);
    expect(activeTransports).toBe(0);

    const callerController = new AbortController();
    const callerReason = new DOMException("caller canceled list", "AbortError");
    const callerRun = list.execute(
      "caller-aborted-list",
      { deadline_ms: 1_000 },
      callerController.signal,
    );
    await Bun.sleep(0);
    callerController.abort(callerReason);
    let caught: unknown;
    try {
      await callerRun;
    } catch (error) {
      caught = error;
    }
    expect(caught).toBe(callerReason);
    expect(activeTransports).toBe(0);
  });

  test("fails bounded when tools/list transport cleanup cannot be joined", async () => {
    let listSignal: AbortSignal | undefined;
    const tools = createCloudIntegrationTools({
      post: initializedPost(async (request, signal) => {
        if (request.method !== "tools/list")
          throw new Error("unexpected method");
        listSignal = signal;
        return await new Promise<Response>(() => undefined);
      }),
    });
    const started = performance.now();
    await expect(
      tools
        .find((tool) => tool.name === "mcp_list")!
        .execute("list", { deadline_ms: 5 }),
    ).rejects.toThrow(/transport cleanup/i);
    const elapsed = performance.now() - started;
    expect(elapsed).toBeGreaterThanOrEqual(200);
    expect(elapsed).toBeLessThan(1_000);
    expect(listSignal?.aborted).toBe(true);
  });

  test.each([
    [
      "readOnlyHint false",
      { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    ],
    [
      "destructiveHint true",
      { readOnlyHint: true, destructiveHint: true, idempotentHint: true },
    ],
    ["unclassified annotations", { idempotentHint: true }],
  ])(
    "keeps mutating or unclassified listed tools ineligible: %s",
    async (_label, annotations) => {
      const tools = createCloudIntegrationTools({
        post: initializedPost(async (request) =>
          rpcResult(request.id, {
            tools: [listedTool("native__gmail__MUTATE", { annotations })],
          }),
        ),
      });
      await expect(
        tools.find((tool) => tool.name === "mcp_list")!.execute("list", {}),
      ).rejects.toThrow(/invalid tool list/i);
    },
  );

  test("requires a reviewed policy version on every listed tool", async () => {
    const tools = createCloudIntegrationTools({
      post: initializedPost(async (request) =>
        rpcResult(request.id, {
          tools: [
            listedTool("native__gmail__READ", {
              meta: {
                "stella/integration": "gmail",
                "stella/revision": "v1:11:reviewed.v1",
              },
            }),
          ],
        }),
      ),
    });
    await expect(
      tools.find((tool) => tool.name === "mcp_list")!.execute("list", {}),
    ).rejects.toThrow(/invalid tool list/i);
  });

  test("best-effort cancellation references the derived tools/call id", async () => {
    const requests: Array<{ request: RpcRequest; signal?: AbortSignal }> = [];
    const controller = new AbortController();
    const originalAbort = new DOMException(
      "provider request aborted",
      "AbortError",
    );
    const tools = createCloudIntegrationTools({
      post: async (_path, body, signal) => {
        const request = body as RpcRequest;
        requests.push({ request, ...(signal ? { signal } : {}) });
        if (request.method === "initialize")
          return initializeResult(request.id);
        if (request.method === "notifications/initialized") {
          return new Response(null, { status: 204 });
        }
        if (request.method === "tools/call") {
          controller.abort(originalAbort);
          throw originalAbort;
        }
        if (request.method === "notifications/cancelled") {
          return new Response(null, { status: 202 });
        }
        throw new Error(`unexpected method: ${String(request.method)}`);
      },
    });
    let caught: unknown;
    try {
      await tools
        .find((tool) => tool.name === "mcp_call")!
        .execute(
          "outer-aborted-call",
          {
            name: "native__gmail__GMAIL_GET_PROFILE",
            revision: "v1:11:reviewed.v1",
            arguments: {},
          },
          controller.signal,
        );
    } catch (error) {
      caught = error;
    }
    const callRequest = requests.find(
      ({ request }) => request.method === "tools/call",
    )!.request;
    const cancellation = requests.find(
      ({ request }) => request.method === "notifications/cancelled",
    )!;
    expect(caught).toBe(originalAbort);
    expect(callRequest.id).toMatch(RPC_ID);
    expect(cancellation.request.params?.requestId).toBe(callRequest.id);
    expect(cancellation.request.params?.requestId).not.toBe(
      "outer-aborted-call",
    );
    expect(cancellation.signal).toBeUndefined();
  });

  test("resets a failed initialization so the next call can retry", async () => {
    let initializeAttempts = 0;
    const methods: unknown[] = [];
    const tools = createCloudIntegrationTools({
      post: async (_path, body) => {
        const request = body as RpcRequest;
        methods.push(request.method);
        if (request.method === "initialize") {
          initializeAttempts += 1;
          return initializeAttempts === 1
            ? rpcResult("wrong-id", {
                protocolVersion: "2025-03-26",
                capabilities: {},
                serverInfo: { name: "server", version: "1" },
              })
            : initializeResult(request.id);
        }
        if (request.method === "notifications/initialized") {
          return new Response(null, { status: 204 });
        }
        if (request.method === "stella/tools/search") {
          return rpcResult(request.id, { tools: [] });
        }
        throw new Error(`unexpected method: ${String(request.method)}`);
      },
    });
    const search = tools.find((tool) => tool.name === "tool_search")!;
    await expect(search.execute("first-id", { query: "mail" })).rejects.toThrow(
      /invalid response/i,
    );
    await expect(
      search.execute("second-id", { query: "mail" }),
    ).resolves.toMatchObject({ details: { count: 0 } });
    expect(initializeAttempts).toBe(2);
    expect(methods).toEqual([
      "initialize",
      "initialize",
      "notifications/initialized",
      "stella/tools/search",
    ]);
  });

  test.each([
    [
      "mismatched id",
      (id: unknown) => ({
        jsonrpc: "2.0",
        id: `${String(id)}-wrong`,
        result: {},
      }),
    ],
    [
      "wrong JSON-RPC version",
      (id: unknown) => ({ jsonrpc: "1.0", id, result: {} }),
    ],
    [
      "both result and error",
      (id: unknown) => ({
        jsonrpc: "2.0",
        id,
        result: {},
        error: { code: -32603, message: "ambiguous" },
      }),
    ],
  ])("rejects %s in a JSON-RPC response", async (_label, envelopeFor) => {
    const tools = createCloudIntegrationTools({
      post: async (_path, body) => {
        const request = body as RpcRequest;
        return Response.json(envelopeFor(request.id));
      },
    });
    await expect(
      tools
        .find((tool) => tool.name === "tool_search")!
        .execute("call", { query: "mail" }),
    ).rejects.toThrow(/invalid response/i);
  });

  test("requires initialized notification status 202/204 and empty body", async () => {
    const tools = createCloudIntegrationTools({
      post: async (_path, body) => {
        const request = body as RpcRequest;
        return request.method === "initialize"
          ? initializeResult(request.id)
          : new Response("not empty", { status: 202 });
      },
    });
    await expect(
      tools
        .find((tool) => tool.name === "tool_search")!
        .execute("call", { query: "mail" }),
    ).rejects.toThrow(/notification/i);
  });

  test("rejects provider-only search results without dual safety annotations", async () => {
    const tools = createCloudIntegrationTools({
      post: initializedPost(async (request) =>
        rpcResult(request.id, {
          tools: [
            {
              ...searchedTool("native__gmail__GMAIL_GET_PROFILE"),
              annotations: { readOnlyHint: true },
            },
          ],
        }),
      ),
    });
    await expect(
      tools
        .find((tool) => tool.name === "tool_search")!
        .execute("call", { query: "mail" }),
    ).rejects.toThrow(/invalid search results/i);
  });

  test("rejects oversized envelopes before parsing", async () => {
    const tools = createCloudIntegrationTools({
      post: async () =>
        new Response("{}", {
          headers: { "content-length": String(300 * 1024) },
        }),
    });
    await expect(
      tools
        .find((tool) => tool.name === "tool_search")!
        .execute("nested-call-large", { query: "mail" }),
    ).rejects.toThrow(/invalid response/i);
  });

  test("bounds connected-tool call text before returning it to code", async () => {
    const huge = "x".repeat(80 * 1024);
    const tools = createCloudIntegrationTools({
      post: initializedPost(async (request) =>
        rpcResult(request.id, {
          content: [{ type: "text", text: huge }],
          structuredContent: { ok: true },
          _meta: { replayed: false },
        }),
      ),
    });
    const result = await tools
      .find((tool) => tool.name === "mcp_call")!
      .execute("nested-call-output", {
        name: "native__gmail__GMAIL_GET_PROFILE",
        revision: "v1:11:reviewed.v1",
        arguments: {},
      });
    const text = (result.content[0] as { text: string }).text;
    expect(new TextEncoder().encode(text).byteLength).toBeLessThanOrEqual(
      50 * 1024,
    );
    expect(text).toEndWith("[Connected-tool output truncated.]");
    expect(
      parseText(result as any, 1).stellaMcpProof.resultReceiptSha256,
    ).toMatch(HASH);
  });
});
