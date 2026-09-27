/// <reference types="vite/client" />

import { convexTest } from "convex-test";
import { makeFunctionReference } from "convex/server";
import { describe, expect, it } from "vitest";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");

const OWNER = "https://issuer.test|schedule-owner";

const listMySchedules = makeFunctionReference<"query">(
  "cloud_schedule:listMySchedules",
);
const createMySchedule = makeFunctionReference<"mutation">(
  "cloud_schedule:createMySchedule",
);
const updateMySchedule = makeFunctionReference<"mutation">(
  "cloud_schedule:updateMySchedule",
);
const removeMySchedule = makeFunctionReference<"mutation">(
  "cloud_schedule:removeMySchedule",
);

const setup = async () => {
  const t = convexTest(schema, modules);
  await t.run(async (ctx) => {
    await ctx.db.insert("cloud_owner_lifecycles", {
      ownerId: OWNER,
      generation: "generation-1",
      state: "open",
      createdAt: 1,
      updatedAt: 1,
    });
  });
  const user = t.withIdentity({
    issuer: "https://issuer.test",
    subject: "schedule-owner",
    tokenIdentifier: OWNER,
  });
  return { t, user };
};

describe("signed-in schedules", () => {
  it("creates a schedule for a computer and lists it", async () => {
    const { user } = await setup();
    const created = (await user.mutation(createMySchedule, {
      requestId: "request-create-1",
      prompt: "Summarise my inbox.",
      schedule: { kind: "every", everyMs: 3_600_000 },
      conversationId: "conversation-1",
      targetDeviceId: "desk-1",
    })) as { scheduleId: string };
    const rows = (await user.query(listMySchedules, {})) as Array<{
      scheduleId: string;
      targetDeviceId?: string;
      status: string;
    }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      scheduleId: created.scheduleId,
      targetDeviceId: "desk-1",
      status: "active",
    });
  });

  it("pauses and removes", async () => {
    const { user } = await setup();
    const created = (await user.mutation(createMySchedule, {
      requestId: "request-create-2",
      prompt: "Check the build.",
      schedule: { kind: "every", everyMs: 3_600_000 },
    })) as { scheduleId: string };
    await user.mutation(updateMySchedule, {
      requestId: "request-pause-2",
      scheduleId: created.scheduleId,
      status: "paused",
    });
    expect(
      ((await user.query(listMySchedules, {})) as Array<{ status: string }>)[0]
        ?.status,
    ).toBe("paused");
    await user.mutation(removeMySchedule, {
      requestId: "request-remove-2",
      scheduleId: created.scheduleId,
    });
    expect(await user.query(listMySchedules, {})).toEqual([]);
  });

  it("keeps a paused schedule listed behind many finished ones", async () => {
    const { t, user } = await setup();
    const created = (await user.mutation(createMySchedule, {
      requestId: "request-create-3",
      prompt: "Weekly review.",
      schedule: { kind: "every", everyMs: 3_600_000 },
    })) as { scheduleId: string };
    await user.mutation(updateMySchedule, {
      requestId: "request-pause-3",
      scheduleId: created.scheduleId,
      status: "paused",
    });
    await t.run(async (ctx) => {
      for (let index = 0; index < 60; index += 1) {
        await ctx.db.insert("cloud_scheduled_turns", {
          scheduleId: `sch-done-${index}`,
          ownerId: OWNER,
          prompt: "Done.",
          schedule: JSON.stringify({ kind: "at", atMs: 1 }),
          nextRunAt: 1,
          status: "done",
          description: "Done",
          createdAt: Date.now() + index,
          updatedAt: Date.now() + index,
        });
      }
    });
    const rows = (await user.query(listMySchedules, {})) as Array<{
      scheduleId: string;
    }>;
    expect(rows.map((row) => row.scheduleId)).toEqual([created.scheduleId]);
  });

  it("shows nothing when signed out", async () => {
    const { t } = await setup();
    expect(await t.query(listMySchedules, {})).toEqual([]);
  });
});
