import path from "node:path";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import { Worker } from "node:worker_threads";

import type { BrowserUseResponseMeta } from "@stella/contracts/local-chat";

import type {
  ToolContext,
  ToolResult,
  ToolUpdateCallback,
} from "../tools/types.js";
import {
  getStellaBrowserSessionId,
  getStellaComputerSessionId,
} from "../tools/stella-computer-session.js";
import {
  maybeRequestBrowserExtensionConnect,
  type BrowserExtensionConnectRequester,
} from "../tools/browser-extension-offer.js";
import {
  createBrowserSession,
  WORKER_BOUND_BACKEND_PARAM,
  type BrowserBackend,
  type BrowserChainOptions,
  type BrowserChainStep,
  type BrowserCommandParams,
  type BrowserProtocolAction,
  type BrowserSessionClient,
  type BrowserSessionOptions,
  type BrowserTurnEndBehavior,
} from "../browser-use/client.js";
import {
  createSkyClient,
  type AuthorizeApp,
  type SkyClient,
} from "./client.js";
import { createNodeReplWorkerSource } from "./kernel-worker.js";
import type { ComputerUseSession } from "./session.js";
import {
  DEFAULT_NODE_REPL_TOOL_DRAIN_TIMEOUT_MS,
  MAX_NODE_REPL_CODE_BYTES,
  MAX_NODE_REPL_OUTPUT_BYTES,
  MAX_NODE_REPL_PENDING_BROWSER_CALLS,
  MAX_NODE_REPL_PENDING_CONNECT_CALLS,
  MAX_NODE_REPL_PENDING_SKY_CALLS,
  MAX_NODE_REPL_PENDING_TOOL_CALLS,
  MAX_NODE_REPL_PROTOCOL_MESSAGE_BYTES,
  NODE_REPL_TOOL_DESCRIBE_NAME,
  NODE_REPL_TOOL_SEARCH_NAME,
  type ConnectMethod,
  type NodeReplContentItem,
  type NodeReplImageDetail,
  type NodeReplResetReason,
  type NodeReplResetReceipt,
  type NodeReplWorkerData,
  type ParentToNodeReplWorkerMessage,
  type SerializedError,
  type SkyMethod,
  type WorkerToNodeReplParentMessage,
} from "./protocol.js";
import type { ReplConnectClient } from "../connectors/connect-service.js";
import { resolveToolFallbackCwd } from "../tools/cwd.js";

const DEFAULT_EVAL_TIMEOUT_MS = 11 * 60_000;
const DEFAULT_COMMAND_TIMEOUT_MS = 30_000;
const DEFAULT_IDLE_TIMEOUT_MS = 4 * 60 * 60_000;

const DEFAULT_KERNEL_DISPOSE_TIMEOUT_MS = 10_000;
const DEFAULT_COMPLETED_CELL_RETENTION_MS = 5 * 60_000;
const DEFAULT_MAX_RETAINED_CELLS = 128;

export type NodeReplMetadata = Readonly<{
  cwd: string;
  home: string;
  tmp: string;
  homeDir: string;
  tmpDir: string;
  write: (...values: unknown[]) => void;
  emitImage: (
    value: string | Readonly<{ attached: true; path: string }>,
    options?: Readonly<{
      mimeType?: "image/jpeg" | "image/png" | "image/gif" | "image/webp";
      detail?: NodeReplImageDetail;
    }>,
  ) => Readonly<{ type: "image"; path: string; attached: true }> | undefined;
  emitAudio: (
    value: string,
    options?: Readonly<{ mimeType?: string }>,
  ) => undefined;
  status: () => Readonly<{
    generation: number;
    generationStartedAt: number;
    persistentBindings: true;
    state: "ready" | "evaluating";
    activeEvaluationId: number | null;
  }>;
  reset: () => NodeReplResetReceipt;
  help: (topic?: "bindings" | "images" | "reset" | "tools") => string;
}>;

export type NodeReplToolSearchResult = {
  name: string;
  signature: string;
  description?: string;

  access?: string;
  dotNotation?: boolean;
};

export type NodeReplEvaluationResult = Readonly<{
  output: string;
  content: readonly NodeReplContentItem[];
  generation: number;
  reset?: NodeReplResetReceipt;
  responseMeta?: BrowserUseResponseMeta;
}>;

export type NodeReplCellObservation = Readonly<{
  cellId: string;
  generation: number;
  status: "running" | "completed" | "failed";
  elapsedMs: number;

  fromCursor: number;

  cursor: number;
  output?: string;
  content?: readonly NodeReplContentItem[];
  reset?: NodeReplResetReceipt;
  error?: string;
  responseMeta?: BrowserUseResponseMeta;
}>;

export type NodeReplKernelManagerOptions = {
  browserBinPath?: string;
  sessionFactory?: ComputerUseSessionFactory;
  authorizeApp?: AuthorizeApp;
  browserSessionFactory?: (
    options: BrowserSessionOptions,
  ) => BrowserSessionClient;
  requestBrowserExtensionConnect?: BrowserExtensionConnectRequester;
  disposeSession?: (sessionId: string) => void | Promise<void>;
  evalTimeoutMs?: number;
  commandTimeoutMs?: number;
  idleTimeoutMs?: number;

  toolDrainTimeoutMs?: number;

  disposeTimeoutMs?: number;

  cellRetentionMs?: number;

  maxRetainedCells?: number;
  executeTool?: (
    toolName: string,
    args: Record<string, unknown>,
    context: ToolContext,
    signal?: AbortSignal,
    onUpdate?: ToolUpdateCallback,
  ) => Promise<ToolResult>;

  connectClient?: ReplConnectClient;

  searchTools?: (
    query: string,
    context: ToolContext,
    limit?: number,
  ) => Promise<NodeReplToolSearchResult[]> | NodeReplToolSearchResult[];
  describeTool?: (
    name: string,
    context: ToolContext,
    cursor?: number,
  ) => Promise<unknown> | unknown;
};

export type ComputerUseSessionFactoryOptions = Readonly<{
  sessionId: string;
  cwd: string;
  getSignal: () => AbortSignal | undefined;
  timeoutMs: number;
}>;

export type ComputerUseSessionFactory = (
  options: ComputerUseSessionFactoryOptions,
) => ComputerUseSession;

export type EvaluateOptions = {
  timeoutMs?: number;
  signal?: AbortSignal;
  onToolResult?: (result: ToolResult) => void;
  onToolUpdate?: ToolUpdateCallback;

  onResponseMeta?: (meta: BrowserUseResponseMeta) => void;

  onContent?: (item: NodeReplContentItem, cursor: number) => void;
};

class KernelTerminatedError extends Error {
  readonly requestedAt: number;

  constructor(
    message: string,
    readonly resetReason: NodeReplResetReason,
    requestedAt = Date.now(),
    readonly resetReceipt?: NodeReplResetReceipt,
  ) {
    super(message);
    this.name = "KernelTerminatedError";
    this.requestedAt = requestedAt;
  }
}

const NODE_REPL_UNCAUGHT_ERROR_NAME = "NodeReplUncaughtError";

