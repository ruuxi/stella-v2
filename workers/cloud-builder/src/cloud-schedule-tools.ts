/**
 * `schedule_add` / `schedule_list` / `schedule_update` / `schedule_remove`
 * for the cloud orchestrator — the device tools' exact model-visible
 * surface (see `defs/schedule-manage-def.ts`) over the owner's cloud
 * schedule (`/api/cloud/schedule`).
 *
 * The cloud store holds one kind of entry: a prompt that fires as a fresh
 * orchestrator turn. The device's three trigger kinds map onto it:
 *  - task     — the prompt, verbatim
 *  - reminder — a prompt instructing the future turn to deliver the fixed
 *               message; a chat line is the only delivery channel here
 *  - watch    — a device sensor script; not runnable in the cloud
 */

import type { TSchema } from "@sinclair/typebox";
import type { AgentToolResult } from "@stella/runtime/kernel/agent-core/types.js";
import {
  SCHEDULE_ADD_TOOL_DESCRIPTOR,
  SCHEDULE_LIST_TOOL_DESCRIPTOR,
  SCHEDULE_REMOVE_TOOL_DESCRIPTOR,
  SCHEDULE_SEARCH_TERMS,
  SCHEDULE_UPDATE_TOOL_DESCRIPTOR,
  type ScheduleToolDescriptor,
} from "@stella/runtime/kernel/tools/defs/schedule-manage-def.js";
import type { CloudCodeSourceAgentTool } from "./cloud-code-tool.js";
import { sha256Hex } from "./hash.js";

export type CloudScheduleToolContext = Readonly<{
  ownerId: string;
  ownerGeneration: string;
  conversationId: string;
  post: (path: string, body: unknown, signal?: AbortSignal) => Promise<Response>;
}>;

/** The cloud scheduler's floor; nothing can run more often than this. */
export const CLOUD_SCHEDULE_MIN_EVERY_MS = 15 * 60_000;

const REMINDER_PROMPT_PREFIX = "Reminder for the user";

/** How a reminder is stored: a self-contained prompt for the future turn. */
export const reminderPrompt = (message: string): string =>
  `${REMINDER_PROMPT_PREFIX} (deliver this exact message to them now, and nothing else): ${message}`;

const reminderMessageOf = (prompt: string): string | null => {
  if (!prompt.startsWith(REMINDER_PROMPT_PREFIX)) return null;
  const separator = prompt.indexOf("): ");
  return separator >= 0 ? prompt.slice(separator + 3) : null;
};

type ScheduleRow = {
  scheduleId: string;
  conversationId?: string;
  prompt: string;
  schedule: string;
  nextRunAt: number;
  lastRunAt?: number;
  status: string;
  description: string;
  lastError?: string;
  lastErrorAt?: number;
};

const asTrimmedString = (value: unknown): string =>
  typeof value === "string" ? value.trim() : "";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const iso = (value: number | undefined): string | undefined =>
  typeof value === "number" && Number.isFinite(value)
    ? new Date(value).toISOString()
    : undefined;

const parseStoredSchedule = (value: string): Record<string, unknown> => {
  try {
    const parsed = JSON.parse(value) as unknown;
    return isRecord(parsed) ? parsed : { raw: value };
  } catch {
    return { raw: value };
  }
};

const describeSchedule = (schedule: Record<string, unknown>): string => {
  if (schedule.kind === "at" && typeof schedule.atMs === "number") {
    return `once at ${new Date(schedule.atMs).toISOString()}`;
  }
  if (schedule.kind === "every" && typeof schedule.everyMs === "number") {
    return `every ${Math.round(schedule.everyMs / 1000)}s`;
  }
  if (schedule.kind === "cron" && typeof schedule.expr === "string") {
    return `cron "${schedule.expr}"${typeof schedule.tz === "string" && schedule.tz ? ` (${schedule.tz})` : ""}`;
  }
  return "unknown schedule";
};

/** The device `summarizeJob` shape so lists read the same on both hosts. */
const summarizeRow = (row: ScheduleRow): Record<string, unknown> => {
  const message = reminderMessageOf(row.prompt);
  return {
    jobId: row.scheduleId,
    name: row.description || (message ?? row.prompt).slice(0, 60),
    triggerKind: message !== null ? "reminder" : "task",
    schedule: parseStoredSchedule(row.schedule),
    enabled: row.status === "active",
    ...(row.conversationId ? { conversationId: row.conversationId } : {}),
    nextRunAt: iso(row.nextRunAt),
    ...(row.description ? { description: row.description } : {}),
    ...(message !== null ? { message } : { prompt: row.prompt }),
    ...(row.lastError ? { lastStatus: "failed", lastError: row.lastError } : {}),
    ...(iso(row.lastRunAt) ? { lastRunAt: iso(row.lastRunAt) } : {}),
  };
};

/**
 * The device schedule shape, validated the way `normalizeScheduleInput`
 * will on the backend, plus the cloud interval floor so the model hears
 * about it before the request leaves.
 */
