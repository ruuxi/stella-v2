/**
 * Residual handler factories.
 *
 * Stella's tool surface is defined by self-contained `ToolDefinition`s under
 * `runtime/kernel/tools/defs/` — one tool per file, each owning its own
 * name + description + parameters + handler. The host imports them through
 * `defs/index.ts::buildBuiltinTools` and routes calls directly.
 *
 * What's left here:
 *   - `mergeToolHandlers`: small utility used by the host
 *   - `createShellToolHandlers`: legacy companions to `Bash` /
 *     `write_stdin` (Bash / ShellStatus / KillShell). Reachable only via
 *     direct `executeTool` calls from non-model code paths; not exposed in
 *     the model-facing catalog.
 *   - `registerExtensionToolHandlers`: helper that lets the host map
 *     runtime-injected ToolDefinitions onto the same handler map.
 */

import {
  handleBash,
  handleKillShell,
  handleShellStatus,
  type ShellState,
} from "./shell.js";
import type { ToolHandler } from "./types.js";
import type { ToolDefinition } from "../extensions/types.js";

export const mergeToolHandlers = (
  ...groups: Array<Record<string, ToolHandler>>
): Record<string, ToolHandler> => Object.assign({}, ...groups);

// ShellStatus / KillShell remain here; the model-facing `Bash` (and its
// `write_stdin` companion) live in defs/exec-command.ts and
// defs/write-stdin.ts now, so the old one-shot `Bash` handler is gone.
export const createShellToolHandlers = (
  shellState: ShellState,
): Record<string, ToolHandler> => ({
  ShellStatus: (args, context) => handleShellStatus(shellState, args, context),
  KillShell: (args, context) => handleKillShell(shellState, args, context),
});

export const registerExtensionToolHandlers = (
  handlers: Record<string, ToolHandler>,
  extensionTools?: ToolDefinition[],
): void => {
  if (!extensionTools) return;
  for (const tool of extensionTools) {
    handlers[tool.name] = (args, context) => tool.execute(args, context);
  }
};
