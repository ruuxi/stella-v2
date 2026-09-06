import type { TSchema } from "@sinclair/typebox";
import type {
  AgentTool,
  AgentToolResult,
} from "@stella/runtime/kernel/agent-core/types.js";
import type { Value as TypeBoxValue } from "@sinclair/typebox/value";
import {
  CODE_TOOL_NAME,
  LEGACY_NODE_REPL_TOOL_NAME,
  toolRequiresExplicitApproval,
} from "@stella/runtime/kernel/tools/code-tool.js";
import {
  buildDemotedCodeSuffix,
  describeToolCatalogEntry,
  searchToolCatalog,
  type DemotedToolCatalogEntry,
} from "@stella/runtime/kernel/tools/code-catalog.js";
import { sanitizeToolVisibleText } from "@stella/runtime/kernel/tools/safety.js";
import {
  isMapRouteArtifact,
  type MapRouteArtifact,
} from "@stella/contracts/map-artifact";
import {
  boundedJsonPreview,
  cloneBoundedJsonValue,
  truncateUtf8,
  type BoundedJsonLimits,
} from "./cloud-code-bounds.js";
import {
  CLOUD_CODE_MAX_CONCURRENT_TOOL_CALLS,
  CLOUD_CODE_MAX_SOURCE_BYTES,
  CLOUD_CODE_MAX_TIMEOUT_MS,
  CLOUD_CODE_MAX_TOOL_CALLS,
  CloudCodeNestedToolError,
  executeCloudCode,
  prepareCloudCodeTools,
  type CloudCodeExecutionRequest,
  type CloudCodeExecutionResult,
  type CloudCodeIntrinsic,
  type CloudCodeToolDefinition,
} from "./cloud-code-executor.js";
import {
  CLOUD_CODE_CONNECT_INTRINSIC,
  CLOUD_CODE_DESCRIBE_INTRINSIC,
  CLOUD_CODE_SEARCH_INTRINSIC,
} from "./cloud-code-worker-executor.js";
import { sha256Hex } from "./hash.js";

const CLOUD_CODE_MODEL_OUTPUT_MAX_BYTES = 50_000;
const CLOUD_CODE_NESTED_RESULT_MAX_BYTES = 128 * 1024;
/** `$describe` documents above this are handed back in lossless chunks. */
const MAX_INLINE_TOOL_DESCRIPTION_CHARS = 96_000;
const TOOL_DESCRIPTION_CHUNK_CHARS = 64_000;
/** Keep a runaway cell from stacking maps down the timeline. */
const MAX_LIFTED_MAPS = 3;

/**
 * Tools that never appear inside code. Same set the device kernel excludes:
 * code itself (no recursion), its legacy alias, and the parallel dispatcher.
 */
const CODE_EXCLUDED_TOOL_NAMES: ReadonlySet<string> = new Set([
  CODE_TOOL_NAME,
  LEGACY_NODE_REPL_TOOL_NAME,
  "multi_tool_use_parallel",
]);

/**
 * The model-facing contract is the device `code` tool's: the same `tools`
 * proxy (`$list`/`$search`/`$describe`, `tools.<name>(args)`), the same
 * `connect` client, the same demoted-tool catalog suffix. Only the runtime
 * differs, and the differences are stated rather than hidden: a fresh
 * sandbox per call (no persistent bindings, no cell_id), and no browser or
 * computer-use globals because the cloud orchestrator has no device.
 */
