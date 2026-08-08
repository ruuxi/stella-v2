/**
 * Reasoning-effort choices shared by the sidebar model picker and the
 * composer's pinned mini picker, so both surfaces present the same ladder.
 */
export type ReasoningEffortOptionId =
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh";

export type ReasoningEffortOption = {
  id: ReasoningEffortOptionId;
  label: string;
};

export const REASONING_EFFORT_OPTIONS: readonly ReasoningEffortOption[] = [
  { id: "minimal", label: "Minimal" },
  { id: "low", label: "Low" },
  { id: "medium", label: "Medium" },
  { id: "high", label: "High" },
  { id: "xhigh", label: "Extra" },
];

/**
 * Claude Code has no "minimal" tier (it is normalized to "low" on write),
 * so the picker hides that pill while the engine is committed.
 */
export function listReasoningEffortOptions(
  engine: string,
): readonly ReasoningEffortOption[] {
  return REASONING_EFFORT_OPTIONS.filter(
    (option) => engine !== "claude_code_local" || option.id !== "minimal",
  );
}
