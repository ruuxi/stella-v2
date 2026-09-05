/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { makeFunctionReference } from "convex/server";
import { describe, expect, it } from "vitest";
import schema from "./schema";
import { homeContextChanged } from "./lib/cloud_home_context_updates";
const modules = import.meta.glob("./**/*.ts");
const owner = { ownerId: "owner-context", ownerGeneration: "gen-1" };
const delivered = makeFunctionReference<"mutation", typeof owner & { revision: number }, null>("cloud_home_context:delivered");
const pending = makeFunctionReference<"query", typeof owner, number | null>("cloud_home_context:pending");
const retry = makeFunctionReference<"mutation", {}, null>("cloud_home_context:retryPending");
describe("context notification debt", () => {
  it("records changes atomically and an old acknowledgement cannot clear a newer change", async () => {
    const t = convexTest(schema, modules);
    await t.run(async ctx => { await homeContextChanged(ctx, owner.ownerId, owner.ownerGeneration); await homeContextChanged(ctx, owner.ownerId, owner.ownerGeneration); });
    expect(await t.query(pending, owner)).toBe(2);
    await t.mutation(delivered, { ...owner, revision: 1 });
    expect(await t.query(pending, owner)).toBe(2);
    await t.mutation(delivered, { ...owner, revision: 2 });
    expect(await t.query(pending, owner)).toBeNull();
  });
  it("the watchdog repairs a lost scheduled action and keeps generations separate", async () => {
    const t = convexTest(schema, modules);
    await t.run(async ctx => {
      await ctx.db.insert("cloud_home_context_updates", { ...owner, revision: 3, deliveredRevision: 1, pending: true, retryAt: 0 });
      await ctx.db.insert("cloud_home_context_updates", { ...owner, ownerGeneration: "gen-2", revision: 1, deliveredRevision: 1, pending: false, retryAt: 0 });
    });
    await t.mutation(retry, {});
    const rows = await t.run(ctx => ctx.db.query("cloud_home_context_updates").withIndex("by_ownerId", q => q.eq("ownerId", owner.ownerId)).take(10));
    expect(rows.find(r => r.ownerGeneration === "gen-1")?.retryAt).toBeGreaterThan(Date.now());
    expect(await t.query(pending, owner)).toBe(3);
    expect(await t.query(pending, { ...owner, ownerGeneration: "gen-2" })).toBeNull();
  });
});
