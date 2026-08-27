import type { TSchema } from "@sinclair/typebox";
import type { AgentTool } from "@stella/runtime/kernel/agent-core/types.js";
import { acquireAbortLatch } from "@stella/runtime/kernel/agent-core/abort-bridge.js";
import { runToolEffect } from "@stella/runtime/kernel/tools/effect-runtime.js";
import { Deferred, Effect, Fiber } from "effect";
import {
  boundedJsonPreview,
  cloneBoundedJsonValue,
  truncateUtf8,
} from "./cloud-code-bounds.js";
import { sha256Hex } from "./hash.js";

type CloudIntegrationTool = AgentTool & { codeEligibility: "read_only" };

export type CloudIntegrationToolContext = Readonly<{
  post: (
    path: string,
    body: unknown,
    signal?: AbortSignal,
  ) => Promise<Response>;
}>;

const MAX_RPC_RESPONSE_BYTES = 256 * 1024;
const MAX_MODEL_RESULT_BYTES = 50 * 1024;
const MCP_PROTOCOL_VERSION = "2025-03-26";
const MCP_LIST_MAX_PAGES = 8;
const MCP_LIST_MAX_PAGE_TOOLS = 8;
const MCP_LIST_MAX_TOOLS = 48;
const MCP_LIST_MAX_RESPONSE_BYTES = 128 * 1024;
const MCP_LIST_MAX_CURSOR_CHARS = 2_048;
const MCP_LIST_MAX_DEADLINE_MS = 15_000;
const MCP_LIST_TRANSPORT_JOIN_TIMEOUT_MS = 250;

type JsonRecord = Record<string, unknown>;

type InitializationProof = Readonly<{
  protocolVersion: typeof MCP_PROTOCOL_VERSION;
  serverIdSha256: string;
  initializeRequestIdSha256: string;
  initializationReceiptSha256: string;
  initializedNotificationReceiptSha256: string;
  initializedNotificationSent: true;
}>;

const isRecord = (value: unknown): value is JsonRecord =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

const canonicalize = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, canonicalize(value[key])]),
  );
};

const canonicalJson = (value: unknown): string =>
  JSON.stringify(canonicalize(value));

const utf8Size = (value: string): number =>
  new TextEncoder().encode(value).byteLength;

const rpcRequestId = async (
  toolCallId: string,
  operation: string,
): Promise<string> =>
  `mcp-${await sha256Hex(`stella-cloud-mcp-rpc-v1\0${toolCallId}\0${operation}`)}`;

const requestIdSha256 = async (requestId: string): Promise<string> =>
  await sha256Hex(requestId);

const toolIdSha256 = async (name: string, revision: string): Promise<string> =>
  await sha256Hex(canonicalJson({ schemaVersion: 1, name, revision }));

const readResponseBytesBounded = async (
  response: Response,
): Promise<Uint8Array> => {
  const contentLength = Number(response.headers.get("content-length"));
  if (
    Number.isFinite(contentLength) &&
    contentLength > MAX_RPC_RESPONSE_BYTES
  ) {
    await response.body?.cancel("response too large").catch(() => undefined);
    throw new Error("Connected-tool service response exceeded its byte limit.");
  }
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_RPC_RESPONSE_BYTES) {
        await reader.cancel("response too large").catch(() => undefined);
        throw new Error(
          "Connected-tool service response exceeded its byte limit.",
        );
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
};

const readResponseJsonBounded = async (
  response: Response,
): Promise<unknown> => {
  const bytes = await readResponseBytesBounded(response);
  return JSON.parse(
    new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes),
  );
};

