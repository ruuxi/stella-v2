import path from "node:path";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  COMPUTER_USE_PROTOCOL_VERSION,
  COMPUTER_USE_SCHEMA_VERSION,
  assertComputerUseRequest,
  assertJsonSafe,
  type ComputerUseActionCommand,
  type ComputerUseActionReceipt,
  type ComputerUseRequest,
  type ComputerUseResponse,
  type ComputerUseTarget,
  type JsonObject,
} from "./contract.js";
import type { ComputerUseSession } from "./session.js";
import type {
  ComputerCommandResult,
  ComputerCommandRunner,
} from "./command-runner.js";

const ATTACH_IMAGE_RE = /^\[stella-attach-image\].*$/gm;
const APP_INSTRUCTIONS_RE =
  /<app_specific_instructions>\s*([\s\S]*?)\s*<\/app_specific_instructions>\s*/g;
const VOLATILE_SEMANTIC_STATE_LINE_RE =
  /^\s*(?:State revision:|Screenshot context:)/;
const VOLATILE_DIFF_ATTRIBUTE_RE =
  /\s(?:previous_captured_at|current_captured_at)="[^"]*"/g;

export type CliDiagnosticsComputerUseSessionOptions = Readonly<{
  cliPath?: string;
  cwd: string;
  runner: ComputerCommandRunner;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  getSignal?: () => AbortSignal | undefined;
  commandTimeoutMs?: number;
  maxOutputBytes?: number;
}>;

const responseEnvelope = (request: ComputerUseRequest) => ({
  schemaVersion: COMPUTER_USE_SCHEMA_VERSION,
  protocolVersion: COMPUTER_USE_PROTOCOL_VERSION,
  requestId: request.requestId,
  sessionId: request.sessionId,
});

const errorResponse = (
  request: ComputerUseRequest,
  code: string,
  message: string,
  retryable = false,
  details?: JsonObject,
): Extract<ComputerUseResponse, { type: "error" }> => ({
  ...responseEnvelope(request),
  type: "error",
  error: { code, message, retryable, ...(details ? { details } : {}) },
});

const targetArgs = (target: ComputerUseTarget): string[] => {
  if (target.type === "app") return ["--app", target.app];
  return [
    ...(target.app ? ["--app", target.app] : []),
    "--window-id",
    target.windowId,
  ];
};

const encodeAction = (command: ComputerUseActionCommand): string[] => {
  const target = targetArgs(command.target);
  const action = command.action;
  const provenance = [
    "--observed-state-id",
    command.observedStateId,
    ...(command.observedVisualStateId
      ? ["--observed-visual-state-id", command.observedVisualStateId]
      : []),
  ];
  switch (action.type) {
    case "click_element":
      return [
        "click",
        action.elementId,
        ...target,
        "--mouse-button",
        action.mouseButton,
        "--click-count",
        String(action.clickCount),
        ...provenance,
      ];
    case "click_point":
      return [
        "click-screenshot",
        String(action.point.x),
        String(action.point.y),
        ...target,
        "--mouse-button",
        action.mouseButton,
        "--click-count",
        String(action.clickCount),
        ...provenance,
      ];
    case "drag":
      return [
        "drag-screenshot",
        String(action.from.x),
        String(action.from.y),
        String(action.to.x),
        String(action.to.y),
        ...target,
        "--allow-hid",
        ...provenance,
      ];
    case "perform_secondary_action":
      return [
        "secondary-action",
        action.elementId,
        action.action,
        ...target,
        ...provenance,
      ];
    case "press_key":
      return ["press", action.key, ...target, "--allow-hid", ...provenance];
    case "scroll":
      return [
        "scroll",
        action.elementId,
        action.direction,
        ...target,
        "--pages",
        String(action.pages),
        ...provenance,
      ];
    case "select_text":
      return [
        "select-text",
        action.elementId,
        action.text,
        ...target,
        ...(action.prefix === undefined ? [] : ["--prefix", action.prefix]),
        ...(action.suffix === undefined ? [] : ["--suffix", action.suffix]),
        ...(action.selectionType === undefined
          ? []
          : ["--selection", action.selectionType]),
        ...provenance,
      ];
    case "set_value":
      return ["fill", action.elementId, action.value, ...target, ...provenance];
    case "type_text":
      return ["type", action.text, ...target, "--allow-hid", ...provenance];
  }
};

const cliFailureMessage = (result: ComputerCommandResult) =>
  result.stderr.trim() || `stella-computer exited ${result.exitCode}.`;

