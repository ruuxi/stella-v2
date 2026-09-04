/**
 * Sub-agent management tools.
 *
 * Five tools cover the durable agent thread surface: `spawn_agent`,
 * `send_input`, and `pause_agent` manipulate threads, and `agent_status` is
 * a read-only, non-interrupting status snapshot. Exposure is two-tier and
 * depends on who owns the running thread, not only on its agent type:
 *
 *   - the orchestrator and a top-level (root-spawned) General agent get all
 *     five, so a General agent can run its own subagents;
 *   - a parent-owned General agent — one spawned BY another agent — gets the
 *     same toolset as a top-level General MINUS these five.
 *
 * The second tier is enforced by absence from the catalog rather than by the
 * depth-limit tool error, so a subagent cannot attempt a third level or steer
 * a sibling thread at all. See `getToolCatalog`'s `parentOwned` option.
 */
import { AGENT_IDS } from "@stella/contracts/agent-runtime";
import {
  AGENT_ORCHESTRATION_TOOL_NAMES,
  AGENT_STATUS_TOOL_DESCRIPTOR,
  MERGE_WORKSPACE_TOOL_DESCRIPTOR,
  PAUSE_AGENT_TOOL_DESCRIPTOR,
  SEND_INPUT_TOOL_DESCRIPTOR,
  SPAWN_AGENT_MODEL_DESCRIPTION,
  SPAWN_AGENT_TOOL_DESCRIPTOR,
} from "./agent-orchestration-def.js";
import {
  handleAgentStatus,
  handleMergeWorkspace,
  handleSendInput,
  handleSpawnAgent,
} from "../state.js";
const AGENT_SPAWNERS = [AGENT_IDS.ORCHESTRATOR, AGENT_IDS.GENERAL];
/**
 * Tools withheld from a parent-owned agent. Kept as one exported list so the
 * catalog filter and the execute-time gate can never drift apart.
 */
export { AGENT_ORCHESTRATION_TOOL_NAMES, SPAWN_AGENT_MODEL_DESCRIPTION };
export const createAgentTools = (stateContext) => [
  {
    ...SPAWN_AGENT_TOOL_DESCRIPTOR,
    agentTypes: AGENT_SPAWNERS,
    execute: async (args, context) =>
      handleSpawnAgent(stateContext, args, context),
  },
  {
    ...SEND_INPUT_TOOL_DESCRIPTOR,
    agentTypes: AGENT_SPAWNERS,
    execute: async (args, context) =>
      handleSendInput(stateContext, args, context),
  },
  {
    ...PAUSE_AGENT_TOOL_DESCRIPTOR,
    agentTypes: AGENT_SPAWNERS,
    execute: async (args, context) =>
      handleSpawnAgent(stateContext, { ...args, action: "cancel" }, context),
  },
  {
    ...AGENT_STATUS_TOOL_DESCRIPTOR,
    agentTypes: AGENT_SPAWNERS,
    execute: async (args, context) =>
      handleAgentStatus(stateContext, args, context),
  },
  {
    ...MERGE_WORKSPACE_TOOL_DESCRIPTOR,
    agentTypes: AGENT_SPAWNERS,
    execute: async () => handleMergeWorkspace(),
  },
];