export const CLOUD_CODE_TOOL_DESCRIPTION =
  "Run JavaScript with top-level await in Stella's cloud code runtime — a fresh isolated sandbox per call. Call the immutable globals directly: connect and tools. End with an expression to return its value; console.log lines come back in a [console] section. Bindings do not persist between calls and there is no cell_id, codeRuntime, sky, or browser in this session, so do the whole computation in one call and return a structured-cloneable value. The sandbox has no network and no secrets of its own; reach the outside world only through tools and connect. tools exposes allowed Stella tools. Use tools.$list() for exact names/access expressions; non-identifier names require bracket notation such as tools[\"mcp.server/tool\"](...). Use tools.$search({ query: \"<capability>\" }) for ranked signatures, and tools.$describe(name) for a complete unfamiliar schema. Use Promise.all for independent calls. Nested tools retain permissions, cancellation, and route artifacts, and a failing nested call rejects with the tool's own error so you can catch it; tools requiring explicit approval are unavailable inside code and must be called directly. connect is the connector client for the user's connected services (connect.documentation() explains it): discover → actions → schema → call. " +
  `One execution may make at most ${CLOUD_CODE_MAX_TOOL_CALLS} nested tool calls, with at most ${CLOUD_CODE_MAX_CONCURRENT_TOOL_CALLS} running concurrently, and runs for at most ${Math.round(CLOUD_CODE_MAX_TIMEOUT_MS / 1000)} seconds.`;

const CLOUD_CODE_PARAMETERS = {
  type: "object",
  properties: {
    code: {
      type: "string",
      minLength: 1,
      maxLength: CLOUD_CODE_MAX_SOURCE_BYTES,
      description: "JavaScript to evaluate with top-level await.",
    },
    timeout_ms: {
      type: "integer",
      minimum: 1,
      maximum: CLOUD_CODE_MAX_TIMEOUT_MS,
      description: "Optional evaluation timeout in milliseconds.",
    },
  },
  required: ["code"],
  additionalProperties: false,
} as const;

type CloudCodeParameters = Readonly<{
  code: string;
  timeout_ms?: number;
}>;

/** Agent tools may carry source metadata not represented by the core Tool type. */
export type CloudCodeSourceAgentTool = AgentTool & {
  approval?: unknown;
  outputSchema?: TSchema;
  workingText?: string;
  /**
   * Same semantics as the device catalog: a demoted tool leaves the direct
   * list whenever code is available and is callable only as
   * `tools.<name>(args)`; `$search` ranks it by these extra terms.
   */
  demoted?: {
    searchTerms?: readonly string[];
    requiredConnectorProvider?: string;
  };
};

/** Host-side implementation of the sandbox's frozen `connect` global. */
export type CloudConnectClient = Readonly<{
  discover(query: string): Promise<unknown>;
  connectors(): Promise<unknown>;
  actions(
    id: string,
    options: Readonly<{ query?: string; limit?: number }>,
  ): Promise<unknown>;
  schema(id: string, action: string): Promise<unknown>;
  call(
    id: string,
    action: string,
    args: Readonly<Record<string, unknown>>,
  ): Promise<unknown>;
  addMcp(options: Readonly<Record<string, unknown>>): Promise<unknown>;
  remove(id: string): Promise<unknown>;
}>;

export type CloudCodeExecute = (
  request: CloudCodeExecutionRequest,
) => Promise<CloudCodeExecutionResult>;

export type CreateCloudCodeAgentToolOptions = Readonly<{
  loader: WorkerLoader;
  tools: readonly CloudCodeSourceAgentTool[];
  /** Stable owner-generation + conversation + turn identity. */
  executionScope: string;
  /** Absent means `connect.*` rejects with an explanation. */
  connect?: CloudConnectClient;
  /** Test seam; production always uses the official Dynamic Worker executor. */
  executeCode?: CloudCodeExecute;
}>;

const NESTED_RESULT_LIMITS: BoundedJsonLimits = Object.freeze({
  maxBytes: CLOUD_CODE_NESTED_RESULT_MAX_BYTES,
  maxDepth: 16,
  maxNodes: 4_096,
  maxEntries: 4_096,
  maxStringBytes: CLOUD_CODE_NESTED_RESULT_MAX_BYTES,
});

/**
 * Whether a tool is reachable as `tools.<name>` inside code. The device
 * rule: every allowed tool except code's own family and anything that
 * needs an explicit top-level approval flow.
 */
export const isCloudCodeReachableTool = (
  tool: Pick<CloudCodeSourceAgentTool, "name" | "approval">,
): boolean =>
  !CODE_EXCLUDED_TOOL_NAMES.has(tool.name) &&
  !tool.name.startsWith("$") &&
  !toolRequiresExplicitApproval(tool.approval);

