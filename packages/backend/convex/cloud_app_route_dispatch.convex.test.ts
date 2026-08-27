/// <reference types="vite/client" />

import { convexTest } from "convex-test";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { internal } from "./_generated/api";
import { CLOUD_APP_ROUTE_MODEL_BILLING_POLICY } from "./cloud_apps";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");
const OWNER_ID = "cloud-app-route-owner";
const OWNER_GENERATION = "cloud-app-route-generation";
const APP_ID = "cloud-app-route-app";
const TURN_ID = "cloud-app-route-turn";

beforeAll(() => {
  process.env.ANTHROPIC_API_KEY = "test-anthropic-key";
});

afterEach(() => {
  vi.restoreAllMocks();
});

const createTest = async () => {
  const t = convexTest(schema, modules);
  await t.run(async (ctx) => {
    await ctx.db.insert("cloud_owner_lifecycles", {
      ownerId: OWNER_ID,
      generation: OWNER_GENERATION,
      state: "open",
      createdAt: 1,
      updatedAt: 1,
    });
    await ctx.db.insert("cloud_apps", {
      appId: APP_ID,
      ownerId: OWNER_ID,
      slug: "route-app",
      title: "Route App",
      status: "active",
      createdAt: 1,
      updatedAt: 1,
    });
    await ctx.db.insert("agent_turns", {
      turnId: TURN_ID,
      sessionId: "cloud-app-route-session",
      ownerId: OWNER_ID,
      appId: APP_ID,
      prompt: "Add my reading habit.",
      status: "running",
      createdAt: 1,
      updatedAt: 1,
    });
    const manifestJson = JSON.stringify([
      {
        name: "addHabit",
        description: "Add a habit",
        args: [
          {
            name: "name",
            type: "string",
            required: true,
          },
        ],
      },
    ]);
    await ctx.db.insert("cloud_app_operations", {
      appId: APP_ID,
      ownerId: OWNER_ID,
      manifestJson,
      sizeBytes: new TextEncoder().encode(manifestJson).byteLength,
      updatedAt: 1,
    });
  });
  return t;
};

const routeArgs = {
  ownerId: OWNER_ID,
  ownerGeneration: OWNER_GENERATION,
  conversationId: "cloud-app-route-conversation",
  appId: APP_ID,
  turnId: TURN_ID,
  sessionId: "cloud-app-route-session",
  prompt: "Add my reading habit.",
  turnToken: "cloud-app-route-token",
  autoActivate: true,
};

const managedLeaseState = async (t: Awaited<ReturnType<typeof createTest>>) =>
  await t.run(async (ctx) => ({
    dispatches: await ctx.db
      .query("billing_managed_dispatch_leases")
      .withIndex("by_ownerId_and_createdAt", (q) => q.eq("ownerId", OWNER_ID))
      .collect(),
    executions: await ctx.db
      .query("billing_managed_execution_leases")
      .withIndex("by_ownerId_and_createdAt", (q) => q.eq("ownerId", OWNER_ID))
      .collect(),
    invocations: await ctx.db
      .query("cloud_app_op_invocations")
      .withIndex("by_turnId", (q) => q.eq("turnId", TURN_ID))
      .collect(),
  }));

