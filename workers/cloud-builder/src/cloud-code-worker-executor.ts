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
export const CLOUD_CODE_HISTORY_INTRINSIC = "$history";
/** Present only for an agent's code, which holds the cloud browser. */
export const CLOUD_CODE_BROWSER_INTRINSIC = "$browser";
/**
 * Present only for an agent's code, which reaches the owner world: the
 * revision its reads are checked against, and the commit of one `fs` write.
 */
export const CLOUD_CODE_WORLD_INTRINSIC = "$world";
/**
 * Present only for the orchestrator's code while memory is on: its
 * `memory.read` / `memory.write` / `memory.list` over the memory files. It is
 * not `fs`: it reaches those files and nothing else in the world.
 */
export const CLOUD_CODE_MEMORY_INTRINSIC = "$memory";
export const CLOUD_CODE_INTRINSIC_NAMES: ReadonlySet<string> = new Set([
  CLOUD_CODE_SEARCH_INTRINSIC,
  CLOUD_CODE_DESCRIBE_INTRINSIC,
  CLOUD_CODE_CONNECT_INTRINSIC,
  CLOUD_CODE_HISTORY_INTRINSIC,
  CLOUD_CODE_BROWSER_INTRINSIC,
  CLOUD_CODE_WORLD_INTRINSIC,
  CLOUD_CODE_MEMORY_INTRINSIC,
]);

/** The model's workspace path; `~` names the same directory. */
export const CLOUD_CODE_WORLD_ROOT = "/workspace/world";
/** One `fs` file, read or written; larger files belong to Bash. */
export const CLOUD_CODE_FS_MAX_FILE_BYTES = 16 * 1024 * 1024;
/** The world loopback refuses more than 8 MiB in one read. */
const CLOUD_CODE_FS_READ_CHUNK_BYTES = 8 * 1024 * 1024;

let cloudflareCodeModePromise: Promise<CloudflareCodeModeModule> | undefined;

/** Load the Code Mode SDK once, only after a turn needs the Code tool. */
export const loadCloudflareCodeMode = (): Promise<CloudflareCodeModeModule> =>
  (cloudflareCodeModePromise ??= import("@cloudflare/codemode"));

export const CLOUD_CODE_WORKER_VALUE_MAX_BYTES = 8 * 1024 * 1024;
export const CLOUD_CODE_WORKER_MAX_VALUE_DEPTH = 16;
export const CLOUD_CODE_WORKER_MAX_VALUE_NODES = 200_000;
export const CLOUD_CODE_WORKER_MAX_VALUE_ENTRIES = 200_000;
export const CLOUD_CODE_WORKER_MAX_STRING_BYTES = 8 * 1024 * 1024;

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

/**
 * The sandbox `browser` global. Each method is a thin forwarder; the host
 * validates arguments and owns the gateway contract. Trailing omitted
 * arguments are dropped because the value bridge refuses `undefined`.
 */
