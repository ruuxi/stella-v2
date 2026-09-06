import type {
  ExecuteResult,
  Executor,
  ResolvedProvider,
  ToolDispatcher,
} from "@cloudflare/codemode";

import { CONNECT_DOCUMENTATION } from "@stella/runtime/kernel/connectors/connect-documentation.js";

type CloudflareCodeModeModule = typeof import("@cloudflare/codemode");

/**
 * Reserved sandbox intrinsics dispatched through the same RPC bridge as
 * tools. `$`-prefixed names are never real tools (the device kernel reserves
 * them too), so the child can route them without a second dispatcher.
 */
export const CLOUD_CODE_SEARCH_INTRINSIC = "$search";
export const CLOUD_CODE_DESCRIBE_INTRINSIC = "$describe";
export const CLOUD_CODE_CONNECT_INTRINSIC = "$connect";
export const CLOUD_CODE_INTRINSIC_NAMES: ReadonlySet<string> = new Set([
  CLOUD_CODE_SEARCH_INTRINSIC,
  CLOUD_CODE_DESCRIBE_INTRINSIC,
  CLOUD_CODE_CONNECT_INTRINSIC,
]);

let cloudflareCodeModePromise: Promise<CloudflareCodeModeModule> | undefined;

/** Load the Code Mode SDK once, only after a turn needs the Code tool. */
export const loadCloudflareCodeMode = (): Promise<CloudflareCodeModeModule> =>
  (cloudflareCodeModePromise ??= import("@cloudflare/codemode"));

export const CLOUD_CODE_WORKER_VALUE_MAX_BYTES = 128 * 1024;
export const CLOUD_CODE_WORKER_MAX_VALUE_DEPTH = 16;
export const CLOUD_CODE_WORKER_MAX_VALUE_NODES = 4_096;
export const CLOUD_CODE_WORKER_MAX_VALUE_ENTRIES = 4_096;
export const CLOUD_CODE_WORKER_MAX_STRING_BYTES = 128 * 1024;

const WORKER_MAX_LOG_LINES = 100;
const WORKER_MAX_LOG_LINE_BYTES = 4_000;
const WORKER_MAX_LOG_TOTAL_BYTES = 100_000;
const RESOURCE_LIMIT_MARKER = "__STELLA_CLOUD_CODE_RESOURCE_LIMIT__";

export type StellaWorkerCleanupStatus =
  | "disposed"
  | "dispose_failed"
  | "executor_dispose_unavailable";

export interface StellaDisposableExecutor extends Executor {
  dispose?: () =>
    | StellaWorkerCleanupStatus
    | Promise<StellaWorkerCleanupStatus | void>
    | void;
}

type CodeEntrypoint = Readonly<{
  evaluate: (
    dispatchers: Record<string, ToolDispatcher>,
  ) => Promise<ExecuteResult>;
}>;

