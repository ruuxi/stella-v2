/// <reference types="vite/client" />

import { convexTest } from "convex-test";
import type { FunctionReference } from "convex/server";
import { describe, expect, it } from "vitest";
import { internal } from "./_generated/api";
import schema from "./schema";
import { createControlPlaneSigner } from "../tests/helpers/control_plane_capability";

const modules = import.meta.glob("./**/*.ts");
const createTest = () => convexTest(schema, modules);

type Receipt = { replayed: boolean; resultJson: string };
type ScheduleArgs = {
  ownerId: string;
  ownerGeneration: string;
  requestId: string;
  now: number;
};

const schedule = (
  internal as unknown as {
    cloud_schedule: {
      createScheduleInternal: FunctionReference<
        "mutation",
        "internal",
        ScheduleArgs & {
          isAnonymous: boolean;
          prompt: string;
          schedule:
            | { kind: "at"; atMs: number }
            | { kind: "every"; everyMs: number; anchorMs?: number }
            | { kind: "cron"; expr: string; tz?: string };
          description?: string;
          conversationId?: string;
        },
        Receipt
      >;
      updateScheduleInternal: FunctionReference<
        "mutation",
        "internal",
        ScheduleArgs & {
          isAnonymous: boolean;
          scheduleId: string;
          prompt?: string;
          schedule?:
            | { kind: "at"; atMs: number }
            | { kind: "every"; everyMs: number; anchorMs?: number }
            | { kind: "cron"; expr: string; tz?: string };
          description?: string;
          status?: string;
        },
        Receipt
      >;
      removeScheduleInternal: FunctionReference<
        "mutation",
        "internal",
        ScheduleArgs & { scheduleId: string },
        Receipt
      >;
    };
  }
).cloud_schedule;

const OWNER = "owner-schedule-receipts";
const GENERATION = "generation-schedule-receipts";

const seedLifecycle = async (t: ReturnType<typeof createTest>) => {
  await t.run(async (ctx) => {
    await ctx.db.insert("cloud_owner_lifecycles", {
      ownerId: OWNER,
      generation: GENERATION,
      state: "open",
      createdAt: 1,
      updatedAt: 1,
    });
  });
};

const createArgs = {
  ownerId: OWNER,
  ownerGeneration: GENERATION,
  isAnonymous: false,
  requestId: "schedule-request-create",
  prompt: "Check the weekly report.",
  description: "Check weekly report",
  schedule: { kind: "every" as const, everyMs: 900_000 },
  conversationId: "conversation-1",
  now: 1_000,
};