const BROWSER_GLOBAL_LINES = [
  "    const __browserCall = (method, args) => {",
  "      let end = args.length;",
  "      while (end > 0 && args[end - 1] === undefined) end -= 1;",
  '      return __dispatch("$browser", [{ method, args: args.slice(0, end) }]);',
  "    };",
  "    const browser = Object.freeze({",
  '      open: (url, options) => __browserCall("open", [url, options]),',
  '      navigate: (url) => __browserCall("navigate", [url]),',
  '      observe: () => __browserCall("observe", []),',
  '      click: (selector) => __browserCall("click", [selector]),',
  '      fill: (selector, value) => __browserCall("fill", [selector, value]),',
  '      press: (selector, key) => __browserCall("press", [selector, key]),',
  '      select: (selector, value) => __browserCall("select", [selector, value]),',
  '      wait: (selector, timeoutMs) => __browserCall("wait", [selector, timeoutMs]),',
  '      tabs: () => __browserCall("tabs", []),',
  '      focusTab: (tabId) => __browserCall("focusTab", [tabId]),',
  '      back: () => __browserCall("back", []),',
  '      forward: () => __browserCall("forward", []),',
  '      reload: () => __browserCall("reload", []),',
  '      hover: (selector) => __browserCall("hover", [selector]),',
  '      scroll: (options) => __browserCall("scroll", [options]),',
  '      check: (selector) => __browserCall("check", [selector]),',
  '      uncheck: (selector) => __browserCall("uncheck", [selector]),',
  '      text: (selector) => __browserCall("text", [selector]),',
  '      screenshot: (options) => __browserCall("screenshot", [options]),',
  '      evaluate: (script, arg) => __browserCall("evaluate", arg === undefined ? [script] : [script, arg]),',
  '      cookies: (urls) => __browserCall("cookies", [urls]),',
  '      setCookies: (cookies) => __browserCall("setCookies", [cookies]),',
  '      clearCookies: () => __browserCall("clearCookies", []),',
  '      requests: (options) => __browserCall("requests", [options]),',
  '      responseBody: (url) => __browserCall("responseBody", [url]),',
  '      close: () => __browserCall("close", []),',
  '      requestLoginTakeover: (options) => __browserCall("requestLoginTakeover", [options]),',
  '      requestDeviceCodeFixture: (options) => __browserCall("requestDeviceCodeFixture", [options]),',
  "    });",
] as const;

/**
 * The sandbox `memory` global, the orchestrator's only. Omitted arguments are
 * left out of the request because the value bridge refuses `undefined`; the
 * host validates every field.
 */
const MEMORY_GLOBAL_LINES = [
  "    const __memoryCall = (op, fields) => {",
  "      const request = { op };",
  "      for (const [key, value] of Object.entries(fields)) {",
  "        if (value !== undefined) request[key] = value;",
  "      }",
  '      return __dispatch("$memory", [request]);',
  "    };",
  "    const memory = Object.freeze({",
  '      read: (path) => __memoryCall("read", { path }),',
  '      write: (path, content, options) => __memoryCall("write", { path, content, options }),',
  '      list: () => __memoryCall("list", {}),',
  "    });",
] as const;

/**
 * The sandbox `fs` global over the owner world, for an agent's code only.
 *
 * Reads go straight to `env.WORLD`, the read-only world loopback the host
 * bound into this Worker, so file bytes never pass through the agent's
 * Durable Object. A write uploads its content through the same loopback as an
 * unreferenced blob and then asks the host to commit one change through
 * `$world`; the host applies it only if nothing this call read since its last
 * write or nested tool call changed meanwhile (`WorldStore.commitShell`).
 * Writes run one at a time so a read-modify-write such as `appendFile` checks
 * its own read; reads run concurrently. A nested `tools.*` call changes the
 * world on its own, so after one the read set starts over.
 *
 * Symlinks resolve inside the world only; a link that leaves it is refused.
 */
