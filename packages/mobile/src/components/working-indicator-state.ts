export type WorkingActivity = {

  toolName?: string;

  toolCallId?: string;

  statusText?: string;

  answerLanded: boolean;

  hasToolActivity: boolean;
};

export const IDLE_WORKING_ACTIVITY: WorkingActivity = {
  answerLanded: false,
  hasToolActivity: false,
};

export const WORKING_ACTIVITY_KEYS = [
  "toolName",
  "toolCallId",
  "statusText",
  "answerLanded",
  "hasToolActivity",
] as const satisfies readonly (keyof WorkingActivity)[];

export type WorkingIndicatorState = {

  active: boolean;

  exitImmediately: boolean;

  status?: string;
  toolName?: string;
  toolCallId?: string;
};

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
  };
}
