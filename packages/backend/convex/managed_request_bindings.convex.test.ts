/// <reference types="vite/client" />

import { convexTest } from "convex-test";
import { describe, expect, it } from "vitest";
import { internal } from "./_generated/api";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");
const createTest = () => convexTest(schema, modules);

const bind = async (
  t: ReturnType<typeof createTest>,
  overrides: Partial<{
    ownerId: string;
    ownerGeneration: string;
    route: string;
    requestId: string;
    bodyFingerprint: string;
    now: number;
  }> = {},
) =>
  await t.mutation(internal.billing.bindManagedProviderRequestInternal, {
    ownerId: "binding-owner",
    ownerGeneration: "legacy",
    route: "mobile_offline_chat",
    requestId: "mobile-request-0001",
    bodyFingerprint: "a".repeat(64),
    now: 1_000,
    ...overrides,
  });

describe("managed provider logical request bindings", () => {
  it("replays the identical canonical body and rejects request-id rebinding", async () => {
    const t = createTest();

    const first = await bind(t);
    const replay = await bind(t, { now: 2_000 });
    expect(first.replayed).toBe(false);
    expect(replay).toEqual({
      requestFingerprint: first.requestFingerprint,
      replayed: true,
    });

    await expect(
      bind(t, { bodyFingerprint: "b".repeat(64), now: 3_000 }),
    ).rejects.toThrow(/reused with different input/iu);

    const rows = await t.run(async (ctx) =>
      await ctx.db
        .query("billing_managed_request_bindings")
        .withIndex(
          "by_ownerId_and_ownerGeneration_and_route_and_requestId",
          (q) =>
            q
              .eq("ownerId", "binding-owner")
              .eq("ownerGeneration", "legacy")
              .eq("route", "mobile_offline_chat")
              .eq("requestId", "mobile-request-0001"),
        )
        .collect(),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      bodyFingerprint: "a".repeat(64),
      requestFingerprint: first.requestFingerprint,
    });
  });

  it("is owner/generation scoped and becomes purge-visible", async () => {
    const t = createTest();
    const first = await bind(t);
    const otherOwner = await bind(t, {
      ownerId: "other-binding-owner",
      bodyFingerprint: "b".repeat(64),
    });
    expect(otherOwner.requestFingerprint).not.toBe(first.requestFingerprint);

    expect(
      await t.query(
        internal.account_billing_purge.remainingOwnerBillingInternal,
        { ownerId: "binding-owner" },
      ),
    ).toContain("billing_managed_request_bindings");

    await t.mutation(internal.owner_lifecycle.beginOwnerDataPurgeInternal, {
      ownerId: "binding-owner",
      operationId: "reset-binding-owner",
      mode: "reset",
      now: 4_000,
    });
    await expect(bind(t, { now: 4_001 })).rejects.toThrow(
      /reset|purge|active|generation/iu,
    );
  });

  it("fails closed on malformed route, request id, or body digest", async () => {
    const t = createTest();
    await expect(bind(t, { route: "bad route" })).rejects.toThrow(/route/iu);
    await expect(bind(t, { requestId: "tiny" })).rejects.toThrow(/request id/iu);
    await expect(bind(t, { bodyFingerprint: "not-a-digest" })).rejects.toThrow(
      /body fingerprint/iu,
    );
  });

  it("drains generation-scoped bindings during reset after dispatch quiescence", async () => {
    const t = createTest();
    await bind(t);
    const purge = await t.mutation(
      internal.owner_lifecycle.beginOwnerDataPurgeInternal,
      {
        ownerId: "binding-owner",
        operationId: "reset-bindings",
        mode: "reset",
        now: 5_000,
      },
    );
    const leaseId = "reset-bindings-core-lease";
    await t.mutation(internal.owner_lifecycle.claimOwnerPurgeStageInternal, {
      ownerId: "binding-owner",
      operationId: purge.operationId,
      generation: purge.generation,
      stage: "core",
      leaseId,
      now: 5_001,
    });

    expect(
      await t.mutation(
        internal.account_billing_purge.quiesceOwnerManagedDispatchesInternal,
        {
          ownerId: "binding-owner",
          operationId: purge.operationId,
          generation: purge.generation,
          leaseId,
          mode: "reset",
          now: 5_002,
        },
      ),
    ).toEqual({ ready: true, pending: [] });
    expect(
      await t.run(async (ctx) =>
        await ctx.db
          .query("billing_managed_request_bindings")
          .withIndex("by_ownerId_and_createdAt", (q) =>
            q.eq("ownerId", "binding-owner"),
          )
          .collect(),
      ),
    ).toEqual([]);
  });

  it("drains more than one bounded page before allowing reset to reopen", async () => {
    const t = createTest();
    await t.run(async (ctx) => {
      for (let index = 0; index < 101; index += 1) {
        await ctx.db.insert("billing_managed_request_bindings", {
          ownerId: "binding-batch-owner",
          ownerGeneration: "legacy",
          route: "mobile_offline_chat",
          requestId: `mobile-request-${String(index).padStart(4, "0")}`,
          bodyFingerprint: index.toString(16).padStart(64, "0"),
          requestFingerprint: (index + 1).toString(16).padStart(64, "0"),
          createdAt: index,
          updatedAt: index,
        });
      }
    });
    const purge = await t.mutation(
      internal.owner_lifecycle.beginOwnerDataPurgeInternal,
      {
        ownerId: "binding-batch-owner",
        operationId: "reset-binding-batch",
        mode: "reset",
        now: 10_000,
      },
    );
    const leaseId = "reset-binding-batch-core-lease";
    await t.mutation(internal.owner_lifecycle.claimOwnerPurgeStageInternal, {
      ownerId: "binding-batch-owner",
      operationId: purge.operationId,
      generation: purge.generation,
      stage: "core",
      leaseId,
      now: 10_001,
    });

    const fence = {
      ownerId: "binding-batch-owner",
      operationId: purge.operationId,
      generation: purge.generation,
      leaseId,
      mode: "reset" as const,
    };
    expect(
      await t.mutation(
        internal.account_billing_purge.quiesceOwnerManagedDispatchesInternal,
        { ...fence, now: 10_002 },
      ),
    ).toEqual({
      ready: false,
      pending: ["billing_managed_request_bindings"],
    });
    expect(
      await t.run(async (ctx) =>
        await ctx.db
          .query("billing_managed_request_bindings")
          .withIndex("by_ownerId_and_createdAt", (q) =>
            q.eq("ownerId", "binding-batch-owner"),
          )
          .collect(),
      ),
    ).toHaveLength(1);
    expect(
      await t.mutation(
        internal.account_billing_purge.quiesceOwnerManagedDispatchesInternal,
        { ...fence, now: 10_003 },
      ),
    ).toEqual({ ready: true, pending: [] });
  });
});
