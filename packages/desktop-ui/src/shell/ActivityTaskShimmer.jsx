import { TextShimmer } from "@/app/chat/TextShimmer";
export const isTopLevelActivityShimmerEligible = (task, isTopLevel) => isTopLevel && task.status === "running";
/** Shimmer every visible, running top-level Activity row. */
export function ActivityTaskShimmer({ task, text, isTopLevel, }) {
    if (!isTopLevelActivityShimmerEligible(task, isTopLevel))
        return text;
    return (<TextShimmer text={text} durationMs={2000} className="activity-task-shimmer"/>);
}