const parseActionPayload = (
  result: ComputerCommandResult,
): { payload?: JsonObject; error?: string } => {
  let payload: unknown;
  try {
    payload = result.stdout.trim() ? JSON.parse(result.stdout) : null;
  } catch {
    return {
      error: `stella-computer returned invalid JSON: ${result.stdout.trim() || result.stderr.trim()}`,
    };
  }
  if (result.exitCode !== 0) {
    const message =
      payload && typeof payload === "object" && "error" in payload
        ? String(payload.error)
        : cliFailureMessage(result);
    return { error: message };
  }
  if (
    payload === null ||
    typeof payload !== "object" ||
    Array.isArray(payload)
  ) {
    return { error: "stella-computer returned an invalid action payload." };
  }
  try {
    assertJsonSafe(payload, "stella-computer action payload");
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
  return { payload: payload as JsonObject };
};

const receiptFor = (
  command: ComputerUseActionCommand,
  payload: JsonObject,
): ComputerUseActionReceipt => {
  const rawReceipt = payload.receipt;
  const receiptRecord =
    rawReceipt !== null &&
    typeof rawReceipt === "object" &&
    !Array.isArray(rawReceipt)
      ? (rawReceipt as Readonly<Record<string, unknown>>)
      : undefined;
  const receiptDeferred =
    receiptRecord && typeof receiptRecord.deferred === "boolean"
      ? receiptRecord.deferred
      : undefined;
  const deferred =
    receiptDeferred ??
    (typeof payload.deferred === "boolean" ? payload.deferred : true);
  return {
    type: "action",
    action: command.action.type,
    target: command.target,
    status: deferred ? "accepted" : "completed",
    deferred,
    details: payload,
  };
};

const targetLabel = (target: ComputerUseTarget) =>
  target.type === "app"
    ? target.app
    : (target.app ?? `window-id:${target.windowId}`);

const extractStateOutput = (stdout: string) => {
  let screenshotPath: string | null = null;
  let instructions: string | undefined;
  let text = stdout.replace(ATTACH_IMAGE_RE, (marker) => {
    const assignedPath = /\bpath=("(?:\\.|[^"\\])*")/.exec(marker)?.[1];
    let candidate = "";
    if (assignedPath) {
      try {
        candidate = String(JSON.parse(assignedPath));
      } catch {
        candidate = "";
      }
    } else {
      candidate =
        /\s((?:\/|[A-Za-z]:[\\/]).*\.(?:png|jpg|jpeg|gif|webp))$/i
          .exec(marker)?.[1]
          ?.trim() ?? "";
    }
    if (path.isAbsolute(candidate)) screenshotPath = candidate;
    return "";
  });
  text = text.replace(APP_INSTRUCTIONS_RE, (_full, body: string) => {
    if (instructions === undefined && body.trim()) instructions = body.trim();
    return "";
  });
  const renderedText = text.trim();
  const semanticText = renderedText
    .split("\n")
    .filter((line) => !VOLATILE_SEMANTIC_STATE_LINE_RE.test(line))
    .join("\n")
    .replace(VOLATILE_DIFF_ATTRIBUTE_RE, "");
  const semanticStateId = `state_${createHash("sha256")
    .update(semanticText)
    .digest("hex")
    .slice(0, 20)}`;
  let visualStateId: string | undefined;
  if (screenshotPath) {
    try {
      visualStateId = `visual_${createHash("sha256")
        .update(readFileSync(screenshotPath))
        .digest("hex")
        .slice(0, 20)}`;
    } catch {
      // A missing diagnostics screenshot has no visual identity.
    }
  }
  return {
    text: renderedText,
    stateId: semanticStateId,
    semanticStateId,
    ...(visualStateId ? { visualStateId } : {}),
    representation: renderedText.includes("<app_state_diff")
      ? ("diff" as const)
      : ("full" as const),
    ...(instructions ? { instructions } : {}),
    screenshot: screenshotPath
      ? ({ type: "image", url: pathToFileURL(screenshotPath).href } as const)
      : null,
  };
};

