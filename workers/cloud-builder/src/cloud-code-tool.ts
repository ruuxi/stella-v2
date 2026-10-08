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
import { CODE_TOOL_HISTORY_SENTENCE } from "@stella/runtime/kernel/tools/defs/code-def.js";
import {
  buildDemotedCodeSuffix,
  describeToolCatalogEntry,
  searchToolCatalog,
  type DemotedToolCatalogEntry,
} from "@stella/runtime/kernel/tools/code-catalog.js";
import { sanitizeToolVisibleText } from "@stella/runtime/kernel/tools/safety.js";
import { AgentToolSuspendedError } from "@stella/runtime/kernel/agent-core/suspension.js";
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
  CLOUD_CODE_BROWSER_INTRINSIC,
  CLOUD_CODE_CONNECT_INTRINSIC,
  CLOUD_CODE_DESCRIBE_INTRINSIC,
  CLOUD_CODE_FS_MAX_FILE_BYTES,
  CLOUD_CODE_HISTORY_INTRINSIC,
  CLOUD_CODE_SEARCH_INTRINSIC,
  CLOUD_CODE_WORLD_INTRINSIC,
  CLOUD_CODE_WORLD_ROOT,
} from "./cloud-code-worker-executor.js";
import { sha256Hex } from "./hash.js";
import type {
  ResidentBrowserClient,
  ResidentBrowserScreenshot,
} from "./resident-browser.js";
import type { ToolReplayPolicy } from "./tool-replay.js";
import type { WorldShellFsRpc } from "./worker-shell/protocol.js";
import type { WorkerShellWorldCommit } from "./worker-shell-runner.js";
import type { WorldListingEntry } from "./world/types.js";
import {
  GENERAL_AGENT_EGRESS_BUDGET_BYTES,
  GENERAL_AGENT_EGRESS_REQUESTS_PER_MINUTE,
} from "./sandbox-egress-policy.js";

const CLOUD_CODE_MODEL_OUTPUT_MAX_BYTES = 50_000;
const CLOUD_CODE_NESTED_RESULT_MAX_BYTES = 128 * 1024;
/** `$describe` documents above this are handed back in lossless chunks. */
const MAX_INLINE_TOOL_DESCRIPTION_CHARS = 96_000;
const TOOL_DESCRIPTION_CHUNK_CHARS = 64_000;
/** Keep a runaway cell from stacking maps down the timeline. */
const MAX_LIFTED_MAPS = 3;
/** Screenshots one code call may hand the model. */
const MAX_LIFTED_SCREENSHOTS = 3;

type LiftedScreenshot = ResidentBrowserScreenshot["image"];

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
 * sandbox per call (no persistent bindings, no cell_id), and no
 * computer-use globals because the cloud has no device. A turn that holds a
 * cloud browser (a resident background agent) also gets the `browser` global
 * over Stella's private Browser Run profile; the orchestrator never does.
 * Neither does it get what a General agent's code reaches (`reach`): `fetch`
 * to the public network and the `fs` global over the owner world.
 */
const cloudCodeToolDescription = (browser: boolean): string =>
  `Run JavaScript with top-level await in Stella's cloud code runtime — a fresh isolated sandbox per call. Call the immutable globals directly: connect, history, tools${browser ? ", and browser" : ""}. End with an expression to return its value; console.log lines come back in a [console] section. Bindings do not persist between calls and there is no cell_id, codeRuntime, or sky${browser ? "" : ", or browser"} in this session, so do the whole computation in one call and return a structured-cloneable value. The sandbox has no network and no secrets of its own; reach the outside world only through tools${browser ? ", connect, and browser" : " and connect"}. ${browser ? `${CLOUD_CODE_BROWSER_SENTENCE} ` : ""}tools exposes allowed Stella tools. Use tools.$list() for exact names/access expressions; non-identifier names require bracket notation such as tools[\"mcp.server/tool\"](...). Use tools.$search({ query: \"<capability>\" }) for ranked signatures, and tools.$describe(name) for a complete unfamiliar schema. Use Promise.all for independent calls. Nested tools retain permissions, cancellation, and route artifacts, and a failing nested call rejects with the tool's own error so you can catch it; tools requiring explicit approval are unavailable inside code and must be called directly. connect is the connector client for the user's connected services (connect.documentation() explains it): discover → actions → schema → call. ` +
  `${CODE_TOOL_HISTORY_SENTENCE} ` +
  `One execution may make at most ${CLOUD_CODE_MAX_TOOL_CALLS} nested tool calls, with at most ${CLOUD_CODE_MAX_CONCURRENT_TOOL_CALLS} running concurrently, and runs for at most ${Math.round(CLOUD_CODE_MAX_TIMEOUT_MS / 1000)} seconds.`;

