import { createCloudCodeAgentTool } from "../../src/cloud-code-tool.js";
import { createCloudIntegrationTools } from "../../src/cloud-integration-tools.js";

type Env = { LOADER: WorkerLoader };
type RpcRequest = {
  jsonrpc?: unknown;
  id?: unknown;
  method?: unknown;
  params?: Record<string, unknown>;
};

const endpointMarker = "https://private.example.invalid/mcp";
const tokenMarker = "raw-turn-token-must-not-leak";
const accountMarker = "raw-account-id-must-not-leak";
const cursorMarker = "opaque-workerd-page-2";

const rpcResult = (id: unknown, result: unknown): Response =>
  Response.json({ jsonrpc: "2.0", id, result });

const listedTool = (name: string, revision: string) => ({
  name,
  description: `${endpointMarker}?token=${tokenMarker}`,
  inputSchema: {
    type: "object",
    description: tokenMarker,
    additionalProperties: false,
  },
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
  },
  _meta: {
    "stella/integration": "gmail",
    "stella/revision": revision,
    "stella/codePolicyVersion": "gmail-read.workerd.v1",
  },
});

export default {
  async fetch(_request: Request, env: Env): Promise<Response> {
    const requests: RpcRequest[] = [];
    const integrationTools = createCloudIntegrationTools({
      post: async (path, body, signal) => {
        if (path !== "/api/cloud/integrations/mcp") {
          throw new Error("unexpected connected-tool route");
        }
        signal?.throwIfAborted();
        const request = body as RpcRequest;
        requests.push(request);
        if (request.method === "initialize") {
          return rpcResult(request.id, {
            protocolVersion: "2025-03-26",
            capabilities: { tools: { listChanged: false } },
            serverInfo: { name: "stella-native-integrations", version: "1" },
            privateDebug: {
              endpoint: endpointMarker,
              token: tokenMarker,
              account: accountMarker,
            },
          });
        }
        if (request.method === "notifications/initialized") {
          return new Response(null, { status: 202 });
        }
        if (request.method === "tools/list") {
          return request.params?.cursor === undefined
            ? rpcResult(request.id, {
                tools: [
                  listedTool(
                    "native__gmail__GMAIL_GET_PROFILE",
                    "v1:11:reviewed.workerd.v1",
                  ),
                ],
                nextCursor: cursorMarker,
              })
            : rpcResult(request.id, {
                tools: [
                  listedTool(
                    "native__gmail__GMAIL_LIST_THREADS",
                    "v1:12:reviewed.workerd.v1",
                  ),
                ],
              });
        }
        if (request.method === "stella/tools/describe") {
          return rpcResult(request.id, {
            tool: listedTool(
              "native__gmail__GMAIL_GET_PROFILE",
              "v1:11:reviewed.workerd.v1",
            ),
          });
        }
        if (request.method === "tools/call") {
          return rpcResult(request.id, {
            content: [{ type: "text", text: '{"email":"me@example.com"}' }],
            structuredContent: { email: "me@example.com" },
            _meta: { replayed: false },
          });
        }
        throw new Error(`unexpected method: ${String(request.method)}`);
      },
    });
    const codeTool = createCloudCodeAgentTool({
      loader: env.LOADER,
      tools: integrationTools,
      executionScope: "workerd:mcp-list-acceptance",
    });
    const executed = await codeTool.execute("workerd-code-call", {
      timeout_ms: 5_000,
      code: `async () => {
        const listed = await codemode.mcp_list({ deadline_ms: 1000 });
        const catalog = JSON.parse(listed.content[0].text);
        const described = await codemode.mcp_describe({
          name: "native__gmail__GMAIL_GET_PROFILE",
        });
        const describeProof = JSON.parse(described.content[1].text).stellaMcpProof;
        const called = await codemode.mcp_call({
          name: "native__gmail__GMAIL_GET_PROFILE",
          revision: "v1:11:reviewed.workerd.v1",
          arguments: {},
        });
        const callOutput = JSON.parse(called.content[0].text);
        const callProof = JSON.parse(called.content[1].text).stellaMcpProof;
        let outbound = "allowed";
        try {
          await fetch("https://example.com/");
        } catch {
          outbound = "blocked";
        }
        return {
          answer: 6 * 7,
          outbound,
          catalog,
          describeProof,
          callOutput,
          callProof,
        };
      }`,
    });
    if (executed.isError) return Response.json(executed, { status: 500 });
    const visibleText = (executed.content[0] as { text?: string }).text ?? "";
    const result = JSON.parse(visibleText) as Record<string, unknown>;
    const rpcIds = requests
      .filter((request) => request.id !== undefined)
      .map((request) => String(request.id));
    return Response.json({
      ok: true,
      result,
      hostProof: {
        rpcRequestCount: rpcIds.length,
        rawRpcIdsDistinct: new Set(rpcIds).size === rpcIds.length,
        rawRpcIdsLeaked: rpcIds.some((id) => visibleText.includes(id)),
        privateFieldsLeaked: [
          endpointMarker,
          tokenMarker,
          accountMarker,
          cursorMarker,
        ].some((marker) => visibleText.includes(marker)),
        initializedNotificationCount: requests.filter(
          (request) => request.method === "notifications/initialized",
        ).length,
        toolsListPageCount: requests.filter(
          (request) => request.method === "tools/list",
        ).length,
        toolsDescribeCount: requests.filter(
          (request) => request.method === "stella/tools/describe",
        ).length,
        toolsCallCount: requests.filter(
          (request) => request.method === "tools/call",
        ).length,
      },
    });
  },
};
