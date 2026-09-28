/// <reference types="vite/client" />

import rateLimiterTest from "@convex-dev/rate-limiter/test";
import { convexTest } from "convex-test";
import { describe, expect, it } from "vitest";
import { api, internal } from "./_generated/api";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");
const createTest = () => {
  const t = convexTest(schema, modules);
  rateLimiterTest.register(t);
  return t;
};

const OWNER_ID = "https://issuer.test|connect-owner";
const OWNER_GENERATION = "generation:connect-owner";

describe("cloud connector connect expiry", () => {
  it("expires a card at its deadline as a data change the list query sees", async () => {
    const t = createTest();
    await t.run(async (ctx) => {
      await ctx.db.insert("cloud_owner_lifecycles", {
        ownerId: OWNER_ID,
        generation: OWNER_GENERATION,
        state: "open",
        createdAt: 1,
        updatedAt: 1,
      });
    });
    // A real-clock deadline far enough out that convex-test won't fire the
    // scheduled expiry during the test; it is driven explicitly below.
    const now = Date.now();
    const created = await t.mutation(
      internal.cloud_connector_connect.createConnectRequestInternal,
      {
        ownerId: OWNER_ID,
        ownerGeneration: OWNER_GENERATION,
        conversationId: "conversation:connect",
        turnId: "turn:connect",
        integrationId: "gmail",
        name: "Gmail",
        now,
      },
    );
    const scheduled = await t.run(async (ctx) =>
      ctx.db.system.query("_scheduled_functions").collect(),
    );
    const job = scheduled.find((row) =>
      row.name.includes("expireConnectRequestInternal"),
    );
    expect(job).toMatchObject({ scheduledTime: created.expiresAt });

    const connected = t.withIdentity({
      issuer: "https://issuer.test",
      subject: "connect-owner",
      tokenIdentifier: OWNER_ID,
      iat: 200,
    });
    // Before the deadline the sweeper is a no-op and the card stays listed.
    await t.mutation(
      internal.cloud_connector_connect.expireConnectRequestInternal,
      { requestId: created.requestId },
    );
    expect(
      await connected.query(
        api.cloud_connector_connect.listMyPendingConnectRequests,
      ),
    ).toHaveLength(1);

    await t.run(async (ctx) => {
      await ctx.scheduler.cancel(job!._id);
      const row = await ctx.db
        .query("cloud_connector_connect_requests")
        .withIndex("by_requestId", (q) => q.eq("requestId", created.requestId))
        .unique();
      await ctx.db.patch(row!._id, { expiresAt: now - 1 });
    });
    await t.mutation(
      internal.cloud_connector_connect.expireConnectRequestInternal,
      { requestId: created.requestId },
    );
    expect(
      await connected.query(
        api.cloud_connector_connect.listMyPendingConnectRequests,
      ),
    ).toEqual([]);
    expect(
      await t.query(
        internal.cloud_connector_connect.getConnectRequestInternal,
        {
          ownerId: OWNER_ID,
          ownerGeneration: OWNER_GENERATION,
          requestId: created.requestId,
          now,
        },
      ),
    ).toMatchObject({ state: "expired", revision: 2 });
  });
});