/**
 * The cloud browser contract, stated in full because it differs from the
 * device's Playwright tabs: every call is one allowlisted gateway command,
 * the profile persists between turns, and sign-in is a human handoff.
 */
const CLOUD_CODE_BROWSER_SENTENCE =
  `browser drives Stella's private cloud browser (one persistent signed-in profile, kept between turns; it is not the user's own browser). Each method is one awaited command. browser.open(url, { allowedOrigins? }) starts at an https URL and limits navigation to its origin plus allowedOrigins. browser.open, navigate(url), observe(), back(), forward(), and reload() return { url, title, text, elements }: text is the page's visible text, and elements lists the visible controls as { ref, role, name, selector?, href?, checked?, disabled?, sensitive? } (sensitive marks password, email, code, and card fields). Selectors are Playwright selectors (CSS, text=, role=, xpath=, chains) or ref=eN from the latest observation; refs change after navigation, so observe again. Actions: click(selector), fill(selector, value), press(selector, key), select(selector, value), check(selector), uncheck(selector), hover(selector), text(selector), wait(selector, timeoutMs?), and scroll({ direction?, amount?, selector? }). browser.evaluate(script, arg?) runs a JavaScript expression, or a function source string called with arg, in the page and returns its JSON result (use it for DOM reads, localStorage, or same-origin fetch with the page's session). browser.cookies(urls?), setCookies(cookies), and clearCookies() manage the profile's cookies. browser.requests({ limit? }) lists recent network requests and responseBody(url) returns one response's body. browser.screenshot({ fullPage? }) attaches a picture to this code call's result (up to ${MAX_LIFTED_SCREENSHOTS} per call). Also tabs(), focusTab(tabId), and close(). For signing in, prefer handing the login to the user: call browser.requestLoginTakeover({ allowedOrigins: [origin], displayOrigin: origin, startUrl?, displayTitle?, verification: { expectedOrigin: origin, authenticatedSelector, loggedOutSelector, resumeUrl } }) with one exact https origin everywhere. loggedOutSelector names something visible now only when signed out; authenticatedSelector names something that appears only once signed in (such as text=Sign out); they must differ and cannot be refs. It hands the login screen to the user on their phone or desktop and pauses this task until they finish: make it the last call in that code cell. Type a password or card number yourself only when the user gave it to you in this conversation. When the task continues, this code call's result says whether sign-in was approved, canceled, or expired; on approval, browser.open the site again and carry on signed in.`;

export const CLOUD_CODE_TOOL_DESCRIPTION = cloudCodeToolDescription(false);

/**
 * A General agent's `code` reaches more than the orchestrator's: the public
 * network through `fetch` and the owner world through `fs`. It is still a
 * fresh isolate per call, and the description says what that means for state.
 */
