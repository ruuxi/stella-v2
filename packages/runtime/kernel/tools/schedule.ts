/**
 * Handlers for the orchestrator's direct scheduling tools
 * (`schedule_add` / `schedule_list` / `schedule_update` / `schedule_remove`).
 *
 * One local schedule store, three trigger kinds:
 *
 *  - **reminder** — `payload.kind === 'notify'`: literal text delivered as
 *    an assistant message + OS notification at fire time. No LLM.
 *  - **task** — `payload.kind === 'task'`: the stored intent fires as an
 *    orchestrator turn, which answers or spawns agents as usual.
 *  - **watch** — `payload.kind === 'watch'`: a verified deterministic check
 *    script runs on the schedule; non-empty stdout (a detected change) or a
 *    failure escalates to an orchestrator turn. Unchanged = silent.
 *
 * Legacy `script` / `agent` payloads written by the retired schedule
 * specialist keep executing unmodified; these handlers surface them as
 * `legacy-script` / `legacy-agent` and allow same-kind edits.
 */

import {
  getCronTriggerKind,
  type LocalCronJobRecord,
  type LocalCronPayload,
  type LocalCronSchedule,
  type ScheduleToolDetails,
} from "@stella/contracts/scheduling";
import type { ScheduleToolApi, ToolContext, ToolResult } from "./types.js";

const requireScheduleApi = (scheduleApi?: ScheduleToolApi): ScheduleToolApi => {
  if (!scheduleApi) {
    throw new Error("Scheduling is not configured on this device.");
  }
  return scheduleApi;
};

const getConversationId = (
  args: Record<string, unknown>,
  context: ToolContext,
): string => {
  const explicit =
    typeof args.conversationId === "string" ? args.conversationId.trim() : "";
  return explicit || context.conversationId;
};

const asTrimmedString = (value: unknown): string =>
  typeof value === "string" ? value.trim() : "";

const cronDetails = (
  change: "added" | "updated" | "removed",
  record: Pick<LocalCronJobRecord, "id"> &
    Partial<
      Pick<LocalCronJobRecord, "conversationId" | "name" | "enabled" | "nextRunAtMs">
    >,
): ScheduleToolDetails => ({
  schedule: {
    affected:
      change === "removed"
        ? []
        : [
            {
              kind: "cron",
              id: record.id,
              conversationId: record.conversationId ?? "",
              name: record.name?.trim() || "Scheduled task",
              enabled: record.enabled ?? true,
              nextRunAtMs: record.nextRunAtMs ?? 0,
            },
          ],
    changes: {
      added: change === "added" ? [{ kind: "cron", id: record.id }] : [],
      updated: change === "updated" ? [{ kind: "cron", id: record.id }] : [],
      removed: change === "removed" ? [{ kind: "cron", id: record.id }] : [],
    },
  },
});

const describeSchedule = (schedule: LocalCronSchedule): string => {
  if (schedule.kind === "at") {
    return `once at ${new Date(schedule.atMs).toISOString()}`;
  }
  if (schedule.kind === "every") {
    return `every ${Math.round(schedule.everyMs / 1000)}s`;
  }
  return `cron "${schedule.expr}"${schedule.tz ? ` (${schedule.tz})` : ""}`;
};

const summarizeJob = (record: LocalCronJobRecord): Record<string, unknown> => ({
  jobId: record.id,
  name: record.name,
  triggerKind: getCronTriggerKind(record.payload),
  schedule: record.schedule,
  enabled: record.enabled,
  conversationId: record.conversationId,
  nextRunAt: new Date(record.nextRunAtMs).toISOString(),
  ...(record.description ? { description: record.description } : {}),
  ...(record.payload.kind === "notify" ? { message: record.payload.text } : {}),
  ...(record.payload.kind === "task" || record.payload.kind === "agent"
    ? { prompt: record.payload.prompt }
    : {}),
  ...(record.payload.kind === "watch" || record.payload.kind === "script"
    ? { scriptPath: record.payload.scriptPath }
    : {}),
  ...(record.lastStatus ? { lastStatus: record.lastStatus } : {}),
  ...(record.lastError ? { lastError: record.lastError } : {}),
  ...(typeof record.lastRunAtMs === "number"
    ? { lastRunAt: new Date(record.lastRunAtMs).toISOString() }
    : {}),
});

/**
 * Map schedule_add's trigger-kind args onto the stored payload shape.
 */
const buildPayloadForAdd = (
  args: Record<string, unknown>,
): LocalCronPayload => {
  const kind = asTrimmedString(args.kind);
  if (kind === "reminder") {
    const message = asTrimmedString(args.message);
    if (!message) {
      throw new Error('kind="reminder" requires message.');
    }
    return { kind: "notify", text: message };
  }
  if (kind === "task") {
    const prompt = asTrimmedString(args.prompt);
    if (!prompt) {
      throw new Error('kind="task" requires prompt.');
    }
    return { kind: "task", prompt };
  }
  if (kind === "watch") {
    const scriptPath = asTrimmedString(args.scriptPath);
    if (!scriptPath) {
      throw new Error(
        'kind="watch" requires scriptPath (author + dry-run the check script with ScriptDraft first).',
      );
    }
    return { kind: "watch", scriptPath };
  }
  throw new Error('kind must be "reminder", "task", or "watch".');
};

