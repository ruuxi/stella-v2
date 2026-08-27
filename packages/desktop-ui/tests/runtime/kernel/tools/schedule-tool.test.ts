import { describe, expect, it } from "vitest";

import {
  handleScheduleAdd,
  handleScheduleList,
  handleScheduleRemove,
  handleScheduleUpdate,
} from "@stella/runtime/kernel/tools/schedule";
import type {
  LocalCronJobCreateInput,
  LocalCronJobRecord,
  LocalCronJobUpdatePatch,
  LocalHeartbeatConfigRecord,
  LocalHeartbeatUpsertInput,
} from "@stella/contracts/scheduling";
import type { ScheduleToolApi, ToolContext } from "@stella/runtime/kernel/tools/types";

const context: ToolContext = {
  conversationId: "c1",
  deviceId: "d1",
  requestId: "r1",
};

const makeApi = (
  seed: LocalCronJobRecord[] = [],
  seedHeartbeats: LocalHeartbeatConfigRecord[] = [],
): ScheduleToolApi & {
  jobs: LocalCronJobRecord[];
  heartbeats: LocalHeartbeatConfigRecord[];
} => {
  const jobs = [...seed];
  const heartbeats = [...seedHeartbeats];
  let counter = 0;
  return {
    jobs,
    heartbeats,
    listCronJobs: async () => jobs.map((job) => ({ ...job })),
    addCronJob: async (input: LocalCronJobCreateInput) => {
      const now = Date.now();
      counter += 1;
      const record: LocalCronJobRecord = {
        id: `cron:test-${counter}`,
        conversationId: input.conversationId,
        name: input.name,
        ...(input.description ? { description: input.description } : {}),
        enabled: input.enabled !== false,
        schedule: input.schedule,
        payload: input.payload,
        ...(typeof input.deleteAfterRun === "boolean"
          ? { deleteAfterRun: input.deleteAfterRun }
          : {}),
        nextRunAtMs: now + 60_000,
        createdAt: now,
        updatedAt: now,
      };
      jobs.push(record);
      return { ...record };
    },
    updateCronJob: async (jobId: string, patch: LocalCronJobUpdatePatch) => {
      const job = jobs.find((entry) => entry.id === jobId);
      if (!job) return null;
      if (patch.name !== undefined) job.name = patch.name;
      if (patch.schedule !== undefined) job.schedule = patch.schedule;
      if (patch.payload !== undefined) job.payload = patch.payload;
      if (patch.enabled !== undefined) job.enabled = patch.enabled;
      if (patch.description !== undefined) job.description = patch.description;
      job.updatedAt = Date.now();
      return { ...job };
    },
    removeCronJob: async (jobId: string) => {
      const index = jobs.findIndex((entry) => entry.id === jobId);
      if (index < 0) return false;
      jobs.splice(index, 1);
      return true;
    },
    runCronJob: async () => null,
    listHeartbeats: async () => heartbeats.map((entry) => ({ ...entry })),
    getHeartbeatConfig: async (conversationId: string) =>
      heartbeats.find((entry) => entry.conversationId === conversationId) ??
      null,
    upsertHeartbeat: async (input: LocalHeartbeatUpsertInput) => {
      const existing = heartbeats.find(
        (entry) => entry.conversationId === input.conversationId,
      );
      if (!existing) throw new Error("heartbeat not found");
      if (input.enabled !== undefined) existing.enabled = input.enabled;
      if (typeof input.intervalMs === "number") {
        existing.intervalMs = input.intervalMs;
      }
      if (input.prompt !== undefined) existing.prompt = input.prompt;
      existing.nextRunAtMs = Date.now() + existing.intervalMs;
      existing.updatedAt = Date.now();
      return { ...existing };
    },
    runHeartbeat: async () => null,
  };
};

const checkinHeartbeat = (): LocalHeartbeatConfigRecord => ({
  id: "heartbeat:hb-1",
  conversationId: "c1",
  enabled: true,
  intervalMs: 30 * 60_000,
  prompt: "Check the build queue",
  nextRunAtMs: Date.now() + 60_000,
  createdAt: 1,
  updatedAt: 1,
});

const reminderJob = (): LocalCronJobRecord => ({
  id: "cron:reminder-1",
  conversationId: "c1",
  name: "Daily: 9 AM gym",
  enabled: true,
  schedule: { kind: "cron", expr: "0 9 * * *" },
  payload: { kind: "notify", text: "9:00 AM — gym time" },
  nextRunAtMs: Date.now() + 60_000,
  createdAt: 1,
  updatedAt: 1,
});

