import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { createConnection, type Socket } from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  getStellaBrowserBridgeEnv,
  getStellaInAppBrowserInitEndpoint,
  getStellaInAppBrowserInitTokenPath,
} from "../tools/stella-browser-bridge-config.js";
import {
  DEFAULT_BROWSER_COMMAND_TIMEOUT_MS,
  DEFAULT_BROWSER_MAX_OUTPUT_BYTES,
  runBrowserCommand,
  type BrowserCommandRunner,
} from "./command-runner.js";

export const MAX_BROWSER_CHAIN_STEPS = 100;

const DEFAULT_BROWSER_CHAIN_WAIT_TIMEOUT_MS = 10_000;
const BROWSER_CHAIN_STEP_BUDGET_MS = 1_000;
const MIN_BROWSER_CHAIN_TIMEOUT_MS = 3 * 60_000;
const MAX_BROWSER_CHAIN_TIMEOUT_MS = 4 * 60_000;
const MAX_BROWSER_TURN_CLEANUP_TIMEOUT_MS = 2_000;
const BROWSER_COMMAND_TIMEOUT_GRACE_MS = 5_000;
let lastBrowserOwnerLeaseIssuedAt = Date.now();

// Contract-checked against packages/stella-browser/protocol/actions.json
// ("chain": true) by tests/runtime/kernel/browser-use/action-contract.test.ts:
// adding, removing, or renaming an entry fails that test until the manifest
// and the Rust daemon (is_chain_allowed_action) agree.
export const BROWSER_CHAIN_ACTIONS = [
  "healthcheck",
  "navigate",
  "back",
  "forward",
  "reload",
  "url",
  "title",
  "click",
  "fill",
  "type",
  "hover",
  "select",
  "press",
  "scroll",
  "clear",
  "check",
  "uncheck",
  "focus",
  "dblclick",
  "wait",
  "screenshot",
  "snapshot",
  "content",
  "evaluate",
  "gettext",
  "getattribute",
  "innertext",
  "innerhtml",
  "inputvalue",
  "boundingbox",
  "scrollintoview",
  "isvisible",
  "isenabled",
  "ischecked",
  "count",
  "styles",
  "waitforurl",
  "waitforfunction",
  "bringtofront",
  "requests",
  "responsebody",
  "route",
  "unroute",
  "har_start",
  "har_stop",
  "clipboard",
  "mousemove",
  "mousedown",
  "mouseup",
  "drag",
  "keydown",
  "keyup",
  "inserttext",
  "tab_new",
  "tab_list",
  "tab_switch",
  "tab_close",
  "cookies_get",
  "cookies_set",
  "cookies_clear",
  "upload",
] as const;

export const BROWSER_PROTOCOL_ACTIONS = [
  ...BROWSER_CHAIN_ACTIONS,
  "authenticated_request",
  "authenticated_request_batch",
  "evaluate_detached",
  "rewrite_request",
  "unrewrite_request",
  "finalize_tabs",
  "close_owner",
  "release_owner_lease",
] as const;

export type BrowserChainAction = (typeof BROWSER_CHAIN_ACTIONS)[number];
export type BrowserProtocolAction = (typeof BROWSER_PROTOCOL_ACTIONS)[number];
export type BrowserJsonPrimitive = string | number | boolean | null;
export type BrowserJsonValue =
  | BrowserJsonPrimitive
  | readonly BrowserJsonValue[]
  | Readonly<{ [key: string]: BrowserJsonValue }>;
export type BrowserCommandParams = Readonly<Record<string, BrowserJsonValue>>;
export type BrowserBridgeEnvironmentProvider = () => Record<string, string>;
export type InAppBrowserCapability = Readonly<{
  bridgeSessionId: string;
  capabilityExpiresAt: number;
}>;
export type InAppBrowserInitializer = (options: {
  env: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  timeoutMs: number;
  sessionId: string;
  turnId: string;
  ownerLeaseId: string;
  ownerLeaseIssuedAt: number;
  recover?: boolean;
}) => Promise<InAppBrowserCapability | boolean>;

export type BrowserCommandResult<TData = unknown> =
  | (Readonly<{
      id: string;
      success: true;
      data?: TData;
    }> &
      Readonly<Record<string, unknown>>)
  | (Readonly<{
      id: string;
      success: false;
      data?: TData;
      error: string;
    }> &
      Readonly<Record<string, unknown>>);

export type BrowserCommandSuccess<TData = unknown> = Extract<
  BrowserCommandResult<TData>,
  { success: true }
>;

export type BrowserCommandAttemptReceipt<TData = unknown> = Readonly<{
  sessionId: string;
  bridgeSessionId: string;
  requestId: string;
  action: string;
  params: BrowserCommandParams;
  result: BrowserCommandResult<TData>;
  attempts: number;
  durationMs: number;
}>;

export type BrowserCommandReceipt<TData = unknown> = Omit<
  BrowserCommandAttemptReceipt<TData>,
  "result"
> &
  Readonly<{ result: BrowserCommandSuccess<TData> }>;

export type BrowserCommandOptions = Readonly<{
  signal?: AbortSignal;
}>;

export type BrowserChainStep = Readonly<{
  action: BrowserChainAction;
  params?: BrowserCommandParams;
}>;

export type BrowserChainOptions = BrowserCommandOptions &
  Readonly<{
    abortOnError?: boolean;
    delay?: Readonly<{
      minMs?: number;
      maxMs?: number;
    }>;
    waitForSelector?: boolean;
    waitTimeoutMs?: number;
    returnSnapshot?: boolean;
    returnScreenshot?: boolean;
  }>;

export type BrowserChainStepResult<TData = unknown> = Readonly<{
  step: number;
  action: string;
  success: boolean;
  data?: TData;
  error?: string;
  durationMs: number;
}>;

export type BrowserChainResult<TData = unknown> = Readonly<{
  results: readonly BrowserChainStepResult<TData>[];
  completed: number;
  total: number;
  totalDurationMs: number;
  snapshot?: string;
  screenshot?: string;
}>;

export type BrowserSessionOptions = Readonly<{
  binaryPath?: string;
  sessionId: string;
  cwd: string;
  env?: NodeJS.ProcessEnv;
  commandTimeoutMs?: number;
  maxOutputBytes?: number;
  signal?: AbortSignal;
  runner?: BrowserCommandRunner;
  getBridgeEnv?: BrowserBridgeEnvironmentProvider;
  initializeInAppBrowser?: InAppBrowserInitializer;
  ownerLeaseId?: string;
  ownerLeaseIssuedAt?: number;
  turnId?: string;
}>;

export type BrowserTurnEndBehavior = "retain-tabs" | "close-tabs";

export type BrowserBackend = "in-app" | "external";

export const BROWSER_SESSION_CLIENT_METHODS = [
  "command",
  "chain",
  "selectBackend",
  "dispose",
] as const;

export type BrowserSessionClientMethod =
  (typeof BROWSER_SESSION_CLIENT_METHODS)[number];

export interface BrowserSessionClient {
  command<TData = unknown>(
    action: BrowserProtocolAction,
    params?: BrowserCommandParams,
    options?: BrowserCommandOptions,
  ): Promise<BrowserCommandReceipt<TData>>;
  chain<TData = unknown>(
    steps: readonly BrowserChainStep[],
    options?: BrowserChainOptions,
  ): Promise<BrowserCommandReceipt<BrowserChainResult<TData>>>;
  selectBackend?(
    backend: BrowserBackend,
  ): Promise<Readonly<{ backend: BrowserBackend }>>;
  beginTurn?(turnId: string): void;
  endTurn?(turnId: string, behavior: BrowserTurnEndBehavior): Promise<void>;
  dispose(): Promise<void>;
}

