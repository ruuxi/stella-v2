import type { CloudAgentLifecycleCard } from "@stella/contracts/cloud-agent-lifecycle";
import type {
  CloudAgentControlReceipt,
  CloudAgentToolOutcome,
} from "./cloud-agent-dispatch.js";

export const cloudAgentActivationCard = (args: {
  outcome: CloudAgentToolOutcome;
  parentTurnId: string;
  toolCallId: string;
}): CloudAgentLifecycleCard | null => {
  const { outcome, parentTurnId, toolCallId } = args;
  if (outcome.kind === "pause_agent") return null;
  const control = outcome.control;
  const identity = {
    agentId: control.threadId,
    rootRunId: parentTurnId,
    attemptGeneration: control.attemptGeneration,
  };
  if (outcome.disposition === "steered") {
    return {
      type: "agent-lifecycle",
      eventId: `cloud:${parentTurnId}:${toolCallId}:agent-progress`,
      event: {
        type: "agent-progress",
        payload: {
          ...identity,
          statusText: "Continuing with your latest instruction",
        },
      },
    };
  }
  return {
    type: "agent-lifecycle",
    eventId: `cloud:${parentTurnId}:${toolCallId}:agent-started`,
    event: {
      type: "agent-started",
      payload: {
        ...identity,
        description: control.description ?? "Background task",
        agentType: "general",
        ...(outcome.kind === "send_input" ? { isFollowUp: true } : {}),
      },
    },
  };
};

export const cloudAgentTerminalCard = (
  control: CloudAgentControlReceipt,
): CloudAgentLifecycleCard | null => {
  const payload = {
    agentId: control.threadId,
    attemptGeneration: control.attemptGeneration,
  };
  const card = {
    type: "agent-lifecycle",
    eventId: `cloud:${control.threadId}:${control.attemptGeneration}:terminal`,
  } as const;
  switch (control.status) {
    case "completed":
      return {
        ...card,
        event: {
          type: "agent-completed",
          payload: { ...payload, result: control.lifecycleReport ?? "" },
        },
      };
    case "failed":
    case "canceled":
      return {
        ...card,
        event: {
          type: control.status === "failed" ? "agent-failed" : "agent-canceled",
          payload: {
            ...payload,
            ...(control.lifecycleReport
              ? { error: control.lifecycleReport }
              : {}),
          },
        },
      };
    default:
      return null;
  }
};