const CHILD_RUNTIME = String.raw`
const __RESOURCE_LIMIT = "${RESOURCE_LIMIT_MARKER}";
const __MAX_VALUE_BYTES = ${CLOUD_CODE_WORKER_VALUE_MAX_BYTES};
const __MAX_VALUE_DEPTH = ${CLOUD_CODE_WORKER_MAX_VALUE_DEPTH};
const __MAX_VALUE_NODES = ${CLOUD_CODE_WORKER_MAX_VALUE_NODES};
const __MAX_VALUE_ENTRIES = ${CLOUD_CODE_WORKER_MAX_VALUE_ENTRIES};
const __MAX_STRING_BYTES = ${CLOUD_CODE_WORKER_MAX_STRING_BYTES};
const __MAX_LOG_LINES = ${WORKER_MAX_LOG_LINES};
const __MAX_LOG_LINE_BYTES = ${WORKER_MAX_LOG_LINE_BYTES};
const __MAX_LOG_TOTAL_BYTES = ${WORKER_MAX_LOG_TOTAL_BYTES};

function __byteWidth(text, index) {
  const code = text.charCodeAt(index);
  if (code <= 0x7f) return [1, 1];
  if (code <= 0x7ff) return [2, 1];
  if (code >= 0xd800 && code <= 0xdbff) {
    const next = text.charCodeAt(index + 1);
    if (next >= 0xdc00 && next <= 0xdfff) return [4, 2];
  }
  return [3, 1];
}

function __utf8Bytes(text, max = Number.MAX_SAFE_INTEGER) {
  let bytes = 0;
  for (let index = 0; index < text.length;) {
    const [width, consumed] = __byteWidth(text, index);
    bytes += width;
    if (bytes > max) return max + 1;
    index += consumed;
  }
  return bytes;
}

function __utf8Prefix(text, maxBytes) {
  let bytes = 0;
  let index = 0;
  while (index < text.length) {
    const [width, consumed] = __byteWidth(text, index);
    if (bytes + width > maxBytes) break;
    bytes += width;
    index += consumed;
  }
  return index === text.length ? text : text.slice(0, index);
}

function __jsonStringBytes(text, max) {
  let bytes = 2;
  for (let index = 0; index < text.length;) {
    const code = text.charCodeAt(index);
    let width;
    let consumed = 1;
    if (code === 0x22 || code === 0x5c) width = 2;
    else if (code <= 0x1f) width = 6;
    else if (code >= 0xd800 && code <= 0xdbff) {
      const next = text.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        width = 4;
        consumed = 2;
      } else width = 6;
    } else if (code >= 0xdc00 && code <= 0xdfff) width = 6;
    else [width] = __byteWidth(text, index);
    bytes += width;
    if (bytes > max) return max + 1;
    index += consumed;
  }
  return bytes;
}

function __resourceLimit(detail) {
  throw new Error(__RESOURCE_LIMIT + ":" + detail);
}

function __cloneBoundedJson(root, label) {
  const state = {
    bytes: 0,
    nodes: 0,
    entries: 0,
    ancestors: new WeakSet(),
  };
  const add = (count) => {
    state.bytes += count;
    if (state.bytes > __MAX_VALUE_BYTES) __resourceLimit(label + " bytes");
  };
  const copy = (value, depth) => {
    state.nodes += 1;
    if (state.nodes > __MAX_VALUE_NODES) __resourceLimit(label + " nodes");
    if (depth > __MAX_VALUE_DEPTH) __resourceLimit(label + " depth");
    if (value === null) {
      add(4);
      return null;
    }
    if (typeof value === "string") {
      if (__utf8Bytes(value, __MAX_STRING_BYTES) > __MAX_STRING_BYTES) {
        __resourceLimit(label + " string");
      }
      const remaining = Math.max(0, __MAX_VALUE_BYTES - state.bytes);
      const bytes = __jsonStringBytes(value, remaining);
      if (bytes > remaining) __resourceLimit(label + " bytes");
      state.bytes += bytes;
      return value;
    }
    if (typeof value === "boolean") {
      add(value ? 4 : 5);
      return value;
    }
    if (typeof value === "number") {
      const normalized = Number.isFinite(value) ? value : null;
      add(normalized === null ? 4 : String(normalized).length);
      return normalized;
    }
    if (typeof value !== "object" || value === null) {
      __resourceLimit(label + " unsupported value");
    }
    if (state.ancestors.has(value)) __resourceLimit(label + " cycle");
    state.ancestors.add(value);
    try {
      if (Array.isArray(value)) {
        if (value.length > __MAX_VALUE_ENTRIES - state.entries) {
          __resourceLimit(label + " entries");
        }
        state.entries += value.length;
        add(2 + Math.max(0, value.length - 1));
        const output = new Array(value.length);
        for (let index = 0; index < value.length; index += 1) {
          const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
          if (descriptor && !("value" in descriptor)) {
            __resourceLimit(label + " accessor");
          }
          output[index] = copy(descriptor ? descriptor.value : null, depth + 1);
        }
        return output;
      }
      const prototype = Object.getPrototypeOf(value);
      if (prototype !== Object.prototype && prototype !== null) {
        __resourceLimit(label + " prototype");
      }
      add(2);
      const output = {};
      let first = true;
      for (const key in value) {
        if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
        state.entries += 1;
        if (state.entries > __MAX_VALUE_ENTRIES) __resourceLimit(label + " entries");
        if (__utf8Bytes(key, __MAX_STRING_BYTES) > __MAX_STRING_BYTES) {
          __resourceLimit(label + " key");
        }
        const remaining = Math.max(0, __MAX_VALUE_BYTES - state.bytes);
        const keyBytes = __jsonStringBytes(key, remaining);
        if (keyBytes > remaining) __resourceLimit(label + " bytes");
        add(keyBytes + 1 + (first ? 0 : 1));
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (!descriptor || !("value" in descriptor)) __resourceLimit(label + " accessor");
        const nested = copy(descriptor.value, depth + 1);
        Object.defineProperty(output, key, {
          value: nested,
          enumerable: true,
          configurable: true,
          writable: true,
        });
        first = false;
      }
      return output;
    } finally {
      state.ancestors.delete(value);
    }
  };
  return copy(root, 0);
}

function __safeLogValue(value) {
  if (typeof value === "string") return __utf8Prefix(value, __MAX_LOG_LINE_BYTES);
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "null";
  if (typeof value === "boolean" || typeof value === "undefined") return String(value);
  if (typeof value === "bigint") return "[bigint]";
  if (typeof value === "symbol") return "[symbol]";
  if (typeof value === "function") return "[function]";
  if (value === null) return "null";
  return Array.isArray(value) ? "[Array]" : "[Object]";
}

function __errorMessage(error) {
  if (error && typeof error === "object") {
    const descriptor = Object.getOwnPropertyDescriptor(error, "message");
    if (descriptor && "value" in descriptor && typeof descriptor.value === "string") {
      return __utf8Prefix(descriptor.value, __MAX_LOG_LINE_BYTES);
    }
  }
  return "Cloud code execution failed.";
}
`;