export type BrowserSessionCommandErrorCode =
  | "command_failed"
  | "execution_failed";

export class BrowserSessionCommandError extends Error {
  readonly code: BrowserSessionCommandErrorCode;
  readonly requestId: string;
  readonly action: string;
  readonly receipt?: BrowserCommandAttemptReceipt;

  constructor(
    code: BrowserSessionCommandErrorCode,
    message: string,
    options: {
      requestId: string;
      action: string;
      receipt?: BrowserCommandAttemptReceipt;
      cause?: unknown;
    },
  ) {
    super(message, { cause: options.cause });
    this.name = "BrowserSessionCommandError";
    this.code = code;
    this.requestId = options.requestId;
    this.action = options.action;
    this.receipt = options.receipt;
  }
}

export class BrowserSessionDisposedError extends Error {
  constructor() {
    super("BrowserSession has been disposed.");
    this.name = "BrowserSessionDisposedError";
  }
}

type BrowserTransportErrorCode =
  | "connection_closed"
  | "connection_failed"
  | "invalid_response"
  | "output_limit"
  | "request_limit"
  | "timeout"
  | "write_failed";

class BrowserTransportError extends Error {
  readonly code: BrowserTransportErrorCode;
  readonly retryable: boolean;

  constructor(
    code: BrowserTransportErrorCode,
    message: string,
    options: { retryable?: boolean; cause?: unknown } = {},
  ) {
    super(message, { cause: options.cause });
    this.name = "BrowserTransportError";
    this.code = code;
    this.retryable = options.retryable ?? false;
  }
}

type ResolvedExecutionConfig = Readonly<{
  binaryPath: string;
  bridgeSessionId: string;
  env: NodeJS.ProcessEnv;
  endpoint:
    | Readonly<{ path: string }>
    | Readonly<{ host: string; port: number }>;
}>;

type PendingResponse = {
  socket: Socket;
  requestId: string;
  resolve: (result: BrowserCommandResult) => void;
  reject: (error: Error) => void;
  timeout: NodeJS.Timeout;
  signal?: AbortSignal;
  onAbort?: () => void;
};

const ALLOWED_ACTIONS = new Set<string>(BROWSER_PROTOCOL_ACTIONS);
const ALLOWED_CHAIN_ACTIONS = new Set<string>(BROWSER_CHAIN_ACTIONS);
const BROWSER_OWNER_LIFECYCLE_ACTIONS = new Set<string>([
  "finalize_tabs",
  "close_owner",
  "release_owner_lease",
]);
// These requests can be repeated after a managed daemon is replaced without
// changing page/browser state. Mutations and arbitrary evaluation are
// deliberately absent: the old daemon may have executed them before its
// response was lost, and replay protection is daemon-local.
const BROWSER_REPLACEMENT_REPLAY_SAFE_ACTIONS = new Set<string>([
  "healthcheck",
  "url",
  "title",
  "wait",
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
  "waitforurl",
  "requests",
  "responsebody",
  "tab_list",
  "cookies_get",
]);
const RESERVED_PARAM_KEYS = new Set([
  "id",
  "action",
  "ownerId",
  "sessionId",
  "turnId",
  "ownerLeaseId",
  "ownerLeaseIssuedAt",
]);
const EMPTY_BUFFER = Buffer.alloc(0);

const canReplayAfterManagedReplacement = (
  action: string,
  params: BrowserCommandParams,
): boolean => {
  if (action !== "chain") {
    return BROWSER_REPLACEMENT_REPLAY_SAFE_ACTIONS.has(action);
  }
  const steps = params.steps;
  return (
    Array.isArray(steps) &&
    steps.every(
      (step) =>
        typeof step === "object" &&
        step !== null &&
        !Array.isArray(step) &&
        BROWSER_REPLACEMENT_REPLAY_SAFE_ACTIONS.has(
          String((step as Readonly<Record<string, BrowserJsonValue>>).action),
        ),
    )
  );
};

const requireNonEmptyString = (value: unknown, name: string): string => {
  if (typeof value !== "string" || value.trim() === "") {
    throw new TypeError(`${name} must be a non-empty string.`);
  }
  if (value.includes("\0")) {
    throw new TypeError(`${name} must not contain a null byte.`);
  }
  return value;
};

const requirePositiveInteger = (value: unknown, name: string): number => {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${name} must be a positive integer.`);
  }
  return value;
};

const requireNonNegativeInteger = (value: unknown, name: string): number => {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${name} must be a non-negative integer.`);
  }
  return value;
};

const isAbortSignal = (value: unknown): value is AbortSignal =>
  typeof value === "object" &&
  value !== null &&
  "aborted" in value &&
  typeof value.aborted === "boolean" &&
  "addEventListener" in value &&
  typeof value.addEventListener === "function";

const abortReason = (signal: AbortSignal): Error =>
  signal.reason instanceof Error
    ? signal.reason
    : new Error("Browser command aborted.");

const throwIfAborted = (signal: AbortSignal | undefined): void => {
  if (signal?.aborted) throw abortReason(signal);
};

const combineSignals = (
  first: AbortSignal | undefined,
  second: AbortSignal | undefined,
): AbortSignal | undefined => {
  if (!first) return second;
  if (!second || first === second) return first;
  return AbortSignal.any([first, second]);
};

const isUnavailableInitializerError = (error: Error) =>
  "code" in error &&
  ["ENOENT", "ECONNREFUSED", "EADDRNOTAVAIL"].includes(
    String((error as NodeJS.ErrnoException).code),
  );

export const initializeStellaInAppBrowser: InAppBrowserInitializer = async ({
  env,
  signal,
  timeoutMs,
  sessionId,
  turnId,
  ownerLeaseId,
  ownerLeaseIssuedAt,
  recover,
}) => {
  throwIfAborted(signal);
  let token = "";
  try {
    token = readFileSync(
      getStellaInAppBrowserInitTokenPath(env),
      "utf8",
    ).trim();
  } catch {
    return false;
  }
  if (!token) return false;
  const endpoint = getStellaInAppBrowserInitEndpoint(env);

  return await new Promise<InAppBrowserCapability | boolean>(
    (resolve, reject) => {
      let settled = false;
      let connected = false;
      let buffer = "";
      const socket =
        "path" in endpoint
          ? createConnection({ path: endpoint.path })
          : createConnection({ host: endpoint.host, port: endpoint.port });

      const cleanup = () => {
        clearTimeout(timeout);
        signal?.removeEventListener("abort", onAbort);
        socket.removeAllListeners();
        if (!socket.destroyed) socket.destroy();
      };
      const finish = (value: InAppBrowserCapability | boolean) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(value);
      };
      const fail = (error: Error) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(error);
      };
      const onAbort = () => fail(abortReason(signal!));
      const timeout = setTimeout(
        () =>
          fail(
            new Error(
              `In-app browser initialization timed out after ${timeoutMs}ms.`,
            ),
          ),
        Math.max(1, timeoutMs),
      );

      signal?.addEventListener("abort", onAbort, { once: true });
      socket.setEncoding("utf8");
      socket.once("connect", () => {
        connected = true;
        socket.write(
          `${JSON.stringify({
            action: "ensure",
            token,
            sessionId,
            turnId,
            ownerLeaseId,
            ownerLeaseIssuedAt,
            ...(recover ? { recover: true } : {}),
          })}\n`,
        );
      });
      socket.on("data", (chunk: string) => {
        buffer += chunk;
        if (Buffer.byteLength(buffer) > 16 * 1024) {
          fail(
            new Error("In-app browser initialization response is too large."),
          );
          return;
        }
        const newline = buffer.indexOf("\n");
        if (newline < 0) return;
        try {
          const response = JSON.parse(buffer.slice(0, newline)) as Record<
            string,
            unknown
          >;
          const data = response.data;
          if (
            response.success === true &&
            typeof data === "object" &&
            data !== null &&
            !Array.isArray(data) &&
            typeof (data as Record<string, unknown>).bridgeSessionId ===
              "string" &&
            ((data as Record<string, unknown>).bridgeSessionId as string).trim()
              .length > 0 &&
            typeof (data as Record<string, unknown>).capabilityExpiresAt ===
              "number" &&
            Number.isSafeInteger(
              (data as Record<string, unknown>).capabilityExpiresAt,
            )
          ) {
            finish(
              Object.freeze({
                bridgeSessionId: (data as Record<string, unknown>)
                  .bridgeSessionId as string,
                capabilityExpiresAt: (data as Record<string, unknown>)
                  .capabilityExpiresAt as number,
              }),
            );
            return;
          }
          fail(
            new Error(
              typeof response.error === "string"
                ? response.error
                : "Failed to initialize the in-app browser.",
            ),
          );
        } catch (error) {
          fail(
            new Error(
              `In-app browser initialization returned invalid JSON: ${
                error instanceof Error ? error.message : String(error)
              }`,
            ),
          );
        }
      });
      socket.once("error", (error) => {
        if (!connected && isUnavailableInitializerError(error)) {
          finish(false);
          return;
        }
        fail(error);
      });
      socket.once("close", () => {
        if (!settled) {
          fail(new Error("In-app browser initialization connection closed."));
        }
      });
    },
  );
};