const FS_GLOBAL_SOURCE = String.raw`
    const __fsWorld = this.env.WORLD;
    const __FS_ROOT = "${CLOUD_CODE_WORLD_ROOT}";
    const __FS_MAX_FILE_BYTES = ${CLOUD_CODE_FS_MAX_FILE_BYTES};
    const __FS_READ_CHUNK_BYTES = ${CLOUD_CODE_FS_READ_CHUNK_BYTES};
    const __FS_ROOT_ENTRY = Object.freeze({ path: "", kind: "dir", mode: 0o755, mtime: 0, size: 0 });
    const __fsEncoder = new TextEncoder();
    const __fsDecoder = new TextDecoder();
    let __fsBase = null;
    const __fsReadPaths = new Set();
    const __fsListed = new Set();
    let __fsWrites = Promise.resolve();
    const __fsForget = () => {
      __fsBase = null;
      __fsReadPaths.clear();
      __fsListed.clear();
    };
    const __fsError = (code, message, op, path) => {
      const error = new Error(code + ": " + message + ", " + op + " '" + String(path) + "'");
      error.code = code;
      return error;
    };
    const __fsShellPath = (worldPath) => (worldPath ? __FS_ROOT + "/" + worldPath : __FS_ROOT);
    const __fsWorldPath = (input, op) => {
      if (typeof input !== "string" || input.length === 0) {
        throw new TypeError("fs." + op + ": path must be a non-empty string.");
      }
      const absolute = input === "~" ? __FS_ROOT
        : input.startsWith("~/") ? __FS_ROOT + input.slice(1)
          : input.startsWith("/") ? input
            : __FS_ROOT + "/" + input;
      const segments = [];
      for (const segment of absolute.split("/")) {
        if (!segment || segment === ".") continue;
        if (segment === "..") segments.pop();
        else segments.push(segment);
      }
      const normalized = "/" + segments.join("/");
      if (normalized === __FS_ROOT) return "";
      if (!normalized.startsWith(__FS_ROOT + "/")) {
        throw __fsError("EACCES", "only " + __FS_ROOT + " (~) is reachable from code", op, input);
      }
      const relative = normalized.slice(__FS_ROOT.length + 1);
      // The user's drive is its own store, never in the world this reads.
      if (relative === "drive" || relative.startsWith("drive/")) {
        throw __fsError("EACCES", "the user's drive is not in this filesystem; use tools.Read, tools.Write or tools.Edit on " + __FS_ROOT + "/drive", op, input);
      }
      return relative;
    };
    const __fsPin = async () => {
      if (__fsBase !== null) return;
      const head = await __dispatch("$world", [{ op: "head" }]);
      if (__fsBase === null) __fsBase = head.revision;
    };
    const __fsResolve = async (worldPath, followLast, op, display) => {
      await __fsPin();
      let current = worldPath;
      for (let hops = 0; hops <= 40; hops += 1) {
        if (current === "") return { path: "", entry: __FS_ROOT_ENTRY, parentMissing: false };
        const parts = current.split("/");
        if (parts.length > 256) throw __fsError("ENAMETOOLONG", "path has too many components", op, display);
        const prefixes = [];
        for (let index = 0; index < parts.length; index += 1) {
          prefixes.push(index === 0 ? parts[0] : prefixes[index - 1] + "/" + parts[index]);
        }
        const entries = await __fsWorld.stat(prefixes);
        for (const prefix of prefixes) __fsReadPaths.add(prefix);
        let next = null;
        for (let index = 0; index < parts.length; index += 1) {
          const entry = entries[index];
          const last = index === parts.length - 1;
          if (!entry) return { path: current, entry: null, parentMissing: !last };
          if (entry.kind === "symlink" && (!last || followLast)) {
            const target = typeof entry.target === "string" ? entry.target : "";
            const base = index === 0 ? "" : prefixes[index - 1];
            const resolved = __fsWorldPath(target.startsWith("/") ? target : __fsShellPath(base) + "/" + target, op);
            const rest = parts.slice(index + 1).join("/");
            next = rest ? (resolved ? resolved + "/" + rest : rest) : resolved;
            break;
          }
          if (!last && entry.kind !== "dir") throw __fsError("ENOTDIR", "not a directory", op, display);
          if (last) return { path: current, entry, parentMissing: false };
        }
        current = next;
      }
      throw __fsError("ELOOP", "too many symbolic links", op, display);
    };
    const __fsEncoding = (options, op) => {
      const encoding = typeof options === "string" ? options
        : options && typeof options === "object" ? options.encoding : undefined;
      if (encoding === undefined || encoding === "utf8" || encoding === "utf-8") return "utf8";
      if (encoding === null || encoding === "bytes") return "bytes";
      if (encoding === "base64") return "base64";
      throw new TypeError("fs." + op + ': encoding must be "utf8", "base64" or "bytes".');
    };
    const __fsToBase64 = (bytes) => {
      let binary = "";
      for (let offset = 0; offset < bytes.length; offset += 0x8000) {
        binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
      }
      return btoa(binary);
    };
    const __fsBytesOf = (data, options, op) => {
      if (typeof data === "string") {
        if (__fsEncoding(options, op) !== "base64") return __fsEncoder.encode(data);
        try {
          return Uint8Array.from(atob(data), (character) => character.charCodeAt(0));
        } catch {
          throw new TypeError("fs." + op + ": data is not valid base64.");
        }
      }
      const view = data instanceof ArrayBuffer ? new Uint8Array(data)
        : ArrayBuffer.isView(data) ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
          : null;
      if (!view) throw new TypeError("fs." + op + ": data must be a string or bytes.");
      return view.byteOffset === 0 && view.byteLength === view.buffer.byteLength ? view : view.slice();
    };
    const __fsRead = async (worldPath, entry, op, display) => {
      if (entry.kind !== "file") throw __fsError("EISDIR", "illegal operation on a directory", op, display);
      if (entry.size > __FS_MAX_FILE_BYTES) {
        throw __fsError("EFBIG", "files over 16 MiB cannot be read from code; use Bash", op, display);
      }
      const bytes = new Uint8Array(entry.size);
      let offset = 0;
      while (offset < entry.size) {
        const chunk = await __fsWorld.read(worldPath, {
          offset,
          length: Math.min(__FS_READ_CHUNK_BYTES, entry.size - offset),
        });
        if (!chunk) throw __fsError("ENOENT", "no such file or directory", op, display);
        if (chunk.byteLength === 0) break;
        bytes.set(chunk.subarray(0, Math.min(chunk.byteLength, entry.size - offset)), offset);
        offset += chunk.byteLength;
      }
      return offset >= entry.size ? bytes : bytes.subarray(0, offset);
    };
    const __fsDecode = (bytes, options, op) => {
      const encoding = __fsEncoding(options, op);
      return encoding === "bytes" ? bytes : encoding === "base64" ? __fsToBase64(bytes) : __fsDecoder.decode(bytes);
    };
    const __fsCommit = async (change, op, display) => {
      const outcome = await __dispatch("$world", [{
        op: "commit",
        baseRevision: __fsBase,
        reads: [...__fsReadPaths],
        children: [...__fsListed],
        entries: change.entries,
        deleted: change.deleted,
      }]);
      if (outcome && outcome.status === "committed") {
        __fsBase = outcome.revision;
        __fsReadPaths.clear();
        __fsListed.clear();
        return;
      }
      __fsForget();
      if (outcome && outcome.status === "conflict") {
        const paths = Array.isArray(outcome.paths) ? outcome.paths.slice(0, 5).map(__fsShellPath) : [];
        throw __fsError("EAGAIN", "the workspace changed after this call read it" + (paths.length > 0 ? " (" + paths.join(", ") + ")" : "") + "; nothing was written, so read it again and retry", op, display);
      }
      throw __fsError("EIO", "the workspace did not accept this write", op, display);
    };
    const __fsWrite = (work) => {
      const run = __fsWrites.then(work);
      __fsWrites = run.then(() => undefined, () => undefined);
      return run;
    };
    const __fsPut = async (worldPath, entry, bytes, op, display) => {
      if (bytes.byteLength > __FS_MAX_FILE_BYTES) {
        throw __fsError("EFBIG", "files over 16 MiB cannot be written from code; use Bash", op, display);
      }
      const blob = await __fsWorld.putBlob(bytes);
      await __fsCommit({
        entries: [{ path: worldPath, kind: "file", mode: entry ? entry.mode : 0o644, size: blob.size, sha256: blob.sha256 }],
        deleted: [],
      }, op, display);
    };
    const __fsStat = (worldPath, entry) => Object.freeze({
      path: __fsShellPath(worldPath),
      kind: entry.kind,
      size: entry.size,
      mode: entry.mode,
      mtimeMs: entry.mtime,
      isFile: entry.kind === "file",
      isDirectory: entry.kind === "dir",
      isSymbolicLink: entry.kind === "symlink",
      ...(typeof entry.target === "string" ? { target: entry.target } : {}),
    });
    const __fsExisting = async (path, followLast, op) => {
      const found = await __fsResolve(__fsWorldPath(path, op), followLast, op, path);
      if (!found.entry) throw __fsError("ENOENT", "no such file or directory", op, path);
      return found;
    };
    for (const [__name, __call] of __toolFunctions) {
      __toolFunctions.set(__name, Object.freeze((args = {}) => __call(args).finally(__fsForget)));
    }
    const fs = Object.freeze({
      readFile: async (path, options) => {
        const found = await __fsExisting(path, true, "readFile");
        return __fsDecode(await __fsRead(found.path, found.entry, "readFile", path), options, "readFile");
      },
      writeFile: (path, data, options) => __fsWrite(async () => {
        const bytes = __fsBytesOf(data, options, "writeFile");
        const found = await __fsResolve(__fsWorldPath(path, "writeFile"), true, "writeFile", path);
        if (found.entry && found.entry.kind !== "file") throw __fsError("EISDIR", "illegal operation on a directory", "writeFile", path);
        await __fsPut(found.path, found.entry, bytes, "writeFile", path);
      }),
      appendFile: (path, data, options) => __fsWrite(async () => {
        const added = __fsBytesOf(data, options, "appendFile");
        const found = await __fsResolve(__fsWorldPath(path, "appendFile"), true, "appendFile", path);
        const prior = found.entry ? await __fsRead(found.path, found.entry, "appendFile", path) : new Uint8Array(0);
        const combined = new Uint8Array(prior.byteLength + added.byteLength);
        combined.set(prior, 0);
        combined.set(added, prior.byteLength);
        await __fsPut(found.path, found.entry, combined, "appendFile", path);
      }),
      readdir: async (path, options) => {
        const found = await __fsExisting(path, true, "readdir");
        if (found.entry.kind !== "dir") throw __fsError("ENOTDIR", "not a directory", "readdir", path);
        const children = await __fsWorld.children(found.path);
        __fsListed.add(found.path);
        const nameOf = (child) => child.path.slice(child.path.lastIndexOf("/") + 1);
        return options && typeof options === "object" && options.withFileTypes
          ? children.map((child) => Object.freeze({
              name: nameOf(child),
              kind: child.kind,
              isFile: child.kind === "file",
              isDirectory: child.kind === "dir",
              isSymbolicLink: child.kind === "symlink",
            }))
          : children.map(nameOf);
      },
      stat: async (path) => {
        const found = await __fsExisting(path, true, "stat");
        return __fsStat(found.path, found.entry);
      },
      lstat: async (path) => {
        const found = await __fsExisting(path, false, "lstat");
        return __fsStat(found.path, found.entry);
      },
      exists: async (path) => {
        try {
          return Boolean((await __fsResolve(__fsWorldPath(path, "exists"), true, "exists", path)).entry);
        } catch (error) {
          if (error && (error.code === "ENOTDIR" || error.code === "ELOOP")) return false;
          throw error;
        }
      },
      mkdir: (path, options) => __fsWrite(async () => {
        const recursive = Boolean(options && typeof options === "object" && options.recursive);
        const found = await __fsResolve(__fsWorldPath(path, "mkdir"), true, "mkdir", path);
        if (found.entry) {
          if (found.entry.kind === "dir" && recursive) return undefined;
          throw __fsError("EEXIST", "file already exists", "mkdir", path);
        }
        if (found.parentMissing && !recursive) throw __fsError("ENOENT", "no such file or directory", "mkdir", path);
        await __fsCommit({ entries: [{ path: found.path, kind: "dir", mode: 0o755, size: 0 }], deleted: [] }, "mkdir", path);
        return undefined;
      }),
      rm: (path, options) => __fsWrite(async () => {
        const recursive = Boolean(options && typeof options === "object" && options.recursive);
        const force = Boolean(options && typeof options === "object" && options.force);
        const worldPath = __fsWorldPath(path, "rm");
        if (worldPath === "") throw __fsError("EPERM", "the workspace root cannot be removed", "rm", path);
        const found = await __fsResolve(worldPath, false, "rm", path);
        if (!found.entry) {
          if (force) return undefined;
          throw __fsError("ENOENT", "no such file or directory", "rm", path);
        }
        if (found.entry.kind === "dir" && !recursive) {
          throw __fsError("EISDIR", "is a directory; pass { recursive: true }", "rm", path);
        }
        await __fsCommit({ entries: [], deleted: [found.path] }, "rm", path);
        return undefined;
      }),
      rename: (from, to) => __fsWrite(async () => {
        const source = await __fsExisting(from, false, "rename");
        if (source.entry.kind === "dir") {
          throw __fsError("EISDIR", "directories cannot be renamed from code; use Bash", "rename", from);
        }
        const target = await __fsResolve(__fsWorldPath(to, "rename"), false, "rename", to);
        if (target.path === "" || (target.entry && target.entry.kind === "dir")) {
          throw __fsError("EISDIR", "illegal operation on a directory", "rename", to);
        }
        if (target.path === source.path) return undefined;
        const { path: _path, mtime: _mtime, ...node } = source.entry;
        await __fsCommit({ entries: [{ path: target.path, ...node }], deleted: [source.path] }, "rename", from);
        return undefined;
      }),
      copyFile: (from, to) => __fsWrite(async () => {
        const source = await __fsExisting(from, true, "copyFile");
        if (source.entry.kind !== "file") throw __fsError("EISDIR", "illegal operation on a directory", "copyFile", from);
        const target = await __fsResolve(__fsWorldPath(to, "copyFile"), true, "copyFile", to);
        if (target.path === "" || (target.entry && target.entry.kind === "dir")) {
          throw __fsError("EISDIR", "illegal operation on a directory", "copyFile", to);
        }
        if (target.path === source.path) return undefined;
        await __fsCommit({
          entries: [{ path: target.path, kind: "file", mode: source.entry.mode, size: source.entry.size, sha256: source.entry.sha256 }],
          deleted: [],
        }, "copyFile", from);
        return undefined;
      }),
    });
`;

