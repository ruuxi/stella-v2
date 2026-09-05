import { describe, expect, test } from "bun:test";
import { createLazyCloudIntegrationTools } from "../src/lazy-cloud-integration-tools.js";

type RpcRequest = {
  jsonrpc?: unknown;
  id?: unknown;
  method?: unknown;
  params?: Record<string, unknown>;
};

const rpcResult = (id: unknown, result: unknown): Response =>
  Response.json({ jsonrpc: "2.0", id, result });

describe("lazy cloud integration tools", () => {
  test("loads the executable implementation only when a tool runs", async () => {
    const requests: RpcRequest[] = [];
    const tools = createLazyCloudIntegrationTools({
      post: async (_path, body) => {
        const request = body as RpcRequest;
        requests.push(request);
        if (request.method === "initialize") {
          return rpcResult(request.id, {
            protocolVersion: "2025-03-26",
            capabilities: { tools: { listChanged: false } },
            serverInfo: { name: "stella-native-integrations", version: "1" },
          });
        }
        if (request.method === "notifications/initialized") {
          return new Response(null, { status: 204 });
        }
        if (request.method === "stella/tools/search") {
          return rpcResult(request.id, {
            tools: [
              {
                name: "native__calendar__CALENDAR_FIND_EVENT",
                integration: "calendar",
                title: "Find event",
                description: "Find calendar events.",
                revision: "v1:calendar:reviewed.v1",
                annotations: {
                  readOnlyHint: true,
                  destructiveHint: false,
                },
              },
            ],
          });
        }
        throw new Error(`unexpected method: ${String(request.method)}`);
      },
    });

    const search = tools.find((tool) => tool.name === "tool_search");
    if (!search) throw new Error("tool_search missing");
    expect(requests).toHaveLength(0);
    const result = await search.execute("tool-call-1", {
      query: "calendar",
      limit: 1,
    });

    expect(requests.map((request) => request.method)).toEqual([
      "initialize",
      "notifications/initialized",
      "stella/tools/search",
    ]);
    expect(result.details).toEqual({ count: 1 });
    expect(result.content[0]).toMatchObject({
      type: "text",
      text: expect.stringContaining("native__calendar__CALENDAR_FIND_EVENT"),
    });
  });
});
