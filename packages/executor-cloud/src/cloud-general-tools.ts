/**
 * The container executor's general-agent tool names. They live in a module of
 * their own, free of Node builtins, because the worker renders the agent's
 * prompt for exactly these tools at dispatch.
 *
 * Pinned in code, not read from agent-metadata: the sandbox image's home-seed
 * copy is agent-writable in principle, and the cloud contract is that
 * allowlists governing execution surfaces are never data-driven.
 *
 * The document and media stack adds no tool names — the host exposes
 * `stella-office`, poppler and `mediainfo` as shell commands, so they arrive
 * through `Bash`. `Read` is the one catalog addition they need: a
 * plain-text read of extracted document text that does not cost a PTY turn.
 */

const CLOUD_GENERAL_TOOLS = [
  "Bash",
  "write_stdin",
  "apply_patch",
  "web",
  "Read",
  "Write",
  "Edit",
  "Grep",
  "ask_user",
  "request_secure_input",
] as const;

export const cloudGeneralToolNames = (): readonly string[] =>
  CLOUD_GENERAL_TOOLS;
