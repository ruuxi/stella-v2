import type { HttpRouter } from "convex/server";
import { makeFunctionReference } from "convex/server";
import { httpAction } from "../_generated/server";
import { internal } from "../_generated/api";
import {
  RequestBodyLimitError,
  readRequestTextBounded,
} from "../http_shared/bounded_request_body";
import {
  ComposioUpstreamHttpError,
  composioFetch,
  composioSessionUserIdFromPayload,
  composioToolsApiBaseUrl,
  composioToolkitConnectedFromPayload,
  requireComposioConfig,
} from "./native_oauth";

const MAX_REQUEST_BYTES = 160 * 1024;
const MAX_PROVIDER_RESULT_BYTES = 96 * 1024;
const MAX_TOOLS_LIST_BYTES = 96 * 1024;
const MAX_SEARCH_RESULT_BYTES = 32 * 1024;
const MAX_TOOLS_LIST_COUNT = 8;
const MAX_SEARCH_COUNT = 20;
const MAX_CANONICAL_DEPTH = 20;
const MAX_CANONICAL_NODES = 4_000;
const MAX_RPC_BATCH_ITEMS = 16;
const MAX_RPC_BATCH_RESPONSE_BYTES = 256 * 1024;
const SAFE_REQUEST_ID = /^[A-Za-z0-9._:-]{1,256}$/u;

type TurnTokenRow = {
  ownerId: string;
  ownerGeneration: string;
  turnId: string;
  agentType: string;
  expiresAt: number;
  tokenHash: string;
};

type CodeToolSummary = {
  name: string;
  integrationId: string;
  action: string;
  title?: string;
  description?: string;
  revision: string;
  annotations: {
    readOnlyHint: boolean;
    destructiveHint: boolean;
    idempotentHint: boolean;
    source: "composio_tool_tags";
  };
  codeModePolicy: {
    effect: "read";
    requiresApproval: false;
    policyVersion: string;
    toolkitVersion: string;
    source: "stella_admin";
  };
};

type CodeToolAction = CodeToolSummary & {
  inputSchemaJson: string;
  reviewedInputSchemaJson: string;
};

const listToolsRef = makeFunctionReference<
  "query",
  {
    ownerId: string;
    ownerGeneration: string;
    query?: string;
    limit: number;
  },
  CodeToolSummary[]
>("cloud_integration_catalog:listCodeIntegrationToolsInternal");

const listToolsPageRef = makeFunctionReference<
  "query",
  {
    ownerId: string;
    ownerGeneration: string;
    afterName?: string;
    limit: number;
  },
  { tools: CodeToolSummary[]; nextAfterName?: string }
>("cloud_integration_catalog:listCodeIntegrationToolsPageInternal");

const getToolRef = makeFunctionReference<
  "query",
  { ownerId: string; ownerGeneration: string; name: string },
  CodeToolAction | null
>("cloud_integration_catalog:getCodeIntegrationActionInternal");

type ClaimResult =
  | {
      status: "dispatch";
      integrationId: string;
      action: string;
      sessionId: string;
      composioUserId?: string;
    }
  | { status: "replay"; resultJson: string }
  | { status: "failed"; errorCode: string }
  | { status: "in_progress" };

const claimCallRef = makeFunctionReference<
  "mutation",
  {
    ownerId: string;
    ownerGeneration: string;
    requestId: string;
    fingerprint: string;
    name: string;
    revision: string;
    leaseId: string;
    now: number;
  },
  ClaimResult
>("cloud_integration_catalog:claimCodeIntegrationCallInternal");

const completeCallRef = makeFunctionReference<
  "mutation",
  {
    ownerId: string;
    ownerGeneration: string;
    requestId: string;
    fingerprint: string;
    leaseId: string;
    outcome: "succeeded" | "failed" | "unknown";
    resultJson?: string;
    errorCode?: string;
    now: number;
  },
  null
>("cloud_integration_catalog:completeCodeIntegrationCallInternal");