const parseRpcResponse = async (
  response: Response,
  expectedId: string,
): Promise<unknown> => {
  let envelope: JsonRecord;
  try {
    const parsed = await readResponseJsonBounded(response);
    const bounded = cloneBoundedJsonValue(parsed, {
      maxBytes: MAX_RPC_RESPONSE_BYTES,
      maxDepth: 20,
      maxNodes: 4_096,
      maxEntries: 4_096,
      maxStringBytes: 128 * 1024,
    });
    if (!bounded.ok || !isRecord(bounded.value)) {
      throw new Error("invalid bounded JSON-RPC envelope");
    }
    envelope = bounded.value;
  } catch {
    throw new Error("Connected-tool service returned an invalid response.");
  }

  const hasResult = Object.hasOwn(envelope, "result");
  const hasError = Object.hasOwn(envelope, "error");
  if (
    envelope.jsonrpc !== "2.0" ||
    envelope.id !== expectedId ||
    hasResult === hasError
  ) {
    throw new Error("Connected-tool service returned an invalid response.");
  }

  if (hasError) {
    if (!isRecord(envelope.error)) {
      throw new Error("Connected-tool service returned an invalid response.");
    }
    const code = envelope.error.code;
    const message = envelope.error.message;
    if (!Number.isInteger(code) || typeof message !== "string") {
      throw new Error("Connected-tool service returned an invalid response.");
    }
    throw new Error(
      message || `Connected-tool service failed (${response.status}).`,
    );
  }

  if (!response.ok) {
    throw new Error(`Connected-tool service failed (${response.status}).`);
  }
  return envelope.result;
};