const BLOCKED_NODE_MODULE_RE =
  /(?:from\s*|import\s*\(\s*|require\s*\(\s*)["'](?:node:)?(?:child_process|process|worker_threads)["']|process\s*\.\s*(?:binding|getBuiltinModule|dlopen)/;

const CONNECT_METHODS = new Set<ConnectMethod>([
  "discover",
  "connectors",
  "actions",
  "schema",
  "call",
  "addMcp",
  "remove",
]);

const SKY_METHODS = new Set<SkyMethod>([
  "list_apps",
  "list_windows",
  "get_app_state",
  "wait_for_change",
  "click",
  "drag",
  "perform_secondary_action",
  "press_key",
  "scroll",
  "select_text",
  "set_value",
  "type_text",
  "batch",
]);

const abortError = (signal: AbortSignal) =>
  signal.reason instanceof Error
    ? signal.reason
    : new Error("Node REPL evaluation aborted.");

const byteLength = (value: string) => Buffer.byteLength(value, "utf8");

const serializedSize = (value: unknown): number => {
  try {
    return byteLength(JSON.stringify(value) ?? "");
  } catch {
    return Number.POSITIVE_INFINITY;
  }
};

const sanitizedBrowserUrl = (rawUrl: string): string | undefined => {
  try {
    const parsed = new URL(rawUrl);
    parsed.username = "";
    parsed.password = "";
    parsed.search = "";
    parsed.hash = "";
    return parsed.toString();
  } catch {
    return undefined;
  }
};

const browserPageOrigin = (rawUrl: string): string | undefined => {
  try {
    const origin = new URL(rawUrl).origin;
    return origin === "null" ? undefined : origin;
  } catch {
    return undefined;
  }
};

const serializeError = (error: unknown): SerializedError => {
  const truncate = (value: string, maxBytes: number) =>
    byteLength(value) <= maxBytes
      ? value
      : Buffer.from(value).subarray(0, maxBytes).toString("utf8");
  if (error instanceof Error) {
    return {
      name: truncate(error.name || "Error", 256),
      message: truncate(error.message || String(error), 16_384),
      ...(error.stack ? { stack: truncate(error.stack, 65_536) } : {}),
    };
  }
  return { name: "Error", message: truncate(String(error), 16_384) };
};

const deserializeError = (error: SerializedError): Error => {
  const result = new Error(error.message);
  result.name = error.name;
  if (error.stack) result.stack = error.stack;
  return result;
};

type ActiveEvaluation = {
  id: number;
  controller: AbortController;
  timeout: NodeJS.Timeout;
  signal?: AbortSignal;
  onAbort?: () => void;
  resolve: (result: NodeReplEvaluationResult) => void;
  reject: (error: Error) => void;
  context: ToolContext;
  onToolResult?: (result: ToolResult) => void;
  onToolUpdate?: ToolUpdateCallback;
  onResponseMeta?: (meta: BrowserUseResponseMeta) => void;
  resetRequestedAt?: number;
  responseMeta?: BrowserUseResponseMeta;
  content: NodeReplContentItem[];
  nextContentCursor: number;
  onContent?: (item: NodeReplContentItem, cursor: number) => void;
  browserActivity: {
    callCount: number;
    mutated: boolean;
    screenshotAttachments: BrowserScreenshotAttachment[];
    terminalLifecycle: boolean;
    lastAction?: string;
    lastBackend?: BrowserBackend;
    presentationAction?: {
      action: string;
      tabId?: number;
      backend: BrowserBackend;
    };
  };
};

type BrowserScreenshotAttachment = Readonly<{
  path: string;
  mimeType: "image/jpeg" | "image/png";
  deleteAfterAttach: boolean;
}>;

type BrowserPresentationTab = Readonly<{
  tabId: number;
  active: boolean;
  url?: string;
}>;

type BrowserPresentationTabs = Readonly<{
  tabs: BrowserPresentationTab[];
  activeTabId?: number;
}>;

const BROWSER_METHODS = new Set(["command", "chain", "use"]);
const READ_ONLY_BROWSER_ACTIONS = new Set([
  "healthcheck",
  "url",
  "title",
  "screenshot",
  "snapshot",
  "content",
  "gettext",
  "getattribute",
  "innertext",
  "innerhtml",
  "inputvalue",
  "boundingbox",
  "isvisible",
  "isenabled",
  "ischecked",
  "count",
  "styles",
  "requests",
  "responsebody",
  "cookies_get",
  "site_mod_list",
  "tab_list",
  "wait",
  "waitforurl",
]);

const BROWSER_PRESENTATION_ACTIONS = new Set([
  "tab_close",
  "click",
  "dblclick",
  "drag",
  "press",
  "type",
  "inserttext",
  "fill",
  "select",
  "check",
  "uncheck",
  "scroll",
  "navigate",
  "back",
  "forward",
  "reload",
  "dialog",
  "download",

  "input_keyboard",
  "input_mouse",
  "keyboard",
  "mouse",
  "mousemove",
  "wheel",
]);
const BROWSER_PRESENTATION_TIMEOUT_MS = 10_000;
const MAX_BROWSER_SCREENSHOT_FILES_PER_KERNEL = 100;

export const NODE_REPL_EXCLUDED_TOOL_NAMES: ReadonlySet<string> = new Set([
  "node_repl",
  "multi_tool_use_parallel",
]);

const replToolNamesForContext = (context: ToolContext): string[] =>
  [...new Set(context.allowedToolNames ?? [])].filter(
    (name) => !NODE_REPL_EXCLUDED_TOOL_NAMES.has(name) && !name.startsWith("$"),
  );

const JAVASCRIPT_IDENTIFIER_RE = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

const replToolAccess = (name: string): string =>
  JAVASCRIPT_IDENTIFIER_RE.test(name)
    ? `tools.${name}`
    : `tools[${JSON.stringify(name)}]`;

const enrichToolSearchResults = (
  results: readonly NodeReplToolSearchResult[],
): NodeReplToolSearchResult[] =>
  results.map((result) => {
    const access = replToolAccess(result.name);
    const legacyPrefix = `tools.${result.name}`;
    const signature = result.signature.startsWith(legacyPrefix)
      ? `${access}${result.signature.slice(legacyPrefix.length)}`
      : result.signature;
    return {
      ...result,
      signature,
      access,
      dotNotation: JAVASCRIPT_IDENTIFIER_RE.test(result.name),
    };
  });

const formatNodeReplContent = (
  content: readonly NodeReplContentItem[],
): string =>
  content
    .map((item) => {
      if (item.type === "text") return item.text;
      if (item.type === "image") {
        if (item.alreadyAttached) {
          return `[stella-image-already-attached] path=${JSON.stringify(item.path)}`;
        }
        const mimeType = item.mimeType ? ` inline=${item.mimeType}` : "";
        const detail = item.detail ? ` detail=${item.detail}` : "";
        return `[stella-attach-image]${mimeType}${detail} path=${JSON.stringify(item.path)}`;
      }
      const mimeType = item.mimeType ? ` mime=${item.mimeType}` : "";
      return `[node-repl-audio]${mimeType} path=${JSON.stringify(item.path)}`;
    })
    .filter(Boolean)
    .join("\n");

const isNodeReplContentItem = (
  value: unknown,
): value is NodeReplContentItem => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  if (item.type === "text") return typeof item.text === "string";
  if (item.type === "image") {
    return typeof item.path === "string" && path.isAbsolute(item.path);
  }
  return (
    item.type === "audio" &&
    typeof item.path === "string" &&
    path.isAbsolute(item.path)
  );
};

const resetReceipt = (
  generation: number,
  reason: NodeReplResetReason,
  requestedAt = Date.now(),
): NodeReplResetReceipt => ({
  reset: true,
  reason,
  previousGeneration: generation,
  nextGeneration: generation + 1,
  bindingsDiscarded: true,
  requestedAt,
});

const formatResetReceipt = (receipt: NodeReplResetReceipt): string =>
  `[node_repl reset: reason=${receipt.reason} generation=${receipt.previousGeneration} previousGeneration=${receipt.previousGeneration} nextGeneration=${receipt.nextGeneration} bindingsDiscarded=true requestedAt=${receipt.requestedAt}]`;

export type NodeReplTransport = {
  on(event: "message", listener: (message: unknown) => void): unknown;
  on(event: "error", listener: (error: Error) => void): unknown;
  on(event: "exit", listener: (code: number | null) => void): unknown;
  postMessage(message: ParentToNodeReplWorkerMessage): void;
  ref(): void;
  unref(): void;
  terminate(): Promise<unknown>;
};

export const isBunNodeReplRuntime = (
  versions: NodeJS.ProcessVersions & { bun?: string } = process.versions,
) => Boolean(versions.bun);

export const nodeReplChildUsesElectronRuntime = (
  env: NodeJS.ProcessEnv = process.env,
): boolean => {
  if (env.STELLA_NODE_IS_ELECTRON?.trim() === "1") return true;
  if (env.STELLA_NODE_BIN?.trim()) return false;
  return Boolean(env.STELLA_HOST_EXECUTABLE_PATH?.trim());
};

type ExternalNodeReplTransportOptions = Readonly<{
  env?: NodeJS.ProcessEnv;
  spawnProcess?: typeof spawn;
}>;

export const createExternalNodeReplTransport = (
  source: string,
  workerData: NodeReplWorkerData,
  options: ExternalNodeReplTransportOptions = {},
): NodeReplTransport => {
  const env = options.env ?? process.env;
  const executable =
    env.STELLA_NODE_BIN?.trim() ||
    env.STELLA_HOST_EXECUTABLE_PATH?.trim() ||
    "node";
  const child = (options.spawnProcess ?? spawn)(executable, ["-"], {
    env: {
      ...env,
      ...(nodeReplChildUsesElectronRuntime(env)
        ? { ELECTRON_RUN_AS_NODE: "1" }
        : {}),
      STELLA_NODE_REPL_WORKER_DATA: JSON.stringify(workerData),
    },
    stdio: ["pipe", "ignore", "ignore", "ipc"],
    windowsHide: true,
  });

  const errorListeners = new Set<(error: Error) => void>();
  const bufferedErrors: Error[] = [];
  const forwardError = (error: Error) => {
    if (errorListeners.size === 0) {
      bufferedErrors.push(error);
      return;
    }
    for (const listener of errorListeners) listener(error);
  };

  child.on("error", forwardError);
  child.stdin?.on("error", forwardError);
  try {
    if (!child.stdin) {
      forwardError(new Error("Node REPL child stdin is unavailable."));
    } else {
      child.stdin.end(source);
    }
  } catch (error) {
    forwardError(error instanceof Error ? error : new Error(String(error)));
  }

  return {
    on(event, listener) {
      if (event === "error") {
        const errorListener = listener as (error: Error) => void;
        errorListeners.add(errorListener);
        if (bufferedErrors.length > 0) {
          const pending = bufferedErrors.splice(0);
          queueMicrotask(() => {
            for (const error of pending) errorListener(error);
          });
        }
        return child;
      }
      child.on(event, listener as never);
      return child;
    },
    postMessage(message) {
      if (!child.connected) {
        throw new Error("Node REPL child transport is not connected.");
      }
      child.send(message);
    },
    ref() {
      child.ref();
      child.channel?.ref?.();
    },
    unref() {
      child.unref();
      child.channel?.unref?.();
    },
    async terminate() {
      if (child.exitCode === null && child.signalCode === null) child.kill();
    },
  };
};

const createNodeReplTransport = (
  source: string,
  workerData: NodeReplWorkerData,
  name: string,
): NodeReplTransport => {
  if (!isBunNodeReplRuntime()) {
    return new Worker(source, { eval: true, workerData, name });
  }
  return createExternalNodeReplTransport(source, workerData);
};

class NodeReplKernel {
  private readonly worker: NodeReplTransport;
  private readonly sky: SkyClient;
  private readonly browser: BrowserSessionClient;
  private readonly browserSessionId: string;
  private browserBackend: BrowserBackend = "in-app";
  private readonly requestBrowserExtensionConnect?: BrowserExtensionConnectRequester;
  private readonly executeTool?: NodeReplKernelManagerOptions["executeTool"];
  private readonly searchTools?: NodeReplKernelManagerOptions["searchTools"];
  private readonly describeTool?: NodeReplKernelManagerOptions["describeTool"];
  private readonly connectClient?: ReplConnectClient;
  private readonly onTerminated: (kernel: NodeReplKernel) => void;
  private tail: Promise<void> = Promise.resolve();
  private idleTimer: NodeJS.Timeout | null = null;
  private pending = 0;
  private skyTail: Promise<void> = Promise.resolve();
  private browserTail: Promise<void> = Promise.resolve();
  private connectTail: Promise<void> = Promise.resolve();
  private nextEvaluationId = 1;
  private active: ActiveEvaluation | null = null;
  private closed = false;
  private closePromise?: Promise<void>;
  private readonly browserScreenshotPaths = new Set<string>();
  readonly generationStartedAt = Date.now();

  constructor(
    readonly id: string,
    readonly generation: number,
    cwd: string,
    options: Required<
      Pick<
        NodeReplKernelManagerOptions,
        | "sessionFactory"
        | "evalTimeoutMs"
        | "commandTimeoutMs"
        | "idleTimeoutMs"
        | "toolDrainTimeoutMs"
      >
    > & {
      authorizeApp?: AuthorizeApp;
      browserBinPath?: string;
      browserSessionFactory: (
        options: BrowserSessionOptions,
      ) => BrowserSessionClient;
      requestBrowserExtensionConnect?: BrowserExtensionConnectRequester;
      executeTool?: NodeReplKernelManagerOptions["executeTool"];
      searchTools?: NodeReplKernelManagerOptions["searchTools"];
      describeTool?: NodeReplKernelManagerOptions["describeTool"];
      connectClient?: ReplConnectClient;
      toolNames: string[];
      browserSessionId: string;
      ownerLeaseId: string;
      ownerLeaseIssuedAt: number;
      generation: number;
      onIdle: (kernel: NodeReplKernel) => void;
    },
  ) {
    this.onTerminated = options.onIdle;
    this.requestBrowserExtensionConnect =
      options.requestBrowserExtensionConnect;
    this.executeTool = options.executeTool;
    this.searchTools = options.searchTools;
    this.describeTool = options.describeTool;
    this.connectClient = options.connectClient;
    this.browserSessionId = options.browserSessionId;
    const getSignal = () => this.active?.controller.signal;
    const session = options.sessionFactory({
      sessionId: id,
      cwd,
      getSignal,
      timeoutMs: options.commandTimeoutMs,
    });
    this.sky = createSkyClient({
      sessionId: id,
      session,
      getSignal,
      authorizeApp: options.authorizeApp,
    });
    this.browser = options.browserSessionFactory({
      ...(options.browserBinPath ? { binaryPath: options.browserBinPath } : {}),
      sessionId: options.browserSessionId,
      cwd,
      commandTimeoutMs: options.commandTimeoutMs,
      ownerLeaseId: options.ownerLeaseId,
      ownerLeaseIssuedAt: options.ownerLeaseIssuedAt,
    });
    const workerData: NodeReplWorkerData = {
      cwd,
      generation: options.generation,
      generationStartedAt: this.generationStartedAt,
      moduleUrl: import.meta.url,
      maxCodeBytes: MAX_NODE_REPL_CODE_BYTES,
      maxEvalOutputBytes: MAX_NODE_REPL_OUTPUT_BYTES,
      maxProtocolMessageBytes: MAX_NODE_REPL_PROTOCOL_MESSAGE_BYTES,
      maxPendingSkyCalls: MAX_NODE_REPL_PENDING_SKY_CALLS,
      maxPendingBrowserCalls: MAX_NODE_REPL_PENDING_BROWSER_CALLS,
      maxPendingToolCalls: MAX_NODE_REPL_PENDING_TOOL_CALLS,
      maxPendingConnectCalls: MAX_NODE_REPL_PENDING_CONNECT_CALLS,
      maxToolDrainWaitMs: options.toolDrainTimeoutMs,
      toolNames: options.toolNames,
    };
    this.worker = createNodeReplTransport(
      createNodeReplWorkerSource(),
      workerData,
      `stella-node-repl-${id.slice(0, 48)}`,
    );
    this.worker.on("message", (message: unknown) =>
      this.handleMessage(message),
    );
    this.worker.on("error", (error) =>
      this.handleWorkerFailure(
        error instanceof Error ? error : new Error(String(error)),
      ),
    );
    this.worker.on("exit", (code) => {
      if (!this.closed) {
        this.handleWorkerFailure(
          new Error(`Node REPL worker exited unexpectedly with code ${code}.`),
        );
      }
    });
    this.worker.unref();
    this.scheduleIdle(options.idleTimeoutMs, options.onIdle);
  }

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closed = true;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
    const active = this.active;
    if (active) {
      active.controller.abort(new Error("Node REPL kernel closed."));
      this.settleActive(
        active,
        new KernelTerminatedError("Node REPL kernel closed.", "closed"),
      );
    }
    this.closePromise = Promise.allSettled([
      this.worker.terminate(),
      this.browser.dispose(),
      this.cleanupBrowserScreenshots(),
    ]).then(() => undefined);
    return this.closePromise;
  }

  async endBrowserTurn(
    turnId: string,
    behavior: BrowserTurnEndBehavior,
  ): Promise<void> {
    await this.browser.endTurn?.(turnId, behavior);
  }

  enqueue(
    code: string,
    context: ToolContext,
    options: EvaluateOptions,
    defaults: { evalTimeoutMs: number; idleTimeoutMs: number },
    onIdle: (kernel: NodeReplKernel) => void,
  ): Promise<NodeReplEvaluationResult> {
    if (this.closed) {
      return Promise.reject(
        new KernelTerminatedError("Kernel closed.", "closed"),
      );
    }
    if (byteLength(code) > MAX_NODE_REPL_CODE_BYTES) {
      return Promise.reject(
        new Error(
          `Node REPL input exceeds the ${MAX_NODE_REPL_CODE_BYTES}-byte limit.`,
        ),
      );
    }
    this.pending += 1;
    this.worker.ref();
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
    const run = async () => {
      if (this.closed) {
        throw new KernelTerminatedError("Kernel closed.", "closed");
      }
      return await this.evaluate(
        code,
        context,
        options.timeoutMs ?? defaults.evalTimeoutMs,
        options.signal,
        options.onToolResult,
        options.onToolUpdate,
        options.onResponseMeta,
        options.onContent,
      );
    };
    const task = this.tail.then(run, run);
    this.tail = task.then(
      () => undefined,
      () => undefined,
    );
    const finish = () => {
      this.pending -= 1;
      if (!this.closed && this.pending === 0) {
        this.worker.unref();
        this.scheduleIdle(defaults.idleTimeoutMs, onIdle);
      }
    };
    void task.then(finish, finish);
    return task;
  }

  private scheduleIdle(
    timeoutMs: number,
    onIdle: (kernel: NodeReplKernel) => void,
  ) {
    this.idleTimer = setTimeout(() => onIdle(this), timeoutMs);
    this.idleTimer.unref();
  }

  private evaluate(
    code: string,
    context: ToolContext,
    timeoutMs: number,
    signal?: AbortSignal,
    onToolResult?: (result: ToolResult) => void,
    onToolUpdate?: ToolUpdateCallback,
    onResponseMeta?: (meta: BrowserUseResponseMeta) => void,
    onContent?: (item: NodeReplContentItem, cursor: number) => void,
  ): Promise<NodeReplEvaluationResult> {
    if (signal?.aborted) {
      return Promise.reject(
        new KernelTerminatedError(abortError(signal).message, "cancelled"),
      );
    }
    if (BLOCKED_NODE_MODULE_RE.test(code)) {
      return Promise.reject(
        new Error(
          "Direct process spawning is blocked in node_repl; use sky for computer use or exec_command for explicit shell work.",
        ),
      );
    }

    return new Promise<NodeReplEvaluationResult>((resolve, reject) => {
      const id = this.nextEvaluationId++;
      const controller = new AbortController();
      const timeout = setTimeout(() => {
        this.terminateActive(
          new KernelTerminatedError(
            `Node REPL timed out after ${timeoutMs}ms.`,
            "timeout",
          ),
        );
      }, timeoutMs);
      const active: ActiveEvaluation = {
        id,
        controller,
        timeout,
        signal,
        resolve,
        reject,
        context,
        onToolResult,
        onToolUpdate,
        onResponseMeta,
        onContent,
        content: [],
        nextContentCursor: 1,
        browserActivity: {
          callCount: 0,
          mutated: false,
          screenshotAttachments: [],
          terminalLifecycle: false,
        },
      };
      this.active = active;
      if (signal) {
        active.onAbort = () => {
          this.terminateActive(
            new KernelTerminatedError(abortError(signal).message, "cancelled"),
          );
        };
        signal.addEventListener("abort", active.onAbort, { once: true });
        if (signal.aborted) {
          active.onAbort();
          return;
        }
      }
      try {

        this.post({
          type: "evaluate",
          evaluationId: id,
          code,
          toolNames: replToolNamesForContext(context),
        });
      } catch (error) {
        this.terminateActive(
          new KernelTerminatedError(
            `Failed to send Node REPL evaluation: ${error instanceof Error ? error.message : String(error)}`,
            "transport_error",
          ),
        );
      }
    });
  }

  private post(message: ParentToNodeReplWorkerMessage) {
    this.worker.postMessage(message);
  }

  private handleMessage(message: unknown) {
    if (!message || typeof message !== "object" || !("type" in message)) return;
    const typed = message as WorkerToNodeReplParentMessage;
    if (typed.type === "ready") return;
    if (typed.type === "reset-request") {
      const active = this.active;
      if (
        active &&
        typed.evaluationId === active.id &&
        Number.isFinite(typed.requestedAt)
      ) {
        active.resetRequestedAt = typed.requestedAt;
      }
      return;
    }
    if (typed.type === "sky-call") {
      const run = () => this.handleSkyCall(typed);
      const task = this.skyTail.then(run, run);
      this.skyTail = task.then(
        () => undefined,
        () => undefined,
      );
      return;
    }
    if (typed.type === "browser-call") {
      const run = () => this.handleBrowserCall(typed);
      const task = this.browserTail.then(run, run);
      this.browserTail = task.then(
        () => undefined,
        () => undefined,
      );
      return;
    }
    if (typed.type === "connect-call") {
      const run = () => this.handleConnectCall(typed);
      const task = this.connectTail.then(run, run);
      this.connectTail = task.then(
        () => undefined,
        () => undefined,
      );
      return;
    }
    if (typed.type === "tool-call") {
      void this.handleToolCall(typed);
      return;
    }

    const active = this.active;
    if (!active || typed.evaluationId !== active.id) return;
    if (typed.type === "evaluation-content") {
      if (
        typed.cursor !== active.nextContentCursor ||
        !isNodeReplContentItem(typed.item) ||
        serializedSize(typed.item) > MAX_NODE_REPL_OUTPUT_BYTES
      ) {
        this.terminateActive(
          new KernelTerminatedError(
            "Node REPL worker returned invalid or out-of-order content.",
            "protocol_error",
          ),
        );
        return;
      }
      active.content.push(typed.item);
      active.nextContentCursor += 1;
      try {
        active.onContent?.(typed.item, typed.cursor);
      } catch {

      }
      return;
    }
    if (typed.type === "evaluation-result") {
      if (
        typed.finalCursor !== active.content.length ||
        serializedSize(active.content) > MAX_NODE_REPL_OUTPUT_BYTES
      ) {
        this.terminateActive(
          new KernelTerminatedError(
            "Node REPL worker returned invalid or oversized output.",
            "protocol_error",
          ),
        );
        return;
      }
      const explicitReset =
        active.resetRequestedAt === undefined
          ? undefined
          : resetReceipt(this.generation, "explicit", active.resetRequestedAt);
      void this.completeEvaluation(
        active,
        active.content,
        undefined,
        explicitReset,
      );
      return;
    }
    if (typed.type === "evaluation-error") {
      if (typed.finalCursor !== active.content.length) {
        this.terminateActive(
          new KernelTerminatedError(
            "Node REPL worker returned an invalid terminal content cursor.",
            "protocol_error",
          ),
        );
        return;
      }
      const error = deserializeError(typed.error);
      if (active.resetRequestedAt !== undefined) {
        const receipt = resetReceipt(
          this.generation,
          "explicit",
          active.resetRequestedAt,
        );
        void this.completeEvaluation(
          active,
          active.content,
          new KernelTerminatedError(
            error.message,
            "explicit",
            active.resetRequestedAt,
            receipt,
          ),
          receipt,
        );
        return;
      }
      if (error.name === NODE_REPL_UNCAUGHT_ERROR_NAME) {

        void this.completeEvaluation(
          active,
          active.content,
          new KernelTerminatedError(error.message, "uncaught_error"),
          resetReceipt(this.generation, "uncaught_error"),
        );
        return;
      }
      void this.completeEvaluation(active, active.content, error);
    }
  }

  private async handleSkyCall(
    message: Extract<WorkerToNodeReplParentMessage, { type: "sky-call" }>,
  ) {
    const active = this.active;
    if (
      !active ||
      message.evaluationId !== active.id ||
      !SKY_METHODS.has(message.method) ||
      !Array.isArray(message.args) ||
      serializedSize(message.args) > MAX_NODE_REPL_PROTOCOL_MESSAGE_BYTES
    ) {
      this.postSkyError(
        message.callId,
        new Error("Invalid sky protocol request."),
      );
      return;
    }

    try {
      const method = this.sky[message.method] as (
        ...args: unknown[]
      ) => Promise<unknown>;
      const value = await method(...message.args);
      if (serializedSize(value) > MAX_NODE_REPL_PROTOCOL_MESSAGE_BYTES) {
        throw new Error("sky result exceeds the protocol limit.");
      }
      if (!this.closed && this.active === active) {
        this.post({
          type: "sky-result",
          callId: message.callId,
          ok: true,
          value,
        });
      }
    } catch (error) {
      if (!this.closed && this.active === active) {
        this.postSkyError(message.callId, error);
      }
    }
  }

  private async handleConnectCall(
    message: Extract<WorkerToNodeReplParentMessage, { type: "connect-call" }>,
  ) {
    const active = this.active;
    if (
      !active ||
      message.evaluationId !== active.id ||
      !CONNECT_METHODS.has(message.method) ||
      !Array.isArray(message.args) ||
      serializedSize(message.args) > MAX_NODE_REPL_PROTOCOL_MESSAGE_BYTES
    ) {
      this.postConnectError(
        message.callId,
        new Error("Invalid connect protocol request."),
      );
      return;
    }

    try {
      const client = this.connectClient;
      if (!client) {
        throw new Error("connect is not available in this session.");
      }
      const value = await this.dispatchConnectCall(
        client,
        message.method,
        message.args,
      );
      if (serializedSize(value) > MAX_NODE_REPL_PROTOCOL_MESSAGE_BYTES) {
        throw new Error("connect result exceeds the protocol limit.");
      }
      if (!this.closed && this.active === active) {
        this.post({
          type: "connect-result",
          callId: message.callId,
          ok: true,
          value,
        });
      }
    } catch (error) {
      if (!this.closed && this.active === active) {
        this.postConnectError(message.callId, error);
      }
    }
  }

  private dispatchConnectCall(
    client: ReplConnectClient,
    method: ConnectMethod,
    args: readonly unknown[],
  ): Promise<unknown> {
    const isNonEmptyString = (value: unknown): value is string =>
      typeof value === "string" && value.trim().length > 0;
    const isPlainRecord = (value: unknown): value is Record<string, unknown> =>
      value !== null && typeof value === "object" && !Array.isArray(value);
    const invalid = () =>
      Promise.reject(new Error("Invalid connect protocol request."));
    switch (method) {
      case "discover":
        return isNonEmptyString(args[0]) ? client.discover(args[0]) : invalid();
      case "connectors":
        return client.connectors();
      case "actions": {
        if (!isNonEmptyString(args[0])) return invalid();
        if (args[1] !== undefined && !isPlainRecord(args[1])) return invalid();
        const options = isPlainRecord(args[1]) ? args[1] : {};
        return client.actions(args[0], {
          ...(typeof options.query === "string"
            ? { query: options.query }
            : {}),
          ...(typeof options.limit === "number"
            ? { limit: options.limit }
            : {}),
        });
      }
      case "schema":
        return isNonEmptyString(args[0]) && isNonEmptyString(args[1])
          ? client.schema(args[0], args[1])
          : invalid();
      case "call": {
        if (!isNonEmptyString(args[0]) || !isNonEmptyString(args[1])) {
          return invalid();
        }
        if (args[2] !== undefined && !isPlainRecord(args[2])) return invalid();
        return client.call(
          args[0],
          args[1],
          isPlainRecord(args[2]) ? args[2] : {},
        );
      }
      case "addMcp":
        return isPlainRecord(args[0]) ? client.addMcp(args[0]) : invalid();
      case "remove":
        return isNonEmptyString(args[0]) ? client.remove(args[0]) : invalid();
    }
  }

  private postConnectError(callId: number, error: unknown) {
    if (this.closed) return;
    try {
      this.post({
        type: "connect-result",
        callId,
        ok: false,
        error: serializeError(error),
      });
    } catch (postError) {
      this.handleWorkerFailure(
        postError instanceof Error ? postError : new Error(String(postError)),
      );
    }
  }

  private postSkyError(callId: number, error: unknown) {
    if (this.closed) return;
    try {
      this.post({
        type: "sky-result",
        callId,
        ok: false,
        error: serializeError(error),
      });
    } catch (postError) {
      this.handleWorkerFailure(
        postError instanceof Error ? postError : new Error(String(postError)),
      );
    }
  }

  private async handleBrowserCall(
    message: Extract<WorkerToNodeReplParentMessage, { type: "browser-call" }>,
  ) {
    const active = this.active;
    if (
      !active ||
      message.evaluationId !== active.id ||
      !BROWSER_METHODS.has(message.method) ||
      !Array.isArray(message.args) ||
      serializedSize(message.args) > MAX_NODE_REPL_PROTOCOL_MESSAGE_BYTES
    ) {
      this.postBrowserError(
        message.callId,
        new Error("Invalid browser protocol request."),
      );
      return;
    }

    try {
      const turnId =
        active.context.runId ??
        active.context.rootRunId ??
        active.context.requestId;
      this.browser.beginTurn?.(turnId);
      let value: unknown;
      try {
        value = await this.executeBrowserMessage(active, message);
      } catch (error) {
        const outcome = await maybeRequestBrowserExtensionConnect({
          output: error instanceof Error ? error.message : String(error),
          command: "stella-browser node_repl",
          requestConnect: this.requestBrowserExtensionConnect,
          conversationId: active.context.conversationId,
          agentId: active.context.agentId,
          signal: active.controller.signal,
        });
        if (!outcome?.ok) throw error;
        value = await this.executeBrowserMessage(active, message);
      }
      value = await this.prepareBrowserScreenshotResult(active, message, value);
      if (serializedSize(value) > MAX_NODE_REPL_PROTOCOL_MESSAGE_BYTES) {
        throw new Error("browser result exceeds the protocol limit.");
      }
      this.recordBrowserActivity(active, message, value);
      if (!this.closed && this.active === active) {
        this.post({
          type: "browser-result",
          callId: message.callId,
          ok: true,
          value,
        });
      }
    } catch (error) {
      if (!this.closed && this.active === active) {
        this.postBrowserError(message.callId, error);
      }
    }
  }

  private async prepareBrowserScreenshotResult(
    active: ActiveEvaluation,
    message: Extract<WorkerToNodeReplParentMessage, { type: "browser-call" }>,
    value: unknown,
  ): Promise<unknown> {
    const receipt = this.recordValue(value);
    const result = this.recordValue(receipt?.result);
    const data = this.recordValue(result?.data);
    if (!data) return value;

    if (message.method === "command" && message.args[0] === "screenshot") {
      const params = this.recordValue(message.args[1]);
      await this.materializeBrowserScreenshot(active, data, {
        base64Key: "base64",
        pathKey: "path",
        format: data.format ?? params?.format,
      });
      return value;
    }

    if (message.method !== "chain") return value;
    const steps = Array.isArray(message.args[0]) ? message.args[0] : [];
    const results = Array.isArray(data.results) ? data.results : [];
    for (let index = 0; index < steps.length; index += 1) {
      const step = this.recordValue(steps[index]);
      if (step?.action !== "screenshot") continue;
      const stepResult = this.recordValue(results[index]);
      const stepData = this.recordValue(stepResult?.data);
      if (!stepData) continue;
      const stepParams = this.recordValue(step.params);
      await this.materializeBrowserScreenshot(active, stepData, {
        base64Key: "base64",
        pathKey: "path",
        format: stepData.format ?? stepParams?.format,
      });
    }

    const options = this.recordValue(message.args[1]);
    if (options?.returnScreenshot === true) {
      await this.materializeBrowserScreenshot(active, data, {
        base64Key: "screenshot",
        pathKey: "screenshotPath",
        format: data.screenshotFormat,
      });
    }
    return value;
  }

  private recordValue(value: unknown): Record<string, unknown> | undefined {
    return value !== null && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;
  }

  private async materializeBrowserScreenshot(
    active: ActiveEvaluation,
    data: Record<string, unknown>,
    options: {
      base64Key: string;
      pathKey: string;
      format: unknown;
    },
  ): Promise<void> {
    const encoded = data[options.base64Key];
    const existingPath = data[options.pathKey];
    const format = this.browserScreenshotFormat(
      options.format,
      typeof existingPath === "string" ? existingPath : undefined,
    );
    let screenshotPath =
      typeof existingPath === "string" && path.isAbsolute(existingPath)
        ? existingPath
        : undefined;

    if (typeof encoded === "string") {
      delete data[options.base64Key];
      if (encoded) {
        screenshotPath = await this.writeBrowserScreenshot(encoded, format);
        data[options.pathKey] = screenshotPath;
      }
    }

    if (!screenshotPath) return;
    const attachment = {
      path: screenshotPath,
      mimeType: format === "png" ? "image/png" : "image/jpeg",
      deleteAfterAttach: this.browserScreenshotPaths.has(screenshotPath),
    } as const;
    if (
      !active.browserActivity.screenshotAttachments.some(
        (candidate) => candidate.path === attachment.path,
      )
    ) {
      active.browserActivity.screenshotAttachments.push(attachment);
    }
  }

  private browserScreenshotFormat(
    value: unknown,
    screenshotPath?: string,
  ): "jpeg" | "png" {
    if (value === "png") return "png";
    if (value === "jpeg" || value === "jpg") return "jpeg";
    return screenshotPath?.toLowerCase().endsWith(".png") ? "png" : "jpeg";
  }

  private async writeBrowserScreenshot(
    encoded: string,
    format: "jpeg" | "png",
  ): Promise<string> {
    const directory = path.join(os.tmpdir(), "stella-browser-repl");
    await mkdir(directory, { recursive: true });
    const screenshotPath = path.join(
      directory,
      `${randomUUID()}.${format === "png" ? "png" : "jpeg"}`,
    );
    await writeFile(screenshotPath, Buffer.from(encoded, "base64"));
    this.browserScreenshotPaths.add(screenshotPath);
    while (
      this.browserScreenshotPaths.size > MAX_BROWSER_SCREENSHOT_FILES_PER_KERNEL
    ) {
      const oldest = this.browserScreenshotPaths.values().next().value;
      if (typeof oldest !== "string") break;
      this.browserScreenshotPaths.delete(oldest);
      await rm(oldest, { force: true }).catch(() => undefined);
    }
    return screenshotPath;
  }

  private async executeBrowserMessage(
    active: ActiveEvaluation,
    message: Extract<WorkerToNodeReplParentMessage, { type: "browser-call" }>,
  ): Promise<unknown> {
    if (message.method === "use") {
      if (
        message.args.length !== 1 ||
        (message.args[0] !== "in-app" && message.args[0] !== "external")
      ) {
        throw new Error("Invalid browser backend arguments.");
      }
      if (!this.browser.selectBackend) {
        throw new Error("Browser backend selection is unavailable.");
      }
      const backend = message.args[0] as BrowserBackend;
      const result = await this.browser.selectBackend(backend);
      this.browserBackend = backend;
      return result;
    }
    if (message.method === "command") {
      if (message.args.length < 1 || message.args.length > 2) {
        throw new Error("Invalid browser command arguments.");
      }
      return await this.browser.command(
        message.args[0] as BrowserProtocolAction,
        message.args[1] as BrowserCommandParams | undefined,
        { signal: active.controller.signal },
      );
    }
    if (message.args.length < 1 || message.args.length > 2) {
      throw new Error("Invalid browser chain arguments.");
    }
    const wireOptions =
      message.args[1] && typeof message.args[1] === "object"
        ? (message.args[1] as Record<string, unknown>)
        : {};
    const wireDelay =
      wireOptions.delay && typeof wireOptions.delay === "object"
        ? (wireOptions.delay as Record<string, unknown>)
        : undefined;
    const boundBackend = wireOptions[WORKER_BOUND_BACKEND_PARAM];
    if (
      boundBackend !== undefined &&
      boundBackend !== "in-app" &&
      boundBackend !== "external"
    ) {
      throw new Error("Invalid bound browser backend.");
    }
    const chainOptions: BrowserChainOptions = {
      signal: active.controller.signal,
      ...(wireOptions.timeout === undefined
        ? {}
        : { timeoutMs: wireOptions.timeout as number }),
      ...(wireOptions.abortOnError === undefined
        ? {}
        : { abortOnError: wireOptions.abortOnError as boolean }),
      ...(wireDelay
        ? {
            delay: {
              minMs: wireDelay.min as number | undefined,
              maxMs: wireDelay.max as number | undefined,
            },
          }
        : {}),
      ...(wireOptions.waitForSelector === undefined
        ? {}
        : { waitForSelector: wireOptions.waitForSelector as boolean }),
      ...(wireOptions.waitTimeout === undefined
        ? {}
        : { waitTimeoutMs: wireOptions.waitTimeout as number }),
      ...(wireOptions.returnSnapshot === undefined
        ? {}
        : { returnSnapshot: wireOptions.returnSnapshot as boolean }),
      ...(wireOptions.returnScreenshot === undefined
        ? {}
        : { returnScreenshot: wireOptions.returnScreenshot as boolean }),
      ...(boundBackend === undefined
        ? {}
        : { [WORKER_BOUND_BACKEND_PARAM]: boundBackend }),
    };
    return await this.browser.chain(
      message.args[0] as readonly BrowserChainStep[],
      chainOptions,
    );
  }

  private postBrowserError(callId: number, error: unknown) {
    if (this.closed) return;
    try {
      this.post({
        type: "browser-result",
        callId,
        ok: false,
        error: serializeError(error),
      });
    } catch (postError) {
      this.handleWorkerFailure(
        postError instanceof Error ? postError : new Error(String(postError)),
      );
    }
  }

  private async handleToolCall(
    message: Extract<WorkerToNodeReplParentMessage, { type: "tool-call" }>,
  ) {
    const active = this.active;
    if (
      !active ||
      message.evaluationId !== active.id ||
      !message.args ||
      typeof message.args !== "object" ||
      Array.isArray(message.args) ||
      serializedSize(message.args) > MAX_NODE_REPL_PROTOCOL_MESSAGE_BYTES
    ) {
      this.postToolError(
        message.callId,
        new Error("Invalid or unauthorized tool protocol request."),
      );
      return;
    }

    if (message.toolName === NODE_REPL_TOOL_SEARCH_NAME) {
      try {
        if (!this.searchTools) {
          throw new Error("tools.$search is not available in this session.");
        }
        const query =
          typeof message.args.query === "string" ? message.args.query : "";
        if (!query.trim()) {
          throw new Error(
            'tools.$search requires a non-empty { query: "<intent + key nouns>" }.',
          );
        }
        const rawLimit = message.args.limit;
        const limit =
          typeof rawLimit === "number" && Number.isFinite(rawLimit)
            ? rawLimit
            : undefined;
        const results = enrichToolSearchResults(
          await this.searchTools(query, active.context, limit),
        );
        if (serializedSize(results) > MAX_NODE_REPL_PROTOCOL_MESSAGE_BYTES) {
          throw new Error(
            "Tool search result exceeds the Node REPL protocol limit.",
          );
        }
        if (!this.closed && this.active === active) {
          this.post({
            type: "tool-result",
            callId: message.callId,
            ok: true,
            value: results,
          });
        }
      } catch (error) {
        if (!this.closed && this.active === active) {
          this.postToolError(message.callId, error);
        }
      }
      return;
    }

    if (message.toolName === NODE_REPL_TOOL_DESCRIBE_NAME) {
      try {
        if (!this.describeTool) {
          throw new Error("tools.$describe is not available in this session.");
        }
        const name = message.args.name;
        if (typeof name !== "string" || name.trim().length === 0) {
          throw new Error(
            "tools.$describe requires an exact non-empty tool name string.",
          );
        }
        const rawCursor = message.args.cursor;
        if (
          rawCursor !== undefined &&
          (typeof rawCursor !== "number" ||
            !Number.isSafeInteger(rawCursor) ||
            rawCursor < 0)
        ) {
          throw new Error(
            "tools.$describe cursor must be a non-negative safe integer.",
          );
        }
        const result = await this.describeTool(
          name,
          active.context,
          rawCursor as number | undefined,
        );
        if (serializedSize(result) > MAX_NODE_REPL_PROTOCOL_MESSAGE_BYTES) {
          throw new Error(
            "Tool description exceeds the Node REPL protocol limit. The host must provide deterministic paged retrieval.",
          );
        }
        if (!this.closed && this.active === active) {
          this.post({
            type: "tool-result",
            callId: message.callId,
            ok: true,
            value: result,
          });
        }
      } catch (error) {
        if (!this.closed && this.active === active) {
          this.postToolError(message.callId, error);
        }
      }
      return;
    }

    const allowedToolNames = new Set(active.context.allowedToolNames ?? []);
    if (
      !this.executeTool ||
      NODE_REPL_EXCLUDED_TOOL_NAMES.has(message.toolName) ||
      !allowedToolNames.has(message.toolName)
    ) {
      this.postToolError(
        message.callId,
        new Error("Invalid or unauthorized tool protocol request."),
      );
      return;
    }

    try {
      const result = await this.executeTool(
        message.toolName,
        message.args,
        active.context,
        active.controller.signal,
        (update) => {
          if (!this.closed && this.active === active) {
            active.onToolUpdate?.(update);
          }
        },
      );
      if (!this.closed && this.active === active) {
        active.onToolResult?.(result);
      }
      if (result.error) throw new Error(result.error);
      if (
        serializedSize(result.result) > MAX_NODE_REPL_PROTOCOL_MESSAGE_BYTES
      ) {
        throw new Error("Tool result exceeds the Node REPL protocol limit.");
      }
      if (!this.closed && this.active === active) {
        this.post({
          type: "tool-result",
          callId: message.callId,
          ok: true,
          value: result.result,
        });
      }
    } catch (error) {
      if (!this.closed && this.active === active) {
        this.postToolError(message.callId, error);
      }
    }
  }

  private postToolError(callId: number, error: unknown) {
    if (this.closed) return;
    try {
      this.post({
        type: "tool-result",
        callId,
        ok: false,
        error: serializeError(error),
      });
    } catch (postError) {
      this.handleWorkerFailure(
        postError instanceof Error ? postError : new Error(String(postError)),
      );
    }
  }

  private recordBrowserActivity(
    active: ActiveEvaluation,
    message: Extract<WorkerToNodeReplParentMessage, { type: "browser-call" }>,
    value: unknown,
  ) {
    if (message.method === "use") return;
    const actions: Array<{
      action: string;
      params?: Record<string, unknown>;
    }> = [];
    const receipt = this.recordValue(value);
    const result = this.recordValue(receipt?.result);
    const data = this.recordValue(result?.data);
    const chainResults = Array.isArray(data?.results) ? data.results : [];
    const resultTabId = (candidate: unknown): number | undefined => {
      const record = this.recordValue(candidate);
      const nested = this.recordValue(record?.data) ?? record;
      const id = nested?.id ?? nested?.tabId;
      return typeof id === "number" && Number.isInteger(id) && id > 0
        ? id
        : undefined;
    };
    const routingParams =
      message.method === "command"
        ? this.recordValue(message.args[1])
        : message.method === "chain"
          ? this.recordValue(message.args[1])
          : undefined;
    const boundBackend = routingParams?.[WORKER_BOUND_BACKEND_PARAM];
    const actionBackend: BrowserBackend =
      boundBackend === "in-app" || boundBackend === "external"
        ? boundBackend
        : this.browserBackend;
    if (message.method === "command") {
      if (typeof message.args[0] === "string") {
        const returnedTabId = resultTabId(data);
        actions.push({
          action: message.args[0],
          params: {
            ...(this.recordValue(message.args[1]) ?? {}),
            ...(returnedTabId ? { resultTabId: returnedTabId } : {}),
          },
        });
      }
    } else if (Array.isArray(message.args[0])) {
      for (let index = 0; index < message.args[0].length; index += 1) {
        const step = message.args[0][index];
        const entry = this.recordValue(step);
        if (typeof entry?.action !== "string") continue;
        const returnedTabId = resultTabId(chainResults[index]);
        actions.push({
          action: entry.action,
          params: {
            ...(this.recordValue(entry.params) ?? {}),
            ...(returnedTabId ? { resultTabId: returnedTabId } : {}),
          },
        });
      }
    }
    active.browserActivity.callCount += 1;
    for (const { action, params } of actions) {
      active.browserActivity.lastAction = action;
      active.browserActivity.lastBackend = actionBackend;
      if (action === "finalize_tabs" || action === "close_owner") {
        active.browserActivity.terminalLifecycle = true;
      }
      if (!READ_ONLY_BROWSER_ACTIONS.has(action)) {
        active.browserActivity.mutated = true;
      }
      if (BROWSER_PRESENTATION_ACTIONS.has(action)) {
        const tabId = params?.tabId ?? params?.resultTabId;
        active.browserActivity.presentationAction = {
          action,
          backend: actionBackend,
          ...(typeof tabId === "number" && Number.isInteger(tabId) && tabId > 0
            ? { tabId }
            : {}),
        };
      }
    }
  }

  private presentationSignal(active: ActiveEvaluation): {
    signal: AbortSignal;
    dispose: () => void;
  } {
    const controller = new AbortController();
    const forwardAbort = () =>
      controller.abort(
        active.controller.signal.reason ??
          new Error("Node REPL evaluation aborted."),
      );
    active.controller.signal.addEventListener("abort", forwardAbort, {
      once: true,
    });
    if (active.controller.signal.aborted) forwardAbort();
    const timeout = setTimeout(
      () =>
        controller.abort(
          new Error(
            `Browser presentation timed out after ${BROWSER_PRESENTATION_TIMEOUT_MS}ms.`,
          ),
        ),
      BROWSER_PRESENTATION_TIMEOUT_MS,
    );
    timeout.unref();
    return {
      signal: controller.signal,
      dispose: () => {
        clearTimeout(timeout);
        active.controller.signal.removeEventListener("abort", forwardAbort);
      },
    };
  }

  private async readBrowserPresentationTabs(
    signal: AbortSignal,
    backend: BrowserBackend,
  ): Promise<BrowserPresentationTabs> {
    const backendParams =
      backend === this.browserBackend
        ? {}
        : { [WORKER_BOUND_BACKEND_PARAM]: backend };
    const tabsReceipt = await this.browser.command<Record<string, unknown>>(
      "tab_list",
      backendParams,
      { signal },
    );
    const tabsData = tabsReceipt.result.data ?? {};
    const sourceTabs = Array.isArray(tabsData.tabs) ? tabsData.tabs : [];
    const tabs: BrowserPresentationTab[] = [];
    for (const sourceTab of sourceTabs) {
      const tab = this.recordValue(sourceTab);
      if (
        typeof tab?.tabId !== "number" ||
        !Number.isInteger(tab.tabId) ||
        tab.tabId <= 0
      ) {
        continue;
      }
      tabs.push({
        tabId: tab.tabId,
        active: tab.active === true,
        ...(typeof tab.url === "string" ? { url: tab.url } : {}),
      });
    }
    let activeTabId =
      typeof tabsData.activeTabId === "number" &&
      Number.isInteger(tabsData.activeTabId) &&
      tabsData.activeTabId > 0
        ? tabsData.activeTabId
        : undefined;
    activeTabId ??= tabs.find((tab) => tab.active)?.tabId;
    return { tabs, ...(activeTabId ? { activeTabId } : {}) };
  }

  private deliverBrowserResponseMeta(
    active: ActiveEvaluation,
    meta: BrowserUseResponseMeta,
  ) {
    active.responseMeta = meta;
    try {
      active.onResponseMeta?.(meta);
    } catch {

    }
  }

  private async captureBrowserResponseMeta(
    active: ActiveEvaluation,
    tabState: BrowserPresentationTabs | undefined,
    signal: AbortSignal,
  ): Promise<void> {
    const activity = active.browserActivity;
    if (!active.onResponseMeta) return;
    if (activity.terminalLifecycle) {
      const backend = activity.lastBackend ?? this.browserBackend;
      this.deliverBrowserResponseMeta(active, {
        "stella/browserUse": true,
        "stella/toolSurface": {
          kind: "browserUse",
          backend: backend === "external" ? "extension" : "iab",
          browserId: this.browserSessionId,
          openTabIds: [],
          sessionEnded: true,
        },
      });
      return;
    }

    const presentation = activity.presentationAction;
    if (!presentation) return;
    const tabs = tabState?.tabs ?? [];
    const activeTab = tabs.find((tab) => tab.tabId === tabState?.activeTabId);

    const screenshotTab =
      presentation.action === "tab_close"
        ? (activeTab ?? tabs[0])
        : presentation.tabId
          ? tabs.find((tab) => tab.tabId === presentation.tabId)
          : (activeTab ?? tabs[0]);
    let screenshot:
      | NonNullable<BrowserUseResponseMeta["stella/toolSurface"]["screenshot"]>
      | undefined;
    if (screenshotTab) {
      try {
        const backendParams =
          presentation.backend === this.browserBackend
            ? {}
            : { [WORKER_BOUND_BACKEND_PARAM]: presentation.backend };
        const receipt = await this.browser.command<{
          base64?: string;
          format?: string;
        }>(
          "screenshot",
          {
            tabId: screenshotTab.tabId,
            format: "jpeg",
            ...backendParams,
          },
          { signal },
        );
        const encoded = receipt.result.data?.base64;
        if (typeof encoded === "string" && encoded) {
          const pageUrl = screenshotTab.url
            ? browserPageOrigin(screenshotTab.url)
            : undefined;
          screenshot = {
            tabId: String(screenshotTab.tabId),
            url: `data:image/jpeg;base64,${encoded}`,
            ...(pageUrl ? { pageUrl } : {}),
          };
        }
      } catch {

      }
    }
    const visibleUrl = screenshotTab?.url
      ? sanitizedBrowserUrl(screenshotTab.url)
      : undefined;
    this.deliverBrowserResponseMeta(active, {
      "stella/browserUse": true,
      "stella/toolSurface": {
        kind: "browserUse",
        backend: presentation.backend === "external" ? "extension" : "iab",
        browserId: this.browserSessionId,
        openTabIds: tabs.map((tab) => String(tab.tabId)),
        sessionEnded: false,
        ...(screenshot ? { screenshot } : {}),
      },
      ...(visibleUrl ? { browser_use: { url: visibleUrl } } : {}),
    });
  }

  private async completeEvaluation(
    active: ActiveEvaluation,
    workerContent: readonly NodeReplContentItem[] | undefined,
    error?: Error,
    terminalReset?: NodeReplResetReceipt,
  ) {
    if (this.active !== active) return;
    const activity = active.browserActivity;
    const needsPresentation =
      Boolean(active.onResponseMeta) &&
      (activity.terminalLifecycle || Boolean(activity.presentationAction));

    if (needsPresentation) clearTimeout(active.timeout);
    const content: NodeReplContentItem[] = [...(workerContent ?? [])];
    if (!error) {
      for (const attachment of activity.screenshotAttachments) {

        if (attachment.deleteAfterAttach) {
          this.browserScreenshotPaths.delete(attachment.path);
        }
        content.push({
          type: "image",
          path: attachment.path,
          mimeType: attachment.mimeType,
          ...(attachment.deleteAfterAttach ? { deleteAfterAttach: true } : {}),
        });
      }
    }

    let tabState: BrowserPresentationTabs | undefined;
    let tabStateUnavailable = false;
    const needsTabState =
      !activity.terminalLifecycle &&
      ((activity.mutated && !error) ||
        (needsPresentation && Boolean(activity.presentationAction)));
    if (needsTabState) {
      const presentation = activity.presentationAction
        ? this.presentationSignal(active)
        : undefined;
      try {
        tabState = await this.readBrowserPresentationTabs(
          presentation?.signal ?? active.controller.signal,
          activity.presentationAction?.backend ??
            activity.lastBackend ??
            this.browserBackend,
        );
        if (needsPresentation && presentation) {
          await this.captureBrowserResponseMeta(
            active,
            tabState,
            presentation.signal,
          );
        }
      } catch {
        tabStateUnavailable = true;
        if (needsPresentation && presentation) {
          await this.captureBrowserResponseMeta(
            active,
            undefined,
            presentation.signal,
          );
        }
      } finally {
        presentation?.dispose();
      }
    } else if (needsPresentation) {
      await this.captureBrowserResponseMeta(
        active,
        undefined,
        active.controller.signal,
      );
    }

    if (!error && activity.callCount > 0) {
      if (!activity.mutated || activity.terminalLifecycle) {
        const receipt = `[browser-receipt] calls=${activity.callCount} mutated=${activity.mutated}${
          activity.lastAction ? ` last=${activity.lastAction}` : ""
        }`;
        content.push({ type: "text", text: receipt });
      } else if (tabState) {
        const receipt = `[browser-receipt] calls=${activity.callCount} mutated=${activity.mutated} tabs=${tabState.tabs.length}${
          tabState.activeTabId === undefined
            ? ""
            : ` activeTabId=${tabState.activeTabId}`
        }${activity.lastAction ? ` last=${activity.lastAction}` : ""}`;
        content.push({ type: "text", text: receipt });
      } else if (tabStateUnavailable) {
        const receipt = `[browser-receipt] calls=${activity.callCount} mutated=${activity.mutated}${
          activity.lastAction ? ` last=${activity.lastAction}` : ""
        } settled_state=unavailable`;
        content.push({ type: "text", text: receipt });
      }
    }
    if (this.active !== active) return;
    if (terminalReset && error && !active.controller.signal.aborted) {
      active.controller.abort(error);
    }
    this.settleActive(active, error ?? null, {
      output: formatNodeReplContent(content),
      content,
      generation: this.generation,
      ...(terminalReset ? { reset: terminalReset } : {}),
      ...(active.responseMeta ? { responseMeta: active.responseMeta } : {}),
    });
    if (terminalReset) {
      void this.close();
      this.onTerminated(this);
    }
  }

  private async cleanupBrowserScreenshots(): Promise<void> {
    const paths = [...this.browserScreenshotPaths];
    this.browserScreenshotPaths.clear();
    await Promise.allSettled(
      paths.map((filePath) => rm(filePath, { force: true })),
    );
  }

  private terminateActive(error: KernelTerminatedError) {
    const active = this.active;
    if (!active) return;
    active.controller.abort(error);
    this.settleActive(active, error);
    void this.close();
  }

  terminate(reason = "Node REPL cell terminated by caller."): void {
    const active = this.active;
    if (!active) {
      void this.close();
      this.onTerminated(this);
      return;
    }
    const terminated = new KernelTerminatedError(reason, "terminated");
    this.terminateActive(terminated);
    this.onTerminated(this);
  }

  private settleActive(
    active: ActiveEvaluation,
    error: Error | null,
    result: NodeReplEvaluationResult = {
      output: "",
      content: [],
      generation: this.generation,
    },
  ) {
    if (this.active !== active) return;
    this.active = null;
    clearTimeout(active.timeout);
    if (active.signal && active.onAbort) {
      active.signal.removeEventListener("abort", active.onAbort);
    }
    if (!active.controller.signal.aborted) {
      active.controller.abort(
        error ?? new Error("Node REPL evaluation completed."),
      );
    }
    if (error) active.reject(error);
    else active.resolve(result);
  }

  private handleWorkerFailure(error: Error) {
    if (this.closed) return;
    const terminated = new KernelTerminatedError(
      `Node REPL worker failed: ${error.message}`,
      "worker_error",
    );
    const active = this.active;
    if (active) {
      active.controller.abort(terminated);
      this.settleActive(active, terminated);
    }
    void this.close();
    this.onTerminated(this);
  }
}

type NodeReplCellOutcome =
  | { ok: true; value: NodeReplEvaluationResult }
  | { ok: false; error: Error };

type NodeReplCellRecord = {
  cellId: string;
  ownerId: string;
  kernel: NodeReplKernel;
  generation: number;
  startedAt: number;
  content: NodeReplContentItem[];
  cursor: number;
  deliveredCursor: number;
  listeners: Set<() => void>;
  completedAt?: number;
  lastObservedAt: number;
  outcome?: NodeReplCellOutcome;
  settled: Promise<void>;
};

const notifyCellObservers = (cell: NodeReplCellRecord): void => {
  for (const listener of [...cell.listeners]) listener();
};

const waitForCellChange = async (
  cell: NodeReplCellRecord,
  afterCursor: number,
  waitMs: number,
  signal?: AbortSignal,
  wakeOnContent = true,
): Promise<void> => {
  if (
    cell.outcome ||
    (wakeOnContent && cell.cursor > afterCursor) ||
    waitMs <= 0
  ) {
    return;
  }
  if (signal?.aborted) throw abortError(signal);
  let timer: NodeJS.Timeout | undefined;
  let contentImmediate: NodeJS.Immediate | undefined;
  await new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      cell.listeners.delete(onChange);
      if (timer) clearTimeout(timer);
      if (contentImmediate) clearImmediate(contentImmediate);
      signal?.removeEventListener("abort", onAbort);
    };
    const settle = () => {
      cleanup();
      resolve();
    };
    const onChange = () => {
      if (cell.outcome) {
        settle();
      } else if (
        wakeOnContent &&
        cell.cursor > afterCursor &&
        !contentImmediate
      ) {

        contentImmediate = setImmediate(settle);
        contentImmediate.unref?.();
      }
    };
    const onAbort = () => {
      cleanup();
      reject(
        signal ? abortError(signal) : new Error("Node REPL wait aborted."),
      );
    };
    cell.listeners.add(onChange);
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) {
      onAbort();
      return;
    }
    timer = setTimeout(settle, waitMs);
    timer.unref?.();
  });
};

