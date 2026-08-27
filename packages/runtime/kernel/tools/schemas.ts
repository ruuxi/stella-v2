import { getCatastrophicShellCommandReason } from "./shell-command-safety.js";

export const DEVICE_TOOL_NAMES = ["RequestCredential"] as const;

export type DeviceToolName = (typeof DEVICE_TOOL_NAMES)[number];

export function getDangerousCommandReason(
  command: string,
  cwd?: string,
): string | null {
  return getCatastrophicShellCommandReason(command, cwd);
}
