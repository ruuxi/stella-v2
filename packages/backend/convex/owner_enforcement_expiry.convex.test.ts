/// <reference types="vite/client" />

import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { internal } from "./_generated/api";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");
const HOUR_MS = 60 * 60_000;

const makeTest = () => convexTest(schema, modules);
type T = ReturnType<typeof makeTest>;

const readRow = async (t: T, ownerId: string) =>
  await t.run(
    async (ctx) =>
      await ctx.db
        .query("owner_enforcement")
        .withIndex("by_owner", (q) => q.eq("ownerId", ownerId))
        .unique(),
  );

const expiryJobs = async (t: T) =>
  await t.run(async (ctx) =>
    (await ctx.db.system.query("_scheduled_functions").collect()).filter(
      (job) =>
        job.name.includes("expireOwnerEnforcementInternal") &&
        job.state.kind === "pending",
    ),
  );

const runExpiryJobs = async (t: T) => {
  for (const job of await expiryJobs(t)) {
    await t.mutation(
      internal.owner_enforcement.expireOwnerEnforcementInternal,
      job.args[0] as {
        ownerId: string;
        expectedUpdatedAt: number;
        expectedUntil: number;
      },
    );
  }
};

describe("owner enforcement expiry", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("schedules expiry at until and clears the row when it fires", async () => {
    const t = makeTest();
    const until = Date.now() + HOUR_MS;
    await t.mutation(internal.owner_enforcement.setOwnerEnforcementInternal, {
      ownerId: "owner-a",
      status: "throttled",
      until,
      reason: "risk",
      actor: "risk-cron",
    });
    const jobs = await expiryJobs(t);
    expect(jobs).toHaveLength(1);
    expect(jobs[0].scheduledTime).toBe(until);

    vi.setSystemTime(until);
    await runExpiryJobs(t);
    expect(await readRow(t, "owner-a")).toMatchObject({
      status: "ok",
      actor: "system:expiry",
    });
    expect((await readRow(t, "owner-a"))?.until).toBeUndefined();
  });

  it("does not let an old job clear an extended enforcement", async () => {
    const t = makeTest();
    const start = Date.now();
    await t.mutation(internal.owner_enforcement.setOwnerEnforcementInternal, {
      ownerId: "owner-b",
      status: "challenged",
      until: start + HOUR_MS,
      reason: "risk",
      actor: "risk-cron",
    });
    vi.setSystemTime(start + 1_000);
    await t.mutation(internal.owner_enforcement.setOwnerEnforcementInternal, {
      ownerId: "owner-b",
      status: "suspended",
      until: start + 3 * HOUR_MS,
      reason: "escalated",
      actor: "admin",
    });

    vi.setSystemTime(start + HOUR_MS);
    const [oldJob] = (await expiryJobs(t)).filter(
      (job) =>
        (job.args[0] as { expectedUntil: number }).expectedUntil ===
        start + HOUR_MS,
    );
    await t.mutation(
      internal.owner_enforcement.expireOwnerEnforcementInternal,
      oldJob.args[0] as {
        ownerId: string;
        expectedUpdatedAt: number;
        expectedUntil: number;
      },
    );
    expect(await readRow(t, "owner-b")).toMatchObject({
      status: "suspended",
      until: start + 3 * HOUR_MS,
    });

    vi.setSystemTime(start + 3 * HOUR_MS);
    await runExpiryJobs(t);
    expect(await readRow(t, "owner-b")).toMatchObject({ status: "ok" });
  });

  it("reads stored state without consulting the clock", async () => {
    const t = makeTest();
    const until = Date.now() + HOUR_MS;
    await t.mutation(internal.owner_enforcement.setOwnerEnforcementInternal, {
      ownerId: "owner-c",
      status: "suspended",
      until,
      reason: "abuse",
      actor: "admin",
    });
    // Past `until` but before the expiry job runs, the row is still the truth.
    vi.setSystemTime(until + HOUR_MS);
    const state = await t.query(
      internal.owner_enforcement.getOwnerEnforcementStateInternal,
      { ownerId: "owner-c" },
    );
    expect(state.enforcement).toMatchObject({ status: "suspended", until });
  });

  it("backfill clears past rows, schedules future ones, and is idempotent", async () => {
    const t = makeTest();
    const now = Date.now();
    await t.run(async (ctx) => {
      await ctx.db.insert("owner_enforcement", {
        ownerId: "past",
        status: "throttled",
        until: now - 1,
        reason: "risk",
        actor: "risk-cron",
        updatedAt: now - HOUR_MS,
      });
      await ctx.db.insert("owner_enforcement", {
        ownerId: "future",
        status: "challenged",
        until: now + HOUR_MS,
        reason: "risk",
        actor: "risk-cron",
        updatedAt: now - 1_000,
      });
      await ctx.db.insert("owner_enforcement", {
        ownerId: "indefinite",
        status: "suspended",
        reason: "abuse",
        actor: "admin",
        updatedAt: now - 1_000,
      });
    });

    for (let run = 0; run < 2; run += 1) {
      await t.mutation(
        internal.owner_enforcement.backfillOwnerEnforcementExpiryInternal,
        {},
      );
    }
    expect(await readRow(t, "past")).toMatchObject({ status: "ok" });
    expect(await readRow(t, "future")).toMatchObject({ status: "challenged" });
    expect(await readRow(t, "indefinite")).toMatchObject({
      status: "suspended",
    });
    const jobs = await expiryJobs(t);
    expect(jobs.length).toBeGreaterThan(0);
    expect(
      jobs.every(
        (job) => (job.args[0] as { ownerId: string }).ownerId === "future",
      ),
    ).toBe(true);

    vi.setSystemTime(now + HOUR_MS);
    await runExpiryJobs(t);
    expect(await readRow(t, "future")).toMatchObject({ status: "ok" });
  });
});
