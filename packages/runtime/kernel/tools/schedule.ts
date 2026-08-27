import {
  getCronTriggerKind,
  type LocalCronJobRecord,
  type LocalCronPayload,
  type LocalCronSchedule,
  type LocalHeartbeatConfigRecord,
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

const heartbeatDetails = (
  change: "updated" | "removed",
  record: LocalHeartbeatConfigRecord,
): ScheduleToolDetails => ({
  schedule: {
    affected:
      change === "removed"
        ? []
        : [
            {
              kind: "heartbeat",
              id: record.id,
              conversationId: record.conversationId,
              name: heartbeatDisplayName(record),
              enabled: record.enabled,
              nextRunAtMs: record.nextRunAtMs,
            },
          ],
    changes: {
      added: [],
      updated: change === "updated" ? [{ kind: "heartbeat", id: record.id }] : [],
      removed: change === "removed" ? [{ kind: "heartbeat", id: record.id }] : [],
    },
  },
});

const heartbeatDisplayName = (record: LocalHeartbeatConfigRecord): string => {
  const prompt = record.prompt?.trim();
  if (!prompt) return "Check-in";
  return prompt.length > 60 ? `${prompt.slice(0, 60)}…` : prompt;
};

const findHeartbeat = async (
  api: ScheduleToolApi,
  id: string,
): Promise<LocalHeartbeatConfigRecord | null> =>
  (await api.listHeartbeats()).find((entry) => entry.id === id) ?? null;

const summarizeHeartbeat = (
  record: LocalHeartbeatConfigRecord,
): Record<string, unknown> => ({
  jobId: record.id,
  triggerKind: "heartbeat",
  enabled: record.enabled,
  intervalMs: record.intervalMs,
  conversationId: record.conversationId,
  nextRunAt: new Date(record.nextRunAtMs).toISOString(),
  ...(record.prompt ? { prompt: record.prompt } : {}),
  ...(record.lastStatus ? { lastStatus: record.lastStatus } : {}),
  ...(record.lastError ? { lastError: record.lastError } : {}),
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
  _context: ToolContext,
): Promise<ToolResult> => {
  const api = requireScheduleApi(scheduleApi);
  const [jobs, heartbeats] = await Promise.all([
    api.listCronJobs(),
    api.listHeartbeats().catch(() => []),
  ]);
  const lines: Record<string, unknown> = {
    entries: jobs.map(summarizeJob),
    ...(heartbeats.length > 0
      ? { heartbeats: heartbeats.map(summarizeHeartbeat) }
      : {}),
  };
  return { result: JSON.stringify(lines, null, 2) };
};

const updateHeartbeat = async (
  api: ScheduleToolApi,
  heartbeat: LocalHeartbeatConfigRecord,
  args: Record<string, unknown>,
): Promise<ToolResult> => {
  for (const field of ["message", "scriptPath", "name"] as const) {
    if (asTrimmedString(args[field])) {
      throw new Error(
        `${field} does not apply to a heartbeat check-in (${heartbeat.id}).`,
      );
    }
  }
  let intervalMs: number | undefined;
  if (args.schedule !== undefined) {
    const schedule = args.schedule as Partial<LocalCronSchedule> | null;
    if (
      !schedule ||
      schedule.kind !== "every" ||
      typeof (schedule as { everyMs?: unknown }).everyMs !== "number"
    ) {
      throw new Error(
        "Heartbeat cadence must be schedule: { kind: 'every', everyMs }.",
      );
    }
    intervalMs = (schedule as { everyMs: number }).everyMs;
  }
  const record = await api.upsertHeartbeat({
    conversationId: heartbeat.conversationId,
    ...(typeof args.enabled === "boolean" ? { enabled: args.enabled } : {}),

    intervalMs: intervalMs ?? heartbeat.intervalMs,
    ...(typeof args.prompt === "string" ? { prompt: args.prompt } : {}),
  });
  return {
    result: `Updated check-in "${heartbeatDisplayName(record)}" (${record.id}): ${record.enabled ? "active" : "paused"}, every ${Math.round(record.intervalMs / 60000)} min; next fire ${new Date(record.nextRunAtMs).toISOString()}.`,
    details: heartbeatDetails("updated", record),
  };
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
    const heartbeat = await findHeartbeat(api, jobId);
    if (heartbeat) {
      return await updateHeartbeat(api, heartbeat, args);
    }
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

    const heartbeat = await findHeartbeat(api, jobId);
    if (heartbeat) {
      const record = await api.upsertHeartbeat({
        conversationId: heartbeat.conversationId,
        enabled: false,
        intervalMs: heartbeat.intervalMs,
      });
      return {
        result: `Turned off check-in "${heartbeatDisplayName(record)}" (${record.id}). Check-ins are disabled rather than deleted; re-enable it later with schedule_update if wanted.`,
        details: heartbeatDetails("removed", record),
      };
    }
    return { error: `No schedule entry found with jobId ${jobId}.` };
  }
  return {
    result: `Removed schedule entry ${jobId}.`,
    details: cronDetails("removed", { id: jobId }),
  };
};
