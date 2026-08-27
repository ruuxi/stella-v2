/// <reference types="vite/client" />

import { convexTest } from "convex-test";
import { describe, expect, it } from "vitest";
import { internal } from "./_generated/api";
import schema from "./schema";
import { seedReadyPurgeBackupSweep } from "../tests/convex_backup_sweep_test_helpers";

const modules = import.meta.glob("./**/*.ts");
const createTest = () => convexTest(schema, modules);

const reopenOwnerAfterReset = async (
  t: ReturnType<typeof createTest>,
  ownerId: string,
  nextGeneration: string,
) => {
  const purge = await t.mutation(
    internal.owner_lifecycle.beginOwnerDataPurgeInternal,
    {
      ownerId,
      operationId: `reset-${ownerId}`,
      mode: "reset",
      now: 10_000,
    },
  );
  const coreLeaseId = `core-${ownerId}`;
  await t.mutation(internal.owner_lifecycle.claimOwnerPurgeStageInternal, {
    ownerId,
    operationId: purge.operationId,
    generation: purge.generation,
    stage: "core",
    leaseId: coreLeaseId,
    now: 10_001,
  });
  await t.mutation(internal.owner_lifecycle.advanceOwnerPurgeStageInternal, {
    ownerId,
    operationId: purge.operationId,
    generation: purge.generation,
    leaseId: coreLeaseId,
    stage: "core",
    nextStage: "cloud",
    now: 10_002,
  });
  const cloudLeaseId = `cloud-${ownerId}`;
  await t.mutation(internal.owner_lifecycle.claimOwnerPurgeStageInternal, {
    ownerId,
    operationId: purge.operationId,
    generation: purge.generation,
    stage: "cloud",
    leaseId: cloudLeaseId,
    now: 10_003,
  });
  await t.run(async (ctx) => {
    await seedReadyPurgeBackupSweep(ctx, {
      ownerId,
      operationId: purge.operationId,
      generation: purge.generation,
      now: 10_004,
    });
  });
  expect(
    await t.mutation(internal.owner_lifecycle.finishOwnerCloudPurgeInternal, {
      ownerId,
      operationId: purge.operationId,
      generation: purge.generation,
      leaseId: cloudLeaseId,
      nextGeneration,
      now: 10_004,
    }),
  ).toBe(true);
};

