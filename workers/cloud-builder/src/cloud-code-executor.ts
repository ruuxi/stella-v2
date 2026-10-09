/**
 * The cloud `code` tool's runtime: OpenCode's confined interpreter
 * (`./vendor/opencode-codemode`), run in-process in the Durable Object.
 *
 * Generated code is never evaluated by a JavaScript engine. Acorn parses it
 * and an owned tree-walking interpreter runs a bounded JavaScript subset whose
 * only authority is the host tree built here: `tools.<name>` for each allowed
 * Stella tool, `tools.$list/$search/$describe`, and the `connect`, `history`,
 * `browser`, and `memory` globals. There are no modules, timers, network,
 * bindings, or secrets for the program to reach.
 */

import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import { acquireAbortLatch } from "@stella/runtime/kernel/agent-core/abort-bridge.js";
import {
  forkAbortTimer,
  runToolEffect,
} from "@stella/runtime/kernel/tools/effect-runtime.js";
import { CONNECT_DOCUMENTATION } from "@stella/runtime/kernel/connectors/connect-documentation.js";
import {
  cloneBoundedJsonValue,
  truncateUtf8,
  utf8ByteLengthUpTo,
  type BoundedJsonLimits,
} from "./cloud-code-bounds.js";
import { CodeMode, toolError } from "./vendor/opencode-codemode/index.js";
import {
  globalRootKey,
  isBlockedMember,
  isGlobalRootKey,
  type HostTool,
  type HostTools,
} from "./vendor/opencode-codemode/tool-runtime.js";

export const CLOUD_CODE_DEFAULT_TIMEOUT_MS = 20_000;
export const CLOUD_CODE_MAX_TIMEOUT_MS = 60_000;
export const CLOUD_CODE_MAX_SOURCE_BYTES = 128 * 1024;
export const CLOUD_CODE_MAX_TOOL_CALLS = 64;
/** The interpreter's own fixed cap; further calls queue until one settles. */
export const CLOUD_CODE_MAX_CONCURRENT_TOOL_CALLS = 8;
export const CLOUD_CODE_MAX_CATALOG_TOOLS = 64;
export const CLOUD_CODE_MAX_TOOL_DESCRIPTION_BYTES = 4 * 1024;

export const CLOUD_CODE_VALUE_MAX_BYTES = 8 * 1024 * 1024;
const CLOUD_CODE_MAX_VALUE_DEPTH = 16;
const CLOUD_CODE_MAX_VALUE_NODES = 200_000;
const CLOUD_CODE_MAX_VALUE_ENTRIES = 200_000;
const CLOUD_CODE_MAX_STRING_BYTES = 8 * 1024 * 1024;

/**
 * Reserved intrinsics served host-side. `$`-prefixed names are never real
 * tools (the device kernel reserves them too).
 */
export const CLOUD_CODE_SEARCH_INTRINSIC = "$search";
export const CLOUD_CODE_DESCRIBE_INTRINSIC = "$describe";
export const CLOUD_CODE_CONNECT_INTRINSIC = "$connect";
export const CLOUD_CODE_HISTORY_INTRINSIC = "$history";
/** Present only for an agent's code, which holds the cloud browser. */
export const CLOUD_CODE_BROWSER_INTRINSIC = "$browser";
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
  CLOUD_CODE_MEMORY_INTRINSIC,
]);

const MAX_TOOL_NAME_LENGTH = 160;
const MAX_LOG_LINES = 100;
const MAX_LOG_LINE_LENGTH = 4_000;
const MAX_LOG_TOTAL_BYTES = 100_000;
const MAX_NESTED_ERROR_CHARS = 4_000;
const IDENTIFIER_RE = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

export type CloudCodeJsonSchema = Record<string, unknown>;
export type CloudCodeToolApproval = "not_required" | "required";

export type CloudCodeToolCallContext = Readonly<{
  executionId: string;
  toolCallId: string;
  rawName: string;
  signal: AbortSignal;
}>;

export type CloudCodeToolDefinition = Readonly<{
  /** The tool's exact name; code calls it as `tools[rawName](input)`. */
  rawName: string;
  description: string;
  inputSchema: unknown;
  outputSchema?: unknown;
  /** Required explicitly so a newly-added side-effecting tool cannot default open. */
  approval: CloudCodeToolApproval;
  execute: (
    input: unknown,
    context: CloudCodeToolCallContext,
  ) => Promise<unknown> | unknown;
}>;

