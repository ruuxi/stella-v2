import { createHash, randomUUID } from "node:crypto";
import { Effect } from "effect";
import type { BackendClient } from "@stella/contracts/backend/client";
import type { ScheduleRow } from "@stella/contracts/backend/schedules";
import type {
  LocalCronJobCreateInput,
  LocalCronJobRecord,
  LocalCronJobUpdatePatch,
  LocalCronSchedule,
} from "@stella/contracts/scheduling";

/**
 * Reminders and tasks live in the owner's object on the backend worker with
 * the rest of the owner's schedules, so the phone and the web see them and
 * they still fire while this computer sleeps. A schedule made here names this
 * computer: each fire is offered to it first and runs in the cloud when it
 * can't take it. Watches stay on the local scheduler because their sensor
 * scripts only exist on this machine.
 *
 * Rows are presented as `LocalCronJobRecord`s so the schedule tools, the
 * desktop's schedule chips and the mobile bridge keep one shape.
 */

/** Cloud schedule ids; every other id belongs to the local scheduler. */
export const isCloudScheduleId = (id: string): boolean => id.startsWith("sch-");

/** A payload the cloud can carry; watches and legacy scripts stay local. */
export const isCloudSchedulePayload = (
  payload: LocalCronJobCreateInput["payload"],
): boolean => payload.kind === "notify" || payload.kind === "task";

const REMINDER_PROMPT_PREFIX = "Reminder for the user";
const LIST_TIMEOUT_MS = 15_000;

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

const toCronJob = (row: ScheduleRow): LocalCronJobRecord => {
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

/**
 * The current value of the live list. Shares the client's subscription when
 * one is open, so it answers at once while `subscribe` is following.
 */
const readSchedules = async (client: BackendClient): Promise<ScheduleRow[]> => {
  let unsubscribe: (() => void) | undefined;
  try {
    return await Effect.runPromise(
      Effect.callback<ScheduleRow[], Error>((resume) => {
        unsubscribe = client.watch(
          "schedules.list",
          {},
          (rows) => resume(Effect.succeed(rows)),
          (error) => resume(Effect.fail(error)),
        );
      }).pipe(
        Effect.timeoutOrElse({
          duration: LIST_TIMEOUT_MS,
          orElse: () => Effect.fail(new Error("Schedules took too long to load.")),
        }),
      ),
    );
  } finally {
    unsubscribe?.();
  }
};

export type CloudSchedules = ReturnType<typeof createCloudSchedules>;

export const createCloudSchedules = (options: {
  /** The backend client while signed in; null when signed out. */
  getClient: () => BackendClient | null;
  getDeviceId: () => string | undefined;
}) => {
  const client = (): BackendClient => {
    const backend = options.getClient();
    if (!backend) {
      throw new Error("Sign in to Stella to use schedules.");
    }
    return backend;
  };

  const list = async (): Promise<LocalCronJobRecord[]> => {
    const backend = options.getClient();
    if (!backend) return [];
    return (await readSchedules(backend)).map(toCronJob);
  };

  const add = async (
    input: LocalCronJobCreateInput,
  ): Promise<LocalCronJobRecord> => {
    const prompt = promptFor(input.payload);
    const deviceId = options.getDeviceId();
    const description = input.name || input.description;
    const row = await client().call("schedules.create", {
      // A fresh id per call: two identical schedules are two schedules.
      requestId: `desk-${randomUUID()}`,
      prompt,
      schedule: input.schedule,
      ...(description ? { description } : {}),
      ...(input.conversationId ? { conversationId: input.conversationId } : {}),
      ...(deviceId ? { targetDeviceId: deviceId } : {}),
    });
    if (input.enabled === false) {
      return (await update(row.scheduleId, { enabled: false })) ?? toCronJob(row);
    }
    return toCronJob(row);
  };

  const update = async (
    jobId: string,
    patch: LocalCronJobUpdatePatch,
  ): Promise<LocalCronJobRecord | null> => {
    const description =
      patch.name !== undefined || patch.description !== undefined
        ? (patch.name ?? patch.description)
        : undefined;
    const args = {
      scheduleId: jobId,
      ...(patch.payload ? { prompt: promptFor(patch.payload) } : {}),
      ...(patch.schedule ? { schedule: patch.schedule } : {}),
      ...(description !== undefined ? { description } : {}),
      ...(patch.enabled !== undefined
        ? { status: patch.enabled ? ("active" as const) : ("paused" as const) }
        : {}),
    };
    const row = await client().call("schedules.update", {
      requestId: requestIdFor("update", args, Date.now()),
      ...args,
    });
    return toCronJob(row);
  };

  const remove = async (jobId: string): Promise<boolean> => {
    await client().call("schedules.remove", {
      requestId: requestIdFor("remove", jobId),
      scheduleId: jobId,
    });
    return true;
  };

  const runNow = async (jobId: string): Promise<boolean> => {
    await client().call("schedules.runNow", { scheduleId: jobId });
    return true;
  };

  /** Fires `onChange` whenever the owner's schedules change anywhere. */
  const subscribe = (onChange: () => void): (() => void) => {
    const backend = options.getClient();
    if (!backend) return () => {};
    return backend.watch("schedules.list", {}, () => {
      onChange();
    });
  };

  return { list, add, update, remove, runNow, subscribe };
};