const agentCloudCodeToolDescription = (
  browser: boolean,
  world: boolean,
): string =>
  `Run JavaScript with top-level await in Stella's cloud code runtime — a fresh isolated sandbox per call. Call the immutable globals directly: ${world ? "fs, " : ""}fetch, connect, history, tools${browser ? ", and browser" : ""}. End with an expression to return its value; console.log lines come back in a [console] section. Bindings do not persist between calls and there is no cell_id, codeRuntime, or sky${browser ? "" : ", or browser"} in this session, so do the whole computation in one call, return a structured-cloneable value, and keep anything a later call needs in a file. There are no Node built-ins, npm packages, child processes, or secrets here; use Bash for those. ${CLOUD_CODE_FETCH_SENTENCE} ${world ? `${CLOUD_CODE_FS_SENTENCE} ` : ""}${browser ? `${CLOUD_CODE_BROWSER_SENTENCE} ` : ""}tools exposes allowed Stella tools. Use tools.$list() for exact names/access expressions; non-identifier names require bracket notation such as tools[\"mcp.server/tool\"](...). Use tools.$search({ query: \"<capability>\" }) for ranked signatures, and tools.$describe(name) for a complete unfamiliar schema. Use Promise.all for independent calls. Nested tools retain permissions, cancellation, and route artifacts, and a failing nested call rejects with the tool's own error so you can catch it; tools requiring explicit approval are unavailable inside code and must be called directly. connect is the connector client for the user's connected services (connect.documentation() explains it): discover → actions → schema → call. ` +
  `${CODE_TOOL_HISTORY_SENTENCE} ` +
  `One execution may make at most ${CLOUD_CODE_MAX_TOOL_CALLS} nested tool calls, with at most ${CLOUD_CODE_MAX_CONCURRENT_TOOL_CALLS} running concurrently, and runs for at most ${Math.round(CLOUD_CODE_MAX_TIMEOUT_MS / 1000)} seconds.`;

const CLOUD_CODE_FETCH_SENTENCE = `fetch(url, init) reaches public http(s) URLs: http is upgraded to https, private and local addresses and URLs that carry a credential are refused, every redirect is checked the same way, and requests share the workspace's egress budget (${GENERAL_AGENT_EGRESS_REQUESTS_PER_MINUTE} a minute, ${Math.round(GENERAL_AGENT_EGRESS_BUDGET_BYTES / (1024 * 1024))} MB downloaded).`;

const CLOUD_CODE_FS_SENTENCE = `fs is the workspace — the same files Read, Write, Bash, and the other tools see — at ${CLOUD_CODE_WORLD_ROOT}, which ~ also names; relative paths resolve from it and nothing outside it is reachable. Every method returns a promise: fs.readFile(path, { encoding? }) returns UTF-8 text, or a base64 string or a Uint8Array with encoding "base64" or "bytes"; fs.writeFile(path, data, { encoding? }) takes a string (UTF-8, or base64 with encoding "base64") or bytes and creates missing parent directories; also fs.appendFile(path, data), fs.readdir(path, { withFileTypes? }), fs.stat(path), fs.lstat(path), fs.exists(path), fs.mkdir(path, { recursive? }), fs.rm(path, { recursive?, force? }), and fs.rename(from, to) and fs.copyFile(from, to) for files. A write is saved to the workspace before its promise resolves, so nested tools and later calls see it; it rejects with EAGAIN and writes nothing when a file this call read has changed since. Files over ${CLOUD_CODE_FS_MAX_FILE_BYTES / (1024 * 1024)} MiB need Bash.`;

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
  /** Recovery policy for an unanswered call of this tool (`tool-replay.ts`). */
  replay?: ToolReplayPolicy;
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

/**
 * Host-side implementation of the sandbox's frozen `history` global: the
 * conversation's own SQLite, plus rows rolled out of it into R2 segments.
 */
export type CloudHistoryClient = Readonly<{
  sql(query: string, params: readonly SqlStorageValue[]): unknown;
  read(fromSeq: number, toSeq: number): Promise<unknown>;
}>;

/**
 * The owner world as an agent's `fs` sees it: the read-only loopback bound
 * into the Worker, and the revision and commit calls only the Durable Object
 * makes. `commitShell` is the worker shell's own check-and-apply.
 */
export type CloudCodeWorld = Readonly<{
  loopback: () => WorldShellFsRpc;
  head: WorkerShellWorldCommit["head"];
  commitShell: WorkerShellWorldCommit["commitShell"];
}>;

/**
 * What a General agent's code reaches beyond the orchestrator's: `network`
 * mints the egress entrypoint every `fetch` goes through, and `world`, when
 * present, gives the cell its `fs` global.
 */