const assertDispatchRef = makeFunctionReference<
  "mutation",
  {
    ownerId: string;
    ownerGeneration: string;
    requestId: string;
    fingerprint: string;
    leaseId: string;
    name: string;
    revision: string;
    tokenHash: string;
    turnId: string;
    expectedSessionId: string;
    expectedComposioUserId: string;
    now: number;
  },
  {
    integrationId: string;
    action: string;
    sessionId: string;
    composioUserId: string;
    toolkitVersion: string;
  }
>("cloud_integration_catalog:assertCodeIntegrationDispatchLeaseInternal");

const cancelCallRef = makeFunctionReference<
  "mutation",
  {
    ownerId: string;
    ownerGeneration: string;
    requestId: string;
    now: number;
  },
  null
>("cloud_integration_catalog:cancelCodeIntegrationCallInternal");

type CompleteCallArgs = {
  ownerId: string;
  ownerGeneration: string;
  requestId: string;
  fingerprint: string;
  leaseId: string;
  outcome: "succeeded" | "failed" | "unknown";
  resultJson?: string;
  errorCode?: string;
  now: number;
};

const serviceAuthorized = (request: Request): boolean => {
  const secret = process.env.BUILDER_SERVICE_SECRET?.trim();
  return Boolean(
    secret && request.headers.get("authorization") === `Bearer ${secret}`,
  );
};

const sha256Hex = async (value: string): Promise<string> => {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
};

const isRpcRequestId = (value: unknown): value is string | number =>
  (typeof value === "string" && value.length <= 256) ||
  (typeof value === "number" && Number.isSafeInteger(value));

const rpcRequestIdKey = (value: string | number): string =>
  typeof value === "number" ? `number:${value}` : `string:${value}`;

const base64UrlEncode = (bytes: Uint8Array): string => {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
};

