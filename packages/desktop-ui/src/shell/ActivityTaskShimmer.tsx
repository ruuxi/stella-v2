import type { RefObject } from "react";
import { AGENT_IDS } from "@stella/contracts/agent-runtime";
import type { TaskItem } from "@/features/chat/lib/event-transforms";
import { TextShimmer } from "@/app/chat/TextShimmer";
import { useContinuousAnimationGate } from "@/shared/hooks/use-continuous-animation-gate";
import { useExclusiveAnimation } from "@/shared/hooks/use-exclusive-animation";

export const LEFT_SIDEBAR_ACTIVITY_SHIMMER_GROUP = "left-sidebar-activity";

type ActivityAnimationTask = Pick<TaskItem, "agentType" | "status">;

export const isTopLevelActivityShimmerEligible = (
  task: ActivityAnimationTask,
  isTopLevel: boolean,
): boolean =>
  isTopLevel &&
  task.status === "running" &&
  (task.agentType === AGENT_IDS.GENERAL ||
    task.agentType === AGENT_IDS.MANAGER);

/**
 * Elect one visible top-level General/Manager row. The same owner controls
 * its title shimmer and compact-dot opacity pulse, so rows never stack
 * competing persistent animations.
 */
export function useActivityTaskAnimationOwner(
  task: ActivityAnimationTask,
  isTopLevel: boolean,
  elementRef: RefObject<HTMLElement | null>,
): boolean {
  const eligible = isTopLevelActivityShimmerEligible(task, isTopLevel);
  const gateOpen = useContinuousAnimationGate({
    active: eligible,
    elementRef,
  });
  return useExclusiveAnimation(LEFT_SIDEBAR_ACTIVITY_SHIMMER_GROUP, gateOpen);
}

export function ActivityTaskShimmer({
  text,
  ownsAnimation,
}: {
  text: string;
  ownsAnimation: boolean;
}) {
  return (
    <TextShimmer
      text={text}
      active={ownsAnimation}
      durationMs={2000}
      className="activity-task-shimmer"
      externallyGated
    />
  );
}