export class NodeReplKernelRegistry {
  private readonly kernels = new Map<string, NodeReplKernel>();
  private readonly generations = new Map<string, number>();
  private readonly disposedKernels = new WeakSet<NodeReplKernel>();
  private readonly cells = new Map<string, NodeReplCellRecord>();
  private readonly runningCellByOwner = new Map<string, string>();
  private cellCleanupTimer?: NodeJS.Timeout;
  private readonly evalTimeoutMs: number;
  private readonly commandTimeoutMs: number;
  private readonly idleTimeoutMs: number;
  private readonly toolDrainTimeoutMs: number;
  private readonly disposeTimeoutMs: number;
  private readonly cellRetentionMs: number;
  private readonly maxRetainedCells: number;
  private readonly browserSessionFactory: (
    options: BrowserSessionOptions,
  ) => BrowserSessionClient;
  private lastOwnerLeaseIssuedAt = Date.now();

  constructor(private readonly options: NodeReplKernelManagerOptions = {}) {
    this.evalTimeoutMs = options.evalTimeoutMs ?? DEFAULT_EVAL_TIMEOUT_MS;
    this.commandTimeoutMs =
      options.commandTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;
    this.idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
    this.toolDrainTimeoutMs =
      options.toolDrainTimeoutMs ?? DEFAULT_NODE_REPL_TOOL_DRAIN_TIMEOUT_MS;
    this.disposeTimeoutMs =
      options.disposeTimeoutMs ?? DEFAULT_KERNEL_DISPOSE_TIMEOUT_MS;
    this.cellRetentionMs = Math.max(
      1,
      Math.floor(
        options.cellRetentionMs ?? DEFAULT_COMPLETED_CELL_RETENTION_MS,
      ),
    );
    this.maxRetainedCells = Math.max(
      1,
      Math.floor(options.maxRetainedCells ?? DEFAULT_MAX_RETAINED_CELLS),
    );
    this.browserSessionFactory =
      options.browserSessionFactory ?? createBrowserSession;
  }

