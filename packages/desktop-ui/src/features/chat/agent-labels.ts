import {
  getAgentActivityLabel,
  type AgentId,
} from "@stella/contracts/agent-runtime";

/** Get a friendly label for agent types */
export const getAgentLabel = (agentType: AgentId | string): string =>
  getAgentActivityLabel(agentType) ?? agentType;
