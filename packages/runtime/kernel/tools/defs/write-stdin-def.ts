/**
 * The `write_stdin` tool's model-visible surface, split from the executable
 * definition for the reason described in `exec-command-def.ts`: the shell
 * handler behind it needs `node:child_process`, and the cloud `BuildSession`
 * DO must advertise the byte-identical tool from workerd.
 */

export const WRITE_STDIN_TOOL_NAME = "write_stdin";

export const WRITE_STDIN_TOOL_DESCRIPTION =
  "Continue or control an exec_command session owned by the current conversation/agent thread. Same-session interactions are serialized; different sessions remain parallel. Omit operation to write when chars is nonempty or poll when empty. Optional write_id makes retried writes idempotent within the session's bounded receipt window. Explicit operations also support terminate, pipe-only close_stdin, and PTY-only resize. Result details include stable interaction/chunk receipts and retain shell_session_id after completion. Required: session_id.";

export const WRITE_STDIN_TOOL_PROMPT_SNIPPET =
  "Continue or poll a long-running exec_command session";

export const WRITE_STDIN_TOOL_PARAMETERS: Record<string, unknown> = {
  type: "object",
  properties: {
    session_id: {
      // Stella allocates UUID session ids; advertised as `string` so strict
      // tool validators don't reject the value the model echoes back.
      type: "string",
      description:
        "Identifier returned by exec_command. Completed results keep it as shell_session_id provenance even when session_id becomes null.",
    },
    chars: {
      type: "string",
      description:
        "Bytes to write to stdin. May be empty to poll for more output without sending input.",
    },
    write_id: {
      type: "string",
      description:
        "Optional idempotency key for a write operation. Retrying the same id with identical chars skips duplicate input; reusing it with different chars is an error.",
    },
    operation: {
      type: "string",
      enum: ["write", "poll", "terminate", "close_stdin", "resize"],
      description:
        "Explicit interaction. Defaults to write for nonempty chars and poll otherwise. close_stdin supports pipe sessions; resize supports PTY sessions.",
    },
    cols: {
      type: "integer",
      minimum: 1,
      maximum: 1000,
      description: "PTY columns for operation=resize.",
    },
    rows: {
      type: "integer",
      minimum: 1,
      maximum: 1000,
      description: "PTY rows for operation=resize.",
    },
    yield_time_ms: {
      type: "number",
      description:
        "Maximum wait. A write defaults to 250 ms and caps at 30000; an empty poll defaults to 5000 and caps at 300000. Polls return on the first new output/activity, and all calls return early when the process exits.",
    },
    max_output_tokens: {
      type: "integer",
      minimum: 0,
      description:
        "Output token budget. Defaults to 10000 tokens; larger requests may be capped by the active model policy.",
    },
  },
  required: ["session_id"],
};
