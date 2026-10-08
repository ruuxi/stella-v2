/**
 * The `Bash` tool's model-visible surface — name, description, prompt
 * snippet, parameter schema — split from the executable definition so hosts
 * that assemble their own tool list still expose the byte-identical tool to
 * the model. The cloud `BuildSession` DO runs in workerd and cannot import
 * `shell.ts`, which reaches `node:child_process`. `exec-command.ts` composes
 * this with the executable handler for tool-host consumers.
 */

/**
 * Named like Claude Code's built-in so the model meets one shell tool by one
 * name whichever engine runs the turn. `exec_command` was the original name
 * and stays recognized wherever a tool name is received (agent definitions,
 * persisted transcripts, cloud protocol frames).
 */
export const EXEC_COMMAND_TOOL_NAME = "Bash";
export const LEGACY_EXEC_COMMAND_TOOL_NAME = "exec_command";
export const SHELL_COMMAND_TOOL_NAMES: readonly string[] = [
  EXEC_COMMAND_TOOL_NAME,
  LEGACY_EXEC_COMMAND_TOOL_NAME,
];
/** True for the shell tool under its current or original name. */
export const isShellCommandToolName = (toolName: string): boolean =>
  toolName === EXEC_COMMAND_TOOL_NAME ||
  toolName === LEGACY_EXEC_COMMAND_TOOL_NAME;

export const EXEC_COMMAND_TOOL_DESCRIPTION =
  "Run a shell command and wait for it to finish, returning its full output in one result. Waits up to timeout_ms (default 120000, max 600000); a command still running at the timeout keeps running and the result carries a session_id for write_stdin. Set run_in_background: true for a job you do not need to wait on: the call returns right away with a session_id, and if your turn ends while it runs, its exit code and output are delivered to you automatically, so never poll just to wait. By default stdin/stdout/stderr use ordinary pipes; set tty: true for a real Unix PTY on macOS/Linux or ConPTY on supported Windows when a program needs a terminal. Required: cmd. Node.js and Stella CLIs (stella-browser, stella-office, stella-computer, stella-media, stella-x-api) are auto-injected into PATH.";

export const EXEC_COMMAND_TOOL_PROMPT_SNIPPET =
  "Execute shell commands (git, build, package managers, file scripts)";

export const EXEC_COMMAND_TOOL_PARAMETERS: Record<string, unknown> = {
  type: "object",
  properties: {
    cmd: { type: "string", description: "Shell command to execute." },
    workdir: {
      type: "string",
      description:
        "Optional working directory to run the command in; defaults to the turn cwd.",
    },
    shell: {
      type: "string",
      description:
        "Shell binary to launch. Defaults to the user's detected login shell on macOS/Linux (with platform fallbacks), and to pwsh then Windows PowerShell on Windows with cmd.exe as the final fallback. Explicit shells use their native command syntax.",
    },
    tty: {
      type: "boolean",
      description:
        "True allocates a real pseudo-terminal for interactive terminal programs; false or omitted uses ordinary pipes. Uses a Unix PTY on macOS/Linux and ConPTY on supported Windows.",
    },
    timeout_ms: {
      type: "number",
      description:
        "How long to wait (in milliseconds) for the command to exit before returning with a session_id for the still-running process. Defaults to 120000; maximum 600000. Raise it for builds and test suites instead of polling.",
    },
    run_in_background: {
      type: "boolean",
      description:
        "True starts the command and returns immediately with a session_id instead of waiting. Its completion reaches you automatically once your turn ends. Use for servers, watchers, and long jobs whose result you do not need right now.",
    },
    max_output_tokens: {
      type: "integer",
      minimum: 0,
      description:
        "Output token budget. Defaults to 10000 tokens; larger requests may be capped by the active model policy.",
    },
    login: {
      type: "boolean",
      description:
        "On Unix, true invokes the shell with -lc and false with -c. Defaults to true.",
    },
  },
  required: ["cmd"],
};

/** Replay policy (`ToolReplayPolicy` in ../types.ts). An arbitrary process; its effect cannot be proven or repeated safely. */
export const EXEC_COMMAND_TOOL_REPLAY = "unsafe" as const;
