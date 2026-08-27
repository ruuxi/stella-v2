/**
 * A deliberately narrow adapter around Cloudflare Code Mode.
 *
 * Generated code gets exactly one RPC-backed `codemode` namespace. The child
 * Worker gets no env bindings or additional modules, and `globalOutbound` is
 * always `null`; callers cannot widen either surface through this API.
 *
 * The official `@cloudflare/codemode` child currently pins Cloudflare's
 * `nodejs_compat` compatibility flag internally. That is an implementation
 * detail of the official child Worker, not a custom Node/QuickJS evaluator in
 * this Durable Object: model-generated code receives no modules, bindings, or
 * secrets from Stella, and cannot make ambient outbound requests.
 *
 * Stella owns the WorkerLoader adapter rather than hiding it behind the
 * package executor. The Effect scope therefore owns both native handles and
 * does not report cancellation until their disposal has produced an outcome.
 */

import {
  generateTypesFromJsonSchema,
  sanitizeToolName,
  type ExecuteResult,
  type JsonSchemaToolDescriptor,
  type JsonSchemaToolDescriptors,
  type ResolvedProvider,
} from "@cloudflare/codemode";
import { Deferred, Effect } from "effect";
import { acquireAbortLatch } from "@stella/runtime/kernel/agent-core/abort-bridge.js";
import { runToolEffect } from "@stella/runtime/kernel/tools/effect-runtime.js";
import {
  cloneBoundedJsonValue,
  truncateUtf8,
  utf8ByteLengthUpTo,
  type BoundedJsonLimits,
} from "./cloud-code-bounds.js";
import {
  CLOUD_CODE_WORKER_MAX_STRING_BYTES,
  CLOUD_CODE_WORKER_MAX_VALUE_DEPTH,
  CLOUD_CODE_WORKER_MAX_VALUE_ENTRIES,
  CLOUD_CODE_WORKER_MAX_VALUE_NODES,
  CLOUD_CODE_WORKER_VALUE_MAX_BYTES,
  StellaDynamicWorkerExecutor,
  isCloudCodeResourceLimitError,
  type StellaDisposableExecutor,
  type StellaWorkerCleanupStatus,
} from "./cloud-code-worker-executor.js";

export const CLOUD_CODE_DEFAULT_TIMEOUT_MS = 20_000;
export const CLOUD_CODE_MAX_TIMEOUT_MS = 60_000;
export const CLOUD_CODE_MAX_SOURCE_BYTES = 128 * 1024;
export const CLOUD_CODE_MAX_TOOL_CALLS = 64;
export const CLOUD_CODE_MAX_CONCURRENT_TOOL_CALLS = 8;
export const CLOUD_CODE_MAX_CATALOG_TOOLS = 64;
export const CLOUD_CODE_MAX_TOOL_DESCRIPTION_BYTES = 4 * 1024;
export const CLOUD_CODE_MAX_SCHEMA_BYTES = 24 * 1024;
export const CLOUD_CODE_MAX_CATALOG_BYTES = 128 * 1024;
export const CLOUD_CODE_MAX_TYPE_DECLARATION_BYTES = 96 * 1024;

const PROVIDER_NAME = "codemode";
const MAX_TOOL_NAME_LENGTH = 160;
const MAX_LOG_LINES = 100;
const MAX_LOG_LINE_LENGTH = 4_000;
const MAX_LOG_TOTAL_BYTES = 100_000;
const CLEANUP_OUTCOME_TIMEOUT_MS = 2_000;
const DISPATCH_FAILURE_PREFIX = "__STELLA_CLOUD_CODE_DISPATCH__";
const UNSAFE_SANITIZED_NAMES = new Set([
  "__proto__",
  "constructor",
  "prototype",
]);

export type CloudCodeJsonSchema = JsonSchemaToolDescriptor["inputSchema"];
export type CloudCodeToolApproval = "not_required" | "required";

export type CloudCodeToolCallContext = Readonly<{
  executionId: string;
  toolCallId: string;
  rawName: string;
  sanitizedName: string;
  signal: AbortSignal;
  /** Present only after an explicit approval gate approved this exact call. */
  approvalId?: string;
}>;

