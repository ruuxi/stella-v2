/**
 * Shared shell-safety patterns + device tool name constants.
 *
 * Stella's tool surface lives entirely in `runtime/kernel/tools/defs/` —
 * one self-contained `ToolDefinition` per tool, owning its own name,
 * description, JSON schema, and handler. The host imports them through
 * `defs/index.ts::buildBuiltinTools`.
 *
 * What remains in this file:
 *   - `DEVICE_TOOL_NAMES`: tools the agent runtime treats as device-local.
 *   - `getDangerousCommandReason`: the catastrophic-operation guard consumed
 *     by `exec_command` and other shell paths.
 */

import { getCatastrophicShellCommandReason } from "./shell-command-safety.js";

export const DEVICE_TOOL_NAMES = ["RequestCredential"] as const;

export type DeviceToolName = (typeof DEVICE_TOOL_NAMES)[number];

export function getDangerousCommandReason(
  command: string,
  cwd?: string,
): string | null {
  return getCatastrophicShellCommandReason(command, cwd);
}