  async evaluate(
    code: string,
    context: ToolContext,
    options: EvaluateOptions = {},
  ): Promise<string> {
    return (await this.evaluateDetailed(code, context, options)).output;
  }

  async evaluateDetailed(
    code: string,
    context: ToolContext,
    options: EvaluateOptions = {},
  ): Promise<NodeReplEvaluationResult> {
    const { id, kernel } = this.resolveKernel(context);
    return await this.runKernelEvaluation(id, kernel, code, context, options);
  }

  async startCell(
    code: string,
    context: ToolContext,
    options: EvaluateOptions & { yieldTimeMs?: number } = {},
  ): Promise<NodeReplCellObservation> {
    this.pruneCells();
    const { id, kernel } = this.resolveKernel(context);
    const existingCellId = this.runningCellByOwner.get(id);
    if (existingCellId) {
      throw new Error(
        `Node REPL already has a running cell for this session: ${existingCellId}. Wait for or terminate that cell before starting another.`,
      );
    }
    const cellId = `g${kernel.generation}:${randomUUID()}`;
    const cell: NodeReplCellRecord = {
      cellId,
      ownerId: id,
      kernel,
      generation: kernel.generation,
      startedAt: Date.now(),
      content: [],
      cursor: 0,
      deliveredCursor: 0,
      listeners: new Set(),
      lastObservedAt: Date.now(),
      settled: Promise.resolve(),
    };
    const callerOnContent = options.onContent;
    const evaluation = this.runKernelEvaluation(id, kernel, code, context, {
      ...options,
      onContent: (item, cursor) => {
        cell.content.push(item);
        cell.cursor = cursor;
        try {
          callerOnContent?.(item, cursor);
        } finally {
          notifyCellObservers(cell);
        }
      },
    });
    cell.settled = evaluation.then(
      (value) => {
        if (value.content.length > cell.content.length) {
          cell.content.push(...value.content.slice(cell.content.length));
          cell.cursor = cell.content.length;
        }
        cell.outcome = { ok: true, value };
        cell.completedAt = Date.now();
        notifyCellObservers(cell);
        this.pruneCells();
      },
      (error) => {
        cell.outcome = {
          ok: false,
          error: error instanceof Error ? error : new Error(String(error)),
        };
        cell.completedAt = Date.now();
        notifyCellObservers(cell);
        this.pruneCells();
      },
    );
    this.cells.set(cellId, cell);
    this.runningCellByOwner.set(id, cellId);
    void cell.settled.finally(() => {
      if (this.runningCellByOwner.get(id) === cellId) {
        this.runningCellByOwner.delete(id);
      }
    });
    return await this.observeCell(
      cell,
      options.yieldTimeMs ?? 30_000,
      options.signal,
      undefined,
      false,
    );
  }