const scheduleFromArgs = (value: unknown): Record<string, unknown> => {
  if (!isRecord(value)) throw new Error("schedule must be an object.");
  const kind = asTrimmedString(value.kind);
  if (kind === "at") {
    const atMs = Number(value.atMs);
    if (!Number.isFinite(atMs) || atMs <= 0) {
      throw new Error("schedule.kind='at' requires atMs (epoch ms).");
    }
    if (atMs < Date.now()) throw new Error("schedule.atMs is in the past.");
    return { kind: "at", atMs: Math.floor(atMs) };
  }
  if (kind === "every") {
    const everyMs = Number(value.everyMs);
    if (!Number.isFinite(everyMs) || everyMs <= 0) {
      throw new Error("schedule.kind='every' requires everyMs (> 0).");
    }
    if (everyMs < CLOUD_SCHEDULE_MIN_EVERY_MS) {
      throw new Error(
        `schedule.everyMs must be at least ${CLOUD_SCHEDULE_MIN_EVERY_MS} (${CLOUD_SCHEDULE_MIN_EVERY_MS / 60_000} minutes); cloud schedules cannot run more often than that.`,
      );
    }
    const anchorMs = Number(value.anchorMs);
    return {
      kind: "every",
      everyMs: Math.floor(everyMs),
      ...(Number.isFinite(anchorMs) && anchorMs > 0
        ? { anchorMs: Math.floor(anchorMs) }
        : {}),
    };
  }
  if (kind === "cron") {
    const expr = asTrimmedString(value.expr);
    if (!expr) throw new Error("schedule.kind='cron' requires expr.");
    const tz = asTrimmedString(value.tz);
    return { kind: "cron", expr, ...(tz ? { tz } : {}) };
  }
  throw new Error('schedule.kind must be "at", "every", or "cron".');
};

const result = (
  value: string,
  details: Record<string, unknown>,
): AgentToolResult<unknown> => ({
  content: [{ type: "text", text: value }],
  details,
});

const failure = (message: string): AgentToolResult<unknown> => ({
  content: [{ type: "text", text: message }],
  details: null,
  isError: true,
});

const readJson = async (response: Response): Promise<Record<string, unknown>> => {
  try {
    const payload = (await response.json()) as unknown;
    return isRecord(payload) ? payload : {};
  } catch {
    return {};
  }
};

const rowsOf = (payload: Record<string, unknown>): ScheduleRow[] =>
  (Array.isArray(payload.schedules) ? payload.schedules : []).filter(
    (row): row is ScheduleRow =>
      isRecord(row) &&
      typeof row.scheduleId === "string" &&
      typeof row.prompt === "string",
  );