export const createCliDiagnosticsComputerUseSession = (
  options: CliDiagnosticsComputerUseSessionOptions,
): ComputerUseSession => {
  if (!options || typeof options !== "object") {
    throw new TypeError("CLI diagnostics session options are required.");
  }
  if (typeof options.runner !== "function") {
    throw new TypeError("CLI diagnostics session runner must be a function.");
  }
  if (typeof options.cwd !== "string" || options.cwd.trim() === "") {
    throw new TypeError("CLI diagnostics session cwd is required.");
  }
  const cliPath =
    options.cliPath ??
    fileURLToPath(new URL("../cli/stella-computer.js", import.meta.url));
  const env =
    options.env ??
    (process.versions.electron
      ? { ...process.env, ELECTRON_RUN_AS_NODE: "1" }
      : process.env);
  const observedStates = new Map<
    string,
    ReturnType<typeof extractStateOutput>
  >();

  const observedStateKey = (
    request: ComputerUseRequest,
    target: ComputerUseTarget,
  ) => `${request.sessionId}\0${JSON.stringify(target)}`;

  const request: ComputerUseSession["request"] = async (
    typedRequest,
    requestOptions,
  ) => {
    assertComputerUseRequest(typedRequest);
    const signal =
      requestOptions?.signal ?? options.getSignal?.() ?? options.signal;
    const run = async (
      args: string[],
      runOptions: Readonly<{
        sessionId?: string;
        timeoutMs?: number;
        ignoreSignal?: boolean;
      }> = {},
    ) =>
      await options.runner({
        command: process.execPath,
        args: [
          cliPath,
          "--session",
          runOptions.sessionId ?? typedRequest.sessionId,
          ...args,
        ],
        cwd: options.cwd,
        env,
        signal: runOptions.ignoreSignal ? undefined : signal,
        timeoutMs: runOptions.timeoutMs ?? options.commandTimeoutMs ?? 30_000,
        maxOutputBytes: options.maxOutputBytes,
      });

    const shutdownDiagnosticSession = async (sessionId: string) => {
      const result = await run(["shutdown-session", "--json"], {
        sessionId,
        timeoutMs: 5_000,
        ignoreSignal: true,
      });
      if (result.exitCode !== 0) {
        throw new Error(
          `Failed to shut down diagnostics computer session ${sessionId}: ${cliFailureMessage(result)}`,
        );
      }
    };

    const staleResponse = (observedStateId: string, currentStateId: string) =>
      errorResponse(
        typedRequest,
        "stale_observation",
        `Observed state ${observedStateId} is stale; current state is ${currentStateId}.`,
        true,
        { observedStateId, currentStateId },
      );

    const getStateArgs = (
      target: ComputerUseTarget,
      screenshotPolicy: "auto" | "always" | "never",
      disableDiff: boolean,
    ) => [
      "get-state",
      ...targetArgs(target),
      "--no-inline-screenshot",
      "--screenshot-policy",
      screenshotPolicy,
      ...(disableDiff ? ["--disable-diff"] : []),
    ];

    if (typedRequest.type === "list_apps") {
      const result = await run(["list-apps"]);
      return result.exitCode === 0
        ? {
            ...responseEnvelope(typedRequest),
            type: "list_apps",
            text: result.stdout.trim(),
          }
        : errorResponse(
            typedRequest,
            "cli_command_failed",
            cliFailureMessage(result),
          );
    }
    if (typedRequest.type === "list_windows") {
      const result = await run(["list-windows"]);
      return result.exitCode === 0
        ? {
            ...responseEnvelope(typedRequest),
            type: "list_windows",
            text: result.stdout.trim(),
          }
        : errorResponse(
            typedRequest,
            "cli_command_failed",
            cliFailureMessage(result),
          );
    }
    if (typedRequest.type === "resolve_target") {
      const label = targetLabel(typedRequest.selector);
      return {
        ...responseEnvelope(typedRequest),
        type: "target_policy",
        policy: {
          bundleIdentifier: label,
          displayName: label,
          decision: "allowed",
          allowPersistentApproval: false,
          risk: "CLI diagnostics cannot canonicalize an application selector.",
        },
      };
    }
    if (typedRequest.type === "get_app_state") {
      const result = await run(
        getStateArgs(
          typedRequest.target,
          typedRequest.screenshotPolicy,
          typedRequest.disableDiff,
        ),
      );
      if (result.exitCode !== 0) {
        return errorResponse(
          typedRequest,
          "cli_command_failed",
          cliFailureMessage(result),
        );
      }
      const state = extractStateOutput(result.stdout);
      observedStates.set(
        observedStateKey(typedRequest, typedRequest.target),
        state,
      );
      return {
        ...responseEnvelope(typedRequest),
        type: "app_state",
        state: {
          app: targetLabel(typedRequest.target),
          ...state,
        },
      };
    }

    if (typedRequest.type === "wait_for_change") {
      const baseline = observedStates.get(
        observedStateKey(typedRequest, typedRequest.target),
      );
      if (!baseline) {
        return errorResponse(
          typedRequest,
          "cli_missing_baseline",
          `No baseline state is available for ${targetLabel(typedRequest.target)}. Call get_app_state before wait_for_change.`,
        );
      }
      if (baseline.semanticStateId !== typedRequest.afterStateId) {
        return staleResponse(
          typedRequest.afterStateId,
          baseline.semanticStateId,
        );
      }
      if (
        typedRequest.afterVisualStateId &&
        baseline.visualStateId !== typedRequest.afterVisualStateId
      ) {
        return staleResponse(
          typedRequest.afterVisualStateId,
          baseline.visualStateId ?? "visual_state_missing",
        );
      }

      const startedAt = Date.now();
      let pollCount = 0;
      const pollSessionId = `diagnostics-wait-${createHash("sha256")
        .update(`${typedRequest.sessionId}\0${typedRequest.requestId}`)
        .digest("hex")
        .slice(0, 24)}`;
      const timeoutResponse = () => {
        const elapsedMs = Date.now() - startedAt;
        return errorResponse(
          typedRequest,
          "wait_timeout",
          `Computer state did not change within ${typedRequest.timeoutMs}ms (after_state_id=${typedRequest.afterStateId}, polls=${pollCount}, elapsed_ms=${elapsedMs}).`,
          true,
          {
            timeoutMs: typedRequest.timeoutMs,
            elapsedMs,
            pollCount,
            afterStateId: typedRequest.afterStateId,
            ...(typedRequest.afterVisualStateId
              ? { afterVisualStateId: typedRequest.afterVisualStateId }
              : {}),
          },
        );
      };
      const delay = (milliseconds: number) =>
        new Promise<void>((resolve, reject) => {
          if (signal?.aborted) {
            reject(signal.reason ?? new Error("Computer-use wait aborted."));
            return;
          }
          const timeout = setTimeout(() => {
            signal?.removeEventListener("abort", onAbort);
            resolve();
          }, milliseconds);
          const onAbort = () => {
            clearTimeout(timeout);
            reject(signal?.reason ?? new Error("Computer-use wait aborted."));
          };
          signal?.addEventListener("abort", onAbort, { once: true });
        });

      try {
        for (;;) {
          const remainingMs = typedRequest.timeoutMs - (Date.now() - startedAt);
          if (remainingMs <= 0) return timeoutResponse();
          pollCount += 1;
          let pollResult: ComputerCommandResult;
          try {
            pollResult = await run(
              getStateArgs(
                typedRequest.target,
                typedRequest.afterVisualStateId ? "always" : "never",
                true,
              ),
              {
                sessionId: pollSessionId,
                timeoutMs: Math.max(
                  1,
                  Math.min(options.commandTimeoutMs ?? 30_000, remainingMs),
                ),
              },
            );
          } catch (error) {
            if (Date.now() - startedAt >= typedRequest.timeoutMs) {
              return timeoutResponse();
            }
            return errorResponse(
              typedRequest,
              "cli_command_failed",
              error instanceof Error ? error.message : String(error),
            );
          }
          if (pollResult.exitCode !== 0) {
            return errorResponse(
              typedRequest,
              "cli_command_failed",
              cliFailureMessage(pollResult),
            );
          }
          const polled = extractStateOutput(pollResult.stdout);
          const semanticChanged =
            polled.semanticStateId !== typedRequest.afterStateId;
          const visualChanged = Boolean(
            typedRequest.afterVisualStateId &&
            polled.visualStateId &&
            polled.visualStateId !== typedRequest.afterVisualStateId,
          );
          if (semanticChanged || visualChanged) {
            const finalResult = await run(
              getStateArgs(
                typedRequest.target,
                typedRequest.afterVisualStateId &&
                  typedRequest.screenshotPolicy === "auto"
                  ? "always"
                  : typedRequest.screenshotPolicy,
                typedRequest.disableDiff,
              ),
            );
            if (finalResult.exitCode !== 0) {
              return errorResponse(
                typedRequest,
                "cli_command_failed",
                cliFailureMessage(finalResult),
              );
            }
            const finalState = extractStateOutput(finalResult.stdout);
            const finalSemanticStateId =
              finalState.representation === "diff"
                ? polled.semanticStateId
                : finalState.semanticStateId;
            const changeKinds: ("semantic" | "visual")[] = [
              ...(finalSemanticStateId !== typedRequest.afterStateId
                ? (["semantic"] as const)
                : []),
              ...(typedRequest.afterVisualStateId &&
              finalState.visualStateId &&
              finalState.visualStateId !== typedRequest.afterVisualStateId
                ? (["visual"] as const)
                : []),
            ];
            if (changeKinds.length > 0) {
              const committedState = {
                ...finalState,
                stateId: finalSemanticStateId,
                semanticStateId: finalSemanticStateId,
              };
              observedStates.set(
                observedStateKey(typedRequest, typedRequest.target),
                committedState,
              );
              return {
                ...responseEnvelope(typedRequest),
                type: "wait_for_change",
                state: {
                  app: targetLabel(typedRequest.target),
                  ...committedState,
                  ...(committedState.representation === "diff"
                    ? {
                        baseStateId: typedRequest.afterStateId,
                        ...(typedRequest.afterVisualStateId
                          ? {
                              baseVisualStateId:
                                typedRequest.afterVisualStateId,
                            }
                          : {}),
                      }
                    : {}),
                  wait: {
                    afterStateId: typedRequest.afterStateId,
                    ...(typedRequest.afterVisualStateId
                      ? { afterVisualStateId: typedRequest.afterVisualStateId }
                      : {}),
                    timeoutMs: typedRequest.timeoutMs,
                    elapsedMs: Date.now() - startedAt,
                    pollCount,
                    changeKinds,
                  },
                },
              };
            }
          }
          const remainingAfterPoll =
            typedRequest.timeoutMs - (Date.now() - startedAt);
          if (remainingAfterPoll <= 0) return timeoutResponse();
          await delay(Math.min(150, remainingAfterPoll));
        }
      } finally {
        await shutdownDiagnosticSession(pollSessionId);
      }
    }

    const validateActionObservation = async (
      command: ComputerUseActionCommand,
      index: number,
    ) => {
      const baseline = observedStates.get(
        observedStateKey(typedRequest, command.target),
      );
      if (!baseline) {
        return errorResponse(
          typedRequest,
          "cli_missing_baseline",
          `No baseline state is available for ${targetLabel(command.target)}. Call get_app_state before acting.`,
        );
      }
      if (baseline.semanticStateId !== command.observedStateId) {
        return staleResponse(command.observedStateId, baseline.semanticStateId);
      }
      if (
        command.observedVisualStateId &&
        baseline.visualStateId !== command.observedVisualStateId
      ) {
        return staleResponse(
          command.observedVisualStateId,
          baseline.visualStateId ?? "visual_state_missing",
        );
      }

      const validationSessionId = `diagnostics-action-${createHash("sha256")
        .update(
          `${typedRequest.sessionId}\0${typedRequest.requestId}\0${index}`,
        )
        .digest("hex")
        .slice(0, 24)}`;
      try {
        const result = await run(
          getStateArgs(
            command.target,
            command.observedVisualStateId ? "always" : "never",
            true,
          ),
          { sessionId: validationSessionId },
        );
        if (result.exitCode !== 0) {
          return errorResponse(
            typedRequest,
            "cli_command_failed",
            cliFailureMessage(result),
          );
        }
        const current = extractStateOutput(result.stdout);
        if (current.semanticStateId !== command.observedStateId) {
          return staleResponse(
            command.observedStateId,
            current.semanticStateId,
          );
        }
        if (
          command.observedVisualStateId &&
          current.visualStateId !== command.observedVisualStateId
        ) {
          return staleResponse(
            command.observedVisualStateId,
            current.visualStateId ?? "visual_state_missing",
          );
        }
      } finally {
        await shutdownDiagnosticSession(validationSessionId);
      }
    };

    const executeAction = async (
      command: ComputerUseActionCommand,
    ): Promise<
      ComputerUseActionReceipt | Extract<ComputerUseResponse, { type: "error" }>
    > => {
      const result = await run([
        ...encodeAction(command),
        "--defer-observation",
        "--json",
      ]);
      const parsed = parseActionPayload(result);
      return parsed.error || !parsed.payload
        ? errorResponse(
            typedRequest,
            result.exitCode === 0
              ? "cli_invalid_response"
              : "cli_command_failed",
            parsed.error ?? cliFailureMessage(result),
          )
        : receiptFor(command, parsed.payload);
    };

    if (typedRequest.type === "action") {
      const validation = await validateActionObservation(
        typedRequest.command,
        0,
      );
      if (validation) return validation;
      const receipt = await executeAction(typedRequest.command);
      return receipt.type === "error"
        ? receipt
        : {
            ...responseEnvelope(typedRequest),
            type: "action",
            receipt,
          };
    }

    for (let index = 0; index < typedRequest.commands.length; index += 1) {
      const validation = await validateActionObservation(
        typedRequest.commands[index]!,
        index,
      );
      if (validation) return validation;
    }
    const receipts: ComputerUseActionReceipt[] = [];
    for (const command of typedRequest.commands) {
      const receipt = await executeAction(command);
      if (receipt.type === "error") return receipt;
      receipts.push(receipt);
    }
    return {
      ...responseEnvelope(typedRequest),
      type: "batch",
      receipt: { type: "batch", receipts },
    };
  };

  return Object.freeze({ request });
};
