/**
 * Which Claude Code built-in tools a Stella-driven Claude Code session keeps.
 *
 * Stella used to disable every built-in and serve its own Read/Write/Edit/
 * shell clones over a private MCP server. Each of those calls then paid an
 * HTTP round trip plus the host's correlation gate (a measured ~2s for a
 * file read that native Read does in-process). The built-ins listed here run
 * inside the CLI; the Stella tools they supersede are dropped from the MCP
 * catalog so the model never sees two spellings of the same operation.
 *
 * The orchestrator coordinates rather than works: it may look (Read, Grep,
 * Glob) but never gets a native shell or file writer. Workers get the full
 * file and shell set.
 */
import type { ToolMetadata } from "../tools/types.js";

export type ClaudeCodeNativeToolRole = "orchestrator" | "worker";

export const CLAUDE_CODE_ORCHESTRATOR_NATIVE_TOOLS: readonly string[] = [
  "Read",
  "Grep",
  "Glob",
];

export const CLAUDE_CODE_WORKER_NATIVE_TOOLS: readonly string[] = [
  "Read",
  "Edit",
  "Write",
  "Bash",
  "Grep",
  "Glob",
];

/**
 * Stella tools each built-in replaces. Anything not listed (apply_patch,
 * code, html, web, browser, computer, agents, images, ...) stays on MCP.
 */
const STELLA_TOOLS_REPLACED_BY_NATIVE: Readonly<
  Record<string, readonly string[]>
> = {
  Read: ["Read"],
  Edit: ["Edit"],
  Write: ["Write"],
  Bash: ["Bash", "exec_command", "write_stdin"],
  Grep: ["Grep"],
  Glob: [],
};

/**
 * The orchestrator never writes files, natively or over MCP: its memory
 * goes through the `memory` client inside `code`, and every other change is
 * delegated to an agent. Withheld even when an agent definition lists them,
 * so a prompt override cannot hand them back.
 */
export const CLAUDE_CODE_ORCHESTRATOR_WITHHELD_TOOLS: readonly string[] = [
  "Write",
  "Edit",
  "apply_patch",
  "Bash",
  "exec_command",
  "write_stdin",
];

/**
 * Stella tool names that grant each built-in when an agent has a tools
 * allowlist. A built-in is granted when the allowlist names it or any
 * Stella tool it stands in for (shell -> Bash, apply_patch -> Write/Edit);
 * Glob, read-only, rides on Read or Grep.
 */
const STELLA_TOOLS_GRANTING_NATIVE: Readonly<
  Record<string, readonly string[]>
> = {
  Read: ["Read"],
  Edit: ["Edit", "apply_patch"],
  Write: ["Write", "apply_patch"],
  Bash: ["Bash", "exec_command", "write_stdin"],
  Grep: ["Grep"],
  Glob: ["Glob", "Grep", "Read"],
};

/**
 * The built-ins a role keeps, narrowed to the agent's tools allowlist when
 * it has one (an absent or empty allowlist means the role's full set, the
 * same default Stella's own tool resolution uses).
 */
export const resolveClaudeCodeNativeTools = (
  role: ClaudeCodeNativeToolRole,
  toolsAllowlist?: readonly string[],
): readonly string[] => {
  const roleTools =
    role === "orchestrator"
      ? CLAUDE_CODE_ORCHESTRATOR_NATIVE_TOOLS
      : CLAUDE_CODE_WORKER_NATIVE_TOOLS;
  if (!Array.isArray(toolsAllowlist) || toolsAllowlist.length === 0) {
    return roleTools;
  }
  const allowed = new Set(toolsAllowlist);
  return roleTools.filter((nativeTool) =>
    (STELLA_TOOLS_GRANTING_NATIVE[nativeTool] ?? [nativeTool]).some((name) =>
      allowed.has(name),
    ),
  );
};

/**
 * Drop the Stella MCP tools that an enabled built-in supersedes, plus the
 * ones the role must never hold.
 */
export const withoutToolsReplacedByNative = <
  T extends Pick<ToolMetadata, "name">,
>(
  tools: readonly T[],
  nativeTools: readonly string[],
  role: ClaudeCodeNativeToolRole = "worker",
): T[] => {
  const replaced = new Set<string>(
    role === "orchestrator" ? CLAUDE_CODE_ORCHESTRATOR_WITHHELD_TOOLS : [],
  );
  for (const nativeTool of nativeTools) {
    for (const name of STELLA_TOOLS_REPLACED_BY_NATIVE[nativeTool] ?? []) {
      replaced.add(name);
    }
  }
  if (replaced.size === 0) return [...tools];
  return tools.filter((tool) => !replaced.has(tool.name));
};

/** MCP tools are `mcp__<server>__<name>`; everything else is a CLI built-in. */
export const isClaudeCodeNativeToolName = (toolName: string): boolean =>
  !toolName.startsWith("mcp__");