export type CloudCodeToolNameMapping = Readonly<{
  rawName: string;
  approval: CloudCodeToolApproval;
}>;

export type PreparedCloudCodeTools = Readonly<{
  /** Exact, validated names reachable as `tools[name]`. */
  nameMappings: readonly CloudCodeToolNameMapping[];
}>;

export type CloudCodeFailureCode =
  | "invalid_request"
  | "aborted"
  | "timeout"
  | "approval_required"
  | "resource_limit"
  | "tool_failed"
  | "sandbox_error";

export type CloudCodeExecutionResult =
  | Readonly<{
      ok: true;
      result: unknown;
      logs?: readonly string[];
    }>
  | Readonly<{
      ok: false;
      code: CloudCodeFailureCode;
      error: string;
      logs?: readonly string[];
      tool?: CloudCodeToolNameMapping;
    }>;

/**
 * Sandbox intrinsics (`tools.$search`, `tools.$describe`, `connect.*`, ...)
 * resolved host-side. They share the value bounds with tools but are not
 * metered as nested tool calls, matching the device kernel where
 * `$search`/`$describe` are catalog lookups rather than tool executions.
 */
export type CloudCodeIntrinsic = (
  input: unknown,
  context: Readonly<{ executionId: string; signal: AbortSignal }>,
) => Promise<unknown> | unknown;

export type CloudCodeExecutionRequest = Readonly<{
  code: string;
  tools: PreparedCloudCodeTools;
  executionId?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  /** `$`-named intrinsics; every key must be in CLOUD_CODE_INTRINSIC_NAMES. */
  intrinsics?: Readonly<Record<string, CloudCodeIntrinsic>>;
  /** Host-only diagnostics. The original error is never sent to generated code. */
  onToolError?: (
    error: unknown,
    context: CloudCodeToolCallContext,
  ) => Promise<void> | void;
}>;

type FatalFailure = Readonly<{
  code: Extract<
    CloudCodeFailureCode,
    "approval_required" | "resource_limit" | "tool_failed"
  >;
  tool: CloudCodeToolNameMapping;
}>;

const VALUE_LIMITS: BoundedJsonLimits = Object.freeze({
  maxBytes: CLOUD_CODE_VALUE_MAX_BYTES,
  maxDepth: CLOUD_CODE_MAX_VALUE_DEPTH,
  maxNodes: CLOUD_CODE_MAX_VALUE_NODES,
  maxEntries: CLOUD_CODE_MAX_VALUE_ENTRIES,
  maxStringBytes: CLOUD_CODE_MAX_STRING_BYTES,
});

export class CloudCodeConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CloudCodeConfigurationError";
  }
}

/**
 * A nested tool's own model-visible failure. Unlike a host exception, this
 * is the tool telling the model what went wrong (the device kernel throws
 * the tool's `error` text into the REPL the same way), so it rejects the
 * awaiting call inside the program — catchable by generated code — instead
 * of failing the whole execution.
 */
export class CloudCodeNestedToolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CloudCodeNestedToolError";
  }
}

const nestedErrorMessage = (error: unknown): string => {
  const raw =
    error instanceof Error && error.message.trim()
      ? error.message
      : "The call failed.";
  return truncateUtf8(raw, MAX_NESTED_ERROR_CHARS, "[error truncated]");
};

/**
 * The code clock: the execution deadline counts only the time the program
 * spends in its own code. It pauses while a host call is in flight — a
 * connect card waiting on the user, an image job, a connector action — so
 * those calls are bounded by their own timeouts, not by the program's.
 */
type CodeClock = Readonly<{
  expired: Promise<void>;
  pause(): void;
  resume(): void;
  dispose(): void;
}>;

