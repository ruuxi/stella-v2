export type ReasoningEffortOptionId =
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh";

export type ReasoningEffortOption = {
  id: ReasoningEffortOptionId;

  label: string;

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

export function listReasoningEffortOptions(
  engine: string,
): readonly ReasoningEffortOption[] {
  return REASONING_EFFORT_OPTIONS.filter(
    (option) => engine !== "claude_code_local" || option.id !== "minimal",
  );
}
