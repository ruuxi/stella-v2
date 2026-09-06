import { describe, expect, test } from "bun:test";
import {
  CLOUD_SCHEDULE_MIN_EVERY_MS,
  createCloudScheduleTools,
  reminderPrompt,
} from "../src/cloud-schedule-tools.js";
import { sha256Hex } from "../src/hash.js";

const row = (overrides: Record<string, unknown> = {}) => ({
  scheduleId: "sch-1",
  ownerId: "owner-1",
  conversationId: "conversation-1",
  prompt: "Check the project status.",
  schedule: JSON.stringify({ kind: "every", everyMs: 900_000, anchorMs: 10_000 }),
  nextRunAt: 910_000,
  status: "active",
  description: "Check project status",
  createdAt: 1,
  updatedAt: 1,
  ...overrides,
});

const tools = (post: (path: string, body: unknown, signal?: AbortSignal) => Promise<Response>) => {
  const created = createCloudScheduleTools({
    ownerId: "owner-1",
    ownerGeneration: "generation-1",
    conversationId: "conversation-1",
    post,
  });
  const byName = new Map(created.map((tool) => [tool.name, tool]));
  return {
    add: byName.get("schedule_add")!,
    list: byName.get("schedule_list")!,
    update: byName.get("schedule_update")!,
    remove: byName.get("schedule_remove")!,
    all: created,
  };
};

describe("cloud schedule tools", () => {
  test("advertise the device descriptors, demoted, with the same names", () => {
    const { all } = tools(async () => Response.json({ schedules: [] }));
    expect(all.map((tool) => tool.name)).toEqual([
      "schedule_add",
      "schedule_list",
      "schedule_update",
      "schedule_remove",
    ]);
    for (const tool of all) expect(tool.demoted?.searchTerms).toContain("reminder");
  });

  test("schedule_add replays a lost response with the same generation-fenced request id", async () => {
    const requests: Array<Record<string, unknown>> = [];
    let lose = true;
    const { add } = tools(async (path, body) => {
      expect(path).toBe("/api/cloud/schedule");
      const request = structuredClone(body) as Record<string, unknown>;
      requests.push(request);
      if (lose) {
        lose = false;
        throw new Error("response lost");
      }
      return Response.json({
        ok: true,
        schedule: row(),
        replayed: true,
        schedules: [row()],
      });
    });
    const params = {
      name: "Check project status",
      kind: "task",
      prompt: "Check the project status.",
      schedule: { kind: "every", everyMs: 900_000 },
    };
    const first = await add.execute("tool-call-1", params);
    expect(first.isError).toBe(true);
    const replay = await add.execute("tool-call-1", params);
    expect(replay.isError).not.toBe(true);
    expect(requests).toHaveLength(2);
    expect(requests[0]).toEqual(requests[1]);
    expect(requests[0]?.requestId).toBe(
      await sha256Hex("schedule\0generation-1\0conversation-1\0tool-call-1"),
    );
    expect(requests[0]?.schedule).toEqual({ kind: "every", everyMs: 900_000 });
    expect(requests[0]?.conversationId).toBe("conversation-1");
    expect(replay.content[0]).toMatchObject({
      type: "text",
      text: expect.stringContaining("sch-1"),
    });
    expect(replay.details).toMatchObject({ action: "added", jobId: "sch-1" });
  });

  test("reminders are stored as a delivery prompt and read back as reminders", async () => {
    let created: Record<string, unknown> | undefined;
    const { add, list } = tools(async (_path, body) => {
      const request = body as Record<string, unknown>;
      if (request.action === "create") {
        created = request;
        const stored = row({ prompt: request.prompt, description: request.description });
        return Response.json({ ok: true, schedule: stored, schedules: [stored] });
      }
      return Response.json({
        ok: true,
        schedules: [row({ prompt: reminderPrompt("Drink water"), description: "Hydrate" })],
      });
    });
    await add.execute("call-1", {
      name: "Hydrate",
      kind: "reminder",
      message: "Drink water",
      schedule: { kind: "at", atMs: Date.now() + 60_000 },
    });
    expect(created?.prompt).toBe(reminderPrompt("Drink water"));
    const listed = await list.execute("call-2", {});
    const rows = JSON.parse(listed.content[0]!.type === "text" ? listed.content[0].text : "[]");
    expect(rows[0]).toMatchObject({
      jobId: "sch-1",
      triggerKind: "reminder",
      message: "Drink water",
      enabled: true,
    });
    expect(rows[0]).not.toHaveProperty("prompt");
  });

  test("watch entries and sub-floor intervals are refused before any request", async () => {
    let posted = false;
    const { add } = tools(async () => {
      posted = true;
      return Response.json({ schedules: [] });
    });
    const watch = await add.execute("call-1", {
      name: "Watch",
      kind: "watch",
      scriptPath: "/tmp/check.mjs",
      schedule: { kind: "every", everyMs: 900_000 },
    });
    expect(watch.isError).toBe(true);
    expect(watch.content[0]).toMatchObject({
      text: expect.stringContaining("desktop app"),
    });
    const fast = await add.execute("call-2", {
      name: "Fast",
      kind: "task",
      prompt: "x",
      schedule: { kind: "every", everyMs: CLOUD_SCHEDULE_MIN_EVERY_MS - 1 },
    });
    expect(fast.isError).toBe(true);
    expect(posted).toBe(false);
  });

  test("schedule_update maps enabled to status and schedule_remove reports the removal", async () => {
    const requests: Array<Record<string, unknown>> = [];
    const { update, remove } = tools(async (_path, body) => {
      const request = body as Record<string, unknown>;
      requests.push(request);
      if (request.action === "update") {
        const patched = row({ status: "paused" });
        return Response.json({ ok: true, schedule: patched, schedules: [patched] });
      }
      return Response.json({ ok: true, removed: true, schedules: [] });
    });
    const updated = await update.execute("call-1", { jobId: "sch-1", enabled: false });
    expect(updated.isError).not.toBe(true);
    expect(requests[0]).toMatchObject({ action: "update", scheduleId: "sch-1", status: "paused" });
    expect(updated.details).toMatchObject({ jobId: "sch-1", enabled: false });
    const removed = await remove.execute("call-2", { jobId: "sch-1" });
    expect(removed.isError).not.toBe(true);
    expect(requests[1]).toMatchObject({ action: "remove", scheduleId: "sch-1" });
    expect(removed.details).toMatchObject({ action: "removed", jobId: "sch-1" });
  });
});
