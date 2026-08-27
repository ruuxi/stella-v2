import { AGENT_IDS } from "@stella/contracts/agent-runtime";
import {
  handleScheduleAdd,
  handleScheduleList,
  handleScheduleRemove,
  handleScheduleUpdate,
} from "../schedule.js";
import type { ScheduleToolApi, ToolDefinition } from "../types.js";

export type ScheduleManageOptions = {
  scheduleApi?: ScheduleToolApi;
};

const SCHEDULE_AGENT_TYPES = [
  AGENT_IDS.ORCHESTRATOR,
  AGENT_IDS.GENERAL,
] as const;

const SCHEDULE_SEARCH_TERMS = [
  "schedule",
  "schedules",
  "scheduling",
  "reminder",
  "remind",
  "recurring",
  "cron",
  "daily",
  "weekly",
  "timer",
  "alarm",
  "watch",
  "watcher",
  "monitor",
  "sensor",
  "notify",
  "automation",
  "task",
] as const;

const SCHEDULE_DEFINITION_PROPERTY = {
  type: "object",
  description:
    "When to fire: { kind: 'at', atMs } for one-shots (epoch ms) | { kind: 'every', everyMs, anchorMs? } | { kind: 'cron', expr, tz? } (5-field cron).",
} as const;

const JOB_ID_PROPERTY = {
  type: "string",
  description:
    "Entry id returned by schedule_add / schedule_list (cron:… for reminders/tasks/watches, heartbeat:… for conversation check-ins).",
} as const;

export const createScheduleManageTools = (
  options: ScheduleManageOptions,
): ToolDefinition[] => [
  {
    name: "schedule_add",
    label: "Add schedule",
    workingText: "Adding schedule",
    agentTypes: SCHEDULE_AGENT_TYPES,
    demoted: { searchTerms: SCHEDULE_SEARCH_TERMS },
    description:
      "Create a scheduled trigger in the local schedule store. Three kinds: " +
      "'reminder' fires a fixed message as a chat line + native notification (no LLM at fire time); " +
      "'task' fires the stored intent prompt as a turn to you (the assistant), which then acts as normal; " +
      "'watch' runs a deterministic check script each cycle — silent when unchanged, and it escalates a detected change or a sensor failure to you as a turn. " +
      "For a watch, first have an agent investigate the target, author the check script (fetch + extract + diff against a `<scriptPath>.state.json` baseline), and dry-run-verify it with ScriptDraft; only pass a scriptPath that ran successfully. Fires work even while the app is closed.",
    parameters: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description: "Short human label shown in lists and notifications.",
        },
        kind: {
          type: "string",
          enum: ["reminder", "task", "watch"],
          description: "Trigger kind.",
        },
        schedule: SCHEDULE_DEFINITION_PROPERTY,
        message: {
          type: "string",
          description:
            "kind='reminder': the exact user-facing text delivered at fire time.",
        },
        prompt: {
          type: "string",
          description:
            "kind='task': the stored intent delivered to the assistant at fire time. Make it self-contained.",
        },
        scriptPath: {
          type: "string",
          description:
            "kind='watch': absolute path of the verified check script (from ScriptDraft). Empty stdout = no change (silent); non-empty stdout = change details; non-zero exit = sensor failure.",
        },
        description: {
          type: "string",
          description: "Optional explanation shown in schedule_list.",
        },
        conversationId: {
          type: "string",
          description:
            "Optional conversation override; defaults to the current conversation.",
        },
        deleteAfterRun: {
          type: "boolean",
          description:
            "Remove the entry after a successful fire. Only meaningful for schedule.kind='at'.",
        },
      },
      required: ["name", "kind", "schedule"],
    },
    execute: async (args, context) => {
      try {
        return await handleScheduleAdd(options.scheduleApi, args, context);
      } catch (error) {
        return { error: (error as Error).message };
      }
    },
  },
  {
    name: "schedule_list",
    label: "List schedules",
    workingText: "Checking schedules",
    agentTypes: SCHEDULE_AGENT_TYPES,
    demoted: { searchTerms: SCHEDULE_SEARCH_TERMS },
    description:
      "List every scheduled trigger (reminders, tasks, watches, plus any legacy entries) and every conversation heartbeat check-in, with ids, schedules, next fire times, and last-run status.",
    parameters: { type: "object", properties: {} },
    execute: async (_args, context) => {
      try {
        return await handleScheduleList(options.scheduleApi, context);
      } catch (error) {
        return { error: (error as Error).message };
      }
    },
  },
  {
    name: "schedule_update",
    label: "Update schedule",
    workingText: "Updating schedule",
    agentTypes: SCHEDULE_AGENT_TYPES,
    demoted: { searchTerms: SCHEDULE_SEARCH_TERMS },
    description:
      "Patch an existing schedule entry: rename, reschedule, enable/disable, or edit its content (message for reminders, prompt for tasks, scriptPath for watches — the entry keeps its kind). Also edits heartbeat check-ins by their heartbeat:… id: enabled pauses/resumes, schedule { kind: 'every', everyMs } changes cadence, prompt changes what each check-in does. Pass only the fields to change.",
    parameters: {
      type: "object",
      properties: {
        jobId: JOB_ID_PROPERTY,
        name: { type: "string", description: "New label." },
        schedule: SCHEDULE_DEFINITION_PROPERTY,
        message: {
          type: "string",
          description: "Reminder entries: replacement message text.",
        },
        prompt: {
          type: "string",
          description: "Task entries: replacement intent prompt.",
        },
        scriptPath: {
          type: "string",
          description:
            "Watch entries: replacement verified check script path (from ScriptDraft).",
        },
        description: { type: "string" },
        enabled: {
          type: "boolean",
          description: "Pause (false) or resume (true) the entry.",
        },
        deleteAfterRun: { type: "boolean" },
      },
      required: ["jobId"],
    },
    execute: async (args) => {
      try {
        return await handleScheduleUpdate(options.scheduleApi, args);
      } catch (error) {
        return { error: (error as Error).message };
      }
    },
  },
  {
    name: "schedule_remove",
    label: "Remove schedule",
    workingText: "Removing schedule",
    agentTypes: SCHEDULE_AGENT_TYPES,
    demoted: { searchTerms: SCHEDULE_SEARCH_TERMS },
    description:
      "Delete a schedule entry (and its check script file, for watches). A heartbeat:… id turns that conversation check-in off (heartbeats are disabled rather than deleted, and can be re-enabled with schedule_update).",
    parameters: {
      type: "object",
      properties: { jobId: JOB_ID_PROPERTY },
      required: ["jobId"],
    },
    execute: async (args) => {
      try {
        return await handleScheduleRemove(options.scheduleApi, args);
      } catch (error) {
        return { error: (error as Error).message };
      }
    },
  },
];
