/**
 * Mobile port of the desktop working-indicator derivation
 * (`desktop/src/features/chat/working-indicator-state.ts`). Turns the live
 * run snapshot — which tool is in flight, whether this turn's answer has
 * landed — into the props the native `WorkingIndicator` consumes, so the
 * mobile indicator mirrors the desktop's show/hide and labelling behaviour
 * instead of sitting on a single static "Thinking" string.
 */

/**
 * Live snapshot of the in-flight run, folded together from the bridge's agent
 * events (tool-start / tool-end / status / assistant-message) the same way the
 * desktop store does.
 */
export type WorkingActivity = {
  /** The orchestrator tool currently in flight, if any. */
  toolName?: string;
  /** Stable id of that tool call; seeds the friendly label so it doesn't
   * churn on every re-render. */
  toolCallId?: string;
  /** Run-level status text (wake copy, compaction, raw tool status, …). */
  statusText?: string;
  /**
   * True once an assistant message arrived that is NOT followed by more tool
   * work — the answer the user is waiting for is on screen. Assistant text is
   * delivered whole, so this flips exactly once per answer rather than
   * tracking a growing reply.
   */
  answerLanded: boolean;
  /** True once any tool has run this turn (gates the pre-tool think label). */
  hasToolActivity: boolean;
};

export const IDLE_WORKING_ACTIVITY: WorkingActivity = {
  answerLanded: false,
  hasToolActivity: false,
};

/**
 * Every field of `WorkingActivity`, for callers that adopt a whole snapshot and
 * need to compare it field-by-field against the live one. Declared alongside
 * the type so adding a field here is the same edit as adding it there.
 */
export const WORKING_ACTIVITY_KEYS = [
  "toolName",
  "toolCallId",
  "statusText",
  "answerLanded",
  "hasToolActivity",
] as const satisfies readonly (keyof WorkingActivity)[];

export type WorkingIndicatorState = {
  /** Whether the indicator should be visible and animating. */
  active: boolean;
  /** Skip the min-visible hold on exit (this turn's answer has landed). */
  exitImmediately: boolean;
  /** Explicit status override; otherwise the indicator picks friendly copy. */
  status?: string;
  toolName?: string;
  toolCallId?: string;
};

/**
 * Derive the indicator props from the turn's send flag + live activity,
 * matching the desktop's `buildInlineWorkingIndicatorProps`:
 *
 *   - hide as soon as the answer lands (unless a tool is still running)
 *   - reflect the active tool's friendly label while a tool is in flight
 *   - show the rotating "thinking" copy in the pre-tool / between-tool gaps
 */
export function buildWorkingIndicatorState({
  sending,
  activity,
}: {
  sending: boolean;
  activity: WorkingActivity;
}): WorkingIndicatorState {
  const answerLanded = activity.answerLanded;
  const isToolActive = Boolean(activity.toolName);
  const hasToolActivity = activity.hasToolActivity;

  // Once the answer lands the indicator steps aside; while a tool runs it
  // stays up; otherwise it covers the pre-tool / between-tool thinking gaps.
  const active = isToolActive || (sending && !answerLanded);

  const isPreToolThinking = sending && !answerLanded && !hasToolActivity;

  const toolName = isToolActive ? activity.toolName : undefined;

  return {
    active,
    exitImmediately: answerLanded,
    status:
      isPreToolThinking || isToolActive ? activity.statusText : undefined,
    toolName,
    toolCallId: isToolActive ? activity.toolCallId : undefined,
  };
}