const legacyAgentJob = (): LocalCronJobRecord => ({
  id: "cron:agent-1",
  conversationId: "c1",
  name: "X scan",
  enabled: true,
  schedule: { kind: "every", everyMs: 3_600_000 },
  payload: { kind: "agent", prompt: "scan X", agentType: "general" },
  nextRunAtMs: Date.now() + 60_000,
  createdAt: 1,
  updatedAt: 1,
});

describe("schedule_add", () => {
  it("maps kind=reminder onto a notify payload", async () => {
    const api = makeApi();
    const result = await handleScheduleAdd(
      api,
      {
        name: "Lunch",
        kind: "reminder",
        schedule: { kind: "cron", expr: "0 12 * * *" },
        message: "12:00 PM — lunch time",
      },
      context,
    );
    expect(result.error).toBeUndefined();
    expect(api.jobs[0]?.payload).toEqual({
      kind: "notify",
      text: "12:00 PM — lunch time",
    });
    expect(api.jobs[0]?.conversationId).toBe("c1");
    expect(result.details).toMatchObject({
      schedule: { changes: { added: [{ kind: "cron", id: api.jobs[0]!.id }] } },
    });
    expect(result.result).toContain("reminder");
  });

  it("maps kind=task onto a task payload", async () => {
    const api = makeApi();
    await handleScheduleAdd(
      api,
      {
        name: "Morning brief",
        kind: "task",
        schedule: { kind: "cron", expr: "0 8 * * *" },
        prompt: "Summarize my inbox and calendar for today.",
      },
      context,
    );
    expect(api.jobs[0]?.payload).toEqual({
      kind: "task",
      prompt: "Summarize my inbox and calendar for today.",
    });
  });

  it("maps kind=watch onto a watch payload and requires scriptPath", async () => {
    const api = makeApi();
    await expect(
      handleScheduleAdd(
        api,
        {
          name: "OpenRouter models",
          kind: "watch",
          schedule: { kind: "every", everyMs: 1_800_000 },
        },
        context,
      ),
    ).rejects.toThrow("scriptPath");

    await handleScheduleAdd(
      api,
      {
        name: "OpenRouter models",
        kind: "watch",
        schedule: { kind: "every", everyMs: 1_800_000 },
        scriptPath: "/tmp/schedule-scripts/watch.ts",
      },
      context,
    );
    expect(api.jobs[0]?.payload).toEqual({
      kind: "watch",
      scriptPath: "/tmp/schedule-scripts/watch.ts",
    });
  });

  it("rejects unknown trigger kinds", async () => {
    const api = makeApi();
    await expect(
      handleScheduleAdd(
        api,
        { name: "x", kind: "cron", schedule: { kind: "every", everyMs: 1000 } },
        context,
      ),
    ).rejects.toThrow('kind must be "reminder", "task", or "watch"');
  });
});

describe("schedule_list", () => {
  it("reports trigger kinds including legacy payloads and heartbeats", async () => {
    const api = makeApi([reminderJob(), legacyAgentJob()], [checkinHeartbeat()]);
    const result = await handleScheduleList(api, context);
    const parsed = JSON.parse(result.result as string) as {
      entries: Array<{ jobId: string; triggerKind: string }>;
      heartbeats: Array<{ jobId: string; triggerKind: string; prompt?: string }>;
    };
    expect(parsed.entries.map((entry) => entry.triggerKind)).toEqual([
      "reminder",
      "legacy-agent",
    ]);
    expect(parsed.heartbeats).toEqual([
      expect.objectContaining({
        jobId: "heartbeat:hb-1",
        triggerKind: "heartbeat",
        prompt: "Check the build queue",
      }),
    ]);
  });
});