const buildWorkerModule = (
  normalizedCode: string,
  timeoutMs: number,
  toolNames: readonly string[],
): string =>
  [
    'import { WorkerEntrypoint } from "cloudflare:workers";',
    CHILD_RUNTIME,
    "export default class StellaCodeExecutor extends WorkerEntrypoint {",
    "  async evaluate(__dispatchers = {}) {",
    "    const __logs = [];",
    "    let __logBytes = 0;",
    "    const __pushLog = (prefix, args) => {",
    "      if (__logs.length >= __MAX_LOG_LINES || __logBytes >= __MAX_LOG_TOTAL_BYTES) return;",
    "      let line = prefix;",
    "      const count = Math.min(args.length, 32);",
    "      for (let index = 0; index < count; index += 1) {",
    '        const separator = line ? " " : "";',
    "        const remaining = Math.min(__MAX_LOG_LINE_BYTES, __MAX_LOG_TOTAL_BYTES - __logBytes) - __utf8Bytes(line);",
    "        if (remaining <= 0) break;",
    "        const piece = separator + __safeLogValue(args[index]);",
    "        line += __utf8Prefix(piece, remaining);",
    "      }",
    "      const bytes = __utf8Bytes(line, __MAX_LOG_LINE_BYTES);",
    "      if (bytes <= 0) return;",
    "      __logs.push(line);",
    "      __logBytes += bytes;",
    "    };",
    '    console.log = (...args) => __pushLog("", args);',
    '    console.warn = (...args) => __pushLog("[warn]", args);',
    '    console.error = (...args) => __pushLog("[error]", args);',
    `    const __TOOL_NAMES = ${JSON.stringify(toolNames)};`,
    `    const __CONNECT_DOCUMENTATION = ${JSON.stringify(CONNECT_DOCUMENTATION)};`,
    "    const __IDENTIFIER_RE = /^[A-Za-z_$][A-Za-z0-9_$]*$/;",
    "    // The deadline measures code time only: it pauses while a host call is",
    "    // in flight (a connect card waiting on the user, an image job, a",
    "    // connector action), the way a device REPL cell yields around long",
    "    // tool calls. The host mirrors this on its own clock.",
    `    let __remainingMs = ${timeoutMs};`,
    "    let __timer = null;",
    "    let __timerStartedAt = 0;",
    "    let __inflight = 0;",
    "    let __rejectTimeout = () => {};",
    "    const __timeoutPromise = new Promise((_, reject) => { __rejectTimeout = reject; });",
    "    const __startClock = () => {",
    "      if (__timer !== null) return;",
    "      __timerStartedAt = Date.now();",
    '      __timer = setTimeout(() => __rejectTimeout(new Error("Execution timed out")), __remainingMs);',
    "    };",
    "    const __pauseClock = () => {",
    "      if (__timer === null) return;",
    "      clearTimeout(__timer);",
    "      __timer = null;",
    "      __remainingMs = Math.max(1, __remainingMs - (Date.now() - __timerStartedAt));",
    "    };",
    "    const __dispatch = async (name, args) => {",
    '      const safeArgs = __cloneBoundedJson(args, "tool input");',
    "      const argsJson = JSON.stringify(safeArgs);",
    "      __inflight += 1;",
    "      if (__inflight === 1) __pauseClock();",
    "      let responseJson;",
    "      try {",
    "        responseJson = await __dispatchers.codemode.call(name, argsJson);",
    "      } finally {",
    "        __inflight -= 1;",
    "        if (__inflight === 0) __startClock();",
    "      }",
    '      if (typeof responseJson !== "string" || __utf8Bytes(responseJson, __MAX_VALUE_BYTES + 4096) > __MAX_VALUE_BYTES + 4096) {',
    '        __resourceLimit("tool result envelope");',
    "      }",
    "      const data = JSON.parse(responseJson);",
    '      if (data && typeof data.error === "string") throw new Error(__utf8Prefix(data.error, __MAX_LOG_LINE_BYTES));',
    '      return __cloneBoundedJson(data ? data.result : undefined, "tool result");',
    "    };",
    "    const __toolFunctions = new Map();",
    "    for (const __name of __TOOL_NAMES) {",
    "      __toolFunctions.set(__name, Object.freeze((args = {}) => __dispatch(__name, [args])));",
    "    }",
    '    const __searchTool = Object.freeze((args = {}) => __dispatch("$search", [args]));',
    "    const __describeTool = Object.freeze((name, options = {}) => {",
    '      if (typeof name !== "string" || name.trim().length === 0) {',
    '        return Promise.reject(new Error("tools.$describe requires an exact non-empty tool name string."));',
    "      }",
    '      if (!options || typeof options !== "object" || Array.isArray(options)) {',
    '        return Promise.reject(new Error("tools.$describe options must be an object when provided."));',
    "      }",
    '      return __dispatch("$describe", [{ ...options, name }]);',
    "    });",
    "    const __listTools = Object.freeze(() =>",
    "      [...__TOOL_NAMES].sort().map((name) =>",
    "        Object.freeze({",
    "          name,",
    '          access: __IDENTIFIER_RE.test(name) ? "tools." + name : "tools[" + JSON.stringify(name) + "]",',
    "          dotNotation: __IDENTIFIER_RE.test(name),",
    "        }),",
    "      ),",
    "    );",
    "    const __lookupTool = (property) =>",
    '      property === "$search" ? __searchTool',
    '        : property === "$describe" ? __describeTool',
    '          : property === "$list" ? __listTools',
    '            : typeof property === "string" ? __toolFunctions.get(property)',
    "              : undefined;",
    "    const tools = new Proxy(Object.create(null), {",
    "      get: (_target, property) => __lookupTool(property),",
    "      has: (_target, property) => __lookupTool(property) !== undefined,",
    '      ownKeys: () => ["$search", "$describe", "$list", ...__TOOL_NAMES],',
    "      getOwnPropertyDescriptor: (_target, property) => {",
    "        const value = __lookupTool(property);",
    "        if (value === undefined) return undefined;",
    "        return { value, enumerable: true, writable: false, configurable: true };",
    "      },",
    "      set: () => false,",
    "      defineProperty: () => false,",
    "      deleteProperty: () => false,",
    "      setPrototypeOf: () => false,",
    "    });",
    "    const __requireNonEmptyString = (value, name) => {",
    '      if (typeof value !== "string" || !value.trim()) {',
    '        throw new TypeError("connect: " + name + " must be a non-empty string.");',
    "      }",
    "      return value.trim();",
    "    };",
    "    const __requirePlainObject = (value, name) => {",
    '      if (value === null || typeof value !== "object" || Array.isArray(value)) {',
    '        throw new TypeError("connect: " + name + " must be a plain object.");',
    "      }",
    "      return value;",
    "    };",
    '    const __connectCall = (method, args) => __dispatch("$connect", [{ method, args }]);',
    "    const connect = Object.freeze({",
    "      documentation: () => __CONNECT_DOCUMENTATION,",
    '      discover: (query) => __connectCall("discover", [__requireNonEmptyString(query, "query")]),',
    '      connectors: () => __connectCall("connectors", []),',
    '      actions: (id, options) => __connectCall("actions", [__requireNonEmptyString(id, "id"), options === undefined ? {} : __requirePlainObject(options, "options")]),',
    '      schema: (id, action) => __connectCall("schema", [__requireNonEmptyString(id, "id"), __requireNonEmptyString(action, "action")]),',
    '      call: (id, action, args) => __connectCall("call", [__requireNonEmptyString(id, "id"), __requireNonEmptyString(action, "action"), args === undefined ? {} : __requirePlainObject(args, "args")]),',
    '      addMcp: (options) => __connectCall("addMcp", [__requirePlainObject(options, "options")]),',
    '      remove: (id) => __connectCall("remove", [__requireNonEmptyString(id, "id")]),',
    "    });",
    "    try {",
    "      __startClock();",
    "      const result = await Promise.race([",
    `        (${normalizedCode})(),`,
    "        __timeoutPromise,",
    "      ]);",
    '      const safeResult = result === undefined ? undefined : __cloneBoundedJson(result, "result");',
    "      return { result: safeResult, logs: __logs };",
    "    } catch (error) {",
    "      return { result: undefined, error: __errorMessage(error), logs: __logs };",
    "    }",
    "  }",
    "}",
  ].join("\n");