const createCodeClock = (timeoutMs: number): CodeClock => {
  let remainingMs = timeoutMs;
  let cancelTimer: (() => void) | null = null;
  let startedAt = 0;
  let inflight = 0;
  let disposed = false;
  let expire: () => void = () => {};
  const expired = new Promise<void>((resolve) => {
    expire = resolve;
  });
  const start = () => {
    if (disposed || cancelTimer !== null) return;
    startedAt = Date.now();
    cancelTimer = forkAbortTimer(remainingMs, () => {
      cancelTimer = null;
      expire();
    });
  };
  const stop = () => {
    if (cancelTimer === null) return;
    cancelTimer();
    cancelTimer = null;
    remainingMs = Math.max(1, remainingMs - (Date.now() - startedAt));
  };
  start();
  return {
    expired,
    pause: () => {
      inflight += 1;
      if (inflight === 1) stop();
    },
    resume: () => {
      inflight = Math.max(0, inflight - 1);
      if (inflight === 0) start();
    },
    dispose: () => {
      disposed = true;
      cancelTimer?.();
      cancelTimer = null;
    },
  };
};

const definitionsByPreparedTools = new WeakMap<
  PreparedCloudCodeTools,
  readonly CloudCodeToolDefinition[]
>();

const assertToolName = (rawName: string): void => {
  if (!rawName || rawName !== rawName.trim()) {
    throw new CloudCodeConfigurationError(
      "Cloud code tool names must be non-empty and have no surrounding whitespace.",
    );
  }
  if (rawName.length > MAX_TOOL_NAME_LENGTH) {
    throw new CloudCodeConfigurationError(
      `Cloud code tool name exceeds ${MAX_TOOL_NAME_LENGTH} characters.`,
    );
  }
  if (
    rawName.startsWith("$") ||
    isBlockedMember(rawName) ||
    isGlobalRootKey(rawName)
  ) {
    throw new CloudCodeConfigurationError(
      `Cloud code tool name "${rawName}" is reserved.`,
    );
  }
};

/** Validate and freeze the catalog once, before a turn exposes it to code. */
export const prepareCloudCodeTools = (
  tools: readonly CloudCodeToolDefinition[],
): PreparedCloudCodeTools => {
  if (tools.length > CLOUD_CODE_MAX_CATALOG_TOOLS) {
    throw new CloudCodeConfigurationError(
      `Cloud code catalog exceeds ${CLOUD_CODE_MAX_CATALOG_TOOLS} tools.`,
    );
  }
  const rawNames = new Set<string>();
  const definitions: CloudCodeToolDefinition[] = [];
  const nameMappings: CloudCodeToolNameMapping[] = [];
  for (const candidate of tools) {
    assertToolName(candidate.rawName);
    if (
      candidate.approval !== "not_required" &&
      candidate.approval !== "required"
    ) {
      throw new CloudCodeConfigurationError(
        `Cloud code tool "${candidate.rawName}" must declare an approval policy.`,
      );
    }
    if (rawNames.has(candidate.rawName)) {
      throw new CloudCodeConfigurationError(
        `Duplicate cloud code tool name "${candidate.rawName}".`,
      );
    }
    if (
      utf8ByteLengthUpTo(
        candidate.description,
        CLOUD_CODE_MAX_TOOL_DESCRIPTION_BYTES,
      ) > CLOUD_CODE_MAX_TOOL_DESCRIPTION_BYTES
    ) {
      throw new CloudCodeConfigurationError(
        `Cloud code tool "${candidate.rawName}" description exceeds ${CLOUD_CODE_MAX_TOOL_DESCRIPTION_BYTES} bytes.`,
      );
    }
    rawNames.add(candidate.rawName);
    definitions.push(Object.freeze({ ...candidate }));
    nameMappings.push(
      Object.freeze({
        rawName: candidate.rawName,
        approval: candidate.approval,
      }),
    );
  }
  const prepared = Object.freeze({
    nameMappings: Object.freeze(nameMappings),
  });
  definitionsByPreparedTools.set(prepared, Object.freeze(definitions));
  return prepared;
};

const validateTimeout = (timeoutMs: number | undefined): number | null => {
  const timeout = timeoutMs ?? CLOUD_CODE_DEFAULT_TIMEOUT_MS;
  if (
    !Number.isSafeInteger(timeout) ||
    timeout <= 0 ||
    timeout > CLOUD_CODE_MAX_TIMEOUT_MS
  ) {
    return null;
  }
  return timeout;
};

const validateExecutionId = (executionId: string): boolean =>
  /^[A-Za-z0-9][A-Za-z0-9:._-]{0,127}$/.test(executionId);