describe("schedule_update", () => {
  it("edits a reminder's message while preserving its payload kind", async () => {
    const api = makeApi([reminderJob()]);
    const result = await handleScheduleUpdate(api, {
      jobId: "cron:reminder-1",
      message: "9:00 AM — gym, no excuses",
    });
    expect(result.error).toBeUndefined();
    expect(api.jobs[0]?.payload).toEqual({
      kind: "notify",
      text: "9:00 AM — gym, no excuses",
    });
  });

  it("keeps a legacy agent job legacy when its prompt is edited", async () => {
    const api = makeApi([legacyAgentJob()]);
    await handleScheduleUpdate(api, {
      jobId: "cron:agent-1",
      prompt: "scan X for new topics",
    });
    expect(api.jobs[0]?.payload).toEqual({
      kind: "agent",
      prompt: "scan X for new topics",
      agentType: "general",
    });
  });

  it("rejects content fields that do not match the entry's kind", async () => {
    const api = makeApi([reminderJob()]);
    await expect(
      handleScheduleUpdate(api, {
        jobId: "cron:reminder-1",
        scriptPath: "/tmp/nope.ts",
      }),
    ).rejects.toThrow("scriptPath only applies to watch entries");
  });

  it("supports pause/resume via enabled", async () => {
    const api = makeApi([reminderJob()]);
    await handleScheduleUpdate(api, {
      jobId: "cron:reminder-1",
      enabled: false,
    });
    expect(api.jobs[0]?.enabled).toBe(false);
  });

  it("errors on unknown jobId", async () => {
    const api = makeApi();
    const result = await handleScheduleUpdate(api, { jobId: "cron:nope" });
    expect(result.error).toContain("No schedule entry found");
  });
});

describe("heartbeat editing through the schedule tools", () => {
  it("pauses and resumes a check-in via schedule_update enabled", async () => {
    const api = makeApi([], [checkinHeartbeat()]);
    const paused = await handleScheduleUpdate(api, {
      jobId: "heartbeat:hb-1",
      enabled: false,
    });
    expect(paused.error).toBeUndefined();
    expect(api.heartbeats[0]?.enabled).toBe(false);
    expect(paused.details).toMatchObject({
      schedule: {
        changes: { updated: [{ kind: "heartbeat", id: "heartbeat:hb-1" }] },
      },
    });

    await handleScheduleUpdate(api, { jobId: "heartbeat:hb-1", enabled: true });
    expect(api.heartbeats[0]?.enabled).toBe(true);
  });

  it("changes cadence via schedule { kind: 'every' } without clobbering it otherwise", async () => {
    const api = makeApi([], [checkinHeartbeat()]);
    const result = await handleScheduleUpdate(api, {
      jobId: "heartbeat:hb-1",
      schedule: { kind: "every", everyMs: 24 * 60 * 60_000 },
    });
    expect(result.error).toBeUndefined();
    expect(api.heartbeats[0]?.intervalMs).toBe(24 * 60 * 60_000);

    await handleScheduleUpdate(api, {
      jobId: "heartbeat:hb-1",
      prompt: "Check the deploy queue",
    });
    expect(api.heartbeats[0]?.intervalMs).toBe(24 * 60 * 60_000);
    expect(api.heartbeats[0]?.prompt).toBe("Check the deploy queue");
  });

  it("rejects non-interval cadences and cron-only fields for heartbeats", async () => {
    const api = makeApi([], [checkinHeartbeat()]);
    await expect(
      handleScheduleUpdate(api, {
        jobId: "heartbeat:hb-1",
        schedule: { kind: "cron", expr: "0 9 * * *" },
      }),
    ).rejects.toThrow("kind: 'every'");
    await expect(
      handleScheduleUpdate(api, {
        jobId: "heartbeat:hb-1",
        message: "nope",
      }),
    ).rejects.toThrow("does not apply to a heartbeat");
  });

  it("schedule_remove turns a check-in off (reversible disable, matching the UI)", async () => {
    const api = makeApi([], [checkinHeartbeat()]);
    const result = await handleScheduleRemove(api, {
      jobId: "heartbeat:hb-1",
    });
    expect(result.error).toBeUndefined();
    expect(result.result).toContain("Turned off check-in");
    expect(api.heartbeats).toHaveLength(1);
    expect(api.heartbeats[0]?.enabled).toBe(false);
    expect(result.details).toMatchObject({
      schedule: {
        changes: { removed: [{ kind: "heartbeat", id: "heartbeat:hb-1" }] },
      },
    });
  });
});

describe("schedule_remove", () => {
  it("removes an entry and reports the removal", async () => {
    const api = makeApi([reminderJob()]);
    const result = await handleScheduleRemove(api, {
      jobId: "cron:reminder-1",
    });
    expect(result.error).toBeUndefined();
    expect(api.jobs).toHaveLength(0);
    expect(result.details).toMatchObject({
      schedule: {
        changes: { removed: [{ kind: "cron", id: "cron:reminder-1" }] },
      },
    });
  });

  it("errors on unknown jobId", async () => {
    const api = makeApi();
    const result = await handleScheduleRemove(api, { jobId: "cron:nope" });
    expect(result.error).toContain("No schedule entry found");
  });
});
