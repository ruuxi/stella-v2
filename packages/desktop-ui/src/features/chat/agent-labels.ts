import {
  getAgentActivityLabel,
  type AgentId,
} from "@stella/contracts/agent-runtime";

export const getAgentLabel = (agentType: AgentId | string): string =>
  getAgentActivityLabel(agentType) ?? agentType;
