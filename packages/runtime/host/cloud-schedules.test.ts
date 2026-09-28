import { describe, expect, test } from "bun:test";
import { getFunctionName } from "convex/server";
import {
  createCloudSchedules,
  isCloudScheduleId,
  isCloudSchedulePayload,
} from "./cloud-schedules.js";

const row = {
  scheduleId: "sch-abc",
  conversationId: "conversation-1",
  targetDeviceId: "desk-1",
  prompt:
    "Reminder for the user (deliver this exact message to them now, and nothing else): Stretch",
  schedule: JSON.stringify({ kind: "every", everyMs: 3_600_000 }),
  nextRunAt: 5_000,
  status: "active",
  description: "Stretch",
  createdAt: 1,
  updatedAt: 2,
};

const fakeClient = () => {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const client = {
    query: async (ref: unknown, args: Record<string, unknown>) => {
      calls.push({ name: getFunctionName(ref as never), args });
      return [row];
    },
    mutation: async (ref: unknown, args: Record<string, unknown>) => {
      calls.push({ name: getFunctionName(ref as never), args });
      return row;
    },
  };
  return { client, calls };
};

describe("cloud schedules on the desktop", () => {
  test("routes reminders and tasks to the cloud and keeps watches local", () => {
    expect(isCloudSchedulePayload({ kind: "notify", text: "hi" })).toBe(true);
    expect(isCloudSchedulePayload({ kind: "task", prompt: "go" })).toBe(true);
    expect(
      isCloudSchedulePayload({ kind: "watch", scriptPath: "/tmp/x.ts" }),
    ).toBe(false);
    expect(isCloudScheduleId("sch-abc")).toBe(true);
    expect(isCloudScheduleId("cron-123")).toBe(false);
  });

  test("creates a schedule that names this computer", async () => {
    const { client, calls } = fakeClient();
    const schedules = createCloudSchedules({
      getClient: () => client as never,
      getDeviceId: () => "desk-1",
    });
    const job = await schedules.add({
      name: "Stretch",
      conversationId: "conversation-1",
      schedule: { kind: "every", everyMs: 3_600_000 },
      payload: { kind: "notify", text: "Stretch" },
    });
    expect(calls[0]).toMatchObject({
      name: "cloud_schedule:createMySchedule",
      args: {
        targetDeviceId: "desk-1",
        conversationId: "conversation-1",
        description: "Stretch",
      },
    });
    expect(String(calls[0]?.args.prompt)).toContain("Stretch");
    expect(job).toMatchObject({
      id: "sch-abc",
      enabled: true,
      payload: { kind: "notify", text: "Stretch" },
      nextRunAtMs: 5_000,
    });
  });

  test("pausing maps to the paused status", async () => {
    const { client, calls } = fakeClient();
    const schedules = createCloudSchedules({
      getClient: () => client as never,
      getDeviceId: () => undefined,
    });
    await schedules.update("sch-abc", { enabled: false });
    expect(calls[0]).toMatchObject({
      name: "cloud_schedule:updateMySchedule",
      args: { scheduleId: "sch-abc", status: "paused" },
    });
  });

  test("lists nothing while signed out", async () => {
    const schedules = createCloudSchedules({
      getClient: () => null,
      getDeviceId: () => undefined,
    });
    expect(await schedules.list()).toEqual([]);
  });
});