export const createCloudScheduleTools = (
  context: CloudScheduleToolContext,
): CloudCodeSourceAgentTool[] => {
  const post = async (
    action: "list" | "create" | "update" | "remove",
    body: Record<string, unknown>,
    toolCallId: string,
    signal?: AbortSignal,
  ): Promise<Record<string, unknown>> => {
    const requestId =
      action === "list"
        ? undefined
        : await sha256Hex(
            `schedule\0${context.ownerGeneration}\0${context.conversationId}\0${toolCallId}`,
          );
    const response = await context.post(
      "/api/cloud/schedule",
      {
        ownerId: context.ownerId,
        ownerGeneration: context.ownerGeneration,
        action,
        ...(requestId ? { requestId } : {}),
        ...body,
      },
      signal,
    );
    const payload = await readJson(response);
    if (!response.ok) {
      throw new Error(
        typeof payload.error === "string"
          ? payload.error === "sign_in_required"
            ? "Sign in to Stella with a connected account before scheduling."
            : payload.error
          : `Scheduling failed (${response.status}).`,
      );
    }
    return payload;
  };

  const tool = (
    descriptor: ScheduleToolDescriptor,
    execute: CloudCodeSourceAgentTool["execute"],
  ): CloudCodeSourceAgentTool => ({
    name: descriptor.name,
    label: descriptor.label,
    workingText: descriptor.workingText,
    description: descriptor.description,
    parameters: descriptor.parameters as unknown as TSchema,
    demoted: { searchTerms: SCHEDULE_SEARCH_TERMS },
    execute,
  });

  return [
    tool(SCHEDULE_ADD_TOOL_DESCRIPTOR, async (toolCallId, params, signal) => {
      const args = (params ?? {}) as Record<string, unknown>;
      try {
        const name = asTrimmedString(args.name);
        const kind = asTrimmedString(args.kind);
        let prompt: string;
        if (kind === "reminder") {
          const message = asTrimmedString(args.message);
          if (!message) throw new Error('kind="reminder" requires message.');
          prompt = reminderPrompt(message);
        } else if (kind === "task") {
          prompt = asTrimmedString(args.prompt);
          if (!prompt) throw new Error('kind="task" requires prompt.');
        } else if (kind === "watch") {
          throw new Error(
            'kind="watch" runs a sensor script on the user\'s computer and is only available from the desktop app. In the cloud, schedule a "task" whose prompt tells you what to check and how to report a change.',
          );
        } else {
          throw new Error('kind must be "reminder", "task", or "watch".');
        }
        const schedule = scheduleFromArgs(args.schedule);
        const description = asTrimmedString(args.description) || name;
        const payload = await post(
          "create",
          {
            prompt,
            description,
            conversationId:
              asTrimmedString(args.conversationId) || context.conversationId,
            schedule,
          },
          toolCallId,
          signal,
        );
        // The receipt carries the created row; the list beside it is the
        // owner's full schedule after the change.
        const receiptRow = isRecord(payload.schedule) ? payload.schedule : null;
        const jobId =
          typeof receiptRow?.scheduleId === "string" ? receiptRow.scheduleId : "";
        const record =
          rowsOf(payload).find((row) => row.scheduleId === jobId) ??
          (receiptRow && typeof receiptRow.prompt === "string"
            ? (receiptRow as unknown as ScheduleRow)
            : undefined);
        return result(
          `Added ${kind} "${name}" (${jobId}), ${describeSchedule(schedule)}; next fire ${iso(record?.nextRunAt) ?? "pending"}.`,
          {
            action: "added",
            jobId,
            ...(record ? summarizeRow(record) : {}),
            ...(payload.replayed === true ? { replayed: true } : {}),
          },
        );
      } catch (error) {
        return failure((error as Error).message);
      }
    }),
    tool(SCHEDULE_LIST_TOOL_DESCRIPTOR, async (toolCallId, _params, signal) => {
      try {
        const payload = await post("list", {}, toolCallId, signal);
        const rows = rowsOf(payload).map(summarizeRow);
        return result(JSON.stringify(rows, null, 2), {
          action: "list",
          count: rows.length,
        });
      } catch (error) {
        return failure((error as Error).message);
      }
    }),
    tool(SCHEDULE_UPDATE_TOOL_DESCRIPTOR, async (toolCallId, params, signal) => {
      const args = (params ?? {}) as Record<string, unknown>;
      try {
        const jobId = asTrimmedString(args.jobId);
        if (!jobId) throw new Error("jobId is required.");
        if (jobId.startsWith("heartbeat:")) {
          throw new Error(
            "Conversation heartbeat check-ins run on the desktop app; there is none to edit in the cloud.",
          );
        }
        if (asTrimmedString(args.scriptPath)) {
          throw new Error(
            "scriptPath only applies to watch entries, which run on the desktop app.",
          );
        }
        const message = asTrimmedString(args.message);
        const prompt = asTrimmedString(args.prompt);
        const nextPrompt = message ? reminderPrompt(message) : prompt || undefined;
        const description =
          asTrimmedString(args.description) || asTrimmedString(args.name);
        const status =
          typeof args.enabled === "boolean"
            ? args.enabled
              ? "active"
              : "paused"
            : undefined;
        const schedule =
          args.schedule === undefined ? undefined : scheduleFromArgs(args.schedule);
        if (!nextPrompt && !description && !status && !schedule) {
          throw new Error(
            "Pass at least one field to change: name, schedule, message/prompt, description, or enabled.",
          );
        }
        const payload = await post(
          "update",
          {
            scheduleId: jobId,
            ...(nextPrompt ? { prompt: nextPrompt } : {}),
            ...(description ? { description } : {}),
            ...(status ? { status } : {}),
            ...(schedule ? { schedule } : {}),
          },
          toolCallId,
          signal,
        );
        const record = rowsOf(payload).find((row) => row.scheduleId === jobId);
        if (!record) {
          return failure(`No schedule entry found with jobId ${jobId}.`);
        }
        return result(
          `Updated "${record.description || jobId}" (${jobId}); next fire ${iso(record.nextRunAt) ?? "pending"}.`,
          { action: "updated", jobId, ...summarizeRow(record) },
        );
      } catch (error) {
        return failure((error as Error).message);
      }
    }),
    tool(SCHEDULE_REMOVE_TOOL_DESCRIPTOR, async (toolCallId, params, signal) => {
      const args = (params ?? {}) as Record<string, unknown>;
      try {
        const jobId = asTrimmedString(args.jobId);
        if (!jobId) throw new Error("jobId is required.");
        if (jobId.startsWith("heartbeat:")) {
          throw new Error(
            "Conversation heartbeat check-ins run on the desktop app; there is none to turn off in the cloud.",
          );
        }
        const payload = await post(
          "remove",
          { scheduleId: jobId },
          toolCallId,
          signal,
        );
        const remaining = rowsOf(payload);
        if (remaining.some((row) => row.scheduleId === jobId)) {
          return failure(`Schedule ${jobId} could not be removed.`);
        }
        return result(`Removed schedule ${jobId}.`, {
          action: "removed",
          jobId,
          remaining: remaining.length,
        });
      } catch (error) {
        return failure((error as Error).message);
      }
    }),
  ];
};
