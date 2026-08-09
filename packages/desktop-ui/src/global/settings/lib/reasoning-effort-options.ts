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
  /**
   * English label kept for surfaces that have not moved onto `useT()` yet.
   * Prefer `labelKey` with the i18n catalog for anything user-visible.
   */
  label: string;
  /** Catalog key for the localized label. */
  labelKey: string;
};

export const REASONING_EFFORT_OPTIONS: readonly ReasoningEffortOption[] = [
  {
    id: "minimal",
    label: "Minimal",
    labelKey: "settings.reasoningEffort.minimal",
  },
  { id: "low", label: "Low", labelKey: "settings.reasoningEffort.low" },
  {
    id: "medium",
    label: "Medium",
    labelKey: "settings.reasoningEffort.medium",
  },
  { id: "high", label: "High", labelKey: "settings.reasoningEffort.high" },
  { id: "xhigh", label: "Extra", labelKey: "settings.reasoningEffort.xhigh" },
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