  async waitCell(
    cellId: string,
    context: ToolContext,
    options: {
      waitMs?: number;
      terminate?: boolean;
      afterCursor?: number;
      signal?: AbortSignal;
    } = {},
  ): Promise<NodeReplCellObservation> {
    this.pruneCells();
    const id = getStellaComputerSessionId(context);
    if (!id) {
      throw new Error(
        "node_repl requires a stable Stella agent/session identity.",
      );
    }
    const cell = this.cells.get(cellId);
    if (!cell || cell.ownerId !== id) {
      throw new Error(`Unknown or stale Node REPL cell id: ${cellId}.`);
    }
    if (options.terminate && !cell.outcome) {
      cell.kernel.terminate(`Node REPL cell ${cellId} terminated by caller.`);
    }
    return await this.observeCell(
      cell,
      options.waitMs ?? 10_000,
      options.signal,
      options.afterCursor,
    );
  }

  private resolveKernel(context: ToolContext): {
    id: string;
    kernel: NodeReplKernel;
  } {
    const id = getStellaComputerSessionId(context);
    const browserSessionId = getStellaBrowserSessionId(context);
    if (!id || !browserSessionId) {
      throw new Error(
        "node_repl requires a stable Stella agent/session identity.",
      );
    }
    let kernel = this.kernels.get(id);
    if (!kernel) {
      const sessionFactory = this.options.sessionFactory;
      if (!sessionFactory) {
        throw new Error(
          "node_repl computer use requires a typed ComputerUseSession factory.",
        );
      }
      const cwd = resolveToolFallbackCwd(
        context.toolWorkspaceRoot ?? context.stellaAppDir,
      );
      const ownerLeaseIssuedAt = Math.max(
        Date.now(),
        this.lastOwnerLeaseIssuedAt + 1,
      );
      this.lastOwnerLeaseIssuedAt = ownerLeaseIssuedAt;
      const generation = (this.generations.get(id) ?? 0) + 1;
      this.generations.set(id, generation);
      kernel = new NodeReplKernel(id, generation, cwd, {
        sessionFactory,
        authorizeApp: this.options.authorizeApp,
        browserBinPath: this.options.browserBinPath,
        browserSessionFactory: this.browserSessionFactory,
        requestBrowserExtensionConnect:
          this.options.requestBrowserExtensionConnect,
        executeTool: this.options.executeTool,
        searchTools: this.options.searchTools,
        describeTool: this.options.describeTool,
        connectClient: this.options.connectClient,
        toolNames: replToolNamesForContext(context),
        browserSessionId,
        ownerLeaseId: randomUUID(),
        ownerLeaseIssuedAt,
        generation,
        evalTimeoutMs: this.evalTimeoutMs,
        commandTimeoutMs: this.commandTimeoutMs,
        idleTimeoutMs: this.idleTimeoutMs,
        toolDrainTimeoutMs: this.toolDrainTimeoutMs,
        onIdle: (candidate) => void this.disposeKernel(id, candidate),
      });
      this.kernels.set(id, kernel);
    }

    return { id, kernel };
  }