export type CloudCodeToolDefinition = Readonly<{
  /**
   * The canonical host-side name. Code Mode exposes its exact sanitized form
   * in generated JavaScript and dispatches back to this raw name.
   */
  rawName: string;
  description: string;
  inputSchema: CloudCodeJsonSchema;
  outputSchema?: CloudCodeJsonSchema;
  /** Required explicitly so a newly-added side-effecting tool cannot default open. */
  approval: CloudCodeToolApproval;
  execute: (
    input: unknown,
    context: CloudCodeToolCallContext,
  ) => Promise<unknown> | unknown;
}>;

export type CloudCodeToolNameMapping = Readonly<{
  rawName: string;
  sanitizedName: string;
  approval: CloudCodeToolApproval;
}>;

export type PreparedCloudCodeTools = Readonly<{
  /** TypeScript declarations to place in the model-facing code-tool prompt. */
  typeDeclarations: string;
  /** Exact, collision-checked mapping used by the RPC dispatcher. */
  nameMappings: readonly CloudCodeToolNameMapping[];
}>;

export type CloudCodeApprovalDecision =
  | Readonly<{ status: "approved"; approvalId: string }>
  | Readonly<{ status: "denied" }>;

export type CloudCodeApprovalRequest = Readonly<{
  executionId: string;
  toolCallId: string;
  rawName: string;
  sanitizedName: string;
  input: unknown;
  signal: AbortSignal;
}>;

export type CloudCodeApprovalGate = (
  request: CloudCodeApprovalRequest,
) => Promise<CloudCodeApprovalDecision> | CloudCodeApprovalDecision;

export type CloudCodeFailureCode =
  | "invalid_request"
  | "aborted"
  | "timeout"
  | "approval_required"
  | "approval_denied"
  | "resource_limit"
  | "tool_failed"
  | "sandbox_error"
  | "executor_error";

export type CloudCodeCleanupStatus =
  | StellaWorkerCleanupStatus
  | "dispose_requested";

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
      /**
       * Present when the wrapper returned before the package execution settled.
       * Late settlement is ignored in both cases.
       */
      cleanup?: CloudCodeCleanupStatus;
    }>;

export type CloudCodeExecutionRequest = Readonly<{
  loader: WorkerLoader;
  code: string;
  tools: PreparedCloudCodeTools;
  executionId?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  approvalGate?: CloudCodeApprovalGate;
  /** Host-only diagnostics. The original error is never sent to generated code. */
  onToolError?: (
    error: unknown,
    context: CloudCodeToolCallContext,
  ) => Promise<void> | void;
}>;

type LockedDynamicWorkerOptions = Readonly<{
  loader: WorkerLoader;
  timeout: number;
  globalOutbound: null;
}>;

export type CloudCodeExecutorFactory = (
  options: LockedDynamicWorkerOptions,
) => StellaDisposableExecutor;

type DispatchFailureCode = Extract<
  CloudCodeFailureCode,
  "approval_required" | "approval_denied" | "resource_limit" | "tool_failed"
>;

type DispatchFailure = Readonly<{
  code: DispatchFailureCode;
  tool: CloudCodeToolNameMapping;
}>;

const definitionsByPreparedTools = new WeakMap<
  PreparedCloudCodeTools,
  readonly CloudCodeToolDefinition[]
>();

const CATALOG_SCHEMA_LIMITS: BoundedJsonLimits = Object.freeze({
  maxBytes: CLOUD_CODE_MAX_SCHEMA_BYTES,
  maxDepth: 16,
  maxNodes: 2_048,
  maxEntries: 2_048,
  maxStringBytes: 8 * 1024,
});

const NESTED_VALUE_LIMITS: BoundedJsonLimits = Object.freeze({
  maxBytes: CLOUD_CODE_WORKER_VALUE_MAX_BYTES,
  maxDepth: CLOUD_CODE_WORKER_MAX_VALUE_DEPTH,
  maxNodes: CLOUD_CODE_WORKER_MAX_VALUE_NODES,
  maxEntries: CLOUD_CODE_WORKER_MAX_VALUE_ENTRIES,
  maxStringBytes: CLOUD_CODE_WORKER_MAX_STRING_BYTES,
});