export type CloudCodeAgentReachOptions = Readonly<{
  network: () => Fetcher;
  world?: CloudCodeWorld;
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
  /** Absent means `history.*` rejects with an explanation. */
  history?: CloudHistoryClient;
  /**
   * The turn's cloud browser. Present, the sandbox gets a `browser` global and
   * a login handoff ends the call as `AgentToolSuspendedError`; absent, there
   * is no `browser` at all, as in the cloud orchestrator.
   */
  browser?: ResidentBrowserClient;
  /**
   * A General agent's network and world. Absent, as for the cloud
   * orchestrator, the sandbox has no network and no `fs`.
   */
  reach?: CloudCodeAgentReachOptions;
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
    return await invokeCloudConnect(
      client,
      method,
      Array.isArray(request.args) ? request.args : [],
    );
  };

/**
 * One `connect.<method>(...args)` against a host-side client. Shared by the
 * isolate's intrinsic and the turn broker, which serves the same call for the
 * container's `code`.
 */
export const invokeCloudConnect = async (
  client: CloudConnectClient,
  method: string,
  args: readonly unknown[],
): Promise<unknown> => {
  if (!CONNECT_METHODS.has(method)) {
    throw new Error(`connect.${method || "?"} is not a connect method.`);
  }
  switch (method as ConnectMethod) {
    case "discover":
      return await client.discover(String(args[0] ?? ""));
    case "connectors":
      return await client.connectors();
    case "actions":
      return await client.actions(String(args[0] ?? ""), asRecord(args[1]));
    case "schema":
      return await client.schema(String(args[0] ?? ""), String(args[1] ?? ""));
    case "call":
      return await client.call(
        String(args[0] ?? ""),
        String(args[1] ?? ""),
        asRecord(args[2]),
      );
    case "addMcp":
      return await client.addMcp(asRecord(args[0]));
    case "remove":
      return await client.remove(String(args[0] ?? ""));
  }
};

/** `history.sql(...)` / `history.read(...)` — forwarded to the host. */
const historyIntrinsic =
  (client: CloudHistoryClient | undefined): CloudCodeIntrinsic =>
  async (input) => {
    const request = asRecord(input);
    const args = Array.isArray(request.args) ? request.args : [];
    if (!client) {
      throw new Error("history is unavailable in this session.");
    }
    switch (request.method) {
      case "sql":
        if (typeof args[0] !== "string" || !args[0].trim()) {
          throw new Error("history.sql requires a non-empty query string.");
        }
        if (args[1] !== undefined && !Array.isArray(args[1])) {
          throw new Error("history.sql params must be an array.");
        }
        return client.sql(args[0], (args[1] ?? []) as SqlStorageValue[]);
      case "read":
        if (!Number.isSafeInteger(args[0]) || !Number.isSafeInteger(args[1])) {
          throw new Error("history.read requires integer fromSeq and toSeq.");
        }
        return client.read(args[0] as number, args[1] as number);
      default:
        throw new Error(
          `history.${String(request.method ?? "?")} is not a history method.`,
        );
    }
  };

/** One `fs` write changes at most a file and the path it moved from. */
const WORLD_COMMIT_MAX_PATHS = 16;
const WORLD_COMMIT_MAX_READS = 20_000;
const WORLD_PATH_MAX_LENGTH = 1_024;
const WORLD_SYMLINK_TARGET_MAX_LENGTH = 4_096;
const SHA256_HEX = /^[0-9a-f]{64}$/u;

/**
 * A world-relative path exactly as the store keys it. The empty root is
 * allowed only where a read of it is being reported.
 */
const worldPathOf = (value: unknown, allowRoot = false): string => {
  if (typeof value !== "string") throw new Error("fs: a path is invalid.");
  if (value === "" && allowRoot) return value;
  if (
    value.length === 0 ||
    value.length > WORLD_PATH_MAX_LENGTH ||
    value.startsWith("/") ||
    value
      .split("/")
      .some((segment) => !segment || segment === "." || segment === "..")
  ) {
    throw new Error("fs: a path is invalid.");
  }
  return value;
};

const worldPathsOf = (
  value: unknown,
  max: number,
  allowRoot = false,
): string[] => {
  if (!Array.isArray(value) || value.length > max) {
    throw new Error("fs: a change names too many paths.");
  }
  return value.map((entry) => worldPathOf(entry, allowRoot));
};

