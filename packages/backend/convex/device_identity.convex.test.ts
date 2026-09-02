/// <reference types="vite/client" />

import { convexTest } from "convex-test";
import { register as registerRateLimiter } from "@convex-dev/rate-limiter/test";
import { describe, expect, it } from "vitest";
import { api, internal } from "./_generated/api";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");
const ownerId = "https://issuer.test|succession-owner";
const previousDeviceId = "desktop-retired";
const deviceId = "desktop-current";

const createTest = () => {
  const t = convexTest(schema, modules);
  registerRateLimiter(t);
  return t;
};

const asOwner = (t: ReturnType<typeof createTest>) =>
  t.withIdentity({
    issuer: "https://issuer.test",
    subject: "succession-owner",
    tokenIdentifier: ownerId,
    iat: 1_000,
  });

/** Seed a registered successor plus whatever the retired identity still owns. */
const seed = async (
  t: ReturnType<typeof createTest>,
  options: { pairedPhone?: string; retiredRegistration?: boolean } = {},
) => {
  await t.run(async (ctx) => {
    await ctx.db.insert("devices", { ownerId, deviceId, deviceName: "Mac" });
    if (options.pairedPhone) {
      await ctx.db.insert("paired_mobile_devices", {
        ownerId,
        desktopDeviceId: previousDeviceId,
        mobileDeviceId: options.pairedPhone,
        pairSecretHash: "hash",
        approvedAt: 1,
        lastSeenAt: 1,
      });
    }
    if (options.retiredRegistration) {
      await ctx.db.insert("mobile_bridge_registrations", {
        ownerId,
        deviceId: previousDeviceId,
        baseUrls: ["https://retired.example.com"],
        updatedAt: Date.now(),
      });
    }
  });
};

describe("device identity succession", () => {
  it("moves a stranded pairing onto the replacement identity", async () => {
    const t = createTest();
    await seed(t, { pairedPhone: "phone-a" });

    const result = await asOwner(t).mutation(
      api.device_identity.adoptDeviceIdentitySuccession,
      { previousDeviceId, deviceId },
    );

    expect(result.migratedPairings).toBe(1);
    await t.run(async (ctx) => {
      const rows = await ctx.db.query("paired_mobile_devices").collect();
      expect(rows).toHaveLength(1);
      expect(rows[0]!.desktopDeviceId).toBe(deviceId);
      // The owner gate verifies mobile proofs against the desktop id in its
      // snapshot; a rotation that did not announce itself would strand it.
      const pushes = (
        await ctx.db.system.query("_scheduled_functions").collect()
      ).filter((entry) => entry.name.includes("notifyOwnerSnapshotChanged"));
      expect(pushes).toHaveLength(1);
      expect((pushes[0]!.args[0] as { reason: string }).reason).toBe("pairing");
    });
  });

  it("lets a phone on the retired id find the live bridge", async () => {
    const t = createTest();
    await seed(t);
    await t.run(async (ctx) => {
      await ctx.db.insert("mobile_bridge_registrations", {
        ownerId,
        deviceId,
        baseUrls: ["https://current.example.com"],
        updatedAt: Date.now(),
      });
    });

    // Before succession the retired id resolves to nothing, which is what the
    // phone reads as a permanently offline desktop.
    const stranded = await t.query(
      internal.mobile_bridge.getRegistrationForOwnerDevice,
      { ownerId, deviceId: previousDeviceId, nowMs: Date.now() },
    );
    expect(stranded).toBeNull();

    await asOwner(t).mutation(
      api.device_identity.adoptDeviceIdentitySuccession,
      { previousDeviceId, deviceId },
    );

    const resolved = await t.query(
      internal.mobile_bridge.getRegistrationForOwnerDevice,
      { ownerId, deviceId: previousDeviceId, nowMs: Date.now() },
    );
    expect(resolved?.available).toBe(true);
    // The phone learns its new id from this, and re-files its pairing under it.
    expect(resolved?.deviceId).toBe(deviceId);
  });

  it("drops a retired registration when the successor already re-registered", async () => {
    const t = createTest();
    await seed(t, { retiredRegistration: true });
    await t.run(async (ctx) => {
      await ctx.db.insert("mobile_bridge_registrations", {
        ownerId,
        deviceId,
        baseUrls: ["https://current.example.com"],
        updatedAt: Date.now(),
      });
    });

    await asOwner(t).mutation(
      api.device_identity.adoptDeviceIdentitySuccession,
      { previousDeviceId, deviceId },
    );

    await t.run(async (ctx) => {
      const rows = await ctx.db.query("mobile_bridge_registrations").collect();
      expect(rows).toHaveLength(1);
      expect(rows[0]!.deviceId).toBe(deviceId);
    });
  });

  it("is idempotent so a retried claim is harmless", async () => {
    const t = createTest();
    await seed(t, { pairedPhone: "phone-a" });

    await asOwner(t).mutation(
      api.device_identity.adoptDeviceIdentitySuccession,
      { previousDeviceId, deviceId },
    );
    const second = await asOwner(t).mutation(
      api.device_identity.adoptDeviceIdentitySuccession,
      { previousDeviceId, deviceId },
    );

    expect(second.migratedPairings).toBe(0);
    await t.run(async (ctx) => {
      const successors = await ctx.db
        .query("device_identity_successors")
        .collect();
      expect(successors).toHaveLength(1);
    });
  });

  it("refuses to re-point an id that was already succeeded", async () => {
    const t = createTest();
    await seed(t, { pairedPhone: "phone-a" });
    await t.run(async (ctx) => {
      await ctx.db.insert("devices", {
        ownerId,
        deviceId: "desktop-other",
        deviceName: "Mac",
      });
    });

    await asOwner(t).mutation(
      api.device_identity.adoptDeviceIdentitySuccession,
      { previousDeviceId, deviceId },
    );

    // Otherwise a later rotation could claim an earlier one's paired phones.
    await expect(
      asOwner(t).mutation(api.device_identity.adoptDeviceIdentitySuccession, {
        previousDeviceId,
        deviceId: "desktop-other",
      }),
    ).rejects.toThrow("already been succeeded");
  });

  it("does not require a global liveness registration before succession", async () => {
    const t = createTest();

    const result = await asOwner(t).mutation(
      api.device_identity.adoptDeviceIdentitySuccession,
      { previousDeviceId, deviceId: "new-local-identity" },
    );

    expect(result.migratedPairings).toBe(0);
  });

  it("keeps another account's records isolated when device ids match", async () => {
    const t = createTest();
    await seed(t, { pairedPhone: "phone-a" });

    const otherOwner = t.withIdentity({
      issuer: "https://issuer.test",
      subject: "other-owner",
      tokenIdentifier: "https://issuer.test|other-owner",
      iat: 1_000,
    });

    await otherOwner.mutation(
      api.device_identity.adoptDeviceIdentitySuccession,
      {
        previousDeviceId,
        deviceId,
      },
    );

    await t.run(async (ctx) => {
      const rows = await ctx.db.query("paired_mobile_devices").collect();
      expect(rows[0]!.desktopDeviceId).toBe(previousDeviceId);
    });
  });
});