const disposeResource = async (
  resource: unknown,
): Promise<"disposed" | "unavailable" | "failed"> => {
  if (
    (typeof resource !== "object" && typeof resource !== "function") ||
    resource === null
  ) {
    return "unavailable";
  }
  const symbols = Symbol as typeof Symbol & {
    asyncDispose?: symbol;
    dispose?: symbol;
  };
  const record = resource as Record<PropertyKey, unknown>;
  const candidates: PropertyKey[] = [
    ...(symbols.asyncDispose ? [symbols.asyncDispose] : []),
    ...(symbols.dispose ? [symbols.dispose] : []),
    "dispose",
    "close",
  ];
  for (const key of candidates) {
    const method = record[key];
    if (typeof method !== "function") continue;
    try {
      await (method as () => unknown).call(resource);
      return "disposed";
    } catch {
      return "failed";
    }
  }
  return "unavailable";
};

/**
 * Stella-owned Dynamic Worker adapter. Unlike the package's opaque executor,
 * this retains both native handles so an Effect finalizer can synchronously
 * fence new work and await their disposal on cancellation.
 */
export class StellaDynamicWorkerExecutor implements StellaDisposableExecutor {
  readonly #loader: WorkerLoader;
  readonly #timeoutMs: number;
  #worker: WorkerStub | undefined;
  #entrypoint: CodeEntrypoint | undefined;
  #disposePromise: Promise<StellaWorkerCleanupStatus> | undefined;
  #closed = false;
  #started = false;