  private async runKernelEvaluation(
    id: string,
    kernel: NodeReplKernel,
    code: string,
    context: ToolContext,
    options: EvaluateOptions,
  ): Promise<NodeReplEvaluationResult> {
    try {
      return await kernel.enqueue(
        code,
        context,
        options,
        {
          evalTimeoutMs: this.evalTimeoutMs,
          idleTimeoutMs: this.idleTimeoutMs,
        },
        (candidate) => void this.disposeKernel(id, candidate),
      );
    } catch (error) {
      if (error instanceof KernelTerminatedError) {
        await this.disposeKernel(id, kernel);
        const receipt = resetReceipt(
          kernel.generation,
          error.resetReason,
          error.requestedAt,
        );
        throw new KernelTerminatedError(
          `${error.message} ${formatResetReceipt(receipt)}`,
          error.resetReason,
          error.requestedAt,
          receipt,
        );
      }
      throw error;
    }
  }

  private async observeCell(
    cell: NodeReplCellRecord,
    waitMs: number,
    signal?: AbortSignal,
    requestedAfterCursor?: number,
    wakeOnContent = true,
  ): Promise<NodeReplCellObservation> {
    const boundedWaitMs = Number.isFinite(waitMs)
      ? Math.max(0, Math.floor(waitMs))
      : 0;
    const fromCursor =
      requestedAfterCursor === undefined
        ? cell.deliveredCursor
        : requestedAfterCursor;
    if (
      !Number.isSafeInteger(fromCursor) ||
      fromCursor < 0 ||
      fromCursor > cell.cursor
    ) {
      throw new Error(
        `Invalid Node REPL content cursor ${String(requestedAfterCursor)} for cell ${cell.cellId}; current cursor is ${cell.cursor}.`,
      );
    }
    await waitForCellChange(
      cell,
      fromCursor,
      boundedWaitMs,
      signal,
      wakeOnContent,
    );
    if (signal?.aborted) throw abortError(signal);
    const cursor = cell.cursor;
    const content = cell.content.slice(fromCursor, cursor);
    cell.deliveredCursor = Math.max(cell.deliveredCursor, cursor);
    cell.lastObservedAt = Date.now();
    const elapsedMs = Date.now() - cell.startedAt;
    if (!cell.outcome) {
      return {
        cellId: cell.cellId,
        generation: cell.generation,
        status: "running",
        elapsedMs,
        fromCursor,
        cursor,
        ...(content.length > 0
          ? { output: formatNodeReplContent(content), content }
          : {}),
      };
    }
    if (cell.outcome.ok) {
      return {
        cellId: cell.cellId,
        generation: cell.generation,
        status: "completed",
        elapsedMs,
        fromCursor,
        cursor,
        output: formatNodeReplContent(content),
        ...(content.length > 0 ? { content } : {}),
        ...(cell.outcome.value.reset
          ? { reset: cell.outcome.value.reset }
          : {}),
        ...(cell.outcome.value.responseMeta
          ? { responseMeta: cell.outcome.value.responseMeta }
          : {}),
      };
    }
    return {
      cellId: cell.cellId,
      generation: cell.generation,
      status: "failed",
      elapsedMs,
      fromCursor,
      cursor,
      ...(content.length > 0
        ? { output: formatNodeReplContent(content), content }
        : {}),
      error: cell.outcome.error.message,
      ...(cell.outcome.error instanceof KernelTerminatedError &&
      cell.outcome.error.resetReceipt
        ? { reset: cell.outcome.error.resetReceipt }
        : {}),
    };
  }

