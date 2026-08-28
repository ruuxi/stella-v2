import type {
  ExecOptions,
  ExecResult,
  ExecutionSession,
  Process,
  ProcessOptions,
} from "@cloudflare/sandbox";

export const CLOUD_MODEL_UID = 42_424;
export const CLOUD_MODEL_GID = 42_424;
export const APP_BUILD_SESSION_ENV = Object.freeze({
  STELLA_CLOUD_WORKSPACE_ROOT: "/workspace/app",
  USER: "stella-tools",
  LOGNAME: "stella-tools",
  HOME: "/workspace/.stella-tool-home",
  XDG_CONFIG_HOME: "/workspace/.stella-tool-home/.config",
  XDG_CACHE_HOME: "/workspace/.stella-tool-home/.cache",
  XDG_STATE_HOME: "/workspace/.stella-tool-home/.local/state",
});

const quoteShellArg = (value: string): string => {
  if (value.includes("\0")) {
    throw new Error("Strict session argv contains a NUL byte.");
  }
  return `'${value.replace(/'/g, `'"'"'`)}'`;
};

const strictSessionCommandForMode = (
  argv: readonly string[],
  replaceSessionShell: boolean,
): string => {
  if (argv.length === 0 || !argv[0]) {
    throw new Error("Strict session execution requires a command.");
  }
  return [
    ...(replaceSessionShell ? ["exec"] : []),
    "/usr/bin/setpriv",
    `--reuid=${CLOUD_MODEL_UID}`,
    `--regid=${CLOUD_MODEL_GID}`,
    "--clear-groups",
    "--no-new-privs",
    "--bounding-set=-all",
    "--inh-caps=-all",
    "--ambient-caps=-all",
    "--",
    ...argv.map(quoteShellArg),
  ].join(" ");
};

/**
 * Exact command for a tracked process inside an ExecutionSession.
 *
 * The session owns a persistent shell. Replacing that shell with `exec` makes
 * Cloudflare's process registry track a session lifetime instead of the
 * bounded command and can leave `waitForExit()` pending after admission. The
 * fixed root shell is only a non-interactive wrapper; the model-controlled
 * child still crosses the complete setpriv boundary below, and process-tree
 * cancellation joins both wrapper and child.
 */
export const strictSessionCommand = (argv: readonly string[]): string =>
  strictSessionCommandForMode(argv, false);

type StrictExecSession = Pick<ExecutionSession, "exec">;
type StrictProcessSession = Pick<ExecutionSession, "startProcess">;
type CapturedSession = Pick<ExecutionSession, "startProcess"> &
  Partial<Pick<ExecutionSession, "getProcess">>;

export type CapturedSessionAbandonDisposition =
  | "session_quiesced"
  | "sandbox_destroyed";

export class CapturedSessionAbandonedError extends Error {
  readonly disposition: CapturedSessionAbandonDisposition;
  readonly phase: "start_uncertain" | "process_unsettled";

  constructor(args: {
    cause: unknown;
    disposition: CapturedSessionAbandonDisposition;
    phase: "start_uncertain" | "process_unsettled";
  }) {
    super(
      args.phase === "start_uncertain"
        ? "Captured session process start could not be confirmed."
        : "Captured session process did not reach a terminal state.",
      { cause: args.cause },
    );
    this.name = "CapturedSessionAbandonedError";
    this.disposition = args.disposition;
    this.phase = args.phase;
  }
}

export type CapturedSessionExecOptions = Readonly<{
  onStarted?: () => void | Promise<void>;
  onAbandon?: (input: {
    phase: "start_uncertain" | "process_unsettled";
    processId: string;
  }) =>
    | CapturedSessionAbandonDisposition
    | Promise<CapturedSessionAbandonDisposition>;
  processId?: string;
  signal?: AbortSignal;
  abandonTimeoutMs?: number;
  startTimeoutMs?: number;
  startedTimeoutMs?: number;
  resultTimeoutMs?: number;
  /**
   * Sessionless execution context for the trusted Stella executor. Supplying
   * these directly avoids Cloudflare's persistent ExecutionSession shell;
   * that shell is useful for interactive state, but it is not an
   * authoritative lifetime boundary for a one-shot process.
   */
  cwd?: string;
  env?: Record<string, string | undefined>;
}>;

const CAPTURE_START_TIMEOUT_MS = 10_000;
const CAPTURE_STARTED_TIMEOUT_MS = 10_000;
// Production teardown may spend up to 35s on an exact kill and 30s on a
// sandbox lifetime rotation. Keep explicit room for the durable terminal fence
// and marker transaction rather than racing those writes at the same boundary.
const CAPTURE_ABANDON_TIMEOUT_MS = 90_000;
const CAPTURE_RESULT_TIMEOUT_MS = 60_000;
const CAPTURE_STATUS_RPC_TIMEOUT_MS = 10_000;