describe("mobile lifecycle generation fencing", () => {
  it("rejects stale token, connect-intent, and registration writers after reset", async () => {
    const t = createTest();
    const ownerId = "mobile-reset-owner";
    await reopenOwnerAfterReset(t, ownerId, "mobile-reset-generation");

    await expect(
      t.mutation(internal.mobile_push.upsertToken, {
        ownerId,
        ownerGeneration: "legacy",
        mobileDeviceId: "mobile-1",
        expoPushToken: "ExponentPushToken[stale-reset-token]",
        nowMs: 20_000,
      }),
    ).rejects.toThrow(/before the account data was reset/u);
    await expect(
      t.mutation(internal.mobile_access.upsertConnectIntent, {
        ownerId,
        ownerGeneration: "legacy",
        desktopDeviceId: "desktop-1",
        mobileDeviceId: "mobile-1",
        createdAt: 20_000,
      }),
    ).rejects.toThrow(/before the account data was reset/u);
    await expect(
      t.mutation(internal.mobile_bridge.upsertRegistration, {
        ownerId,
        ownerGeneration: "legacy",
        deviceId: "desktop-1",
        baseUrls: ["https://desktop-1.example.test"],
        updatedAt: 20_000,
      }),
    ).rejects.toThrow(/before the account data was reset/u);

    expect(
      await t.run(async (ctx) => ({
        tokens: await ctx.db.query("mobile_push_tokens").collect(),
        intents: await ctx.db.query("mobile_connect_intents").collect(),
        registrations: await ctx.db
          .query("mobile_bridge_registrations")
          .collect(),
        devices: await ctx.db.query("devices").collect(),
      })),
    ).toEqual({ tokens: [], intents: [], registrations: [], devices: [] });
  });

  it("rejects a pairing callback minted before reset", async () => {
    const t = createTest();
    const ownerId = "mobile-pairing-reset-owner";
    await t.run(async (ctx) => {
      await ctx.db.insert("mobile_pairing_sessions", {
        ownerId,
        ownerGeneration: "legacy",
        desktopDeviceId: "desktop-pairing",
        pairingCode: "STALE123",
        createdAt: 1,
        expiresAt: Date.now() + 60_000,
      });
    });
    await reopenOwnerAfterReset(t, ownerId, "mobile-pairing-next");

    await expect(
      t.mutation(internal.mobile_access.completePairingSession, {
        ownerId,
        ownerGeneration: "mobile-pairing-next",
        pairingCode: "STALE123",
        mobileDeviceId: "mobile-pairing",
      }),
    ).rejects.toThrow(/before the account data was reset/u);
    expect(
      await t.run(async (ctx) =>
        ctx.db.query("paired_mobile_devices").collect(),
      ),
    ).toEqual([]);
  });

  it("rejects a bridge session callback from the previous generation", async () => {
    const t = createTest();
    const ownerId = "mobile-session-reset-owner";
    const session = await t.mutation(internal.mobile_bridge.createSession, {
      ownerId,
      ownerGeneration: "legacy",
      desktopDeviceId: "desktop-session",
      mobileDeviceId: "mobile-session",
      desktopChallenge: "challenge",
      desktopPublicKey: "desktop-key",
      mobilePublicKey: "mobile-key",
      createdAt: 1,
    });
    await reopenOwnerAfterReset(t, ownerId, "mobile-session-next");

    await expect(
      t.mutation(internal.mobile_bridge.consumeSession, {
        ownerId,
        ownerGeneration: "mobile-session-next",
        desktopDeviceId: "desktop-session",
        sessionId: session.sessionId,
        sessionSecret: session.sessionSecret,
        desktopChallenge: "challenge",
        nowMs: 20_000,
      }),
    ).rejects.toThrow(/before the account data was reset/u);
    const stored = await t.run(async (ctx) =>
      ctx.db
        .query("mobile_bridge_sessions")
        .withIndex("by_sessionId", (q) => q.eq("sessionId", session.sessionId))
        .unique(),
    );
    expect(stored?.lastSeenAt).toBe(1);
    expect(stored?.ownerGeneration).toBe("legacy");
  });

  it("rejects new mobile rows while permanent deletion is active", async () => {
    const t = createTest();
    const ownerId = "mobile-delete-owner";
    await t.mutation(internal.owner_lifecycle.beginOwnerDataPurgeInternal, {
      ownerId,
      operationId: "delete-mobile-owner",
      mode: "delete",
      now: 30_000,
    });

    await expect(
      t.mutation(internal.mobile_push.upsertToken, {
        ownerId,
        ownerGeneration: "legacy",
        mobileDeviceId: "mobile-delete",
        expoPushToken: "ExponentPushToken[stale-delete-token]",
        nowMs: 30_001,
      }),
    ).rejects.toThrow(/being deleted/u);
    expect(
      await t.run(async (ctx) => ctx.db.query("mobile_push_tokens").collect()),
    ).toEqual([]);
  });

  it("fences both owners while ownership migration is active", async () => {
    const t = createTest();
    const fromOwnerId = "mobile-migration-source";
    const toOwnerId = "mobile-migration-target";
    await t.mutation(internal.auth_migration.prepareOwnershipMigration, {
      fromOwnerId,
      toOwnerId,
    });
    const claim = await t.mutation(
      internal.auth_migration.claimOwnershipMigration,
      {
        fromOwnerId,
        toOwnerId,
        leaseId: "mobile-migration-lease",
        now: 40_000,
      },
    );
    if (!("fromOwnerGeneration" in claim)) {
      throw new Error("Ownership migration did not capture generations.");
    }

    for (const [ownerId, ownerGeneration] of [
      [fromOwnerId, claim.fromOwnerGeneration],
      [toOwnerId, claim.toOwnerGeneration],
    ] as const) {
      await expect(
        t.mutation(internal.mobile_access.upsertConnectIntent, {
          ownerId,
          ownerGeneration,
          desktopDeviceId: "desktop-migration",
          mobileDeviceId: "mobile-migration",
          createdAt: 40_001,
        }),
      ).rejects.toThrow(/linked to an account/u);
    }
    expect(
      await t.run(async (ctx) =>
        ctx.db.query("mobile_connect_intents").collect(),
      ),
    ).toEqual([]);
  });
});
