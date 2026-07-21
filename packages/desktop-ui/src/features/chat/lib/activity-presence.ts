import {
  deriveTopLevelActivityWorkUnits,
  type TaskItem,
} from "@/features/chat/lib/event-transforms";

/**
 * Whether the authoritative Activity projection has finished loading and
 * contains at least one work unit the Activity UI would display.
 */
export type ActivityPresence = "unknown" | "empty" | "present";

export const getActivityPresence = (
  tasks: TaskItem[],
  hasLoaded: boolean,
): ActivityPresence => {
  if (deriveTopLevelActivityWorkUnits(tasks).length > 0) return "present";
  return hasLoaded ? "empty" : "unknown";
};
