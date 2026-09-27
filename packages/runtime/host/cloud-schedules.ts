import { createHash, randomUUID } from "node:crypto";
import type { ConvexClient } from "convex/browser";
import { anyApi } from "convex/server";
import type {
  LocalCronJobCreateInput,
  LocalCronJobRecord,
  LocalCronJobUpdatePatch,
  LocalCronSchedule,
} from "@stella/contracts/scheduling";

/**
 * Reminders and tasks live in Convex with the rest of the owner's schedules,
 * so the phone and the web see them and they still fire while this computer
 * sleeps. A schedule made here names this computer: each fire is offered to
 * it first and runs in the cloud when it can't take it. Watches stay on the
 * local scheduler because their sensor scripts only exist on this machine.
 *
 * Rows are presented as `LocalCronJobRecord`s so the schedule tools, the
 * desktop's schedule chips and the mobile bridge keep one shape.
 */

const api = anyApi.cloud_schedule;

/** Cloud schedule ids; every other id belongs to the local scheduler. */
export const isCloudScheduleId = (id: string): boolean => id.startsWith("sch-");

/** A payload the cloud can carry; watches and legacy scripts stay local. */
export const isCloudSchedulePayload = (
  payload: LocalCronJobCreateInput["payload"],
): boolean => payload.kind === "notify" || payload.kind === "task";

const REMINDER_PROMPT_PREFIX = "Reminder for the user";

/** Same wording as the cloud orchestrator's schedule tool. */
const reminderPrompt = (message: string): string =>
  `${REMINDER_PROMPT_PREFIX} (deliver this exact message to them now, and nothing else): ${message}`;

const reminderMessageOf = (prompt: string): string | null => {
  if (!prompt.startsWith(REMINDER_PROMPT_PREFIX)) return null;
  const separator = prompt.indexOf("): ");
  return separator >= 0 ? prompt.slice(separator + 3) : null;
};

const promptFor = (payload: LocalCronJobCreateInput["payload"]): string => {
  if (payload.kind === "notify") return reminderPrompt(payload.text);
  if (payload.kind === "task") return payload.prompt;
  throw new Error("Only reminders and tasks can be stored in the cloud.");
};

type CloudScheduleRow = {
  scheduleId: string;
  conversationId?: string;
  targetDeviceId?: string;
  prompt: string;
  schedule: string;
  nextRunAt: number;
  lastRunAt?: number;
  status: string;
  description: string;
  lastError?: string;
  lastErrorAt?: number;
  createdAt: number;
  updatedAt: number;
};

const toCronJob = (row: CloudScheduleRow): LocalCronJobRecord => {
  const reminder = reminderMessageOf(row.prompt);
  return {
    id: row.scheduleId,
    conversationId: row.conversationId ?? "",
    name: row.description,
    description: row.description,
    enabled: row.status === "active",
    schedule: JSON.parse(row.schedule) as LocalCronSchedule,
    payload:
      reminder !== null
        ? { kind: "notify", text: reminder }
        : { kind: "task", prompt: row.prompt },
    nextRunAtMs: row.nextRunAt,
    ...(row.lastRunAt !== undefined ? { lastRunAtMs: row.lastRunAt } : {}),
    ...(row.lastError ? { lastStatus: "error", lastError: row.lastError } : {}),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
};

/** Stable per intent, so a retried write replays instead of duplicating. */
const requestIdFor = (...parts: unknown[]): string =>
  `desk-${createHash("sha256")
    .update(JSON.stringify(parts))
    .digest("hex")
    .slice(0, 40)}`;

export type CloudSchedules = ReturnType<typeof createCloudSchedules>;

export const createCloudSchedules = (options: {
  getClient: () => ConvexClient | null;
  getDeviceId: () => string | undefined;
}) => {
  const client = (): ConvexClient => {
    const convex = options.getClient();
    if (!convex) {
      throw new Error("Sign in to Stella to use schedules.");
    }
    return convex;
  };

  const list = async (): Promise<LocalCronJobRecord[]> => {
    const convex = options.getClient();
    if (!convex) return [];
    const rows = (await convex.query(
      api.listMySchedules,
      {},
    )) as CloudScheduleRow[];
    return rows.map(toCronJob);
  };

  const add = async (
    input: LocalCronJobCreateInput,
  ): Promise<LocalCronJobRecord> => {
    const prompt = promptFor(input.payload);
    const deviceId = options.getDeviceId();
    const row = (await client().mutation(api.createMySchedule, {
      // A fresh id per call: two identical schedules are two schedules.
      requestId: `desk-${randomUUID()}`,
      prompt,
      schedule: input.schedule,
      description: input.name || input.description || undefined,
      ...(input.conversationId ? { conversationId: input.conversationId } : {}),
      ...(deviceId ? { targetDeviceId: deviceId } : {}),
    })) as CloudScheduleRow;
    if (input.enabled === false) {
      await update(row.scheduleId, { enabled: false });
    }
    return toCronJob(row);
  };

  const update = async (
    jobId: string,
    patch: LocalCronJobUpdatePatch,
  ): Promise<LocalCronJobRecord | null> => {
    const args = {
      scheduleId: jobId,
      ...(patch.payload ? { prompt: promptFor(patch.payload) } : {}),
      ...(patch.schedule ? { schedule: patch.schedule } : {}),
      ...(patch.name !== undefined || patch.description !== undefined
        ? { description: patch.name ?? patch.description }
        : {}),
      ...(patch.enabled !== undefined
        ? { status: patch.enabled ? "active" : "paused" }
        : {}),
    };
    const row = (await client().mutation(api.updateMySchedule, {
      requestId: requestIdFor("update", args, Date.now()),
      ...args,
    })) as CloudScheduleRow | null;
    return row ? toCronJob(row) : null;
  };

  const remove = async (jobId: string): Promise<boolean> => {
    await client().mutation(api.removeMySchedule, {
      requestId: requestIdFor("remove", jobId),
      scheduleId: jobId,
    });
    return true;
  };

  const runNow = async (jobId: string): Promise<boolean> => {
    await client().mutation(api.runMyScheduleNow, { scheduleId: jobId });
    return true;
  };

  /** Fires `onChange` whenever the owner's schedules change anywhere. */
  const subscribe = (onChange: () => void): (() => void) => {
    const convex = options.getClient();
    if (!convex) return () => {};
    const unsubscribe = convex.onUpdate(api.listMySchedules, {}, () => {
      onChange();
    });
    return () => unsubscribe();
  };

  return { list, add, update, remove, runNow, subscribe };
};