describe("cloud app route model dispatch", () => {
  it("binds the physical Anthropic request to a durable exact-owner lease", async () => {
    expect(CLOUD_APP_ROUTE_MODEL_BILLING_POLICY).toBe(
      "stella_control_plane_overhead",
    );
    const t = await createTest();
    const upstream = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({
        content: [
          {
            type: "text",
            text: JSON.stringify({
              decision: "operation",
              name: "addHabit",
              args: { name: "Read" },
            }),
          },
        ],
      }),
    );

    expect(
      await t.action(internal.cloud_apps.routeCloudTurnInternal, routeArgs),
    ).toBeNull();
    expect(upstream).toHaveBeenCalledTimes(1);
    expect(upstream.mock.calls[0]?.[1]?.signal).toBeInstanceOf(AbortSignal);
    const state = await t.run(async (ctx) => ({
      invocation: await ctx.db
        .query("cloud_app_op_invocations")
        .withIndex("by_turnId", (q) => q.eq("turnId", TURN_ID))
        .unique(),
      dispatch: await ctx.db
        .query("billing_managed_dispatch_leases")
        .withIndex("by_ownerId_and_createdAt", (q) => q.eq("ownerId", OWNER_ID))
        .unique(),
      usageLogs: await ctx.db
        .query("usage_logs")
        .withIndex("by_ownerId_and_createdAt", (q) => q.eq("ownerId", OWNER_ID))
        .collect(),
    }));
    expect(state.invocation).toMatchObject({
      ownerId: OWNER_ID,
      turnId: TURN_ID,
      name: "addHabit",
      status: "pending",
    });
    expect(state.dispatch).toMatchObject({
      ownerId: OWNER_ID,
      ownerGeneration: OWNER_GENERATION,
      state: "terminal",
      outcome: "succeeded",
    });
    expect(state.dispatch!.providerDeadlineAt).toBeLessThan(
      state.dispatch!.leaseExpiresAt,
    );
    expect(state.usageLogs).toEqual([]);
  });

  it("rejects incoming migration before provider I/O or route writes", async () => {
    const t = await createTest();
    await t.run(async (ctx) => {
      await ctx.db.insert("auth_owner_migrations", {
        fromOwnerId: "cloud-app-route-source",
        toOwnerId: OWNER_ID,
        status: "running",
        leaseGeneration: 1,
        fromOwnerGeneration: "legacy",
        toOwnerGeneration: OWNER_GENERATION,
        planRevision: 1,
        createdAt: 2,
        updatedAt: 2,
      });
    });
    const upstream = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(new Error("migration-fenced I/O must not run"));

    await expect(
      t.action(internal.cloud_apps.routeCloudTurnInternal, routeArgs),
    ).rejects.toThrow(/migrat|ownership_migrated/iu);
    expect(upstream).not.toHaveBeenCalled();
    expect(
      await t.run(async (ctx) =>
        ctx.db
          .query("agent_events")
          .withIndex("by_turnId_and_seq", (q) => q.eq("turnId", TURN_ID))
          .collect(),
      ),
    ).toEqual([]);
  });

  it("settles the physical and enclosing leases exactly once when the provider throws", async () => {
    const t = await createTest();
    const upstream = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(new Error("provider transport failed"));

    await expect(
      t.action(internal.cloud_apps.routeCloudTurnInternal, routeArgs),
    ).resolves.toBeNull();
    expect(upstream).toHaveBeenCalledTimes(1);
    const state = await managedLeaseState(t);
    expect(state.dispatches).toHaveLength(1);
    expect(state.dispatches[0]).toMatchObject({
      state: "terminal",
      outcome: "failed",
    });
    expect(state.executions).toHaveLength(1);
    expect(state.executions[0]).toMatchObject({
      state: "terminal",
      outcome: "failed",
    });
    expect(state.invocations).toEqual([]);
  });

  it("settles failed exactly once when the provider body contains invalid route JSON", async () => {
    const t = await createTest();
    const upstream = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({
        content: [{ type: "text", text: "{not-valid-json" }],
      }),
    );

    await expect(
      t.action(internal.cloud_apps.routeCloudTurnInternal, routeArgs),
    ).resolves.toBeNull();
    expect(upstream).toHaveBeenCalledTimes(1);
    const state = await managedLeaseState(t);
    expect(state.dispatches).toHaveLength(1);
    expect(state.dispatches[0]).toMatchObject({
      state: "terminal",
      outcome: "failed",
    });
    expect(state.executions).toHaveLength(1);
    expect(state.executions[0]).toMatchObject({
      state: "terminal",
      outcome: "failed",
    });
    expect(state.invocations).toEqual([]);
  });

  it("holds the enclosing lease across route-state delivery when reset wins after the body", async () => {
    const t = await createTest();
    const upstream = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async () => {
        await t.mutation(internal.owner_lifecycle.beginOwnerDataPurgeInternal, {
          ownerId: OWNER_ID,
          operationId: "cloud-route-reset-race",
          mode: "reset",
          now: Date.now(),
        });
        return Response.json({
          content: [
            {
              type: "text",
              text: JSON.stringify({
                decision: "operation",
                name: "addHabit",
                args: { name: "Read" },
              }),
            },
          ],
        });
      });

    await expect(
      t.action(internal.cloud_apps.routeCloudTurnInternal, routeArgs),
    ).rejects.toThrow(/generation|lifecycle|ownership|purge/iu);
    expect(upstream).toHaveBeenCalledTimes(1);
    const state = await managedLeaseState(t);
    expect(state.dispatches).toHaveLength(1);
    expect(state.dispatches[0]).toMatchObject({
      state: "terminal",
      outcome: "succeeded",
    });
    expect(state.executions).toHaveLength(1);
    expect(state.executions[0]).toMatchObject({
      state: "terminal",
      outcome: "failed",
    });
    expect(state.invocations).toEqual([]);
  });
});