describe("cloud schedule mutation receipts", () => {
  it("creates once and exactly replays without re-anchoring", async () => {
    const t = createTest();
    await seedLifecycle(t);
    const first = await t.mutation(schedule.createScheduleInternal, createArgs);
    const replay = await t.mutation(schedule.createScheduleInternal, {
      ...createArgs,
      now: 999_000,
    });
    expect(first.replayed).toBe(false);
    expect(replay).toEqual({ replayed: true, resultJson: first.resultJson });
    const rows = await t.run((ctx) =>
      ctx.db
        .query("cloud_scheduled_turns")
        .withIndex("by_ownerId_and_updatedAt", (q) => q.eq("ownerId", OWNER))
        .collect(),
    );
    expect(rows).toHaveLength(1);
    expect(JSON.parse(first.resultJson)).toMatchObject({
      schedule: { scheduleId: rows[0]?.scheduleId, nextRunAt: 901_000 },
    });
  });

  it("rejects a reused id with different intent", async () => {
    const t = createTest();
    await seedLifecycle(t);
    await t.mutation(schedule.createScheduleInternal, createArgs);
    await expect(
      t.mutation(schedule.createScheduleInternal, {
        ...createArgs,
        prompt: "Different work.",
        now: 2_000,
      }),
    ).rejects.toThrow(/different operation/i);
  });

  it("returns an HTTP conflict for a reused id with different intent", async () => {
    const t = createTest();
    await seedLifecycle(t);
    const previousJwks = process.env.CAPABILITY_JWKS;
    const signer = await createControlPlaneSigner("schedule-receipt-kid");
    process.env.CAPABILITY_JWKS = signer.jwksJson;
    const capability = await signer.mint({
      ownerId: OWNER,
      ownerGeneration: GENERATION,
      turnId: "turn:schedule-receipt",
      conversationId: "conversation:schedule-receipt",
      agentTypes: ["orchestrator"],
    });
    const request = (prompt: string) => ({
      method: "POST",
      headers: {
        authorization: `Bearer ${capability}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        requestId: "schedule-request-http-conflict",
        action: "create",
        prompt,
        schedule: { kind: "every", everyMs: 900_000 },
      }),
    });
    try {
      const first = await t.fetch(
        "/api/cloud/schedule",
        request("First scheduled prompt."),
      );
      expect(first.status).toBe(200);
      const conflict = await t.fetch(
        "/api/cloud/schedule",
        request("Changed scheduled prompt."),
      );
      expect(conflict.status).toBe(409);
      await expect(conflict.json()).resolves.toEqual({
        error:
          "Schedule request id was already used for a different operation.",
      });
    } finally {
      if (previousJwks === undefined) {
        delete process.env.CAPABILITY_JWKS;
      } else {
        process.env.CAPABILITY_JWKS = previousJwks;
      }
    }
  });

  it("replays update and remove outcomes exactly", async () => {
    const t = createTest();
    await seedLifecycle(t);
    const created = await t.mutation(
      schedule.createScheduleInternal,
      createArgs,
    );
    const scheduleId = (
      JSON.parse(created.resultJson) as { schedule: { scheduleId: string } }
    ).schedule.scheduleId;
    const updateArgs = {
      ownerId: OWNER,
      ownerGeneration: GENERATION,
      isAnonymous: false,
      requestId: "schedule-request-update",
      scheduleId,
      status: "active",
      now: 5_000,
    };
    const updated = await t.mutation(
      schedule.updateScheduleInternal,
      updateArgs,
    );
    const updateReplay = await t.mutation(schedule.updateScheduleInternal, {
      ...updateArgs,
      now: 995_000,
    });
    expect(updateReplay).toEqual({
      replayed: true,
      resultJson: updated.resultJson,
    });

    const removeArgs = {
      ownerId: OWNER,
      ownerGeneration: GENERATION,
      requestId: "schedule-request-remove",
      scheduleId,
      now: 6_000,
    };
    const removed = await t.mutation(
      schedule.removeScheduleInternal,
      removeArgs,
    );
    const removeReplay = await t.mutation(schedule.removeScheduleInternal, {
      ...removeArgs,
      now: 7_000,
    });
    expect(JSON.parse(removed.resultJson)).toEqual({ ok: true, removed: true });
    expect(removeReplay).toEqual({
      replayed: true,
      resultJson: removed.resultJson,
    });
  });

  it("cannot replay or resurrect a receipt after owner generation changes", async () => {
    const t = createTest();
    await seedLifecycle(t);
    await t.mutation(schedule.createScheduleInternal, createArgs);
    await t.run(async (ctx) => {
      const lifecycle = await ctx.db
        .query("cloud_owner_lifecycles")
        .withIndex("by_ownerId", (q) => q.eq("ownerId", OWNER))
        .unique();
      await ctx.db.patch(lifecycle!._id, {
        generation: "generation-after-reset",
        updatedAt: 2,
      });
    });
    await expect(
      t.mutation(schedule.createScheduleInternal, {
        ...createArgs,
        now: 2_000,
      }),
    ).rejects.toThrow(/before the account data was reset/i);
    const receipts = await t.run((ctx) =>
      ctx.db
        .query("cloud_schedule_receipts")
        .withIndex("by_ownerId_and_createdAt", (q) => q.eq("ownerId", OWNER))
        .collect(),
    );
    expect(receipts).toHaveLength(1);
  });

  it("requires sign-in to create or activate a schedule", async () => {
    const t = createTest();
    await seedLifecycle(t);
    await expect(
      t.mutation(schedule.createScheduleInternal, {
        ...createArgs,
        isAnonymous: true,
      }),
    ).rejects.toMatchObject({ data: { code: "SIGN_IN_REQUIRED" } });
    const created = await t.mutation(
      schedule.createScheduleInternal,
      createArgs,
    );
    const scheduleId = (
      JSON.parse(created.resultJson) as { schedule: { scheduleId: string } }
    ).schedule.scheduleId;
    await expect(
      t.mutation(schedule.updateScheduleInternal, {
        ownerId: OWNER,
        ownerGeneration: GENERATION,
        isAnonymous: true,
        requestId: "anonymous-schedule-activate",
        scheduleId,
        status: "active",
        now: 2_000,
      }),
    ).rejects.toMatchObject({ data: { code: "SIGN_IN_REQUIRED" } });

    const previousJwks = process.env.CAPABILITY_JWKS;
    const signer = await createControlPlaneSigner("anonymous-schedule-kid");
    process.env.CAPABILITY_JWKS = signer.jwksJson;
    const capability = await signer.mint({
      ownerId: OWNER,
      ownerGeneration: GENERATION,
      turnId: "turn:anonymous-schedule",
      conversationId: "conversation:anonymous-schedule",
      agentTypes: ["orchestrator"],
      modelAudience: "anonymous",
    });
    try {
      const response = await t.fetch("/api/cloud/schedule", {
        method: "POST",
        headers: {
          authorization: `Bearer ${capability}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          requestId: "anonymous-schedule-create",
          action: "create",
          prompt: "Run later",
          schedule: { kind: "every", everyMs: 900_000 },
        }),
      });
      expect(response.status).toBe(403);
      await expect(response.json()).resolves.toEqual({
        error: "sign_in_required",
      });
    } finally {
      if (previousJwks === undefined) {
        delete process.env.CAPABILITY_JWKS;
      } else {
        process.env.CAPABILITY_JWKS = previousJwks;
      }
    }
  });
});
