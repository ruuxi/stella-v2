import type { TaskLifecycleStatus } from "@stella/contracts/agent-runtime";
import { Icon, type IconName } from "./Icon";

/**
 * The phone's half of desktop's one activity icon vocabulary
 * (`desktop-ui` `AgentLifecycleStatusIcon`): a dotted circle while an agent
 * runs, a tick once it is done, an alert ring when it failed, a bare ring when
 * it was canceled. The names map onto the same Lucide shapes desktop draws, so
 * the two apps read as one product rather than two icon sets.
 */
export const AGENT_LIFECYCLE_STATUS_ICONS = {
  running: "circle-dot",
  completed: "check-circle",
  error: "alert-circle",
  canceled: "circle",
} as const satisfies Record<TaskLifecycleStatus, IconName>;

export function AgentLifecycleStatusIcon({
  status,
  size,
  color,
}: {
  status: TaskLifecycleStatus;
  size: number;
  color: string;
}) {
  return (
    <Icon
      name={AGENT_LIFECYCLE_STATUS_ICONS[status]}
      size={size}
      color={color}
    />
  );
}