const terminalProcessStatus = (
  status: Process["status"],
): status is "completed" | "failed" | "killed" | "error" =>
  status === "completed" ||
  status === "failed" ||
  status === "killed" ||
  status === "error";

class LocalCaptureDeadlineError extends Error {}

const positiveDuration = (
  value: number | undefined,
  fallback: number,
): number =>
  typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : fallback;

/**
 * Keep both settlement handlers attached after the timer wins. A late platform
 * rejection is observed rather than becoming an unhandled rejection.
 */
const withLocalDeadline = <T>(
  operation: () => Promise<T>,
  timeoutMs: number,
  message: string,
  signal?: AbortSignal,
): Promise<T> =>
  new Promise<T>((resolve, reject) => {
    let settled = false;
    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    };
    const onAbort = () => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(
        signal?.reason instanceof Error
          ? signal.reason
          : new Error("Captured session process was canceled."),
      );
    };
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new LocalCaptureDeadlineError(message));
    }, timeoutMs);
    if (signal?.aborted) {
      onAbort();
      return;
    }
    signal?.addEventListener("abort", onAbort, { once: true });
    void Promise.resolve()
      .then(() => {
        // An abort can land after the synchronous `signal.aborted` check but
        // before this microtask. Never admit detached work after the deadline
        // has already won and teardown has started.
        if (settled) return undefined as T;
        return operation();
      })
      .then(
        (value) => {
          if (settled) return;
          settled = true;
          cleanup();
          resolve(value);
        },
        (error: unknown) => {
          if (settled) return;
          settled = true;
          cleanup();
          reject(error);
        },
      );
  });

export const strictSessionExec = (
  session: StrictExecSession,
  argv: readonly string[],
  options?: ExecOptions,
): Promise<ExecResult> =>
  // ExecutionSession owns a persistent shell. `exec setpriv ...` would replace
  // that shell, so a successful foreground command would terminate the whole
  // session and make every subsequent operation fail.
  session.exec(strictSessionCommandForMode(argv, false), options);

export const startStrictSessionProcess = (
  session: StrictProcessSession,
  argv: readonly string[],
  options?: ProcessOptions,
): Promise<Process> =>
  session.startProcess(strictSessionCommand(argv), options);

const trustedProcessCommand = (argv: readonly string[]): string => {
  if (argv.length === 0 || !argv[0]) {
    throw new Error("Captured process execution requires a command.");
  }
  return argv.map(quoteShellArg).join(" ");
};

/**
 * Run the trusted Stella executor as a named, sessionless process and collect
 * its authoritative terminal result from Cloudflare's process registry. The
 * executor must remain root so it can validate the root-owned host/native
 * anchors and apply the per-tool setpriv boundary itself. Untrusted app/build
 * commands continue to use `strictSessionExec`/`startStrictSessionProcess`.
 *
 * A foreground `ExecutionSession.exec()` RPC can remain pending after its
 * command exits, while an explicit-session background process can be tracked
 * as the persistent session shell rather than the one-shot command. The
 * Builder therefore passes the sessionless Sandbox facade here. A Process
 * start ACK, one terminal observer, and one final accumulated-log read avoid
 * capture-file polling or uncancellable RPC accumulation.
 *
 * The caller owns the destructive uncertainty boundary. A start whose ACK is
 * lost must destroy the exact sandbox. An acknowledged process that does not
 * yield a terminal event must be killed and its dedicated session deleted,
 * falling back to sandbox destruction. Production callers that may recover a
 * workspace must therefore supply `onAbandon`.
 */
