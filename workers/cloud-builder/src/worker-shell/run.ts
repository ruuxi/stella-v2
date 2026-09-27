/**
 * One worker-shell run: interpret the script against the staged workspace
 * and report either its result and change set, or why the sandbox has to run
 * it instead. Kept free of `cloudflare:workers` so it runs under bun as well
 * as inside the Dynamic Worker.
 */

import { Bash } from "just-bash";
import type { CommandName, ScriptNode } from "just-bash";
import {
  analyzeWorkerShellScript,
  WORKER_SHELL_COMMANDS,
} from "./eligibility.js";
import {
  WORKER_SHELL_LIMITS,
  WORKER_SHELL_MAX_TIMEOUT_MS,
  type WorkerShellOutcome,
  type WorkerShellRequest,
} from "./protocol.js";
import {
  normalizeShellPath,
  WorkerShellFileSystem,
  WorkerShellGuard,
  type WorkerShellWorld,
} from "./workspace-fs.js";

/**
 * The hooks the bundle build patches into just-bash's dispatcher and limit
 * errors (see `scripts/build-worker-shell.mjs`). They exist for the paths no
 * parse reaches: a workspace file resolved as a script, a name no registered
 * command answers, and an interpreter limit that ended execution early.
 */
export type WorkerShellDispatchHooks = {
  userScript(path: string): void;
  commandNotFound(name: string): void;
  limit(message: string): void;
  /** Every registered command's own result, before redirections apply. */
  commandResult(result: { stderr?: unknown; exitCode?: unknown }): void;
};

/**
 * How just-bash commands say they lack something the real tool has. A match
 * sends the command to the sandbox; a false match only costs a sandbox run,
 * because nothing has been committed when it is seen.
 */
const MISSING_FEATURE =
  /\b(?:not supported|not implemented|unrecognized option|invalid option|unknown option)\b/iu;

export const missingFeature = (stderr: unknown): string | null => {
  if (typeof stderr !== "string" || stderr === "") return null;
  const line = stderr
    .split("\n")
    .find((candidate) => MISSING_FEATURE.test(candidate));
  return line ? line.trim().slice(0, 300) : null;
};

/**
 * Which run a hook call belongs to. A Dynamic Worker isolate may serve
 * concurrent runs, so the patched call sites reach the current run through
 * async context rather than through one mutable global.
 */
export type WorkerShellHookScope = Readonly<{
  run<T>(hooks: WorkerShellDispatchHooks, body: () => Promise<T>): Promise<T>;
}>;

const encoder = new TextEncoder();

export type RunWorkerShellOptions = Readonly<{
  /** Resolves when the BuildSession cancels the tool call. */
  cancelled?: Promise<unknown>;
  limits?: Partial<typeof WORKER_SHELL_LIMITS>;
  hooks?: WorkerShellHookScope;
}>;

const unscoped: WorkerShellHookScope = {
  run: (_hooks, body) => body(),
};

export const runWorkerShell = async (
  request: WorkerShellRequest,
  world: WorkerShellWorld,
  options: RunWorkerShellOptions = {},
): Promise<WorkerShellOutcome> => {
  const limits = { ...WORKER_SHELL_LIMITS, ...options.limits };
  if (encoder.encode(request.script).byteLength > limits.scriptBytes) {
    return {
      kind: "fallback",
      reason: "resource_limit",
      detail: `the command is longer than ${limits.scriptBytes} bytes`,
    };
  }
  const guard = new WorkerShellGuard();
  const hooks: WorkerShellDispatchHooks = {
    userScript: (path) =>
      guard.veto("unsupported_command", `${path} would run as a program`),
    commandNotFound: (name) =>
      guard.veto(
        "unsupported_command",
        `${name} is not available in the lightweight shell`,
      ),
    limit: (message) => guard.stop("resource_limit", message),
    commandResult: (result) => {
      const missing = missingFeature(result.stderr);
      if (missing) guard.veto("unsupported_command", missing);
    },
  };
  const fs = new WorkerShellFileSystem({
    root: request.root,
    world,
    guard,
    limits,
    sandboxOnly: request.sandboxOnly,
  });
  const timeoutMs = Math.max(
    1,
    Math.min(request.timeoutMs, WORKER_SHELL_MAX_TIMEOUT_MS),
  );
  const bash = new Bash({
    fs,
    cwd: request.cwd,
    env: { ...request.env },
    commands: [...WORKER_SHELL_COMMANDS] as CommandName[],
    // The Dynamic Worker is the isolation boundary. just-bash's in-process
    // defense box installs module hooks workerd does not implement.
    defenseInDepth: false,
    executionLimits: {
      maxSourceBytes: limits.scriptBytes,
      maxOutputSize: limits.outputBytes,
      maxFileSystemBytes: limits.scratchBytes,
      // A backstop only: the run's own deadline below fires first and
      // records why, so a just-bash timeout never reads as a result.
      maxExecutionTimeMs: timeoutMs + 5_000,
    },
  });
  bash.registerTransformPlugin({
    name: "stella-worker-shell-eligibility",
    transform: (context: { ast: ScriptNode }) => {
      const verdict = analyzeWorkerShellScript(context.ast);
      if (!verdict.ok) guard.veto(verdict.reason, verdict.detail);
      return { ast: context.ast };
    },
  });
  const deadline = AbortSignal.timeout(timeoutMs);
  deadline.addEventListener("abort", () =>
    guard.stop(
      "timeout",
      `the command ran longer than ${timeoutMs} ms in the lightweight shell`,
    ),
  );
  void options.cancelled?.then(
    () => guard.stop("timeout", "the tool call was cancelled"),
    () => undefined,
  );
  let result: Awaited<ReturnType<Bash["exec"]>> | null = null;
  try {
    // The sandbox refuses a workdir that is missing, outside the workspace,
    // or reached through a link; it says so in its own words.
    const cwd = normalizeShellPath(request.cwd);
    const canonical = await fs.realpath(cwd).catch(() => null);
    if (canonical !== cwd || !(await fs.stat(cwd)).isDirectory) {
      guard.veto(
        "unsupported_filesystem_operation",
        `workdir ${request.cwd} is not an existing real directory in the workspace`,
      );
    }
    result = await (options.hooks ?? unscoped).run(hooks, () =>
      bash.exec(request.script, {
        cwd: request.cwd,
        signal: deadline,
        rawScript: true,
      }),
    );
  } catch (error) {
    guard.stop(
      "unsupported_syntax",
      error instanceof Error ? error.message : "the interpreter failed",
    );
  }
  const veto = guard.vetoed();
  if (veto || !result) {
    return {
      kind: "fallback",
      reason: veto?.reason ?? "unsupported_syntax",
      detail: veto?.detail ?? "the interpreter did not finish",
    };
  }
  let changes;
  try {
    changes = await fs.changes();
  } catch (error) {
    const late = guard.vetoed();
    if (late) {
      return { kind: "fallback", reason: late.reason, detail: late.detail };
    }
    throw error;
  }
  return {
    kind: "completed",
    stdout: result.stdout,
    stderr: result.stderr,
    exitCode: result.exitCode,
    outputBytes:
      encoder.encode(result.stdout).byteLength +
      encoder.encode(result.stderr).byteLength,
    reads: fs.readSet(),
    changes,
    stats: fs.stats(),
  };
};