const boundedLogs = (
  logs: readonly string[] | undefined,
): readonly string[] | undefined => {
  if (!logs || logs.length === 0) return undefined;
  const bounded: string[] = [];
  let totalBytes = 0;
  for (const line of logs) {
    if (bounded.length >= MAX_LOG_LINES || totalBytes >= MAX_LOG_TOTAL_BYTES) {
      break;
    }
    const remaining = Math.min(
      MAX_LOG_LINE_LENGTH,
      MAX_LOG_TOTAL_BYTES - totalBytes,
    );
    const value = truncateUtf8(line, remaining, "[log truncated]");
    const bytes = utf8ByteLengthUpTo(value, remaining);
    if (bytes <= 0 || bytes > remaining) continue;
    bounded.push(value);
    totalBytes += bytes;
  }
  return Object.freeze(bounded);
};

/**
 * Program values arrive as plain data whose object fields may still hold
 * `undefined`. Drop those fields (and null out undefined array slots), as
 * `JSON.stringify` would, before the bounded copy, which refuses `undefined`.
 */
const withoutUndefined = (value: unknown): unknown => {
  if (Array.isArray(value)) {
    return value.map((item) =>
      item === undefined ? null : withoutUndefined(item),
    );
  }
  if (value !== null && typeof value === "object") {
    const output: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      if (item !== undefined) output[key] = withoutUndefined(item);
    }
    return output;
  }
  return value;
};

/** A program-supplied value, bounded; `undefined` stays `undefined`. */
const boundedProgramValue = (
  value: unknown,
): { ok: true; value: unknown } | { ok: false } => {
  if (value === undefined) return { ok: true, value: undefined };
  const bounded = cloneBoundedJsonValue(withoutUndefined(value), VALUE_LIMITS);
  return bounded.ok ? { ok: true, value: bounded.value } : { ok: false };
};

/** A catchable failure inside the program, as `catch (error)` sees it. */
const programError = (message: string) => toolError(message);

const fatalResult = (
  failure: FatalFailure,
  logs: readonly string[] | undefined,
): CloudCodeExecutionResult => {
  const action =
    failure.code === "approval_required"
      ? "requires explicit approval"
      : failure.code === "resource_limit"
        ? "exceeded the nested-call resource limit"
        : "failed";
  return {
    ok: false,
    code: failure.code,
    error: `Cloud code tool "${failure.tool.rawName}" ${action}.`,
    tool: failure.tool,
    ...(logs ? { logs } : {}),
  };
};

/**
 * The interpreter's message already names the source location; suggestions
 * it does not already spell out (such as the discovery idioms after an
 * unknown tool) follow it.
 */
const diagnosticText = (diagnostic: CodeMode.Diagnostic): string =>
  truncateUtf8(
    [
      `${diagnostic.kind}: ${diagnostic.message}`,
      ...(diagnostic.suggestions ?? []).filter(
        (suggestion) => !diagnostic.message.includes(suggestion),
      ),
    ].join(" "),
    MAX_NESTED_ERROR_CHARS,
    "[error truncated]",
  );

const mapProgramResult = (result: CodeMode.Result): CloudCodeExecutionResult => {
  const logs = boundedLogs(result.logs);
  if (!result.ok) {
    return {
      ok: false,
      code: "sandbox_error",
      error: diagnosticText(result.error),
      ...(logs ? { logs } : {}),
    };
  }
  const bounded = cloneBoundedJsonValue(result.value, VALUE_LIMITS);
  if (!bounded.ok) {
    return {
      ok: false,
      code: "resource_limit",
      error: "Cloud code execution exceeded its value resource limit.",
      ...(logs ? { logs } : {}),
    };
  }
  return { ok: true, result: bounded.value, ...(logs ? { logs } : {}) };
};

type Requirement = (value: unknown, name: string) => unknown;

const requireNonEmptyString =
  (method: string): Requirement =>
  (value, name) => {
    if (typeof value !== "string" || !value.trim()) {
      throw programError(`${method}: ${name} must be a non-empty string.`);
    }
    return value.trim();
  };

const requirePlainObject =
  (method: string): Requirement =>
  (value, name) => {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      throw programError(`${method}: ${name} must be a plain object.`);
    }
    return value;
  };