  private pruneCells(now = Date.now()): void {
    for (const [cellId, cell] of this.cells) {
      if (
        cell.completedAt !== undefined &&
        now - cell.completedAt >= this.cellRetentionMs
      ) {
        this.cells.delete(cellId);
      }
    }
    const completed = [...this.cells.values()].filter(
      (cell) => cell.completedAt !== undefined,
    );
    if (completed.length > this.maxRetainedCells) {
      completed
        .sort(
          (left, right) =>
            left.lastObservedAt - right.lastObservedAt ||
            (left.completedAt ?? 0) - (right.completedAt ?? 0),
        )
        .slice(0, completed.length - this.maxRetainedCells)
        .forEach((cell) => this.cells.delete(cell.cellId));
    }
    if (this.cellCleanupTimer) clearTimeout(this.cellCleanupTimer);
    this.cellCleanupTimer = undefined;
    const nextExpiry = Math.min(
      ...[...this.cells.values()]
        .filter(
          (cell): cell is NodeReplCellRecord & { completedAt: number } =>
            cell.completedAt !== undefined,
        )
        .map((cell) => cell.completedAt + this.cellRetentionMs),
    );
    if (Number.isFinite(nextExpiry)) {
      this.cellCleanupTimer = setTimeout(
        () => {
          this.cellCleanupTimer = undefined;
          this.pruneCells();
        },
        Math.max(1, nextExpiry - now),
      );
      this.cellCleanupTimer.unref?.();
    }
  }

