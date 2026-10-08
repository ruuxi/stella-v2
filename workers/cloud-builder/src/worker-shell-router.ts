/**
 * Chooses where each Bash command runs: the just-bash worker shell, or the
 * sandbox container.
 *
 * The rule is simple because the worker shell is transactional. A command
 * goes to the worker shell only while this turn has no sandbox attached;
 * once one is, the container's disk may hold changes no WorldStore read can
 * see yet (a background process, a command between sync points), so every
 * later command goes to the sandbox too. In the worker shell a command
 * either finishes and its changes are committed once, or it stops before
 * anything is committed and the whole command is handed to the sandbox. No
 * statement ever runs in both, and a completed command is never retried.
 *
 * `write_stdin` and PTY sessions only exist in the sandbox, so they always
 * go there.
 */

import {
  isShellCommandToolName,
  type SerializedAgentToolResult,
} from "@stella/executor-cloud/attached-tool-protocol";
import type { GeneralAgentComputeBridge } from "./general-agent-tools.js";
import type {
  WorkerShellRunner,
  WorkerShellRunResult,
} from "./worker-shell-runner.js";
import { WORKER_SHELL_MAX_TIMEOUT_MS } from "./worker-shell/protocol.js";
import { normalizeShellPath } from "./worker-shell/paths.js";
import {
  CLOUD_TOOL_HOME,
  toolStateEnvironment,
  WORLD_UNSYNCED_PATHS,
} from "@stella/contracts/cloud-tool-home";

export type WorkerShellLadder = Readonly<{
  execute(call: {
    toolCallId: string;
    toolName: string;
    params: Record<string, unknown>;
  }): Promise<SerializedAgentToolResult>;
  attached(): boolean;
}>;

/**
 * The tool account the container runs a tool process as
 * (`CLOUD_TOOL_PROCESS_IDENTITY`). The container module spawns processes and
 * cannot load in a Durable Object; `worker-shell-router.test.ts` pins this
 * against it. HOME and the cache, config and state directories come from
 * `@stella/contracts/cloud-tool-home`, as they do in the container.
 */
export const WORKER_SHELL_TOOL_USER = "stella-tools";

/**
 * The user's drive is hydrated into the world only when a sandbox attaches
 * (`hydrateDriveForAgentTurn`), so the world may not hold the user's latest
 * uploads. The worker shell leaves it to the sandbox rather than answer from
 * an older copy.
 */
export const WORKER_SHELL_SANDBOX_ONLY: readonly string[] = ["drive"];

const DEFAULT_YIELD_MS = 10_000;
const MIN_TIMEOUT_MS = 1_000;
const MODEL_VISIBLE_MAX_CHARS = 30_000;
const APPROX_BYTES_PER_TOKEN = 4;

const SHELLS_THE_WORKER_SHELL_SPEAKS: ReadonlySet<string> = new Set([
  "bash",
  "sh",
]);

export type WorkerShellRoute =
  | Readonly<{
      route: "worker_shell";
      script: string;
      cwd: string;
      timeoutMs: number;
      maxChars: number;
    }>
  | Readonly<{ route: "sandbox"; why: string }>;

export type WorkerShellRouteInput = Readonly<{
  params: Record<string, unknown>;
  root: string;
  sandboxAttached: boolean;
  /** The container's catastrophic-command guard, or null when it passes. */
  dangerousReason: (command: string, cwd: string) => Promise<string | null>;
}>;

/** Decide where one Bash command runs. Pure apart from the guard. */
export const routeExecCommand = async (
  input: WorkerShellRouteInput,
): Promise<WorkerShellRoute> => {
  const { params } = input;
  if (input.sandboxAttached) {
    return { route: "sandbox", why: "the sandbox is attached" };
  }
  const script = params.cmd;
  if (typeof script !== "string" || script.trim() === "") {
    return { route: "sandbox", why: "cmd is missing" };
  }
  if (params.tty === true) {
    return { route: "sandbox", why: "tty needs a real terminal" };
  }
  if (params.shell !== undefined && params.shell !== null) {
    const shell = String(params.shell);
    const name = shell.slice(shell.lastIndexOf("/") + 1);
    if (!SHELLS_THE_WORKER_SHELL_SPEAKS.has(name)) {
      return { route: "sandbox", why: `${shell} is not bash` };
    }
  }
  const workdir = params.workdir ?? params.working_directory;
  const cwd =
    workdir === undefined || workdir === null
      ? input.root
      : normalizeShellPath(
          String(workdir).startsWith("/")
            ? String(workdir)
            : `${input.root}/${String(workdir)}`,
        );
  if (cwd !== input.root && !cwd.startsWith(`${input.root}/`)) {
    return { route: "sandbox", why: "workdir is outside the workspace" };
  }
  let dangerous: string | null;
  try {
    dangerous = await input.dangerousReason(script, cwd);
  } catch {
    dangerous = "the safety check could not run";
  }
  if (dangerous) {
    // The sandbox refuses it with the exact message it always has.
    return { route: "sandbox", why: "the command is blocked for safety" };
  }
  const yieldMs =
    typeof params.yield_time_ms === "number" &&
    Number.isFinite(params.yield_time_ms)
      ? params.yield_time_ms
      : DEFAULT_YIELD_MS;
  const tokens = params.max_output_tokens;
  const maxChars =
    typeof tokens === "number" && Number.isSafeInteger(tokens) && tokens >= 0
      ? Math.min(MODEL_VISIBLE_MAX_CHARS, tokens * APPROX_BYTES_PER_TOKEN)
      : MODEL_VISIBLE_MAX_CHARS;
  return {
    route: "worker_shell",
    script,
    cwd,
    // A command that outlives its yield window would have handed the model a
    // session in the sandbox. Here it falls back and gets exactly that.
    timeoutMs: Math.max(
      MIN_TIMEOUT_MS,
      Math.min(yieldMs, WORKER_SHELL_MAX_TIMEOUT_MS),
    ),
    maxChars,
  };
};