  constructor(options: Readonly<{ loader: WorkerLoader; timeout: number }>) {
    this.#loader = options.loader;
    this.#timeoutMs = options.timeout;
  }

  async execute(
    code: string,
    providersOrFns:
      | ResolvedProvider[]
      | Record<string, (...args: unknown[]) => Promise<unknown>>,
  ): Promise<ExecuteResult> {
    if (this.#closed || this.#started) {
      return { result: undefined, error: "Cloud code executor is closed." };
    }
    this.#started = true;
    if (
      !Array.isArray(providersOrFns) ||
      providersOrFns.length !== 1 ||
      providersOrFns[0]?.name !== "codemode"
    ) {
      return {
        result: undefined,
        error: "Cloud code executor received an invalid provider surface.",
      };
    }

    const { normalizeCode, sanitizeToolName, ToolDispatcher } =
      await loadCloudflareCodeMode();
    let normalized: string;
    try {
      normalized = normalizeCode(code);
    } catch {
      return { result: undefined, error: "Cloud code source is invalid." };
    }

    const sanitizedFns: Record<
      string,
      (...args: unknown[]) => Promise<unknown>
    > = Object.create(null) as Record<
      string,
      (...args: unknown[]) => Promise<unknown>
    >;
    const sanitizedNames = new Map<string, string>();
    for (const [rawName, fn] of Object.entries(providersOrFns[0].fns)) {
      const sanitizedName = sanitizeToolName(rawName);
      const collision = sanitizedNames.get(sanitizedName);
      if (collision && collision !== rawName) {
        return {
          result: undefined,
          error: "Cloud code executor received colliding tool names.",
        };
      }
      sanitizedNames.set(sanitizedName, rawName);
      sanitizedFns[sanitizedName] = fn;
    }
    const dispatchers = {
      codemode: new ToolDispatcher(sanitizedFns),
    };
    // `tools.<name>` is the exact sanitized identifier; intrinsics are
    // reachable only through their `tools.$…` accessors.
    const toolNames = [...sanitizedNames.keys()].filter(
      (name) => !CLOUD_CODE_INTRINSIC_NAMES.has(name),
    );

    try {
      this.#worker = this.#loader.load({
        compatibilityDate: "2025-06-01",
        mainModule: "executor.js",
        modules: {
          "executor.js": buildWorkerModule(
            normalized,
            this.#timeoutMs,
            toolNames,
          ),
        },
        globalOutbound: null,
      });
      this.#entrypoint =
        this.#worker.getEntrypoint() as unknown as CodeEntrypoint;
      return await this.#entrypoint.evaluate(dispatchers);
    } catch {
      return { result: undefined, error: "Cloud code executor failed." };
    } finally {
      await this.dispose();
    }
  }

  dispose(): Promise<StellaWorkerCleanupStatus> {
    this.#closed = true;
    this.#disposePromise ??= (async () => {
      const entrypoint = this.#entrypoint;
      const worker = this.#worker;
      this.#entrypoint = undefined;
      this.#worker = undefined;
      const entrypointStatus = await disposeResource(entrypoint);
      const workerStatus = await disposeResource(worker);
      if (entrypointStatus === "failed" || workerStatus === "failed") {
        return "dispose_failed";
      }
      if (entrypointStatus === "disposed" || workerStatus === "disposed") {
        return "disposed";
      }
      // No handle can exist when cancellation wins before execute starts. The
      // closed fence itself is then a complete cleanup outcome.
      return this.#started ? "executor_dispose_unavailable" : "disposed";
    })();
    return this.#disposePromise;
  }
}

export const isCloudCodeResourceLimitError = (error: string): boolean =>
  error.startsWith(RESOURCE_LIMIT_MARKER);
