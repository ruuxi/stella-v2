/**
 * The `exec_command` tool's model-visible surface — name, description, prompt
 * snippet, parameter schema — split from the executable definition so hosts
 * that assemble their own tool list still expose the byte-identical tool to
 * the model. The cloud `BuildSession` DO runs in workerd and cannot import
 * `shell.ts`, which reaches `node:child_process`. `exec-command.ts` composes
 * this with the executable handler for tool-host consumers.
 */

export const EXEC_COMMAND_TOOL_NAME = "exec_command";

export const EXEC_COMMAND_TOOL_DESCRIPTION =
  "Run a command in a shell process. By default stdin/stdout/stderr use ordinary pipes; set tty: true for a real Unix PTY on macOS/Linux or ConPTY on supported Windows. Returns immediate output, or a session_id if the process is still running so you can poll/interact via write_stdin. Streaming updates are incremental UTF-8 deltas with stable cursor receipts; final details retain shell_session_id even after completion. Required: cmd. Node.js and Stella CLIs (stella-browser, stella-office, stella-computer, stella-media, stella-x-api) are auto-injected into PATH.";

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
    yield_time_ms: {
      type: "number",
      description:
        "How long to wait (in milliseconds) for output before yielding control back to you with a session_id. Defaults to 10000.",
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