const bound = (text: string, maxChars: number): string => {
  if (text.length <= maxChars) return text;
  const half = Math.floor(maxChars / 2);
  return `${text.slice(0, half)}\n…[truncated]…\n${text.slice(text.length - half)}`;
};

const joinOutput = (stdout: string, stderr: string): string =>
  !stdout || !stderr || stdout.endsWith("\n")
    ? `${stdout}${stderr}`
    : `${stdout}\n${stderr}`;

/**
 * The container's Bash result shape (`formatExecToolResult`), so a
 * model sees one tool whichever runtime answered.
 */
export const formatWorkerShellResult = (
  result: Extract<WorkerShellRunResult, { kind: "completed" }>,
  context: Readonly<{
    command: string;
    cwd: string;
    wallTimeMs: number;
    maxChars: number;
  }>,
): SerializedAgentToolResult => {
  const output = joinOutput(result.stdout, result.stderr);
  const wallTimeSeconds = context.wallTimeMs / 1000;
  const originalTokenCount = Math.ceil(
    result.outputBytes / APPROX_BYTES_PER_TOKEN,
  );
  const text = [
    `Wall time: ${wallTimeSeconds.toFixed(4)} seconds`,
    `Process exited with code ${result.exitCode}`,
    `Original token count: ${originalTokenCount}`,
    "Output:",
    bound(output, context.maxChars),
  ].join("\n");
  return {
    outcome: { kind: "ok", text },
    details: {
      runtime: "worker_shell",
      session_id: null,
      running: false,
      exit_code: result.exitCode,
      wall_time_seconds: wallTimeSeconds,
      original_token_count: originalTokenCount,
      cwd: context.cwd,
      command: context.command,
      world_revision: result.revision,
    },
    authorizedImages: [],
  };
};

const errorResult = (message: string): SerializedAgentToolResult => ({
  outcome: { kind: "error", message },
  details: null,
  authorizedImages: [],
});

export type WorkerShellRouterInput = Readonly<{
  ladder: WorkerShellLadder;
  /** Absent on a deployment without the Worker Loader: everything attaches. */
  shell?: WorkerShellRunner;
  root: string;
  /** Establish the current drive before shell reads; false attaches the sandbox. */
  prepareWorkspace?: () => Promise<boolean>;
  signal?: AbortSignal;
  emitEvent?: (kind: string, payload: unknown) => void;
  now?: () => number;
  dangerousReason?: (command: string, cwd: string) => Promise<string | null>;
}>;

const loadDangerousReason = async (
  command: string,
  cwd: string,
): Promise<string | null> => {
  const { getDangerousCommandReason } = await import(
    "@stella/runtime/kernel/tools/schemas.js"
  );
  return getDangerousCommandReason(command, cwd);
};

export const createWorkerShellRouter = (
  input: WorkerShellRouterInput,
): GeneralAgentComputeBridge => {
  const now = input.now ?? (() => Date.now());
  const shell = input.shell;
  const toSandbox = ({
    toolCallId,
    toolName,
    params,
  }: Parameters<GeneralAgentComputeBridge["execute"]>[0]) =>
    input.ladder.execute({ toolCallId, toolName, params });
  return {
    async execute(call) {
      // Older callers still name the shell tool `exec_command`; it is the
      // same tool and takes the same route.
      if (!isShellCommandToolName(call.toolName) || !shell) {
        return await toSandbox(call);
      }
      const route = await routeExecCommand({
        params: call.params,
        root: input.root,
        sandboxAttached: input.ladder.attached(),
        dangerousReason: input.dangerousReason ?? loadDangerousReason,
      });
      if (route.route === "sandbox") return await toSandbox(call);
      if (input.prepareWorkspace && !(await input.prepareWorkspace())) {
        return await toSandbox(call);
      }
      // Hydration may have attached while another resident tool was running.
      if (input.ladder.attached()) return await toSandbox(call);
      const started = now();
      const result = await shell.run(
        {
          script: route.script,
          cwd: route.cwd,
          env: {
            HOME: input.root,
            USER: WORKER_SHELL_TOOL_USER,
            LOGNAME: WORKER_SHELL_TOOL_USER,
            ...toolStateEnvironment(CLOUD_TOOL_HOME),
            STELLA_CLOUD_WORKSPACE_ROOT: input.root,
            PWD: route.cwd,
          },
          timeoutMs: route.timeoutMs,
          // HOME's caches and the mirrored skills exist only on the
          // sandbox's disk, so touching one hands the command over.
          sandboxOnly: [
            ...WORLD_UNSYNCED_PATHS,
            ...(input.prepareWorkspace ? [] : WORKER_SHELL_SANDBOX_ONLY),
          ],
        },
        call.signal ?? input.signal,
      );
      switch (result.kind) {
        case "completed":
          return formatWorkerShellResult(result, {
            command: route.script,
            cwd: route.cwd,
            wallTimeMs: now() - started,
            maxChars: route.maxChars,
          });
        case "fallback":
          // Nothing this run did reached the world, so the sandbox runs the
          // whole command from the state the model last saw.
          input.emitEvent?.("worker_shell_fallback", {
            toolCallId: call.toolCallId,
            reason: result.reason,
            detail: result.detail,
          });
          return await toSandbox(call);
        case "cancelled":
          return errorResult(
            "The command was cancelled before it changed the workspace.",
          );
        case "failed":
          return errorResult(result.message);
      }
    },
  };
};
