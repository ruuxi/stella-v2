/**
 * The character states shared by the mobile working indicator and its mark.
 * This is the native counterpart of desktop's working-indicator state map.
 */
export type WorkingIndicatorCharacterState =
  | "thinking"
  | "working"
  | "writing"
  | "searching"
  | "reading";

/** Match the desktop character pose to the tool currently doing the work. */
export function getWorkingIndicatorCharacterState(
  toolName?: string,
): WorkingIndicatorCharacterState {
  const tool = toolName?.trim().toLowerCase() ?? "";
  if (!tool) return "thinking";
  if (/search|web/.test(tool)) return "searching";
  if (/read|fetch/.test(tool)) return "reading";
  if (/write|edit/.test(tool)) return "writing";
  return "working";
}