const rpc = async (
  context: CloudIntegrationToolContext,
  requestId: string,
  method: string,
  params: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<unknown> => {
  const response = await context.post(
    "/api/cloud/integrations/mcp",
    { jsonrpc: "2.0", id: requestId, method, params },
    signal,
  );
  return parseRpcResponse(response, requestId);
};

const requireRecordResult = (result: unknown): JsonRecord => {
  if (!isRecord(result)) {
    throw new Error("Connected-tool service returned an invalid response.");
  }
  return result;
};

const postNotification = async (
  context: CloudIntegrationToolContext,
  method: string,
  params?: Record<string, unknown>,
  signal?: AbortSignal,
  acceptedStatuses: readonly number[] = [202, 204],
): Promise<Readonly<{ status: number; bodyBytes: 0 }>> => {
  const response = await context.post(
    "/api/cloud/integrations/mcp",
    {
      jsonrpc: "2.0",
      method,
      ...(params ? { params } : {}),
    },
    signal,
  );
  if (!acceptedStatuses.includes(response.status)) {
    await response.body
      ?.cancel("unexpected notification response")
      .catch(() => undefined);
    throw new Error("Connected-tool service rejected an MCP notification.");
  }
  let bytes: Uint8Array;
  try {
    bytes = await readResponseBytesBounded(response);
  } catch {
    throw new Error("Connected-tool service returned an invalid response.");
  }
  if (bytes.byteLength !== 0) {
    throw new Error(
      "Connected-tool service returned a body for an MCP notification.",
    );
  }
  return { status: response.status, bodyBytes: 0 };
};

type ListedTool = Readonly<{
  name: string;
  title?: string;
  description?: string;
  revision: string;
  integration?: string;
  codePolicyVersion: string;
  annotations: JsonRecord;
  raw: JsonRecord;
}>;

const parseListedTool = (value: unknown): ListedTool => {
  if (!isRecord(value)) {
    throw new Error("Connected-tool service returned an invalid tool list.");
  }
  const name = value.name;
  const title = value.title;
  const description = value.description;
  const inputSchema = value.inputSchema;
  const annotations = value.annotations;
  const meta = value._meta;
  if (
    typeof name !== "string" ||
    name.length === 0 ||
    name.length > 300 ||
    (title !== undefined && typeof title !== "string") ||
    (description !== undefined && typeof description !== "string") ||
    !isRecord(inputSchema) ||
    !isRecord(annotations) ||
    annotations.readOnlyHint !== true ||
    annotations.destructiveHint !== false ||
    !isRecord(meta) ||
    typeof meta["stella/revision"] !== "string" ||
    meta["stella/revision"].length === 0 ||
    meta["stella/revision"].length > 192 ||
    (meta["stella/integration"] !== undefined &&
      (typeof meta["stella/integration"] !== "string" ||
        meta["stella/integration"].length > 128)) ||
    typeof meta["stella/codePolicyVersion"] !== "string" ||
    meta["stella/codePolicyVersion"].length === 0 ||
    meta["stella/codePolicyVersion"].length > 192
  ) {
    throw new Error("Connected-tool service returned an invalid tool list.");
  }
  return {
    name,
    ...(typeof title === "string" ? { title } : {}),
    ...(typeof description === "string" ? { description } : {}),
    revision: meta["stella/revision"],
    codePolicyVersion: meta["stella/codePolicyVersion"],
    ...(typeof meta["stella/integration"] === "string"
      ? { integration: meta["stella/integration"] }
      : {}),
    annotations,
    raw: value,
  };
};

type ToolsListPage = Readonly<{
  tools: readonly ListedTool[];
  nextCursor?: string;
  bytes: number;
}>;

const parseToolsListPage = (result: unknown): ToolsListPage => {
  const record = requireRecordResult(result);
  if (
    !Array.isArray(record.tools) ||
    record.tools.length > MCP_LIST_MAX_PAGE_TOOLS
  ) {
    throw new Error(
      "Connected-tool service exceeded the tools/list item limit.",
    );
  }
  const nextCursor = record.nextCursor;
  if (
    nextCursor !== undefined &&
    (typeof nextCursor !== "string" ||
      nextCursor.length === 0 ||
      nextCursor.length > MCP_LIST_MAX_CURSOR_CHARS)
  ) {
    throw new Error(
      "Connected-tool service returned an invalid tools/list cursor.",
    );
  }
  return {
    tools: record.tools.map(parseListedTool),
    ...(typeof nextCursor === "string" ? { nextCursor } : {}),
    bytes: utf8Size(canonicalJson(record)),
  };
};

type SearchedTool = Readonly<{
  name: string;
  title?: string;
  description?: string;
  revision: string;
  integration?: string;
  annotations: JsonRecord;
  raw: JsonRecord;
}>;

const parseSearchTools = (result: unknown): SearchedTool[] => {
  const record = requireRecordResult(result);
  if (!Array.isArray(record.tools) || record.tools.length > 20) {
    throw new Error("Connected-tool service returned invalid search results.");
  }
  return record.tools.map((value) => {
    if (!isRecord(value)) {
      throw new Error(
        "Connected-tool service returned invalid search results.",
      );
    }
    const name = value.name;
    const integration = value.integration;
    const title = value.title;
    const description = value.description;
    const revision = value.revision;
    const annotations = value.annotations;
    if (
      typeof name !== "string" ||
      name.length === 0 ||
      name.length > 300 ||
      (integration !== undefined && typeof integration !== "string") ||
      (title !== undefined && typeof title !== "string") ||
      (description !== undefined && typeof description !== "string") ||
      typeof revision !== "string" ||
      revision.length === 0 ||
      revision.length > 192 ||
      !isRecord(annotations) ||
      annotations.readOnlyHint !== true ||
      annotations.destructiveHint !== false
    ) {
      throw new Error(
        "Connected-tool service returned invalid search results.",
      );
    }
    return {
      name,
      ...(typeof integration === "string" ? { integration } : {}),
      ...(typeof title === "string" ? { title } : {}),
      ...(typeof description === "string" ? { description } : {}),
      revision,
      annotations,
      raw: value,
    };
  });
};

const renderedJson = (value: unknown): string => {
  return boundedJsonPreview(value, MAX_MODEL_RESULT_BYTES);
};

const runWithDeadline = async <T>(
  deadlineMs: number,
  callerSignal: AbortSignal | undefined,
  operation: (signal: AbortSignal) => Promise<T>,
): Promise<T> => {
  callerSignal?.throwIfAborted();
  const timeoutSignal = AbortSignal.timeout(deadlineMs);
  const transportSignal = callerSignal
    ? AbortSignal.any([callerSignal, timeoutSignal])
    : timeoutSignal;
  type Outcome =
    | { readonly status: "completed"; readonly value: T }
    | { readonly status: "failed"; readonly error: unknown }
    | { readonly status: "aborted" };

  return await runToolEffect(
    Effect.scoped(
      Effect.gen(function* () {
        const abortLatch = yield* acquireAbortLatch(transportSignal);
        const transportFiber = yield* Effect.forkScoped(
          Effect.tryPromise({
            try: () => operation(transportSignal),
            catch: (error) => error,
          }).pipe(
            Effect.match({
              onFailure: (error): Outcome => ({ status: "failed", error }),
              onSuccess: (value): Outcome => ({ status: "completed", value }),
            }),
          ),
          { startImmediately: true },
        );
        const outcome = yield* Effect.raceFirst(
          Fiber.join(transportFiber),
          Deferred.await(abortLatch).pipe(
            Effect.as<Outcome>({ status: "aborted" }),
          ),
        );
        if (outcome.status === "completed") return outcome.value;
        if (outcome.status === "failed") {
          if (callerSignal?.aborted) {
            return yield* Effect.fail(callerSignal.reason);
          }
          if (timeoutSignal.aborted) {
            return yield* Effect.fail(
              new Error("mcp_list exceeded its deadline."),
            );
          }
          return yield* Effect.fail(outcome.error);
        }

        const transportJoined = yield* Effect.raceFirst(
          Fiber.join(transportFiber).pipe(Effect.as(true)),
          Effect.sleep(MCP_LIST_TRANSPORT_JOIN_TIMEOUT_MS).pipe(
            Effect.as(false),
          ),
        );
        if (!transportJoined) {
          return yield* Effect.fail(
            new Error(
              "mcp_list could not confirm connected-tool transport cleanup.",
            ),
          );
        }
        if (callerSignal?.aborted) {
          return yield* Effect.fail(callerSignal.reason);
        }
        return yield* Effect.fail(
          new Error("mcp_list exceeded its deadline."),
        );
      }),
    ),
  );
};

/**
 * A bounded, fixed host facade over the owner's live native-integration
 * catalog. Admission requires both provider safety hints and a versioned
 * Stella-admin review. Raw action schemas and Composio credentials never
 * become AgentTool definitions or Dynamic Worker bindings.
 */
export const createCloudIntegrationTools = (
  context: CloudIntegrationToolContext,
): CloudIntegrationTool[] => {
  let initializedProof: InitializationProof | null = null;
  let initialization: Promise<InitializationProof> | null = null;
  let initializationSignal: AbortSignal | undefined;

  const performInitialization = async (
    toolCallId: string,
    signal?: AbortSignal,
  ): Promise<InitializationProof> => {
    const initializeRequestId = await rpcRequestId(toolCallId, "initialize");
    const result = requireRecordResult(
      await rpc(
        context,
        initializeRequestId,
        "initialize",
        {
          protocolVersion: MCP_PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: { name: "stella-cloud-builder", version: "1" },
        },
        signal,
      ),
    );
    const serverInfo = result.serverInfo;
    if (
      result.protocolVersion !== MCP_PROTOCOL_VERSION ||
      !isRecord(result.capabilities) ||
      !isRecord(serverInfo) ||
      typeof serverInfo.name !== "string" ||
      serverInfo.name.length === 0 ||
      serverInfo.name.length > 256 ||
      typeof serverInfo.version !== "string" ||
      serverInfo.version.length === 0 ||
      serverInfo.version.length > 128
    ) {
      throw new Error(
        "Connected-tool service returned an invalid MCP initialization response.",
      );
    }
    const notification = await postNotification(
      context,
      "notifications/initialized",
      undefined,
      signal,
    );
    const initializeRequestIdSha256 =
      await requestIdSha256(initializeRequestId);
    const serverIdSha256 = await sha256Hex(
      canonicalJson({ name: serverInfo.name, version: serverInfo.version }),
    );
    const initializedNotificationReceiptSha256 = await sha256Hex(
      canonicalJson({
        method: "notifications/initialized",
        initializeRequestIdSha256,
        ...notification,
      }),
    );
    const initializationReceiptSha256 = await sha256Hex(
      canonicalJson({
        initializeRequestIdSha256,
        initializedNotificationReceiptSha256,
        response: result,
      }),
    );
    return {
      protocolVersion: MCP_PROTOCOL_VERSION,
      serverIdSha256,
      initializeRequestIdSha256,
      initializationReceiptSha256,
      initializedNotificationReceiptSha256,
      initializedNotificationSent: true,
    };
  };

  const waitWithAbort = async <T>(
    pending: Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> => {
    if (!signal) return pending;
    signal.throwIfAborted();
    return await new Promise<T>((resolve, reject) => {
      const onAbort = () => reject(signal.reason);
      signal.addEventListener("abort", onAbort, { once: true });
      pending.then(
        (value) => {
          signal.removeEventListener("abort", onAbort);
          resolve(value);
        },
        (error) => {
          signal.removeEventListener("abort", onAbort);
          reject(error);
        },
      );
    });
  };

  const ensureInitialized = async (
    toolCallId: string,
    signal?: AbortSignal,
  ): Promise<InitializationProof> => {
    signal?.throwIfAborted();
    if (initializedProof) return initializedProof;
    if (!initialization) {
      const pending = performInitialization(toolCallId, signal);
      initialization = pending;
      initializationSignal = signal;
      void pending.then(
        (proof) => {
          if (initialization === pending) {
            initializedProof = proof;
            initialization = null;
            initializationSignal = undefined;
          }
        },
        () => {
          if (initialization === pending) {
            initialization = null;
            initializationSignal = undefined;
          }
        },
      );
    }
    const pending = initialization;
    try {
      return await waitWithAbort(pending, signal);
    } catch (error) {
      if (
        signal?.aborted &&
        initialization === pending &&
        initializationSignal === signal
      ) {
        initialization = null;
        initializationSignal = undefined;
      }
      throw error;
    }
  };

  const initializedRpc = async (
    toolCallId: string,
    operation: string,
    method: string,
    params: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<unknown> => {
    await ensureInitialized(toolCallId, signal);
    return rpc(
      context,
      await rpcRequestId(toolCallId, operation),
      method,
      params,
      signal,
    );
  };

  return [
    {
      name: "tool_search",
      label: "Search connected tools",
      description:
        "Search the owner's currently connected native integrations for explicitly reviewed read-only actions. Results contain an exact tool name and policy revision for mcp_describe or mcp_call. Missing, mutating, destructive, provider-only, and unclassified actions are never returned.",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            minLength: 1,
            maxLength: 200,
            description: "What information to read from connected services.",
          },
          limit: {
            type: "integer",
            minimum: 1,
            maximum: 20,
            description: "Maximum results (default 8).",
          },
        },
        required: ["query"],
        additionalProperties: false,
      } as unknown as TSchema,
      codeEligibility: "read_only",
      execute: async (toolCallId, params, signal) => {
        const args = params as { query?: string; limit?: number };
        const query = args.query?.trim() ?? "";
        if (!query || query.length > 200) {
          throw new Error(
            "tool_search needs a query of at most 200 characters.",
          );
        }
        const limit = args.limit ?? 8;
        if (!Number.isInteger(limit) || limit < 1 || limit > 20) {
          throw new Error("tool_search limit must be an integer from 1 to 20.");
        }
        const tools = parseSearchTools(
          await initializedRpc(
            toolCallId,
            "search",
            "stella/tools/search",
            { query, limit },
            signal,
          ),
        ).map((tool) => ({
          name: tool.name,
          ...(tool.integration ? { integration: tool.integration } : {}),
          ...(tool.title ? { title: tool.title } : {}),
          ...(tool.description ? { description: tool.description } : {}),
          revision: tool.revision,
          ...(tool.annotations ? { annotations: tool.annotations } : {}),
        }));
        return {
          content: [
            {
              type: "text",
              text:
                tools.length > 0
                  ? renderedJson(tools)
                  : "No connected read-only tool matched. The service may need to be connected, or its actions may not have both provider safety metadata and Stella review.",
            },
          ],
          details: { count: tools.length },
        };
      },
    },
    {
      name: "mcp_list",
      label: "List connected tools",
      description:
        "Enumerate the owner's complete bounded catalog of currently connected, explicitly reviewed read-only MCP tools. Pagination stays inside the owner- and turn-fenced host bridge. The result exposes stable tool identifiers and hash-only protocol receipts, never schemas, cursors, raw JSON-RPC ids, endpoints, tokens, or account identifiers.",
      parameters: {
        type: "object",
        properties: {
          deadline_ms: {
            type: "integer",
            minimum: 1,
            maximum: MCP_LIST_MAX_DEADLINE_MS,
            description: `Optional enumeration deadline in milliseconds (maximum ${MCP_LIST_MAX_DEADLINE_MS}).`,
          },
        },
        additionalProperties: false,
      } as unknown as TSchema,
      codeEligibility: "read_only",
      execute: async (toolCallId, params, signal) => {
        const deadlineMs =
          (params as { deadline_ms?: number }).deadline_ms ??
          MCP_LIST_MAX_DEADLINE_MS;
        if (
          !Number.isInteger(deadlineMs) ||
          deadlineMs < 1 ||
          deadlineMs > MCP_LIST_MAX_DEADLINE_MS
        ) {
          throw new Error(
            `mcp_list deadline_ms must be an integer from 1 to ${MCP_LIST_MAX_DEADLINE_MS}.`,
          );
        }

        return await runWithDeadline(deadlineMs, signal, async (listSignal) => {
          const initialization = await ensureInitialized(
            toolCallId,
            listSignal,
          );
          const tools: Array<{
            name: string;
            integration?: string;
            revision: string;
            toolIdSha256: string;
          }> = [];
          const seenToolNames = new Set<string>();
          const seenCursors = new Set<string>();
          const toolsListRequestIdSha256s: string[] = [];
          let cursor: string | undefined;
          let pageCount = 0;
          let aggregateResponseBytes = 0;

          for (;;) {
            if (pageCount >= MCP_LIST_MAX_PAGES) {
              throw new Error(
                "Connected-tool service exceeded the tools/list page limit.",
              );
            }
            const requestId = await rpcRequestId(
              toolCallId,
              `list:${pageCount + 1}`,
            );
            const page = parseToolsListPage(
              await rpc(
                context,
                requestId,
                "tools/list",
                cursor === undefined ? {} : { cursor },
                listSignal,
              ),
            );
            pageCount += 1;
            toolsListRequestIdSha256s.push(await requestIdSha256(requestId));
            aggregateResponseBytes += page.bytes;
            if (aggregateResponseBytes > MCP_LIST_MAX_RESPONSE_BYTES) {
              throw new Error(
                "Connected-tool service exceeded the aggregate tools/list byte limit.",
              );
            }
            if (tools.length + page.tools.length > MCP_LIST_MAX_TOOLS) {
              throw new Error(
                "Connected-tool service exceeded the aggregate tools/list item limit.",
              );
            }
            for (const tool of page.tools) {
              if (seenToolNames.has(tool.name)) {
                throw new Error(
                  "Connected-tool service repeated a tools/list tool identifier.",
                );
              }
              seenToolNames.add(tool.name);
              tools.push({
                name: tool.name,
                ...(tool.integration ? { integration: tool.integration } : {}),
                revision: tool.revision,
                toolIdSha256: await toolIdSha256(tool.name, tool.revision),
              });
            }

            if (page.nextCursor === undefined) break;
            if (seenCursors.has(page.nextCursor)) {
              throw new Error(
                "Connected-tool service repeated a tools/list cursor.",
              );
            }
            seenCursors.add(page.nextCursor);
            cursor = page.nextCursor;
          }

          const proof = {
            schemaVersion: 1,
            ...initialization,
            toolsListRequestIdSha256s,
            toolsListPageCount: pageCount,
            toolsListCompleted: true,
            toolCount: tools.length,
            aggregateResponseBytes,
            catalogSha256: await sha256Hex(canonicalJson(tools)),
          } as const;
          const output = canonicalJson({ proof, tools });
          if (utf8Size(output) > MAX_MODEL_RESULT_BYTES) {
            throw new Error(
              "Connected-tool catalog exceeded the mcp_list output byte limit.",
            );
          }
          return {
            content: [
              {
                type: "text",
                text: output,
              },
            ],
            details: proof,
          };
        });
      },
    },
    {
      name: "mcp_describe",
      label: "Describe connected tool",
      description:
        "Load the exact bounded input schema for one read-only connected tool returned by tool_search. The server rechecks owner, connection, lifecycle, migration, and current policy.",
      parameters: {
        type: "object",
        properties: {
          name: {
            type: "string",
            minLength: 1,
            maxLength: 300,
            description: "Exact tool name returned by tool_search.",
          },
        },
        required: ["name"],
        additionalProperties: false,
      } as unknown as TSchema,
      codeEligibility: "read_only",
      execute: async (toolCallId, params, signal) => {
        const name = (params as { name?: string }).name?.trim() ?? "";
        if (!name) throw new Error("mcp_describe needs an exact tool name.");
        await ensureInitialized(toolCallId, signal);
        const describeRequestId = await rpcRequestId(toolCallId, "describe");
        const result = requireRecordResult(
          await rpc(
            context,
            describeRequestId,
            "stella/tools/describe",
            { name },
            signal,
          ),
        );
        const tool = parseListedTool(result.tool);
        const proof = {
          describeRequestIdSha256: await requestIdSha256(describeRequestId),
          toolIdSha256: await toolIdSha256(tool.name, tool.revision),
          describeReceiptSha256: await sha256Hex(canonicalJson(result)),
          describeCompleted: true,
        } as const;
        return {
          content: [
            { type: "text", text: renderedJson(tool.raw) },
            {
              type: "text",
              text: canonicalJson({ stellaMcpProof: proof }),
            },
          ],
          details: { name, proof },
        };
      },
    },
    {
      name: "mcp_call",
      label: "Call connected tool",
      description:
        "Call one explicitly read-only connected tool. Pass the exact name and revision returned by tool_search plus arguments matching mcp_describe. The server revalidates all policy and connection state and stores an exact-replay receipt. Mutating or unknown tools cannot be called here.",
      parameters: {
        type: "object",
        properties: {
          name: {
            type: "string",
            minLength: 1,
            maxLength: 300,
            description: "Exact tool name returned by tool_search.",
          },
          revision: {
            type: "string",
            minLength: 1,
            maxLength: 192,
            description: "Exact policy revision returned by tool_search.",
          },
          arguments: {
            type: "object",
            description: "Arguments matching the schema from mcp_describe.",
            additionalProperties: true,
          },
        },
        required: ["name", "revision", "arguments"],
        additionalProperties: false,
      } as unknown as TSchema,
      codeEligibility: "read_only",
      execute: async (toolCallId, params, signal) => {
        const args = params as {
          name?: string;
          revision?: string;
          arguments?: Record<string, unknown>;
        };
        const name = args.name?.trim() ?? "";
        const revision = args.revision?.trim() ?? "";
        if (!name || !revision || !args.arguments) {
          throw new Error("mcp_call needs name, revision, and arguments.");
        }
        const initialization = await ensureInitialized(toolCallId, signal);
        const callRequestId = await rpcRequestId(toolCallId, "call");
        let rawResult: unknown;
        try {
          rawResult = await rpc(
            context,
            callRequestId,
            "tools/call",
            {
              name,
              arguments: args.arguments,
              _meta: { revision },
            },
            signal,
          );
        } catch (error) {
          if (signal?.aborted) {
            try {
              await postNotification(
                context,
                "notifications/cancelled",
                {
                  requestId: callRequestId,
                  reason: "Code execution canceled",
                },
                undefined,
                [202],
              );
            } catch {
              // The abort remains the caller-visible failure. This notification is
              // best-effort because the original request may already have reached
              // the service and needs its durable receipt fenced when possible.
            }
          }
          throw error;
        }
        const result = requireRecordResult(rawResult);
        const replayed =
          Boolean(result._meta) &&
          typeof result._meta === "object" &&
          (result._meta as { replayed?: unknown }).replayed === true;
        const proof = {
          schemaVersion: 1,
          ...initialization,
          callRequestIdSha256: await requestIdSha256(callRequestId),
          toolIdSha256: await toolIdSha256(name, revision),
          resultReceiptSha256: await sha256Hex(canonicalJson(result)),
          callCompleted: true,
          replayed,
        } as const;
        const content = Array.isArray(result.content) ? result.content : [];
        const firstText = content.find(
          (item): item is { type: "text"; text: string } =>
            Boolean(item) &&
            typeof item === "object" &&
            (item as { type?: unknown }).type === "text" &&
            typeof (item as { text?: unknown }).text === "string",
        );
        return {
          content: [
            {
              type: "text",
              text: firstText?.text
                ? truncateUtf8(
                    firstText.text,
                    MAX_MODEL_RESULT_BYTES,
                    "\n\n[Connected-tool output truncated.]",
                  )
                : renderedJson(result.structuredContent ?? result),
            },
            {
              type: "text",
              text: canonicalJson({ stellaMcpProof: proof }),
            },
          ],
          details: {
            name,
            revision,
            replayed,
            proof,
          },
        };
      },
    },
  ];
};