/** Trailing omitted arguments are dropped, as the host contracts expect. */
const trimTrailingUndefined = (args: readonly unknown[]): unknown[] => {
  let end = args.length;
  while (end > 0 && args[end - 1] === undefined) end -= 1;
  return args.slice(0, end);
};

const BROWSER_METHODS = [
  "open",
  "navigate",
  "observe",
  "click",
  "fill",
  "press",
  "select",
  "wait",
  "tabs",
  "focusTab",
  "back",
  "forward",
  "reload",
  "hover",
  "scroll",
  "check",
  "uncheck",
  "text",
  "screenshot",
  "evaluate",
  "cookies",
  "setCookies",
  "clearCookies",
  "requests",
  "responseBody",
  "close",
  "requestLoginTakeover",
  "requestDeviceCodeFixture",
] as const;

/**
 * Production entry point: run one program in the confined interpreter with
 * this turn's tools and intrinsics, bounded by the code clock, the caller's
 * abort signal, and the nested-call budget.
 */
export const executeCloudCode = async (
  request: CloudCodeExecutionRequest,
): Promise<CloudCodeExecutionResult> => {
  const definitions = definitionsByPreparedTools.get(request.tools);
  if (!definitions) {
    return {
      ok: false,
      code: "invalid_request",
      error: "Cloud code tools were not prepared by this runtime.",
    };
  }
  const timeout = validateTimeout(request.timeoutMs);
  if (timeout === null) {
    return {
      ok: false,
      code: "invalid_request",
      error: `Cloud code timeout must be an integer from 1 to ${CLOUD_CODE_MAX_TIMEOUT_MS} milliseconds.`,
    };
  }
  if (!request.code.trim()) {
    return {
      ok: false,
      code: "invalid_request",
      error: "Cloud code source must not be empty.",
    };
  }
  if (
    utf8ByteLengthUpTo(request.code, CLOUD_CODE_MAX_SOURCE_BYTES) >
    CLOUD_CODE_MAX_SOURCE_BYTES
  ) {
    return {
      ok: false,
      code: "invalid_request",
      error: `Cloud code source exceeds ${CLOUD_CODE_MAX_SOURCE_BYTES} bytes.`,
    };
  }
  const executionId = request.executionId ?? crypto.randomUUID();
  if (!validateExecutionId(executionId)) {
    return {
      ok: false,
      code: "invalid_request",
      error: "Cloud code execution id is invalid.",
    };
  }
  for (const name of Object.keys(request.intrinsics ?? {})) {
    if (!CLOUD_CODE_INTRINSIC_NAMES.has(name)) {
      return {
        ok: false,
        code: "invalid_request",
        error: `Cloud code intrinsic "${name}" is not a reserved intrinsic name.`,
      };
    }
  }
  if (request.signal?.aborted) {
    return {
      ok: false,
      code: "aborted",
      error: "Cloud code execution was canceled.",
    };
  }

  const program = Effect.scoped(
    Effect.gen(function* () {
      const signalController = new AbortController();
      const clock = createCodeClock(timeout);
      const fatal = yield* Deferred.make<FatalFailure>();
      const abortLatch = yield* acquireAbortLatch(request.signal);
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          clock.dispose();
          if (!signalController.signal.aborted) signalController.abort();
        }),
      );
      const canceled = () =>
        programError("Cloud code execution was canceled.");
      let sequence = 0;

      /**
       * One host call. The code clock pauses while it is in flight; a
       * rejection reaches the program as a catchable error.
       */
      const hostCall = (
        run: () => Promise<unknown> | unknown,
        failure: (error: unknown) => Effect.Effect<never, unknown>,
      ): Effect.Effect<unknown, unknown> =>
        Effect.suspend(() => {
          if (signalController.signal.aborted) return Effect.fail(canceled());
          clock.pause();
          return Effect.tryPromise({
            try: async () => await run(),
            catch: (error) => error,
          }).pipe(
            Effect.catch((error) =>
              signalController.signal.aborted
                ? Effect.fail(canceled())
                : failure(error),
            ),
            Effect.ensuring(Effect.sync(() => clock.resume())),
          );
        });

      const boundedResult = (
        label: string,
        result: unknown,
      ): Effect.Effect<unknown, unknown> => {
        const bounded = boundedProgramValue(result);
        return bounded.ok
          ? Effect.succeed(bounded.value)
          : Effect.fail(
              programError(`${label} result exceeded the sandbox value limit.`),
            );
      };

      /** An intrinsic call: catchable on every failure, never metered. */
      const intrinsicCall = (
        name: string,
        input: unknown,
      ): Effect.Effect<unknown, unknown> => {
        const intrinsic = request.intrinsics?.[name];
        if (!intrinsic) {
          return Effect.fail(programError(`${name} is unavailable here.`));
        }
        const bounded = boundedProgramValue(input);
        if (!bounded.ok) {
          return Effect.fail(
            programError(`${name} input exceeded the sandbox value limit.`),
          );
        }
        return hostCall(
          () =>
            intrinsic(bounded.value, {
              executionId,
              signal: signalController.signal,
            }),
          (error) => Effect.fail(programError(nestedErrorMessage(error))),
        ).pipe(Effect.flatMap((result) => boundedResult(name, result)));
      };

      /** Ends the whole execution: the program is interrupted, not told. */
      const failFatally = (
        failure: FatalFailure,
      ): Effect.Effect<never, unknown> =>
        Deferred.succeed(fatal, failure).pipe(
          Effect.andThen(
            Effect.sync(() => {
              if (!signalController.signal.aborted) signalController.abort();
            }),
          ),
          Effect.andThen(Effect.never),
        );

      const toolCall =
        (definition: CloudCodeToolDefinition, tool: CloudCodeToolNameMapping) =>
        (...args: unknown[]): Effect.Effect<unknown, unknown> =>
          Effect.suspend(() => {
            if (args.length > 1) {
              return Effect.fail(
                programError(
                  `tools[${JSON.stringify(tool.rawName)}] takes one input object.`,
                ),
              );
            }
            if (sequence >= CLOUD_CODE_MAX_TOOL_CALLS) {
              return failFatally({ code: "resource_limit", tool });
            }
            sequence += 1;
            if (tool.approval === "required") {
              return failFatally({ code: "approval_required", tool });
            }
            const input = boundedProgramValue(args[0] ?? {});
            if (!input.ok) return failFatally({ code: "resource_limit", tool });
            const context: CloudCodeToolCallContext = Object.freeze({
              executionId,
              toolCallId: `${executionId}:${sequence}:${tool.rawName}`,
              rawName: tool.rawName,
              signal: signalController.signal,
            });
            return hostCall(
              () => definition.execute(input.value, context),
              (error) => {
                if (error instanceof CloudCodeNestedToolError) {
                  // The tool's own report: reject this one call so the
                  // program can catch it, the way the device REPL rethrows
                  // a tool's `error` text. Host exceptions stay fatal.
                  return Effect.fail(programError(nestedErrorMessage(error)));
                }
                return Effect.promise(async () => {
                  try {
                    await request.onToolError?.(error, context);
                  } catch {
                    // Diagnostics cannot change dispatch semantics.
                  }
                }).pipe(
                  Effect.andThen(failFatally({ code: "tool_failed", tool })),
                );
              },
            ).pipe(
              Effect.flatMap((result) => {
                const bounded = boundedProgramValue(result);
                return bounded.ok
                  ? Effect.succeed(bounded.value)
                  : failFatally({ code: "resource_limit", tool });
              }),
            );
          });

      const toolNames = request.tools.nameMappings.map((tool) => tool.rawName);
      const tools: Record<string, HostTool | HostTools> = Object.create(
        null,
      ) as Record<string, HostTool | HostTools>;
      definitions.forEach((definition, index) => {
        const mapping = request.tools.nameMappings[index]!;
        tools[definition.rawName] = toolCall(definition, mapping);
      });
      tools.$list = () =>
        Effect.succeed(
          [...toolNames].sort().map((name) => ({
            name,
            access: IDENTIFIER_RE.test(name)
              ? `tools.${name}`
              : `tools[${JSON.stringify(name)}]`,
            dotNotation: IDENTIFIER_RE.test(name),
          })),
        );
      tools.$search = (args = {}) =>
        intrinsicCall(CLOUD_CODE_SEARCH_INTRINSIC, args);
      tools.$describe = (name, options = {}) =>
        Effect.suspend(() => {
          if (typeof name !== "string" || !name.trim()) {
            return Effect.fail(
              programError(
                "tools.$describe requires an exact non-empty tool name string.",
              ),
            );
          }
          if (
            options === null ||
            typeof options !== "object" ||
            Array.isArray(options)
          ) {
            return Effect.fail(
              programError(
                "tools.$describe options must be an object when provided.",
              ),
            );
          }
          return intrinsicCall(CLOUD_CODE_DESCRIBE_INTRINSIC, {
            ...options,
            name,
          });
        });

      /** A global's method: argument checks fail the call, catchably. */
      const method =
        (call: (...args: unknown[]) => Effect.Effect<unknown, unknown>) =>
        (...args: unknown[]): Effect.Effect<unknown, unknown> =>
          Effect.suspend(() => call(...args));

      const connectCall = (name: string, args: unknown[]) =>
        intrinsicCall(CLOUD_CODE_CONNECT_INTRINSIC, { method: name, args });
      const connectString = requireNonEmptyString("connect");
      const connectObject = requirePlainObject("connect");
      tools[globalRootKey("connect")] = {
        documentation: () => Effect.succeed(CONNECT_DOCUMENTATION),
        discover: method((query) =>
          connectCall("discover", [connectString(query, "query")]),
        ),
        connectors: method(() => connectCall("connectors", [])),
        actions: method((id, options) =>
          connectCall("actions", [
            connectString(id, "id"),
            options === undefined ? {} : connectObject(options, "options"),
          ]),
        ),
        schema: method((id, action) =>
          connectCall("schema", [
            connectString(id, "id"),
            connectString(action, "action"),
          ]),
        ),
        call: method((id, action, args) =>
          connectCall("call", [
            connectString(id, "id"),
            connectString(action, "action"),
            args === undefined ? {} : connectObject(args, "args"),
          ]),
        ),
        addMcp: method((options) =>
          connectCall("addMcp", [connectObject(options, "options")]),
        ),
        remove: method((id) => connectCall("remove", [connectString(id, "id")])),
      };

      const historyCall = (name: string, args: unknown[]) =>
        intrinsicCall(CLOUD_CODE_HISTORY_INTRINSIC, { method: name, args });
      tools[globalRootKey("history")] = {
        sql: (query, params = []) => historyCall("sql", [query, params]),
        read: (fromSeq, toSeq) => historyCall("read", [fromSeq, toSeq]),
      };

      const globals = ["connect", "history"];
      if (request.intrinsics?.[CLOUD_CODE_BROWSER_INTRINSIC]) {
        const browser: Record<string, HostTool> = {};
        for (const name of BROWSER_METHODS) {
          browser[name] = (...args) =>
            intrinsicCall(CLOUD_CODE_BROWSER_INTRINSIC, {
              method: name,
              args: trimTrailingUndefined(args),
            });
        }
        tools[globalRootKey("browser")] = browser;
        globals.push("browser");
      }
      if (request.intrinsics?.[CLOUD_CODE_MEMORY_INTRINSIC]) {
        const memoryCall = (op: string, fields: Record<string, unknown>) =>
          intrinsicCall(CLOUD_CODE_MEMORY_INTRINSIC, { op, ...fields });
        tools[globalRootKey("memory")] = {
          read: (path) => memoryCall("read", { path }),
          write: (path, content, options) =>
            memoryCall("write", { path, content, options }),
          list: () => memoryCall("list", {}),
        };
        globals.push("memory");
      }

      const execution = CodeMode.execute({
        code: request.code,
        // The host tree's hidden global roots are ordinary namespaces to
        // the runtime; its generic tree type cannot express them.
        tools: tools as never,
        globals,
      }).pipe(Effect.map(mapProgramResult));

      return yield* Effect.raceFirst(
        execution,
        Effect.raceFirst(
          Deferred.await(fatal).pipe(
            Effect.map((failure) => fatalResult(failure, undefined)),
          ),
          Effect.raceFirst(
            Effect.promise(() => clock.expired).pipe(
              Effect.as<CloudCodeExecutionResult>({
                ok: false,
                code: "timeout",
                error: "Cloud code execution timed out.",
              }),
            ),
            Deferred.await(abortLatch).pipe(
              Effect.as<CloudCodeExecutionResult>({
                ok: false,
                code: "aborted",
                error: "Cloud code execution was canceled.",
              }),
            ),
          ),
        ),
      );
    }),
  );

  return runToolEffect(program);
};
