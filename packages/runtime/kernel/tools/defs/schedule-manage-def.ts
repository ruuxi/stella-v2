/**
 * The scheduling tools' model-visible surface — `schedule_add`,
 * `schedule_list`, `schedule_update`, `schedule_remove` — split from the
 * executable definitions so workerd hosts advertise the byte-identical
 * tools. The device host executes them against the local schedule store;
 * the cloud Durable Object against the owner's cloud schedule.
 */

export const SCHEDULE_ADD_TOOL_NAME = "schedule_add";
export const SCHEDULE_LIST_TOOL_NAME = "schedule_list";
export const SCHEDULE_UPDATE_TOOL_NAME = "schedule_update";
export const SCHEDULE_REMOVE_TOOL_NAME = "schedule_remove";

export const SCHEDULE_TOOL_NAMES = [
  SCHEDULE_ADD_TOOL_NAME,
  SCHEDULE_LIST_TOOL_NAME,
  SCHEDULE_UPDATE_TOOL_NAME,
  SCHEDULE_REMOVE_TOOL_NAME,
] as const;

export const SCHEDULE_SEARCH_TERMS = [
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

export const SCHEDULE_DEFINITION_PROPERTY = {
  description:
    "When to fire: { kind: 'at', atMs } for one-shots (epoch ms) | { kind: 'every', everyMs, anchorMs? } | { kind: 'cron', expr, tz? } (5-field cron).",
  oneOf: [
    {
      type: "object",
      additionalProperties: false,
      required: ["kind", "atMs"],
      properties: {
        kind: {
          type: "string",
          const: "at",
          description: "Run once at an absolute time.",
        },
        atMs: {
          type: "number",
          exclusiveMinimum: 0,
          description: "Absolute Unix epoch timestamp in milliseconds.",
        },
      },
    },
    {
      type: "object",
      additionalProperties: false,
      required: ["kind", "everyMs"],
      properties: {
        kind: {
          type: "string",
          const: "every",
          description: "Run repeatedly at a fixed interval.",
        },
        everyMs: {
          type: "number",
          exclusiveMinimum: 0,
          description: "Positive repeat interval in milliseconds.",
        },
        anchorMs: {
          type: "number",
          description:
            "Optional Unix epoch timestamp used to anchor the interval cadence.",
        },
      },
    },
    {
      type: "object",
      additionalProperties: false,
      required: ["kind", "expr"],
      properties: {
        kind: {
          type: "string",
          const: "cron",
          description: "Run on a cron expression.",
        },
        expr: {
          type: "string",
          minLength: 1,
          description: "Five-field cron expression accepted by the scheduler.",
        },
        tz: {
          type: "string",
          minLength: 1,
          description:
            "Optional IANA time-zone name; omitted uses the scheduler default.",
        },
      },
    },
  ],
} as const;

export const SCHEDULE_JOB_ID_PROPERTY = {
  type: "string",
  description:
    "Entry id returned by schedule_add / schedule_list (cron:… for reminders/tasks/watches, heartbeat:… for conversation check-ins).",
} as const;

export type ScheduleToolDescriptor = {
  name: (typeof SCHEDULE_TOOL_NAMES)[number];
  label: string;
  workingText: string;
  description: string;
  parameters: Record<string, unknown>;
};

export const SCHEDULE_ADD_TOOL_DESCRIPTOR: ScheduleToolDescriptor = {
  name: SCHEDULE_ADD_TOOL_NAME,
  label: "Add schedule",
  workingText: "Adding schedule",
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
};

export const SCHEDULE_LIST_TOOL_DESCRIPTOR: ScheduleToolDescriptor = {
  name: SCHEDULE_LIST_TOOL_NAME,
  label: "List schedules",
  workingText: "Checking schedules",
  description:
    "List every scheduled trigger (reminders, tasks, watches, plus any legacy entries) and every conversation heartbeat check-in, with ids, schedules, next fire times, and last-run status.",
  parameters: { type: "object", properties: {} },
};

export const SCHEDULE_UPDATE_TOOL_DESCRIPTOR: ScheduleToolDescriptor = {
  name: SCHEDULE_UPDATE_TOOL_NAME,
  label: "Update schedule",
  workingText: "Updating schedule",
  description:
    "Patch an existing schedule entry: rename, reschedule, enable/disable, or edit its content (message for reminders, prompt for tasks, scriptPath for watches — the entry keeps its kind). Also edits heartbeat check-ins by their heartbeat:… id: enabled pauses/resumes, schedule { kind: 'every', everyMs } changes cadence, prompt changes what each check-in does. Pass only the fields to change.",
  parameters: {
    type: "object",
    properties: {
      jobId: SCHEDULE_JOB_ID_PROPERTY,
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
};

export const SCHEDULE_REMOVE_TOOL_DESCRIPTOR: ScheduleToolDescriptor = {
  name: SCHEDULE_REMOVE_TOOL_NAME,
  label: "Remove schedule",
  workingText: "Removing schedule",
  description:
    "Delete a schedule entry (and its check script file, for watches). A heartbeat:… id turns that conversation check-in off (heartbeats are disabled rather than deleted, and can be re-enabled with schedule_update).",
  parameters: {
    type: "object",
    properties: { jobId: SCHEDULE_JOB_ID_PROPERTY },
    required: ["jobId"],
  },
};

export const SCHEDULE_TOOL_DESCRIPTORS = [
  SCHEDULE_ADD_TOOL_DESCRIPTOR,
  SCHEDULE_LIST_TOOL_DESCRIPTOR,
  SCHEDULE_UPDATE_TOOL_DESCRIPTOR,
  SCHEDULE_REMOVE_TOOL_DESCRIPTOR,
] as const;