const nonNegativeInteger = (value: unknown, max = Number.MAX_SAFE_INTEGER) =>
  Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= max;

/**
 * Generated code can call `$world` directly, not only through `fs`, so every
 * field of a commit is checked here; the store checks the paths, blobs, and
 * quota again when it applies the change.
 */
const worldEntryOf = (value: unknown): WorldListingEntry => {
  const entry = asRecord(value);
  const path = worldPathOf(entry.path);
  if (!nonNegativeInteger(entry.mode, 0o7777)) {
    throw new Error("fs: a file mode is invalid.");
  }
  const mode = entry.mode as number;
  if (entry.kind === "dir") return { path, kind: "dir", mode, size: 0 };
  if (entry.kind === "file") {
    if (
      !nonNegativeInteger(entry.size, CLOUD_CODE_FS_MAX_FILE_BYTES) ||
      typeof entry.sha256 !== "string" ||
      !SHA256_HEX.test(entry.sha256)
    ) {
      throw new Error("fs: a file's content is invalid.");
    }
    return {
      path,
      kind: "file",
      mode,
      size: entry.size as number,
      sha256: entry.sha256,
    };
  }
  if (
    entry.kind === "symlink" &&
    typeof entry.target === "string" &&
    entry.target.length > 0 &&
    entry.target.length <= WORLD_SYMLINK_TARGET_MAX_LENGTH &&
    nonNegativeInteger(entry.size)
  ) {
    return {
      path,
      kind: "symlink",
      mode,
      size: entry.size as number,
      target: entry.target,
    };
  }
  throw new Error("fs: a change entry is invalid.");
};

/**
 * `$world` — the revision an `fs` cell's reads are checked against, and the
 * commit of one write. The commit lands only if nothing the cell read since
 * its last write, nor the path it writes, changed after `baseRevision`; a
 * write made before any read is pinned commits against the current head.
 */
const worldIntrinsic =
  (world: CloudCodeWorld): CloudCodeIntrinsic =>
  async (input) => {
    const request = asRecord(input);
    if (request.op === "head") {
      return { revision: (await world.head()).revision };
    }
    if (request.op !== "commit") {
      throw new Error("$world takes a head or commit operation.");
    }
    const entries = Array.isArray(request.entries)
      ? request.entries.map(worldEntryOf)
      : [];
    const deleted = worldPathsOf(request.deleted, WORLD_COMMIT_MAX_PATHS);
    if (
      entries.length > WORLD_COMMIT_MAX_PATHS ||
      entries.length + deleted.length === 0
    ) {
      throw new Error("fs: a write must change between one and 16 paths.");
    }
    const reads = {
      paths: worldPathsOf(request.reads, WORLD_COMMIT_MAX_READS),
      children: worldPathsOf(request.children, WORLD_COMMIT_MAX_READS, true),
    };
    let baseRevision: number;
    if (request.baseRevision === null || request.baseRevision === undefined) {
      baseRevision = (await world.head()).revision;
    } else if (nonNegativeInteger(request.baseRevision)) {
      baseRevision = request.baseRevision as number;
    } else {
      throw new Error("fs: the base revision is invalid.");
    }
    const outcome = await world.commitShell({
      baseRevision,
      reads,
      entries,
      deleted,
    });
    switch (outcome.status) {
      case "committed":
        return { status: "committed", revision: outcome.revision };
      case "conflict":
        return { status: "conflict", paths: outcome.paths };
      case "missing_blobs":
        return { status: "missing_blobs" };
    }
  };

const isScreenshotResult = (
  value: unknown,
): value is ResidentBrowserScreenshot =>
  Boolean(value) &&
  typeof value === "object" &&
  typeof (value as { image?: { data?: unknown } }).image?.data === "string";

/**
 * `browser.<method>(...)` — forwarded to the turn's cloud browser client. A
 * screenshot is lifted out of the sandbox: the image rides the outer code
 * result as an image block the model sees, and the cell only learns it was
 * taken, which also keeps image bytes off the sandbox value bridge.
 */
