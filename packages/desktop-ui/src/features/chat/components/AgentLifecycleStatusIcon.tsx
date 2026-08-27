import type { ComponentProps } from "react";
import type { TaskLifecycleStatus } from "@stella/contracts/agent-runtime";
import { AlertCircle, CheckCircle2, Circle, CircleDot } from "@/ui/icons";

type StatusIconProps = Omit<ComponentProps<typeof CircleDot>, "ref"> & {
  status: TaskLifecycleStatus;
};

export function AgentLifecycleStatusIcon({
  status,
  ...props
}: StatusIconProps) {
  switch (status) {
    case "running":
      return <CircleDot {...props} />;
    case "completed":
      return <CheckCircle2 {...props} />;
    case "error":
      return <AlertCircle {...props} />;
    case "canceled":
      return <Circle {...props} />;
  }
}