/**
 * Same-kind payload patch for schedule_update. The job's stored payload
 * family is preserved: `message` edits a reminder, `prompt` edits a task
 * (or legacy agent job, which stays legacy), `scriptPath` edits a watch
 * (or legacy script job, which stays legacy).
 */
const buildPayloadPatch = (
  current: LocalCronPayload,
  args: Record<string, unknown>,
): LocalCronPayload | null => {
  const message = asTrimmedString(args.message);
  const prompt = asTrimmedString(args.prompt);
  const scriptPath = asTrimmedString(args.scriptPath);
  if (!message && !prompt && !scriptPath) return null;

  if (message) {
    if (current.kind !== "notify") {
      throw new Error(
        `message only applies to reminder entries (this entry is ${getCronTriggerKind(current)}).`,
      );
    }
    return { kind: "notify", text: message };
  }
  if (prompt) {
    if (current.kind === "task") return { kind: "task", prompt };
    if (current.kind === "agent") return { ...current, prompt };
    throw new Error(
      `prompt only applies to task entries (this entry is ${getCronTriggerKind(current)}).`,
    );
  }
  if (current.kind === "watch") return { kind: "watch", scriptPath };
  if (current.kind === "script") return { kind: "script", scriptPath };
  throw new Error(
    `scriptPath only applies to watch entries (this entry is ${getCronTriggerKind(current)}).`,
  );
};

export const handleScheduleAdd = async (
  scheduleApi: ScheduleToolApi | undefined,
  args: Record<string, unknown>,
  context: ToolContext,
): Promise<ToolResult> => {
  const api = requireScheduleApi(scheduleApi);
  const payload = buildPayloadForAdd(args);
  const record = await api.addCronJob({
    name: asTrimmedString(args.name),
    schedule: args.schedule as LocalCronSchedule,
    payload,
    conversationId: getConversationId(args, context),
    ...(asTrimmedString(args.description)
      ? { description: asTrimmedString(args.description) }
      : {}),
    ...(typeof args.enabled === "boolean" ? { enabled: args.enabled } : {}),
    ...(typeof args.deleteAfterRun === "boolean"
      ? { deleteAfterRun: args.deleteAfterRun }
      : {}),
  });
  return {
    result: `Added ${getCronTriggerKind(record.payload)} "${record.name}" (${record.id}), ${describeSchedule(record.schedule)}; next fire ${new Date(record.nextRunAtMs).toISOString()}.`,
    details: cronDetails("added", record),
  };
};

export const handleScheduleList = async (
  scheduleApi: ScheduleToolApi | undefined,
  context: ToolContext,
): Promise<ToolResult> => {
  const api = requireScheduleApi(scheduleApi);
  const [jobs, heartbeat] = await Promise.all([
    api.listCronJobs(),
    api.getHeartbeatConfig(context.conversationId).catch(() => null),
  ]);
  const lines: Record<string, unknown> = {
    entries: jobs.map(summarizeJob),
    ...(heartbeat
      ? {
          conversationHeartbeat: {
            id: heartbeat.id,
            enabled: heartbeat.enabled,
            intervalMs: heartbeat.intervalMs,
            ...(heartbeat.prompt ? { prompt: heartbeat.prompt } : {}),
          },
        }
      : {}),
  };
  return { result: JSON.stringify(lines, null, 2) };
};

export const handleScheduleUpdate = async (
  scheduleApi: ScheduleToolApi | undefined,
  args: Record<string, unknown>,
): Promise<ToolResult> => {
  const api = requireScheduleApi(scheduleApi);
  const jobId = asTrimmedString(args.jobId);
  if (!jobId) {
    throw new Error("jobId is required.");
  }
  const existing = (await api.listCronJobs()).find((job) => job.id === jobId);
  if (!existing) {
    return { error: `No schedule entry found with jobId ${jobId}.` };
  }
  const payloadPatch = buildPayloadPatch(existing.payload, args);
  const record = await api.updateCronJob(jobId, {
    ...(asTrimmedString(args.name) ? { name: asTrimmedString(args.name) } : {}),
    ...(args.schedule !== undefined
      ? { schedule: args.schedule as LocalCronSchedule }
      : {}),
    ...(payloadPatch ? { payload: payloadPatch } : {}),
    ...(typeof args.description === "string"
      ? { description: args.description }
      : {}),
    ...(typeof args.enabled === "boolean" ? { enabled: args.enabled } : {}),
    ...(typeof args.deleteAfterRun === "boolean"
      ? { deleteAfterRun: args.deleteAfterRun }
      : {}),
  });
  if (!record) {
    return { error: `No schedule entry found with jobId ${jobId}.` };
  }
  return {
    result: `Updated ${getCronTriggerKind(record.payload)} "${record.name}" (${record.id}), ${describeSchedule(record.schedule)}; next fire ${new Date(record.nextRunAtMs).toISOString()}.`,
    details: cronDetails("updated", record),
  };
};

export const handleScheduleRemove = async (
  scheduleApi: ScheduleToolApi | undefined,
  args: Record<string, unknown>,
): Promise<ToolResult> => {
  const api = requireScheduleApi(scheduleApi);
  const jobId = asTrimmedString(args.jobId);
  if (!jobId) {
    throw new Error("jobId is required.");
  }
  const removed = await api.removeCronJob(jobId);
  if (!removed) {
    return { error: `No schedule entry found with jobId ${jobId}.` };
  }
  return {
    result: `Removed schedule entry ${jobId}.`,
    details: cronDetails("removed", { id: jobId }),
  };
};