const validateJson = (
  value: unknown,
  name: string,
  ancestors: Set<object>,
  depth: number,
): void => {
  if (depth > 32)
    throw new TypeError(`${name} exceeds the maximum depth of 32.`);
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new TypeError(`${name} must contain only finite numbers.`);
    }
    return;
  }
  if (typeof value !== "object") {
    throw new TypeError(`${name} must contain only JSON values.`);
  }
  if (ancestors.has(value)) {
    throw new TypeError(`${name} must not contain circular references.`);
  }

  ancestors.add(value);
  if (Array.isArray(value)) {
    value.forEach((entry, index) =>
      validateJson(entry, `${name}[${index}]`, ancestors, depth + 1),
    );
  } else {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError(`${name} must contain only plain JSON objects.`);
    }
    Object.entries(value).forEach(([key, entry]) =>
      validateJson(entry, `${name}.${key}`, ancestors, depth + 1),
    );
  }
  ancestors.delete(value);
};

const validateParams = (
  value: BrowserCommandParams | undefined,
  name = "params",
): BrowserCommandParams => {
  if (value === undefined) return Object.freeze({});
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`${name} must be a plain JSON object.`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(`${name} must be a plain JSON object.`);
  }
  for (const key of Object.keys(value)) {
    if (RESERVED_PARAM_KEYS.has(key)) {
      throw new TypeError(`${name}.${key} is managed by BrowserSession.`);
    }
  }
  validateJson(value, name, new Set(), 0);
  return Object.freeze(
    JSON.parse(JSON.stringify(value)) as Record<string, BrowserJsonValue>,
  );
};

const validateAction = (
  value: unknown,
  name = "action",
): BrowserProtocolAction => {
  const action = requireNonEmptyString(value, name);
  if (!ALLOWED_ACTIONS.has(action)) {
    throw new TypeError(
      `${name} is not an allowed browser protocol action: ${action}`,
    );
  }
  return action as BrowserProtocolAction;
};

const validateChainAction = (
  value: unknown,
  name: string,
): BrowserChainAction => {
  const action = requireNonEmptyString(value, name);
  if (!ALLOWED_CHAIN_ACTIONS.has(action)) {
    throw new TypeError(
      `${name} is not an allowed browser chain action: ${action}`,
    );
  }
  return action as BrowserChainAction;
};

const validateCommandOptions = (
  value: BrowserCommandOptions | undefined,
): BrowserCommandOptions => {
  if (value === undefined) return Object.freeze({});
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("command options must be an object.");
  }
  if (value.signal !== undefined && !isAbortSignal(value.signal)) {
    throw new TypeError("signal must be an AbortSignal.");
  }
  return Object.freeze({ signal: value.signal });
};

const validateChain = (value: unknown): readonly BrowserChainStep[] => {
  if (!Array.isArray(value) || value.length === 0) {
    throw new TypeError("steps must be a non-empty array of browser commands.");
  }
  if (value.length > MAX_BROWSER_CHAIN_STEPS) {
    throw new RangeError(
      `steps must contain at most ${MAX_BROWSER_CHAIN_STEPS} commands.`,
    );
  }
  return Object.freeze(
    value.map((entry, index) => {
      if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
        throw new TypeError(
          `steps[${index}] must be a browser command object.`,
        );
      }
      const record = entry as {
        action?: unknown;
        params?: BrowserCommandParams;
      };
      return Object.freeze({
        action: validateChainAction(record.action, `steps[${index}].action`),
        params: validateParams(record.params, `steps[${index}].params`),
      });
    }),
  );
};

const validateChainOptions = (
  value: BrowserChainOptions | undefined,
): BrowserChainOptions => {
  if (value === undefined) return Object.freeze({});
  validateCommandOptions(value);
  const booleanKeys = [
    "abortOnError",
    "waitForSelector",
    "returnSnapshot",
    "returnScreenshot",
  ] as const;
  for (const key of booleanKeys) {
    if (value[key] !== undefined && typeof value[key] !== "boolean") {
      throw new TypeError(`${key} must be a boolean.`);
    }
  }
  const waitTimeoutMs =
    value.waitTimeoutMs === undefined
      ? undefined
      : requirePositiveInteger(value.waitTimeoutMs, "waitTimeoutMs");
  let delay: BrowserChainOptions["delay"];
  if (value.delay !== undefined) {
    if (
      typeof value.delay !== "object" ||
      value.delay === null ||
      Array.isArray(value.delay)
    ) {
      throw new TypeError("delay must be an object.");
    }
    const minMs = requireNonNegativeInteger(
      value.delay.minMs ?? 300,
      "delay.minMs",
    );
    const maxMs = requireNonNegativeInteger(
      value.delay.maxMs ?? 1_200,
      "delay.maxMs",
    );
    if (minMs > maxMs) {
      throw new RangeError(
        "delay.minMs must be less than or equal to delay.maxMs.",
      );
    }
    delay = Object.freeze({ minMs, maxMs });
  }
  return Object.freeze({
    signal: value.signal,
    abortOnError: value.abortOnError,
    delay,
    waitForSelector: value.waitForSelector,
    waitTimeoutMs,
    returnSnapshot: value.returnSnapshot,
    returnScreenshot: value.returnScreenshot,
  });
};