  async dispose(): Promise<void> {
    if (this.cellCleanupTimer) clearTimeout(this.cellCleanupTimer);
    this.cellCleanupTimer = undefined;
    const pending: Promise<void>[] = [];
    for (const [id, kernel] of [...this.kernels]) {
      pending.push(this.disposeKernel(id, kernel));
    }
    await Promise.all(pending);
    this.cells.clear();
    this.runningCellByOwner.clear();
  }

  async endBrowserTurn(
    turnId: string,
    behavior: BrowserTurnEndBehavior,
  ): Promise<void> {
    await Promise.allSettled(
      [...this.kernels.values()].map((kernel) =>
        kernel.endBrowserTurn(turnId, behavior),
      ),
    );
  }

  private disposeKernel(id: string, kernel: NodeReplKernel): Promise<void> {
    const kernelClose = kernel.close();
    let sessionCleanup = Promise.resolve();
    if (!this.disposedKernels.has(kernel)) {
      this.disposedKernels.add(kernel);
      try {
        sessionCleanup = Promise.resolve(
          this.options.disposeSession?.(id),
        ).then(
          () => undefined,
          () => undefined,
        );
      } catch {

      }
    }
    if (this.kernels.get(id) === kernel) this.kernels.delete(id);
    const teardown = Promise.allSettled([kernelClose, sessionCleanup]).then(
      () => undefined,
    );

    let deadline: NodeJS.Timeout | undefined;
    return Promise.race([
      teardown,
      new Promise<void>((resolve) => {
        deadline = setTimeout(resolve, this.disposeTimeoutMs);
        deadline.unref?.();
      }),
    ]).finally(() => clearTimeout(deadline));
  }
}

export { NodeReplKernelRegistry as NodeReplKernelManager };