const base64UrlDecode = (value: string): Uint8Array => {
  if (!/^[A-Za-z0-9_-]+$/u.test(value) || value.length > 2_048) {
    throw new Error("invalid cursor encoding");
  }
  const padded = `${value.replaceAll("-", "+").replaceAll("_", "/")}${"=".repeat((4 - (value.length % 4)) % 4)}`;
  const binary = atob(padded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
};

const cursorHmacKey = async (): Promise<CryptoKey> => {
  const secret = process.env.BUILDER_SERVICE_SECRET?.trim();
  if (!secret) throw new Error("cursor signer unavailable");
  return await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
};

const encodeToolsCursor = async (
  turn: TurnTokenRow,
  afterName: string,
): Promise<string> => {
  const payload = JSON.stringify({
    v: 1,
    scope: await sha256Hex(`${turn.ownerId}\0${turn.ownerGeneration}`),
    afterName,
  });
  const bytes = new TextEncoder().encode(payload);
  const signature = new Uint8Array(
    await crypto.subtle.sign("HMAC", await cursorHmacKey(), bytes),
  );
  return `${base64UrlEncode(bytes)}.${base64UrlEncode(signature)}`;
};

const decodeToolsCursor = async (
  turn: TurnTokenRow,
  cursor: string,
): Promise<string> => {
  if (!cursor || cursor.length > 4_096) throw new Error("invalid cursor");
  const parts = cursor.split(".");
  if (parts.length !== 2) throw new Error("invalid cursor");
  const payloadBytes = base64UrlDecode(parts[0]!);
  const signature = base64UrlDecode(parts[1]!);
  if (
    !(await crypto.subtle.verify(
      "HMAC",
      await cursorHmacKey(),
      signature as unknown as BufferSource,
      payloadBytes as unknown as BufferSource,
    ))
  ) {
    throw new Error("invalid cursor signature");
  }
  const payload = JSON.parse(
    new TextDecoder("utf-8", { fatal: true }).decode(payloadBytes),
  ) as unknown;
  if (
    !isRecord(payload) ||
    payload.v !== 1 ||
    payload.scope !==
      (await sha256Hex(`${turn.ownerId}\0${turn.ownerGeneration}`)) ||
    typeof payload.afterName !== "string" ||
    payload.afterName.length > 300
  ) {
    throw new Error("invalid cursor payload");
  }
  return payload.afterName;
};

const verifyActiveOrchestratorTurn = async (
  ctx: { runQuery: (ref: any, args: any) => Promise<any> },
  request: Request,
): Promise<TurnTokenRow | null> => {
  if (!serviceAuthorized(request)) return null;
  const token = request.headers.get("x-stella-turn-token")?.trim();
  if (!token) return null;
  const row = (await ctx.runQuery(
    internal.cloud_apps.getTurnTokenByHashInternal,
    {
      tokenHash: await sha256Hex(token),
      now: Date.now(),
      requireActive: true,
    },
  )) as TurnTokenRow | null;
  return row?.agentType === "orchestrator" &&
    typeof row.ownerGeneration === "string"
    ? row
    : null;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

const jsonRpc = (id: unknown, result: unknown) =>
  Response.json(
    { jsonrpc: "2.0", id: id ?? null, result },
    { headers: { "cache-control": "no-store" } },
  );

const jsonRpcError = (
  id: unknown,
  code: number,
  message: string,
  status = 200,
) =>
  Response.json(
    { jsonrpc: "2.0", id: id ?? null, error: { code, message } },
    { status, headers: { "cache-control": "no-store" } },
  );

const readRpcBody = async (request: Request): Promise<unknown> => {
  const text = await readRequestTextBounded(request, MAX_REQUEST_BYTES);
  return JSON.parse(text) as unknown;
};

const stableCanonicalJson = (value: unknown): string => {
  let nodes = 0;
  const visit = (entry: unknown, depth: number): unknown => {
    nodes += 1;
    if (nodes > MAX_CANONICAL_NODES || depth > MAX_CANONICAL_DEPTH) {
      throw new Error("Connected-tool input is too complex.");
    }
    if (
      entry === null ||
      typeof entry === "string" ||
      typeof entry === "boolean"
    ) {
      return entry;
    }
    if (typeof entry === "number") {
      if (!Number.isFinite(entry)) throw new Error("Invalid numeric input.");
      return entry;
    }
    if (Array.isArray(entry)) return entry.map((item) => visit(item, depth + 1));
    if (!isRecord(entry)) throw new Error("Invalid connected-tool input.");
    const result = Object.create(null) as Record<string, unknown>;
    for (const key of Object.keys(entry).sort()) {
      Object.defineProperty(result, key, {
        value: visit(entry[key], depth + 1),
        enumerable: true,
        configurable: false,
        writable: false,
      });
    }
    return result;
  };
  return JSON.stringify(visit(value, 0));
};

const parseSchema = (schemaJson: string): Record<string, unknown> | null => {
  if (schemaJson.length * 3 > MAX_TOOLS_LIST_BYTES) return null;
  try {
    const schema = JSON.parse(schemaJson) as unknown;
    return isRecord(schema) ? schema : null;
  } catch {
    return null;
  }
};

const safeDescription = (value: string | undefined, max = 2_000) =>
  value ? value.slice(0, max) : undefined;

const mcpTool = (tool: CodeToolAction) => {
  const inputSchema = parseSchema(tool.inputSchemaJson);
  if (!inputSchema) return null;
  return {
    name: tool.name,
    ...(tool.title ? { title: tool.title.slice(0, 512) } : {}),
    ...(tool.description
      ? { description: safeDescription(tool.description) }
      : {}),
    inputSchema,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: tool.annotations.idempotentHint,
    },
    _meta: {
      "stella/integration": tool.integrationId,
      "stella/revision": tool.revision,
      "stella/codePolicyVersion": tool.codeModePolicy.policyVersion,
    },
  };
};

const isDefiniteProviderRejection = (error: unknown): boolean =>
  error instanceof ComposioUpstreamHttpError &&
  error.status >= 400 &&
  error.status < 500 &&
  error.status !== 408 &&
  error.status !== 499;

const completeBestEffort = async (
  ctx: { runMutation: (ref: any, args: any) => Promise<any> },
  args: CompleteCallArgs,
) => {
  try {
    await ctx.runMutation(completeCallRef, args);
  } catch {
    // Lifecycle/migration may have fenced completion. Never write around it.
  }
};

export function registerCloudIntegrationRoutes(http: HttpRouter) {
  http.route({
    path: "/api/cloud/integrations/mcp",
    method: "POST",
    handler: httpAction(async (ctx, request) => {
      const turn = await verifyActiveOrchestratorTurn(ctx, request);
      if (!turn) return jsonRpcError(null, -32001, "Unauthorized", 401);

      let payload: unknown;
      try {
        payload = await readRpcBody(request);
      } catch (error) {
        return jsonRpcError(
          null,
          -32700,
          error instanceof RequestBodyLimitError
            ? "Request is too large."
            : "Invalid JSON-RPC request.",
          400,
        );
      }
      const handleSingle = async (candidate: unknown): Promise<Response> => {
        if (!isRecord(candidate)) {
          return jsonRpcError(null, -32600, "Invalid JSON-RPC request.", 400);
        }
        const body = candidate;
        const hasId = Object.prototype.hasOwnProperty.call(body, "id");
        const id = hasId ? body.id : undefined;
        const method = typeof body.method === "string" ? body.method : "";
        if (
          body.jsonrpc !== "2.0" ||
          !method ||
          (hasId && !isRpcRequestId(id)) ||
          (body.params !== undefined && !isRecord(body.params))
        ) {
          return jsonRpcError(
            isRpcRequestId(id) ? id : null,
            -32600,
            "Invalid JSON-RPC request.",
            400,
          );
        }
        const params = isRecord(body.params) ? body.params : {};

        try {
        if (method === "initialize") {
          const clientInfo = isRecord(params.clientInfo)
            ? params.clientInfo
            : null;
          if (
            !hasId ||
            params.protocolVersion !== "2025-03-26" ||
            !isRecord(params.capabilities) ||
            !clientInfo ||
            typeof clientInfo.name !== "string" ||
            !clientInfo.name.trim() ||
            clientInfo.name.length > 256 ||
            typeof clientInfo.version !== "string" ||
            !clientInfo.version.trim() ||
            clientInfo.version.length > 128
          ) {
            return jsonRpcError(
              id,
              -32602,
              "initialize requires protocolVersion, capabilities, and clientInfo.",
            );
          }
          // The token lookup above and catalog queries below are the authority;
          // caller-supplied owner identifiers are deliberately ignored.
          await ctx.runQuery(listToolsRef, {
            ownerId: turn.ownerId,
            ownerGeneration: turn.ownerGeneration,
            limit: 1,
          });
          return jsonRpc(id, {
            protocolVersion: "2025-03-26",
            capabilities: { tools: { listChanged: false } },
            serverInfo: { name: "stella-native-integrations", version: "1" },
          });
        }

        if (method === "notifications/initialized") {
          if (hasId) {
            return jsonRpcError(
              id,
              -32600,
              "notifications/initialized must not include an id.",
              400,
            );
          }
          // JSON-RPC notifications never receive a response body.
          return new Response(null, {
            status: 202,
            headers: { "cache-control": "no-store" },
          });
        }

        if (method === "notifications/cancelled") {
          if (hasId) {
            return jsonRpcError(
              id,
              -32600,
              "notifications/cancelled must not include an id.",
              400,
            );
          }
          const canceledRpcId = params.requestId;
          if (isRpcRequestId(canceledRpcId)) {
            await ctx.runMutation(cancelCallRef, {
              ownerId: turn.ownerId,
              ownerGeneration: turn.ownerGeneration,
              requestId: await sha256Hex(
                `cloud-integration\0${turn.ownerGeneration}\0${turn.turnId}\0${rpcRequestIdKey(canceledRpcId)}`,
              ),
              now: Date.now(),
            });
          }
          return new Response(null, {
            status: 202,
            headers: { "cache-control": "no-store" },
          });
        }

        if (method === "ping") {
          return jsonRpc(id, {});
        }

        if (method === "stella/tools/search") {
          const query =
            typeof params.query === "string" ? params.query.trim() : "";
          if (!query || query.length > 200) {
            return jsonRpcError(id, -32602, "query must be 1-200 characters.");
          }
          const tools = await ctx.runQuery(listToolsRef, {
            ownerId: turn.ownerId,
            ownerGeneration: turn.ownerGeneration,
            query,
            limit: Math.min(
              Math.max(Number(params.limit) || 8, 1),
              MAX_SEARCH_COUNT,
            ),
          });
          const summaries: Array<Record<string, unknown>> = [];
          let budget = 0;
          for (const tool of tools) {
            const summary = {
              name: tool.name,
              integration: tool.integrationId,
              action: tool.action,
              ...(tool.title ? { title: tool.title.slice(0, 512) } : {}),
              ...(tool.description
                ? { description: safeDescription(tool.description, 1_000) }
                : {}),
              revision: tool.revision,
              annotations: {
                readOnlyHint: true,
                destructiveHint: false,
                idempotentHint: tool.annotations.idempotentHint,
              },
            };
            const encoded = JSON.stringify(summary);
            budget += encoded.length * 3;
            if (budget > MAX_SEARCH_RESULT_BYTES) break;
            summaries.push(summary);
          }
          return jsonRpc(id, { tools: summaries });
        }

        if (method === "stella/tools/describe") {
          const name = typeof params.name === "string" ? params.name : "";
          const tool = await ctx.runQuery(getToolRef, {
            ownerId: turn.ownerId,
            ownerGeneration: turn.ownerGeneration,
            name,
          });
          const rendered = tool ? mcpTool(tool) : null;
          return rendered
            ? jsonRpc(id, { tool: rendered })
            : jsonRpcError(id, -32602, "Read-only connected tool not found.");
        }

        if (method === "tools/list") {
          if (
            params.cursor !== undefined &&
            typeof params.cursor !== "string"
          ) {
            return jsonRpcError(id, -32602, "cursor must be an opaque string.");
          }
          let afterName: string | undefined;
          try {
            afterName =
              typeof params.cursor === "string"
                ? await decodeToolsCursor(turn, params.cursor)
                : undefined;
          } catch {
            return jsonRpcError(id, -32602, "Invalid tools/list cursor.");
          }
          const page = await ctx.runQuery(listToolsPageRef, {
            ownerId: turn.ownerId,
            ownerGeneration: turn.ownerGeneration,
            ...(afterName ? { afterName } : {}),
            limit: MAX_TOOLS_LIST_COUNT,
          });
          const tools: Array<Record<string, unknown>> = [];
          let budget = 0;
          let byteTruncated = false;
          for (const summary of page.tools) {
            const exact = await ctx.runQuery(getToolRef, {
              ownerId: turn.ownerId,
              ownerGeneration: turn.ownerGeneration,
              name: summary.name,
            });
            const rendered = exact ? mcpTool(exact) : null;
            if (!rendered) continue;
            const encoded = JSON.stringify(rendered);
            budget += encoded.length * 3;
            if (budget > MAX_TOOLS_LIST_BYTES) {
              byteTruncated = true;
              break;
            }
            tools.push(rendered);
          }
          if (byteTruncated && tools.length === 0) {
            return jsonRpcError(
              id,
              -32015,
              "Connected-tool schema exceeds the tools/list byte budget.",
            );
          }
          const cursorAfter = byteTruncated
            ? (tools[tools.length - 1]?.name as string | undefined)
            : page.nextAfterName;
          return jsonRpc(id, {
            tools,
            ...(cursorAfter
              ? { nextCursor: await encodeToolsCursor(turn, cursorAfter) }
              : {}),
          });
        }

        if (method !== "tools/call") {
          return jsonRpcError(id, -32601, "Method not found.");
        }

        const name = typeof params.name === "string" ? params.name : "";
        const input = isRecord(params.arguments) ? params.arguments : null;
        const meta = isRecord(params._meta) ? params._meta : {};
        const revision =
          typeof meta.revision === "string" ? meta.revision : "";
        const rpcRequestId = isRpcRequestId(id) ? rpcRequestIdKey(id) : "";
        const stableRpcRequestId =
          typeof id === "number" ||
          (typeof id === "string" && SAFE_REQUEST_ID.test(id));
        if (
          !name ||
          !input ||
          !revision ||
          !stableRpcRequestId
        ) {
          return jsonRpcError(
            id,
            -32602,
            "name, arguments, revision, and a stable JSON-RPC id are required.",
          );
        }

        const tool = await ctx.runQuery(getToolRef, {
          ownerId: turn.ownerId,
          ownerGeneration: turn.ownerGeneration,
          name,
        });
        if (!tool || tool.revision !== revision) {
          return jsonRpcError(id, -32010, "Tool policy changed; search again.");
        }
        const inputJson = stableCanonicalJson(input);
        const validation = await ctx.runAction(
          internal.node.native_integration_schemas.validateActionInput,
          { inputJson, schemaJson: tool.inputSchemaJson },
        );
        if (validation !== "valid") {
          return jsonRpcError(id, -32602, "Tool input failed schema validation.");
        }
        const reviewedValidation = await ctx.runAction(
          internal.node.native_integration_schemas.validateActionInput,
          {
            inputJson,
            schemaJson: tool.reviewedInputSchemaJson,
          },
        );
        if (reviewedValidation !== "valid") {
          return jsonRpcError(
            id,
            -32602,
            "Tool input is outside Stella's reviewed Code contract.",
          );
        }
        const validatedInput = JSON.parse(inputJson) as Record<string, unknown>;
        if (request.signal.aborted) {
          return jsonRpcError(id, -32000, "Request canceled.");
        }

        const requestId = await sha256Hex(
          `cloud-integration\0${turn.ownerGeneration}\0${turn.turnId}\0${rpcRequestId}`,
        );
        const fingerprint = await sha256Hex(
          `${name}\0${revision}\0${inputJson}`,
        );
        const leaseId = crypto.randomUUID();
        const claim = await ctx.runMutation(claimCallRef, {
          ownerId: turn.ownerId,
          ownerGeneration: turn.ownerGeneration,
          requestId,
          fingerprint,
          name,
          revision,
          leaseId,
          now: Date.now(),
        });
        if (claim.status === "replay") {
          return jsonRpc(id, {
            content: [{ type: "text", text: claim.resultJson }],
            structuredContent: JSON.parse(claim.resultJson) as unknown,
            _meta: { replayed: true },
          });
        }
        if (claim.status === "failed") {
          return jsonRpcError(id, -32011, "Earlier provider call failed.");
        }
        if (claim.status === "in_progress") {
          return jsonRpcError(id, -32009, "This call is already in progress.");
        }
        if (request.signal.aborted) {
          await completeBestEffort(ctx, {
            ownerId: turn.ownerId,
            ownerGeneration: turn.ownerGeneration,
            requestId,
            fingerprint,
            leaseId,
            outcome: "failed",
            errorCode: "canceled_before_dispatch",
            now: Date.now(),
          });
          return jsonRpcError(id, -32000, "Request canceled.");
        }

        const composio = requireComposioConfig();
        if (!composio.config) {
          await completeBestEffort(ctx, {
            ownerId: turn.ownerId,
            ownerGeneration: turn.ownerGeneration,
            requestId,
            fingerprint,
            leaseId,
            outcome: "failed",
            errorCode: "provider_unavailable",
            now: Date.now(),
          });
          return jsonRpcError(id, -32012, "Connected-tool provider unavailable.");
        }

        let statusPayload: Record<string, unknown>;
        let composioUserId = claim.composioUserId;
        try {
          statusPayload = await composioFetch(
            `/session/${encodeURIComponent(claim.sessionId)}/toolkits`,
            { method: "GET" },
            composio.config,
            {
              maxResponseBytes: MAX_PROVIDER_RESULT_BYTES,
              signal: request.signal,
            },
          );
          if (!composioUserId) {
            const sessionPayload = await composioFetch(
              `/session/${encodeURIComponent(claim.sessionId)}`,
              { method: "GET" },
              composio.config,
              {
                maxResponseBytes: MAX_PROVIDER_RESULT_BYTES,
                signal: request.signal,
              },
            );
            composioUserId =
              composioSessionUserIdFromPayload(sessionPayload) ?? undefined;
          }
        } catch (error) {
          await completeBestEffort(ctx, {
            ownerId: turn.ownerId,
            ownerGeneration: turn.ownerGeneration,
            requestId,
            fingerprint,
            leaseId,
            outcome: "failed",
            errorCode: request.signal.aborted
              ? "canceled_before_dispatch"
              : "connection_status_error",
            now: Date.now(),
          });
          return jsonRpcError(
            id,
            request.signal.aborted ? -32000 : -32012,
            request.signal.aborted
              ? "Request canceled before provider dispatch."
              : "Connected-tool provider status check failed.",
          );
        }
        if (
          !composioToolkitConnectedFromPayload(
            statusPayload,
            claim.integrationId,
          )
        ) {
          await completeBestEffort(ctx, {
            ownerId: turn.ownerId,
            ownerGeneration: turn.ownerGeneration,
            requestId,
            fingerprint,
            leaseId,
            outcome: "failed",
            errorCode: "connect_required",
            now: Date.now(),
          });
          return jsonRpcError(id, -32013, "Connect this integration first.");
        }
        if (!composioUserId) {
          await completeBestEffort(ctx, {
            ownerId: turn.ownerId,
            ownerGeneration: turn.ownerGeneration,
            requestId,
            fingerprint,
            leaseId,
            outcome: "failed",
            errorCode: "provider_principal_unavailable",
            now: Date.now(),
          });
          return jsonRpcError(
            id,
            -32012,
            "Connected-tool provider principal is unavailable.",
          );
        }

        // The status request above is intentionally outside the mutation. A
        // reset, migration, policy update, session replacement, or receipt
        // takeover may have happened while it was in flight, so renew and
        // revalidate every authority transactionally immediately before IO.
        let dispatch: {
          integrationId: string;
          action: string;
          sessionId: string;
          composioUserId: string;
          toolkitVersion: string;
        };
        try {
          dispatch = await ctx.runMutation(assertDispatchRef, {
            ownerId: turn.ownerId,
            ownerGeneration: turn.ownerGeneration,
            requestId,
            fingerprint,
            leaseId,
            name,
            revision,
            tokenHash: turn.tokenHash,
            turnId: turn.turnId,
            expectedSessionId: claim.sessionId,
            expectedComposioUserId: composioUserId,
            now: Date.now(),
          });
        } catch {
          await completeBestEffort(ctx, {
            ownerId: turn.ownerId,
            ownerGeneration: turn.ownerGeneration,
            requestId,
            fingerprint,
            leaseId,
            outcome: "failed",
            errorCode: "dispatch_fenced",
            now: Date.now(),
          });
          return jsonRpcError(
            id,
            -32010,
            "Connected-tool authority changed before dispatch.",
          );
        }
        if (request.signal.aborted) {
          await completeBestEffort(ctx, {
            ownerId: turn.ownerId,
            ownerGeneration: turn.ownerGeneration,
            requestId,
            fingerprint,
            leaseId,
            outcome: "failed",
            errorCode: "canceled_before_dispatch",
            now: Date.now(),
          });
          return jsonRpcError(id, -32000, "Request canceled before dispatch.");
        }

        try {
          const directConfig = {
            ...composio.config,
            baseUrl: composioToolsApiBaseUrl(composio.config.baseUrl),
          };
          const payload = await composioFetch(
            `/tools/execute/${encodeURIComponent(dispatch.action)}`,
            {
              method: "POST",
              body: JSON.stringify({
                user_id: dispatch.composioUserId,
                version: dispatch.toolkitVersion,
                arguments: validatedInput,
              }),
            },
            directConfig,
            {
              maxResponseBytes: MAX_PROVIDER_RESULT_BYTES,
              signal: request.signal,
            },
          );
          const resultJson = JSON.stringify(payload);
          if (resultJson.length * 3 > MAX_PROVIDER_RESULT_BYTES) {
            throw new Error("provider_result_too_large");
          }
          await ctx.runMutation(completeCallRef, {
            ownerId: turn.ownerId,
            ownerGeneration: turn.ownerGeneration,
            requestId,
            fingerprint,
            leaseId,
            outcome: "succeeded",
            resultJson,
            now: Date.now(),
          });
          return jsonRpc(id, {
            content: [{ type: "text", text: resultJson }],
            structuredContent: payload,
            _meta: { replayed: false },
          });
        } catch (error) {
          const definiteRejection = isDefiniteProviderRejection(error);
          await completeBestEffort(ctx, {
            ownerId: turn.ownerId,
            ownerGeneration: turn.ownerGeneration,
            requestId,
            fingerprint,
            leaseId,
            outcome: definiteRejection ? "failed" : "unknown",
            errorCode: definiteRejection
              ? "provider_rejected"
              : "outcome_unknown",
            now: Date.now(),
          });
          console.error("[cloud-integrations] read-only provider call failed", {
            tool: name,
            definiteRejection,
            canceled: request.signal.aborted,
            message: error instanceof Error ? error.message : "unknown",
          });
          return jsonRpcError(
            id,
            definiteRejection ? -32012 : -32014,
            definiteRejection
              ? "Connected-tool provider rejected the call."
              : "Provider outcome is unknown; this read-only call may be retried.",
          );
        }
      } catch (error) {
        console.error("[cloud-integrations] MCP request rejected", {
          method,
          message: error instanceof Error ? error.message : "unknown",
        });
        return jsonRpcError(id, -32000, "Connected-tool request was rejected.");
      }
      };

      const isNotification = (candidate: unknown): boolean =>
        isRecord(candidate) &&
        candidate.jsonrpc === "2.0" &&
        typeof candidate.method === "string" &&
        !Object.prototype.hasOwnProperty.call(candidate, "id");

      if (!Array.isArray(payload)) {
        const response = await handleSingle(payload);
        return isNotification(payload)
          ? new Response(null, {
              status: 202,
              headers: { "cache-control": "no-store" },
            })
          : response;
      }

      if (
        payload.length === 0 ||
        payload.length > MAX_RPC_BATCH_ITEMS ||
        payload.some(
          (candidate) =>
            isRecord(candidate) && candidate.method === "initialize",
        )
      ) {
        return jsonRpcError(
          null,
          -32600,
          payload.length > MAX_RPC_BATCH_ITEMS
            ? `JSON-RPC batch exceeds ${MAX_RPC_BATCH_ITEMS} messages.`
            : "initialize cannot be sent in a JSON-RPC batch.",
          400,
        );
      }

      const responses: unknown[] = [];
      let aggregateBytes = 2;
      for (const candidate of payload) {
        const response = await handleSingle(candidate);
        if (isNotification(candidate)) continue;
        const text = await response.text();
        aggregateBytes += new TextEncoder().encode(text).byteLength + 1;
        if (aggregateBytes > MAX_RPC_BATCH_RESPONSE_BYTES) {
          return jsonRpcError(
            null,
            -32015,
            "JSON-RPC batch response exceeded its aggregate byte budget.",
            413,
          );
        }
        try {
          responses.push(JSON.parse(text) as unknown);
        } catch {
          responses.push({
            jsonrpc: "2.0",
            id: null,
            error: { code: -32603, message: "Internal JSON-RPC response error." },
          });
        }
      }
      return responses.length === 0
        ? new Response(null, {
            status: 202,
            headers: { "cache-control": "no-store" },
          })
        : Response.json(responses, {
            headers: { "cache-control": "no-store" },
          });
    }),
  });
  http.route({
    path: "/api/cloud/integrations/mcp",
    method: "GET",
    handler: httpAction(async () =>
      new Response(null, {
        status: 405,
        headers: {
          allow: "POST",
          "cache-control": "no-store",
        },
      }),
    ),
  });
}
