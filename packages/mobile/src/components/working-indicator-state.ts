/**
 * Mobile port of the desktop working-indicator derivation
 * (`desktop/src/features/chat/working-indicator-state.ts`). Turns the live
 * run snapshot — which tool is in flight, whether the turn's answer has
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
   * True once this turn's ANSWER has landed — an assistant message arrived
   * that is not followed by more tool work. Assistant text no longer streams,
   * so the indicator can't hand off on "first chunk": it must stay up for the
   * whole in-flight turn and step aside only when the message the user is
   * waiting for is on screen. A preamble segment (`followedByToolCall`) does
   * NOT set this — more work is still coming.
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
  /** Skip the min-visible hold on exit (the answer is already on screen). */
  exitImmediately: boolean;
  /** Explicit status override; otherwise the indicator picks friendly copy. */
  status?: string;
  toolName?: string;
  toolCallId?: string;
  isReasoning: boolean;
};

/**
 * Derive the indicator props from the turn's send flag + live activity.
 *
 *   - stay up for the whole in-flight turn until this turn's answer lands
 *   - reflect the active tool's friendly label while a tool is in flight
 *   - show the rotating "thinking" copy in the pre-tool / between-tool gaps
 *   - exit without the min-visible hold once the answer message is rendered,
 *     so the indicator never trails a message the user can already read
 */
export function buildWorkingIndicatorState({
  sending,
  activity,
}: {
  sending: boolean;
  activity: WorkingActivity;
}): WorkingIndicatorState {
  const isToolActive = Boolean(activity.toolName);
  const answerLanded = activity.answerLanded;
  const hasToolActivity = activity.hasToolActivity;

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
    isReasoning: !toolName,
  };
}
