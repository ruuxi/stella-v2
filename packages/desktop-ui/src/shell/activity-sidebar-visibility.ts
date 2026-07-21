import type { ActivityPresence } from "@/features/chat/lib/activity-presence";

export const activityPresenceAllowsSidebar = (
  presence: ActivityPresence,
): boolean => presence !== "empty";

export const shouldAutoOpenActivitySidebar = (
  previous: ActivityPresence,
  next: ActivityPresence,
): boolean => next === "present" && previous !== "present";

export const isActivitySidebarDocked = ({
  presence,
  preferredVisible,
  isFullWindow,
  breakpointHidden,
}: {
  presence: ActivityPresence;
  preferredVisible: boolean;
  isFullWindow: boolean;
  breakpointHidden: boolean;
}): boolean =>
  isFullWindow &&
  preferredVisible &&
  activityPresenceAllowsSidebar(presence) &&
  !breakpointHidden;