export class CloudCodeConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CloudCodeConfigurationError";
  }
}

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
};

/**
 * Validate and freeze the catalog once, before exposing its declarations to a
 * model. Both the declarations and runtime dispatch use Cloudflare's own
 * `sanitizeToolName`, and ambiguous sanitized names are rejected.
 */
export const prepareCloudCodeTools = (
  tools: readonly CloudCodeToolDefinition[],
): PreparedCloudCodeTools => {
  if (tools.length > CLOUD_CODE_MAX_CATALOG_TOOLS) {
    throw new CloudCodeConfigurationError(
      `Cloud code catalog exceeds ${CLOUD_CODE_MAX_CATALOG_TOOLS} tools.`,
    );
  }
  const rawNames = new Set<string>();
  const sanitizedToRaw = new Map<string, string>();
  const definitions: CloudCodeToolDefinition[] = [];
  const nameMappings: CloudCodeToolNameMapping[] = [];
  const descriptors = Object.create(null) as JsonSchemaToolDescriptors;
  let catalogBytes = 0;

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

    const inputSchema = cloneBoundedJsonValue(
      candidate.inputSchema,
      CATALOG_SCHEMA_LIMITS,
    );
    if (!inputSchema.ok) {
      throw new CloudCodeConfigurationError(
        `Cloud code tool "${candidate.rawName}" input schema exceeds its catalog budget.`,
      );
    }
    const outputSchema = candidate.outputSchema
      ? cloneBoundedJsonValue(candidate.outputSchema, CATALOG_SCHEMA_LIMITS)
      : undefined;
    if (outputSchema && !outputSchema.ok) {
      throw new CloudCodeConfigurationError(
        `Cloud code tool "${candidate.rawName}" output schema exceeds its catalog budget.`,
      );
    }

    const sanitizedName = sanitizeToolName(candidate.rawName);
    if (
      !/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(sanitizedName) ||
      UNSAFE_SANITIZED_NAMES.has(sanitizedName)
    ) {
      throw new CloudCodeConfigurationError(
        `Cloud code tool "${candidate.rawName}" sanitizes to unsafe identifier "${sanitizedName}".`,
      );
    }
    const collidingRawName = sanitizedToRaw.get(sanitizedName);
    if (collidingRawName && collidingRawName !== candidate.rawName) {
      throw new CloudCodeConfigurationError(
        `Cloud code tools "${collidingRawName}" and "${candidate.rawName}" both sanitize to "${sanitizedName}".`,
      );
    }

    rawNames.add(candidate.rawName);
    sanitizedToRaw.set(sanitizedName, candidate.rawName);
    const definition = Object.freeze({ ...candidate });
    const mapping = Object.freeze({
      rawName: candidate.rawName,
      sanitizedName,
      approval: candidate.approval,
    });
    definitions.push(definition);
    nameMappings.push(mapping);
    const description =
      candidate.approval === "required"
        ? `${candidate.description} Requires explicit user approval.`
        : candidate.description;
    catalogBytes +=
      utf8ByteLengthUpTo(candidate.rawName) +
      utf8ByteLengthUpTo(sanitizedName) +
      utf8ByteLengthUpTo(description) +
      inputSchema.bytes +
      (outputSchema?.ok ? outputSchema.bytes : 0);
    if (catalogBytes > CLOUD_CODE_MAX_CATALOG_BYTES) {
      throw new CloudCodeConfigurationError(
        `Cloud code catalog exceeds ${CLOUD_CODE_MAX_CATALOG_BYTES} bytes.`,
      );
    }
    descriptors[candidate.rawName] = {
      description,
      inputSchema: inputSchema.value as CloudCodeJsonSchema,
      ...(outputSchema?.ok
        ? { outputSchema: outputSchema.value as CloudCodeJsonSchema }
        : {}),
    };
  }

  let typeDeclarations: string;
  try {
    typeDeclarations = generateTypesFromJsonSchema(descriptors);
  } catch {
    throw new CloudCodeConfigurationError(
      "Cloud code catalog could not be converted into bounded type declarations.",
    );
  }
  if (
    utf8ByteLengthUpTo(
      typeDeclarations,
      CLOUD_CODE_MAX_TYPE_DECLARATION_BYTES,
    ) > CLOUD_CODE_MAX_TYPE_DECLARATION_BYTES
  ) {
    throw new CloudCodeConfigurationError(
      `Cloud code type declarations exceed ${CLOUD_CODE_MAX_TYPE_DECLARATION_BYTES} bytes.`,
    );
  }
  const prepared = Object.freeze({
    typeDeclarations,
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
  logs: string[] | undefined,
): readonly string[] | undefined => {
  if (!logs) return undefined;
  const bounded: string[] = [];
  let totalBytes = 0;
  for (const line of logs) {
    if (bounded.length >= MAX_LOG_LINES || totalBytes >= MAX_LOG_TOTAL_BYTES) {
      break;
    }
    if (typeof line !== "string") continue;
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

const dispatchMarker = (failure: DispatchFailure): string =>
  `${DISPATCH_FAILURE_PREFIX}:${failure.code}:${failure.tool.sanitizedName}`;

const requestDisposal = async (
  resource: unknown,
): Promise<CloudCodeCleanupStatus> => {
  if (
    (typeof resource !== "object" && typeof resource !== "function") ||
    resource === null
  ) {
    return "executor_dispose_unavailable";
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
    const dispose = record[key];
    if (typeof dispose !== "function") continue;
    try {
      const result = (dispose as () => unknown).call(resource);
      const settled = await result;
      if (
        settled === "disposed" ||
        settled === "dispose_failed" ||
        settled === "executor_dispose_unavailable"
      ) {
        return settled;
      }
      return "disposed";
    } catch {
      return "dispose_failed";
    }
  }
  return "executor_dispose_unavailable";
};

const dispatchFailureResult = (
  failure: DispatchFailure,
  logs?: string[],
): CloudCodeExecutionResult => {
  const action =
    failure.code === "approval_required"
      ? "requires explicit approval"
      : failure.code === "approval_denied"
        ? "was not approved"
        : failure.code === "resource_limit"
          ? "exceeded the nested-call resource limit"
          : "failed";
  const bounded = boundedLogs(logs);
  return {
    ok: false,
    code: failure.code,
    error: `Cloud code tool "${failure.tool.rawName}" ${action}.`,
    tool: failure.tool,
    ...(bounded ? { logs: bounded } : {}),
  };
};

const mapExecutorResult = (
  result: ExecuteResult,
  dispatchFailure: DispatchFailure | undefined,
): CloudCodeExecutionResult => {
  const logs = boundedLogs(result.logs);
  if (dispatchFailure) {
    return dispatchFailureResult(dispatchFailure, result.logs);
  }
  if (result.error) {
    if (result.error === "Execution timed out") {
      return {
        ok: false,
        code: "timeout",
        error: "Cloud code execution timed out.",
        ...(logs ? { logs } : {}),
      };
    }
    if (isCloudCodeResourceLimitError(result.error)) {
      return {
        ok: false,
        code: "resource_limit",
        error: "Cloud code execution exceeded its value resource limit.",
        ...(logs ? { logs } : {}),
      };
    }
    return {
      ok: false,
      code: "sandbox_error",
      error: truncateUtf8(result.error, 4_000, "[error truncated]"),
      ...(logs ? { logs } : {}),
    };
  }
  if (result.result === undefined) {
    return {
      ok: true,
      result: undefined,
      ...(logs ? { logs } : {}),
    };
  }
  const boundedResult = cloneBoundedJsonValue(result.result, NESTED_VALUE_LIMITS);
  if (!boundedResult.ok) {
    return {
      ok: false,
      code: "resource_limit",
      error: "Cloud code execution exceeded its value resource limit.",
      ...(logs ? { logs } : {}),
    };
  }
  return {
    ok: true,
    result: boundedResult.value,
    ...(logs ? { logs } : {}),
  };
};

const createProvider = (
  definitions: readonly CloudCodeToolDefinition[],
  mappings: readonly CloudCodeToolNameMapping[],
  executionId: string,
  signalController: AbortController,
  approvalGate: CloudCodeApprovalGate | undefined,
  onToolError: CloudCodeExecutionRequest["onToolError"],
  setDispatchFailure: (failure: DispatchFailure) => void,
): ResolvedProvider => {
  const fns: Record<string, (...args: unknown[]) => Promise<unknown>> =
    Object.create(null) as Record<
      string,
      (...args: unknown[]) => Promise<unknown>
    >;
  let sequence = 0;
  let activeCalls = 0;

  definitions.forEach((tool, index) => {
    const mapping = mappings[index];
    if (!mapping || mapping.rawName !== tool.rawName) {
      throw new CloudCodeConfigurationError(
        "Prepared cloud code tool mappings are inconsistent.",
      );
    }

    fns[tool.rawName] = async (...args: unknown[]): Promise<unknown> => {
      const toolCallId = `${executionId}:${sequence + 1}:${mapping.sanitizedName}`;
      let countedActiveCall = false;
      const contextBase = {
        executionId,
        toolCallId,
        rawName: mapping.rawName,
        sanitizedName: mapping.sanitizedName,
        signal: signalController.signal,
      } as const;

      const fail = (code: DispatchFailureCode): never => {
        const failure = { code, tool: mapping } as const;
        setDispatchFailure(failure);
        if (!signalController.signal.aborted) signalController.abort();
        throw new Error(dispatchMarker(failure));
      };

      try {
        if (sequence >= CLOUD_CODE_MAX_TOOL_CALLS) {
          return fail("resource_limit");
        }
        sequence += 1;
        if (activeCalls >= CLOUD_CODE_MAX_CONCURRENT_TOOL_CALLS) {
          return fail("resource_limit");
        }
        activeCalls += 1;
        countedActiveCall = true;
        if (args.length !== 1) return fail("tool_failed");
        if (signalController.signal.aborted) {
          throw new Error("Cloud code execution was canceled.");
        }
        const boundedInput = cloneBoundedJsonValue(
          args[0],
          NESTED_VALUE_LIMITS,
        );
        if (!boundedInput.ok) return fail("resource_limit");
        const input = boundedInput.value;
        let approvalId: string | undefined;

        if (tool.approval === "required") {
          if (!approvalGate) return fail("approval_required");
          let decision: CloudCodeApprovalDecision;
          try {
            decision = await approvalGate({ ...contextBase, input });
          } catch {
            return fail("approval_denied");
          }
          if (signalController.signal.aborted) {
            throw new Error("Cloud code execution was canceled.");
          }
          if (
            decision.status !== "approved" ||
            typeof decision.approvalId !== "string" ||
            !decision.approvalId.trim()
          ) {
            return fail("approval_denied");
          }
          approvalId = decision.approvalId;
        }

        const context = Object.freeze({
          ...contextBase,
          ...(approvalId ? { approvalId } : {}),
        });
        try {
          const result = await tool.execute(input, context);
          if (signalController.signal.aborted) {
            throw new Error("Cloud code execution was canceled.");
          }
          if (result === undefined) return undefined;
          const boundedResult = cloneBoundedJsonValue(
            result,
            NESTED_VALUE_LIMITS,
          );
          if (!boundedResult.ok) return fail("resource_limit");
          return boundedResult.value;
        } catch (error) {
          if (signalController.signal.aborted) {
            throw new Error("Cloud code execution was canceled.");
          }
          try {
            await onToolError?.(error, context);
          } catch {
            // Diagnostics cannot change dispatch semantics.
          }
          return fail("tool_failed");
        }
      } finally {
        if (countedActiveCall) activeCalls -= 1;
      }
    };
  });

  return { name: PROVIDER_NAME, fns };
};

const createProductionExecutor: CloudCodeExecutorFactory = (options) =>
  new StellaDynamicWorkerExecutor({
    loader: options.loader,
    timeout: options.timeout,
  });

/**
 * Production entry point. Each call creates a fresh Stella-owned Dynamic
 * Worker and fixes `globalOutbound` to `null`; there is no override for
 * modules or bindings.
 */
export const executeCloudCode = (
  request: CloudCodeExecutionRequest,
): Promise<CloudCodeExecutionResult> =>
  executeCloudCodeWithExecutorFactory(request, createProductionExecutor);

/**
 * Testable seam for the package executor. Production code should call
 * `executeCloudCode`; this function exists so policy, cancellation, and
 * cleanup can be verified without starting workerd.
 */
export const executeCloudCodeWithExecutorFactory = async (
  request: CloudCodeExecutionRequest,
  executorFactory: CloudCodeExecutorFactory,
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
  if (request.signal?.aborted) {
    return {
      ok: false,
      code: "aborted",
      error: "Cloud code execution was canceled.",
    };
  }

  const signalController = new AbortController();
  let dispatchFailure: DispatchFailure | undefined;
  const provider = createProvider(
    definitions,
    request.tools.nameMappings,
    executionId,
    signalController,
    request.approvalGate,
    request.onToolError,
    (failure) => {
      dispatchFailure ??= failure;
    },
  );

  const boundedExecution = Effect.scoped(
    Effect.gen(function* () {
      const resource = yield* Effect.acquireRelease(
        Effect.sync(() => {
          try {
            // The fixed literal is intentional. Do not spread caller options:
            // an omitted globalOutbound inherits the parent's full network.
            const executor = executorFactory({
              loader: request.loader,
              timeout,
              globalOutbound: null,
            });
            let disposal: Promise<CloudCodeCleanupStatus> | undefined;
            return {
              ok: true as const,
              executor,
              disposeOnce: () =>
                (disposal ??= requestDisposal(executor).catch(
                  (): CloudCodeCleanupStatus => "dispose_failed",
                )),
            };
          } catch {
            return { ok: false as const };
          }
        }),
        (acquired) => {
          if (!acquired.ok) return Effect.void;
          if (!signalController.signal.aborted) signalController.abort();
          return Effect.raceFirst(
            Effect.promise(acquired.disposeOnce),
            Effect.sleep(CLEANUP_OUTCOME_TIMEOUT_MS).pipe(
              Effect.as<CloudCodeCleanupStatus>("dispose_failed"),
            ),
          ).pipe(Effect.asVoid);
        },
      );
      if (!resource.ok) {
        return {
          ok: false,
          code: "executor_error",
          error: "Cloud code executor could not be created.",
        } as const;
      }

      const awaitCleanup = (): Effect.Effect<CloudCodeCleanupStatus> =>
        Effect.raceFirst(
          Effect.promise(resource.disposeOnce),
          Effect.sleep(CLEANUP_OUTCOME_TIMEOUT_MS).pipe(
            Effect.as<CloudCodeCleanupStatus>("dispose_failed"),
          ),
        );

      const interrupt = (
        code: "aborted" | "timeout",
        error: string,
      ): Effect.Effect<CloudCodeExecutionResult> =>
        Effect.sync(() => {
          if (!signalController.signal.aborted) signalController.abort();
        }).pipe(
          Effect.flatMap(awaitCleanup),
          Effect.map((cleanup): CloudCodeExecutionResult => {
            if (
              cleanup === "dispose_failed" ||
              cleanup === "executor_dispose_unavailable"
            ) {
              return {
                ok: false,
                code: "executor_error",
                error:
                  "Cloud code cancellation could not confirm sandbox termination.",
                cleanup,
              };
            }
            return { ok: false, code, error, cleanup };
          }),
        );

      const execution = Effect.tryPromise({
        try: () => resource.executor.execute(request.code, [provider]),
        catch: () => undefined,
      }).pipe(
        Effect.map((result): CloudCodeExecutionResult =>
          result
            ? mapExecutorResult(result, dispatchFailure)
            : {
                ok: false,
                code: "executor_error",
                error: "Cloud code executor failed.",
              },
        ),
      );

      const abortLatch = yield* acquireAbortLatch(request.signal);
      return yield* Effect.raceFirst(
        execution,
        Effect.raceFirst(
          Effect.sleep(timeout).pipe(
            Effect.flatMap(() =>
              interrupt("timeout", "Cloud code execution timed out."),
            ),
          ),
          Deferred.await(abortLatch).pipe(
            Effect.flatMap(() =>
              interrupt("aborted", "Cloud code execution was canceled."),
            ),
          ),
        ),
      );
    }),
  );

  return runToolEffect(boundedExecution);
};