const modelTextForResult = (result: CloudCodeExecutionResult): string => {
  const sections: string[] = [];
  if (result.ok) {
    sections.push(
      boundedJsonPreview(result.result, CLOUD_CODE_MODEL_OUTPUT_MAX_BYTES),
    );
  } else {
    sections.push(`Error (${result.code}): ${result.error}`);
  }
  if (result.logs && result.logs.length > 0) {
    sections.push(`[console]\n${result.logs.join("\n")}`);
  }
  return truncateUtf8(
    sanitizeToolVisibleText(sections.filter(Boolean).join("\n\n")),
    CLOUD_CODE_MODEL_OUTPUT_MAX_BYTES,
  );
};

const textOfContent = (
  content: AgentToolResult<unknown>["content"],
): string | null => {
  if (content.length === 1 && content[0]?.type === "text") {
    return content[0].text;
  }
  const texts = content.flatMap((block) =>
    block.type === "text" ? [block.text] : [],
  );
  return texts.length === content.length && texts.length > 0
    ? texts.join("\n")
    : null;
};

/**
 * What `await tools.<name>(args)` resolves to: the tool's model-visible
 * text (the device REPL hands back the tool's result value the same way),
 * or its content blocks when they are not all text.
 */
const nestedValueForCode = (
  rawName: string,
  result: AgentToolResult<unknown>,
): unknown => {
  if (result.isError) {
    throw new CloudCodeNestedToolError(
      textOfContent(result.content) ?? `Nested tool "${rawName}" failed.`,
    );
  }
  const text = textOfContent(result.content);
  const value = cloneBoundedJsonValue(
    text ?? { content: result.content },
    NESTED_RESULT_LIMITS,
  );
  if (!value.ok) {
    throw new CloudCodeNestedToolError(
      `Nested tool "${rawName}" returned too much data.`,
    );
  }
  return value.value;
};

const collectLiftedMaps = (
  details: unknown,
  sink: MapRouteArtifact[],
): void => {
  if (!details || typeof details !== "object" || Array.isArray(details)) return;
  const record = details as Record<string, unknown>;
  const candidates = Array.isArray(record.maps) ? record.maps : [record.map];
  for (const candidate of candidates) {
    if (sink.length >= MAX_LIFTED_MAPS) return;
    if (isMapRouteArtifact(candidate)) sink.push(candidate);
  }
};

/**
 * TypeBox's `Value.Check` validates without code generation, which is what
 * makes it usable inside workerd: Workers forbid `new Function`, so an
 * Ajv-compiled validator can never run here. The module is loaded lazily,
 * only once a turn actually builds the Code tool, so it stays off the
 * Durable Object's startup path.
 */
type TypeBoxValueModule = typeof TypeBoxValue;

let typeBoxValuePromise: Promise<TypeBoxValueModule> | undefined;

const loadTypeBoxValue = (): Promise<TypeBoxValueModule> =>
  (typeBoxValuePromise ??= import("@sinclair/typebox/value").then(
    (module) => module.Value,
  ));

const definitionForAgentTool = (
  tool: CloudCodeSourceAgentTool,
  value: TypeBoxValueModule,
  liftedMaps: Map<string, MapRouteArtifact[]>,
): CloudCodeToolDefinition => ({
  rawName: tool.name,
  description: tool.description,
  inputSchema: tool.parameters,
  ...(tool.outputSchema ? { outputSchema: tool.outputSchema } : {}),
  approval: toolRequiresExplicitApproval(tool.approval)
    ? "required"
    : "not_required",
  execute: async (input, context) => {
    // TypeBox schemas can be checked without eval in workerd. Some discovered
    // MCP sources provide plain JSON Schema instead; those tools retain their
    // own host-side validation rather than compiling untrusted schemas with
    // Ajv/new Function in the Worker.
    if (
      Object.getOwnPropertySymbols(tool.parameters).includes(
        Symbol.for("TypeBox.Kind"),
      ) &&
      !value.Check(tool.parameters, input)
    ) {
      throw new CloudCodeNestedToolError(
        `Nested tool "${tool.name}" received invalid arguments.`,
      );
    }
    const result = await tool.execute(
      context.toolCallId,
      input as Record<string, unknown>,
      context.signal,
    );
    // Route artifacts a nested call produced (a `map` card) ride the outer
    // code result so the chat renders them exactly as a direct call would.
    // Keyed by execution: parallel code calls must not mix their cards.
    const sink = liftedMaps.get(context.executionId);
    if (sink) collectLiftedMaps(result.details, sink);
    return nestedValueForCode(tool.name, result);
  },
});

