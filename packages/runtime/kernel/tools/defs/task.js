/**
 * Sub-agent management tools.
 *
 * Four tools cover the durable agent thread surface: `spawn_agent` and
 * `pause_agent` control threads, `send_message` messages any agent or Stella
 * session, and `agent_status` is a read-only view of one thread or of everyone
 * the caller can reach. Exposure is two-tier and depends on who owns the
 * running thread, not only on its agent type:
 *
 *   - the orchestrator and a top-level (root-spawned) General agent get all
 *     four, so a General agent can run its own subagents;
 *   - a parent-owned General agent — one spawned BY another agent — loses the
 *     control tools (`AGENT_CONTROL_TOOL_NAMES`) but keeps `agent_status` and
 *     `send_message`, so it can still see and message the others.
 *
 * The second tier is enforced by absence from the catalog rather than by the
 * depth-limit tool error, so a subagent cannot attempt a third level at all.
 * See `getToolCatalog`'s `parentOwned` option.
 */
import { AGENT_IDS } from "@stella/contracts/agent-runtime";
import {
  AGENT_CONTROL_TOOL_NAMES,
  AGENT_ORCHESTRATION_TOOL_NAMES,
  AGENT_STATUS_TOOL_DESCRIPTOR,
  AGENT_STATUS_TOOL_REPLAY,
  PAUSE_AGENT_TOOL_DESCRIPTOR,
  PAUSE_AGENT_TOOL_REPLAY,
  SEND_MESSAGE_TOOL_DESCRIPTOR,
  SEND_MESSAGE_TOOL_REPLAY,
  SPAWN_AGENT_MODEL_DESCRIPTION,
  SPAWN_AGENT_TOOL_DESCRIPTOR,
} from "./agent-orchestration-def.js";
import {
  handleAgentStatus,
  handleSendMessage,
  handleSpawnAgent,
} from "../state.js";
const AGENT_SPAWNERS = [AGENT_IDS.ORCHESTRATOR, AGENT_IDS.GENERAL];
/**
 * Tools withheld from a parent-owned agent. Kept as one exported list so the
 * catalog filter and the execute-time gate can never drift apart.
 */
export {
  AGENT_CONTROL_TOOL_NAMES,
  AGENT_ORCHESTRATION_TOOL_NAMES,
  SPAWN_AGENT_MODEL_DESCRIPTION,
};
export const createAgentTools = (stateContext) => [
  {
    ...SPAWN_AGENT_TOOL_DESCRIPTOR,
    // A local spawn mints a random thread key, so a rerun is a second agent.
    replay: /** @type {const} */ ("unsafe"),
    agentTypes: AGENT_SPAWNERS,
    execute: async (args, context) =>
      handleSpawnAgent(stateContext, args, context),
  },
  {
    ...SEND_MESSAGE_TOOL_DESCRIPTOR,
    replay: SEND_MESSAGE_TOOL_REPLAY,
    agentTypes: AGENT_SPAWNERS,
    execute: async (args, context) =>
      handleSendMessage(stateContext, args, context),
  },
  {
    ...PAUSE_AGENT_TOOL_DESCRIPTOR,
    replay: PAUSE_AGENT_TOOL_REPLAY,
    agentTypes: AGENT_SPAWNERS,
    execute: async (args, context) =>
      handleSpawnAgent(stateContext, { ...args, action: "cancel" }, context),
  },
  {
    ...AGENT_STATUS_TOOL_DESCRIPTOR,
    replay: AGENT_STATUS_TOOL_REPLAY,
    agentTypes: AGENT_SPAWNERS,
    execute: async (args, context) =>
      handleAgentStatus(stateContext, args, context),
  },
];
