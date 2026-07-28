/**
 * Sub-agent management tools for the orchestrator.
 *
 * Four tools manipulate the durable agent thread surface: `spawn_agent`,
 * `spawn_manager`, `send_input`, and `pause_agent`. Managers receive the
 * existing agent-management tools but cannot create another manager.
 */

import { AGENT_IDS } from "@stella/contracts/agent-runtime";
import {
  handleSendInput,
  handleManagerReport,
  handleSpawnAgent,
  handleSpawnManager,
  type StateContext,
} from "../state.js";
import type { ToolDefinition } from "../types.js";

const ORCHESTRATOR_ONLY: readonly string[] = [AGENT_IDS.ORCHESTRATOR];
const AGENT_MANAGERS: readonly string[] = [
  AGENT_IDS.ORCHESTRATOR,
  AGENT_IDS.MANAGER,
];
const MANAGER_ONLY: readonly string[] = [AGENT_IDS.MANAGER];

export const createAgentTools = (
  stateContext: StateContext,
): ToolDefinition[] => [
  {
    name: "spawn_agent",
    agentTypes: AGENT_MANAGERS,
    description:
      "Spawn a sub-agent for a well-scoped background task. Returns immediately with a durable `thread_id`; the agent is NOT finished yet.",
    parameters: {
      type: "object",
      properties: {
        description: {
          type: "string",
          description:
            "One short, user-friendly sentence summarizing what this work is about. It becomes the thread's name — put the distinguishing words first.",
        },
        prompt: {
          type: "string",
          description:
            "Detailed instructions for the sub-agent. This is the agent's only context.",
        },
        model: {
          type: "string",
          description:
            "Optional model or engine for this one spawn. Omit (or pass `default`) to use the user's configured setup. A model reference (`stella/light`, `stella/max`, `anthropic/...`, `openrouter/<vendor>/<model>`) uses Stella's in-process engine even when Codex or Claude Code is selected globally. Use `codex` / `claude-code` for that engine's configured model, or `codex/<model>` / `claude-code/<model>` to pin one. Closed model/engine forms may add `:low`, `:medium`, `:high`, or `:xhigh` for a per-spawn reasoning override (for example `default:high`, `codex:xhigh`, or `stella/standard:medium`). Open-ended `openrouter/...`, `vercel-ai-gateway/...`, and `stella/<provider>/<model>` references keep colon segments verbatim, so effort suffixes are unavailable on those forms; use `default:<effort>` or an engine-native `codex...` / `claude-code...` form when unambiguous effort control is required. Use ONLY when the user explicitly asked for it or has a recorded standing preference; when in doubt, omit.",
        },
        workspace: {
          type: "string",
          description:
            "Optional. Choose by what the task operates on: `computer` = the user's local machine (files, apps, anything on this device); `drive` = the user's cloud drive (general file/document work with no local dependency); `project:<name>` = a connected dev repo; `stella` = Stella's own interior; `app:<slug>` = an existing mini app. Omit when the work has no file subject — it then runs wherever the orchestrator runs. Ambiguous new-file work defaults to `drive`. Every placement other than `computer` runs in Stella's cloud and reports there, so `model`, `send_input`, and `pause_agent` do not apply to it.",
        },
      },
      required: ["description", "prompt"],
    },
    execute: async (args, context) =>
      handleSpawnAgent(stateContext, args, context),
  },
  {
    name: "report",
    agentTypes: MANAGER_ONLY,
    description:
      "Send a Manager report to the orchestrator. This is the Manager's only upward channel. Use final false only for a genuine blocker that prevents progress and requires outside action, never for status, milestones, or child completions. Use final true exactly once after all work and review/fix rounds are settled, for one consolidated terminal result.",
    parameters: {
      type: "object",
      properties: {
        message: {
          type: "string",
          description: "The update or consolidated final report to deliver.",
        },
        final: {
          type: "boolean",
          default: false,
          description:
            "False is only for a genuine outside-action blocker. True supplies the exactly-once terminal result after all work is settled.",
        },
      },
      required: ["message"],
    },
    execute: async (args, context) =>
      handleManagerReport(stateContext, args, context),
  },
  {
    name: "spawn_manager",
    agentTypes: ORCHESTRATOR_ONLY,
    description:
      "Spawn a manager agent to coordinate multi-agent work, loops, or adopted threads and return a consolidated report. Returns immediately with a durable `thread_id`; the manager is NOT finished yet.",
    parameters: {
      type: "object",
      properties: {
        prompt: {
          type: "string",
          description:
            "Complete instructions for the manager, including the desired process, scope, constraints, and reporting expectations.",
        },
      },
      required: ["prompt"],
    },
    execute: async (args, context) =>
      handleSpawnManager(stateContext, args, context),
  },
  {
    name: "send_input",
    agentTypes: AGENT_MANAGERS,
    description:
      "Send a follow-up message to an existing sub-agent. The agent sees it right away. If you want the message to land after the agent has finished its current work, wait for the [Agent completed] event on that thread first.",
    parameters: {
      type: "object",
      properties: {
        thread_id: {
          type: "string",
          description: "Durable thread id to continue or revise.",
        },
        description: {
          type: "string",
          description:
            "One short, user-friendly sentence summarizing what this work is about.",
        },
        message: {
          type: "string",
          description: "Follow-up instruction to deliver to the agent.",
        },
      },
      required: ["thread_id", "description", "message"],
    },
    execute: async (args, context) =>
      handleSendInput(stateContext, args, context),
  },
  {
    name: "pause_agent",
    agentTypes: AGENT_MANAGERS,
    description:
      "Pause a running sub-agent, or a whole group of related agents at once by passing a grp-… group id. The same thread can be resumed later by calling send_input with its thread_id.",
    parameters: {
      type: "object",
      properties: {
        thread_id: {
          type: "string",
          description:
            "Durable thread id to pause, or a grp-… group id to pause every agent in that group.",
        },
        reason: {
          type: "string",
          description:
            "Optional explanation for why the agent is being paused.",
        },
      },
      required: ["thread_id"],
    },
    execute: async (args, context) =>
      handleSpawnAgent(stateContext, { ...args, action: "cancel" }, context),
  },
];
