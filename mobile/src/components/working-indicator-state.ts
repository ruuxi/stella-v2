/**
 * Mobile port of the desktop working-indicator derivation
 * (`desktop/src/features/chat/working-indicator-state.ts`). Turns the live
 * run snapshot — which tool is in flight, whether answer text has started
 * streaming — into the props the native `WorkingIndicator` consumes, so the
 * mobile indicator mirrors the desktop's show/hide and labelling behaviour
 * instead of sitting on a single static "Thinking" string.
 */

/**
 * Live snapshot of the in-flight run, folded together from the bridge's agent
 * events (tool-start / tool-end / status / stream) the same way the desktop
 * streaming store does.
 */
export type WorkingActivity = {
  /** The orchestrator tool currently in flight, if any. */
  toolName?: string;
  /** Stable id of that tool call; seeds the friendly label so it doesn't
   * churn on every re-render. */
  toolCallId?: string;
  /** Run-level status text (wake copy, compaction, raw tool status, …). */
  statusText?: string;
  /** True once the assistant has begun streaming answer text. */
  isStreamingText: boolean;
  /** True once any tool has run this turn (gates the pre-tool think label). */
  hasToolActivity: boolean;
};

export const IDLE_WORKING_ACTIVITY: WorkingActivity = {
  isStreamingText: false,
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
  "isStreamingText",
  "hasToolActivity",
] as const satisfies readonly (keyof WorkingActivity)[];

export type WorkingIndicatorState = {
  /** Whether the indicator should be visible and animating. */
  active: boolean;
  /** Skip the min-visible hold on exit (answer text has started streaming). */
  exitImmediately: boolean;
  /** Explicit status override; otherwise the indicator picks friendly copy. */
  status?: string;
  toolName?: string;
  toolCallId?: string;
  isReasoning: boolean;
};

/**
 * Derive the indicator props from the turn's send flag + live activity,
 * matching the desktop's `buildInlineWorkingIndicatorProps`:
 *
 *   - hide as soon as answer text streams (unless a tool is still running)
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
  const isStreaming = sending;
  const isStreamingResponseText = activity.isStreamingText;
  const isToolActive = Boolean(activity.toolName);
  const hasToolActivity = activity.hasToolActivity;

  // Once answer text streams the indicator steps aside; while a tool runs it
  // stays up; otherwise it covers the pre-tool / between-tool thinking gaps.
  const active = isToolActive || (isStreaming && !isStreamingResponseText);

  const isPreToolThinking =
    isStreaming && !isStreamingResponseText && !hasToolActivity;

  const toolName = isToolActive ? activity.toolName : undefined;

  return {
    active,
    exitImmediately: isStreamingResponseText,
    status:
      isPreToolThinking || isToolActive ? activity.statusText : undefined,
    toolName,
    toolCallId: isToolActive ? activity.toolCallId : undefined,
    isReasoning: !toolName,
  };
}