const catalogEntryForTool = (
  tool: CloudCodeSourceAgentTool,
): DemotedToolCatalogEntry & {
  description: string;
  parameters: Record<string, unknown>;
} => ({
  name: tool.name,
  description: tool.description,
  parameters: tool.parameters as unknown as Record<string, unknown>,
  ...(tool.outputSchema
    ? { outputSchema: tool.outputSchema as unknown as Record<string, unknown> }
    : {}),
  ...(tool.approval !== undefined ? { approval: tool.approval } : {}),
  ...(tool.label ? { label: tool.label } : {}),
  ...(tool.workingText ? { workingText: tool.workingText } : {}),
  ...(tool.demoted ? { demoted: tool.demoted } : {}),
});

const asRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

/** `tools.$search` — the device scorer over this turn's reachable catalog. */
const searchIntrinsic =
  (catalog: readonly DemotedToolCatalogEntry[]): CloudCodeIntrinsic =>
  async (input) => {
    const args = asRecord(input);
    const query = typeof args.query === "string" ? args.query : "";
    if (!query.trim()) {
      throw new Error("tools.$search requires a non-empty query string.");
    }
    const limit = typeof args.limit === "number" ? args.limit : undefined;
    return searchToolCatalog(catalog, query, limit);
  };

/** `tools.$describe` — lossless docs for one exact reachable tool. */
const describeIntrinsic =
  (
    catalog: readonly (DemotedToolCatalogEntry & {
      description: string;
      parameters: Record<string, unknown>;
    })[],
  ): CloudCodeIntrinsic =>
  async (input) => {
    const args = asRecord(input);
    const name = typeof args.name === "string" ? args.name.trim() : "";
    const tool = catalog.find((entry) => entry.name === name);
    if (!tool) {
      throw new Error(
        `Tool "${name}" is unknown or not available to describe in this context.`,
      );
    }
    const description = describeToolCatalogEntry(tool);
    const serialized = JSON.stringify(description);
    const cursor = typeof args.cursor === "number" ? args.cursor : undefined;
    if (serialized.length <= MAX_INLINE_TOOL_DESCRIPTION_CHARS) {
      if (cursor !== undefined && cursor !== 0) {
        throw new Error(
          `Tool "${name}" does not have another description page.`,
        );
      }
      return description;
    }
    const start = cursor ?? 0;
    if (start >= serialized.length) {
      throw new Error(
        `Tool "${name}" description cursor is past the end of the document.`,
      );
    }
    let end = Math.min(serialized.length, start + TOOL_DESCRIPTION_CHUNK_CHARS);
    if (end < serialized.length && /[\uD800-\uDBFF]/.test(serialized.charAt(end - 1))) {
      end -= 1;
    }
    const nextCursor = end < serialized.length ? end : undefined;
    return {
      name,
      complete: nextCursor === undefined,
      format: "lossless-json-chunks",
      totalChars: serialized.length,
      totalBytes: new TextEncoder().encode(serialized).byteLength,
      sha256: await sha256Hex(serialized),
      cursor: start,
      chunk: serialized.slice(start, end),
      ...(nextCursor !== undefined ? { nextCursor } : {}),
      instruction:
        "Concatenate chunk values in cursor order, requesting each nextCursor with await tools.$describe(name, { cursor: nextCursor }), then JSON.parse the exact combined string. No schema fields were clipped.",
    };
  };

type ConnectMethod = keyof CloudConnectClient;

const CONNECT_METHODS: ReadonlySet<string> = new Set<ConnectMethod>([
  "discover",
  "connectors",
  "actions",
  "schema",
  "call",
  "addMcp",
  "remove",
]);

