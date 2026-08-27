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

export const createShellToolHandlers = (
  shellState: ShellState,
): Record<string, ToolHandler> => ({
  Bash: (args, context, extras) =>
    handleBash(shellState, args, context, extras?.signal),
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