const buildWorkerModule = (
  normalizedCode: string,
  timeoutMs: number,
  toolNames: readonly string[],
  browser: boolean,
  world = false,
  memory = false,
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
    '    const __historyCall = (method, args) => __dispatch("$history", [{ method, args }]);',
    "    const history = Object.freeze({",
    '      sql: (query, params = []) => __historyCall("sql", [query, params]),',
    '      read: (fromSeq, toSeq) => __historyCall("read", [fromSeq, toSeq]),',
    "    });",
    ...(browser ? BROWSER_GLOBAL_LINES : []),
    ...(world ? [FS_GLOBAL_SOURCE] : []),
    ...(memory ? MEMORY_GLOBAL_LINES : []),
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
  readonly #globalOutbound: Fetcher | null;
  readonly #world: unknown;
  #worker: WorkerStub | undefined;
  #entrypoint: CodeEntrypoint | undefined;
  #disposePromise: Promise<StellaWorkerCleanupStatus> | undefined;
  #closed = false;
  #started = false;

  constructor(
    options: Readonly<{
      loader: WorkerLoader;
      timeout: number;
      /** An agent's egress entrypoint; absent, the Worker has no network. */
      globalOutbound?: Fetcher;
      /** An agent's world loopback, bound as `env.WORLD` for `fs`. */
      world?: unknown;
    }>,
  ) {
    this.#loader = options.loader;
    this.#timeoutMs = options.timeout;
    this.#globalOutbound = options.globalOutbound ?? null;
    this.#world = options.world;
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

    // `fs` needs both halves: the loopback its reads use and the host
    // intrinsic that commits its writes.
    const world =
      this.#world !== undefined &&
      sanitizedNames.has(CLOUD_CODE_WORLD_INTRINSIC);
    try {
      this.#worker = this.#loader.load({
        compatibilityDate: "2025-06-01",
        mainModule: "executor.js",
        modules: {
          "executor.js": buildWorkerModule(
            normalized,
            this.#timeoutMs,
            toolNames,
            sanitizedNames.has(CLOUD_CODE_BROWSER_INTRINSIC),
            world,
            sanitizedNames.has(CLOUD_CODE_MEMORY_INTRINSIC),
          ),
        },
        ...(world ? { env: { WORLD: this.#world } } : {}),
        globalOutbound: this.#globalOutbound,
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