const defaultBinaryPath = (): string => {
  const moduleDir = path.dirname(fileURLToPath(import.meta.url));
  let current = moduleDir;
  for (let depth = 0; depth < 8; depth += 1) {
    const candidates = [
      path.join(
        current,
        "desktop",
        "stella-browser",
        "bin",
        "stella-browser.js",
      ),
      path.join(current, "stella-browser", "bin", "stella-browser.js"),
    ];
    const match = candidates.find((candidate) => existsSync(candidate));
    if (match) return match;
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return path.resolve(
    moduleDir,
    "..",
    "..",
    "..",
    "desktop",
    "stella-browser",
    "bin",
    "stella-browser.js",
  );
};

const isJavaScriptShim = (binaryPath: string): boolean =>
  [".js", ".cjs", ".mjs"].includes(path.extname(binaryPath).toLowerCase());

const getSocketDir = (env: NodeJS.ProcessEnv): string => {
  const explicit = env.STELLA_BROWSER_SOCKET_DIR?.trim();
  if (explicit) return explicit;
  const runtimeDir = env.XDG_RUNTIME_DIR?.trim();
  if (runtimeDir) return path.join(runtimeDir, "stella-browser");
  const homeDir = os.homedir().trim();
  if (homeDir) return path.join(homeDir, ".stella-browser");
  return path.join(os.tmpdir(), "stella-browser");
};

export const getBrowserDaemonPort = (sessionId: string): number => {
  let hash = 0;
  for (const character of sessionId) {
    hash = (Math.imul(hash, 31) + character.codePointAt(0)!) | 0;
  }
  return 49_152 + (Math.abs(hash) % 16_383);
};

const isResponseRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const normalizeResponse = (
  value: unknown,
  expectedId: string,
): BrowserCommandResult => {
  if (!isResponseRecord(value) || typeof value.success !== "boolean") {
    throw new BrowserTransportError(
      "invalid_response",
      "Browser daemon returned a response without a boolean success field.",
      { retryable: true },
    );
  }
  if (typeof value.id !== "string" || value.id !== expectedId) {
    throw new BrowserTransportError(
      "invalid_response",
      `Browser daemon response ID did not match request ${expectedId}.`,
      { retryable: true },
    );
  }
  if (
    !value.success &&
    value.error !== undefined &&
    typeof value.error !== "string"
  ) {
    throw new BrowserTransportError(
      "invalid_response",
      "Browser daemon returned a non-string error.",
      { retryable: true },
    );
  }
  if (value.success) {
    return Object.freeze({ ...value, id: expectedId, success: true });
  }
  return Object.freeze({
    ...value,
    id: expectedId,
    success: false,
    error:
      typeof value.error === "string" && value.error.trim()
        ? value.error
        : "stella-browser command failed.",
  });
};

const getChainTimeoutMs = (
  commandTimeoutMs: number,
  steps: readonly BrowserChainStep[],
  options: BrowserChainOptions,
): number => {
  const selectorWaitSteps =
    options.waitForSelector === false
      ? 0
      : steps.filter((step) => step.params?.selector || step.params?.ref)
          .length;
  const waitTimeoutMs =
    options.waitTimeoutMs ?? DEFAULT_BROWSER_CHAIN_WAIT_TIMEOUT_MS;
  const delayCount = Math.max(0, steps.length - 1);
  const maxDelayMs = options.delay?.maxMs ?? 0;
  const requestedBudget =
    commandTimeoutMs +
    steps.length * BROWSER_CHAIN_STEP_BUDGET_MS +
    selectorWaitSteps * waitTimeoutMs +
    delayCount * maxDelayMs +
    (options.returnSnapshot ? commandTimeoutMs : 0) +
    (options.returnScreenshot ? commandTimeoutMs : 0);
  return Math.max(
    MIN_BROWSER_CHAIN_TIMEOUT_MS,
    Math.min(MAX_BROWSER_CHAIN_TIMEOUT_MS, requestedBudget),
  );
};

const leaseFingerprint = (leaseId: string): string =>
  createHash("sha256").update(leaseId).digest("hex").slice(0, 12);

const getCommandTimeoutMs = (
  commandTimeoutMs: number,
  params: BrowserCommandParams,
): number => {
  const requestedTimeout = params.timeout;
  if (
    typeof requestedTimeout !== "number" ||
    !Number.isSafeInteger(requestedTimeout) ||
    requestedTimeout < 0
  ) {
    return commandTimeoutMs;
  }

  // The daemon/action timeout is an inner deadline. Leave a small transport
  // grace period so a caller asking waitForURL(..., { timeout: 120_000 }) does
  // not get cut off by the client's historical 30-second default (or race the
  // response at exactly 120 seconds).
  return Math.max(
    commandTimeoutMs,
    requestedTimeout + BROWSER_COMMAND_TIMEOUT_GRACE_MS,
  );
};

export class BrowserSession implements BrowserSessionClient {
  readonly sessionId: string;
  readonly cwd: string;

  private readonly configuredBinaryPath?: string;
  private readonly configuredEnv: NodeJS.ProcessEnv;
  private readonly commandTimeoutMs: number;
  private readonly maxOutputBytes: number;
  private readonly signal?: AbortSignal;
  private readonly runner: BrowserCommandRunner;
  private readonly getBridgeEnv: BrowserBridgeEnvironmentProvider;
  private readonly initializeInAppBrowser: InAppBrowserInitializer;
  private readonly configuredOwnerLeaseId?: string;
  private readonly configuredOwnerLeaseIssuedAt?: number;
  private readonly configuredTurnId?: string;
  private configuredLeaseConsumed = false;
  private activeTurn?: Readonly<{
    turnId: string;
    ownerLeaseId: string;
    ownerLeaseIssuedAt: number;
  }>;
  private executionConfig?: ResolvedExecutionConfig;
  private selectedBackend: BrowserBackend = "in-app";
  private readonly activeTurnBackends = new Set<BrowserBackend>();
  private socket?: Socket;
  private connectingSocket?: Socket;
  private readBuffer = EMPTY_BUFFER;
  private pending?: PendingResponse;
  private fallbackAttempted = false;
  private ownerRoute?: Readonly<{
    capability: InAppBrowserCapability & {
      turnId: string;
      ownerLeaseId: string;
    };
    config: ResolvedExecutionConfig;
  }>;
  private recoverInAppBrowserCapability = false;
  private queue: Promise<void> = Promise.resolve();
  private disposed = false;
  private disposePromise?: Promise<void>;

  constructor(options: BrowserSessionOptions) {
    if (typeof options !== "object" || options === null) {
      throw new TypeError("BrowserSession options are required.");
    }
    this.sessionId = requireNonEmptyString(options.sessionId, "sessionId");
    this.cwd = requireNonEmptyString(options.cwd, "cwd");
    this.configuredBinaryPath =
      options.binaryPath === undefined
        ? undefined
        : requireNonEmptyString(options.binaryPath, "binaryPath");
    this.configuredEnv = { ...(options.env ?? {}) };
    this.commandTimeoutMs = requirePositiveInteger(
      options.commandTimeoutMs ?? DEFAULT_BROWSER_COMMAND_TIMEOUT_MS,
      "commandTimeoutMs",
    );
    this.maxOutputBytes = requirePositiveInteger(
      options.maxOutputBytes ?? DEFAULT_BROWSER_MAX_OUTPUT_BYTES,
      "maxOutputBytes",
    );
    if (options.signal !== undefined && !isAbortSignal(options.signal)) {
      throw new TypeError("signal must be an AbortSignal.");
    }
    if (options.runner !== undefined && typeof options.runner !== "function") {
      throw new TypeError("runner must be a function.");
    }
    if (
      options.getBridgeEnv !== undefined &&
      typeof options.getBridgeEnv !== "function"
    ) {
      throw new TypeError("getBridgeEnv must be a function.");
    }
    if (
      options.initializeInAppBrowser !== undefined &&
      typeof options.initializeInAppBrowser !== "function"
    ) {
      throw new TypeError("initializeInAppBrowser must be a function.");
    }
    this.signal = options.signal;
    this.runner = options.runner ?? runBrowserCommand;
    this.getBridgeEnv = options.getBridgeEnv ?? getStellaBrowserBridgeEnv;
    this.initializeInAppBrowser =
      options.initializeInAppBrowser ?? initializeStellaInAppBrowser;
    this.configuredOwnerLeaseId =
      options.ownerLeaseId === undefined
        ? randomUUID()
        : requireNonEmptyString(options.ownerLeaseId, "ownerLeaseId");
    this.configuredOwnerLeaseIssuedAt = requirePositiveInteger(
      options.ownerLeaseIssuedAt ??
        Math.max(Date.now(), lastBrowserOwnerLeaseIssuedAt + 1),
      "ownerLeaseIssuedAt",
    );
    lastBrowserOwnerLeaseIssuedAt = Math.max(
      lastBrowserOwnerLeaseIssuedAt,
      this.configuredOwnerLeaseIssuedAt,
    );
    this.configuredTurnId =
      options.turnId === undefined
        ? undefined
        : requireNonEmptyString(options.turnId, "turnId");
    this.signal?.addEventListener("abort", this.onSessionAbort, { once: true });
  }

  get isDisposed(): boolean {
    return this.disposed;
  }

  beginTurn(turnId: string): void {
    this.assertOpen();
    const validatedTurnId = requireNonEmptyString(turnId, "turnId");
    if (this.activeTurn?.turnId === validatedTurnId) return;
    if (this.activeTurn) {
      throw new Error(
        `Browser turn ${this.activeTurn.turnId} must end before ${validatedTurnId} begins.`,
      );
    }
    this.activeTurnBackends.clear();
    this.activeTurn = this.createTurnLease(validatedTurnId);
  }

  async endTurn(
    turnId: string,
    behavior: BrowserTurnEndBehavior,
  ): Promise<void> {
    const validatedTurnId = requireNonEmptyString(turnId, "turnId");
    const turn = this.activeTurn;
    if (!turn || turn.turnId !== validatedTurnId) return;
    await this.enqueue(async () => {
      try {
        await this.cleanupTurn(turn, false, behavior === "close-tabs");
      } finally {
        if (this.activeTurn === turn) this.activeTurn = undefined;
        this.activeTurnBackends.clear();
        this.ownerRoute = undefined;
        if (this.socket) {
          this.invalidateSocket(
            this.socket,
            new BrowserTransportError(
              "connection_closed",
              "Browser turn completed.",
            ),
          );
        }
      }
    });
  }

  async command<TData = unknown>(
    action: BrowserProtocolAction,
    params?: BrowserCommandParams,
    options?: BrowserCommandOptions,
  ): Promise<BrowserCommandReceipt<TData>> {
    const validatedAction = validateAction(action);
    const validatedParams = validateParams(params);
    const validatedOptions = validateCommandOptions(options);
    this.assertOpen();
    return await this.enqueue(async () =>
      this.execute<TData>(
        validatedAction,
        validatedParams,
        combineSignals(this.signal, validatedOptions.signal),
        getCommandTimeoutMs(this.commandTimeoutMs, validatedParams),
      ),
    );
  }

  async chain<TData = unknown>(
    steps: readonly BrowserChainStep[],
    options?: BrowserChainOptions,
  ): Promise<BrowserCommandReceipt<BrowserChainResult<TData>>> {
    const validatedSteps = validateChain(steps);
    const validatedOptions = validateChainOptions(options);
    this.assertOpen();

    const protocolSteps = validatedSteps.map((step) => ({
      action: step.action,
      ...step.params,
    }));
    const delay = validatedOptions.delay
      ? {
          min: validatedOptions.delay.minMs ?? 300,
          max: validatedOptions.delay.maxMs ?? 1_200,
        }
      : undefined;
    const chainTimeoutMs = getChainTimeoutMs(
      this.commandTimeoutMs,
      validatedSteps,
      validatedOptions,
    );
    const params = validateParams({
      steps: protocolSteps,
      timeout: chainTimeoutMs,
      ...(validatedOptions.abortOnError === undefined
        ? {}
        : { abortOnError: validatedOptions.abortOnError }),
      ...(delay ? { delay } : {}),
      ...(validatedOptions.waitForSelector === undefined
        ? {}
        : { waitForSelector: validatedOptions.waitForSelector }),
      ...(validatedOptions.waitTimeoutMs === undefined
        ? {}
        : { waitTimeout: validatedOptions.waitTimeoutMs }),
      ...(validatedOptions.returnSnapshot === undefined
        ? {}
        : { returnSnapshot: validatedOptions.returnSnapshot }),
      ...(validatedOptions.returnScreenshot === undefined
        ? {}
        : { returnScreenshot: validatedOptions.returnScreenshot }),
    });

    return await this.enqueue(async () =>
      this.execute<BrowserChainResult<TData>>(
        "chain",
        params,
        combineSignals(this.signal, validatedOptions.signal),
        chainTimeoutMs + BROWSER_COMMAND_TIMEOUT_GRACE_MS,
      ),
    );
  }

  async selectBackend(
    backend: BrowserBackend,
  ): Promise<Readonly<{ backend: BrowserBackend }>> {
    if (backend !== "in-app" && backend !== "external") {
      throw new TypeError("browser backend must be 'in-app' or 'external'.");
    }
    this.assertOpen();
    return await this.enqueue(async () => {
      this.assertOpen();
      this.selectedBackend = backend;
      return Object.freeze({ backend });
    });
  }

  dispose(): Promise<void> {
    if (!this.disposePromise) {
      this.disposed = true;
      this.signal?.removeEventListener("abort", this.onSessionAbort);
      const turn = this.activeTurn;
      const releaseLease = this.enqueue(async () => {
        if (!turn) return;
        try {
          // A kernel/worker generation can disappear after an ordinary command
          // rejection or transport timeout. Releasing only this exact lease
          // lets a replacement generation for the same durable task reclaim
          // the tabs. End-of-task cleanup still runs through endTurn(), which
          // explicitly finalizes the task's tabs.
          await this.cleanupTurn(turn, true, false);
        } catch {
          // Stale disposal and unavailable transports are best-effort. Rust
          // lease fencing prevents this cleanup from touching a newer turn.
        } finally {
          if (this.activeTurn === turn) this.activeTurn = undefined;
          this.activeTurnBackends.clear();
        }
      });
      this.disposePromise = releaseLease.finally(() =>
        this.closeClientTransport(),
      );
    }
    return this.disposePromise;
  }

  private readonly onSessionAbort = () => {
    if (this.socket)
      this.invalidateSocket(this.socket, abortReason(this.signal!));
    this.connectingSocket?.destroy(abortReason(this.signal!));
  };

  private assertOpen(): void {
    if (this.disposed) throw new BrowserSessionDisposedError();
  }

  private createTurnLease(turnId: string) {
    if (!this.configuredLeaseConsumed) {
      this.configuredLeaseConsumed = true;
      return Object.freeze({
        turnId,
        ownerLeaseId: this.configuredOwnerLeaseId!,
        ownerLeaseIssuedAt: this.configuredOwnerLeaseIssuedAt!,
      });
    }
    const ownerLeaseIssuedAt = Math.max(
      Date.now(),
      lastBrowserOwnerLeaseIssuedAt + 1,
    );
    lastBrowserOwnerLeaseIssuedAt = ownerLeaseIssuedAt;
    return Object.freeze({
      turnId,
      ownerLeaseId: randomUUID(),
      ownerLeaseIssuedAt,
    });
  }

  private ensureTurn() {
    if (!this.activeTurn) {
      this.beginTurn(this.configuredTurnId ?? randomUUID());
    }
    return this.activeTurn!;
  }

  private async cleanupTurn(
    turn: Readonly<{
      turnId: string;
      ownerLeaseId: string;
      ownerLeaseIssuedAt: number;
    }>,
    allowDisposed: boolean,
    finalizeTabs = true,
  ): Promise<void> {
    const backends = [...this.activeTurnBackends];
    if (!finalizeTabs) {
      const releaseBackend = backends.includes("external")
        ? "external"
        : backends[0];
      if (releaseBackend) {
        await this.cleanupTurnOnBackend(
          turn,
          releaseBackend,
          allowDisposed,
          false,
          true,
        );
      }
      return;
    }
    let firstError: unknown;
    for (const [index, backend] of backends.entries()) {
      try {
        await this.cleanupTurnOnBackend(
          turn,
          backend,
          allowDisposed,
          true,
          index === backends.length - 1,
        );
      } catch (error) {
        firstError ??= error;
      }
    }
    if (firstError !== undefined) throw firstError;
  }

  private async cleanupTurnOnBackend(
    turn: Readonly<{
      turnId: string;
      ownerLeaseId: string;
      ownerLeaseIssuedAt: number;
    }>,
    backend: BrowserBackend,
    allowDisposed: boolean,
    finalizeTabs: boolean,
    releaseLease: boolean,
  ): Promise<void> {
    const timeoutMs = Math.min(
      this.commandTimeoutMs,
      MAX_BROWSER_TURN_CLEANUP_TIMEOUT_MS,
    );
    const deadline = Date.now() + timeoutMs;
    if (!this.socket || this.socket.destroyed || !this.socket.writable) {
      await this.connectOnce(undefined, deadline, timeoutMs, allowDisposed);
    }
    const send = async (action: "finalize_tabs" | "release_owner_lease") => {
      const requestId = randomUUID();
      return await this.roundTrip(
        {
          id: requestId,
          action,
          ...(action === "finalize_tabs" ? { keep: [] } : {}),
          ownerId: this.sessionId,
          sessionId: this.sessionId,
          turnId: turn.turnId,
          ownerLeaseId: turn.ownerLeaseId,
          ownerLeaseIssuedAt: turn.ownerLeaseIssuedAt,
          ...(backend === "external" ? { browserBackend: "extension" } : {}),
        },
        requestId,
        undefined,
        deadline,
        timeoutMs,
        allowDisposed,
      );
    };
    if (!finalizeTabs) {
      if (releaseLease) await send("release_owner_lease");
      return;
    }
    if (!releaseLease) {
      await send("finalize_tabs");
      return;
    }
    try {
      await send("finalize_tabs");
    } finally {
      await send("release_owner_lease").catch(() => undefined);
    }
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.then(operation);
    this.queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private closeClientTransport(): void {
    const error = new BrowserSessionDisposedError();
    this.connectingSocket?.destroy(error);
    this.connectingSocket = undefined;
    if (this.socket) this.invalidateSocket(this.socket, error);
  }

  private resolveExecutionConfig(): ResolvedExecutionConfig {
    if (this.executionConfig) return this.executionConfig;

    const bridgeEnv = this.getBridgeEnv();
    if (typeof bridgeEnv !== "object" || bridgeEnv === null) {
      throw new TypeError("getBridgeEnv must return an environment object.");
    }
    const bridgeSessionId = requireNonEmptyString(
      bridgeEnv.STELLA_BROWSER_SESSION,
      "bridge environment STELLA_BROWSER_SESSION",
    );
    const binaryPath = this.configuredBinaryPath ?? defaultBinaryPath();
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      ...bridgeEnv,
      ...this.configuredEnv,
      STELLA_BROWSER_SESSION: bridgeSessionId,
      STELLA_BROWSER_OWNER_ID: this.sessionId,
    };
    if (isJavaScriptShim(binaryPath)) env.ELECTRON_RUN_AS_NODE = "1";

    const endpoint =
      process.platform === "win32"
        ? Object.freeze({
            host: "127.0.0.1",
            port: getBrowserDaemonPort(bridgeSessionId),
          })
        : Object.freeze({
            path: path.join(getSocketDir(env), `${bridgeSessionId}.sock`),
          });
    this.executionConfig = Object.freeze({
      binaryPath,
      bridgeSessionId,
      env,
      endpoint,
    });
    return this.executionConfig;
  }

  private bindOwnerRoute(
    capability: InAppBrowserCapability & {
      turnId: string;
      ownerLeaseId: string;
    },
  ): ResolvedExecutionConfig {
    const current = this.resolveExecutionConfig();
    const validatedSessionId = requireNonEmptyString(
      capability.bridgeSessionId,
      "bridgeSessionId",
    );
    const env: NodeJS.ProcessEnv = {
      ...current.env,
      STELLA_BROWSER_SESSION: validatedSessionId,
    };
    const endpoint =
      process.platform === "win32"
        ? Object.freeze({
            host: "127.0.0.1",
            port: getBrowserDaemonPort(validatedSessionId),
          })
        : Object.freeze({
            path: path.join(getSocketDir(env), `${validatedSessionId}.sock`),
          });
    const config = Object.freeze({
      binaryPath: current.binaryPath,
      bridgeSessionId: validatedSessionId,
      env,
      endpoint,
    });
    if (this.socket && current.bridgeSessionId !== validatedSessionId) {
      this.invalidateSocket(
        this.socket,
        new BrowserTransportError(
          "connection_closed",
          "Browser capability switched daemon sessions.",
          { retryable: true },
        ),
        true,
      );
    }
    this.ownerRoute = Object.freeze({
      capability: Object.freeze({ ...capability }),
      config,
    });
    this.executionConfig = config;
    return config;
  }

  private async execute<TData>(
    action: string,
    params: BrowserCommandParams,
    signal: AbortSignal | undefined,
    timeoutMs = this.commandTimeoutMs,
  ): Promise<BrowserCommandReceipt<TData>> {
    this.assertOpen();
    throwIfAborted(signal);
    const turn = this.ensureTurn();
    const backend = this.selectedBackend;
    this.activeTurnBackends.add(backend);
    let config = this.ownerRoute?.config ?? this.resolveExecutionConfig();
    const requestId = randomUUID();
    const request = {
      id: requestId,
      action,
      ...params,
      ownerId: this.sessionId,
      sessionId: this.sessionId,
      turnId: turn.turnId,
      ownerLeaseId: turn.ownerLeaseId,
      ownerLeaseIssuedAt: turn.ownerLeaseIssuedAt,
      ...(backend === "external" ? { browserBackend: "extension" } : {}),
    };
    const startedAt = Date.now();
    const deadline = startedAt + timeoutMs;
    let response: BrowserCommandResult<TData>;
    let attempts = 0;
    let requestDispatched = false;

    try {
      for (;;) {
        attempts += 1;
        try {
          if (
            !BROWSER_OWNER_LIFECYCLE_ACTIONS.has(action)
          ) {
            config = await this.ensureInAppBrowserReady(
              config,
              turn,
              signal,
              deadline,
            );
          }
          await this.ensureConnected(signal, deadline, timeoutMs);
          requestDispatched = true;
          response = (await this.roundTrip(
            request,
            requestId,
            signal,
            deadline,
            timeoutMs,
          )) as BrowserCommandResult<TData>;
          if (
            backend === "external" &&
            !response.success &&
            /extension (?:proxy unavailable|delegation expired|delegation .*revoked)/i.test(
              response.error,
            )
          ) {
            throw new BrowserTransportError(
              "connection_closed",
              response.error,
              { retryable: true },
            );
          }
          break;
        } catch (cause) {
          this.assertOpen();
          throwIfAborted(signal);
          this.markManagedCapabilityForRecovery(cause);
          const managedBridge =
            this.resolveExecutionConfig().env.STELLA_BROWSER_MANAGED_BRIDGE ===
            "1";
          if (
            managedBridge &&
            requestDispatched &&
            cause instanceof BrowserTransportError &&
            !canReplayAfterManagedReplacement(action, params)
          ) {
            throw new BrowserTransportError(
              cause.code,
              `${cause.message} The '${action}' command may have completed before the managed browser backend disconnected, so Stella will not replay it automatically. Its outcome is unknown; inspect the current page and tab state before deciding whether to retry.`,
              { cause },
            );
          }
          if (
            attempts >= 2 ||
            !(cause instanceof BrowserTransportError) ||
            !cause.retryable ||
            this.remainingTime(deadline) <= 0
          ) {
            throw cause;
          }
          if (this.socket) this.invalidateSocket(this.socket, cause);
        }
      }
    } catch (cause) {
      this.assertOpen();
      const message =
        cause instanceof Error
          ? cause.message
          : `Browser daemon request failed: ${String(cause)}`;
      const abortSource = signal?.aborted
        ? signal.reason instanceof Error
          ? `${signal.reason.name}: ${signal.reason.message}`
          : String(signal.reason ?? "AbortSignal")
        : undefined;
      const provenance = `owner=${this.sessionId} turn=${turn.turnId} lease#=${leaseFingerprint(turn.ownerLeaseId)} request=${requestId} action=${action}`;
      throw new BrowserSessionCommandError(
        "execution_failed",
        `${message}${abortSource ? ` (abort source: ${abortSource})` : ""} [browser provenance: ${provenance}]`,
        {
          requestId,
          action,
          cause,
        },
      );
    }

    const receipt: BrowserCommandAttemptReceipt<TData> = Object.freeze({
      sessionId: this.sessionId,
      bridgeSessionId: config.bridgeSessionId,
      requestId,
      action,
      params,
      result: response,
      attempts,
      durationMs: Date.now() - startedAt,
    });
    if (!response.success) {
      throw new BrowserSessionCommandError("command_failed", response.error, {
        requestId,
        action,
        receipt,
      });
    }
    return receipt as BrowserCommandReceipt<TData>;
  }

  private remainingTime(deadline: number): number {
    return Math.max(0, deadline - Date.now());
  }

  private async ensureInAppBrowserReady(
    config: ResolvedExecutionConfig,
    turn: Readonly<{
      turnId: string;
      ownerLeaseId: string;
      ownerLeaseIssuedAt: number;
    }>,
    signal: AbortSignal | undefined,
    deadline: number,
  ): Promise<ResolvedExecutionConfig> {
    const capability = this.ownerRoute?.capability;
    if (
      capability?.turnId === turn.turnId &&
      capability.ownerLeaseId === turn.ownerLeaseId &&
      capability.capabilityExpiresAt > Date.now()
    ) {
      return this.ownerRoute!.config;
    }
    const remainingMs = this.remainingTime(deadline);
    if (remainingMs <= 0) {
      throw new Error(
        "Browser command timed out during in-app initialization.",
      );
    }
    const initialized = await this.initializeInAppBrowser({
      env: config.env,
      signal,
      timeoutMs: remainingMs,
      sessionId: this.sessionId,
      turnId: turn.turnId,
      ownerLeaseId: turn.ownerLeaseId,
      ownerLeaseIssuedAt: turn.ownerLeaseIssuedAt,
      ...(this.recoverInAppBrowserCapability ? { recover: true } : {}),
    });
    if (initialized === true) {
      this.recoverInAppBrowserCapability = false;
      return this.bindOwnerRoute({
        bridgeSessionId: config.bridgeSessionId,
        capabilityExpiresAt: Number.MAX_SAFE_INTEGER,
        turnId: turn.turnId,
        ownerLeaseId: turn.ownerLeaseId,
      });
    }
    if (initialized && typeof initialized === "object") {
      this.recoverInAppBrowserCapability = false;
      return this.bindOwnerRoute({
        ...initialized,
        turnId: turn.turnId,
        ownerLeaseId: turn.ownerLeaseId,
      });
    }
    return config;
  }

  private markManagedCapabilityForRecovery(
    cause: unknown,
  ): void {
    if (
      !(cause instanceof BrowserTransportError) ||
      (!cause.retryable && cause.code !== "timeout") ||
      this.resolveExecutionConfig().env.STELLA_BROWSER_MANAGED_BRIDGE !== "1"
    ) {
      return;
    }
    // A timed-out command may leave the single-threaded per-owner daemon
    // alive but wedged in page evaluation. Dropping only the socket causes
    // every follow-up to reconnect to that same process. Poison the cached
    // capability so bootstrap replaces the backend on the next attempt/call.
    this.ownerRoute = undefined;
    this.recoverInAppBrowserCapability = true;
  }

  private async ensureConnected(
    signal: AbortSignal | undefined,
    deadline: number,
    timeoutMs: number,
  ): Promise<void> {
    if (this.socket && !this.socket.destroyed && this.socket.writable) return;
    try {
      await this.connectOnce(signal, deadline, timeoutMs);
      return;
    } catch (initialError) {
      throwIfAborted(signal);
      if (
        this.resolveExecutionConfig().env.STELLA_BROWSER_MANAGED_BRIDGE === "1"
      ) {
        throw initialError;
      }
      if (this.fallbackAttempted) throw initialError;
      this.fallbackAttempted = true;

      let fallbackError: unknown;
      try {
        await this.startDaemonFallback(signal, deadline, timeoutMs);
      } catch (cause) {
        fallbackError = cause;
      }
      try {
        await this.connectOnce(signal, deadline, timeoutMs);
      } catch (reconnectError) {
        const details = [
          reconnectError instanceof Error
            ? reconnectError.message
            : String(reconnectError),
          fallbackError instanceof Error
            ? `Startup fallback failed: ${fallbackError.message}`
            : fallbackError
              ? `Startup fallback failed: ${String(fallbackError)}`
              : "",
        ]
          .filter(Boolean)
          .join("\n");
        throw new BrowserTransportError("connection_failed", details, {
          retryable: true,
          cause: reconnectError,
        });
      }
    }
  }

  private async startDaemonFallback(
    signal: AbortSignal | undefined,
    deadline: number,
    commandBudgetMs: number,
  ): Promise<void> {
    const config = this.resolveExecutionConfig();
    const shim = isJavaScriptShim(config.binaryPath);
    const timeoutMs = this.remainingTime(deadline);
    if (timeoutMs <= 0) {
      throw new BrowserTransportError(
        "timeout",
        `Browser command timed out after ${commandBudgetMs}ms.`,
      );
    }
    await this.runner({
      command: shim ? process.execPath : config.binaryPath,
      args: [
        ...(shim ? [config.binaryPath] : []),
        "service",
        "ensure",
        "--session",
        config.bridgeSessionId,
        "--json",
      ],
      cwd: this.cwd,
      env: config.env,
      signal,
      timeoutMs,
      maxOutputBytes: this.maxOutputBytes,
    });
  }

  private async connectOnce(
    signal: AbortSignal | undefined,
    deadline: number,
    commandBudgetMs: number,
    allowDisposed = false,
  ): Promise<void> {
    if (!allowDisposed) this.assertOpen();
    throwIfAborted(signal);
    const timeoutMs = this.remainingTime(deadline);
    if (timeoutMs <= 0) {
      throw new BrowserTransportError(
        "timeout",
        `Browser command timed out after ${commandBudgetMs}ms.`,
      );
    }
    const config = this.resolveExecutionConfig();

    await new Promise<void>((resolve, reject) => {
      const socket =
        "path" in config.endpoint
          ? createConnection({ path: config.endpoint.path })
          : createConnection({
              host: config.endpoint.host,
              port: config.endpoint.port,
            });
      this.connectingSocket = socket;
      let settled = false;
      const endpoint =
        "path" in config.endpoint
          ? config.endpoint.path
          : `${config.endpoint.host}:${config.endpoint.port}`;
      const cleanup = () => {
        clearTimeout(timeout);
        signal?.removeEventListener("abort", onAbort);
        socket.removeListener("connect", onConnect);
        socket.removeListener("error", onError);
        if (this.connectingSocket === socket) this.connectingSocket = undefined;
      };
      const finish = (callback: () => void) => {
        if (settled) return;
        settled = true;
        cleanup();
        callback();
      };
      const onConnect = () =>
        finish(() => {
          if (this.disposed && !allowDisposed) {
            socket.destroy();
            reject(new BrowserSessionDisposedError());
            return;
          }
          socket.setNoDelay(true);
          socket.unref();
          this.installSocket(socket);
          this.fallbackAttempted = false;
          resolve();
        });
      const onError = (cause: Error) =>
        finish(() => {
          socket.destroy();
          reject(
            new BrowserTransportError(
              "connection_failed",
              `Failed to connect to browser daemon at ${endpoint}: ${cause.message}`,
              { retryable: true, cause },
            ),
          );
        });
      const onAbort = () =>
        finish(() => {
          socket.destroy();
          reject(abortReason(signal!));
        });
      const timeout = setTimeout(
        () =>
          finish(() => {
            socket.destroy();
            reject(
              new BrowserTransportError(
                "timeout",
                `Timed out connecting to browser daemon at ${endpoint}.`,
              ),
            );
          }),
        timeoutMs,
      );

      socket.once("connect", onConnect);
      socket.once("error", onError);
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  }

  private installSocket(socket: Socket): void {
    if (this.socket && this.socket !== socket) {
      this.invalidateSocket(
        this.socket,
        new BrowserTransportError(
          "connection_closed",
          "Browser daemon connection was replaced.",
          { retryable: true },
        ),
      );
    }
    this.socket = socket;
    this.readBuffer = EMPTY_BUFFER;
    socket.on("data", (chunk: Buffer) => this.onSocketData(socket, chunk));
    socket.on("error", (cause) =>
      this.invalidateSocket(
        socket,
        new BrowserTransportError(
          "connection_closed",
          `Browser daemon connection failed: ${cause.message}`,
          { retryable: true, cause },
        ),
      ),
    );
    socket.on("close", () =>
      this.invalidateSocket(
        socket,
        new BrowserTransportError(
          "connection_closed",
          "Browser daemon closed the connection before responding.",
          { retryable: true },
        ),
      ),
    );
  }

  private roundTrip(
    request: Readonly<Record<string, unknown>>,
    requestId: string,
    signal: AbortSignal | undefined,
    deadline: number,
    commandBudgetMs: number,
    allowDisposed = false,
  ): Promise<BrowserCommandResult> {
    if (!allowDisposed) this.assertOpen();
    throwIfAborted(signal);
    const socket = this.socket;
    if (!socket || socket.destroyed || !socket.writable) {
      throw new BrowserTransportError(
        "connection_closed",
        "Browser daemon connection is not writable.",
        { retryable: true },
      );
    }
    if (this.pending) {
      throw new BrowserTransportError(
        "write_failed",
        "BrowserSession attempted to overlap daemon requests.",
      );
    }
    const frame = Buffer.from(`${JSON.stringify(request)}\n`, "utf8");
    if (frame.byteLength > this.maxOutputBytes) {
      throw new BrowserTransportError(
        "request_limit",
        `Browser daemon request exceeded the ${this.maxOutputBytes}-byte limit.`,
      );
    }
    const timeoutMs = this.remainingTime(deadline);
    if (timeoutMs <= 0) {
      throw new BrowserTransportError(
        "timeout",
        `Browser command timed out after ${commandBudgetMs}ms.`,
      );
    }

    return new Promise<BrowserCommandResult>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.invalidateSocket(
          socket,
          new BrowserTransportError(
            "timeout",
            `Browser command timed out after ${commandBudgetMs}ms.`,
          ),
        );
      }, timeoutMs);
      const onAbort = () => this.invalidateSocket(socket, abortReason(signal!));
      this.pending = {
        socket,
        requestId,
        resolve,
        reject,
        timeout,
        signal,
        onAbort,
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      socket.write(frame, (cause) => {
        if (!cause) return;
        this.invalidateSocket(
          socket,
          new BrowserTransportError(
            "write_failed",
            `Failed to write browser daemon request: ${cause.message}`,
            { retryable: true, cause },
          ),
        );
      });
    });
  }

  private onSocketData(socket: Socket, chunk: Buffer): void {
    if (socket !== this.socket) return;
    if (!this.pending) {
      this.invalidateSocket(
        socket,
        new BrowserTransportError(
          "invalid_response",
          "Browser daemon sent an unsolicited response.",
          { retryable: true },
        ),
      );
      return;
    }
    this.readBuffer = Buffer.concat([this.readBuffer, chunk]);
    const newline = this.readBuffer.indexOf(0x0a);
    if (newline < 0) {
      if (this.readBuffer.byteLength > this.maxOutputBytes) {
        this.invalidateSocket(
          socket,
          new BrowserTransportError(
            "output_limit",
            `Browser daemon response exceeded the ${this.maxOutputBytes}-byte limit.`,
          ),
        );
      }
      return;
    }
    if (newline > this.maxOutputBytes) {
      this.invalidateSocket(
        socket,
        new BrowserTransportError(
          "output_limit",
          `Browser daemon response exceeded the ${this.maxOutputBytes}-byte limit.`,
        ),
      );
      return;
    }

    const responseFrame = this.readBuffer
      .subarray(0, newline)
      .toString("utf8")
      .trim();
    const remainder = this.readBuffer
      .subarray(newline + 1)
      .toString("utf8")
      .trim();
    this.readBuffer = EMPTY_BUFFER;
    if (remainder) {
      this.invalidateSocket(
        socket,
        new BrowserTransportError(
          "invalid_response",
          "Browser daemon sent multiple responses for one serialized request.",
          { retryable: true },
        ),
      );
      return;
    }

    try {
      const parsed: unknown = JSON.parse(responseFrame);
      const response = normalizeResponse(parsed, this.pending.requestId);
      const pending = this.takePending();
      pending?.resolve(response);
    } catch (cause) {
      this.invalidateSocket(
        socket,
        cause instanceof BrowserTransportError
          ? cause
          : new BrowserTransportError(
              "invalid_response",
              `Browser daemon returned invalid JSON: ${cause instanceof Error ? cause.message : String(cause)}`,
              { retryable: true, cause },
            ),
      );
    }
  }

  private takePending(): PendingResponse | undefined {
    const pending = this.pending;
    if (!pending) return undefined;
    this.pending = undefined;
    clearTimeout(pending.timeout);
    if (pending.signal && pending.onAbort) {
      pending.signal.removeEventListener("abort", pending.onAbort);
    }
    return pending;
  }

  private invalidateSocket(
    socket: Socket,
    error: Error,
    preserveCapability = false,
  ): void {
    if (socket !== this.socket) return;
    this.socket = undefined;
    if (!preserveCapability) this.ownerRoute = undefined;
    this.readBuffer = EMPTY_BUFFER;
    const pending = this.takePending();
    socket.removeAllListeners();
    if (!socket.destroyed) socket.destroy();
    pending?.reject(error);
  }
}

export const createBrowserSession = (
  options: BrowserSessionOptions,
): BrowserSessionClient => new BrowserSession(options);
