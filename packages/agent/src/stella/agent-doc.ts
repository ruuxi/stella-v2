/**
 * Which Stella agent a conversation is. The root conversation is the
 * orchestrator and has no document; every agent conversation is created
 * with one. Its prompt, gateway agent type and depth limit follow from it,
 * and its parent link is how an agent's report finds its way up.
 */
import { defineDoc } from "@earendil-works/pi-durable";

export type StellaAgentRole = {
  /** Gateway agent type and prompt: `orchestrator` or `general`. */
  agentType: "orchestrator" | "general";
  /** 0 for the orchestrator, 1 for its agents, 2 for theirs. */
  depth: number;
  /** The short name the parent gave this agent. */
  description?: string;
  /** This agent's thread id in its parent's agent list. */
  threadId?: string;
  /** The conversation that started this agent. */
  parentConversationId?: number;
};

export const StellaAgentDoc = defineDoc<StellaAgentRole>({
  kind: "stella.agent",
  version: 1,
  scope: "conversation",
  history: "latest",
  // A fork is the same agent.
  fork: "current",
  initial: () => ({ agentType: "orchestrator", depth: 0 }),
});

export const ORCHESTRATOR_ROLE: StellaAgentRole = { agentType: "orchestrator", depth: 0 };

/** Agents below the orchestrator, and below them; Stella's `maxAgentDepth`. */
export const MAX_AGENT_DEPTH = 2;
