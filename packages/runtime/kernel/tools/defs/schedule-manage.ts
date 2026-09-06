/**
 * Direct scheduling tools — `schedule_add`, `schedule_list`,
 * `schedule_update`, `schedule_remove`.
 *
 * These replace the retired plain-language `Schedule` relay tool and its
 * schedule specialist agent. The orchestrator owns scheduling directly;
 * spawned agents can also reach these tools so a watch-setup agent can
 * register the sensor it just authored and verified.
 *
 * Deferred surface: all four are `demoted`, so they stay out of the
 * always-loaded tool list whenever node_repl is available and are
 * discovered via `tools.$search` / the node_repl demoted-tool catalog,
 * then called as `tools.schedule_add({...})` etc. Agents without
 * node_repl get them as normal direct tools.
 *
 * Three trigger kinds, one local schedule store:
 *  - reminder — plain message at fire time (notification + chat line, no LLM)
 *  - task     — stored intent fires as an orchestrator turn
 *  - watch    — verified deterministic sensor script; diffs and failures
 *               escalate to an orchestrator turn, unchanged runs are silent
 *
 * The model-visible descriptors live in `schedule-manage-def.ts` so the
 * cloud host advertises the byte-identical tools.
 */

import { AGENT_IDS } from "@stella/contracts/agent-runtime";
import {
  handleScheduleAdd,
  handleScheduleList,
  handleScheduleRemove,
  handleScheduleUpdate,
} from "../schedule.js";
import type { ScheduleToolApi, ToolDefinition } from "../types.js";
import {
  SCHEDULE_ADD_TOOL_DESCRIPTOR,
  SCHEDULE_LIST_TOOL_DESCRIPTOR,
  SCHEDULE_REMOVE_TOOL_DESCRIPTOR,
  SCHEDULE_SEARCH_TERMS,
  SCHEDULE_UPDATE_TOOL_DESCRIPTOR,
} from "./schedule-manage-def.js";

export type ScheduleManageOptions = {
  scheduleApi?: ScheduleToolApi;
};

/** Orchestrator owns scheduling; General can register a watch it just built. */
const SCHEDULE_AGENT_TYPES = [
  AGENT_IDS.ORCHESTRATOR,
  AGENT_IDS.GENERAL,
] as const;

export const createScheduleManageTools = (
  options: ScheduleManageOptions,
): ToolDefinition[] => [
  {
    ...SCHEDULE_ADD_TOOL_DESCRIPTOR,
    agentTypes: SCHEDULE_AGENT_TYPES,
    demoted: { searchTerms: SCHEDULE_SEARCH_TERMS },
    execute: async (args, context) => {
      try {
        return await handleScheduleAdd(options.scheduleApi, args, context);
      } catch (error) {
        return { error: (error as Error).message };
      }
    },
  },
  {
    ...SCHEDULE_LIST_TOOL_DESCRIPTOR,
    agentTypes: SCHEDULE_AGENT_TYPES,
    demoted: { searchTerms: SCHEDULE_SEARCH_TERMS },
    execute: async (_args, context) => {
      try {
        return await handleScheduleList(options.scheduleApi, context);
      } catch (error) {
        return { error: (error as Error).message };
      }
    },
  },
  {
    ...SCHEDULE_UPDATE_TOOL_DESCRIPTOR,
    agentTypes: SCHEDULE_AGENT_TYPES,
    demoted: { searchTerms: SCHEDULE_SEARCH_TERMS },
    execute: async (args) => {
      try {
        return await handleScheduleUpdate(options.scheduleApi, args);
      } catch (error) {
        return { error: (error as Error).message };
      }
    },
  },
  {
    ...SCHEDULE_REMOVE_TOOL_DESCRIPTOR,
    agentTypes: SCHEDULE_AGENT_TYPES,
    demoted: { searchTerms: SCHEDULE_SEARCH_TERMS },
    execute: async (args) => {
      try {
        return await handleScheduleRemove(options.scheduleApi, args);
      } catch (error) {
        return { error: (error as Error).message };
      }
    },
  },
];