export const capturedSessionExec = async (
  session: CapturedSession,
  argv: readonly string[],
  timeoutMs: number,
  options: CapturedSessionExecOptions = {},
): Promise<Pick<ExecResult, "success" | "exitCode" | "stdout" | "stderr">> => {
  const startTimeoutMs = positiveDuration(
    options.startTimeoutMs,
    CAPTURE_START_TIMEOUT_MS,
  );
  const resultTimeoutMs = positiveDuration(
    options.resultTimeoutMs,
    CAPTURE_RESULT_TIMEOUT_MS,
  );
  const startedTimeoutMs = positiveDuration(
    options.startedTimeoutMs,
    CAPTURE_STARTED_TIMEOUT_MS,
  );
  const abandonTimeoutMs = positiveDuration(
    options.abandonTimeoutMs,
    CAPTURE_ABANDON_TIMEOUT_MS,
  );
  const commandTimeoutMs = positiveDuration(timeoutMs, 1);
  const processId =
    options.processId?.trim() || `stella-captured-${crypto.randomUUID()}`;

  const abandon = async (
    phase: "start_uncertain" | "process_unsettled",
    cause: unknown,
  ): Promise<never> => {
    if (!options.onAbandon) {
      throw new Error("Captured session process could not be safely joined.", {
        cause,
      });
    }
    let disposition: CapturedSessionAbandonDisposition;
    try {
      disposition = await withLocalDeadline(
        async () => await options.onAbandon!({ phase, processId }),
        abandonTimeoutMs,
        "Captured session process teardown exceeded its local deadline.",
      );
    } catch (abandonError) {
      throw new Error("Captured session process could not be safely quiesced.", {
        cause: abandonError,
      });
    }
    throw new CapturedSessionAbandonedError({
      cause,
      disposition,
      phase,
    });
  };

  let process: Process;
  try {
    process = await withLocalDeadline(
      () =>
        session.startProcess(trustedProcessCommand(argv), {
          processId,
          autoCleanup: false,
          timeout: commandTimeoutMs,
          ...(options.cwd ? { cwd: options.cwd } : {}),
          ...(options.env ? { env: options.env } : {}),
        }),
      startTimeoutMs,
      "Captured session process start exceeded its local deadline.",
      options.signal,
    );
  } catch (error) {
    return await abandon("start_uncertain", error);
  }
  if (process.id !== processId) {
    return await abandon(
      "process_unsettled",
      new Error("Captured session process acknowledgement changed identity."),
    );
  }

  try {
    if (options.onStarted) {
      await withLocalDeadline(
        async () => await options.onStarted!(),
        startedTimeoutMs,
        "Captured session process durable admission exceeded its local deadline.",
        options.signal,
      );
    }
  } catch (error) {
    return await abandon("process_unsettled", error);
  }

  type TerminalObservation = {
    exitCode: number;
    process: Process;
  };
  let terminal: TerminalObservation;
  try {
    const statusObservation = session.getProcess
      ? (async (): Promise<TerminalObservation> => {
          const deadlineAt = Date.now() + commandTimeoutMs;
          let pollDelayMs = 100;
          while (true) {
            const remainingMs = deadlineAt - Date.now();
            if (remainingMs <= 0) {
              throw new LocalCaptureDeadlineError(
                "Captured session process exceeded its local command deadline.",
              );
            }
            // Cloudflare's process-info RPC can stay pending for the lifetime
            // of a running process. One locally bounded observer is enough to
            // close the subscribe-after-exit race; if it hangs, stop polling
            // rather than accumulating detached RPCs and let the already-open
            // exit stream remain authoritative.
            const observed = await withLocalDeadline(
              () => session.getProcess!(processId),
              Math.min(CAPTURE_STATUS_RPC_TIMEOUT_MS, remainingMs),
              "Captured session process status did not settle.",
              options.signal,
            );
            if (observed && terminalProcessStatus(observed.status)) {
              return {
                process: observed,
                exitCode: Number.isSafeInteger(observed.exitCode)
                  ? observed.exitCode!
                  : observed.status === "completed"
                    ? 0
                    : 1,
              };
            }
            const delayMs = Math.min(pollDelayMs, deadlineAt - Date.now());
            if (delayMs <= 0) continue;
            await withLocalDeadline(
              () => new Promise<void>((resolve) => setTimeout(resolve, delayMs)),
              delayMs + 25,
              "Captured session process exceeded its local command deadline.",
              options.signal,
            );
            pollDelayMs = Math.min(5_000, Math.ceil(pollDelayMs * 2.5));
          }
        })()
      : Promise.reject(
          new Error("Durable process status observation is unavailable."),
        );
    const exitStreamObservation = process
      .waitForExit(commandTimeoutMs)
      .then<TerminalObservation>((exit) => ({
        process,
        exitCode: exit.exitCode,
      }));
    terminal = await withLocalDeadline(
      () => Promise.any([statusObservation, exitStreamObservation]),
      commandTimeoutMs,
      "Captured session process exceeded its local command deadline.",
      options.signal,
    );
  } catch (error) {
    return await abandon("process_unsettled", error);
  }

  const logs = await withLocalDeadline(
    () => terminal.process.getLogs(),
    resultTimeoutMs,
    "Captured session process output exceeded its transfer deadline.",
    options.signal,
  );
  return {
    success: terminal.exitCode === 0,
    exitCode: terminal.exitCode,
    stdout: logs.stdout,
    stderr: logs.stderr,
  };
};