const browserIntrinsic =
  (
    client: ResidentBrowserClient,
    screenshots: Map<string, LiftedScreenshot[]>,
  ): CloudCodeIntrinsic =>
  async (input, context) => {
    const request = asRecord(input);
    const method = typeof request.method === "string" ? request.method : "";
    const args = Array.isArray(request.args) ? request.args : [];
    if (method === "screenshot") {
      const sink = screenshots.get(context.executionId);
      if (!sink) throw new Error("browser.screenshot ran outside a code call.");
      if (sink.length >= MAX_LIFTED_SCREENSHOTS) {
        throw new Error(
          `One code call can take at most ${MAX_LIFTED_SCREENSHOTS} screenshots.`,
        );
      }
      const result = await client.call(method, args, context.signal);
      if (!isScreenshotResult(result)) {
        throw new Error("Cloud browser returned an invalid screenshot.");
      }
      sink.push(result.image);
      return {
        screenshot: `attached as image ${sink.length} of this code call's result`,
        width: result.image.width,
        height: result.image.height,
      };
    }
    return await client.call(method, args, context.signal);
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
  const liftedScreenshots = new Map<string, LiftedScreenshot[]>();
  const prepared = await prepareCloudCodeTools(
    sourceTools.map((tool) => definitionForAgentTool(tool, value, liftedMaps)),
  );
  const catalog = sourceTools.map(catalogEntryForTool);
  const demoted = catalog.filter((entry) => entry.demoted !== undefined);
  const intrinsics: Record<string, CloudCodeIntrinsic> = {
    [CLOUD_CODE_SEARCH_INTRINSIC]: searchIntrinsic(catalog),
    [CLOUD_CODE_DESCRIBE_INTRINSIC]: describeIntrinsic(catalog),
    [CLOUD_CODE_CONNECT_INTRINSIC]: connectIntrinsic(options.connect),
    [CLOUD_CODE_HISTORY_INTRINSIC]: historyIntrinsic(options.history),
    ...(options.browser
      ? {
          [CLOUD_CODE_BROWSER_INTRINSIC]: browserIntrinsic(
            options.browser,
            liftedScreenshots,
          ),
        }
      : {}),
    ...(options.reach?.world
      ? { [CLOUD_CODE_WORLD_INTRINSIC]: worldIntrinsic(options.reach.world) }
      : {}),
  };
  const executeCode = options.executeCode ?? executeCloudCode;
  const reach = options.reach;

  return {
    name: CODE_TOOL_NAME,
    label: "Code",
    workingText: "Running code",
    description: `${
      reach
        ? agentCloudCodeToolDescription(
            Boolean(options.browser),
            Boolean(reach.world),
          )
        : cloudCodeToolDescription(Boolean(options.browser))
    }${buildDemotedCodeSuffix(demoted)}`,
    parameters: CLOUD_CODE_PARAMETERS as unknown as TSchema,
    execute: async (toolCallId, params, signal) => {
      const args = params as CloudCodeParameters;
      const executionId = `code:${await sha256Hex(
        `${options.executionScope}\0${toolCallId}`,
      )}`;
      const sink: MapRouteArtifact[] = [];
      liftedMaps.set(executionId, sink);
      const screenshots: LiftedScreenshot[] = [];
      liftedScreenshots.set(executionId, screenshots);
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
          ...(reach
            ? {
                agentReach: {
                  network: reach.network(),
                  ...(reach.world ? { world: reach.world.loopback() } : {}),
                },
              }
            : {}),
        });
      } finally {
        liftedMaps.delete(executionId);
        liftedScreenshots.delete(executionId);
      }
      // A login handoff parked the profile under human control during this
      // cell. Whatever the cell did with the error afterwards, the turn waits
      // for the user; the loop binds this to the outer Code call.
      const suspension = options.browser?.suspension();
      if (suspension) throw new AgentToolSuspendedError(suspension);
      const text = modelTextForResult(result);
      const maps = sink;
      return {
        content: [
          { type: "text", text },
          ...screenshots.map((image) => ({
            type: "image" as const,
            data: image.data,
            mimeType: image.mimeType,
          })),
        ],
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