/** `connect.<method>(...)` — forwarded to the host-side connect client. */
const connectIntrinsic =
  (client: CloudConnectClient | undefined): CloudCodeIntrinsic =>
  async (input) => {
    const request = asRecord(input);
    const method = typeof request.method === "string" ? request.method : "";
    if (!CONNECT_METHODS.has(method)) {
      throw new Error(`connect.${method || "?"} is not a connect method.`);
    }
    if (!client) {
      throw new Error(
        "connect is unavailable in this session: connected services could not be reached.",
      );
    }
    const args = Array.isArray(request.args) ? request.args : [];
    switch (method as ConnectMethod) {
      case "discover":
        return client.discover(String(args[0] ?? ""));
      case "connectors":
        return client.connectors();
      case "actions":
        return client.actions(String(args[0] ?? ""), asRecord(args[1]));
      case "schema":
        return client.schema(String(args[0] ?? ""), String(args[1] ?? ""));
      case "call":
        return client.call(
          String(args[0] ?? ""),
          String(args[1] ?? ""),
          asRecord(args[2]),
        );
      case "addMcp":
        return client.addMcp(asRecord(args[0]));
      case "remove":
        return client.remove(String(args[0] ?? ""));
    }
  };

/**
 * Adapt the exact live AgentTool array — including discovered/MCP-style
 * names — into the cloud sandbox without putting host bindings or
 * credentials in generated code. The model reads the device `code` contract.
 */
export const createCloudCodeAgentTool = async (
  options: CreateCloudCodeAgentToolOptions,
): Promise<AgentTool> => {
  const sourceTools = options.tools.filter(isCloudCodeReachableTool);
  const value = await loadTypeBoxValue();
  const liftedMaps = new Map<string, MapRouteArtifact[]>();
  const prepared = await prepareCloudCodeTools(
    sourceTools.map((tool) => definitionForAgentTool(tool, value, liftedMaps)),
  );
  const catalog = sourceTools.map(catalogEntryForTool);
  const demoted = catalog.filter((entry) => entry.demoted !== undefined);
  const intrinsics: Record<string, CloudCodeIntrinsic> = {
    [CLOUD_CODE_SEARCH_INTRINSIC]: searchIntrinsic(catalog),
    [CLOUD_CODE_DESCRIBE_INTRINSIC]: describeIntrinsic(catalog),
    [CLOUD_CODE_CONNECT_INTRINSIC]: connectIntrinsic(options.connect),
  };
  const executeCode = options.executeCode ?? executeCloudCode;

  return {
    name: CODE_TOOL_NAME,
    label: "Code",
    workingText: "Running code",
    description: `${CLOUD_CODE_TOOL_DESCRIPTION}${buildDemotedCodeSuffix(demoted)}`,
    parameters: CLOUD_CODE_PARAMETERS as unknown as TSchema,
    execute: async (toolCallId, params, signal) => {
      const args = params as CloudCodeParameters;
      const executionId = `code:${await sha256Hex(
        `${options.executionScope}\0${toolCallId}`,
      )}`;
      const sink: MapRouteArtifact[] = [];
      liftedMaps.set(executionId, sink);
      let result: CloudCodeExecutionResult;
      try {
        result = await executeCode({
          loader: options.loader,
          code: args.code,
          tools: prepared,
          executionId,
          intrinsics,
          ...(args.timeout_ms === undefined
            ? {}
            : { timeoutMs: args.timeout_ms }),
          ...(signal ? { signal } : {}),
        });
      } finally {
        liftedMaps.delete(executionId);
      }
      const text = modelTextForResult(result);
      const maps = sink;
      return {
        content: [{ type: "text", text }],
        details: {
          code: result.ok
            ? { ok: true, output: text, toolCallId }
            : {
                ok: false,
                code: result.code,
                error: result.error,
                ...(result.tool ? { tool: result.tool } : {}),
                ...(result.cleanup ? { cleanup: result.cleanup } : {}),
                toolCallId,
              },
          ...(maps.length > 0 ? { maps } : {}),
        },
        isError: !result.ok,
      };
    },
  };
};
